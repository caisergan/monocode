// Workspace state shared by the Project screen, Explorer, Changes and the
// viewers: one `git.index` per working copy (the Changes segment's stats,
// the list, Prev and Next file) and directory listings, painted from memory
// and refreshed on every visit. Reads only; nothing here is persisted.

import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { runtime } from "@/hosts/registry";
import { useAgents, useHosts } from "@/hosts/store";
import { listKey, useProjects } from "@/sync/projects";
import { gitIndex, listFiles, searchFiles } from "./api";
import { projectRunning } from "./git";
import { scopeKey, type FileEntry, type GitDiffIndex, type Scope } from "./types";

type Loadable<T> = { value?: T; error?: string; loading: boolean };

type WorkspaceState = {
  indexes: Record<string, Loadable<GitDiffIndex>>;
  dirs: Record<string, Loadable<FileEntry[]>>;
};

const useWorkspace = create<WorkspaceState>(() => ({ indexes: {}, dirs: {} }));

const IDLE: Loadable<never> = { loading: false };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function patch<K extends keyof WorkspaceState>(table: K, key: string, next: Partial<Loadable<unknown>>): void {
  useWorkspace.setState((state) => ({ [table]: { ...state[table], [key]: { ...(state[table][key] ?? IDLE), ...next } } }) as Partial<WorkspaceState>);
}

const inFlight = new Map<string, Promise<void>>();

/** Loads into `table[key]` once at a time; errors keep the last value.
 * `fresh` asks for a read that starts after any in flight, as after a
 * commit, when an earlier read may predate it. */
function load<K extends keyof WorkspaceState>(
  table: K,
  key: string,
  read: () => Promise<WorkspaceState[K][string]["value"]>,
  fresh = false,
): Promise<void> {
  const flightKey = `${table}:${key}`;
  const running = inFlight.get(flightKey);
  if (running && !fresh) return running;
  const start = () => {
    patch(table, key, { loading: true });
    return read().then(
      (value) => patch(table, key, { value, error: undefined, loading: false }),
      (error: unknown) => patch(table, key, { error: message(error), loading: false }),
    );
  };
  const promise: Promise<void> = (running ? running.then(start) : start()).finally(() => {
    if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey);
  });
  inFlight.set(flightKey, promise);
  return promise;
}

export const makeScope = (env: string, projectId: string, cwd?: string): Scope => (cwd ? { env, projectId, cwd } : { env, projectId });

/** Fetches the working copy's `git.index`; `fresh` after a mutation. */
export function refreshIndex(scope: Scope, fresh = false): Promise<void> {
  const host = runtime(scope.env);
  if (!host) return Promise.resolve();
  return load("indexes", scopeKey(scope), () => gitIndex(host, scope), fresh);
}

/** The working copy's index, fetched when shown. `enabled` is false when the
 * host lacks `git.index`. */
export function useGitIndex(env: string, projectId: string, cwd: string | undefined, enabled = true): Loadable<GitDiffIndex> {
  const key = scopeKey(makeScope(env, projectId, cwd));
  const state = useWorkspace((store) => store.indexes[key]) ?? IDLE;
  const known = useHosts((store) => store.records.some((record) => record.env === env));
  useEffect(() => {
    if (enabled && known) void refreshIndex(makeScope(env, projectId, cwd));
  }, [env, projectId, cwd, enabled, known]);
  return state;
}

export function refreshDirectory(scope: Scope, path: string): Promise<void> {
  const host = runtime(scope.env);
  if (!host) return Promise.resolve();
  return load("dirs", `${scopeKey(scope)}|${path}`, () => listFiles(host, scope, path));
}

/** A folder's entries: the last listing at once, then a fresh one. */
export function useDirectory(env: string, projectId: string, cwd: string | undefined, path: string): Loadable<FileEntry[]> {
  const key = `${scopeKey(makeScope(env, projectId, cwd))}|${path}`;
  const state = useWorkspace((store) => store.dirs[key]) ?? IDLE;
  const known = useHosts((store) => store.records.some((record) => record.env === env));
  useEffect(() => {
    if (known) void refreshDirectory(makeScope(env, projectId, cwd), path);
  }, [env, projectId, cwd, path, known]);
  return state;
}

const SEARCH_DELAY_MS = 200;

/** Go to file results for `query`, debounced; stale answers are dropped. */
export function useFileSearch(env: string, projectId: string, cwd: string | undefined, query: string): Loadable<FileEntry[]> {
  const [state, setState] = useState<Loadable<FileEntry[]> & { query: string }>({ loading: false, query: "" });
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) return;
    let current = true;
    const timer = setTimeout(() => {
      const host = runtime(env);
      if (!host) return;
      setState((previous) => ({ ...previous, loading: true }));
      searchFiles(host, makeScope(env, projectId, cwd), trimmed).then(
        (value) => current && setState({ value, loading: false, query: trimmed }),
        (error: unknown) => current && setState({ error: message(error), loading: false, query: trimmed }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [env, projectId, cwd, trimmed]);
  if (!trimmed) return IDLE;
  // Results for an earlier query stay up until the new ones arrive.
  return state.query === trimmed ? state : { ...state, loading: true };
}

/** Whether a session in the project runs, from the inbox and the project's
 * session list. Keeps the inbox watched while shown, so the answer stays
 * current: the host's inbox lists every running session. */
export function useProjectRunning(env: string, projectId: string): boolean {
  const inbox = useAgents((store) => store.items);
  const list = useProjects((store) => store.lists[listKey(env, projectId, "exclude")]?.list?.items);
  useEffect(() => runtime(env)?.watchInbox(), [env]);
  return useMemo(
    () =>
      projectRunning(
        projectId,
        inbox.filter((item) => item.env === env).map((item) => ({ id: item.sessionId, projectId: item.projectId, status: item.status, revision: item.revision })),
        (list ?? []).map((item) => ({ id: item.id, projectId: item.projectId, status: item.status, revision: item.revision })),
      ),
    [inbox, list, env, projectId],
  );
}
