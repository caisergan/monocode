// Projects and their session lists (12 §12.5, §12.7): painted from the
// cache, then refreshed. A shown project is in the host's watch, and each
// `project.sessions` event refetches its first page.

import { create } from "zustand";
import type { HostProject } from "@monocode/core/session";
import { runtime } from "@/hosts/registry";
import type { HostRuntime } from "@/hosts/runtime";
import { openCache } from "@/storage/cache";
import type { CacheRepo } from "@/storage/repo";
import {
  cachedList,
  canLoadMore,
  mergeFirstPage,
  mergeNextPage,
  removeSession,
  type ArchivedFilter,
  type SessionList,
  type SessionPage,
} from "./paging";

export const PAGE_SIZE = 50;

export type HostProjects = { projects: HostProject[]; freshness: "cached" | "live"; loading: boolean; error?: string };
export type ListState = { list?: SessionList; loading: boolean; loadingMore: boolean; error?: string };

type ProjectsState = {
  hosts: Record<string, HostProjects>;
  lists: Record<string, ListState>;
};

export const useProjects = create<ProjectsState>(() => ({ hosts: {}, lists: {} }));

export const listKey = (env: string, projectId: string, archived: ArchivedFilter) => `${env}/${projectId}/${archived}`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const NO_PROJECTS: HostProjects = { projects: [], freshness: "cached", loading: false };
const NO_LIST: ListState = { loading: false, loadingMore: false };

function patchHost(env: string, patch: Partial<HostProjects>): void {
  useProjects.setState((state) => ({
    hosts: { ...state.hosts, [env]: { ...(state.hosts[env] ?? NO_PROJECTS), ...patch } },
  }));
}

function patchList(key: string, patch: Partial<ListState>): void {
  useProjects.setState((state) => ({
    lists: { ...state.lists, [key]: { ...(state.lists[key] ?? NO_LIST), ...patch } },
  }));
}

/** The demo machine is never persisted. */
const cacheFor = (host: HostRuntime): Promise<CacheRepo | undefined> =>
  host.record.demo ? Promise.resolve(undefined) : openCache();

// ── Projects ─────────────────────────────────────────────────────────────────

const loadingProjects = new Map<string, Promise<void>>();

/** `projects.list` for one machine, painting the cached list first. */
export function loadProjects(env: string): Promise<void> {
  const host = runtime(env);
  if (!host) return Promise.resolve();
  const running = loadingProjects.get(env);
  if (running) return running;
  const work = (async () => {
    patchHost(env, { loading: true });
    const cache = await cacheFor(host);
    if (cache && !useProjects.getState().hosts[env]?.projects.length) {
      const cached = await cache.loadProjects(env).catch(() => []);
      if (cached.length && !useProjects.getState().hosts[env]?.projects.length) patchHost(env, { projects: cached, freshness: "cached" });
    }
    try {
      const projects = await host.request<HostProject[]>("projects.list");
      patchHost(env, { projects, freshness: "live", loading: false, error: undefined });
      void cache?.saveProjects(env, projects).catch(() => undefined);
    } catch (error) {
      patchHost(env, { loading: false, error: message(error) });
    }
  })().finally(() => loadingProjects.delete(env));
  loadingProjects.set(env, work);
  return work;
}

/** Keeps a machine's projects current while a screen shows them. */
export function watchProjects(env: string): () => void {
  const host = runtime(env);
  if (!host) return () => undefined;
  void loadProjects(env);
  return host.subscribe((event) => {
    if (event.type === "state" && event.state.kind === "online") void loadProjects(env);
    if (event.type === "evt" && event.name === "projects.changed") void loadProjects(env);
  });
}

// ── Session lists ────────────────────────────────────────────────────────────

const refreshing = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Refetches the first page. Overlapping calls coalesce into one more run. */
export function refreshSessions(env: string, projectId: string, archived: ArchivedFilter): Promise<void> {
  const key = listKey(env, projectId, archived);
  const running = refreshing.get(key);
  if (running) {
    again.add(key);
    return running;
  }
  const host = runtime(env);
  if (!host) return Promise.resolve();
  const work = (async () => {
    do {
      again.delete(key);
      patchList(key, { loading: true });
      try {
        const page = await host.request<SessionPage>("sessions.page", { projectId, archived, limit: PAGE_SIZE });
        const { list, removed } = mergeFirstPage(useProjects.getState().lists[key]?.list, page);
        patchList(key, { list, loading: false, error: undefined });
        const cache = await cacheFor(host);
        await cache?.putSessionItems(env, projectId, page.items).catch(() => undefined);
        await cache?.deleteSessionItems(env, removed).catch(() => undefined);
      } catch (error) {
        patchList(key, { loading: false, error: message(error) });
      }
    } while (again.has(key));
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, work);
  return work;
}

/** The next page after the list's cursor (11 §11.14: 50 at a time). */
export async function loadMoreSessions(env: string, projectId: string, archived: ArchivedFilter): Promise<void> {
  const key = listKey(env, projectId, archived);
  const state = useProjects.getState().lists[key];
  const host = runtime(env);
  if (!host || !state?.list || state.loadingMore || !canLoadMore(state.list)) return;
  patchList(key, { loadingMore: true });
  try {
    const page = await host.request<SessionPage>("sessions.page", { projectId, archived, limit: PAGE_SIZE, cursor: state.list.cursor });
    const current = useProjects.getState().lists[key]?.list ?? state.list;
    patchList(key, { list: mergeNextPage(current, page), loadingMore: false });
    void cacheFor(host).then((cache) => cache?.putSessionItems(env, projectId, page.items).catch(() => undefined));
  } catch (error) {
    patchList(key, { loadingMore: false, error: message(error) });
  }
}

/** Opens a project's session list: cached summaries first, then the first
 * page; live updates while it is open. Returns the cleanup. */
export function openSessionList(env: string, projectId: string, archived: ArchivedFilter): () => void {
  const host = runtime(env);
  if (!host) return () => undefined;
  const key = listKey(env, projectId, archived);
  let closed = false;
  void (async () => {
    const cache = await cacheFor(host);
    if (cache && !useProjects.getState().lists[key]?.list) {
      const cached = await cache.loadSessionItems(env, projectId).catch(() => []);
      if (!closed && cached.length && !useProjects.getState().lists[key]?.list) patchList(key, { list: cachedList(cached, archived) });
    }
    if (!closed) await refreshSessions(env, projectId, archived);
  })();
  const stopWatch = host.watchProject(projectId);
  const stopEvents = host.subscribe((event) => {
    if (event.type === "state" && event.state.kind === "online") void refreshSessions(env, projectId, archived);
    if (event.type !== "evt") return;
    const data = (event.data ?? {}) as { projectId?: string; sessionId?: string };
    if (event.name === "project.sessions" && data.projectId === projectId) void refreshSessions(env, projectId, archived);
    if (event.name === "session.deleted" && data.sessionId && (!data.projectId || data.projectId === projectId)) {
      const list = useProjects.getState().lists[key]?.list;
      if (list) patchList(key, { list: removeSession(list, data.sessionId) });
      void cacheFor(host).then((cache) => cache?.deleteSessionItems(env, [data.sessionId!]).catch(() => undefined));
    }
  });
  return () => {
    closed = true;
    stopWatch();
    stopEvents();
  };
}
