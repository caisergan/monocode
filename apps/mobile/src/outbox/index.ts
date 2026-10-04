// The app's outbox (12 §12.8): one engine over the encrypted cache's outbox
// table, fed by the host runtimes, viewed through a zustand store. Every
// `commands.dispatch` goes through `enqueue`; every other mutating method
// through `mutate`.

import * as BackgroundTask from "expo-background-task";
import { randomUUID } from "expo-crypto";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { CommandReceipt, HostCommand } from "@monocode/core/session";
import { DEMO_ENV } from "@/demo/demoHost";
import { runtime, startHosts } from "@/hosts/registry";
import { setBackgroundHold, type HostRuntime } from "@/hosts/runtime";
import { useHosts } from "@/hosts/store";
import { openCache } from "@/storage/cache";
import { outboxSessionKey, type OutboxEntry, type OutboxPatch, type OutboxState } from "@/storage/repo";
import { showToast } from "@/ui/toast";
import { OutboxEngine, type EnqueueOptions, type OutboxStore } from "./engine";
import { MemoryOutbox } from "./memory";
import { runMutation } from "./mutate";

type OutboxView = {
  byEnv: Record<string, OutboxEntry[]>;
  /** `${env}/${localSessionId}` → the host's session id. */
  created: Record<string, string>;
};

export const useOutbox = create<OutboxView>(() => ({ byEnv: {}, created: {} }));

const EMPTY: OutboxEntry[] = [];

/** One session's entries, in send order. `key` is a session id or a local
 * session id from New session. */
export function useSessionOutbox(env: string, key: string | undefined): OutboxEntry[] {
  return useOutbox(useShallow((state) => (key ? (state.byEnv[env] ?? EMPTY).filter((entry) => outboxSessionKey(entry) === key) : EMPTY)));
}

/** Local ids for sessions New session is still creating. */
export const LOCAL_PREFIX = "local-";

export function isLocalSession(id: string | undefined): boolean {
  return !!id?.startsWith(LOCAL_PREFIX);
}

/** The demo machine is never persisted; its commands live in memory. */
function routed(table: OutboxStore): OutboxStore {
  const memory = new MemoryOutbox();
  const pick = (env: string) => (env === DEMO_ENV ? memory : table);
  const owner = async (commandId: string) => ((await memory.list()).some((entry) => entry.commandId === commandId) ? memory : table);
  return {
    put: (entry: OutboxEntry) => pick(entry.hostEnv).put(entry),
    list: async (filter: { env?: string; sessionKey?: string; states?: readonly OutboxState[] } = {}) =>
      filter.env !== undefined ? pick(filter.env).list(filter) : [...(await table.list(filter)), ...(await memory.list(filter))],
    update: async (commandId: string, patch: OutboxPatch) => (await owner(commandId)).update(commandId, patch),
    rewriteSession: (env: string, local: string, sessionId: string) => pick(env).rewriteSession(env, local, sessionId),
    delete: async (commandId: string) => (await owner(commandId)).delete(commandId),
  };
}

function transport(host: HostRuntime) {
  return {
    online: () => host.state.kind === "online",
    dispatch: (command: HostCommand) => host.request<CommandReceipt>("commands.dispatch", command as Record<string, unknown>, 60_000),
    connect: () => host.connect(),
  };
}

let starting: Promise<OutboxEngine> | undefined;

/** The engine, started once after the hosts. */
export function startOutbox(): Promise<OutboxEngine> {
  starting ??= (async () => {
    const cache = await openCache();
    const engine = new OutboxEngine({
      store: routed(cache?.outbox ?? new MemoryOutbox()),
      transport: (env) => {
        const host = runtime(env);
        return host ? transport(host) : undefined;
      },
      onChange: (env, entries) => useOutbox.setState((state) => ({ byEnv: { ...state.byEnv, [env]: entries } })),
      onNotice: (_env, notice) => showToast(notice),
      onSessionCreated: (env, local, sessionId) =>
        useOutbox.setState((state) => ({ created: { ...state.created, [`${env}/${local}`]: sessionId } })),
    });
    await engine.ready;
    // Backoff resets and the queue drains whenever a host comes online; a
    // removed host's commands are dropped.
    let online = new Set<string>();
    let paired: Set<string> | undefined;
    const watch = (state: ReturnType<typeof useHosts.getState>) => {
      const now = new Set(Object.entries(state.states).filter(([, conn]) => conn.kind === "online").map(([env]) => env));
      for (const env of now) if (!online.has(env)) engine.hostOnline(env);
      online = now;
      if (!state.loaded) return;
      const envs = new Set(state.records.map((record) => record.env));
      // First look: entries of hosts removed while the app was closed.
      for (const env of paired ?? engine.envs()) if (!envs.has(env)) void engine.forget(env);
      paired = envs;
    };
    watch(useHosts.getState());
    useHosts.subscribe(watch);
    setBackgroundHold((env) => (engine.unsent(env).length ? engine.flush(env) : undefined));
    setInterval(() => void engine.sweep(), 15_000);
    void engine.sweep();
    AppState.addEventListener("change", (state) => {
      if (state === "background") void scheduleBackgroundFlush(engine);
    });
    return engine;
  })();
  return starting;
}

/** Writes the command to the outbox, then sends it when its host is online. */
export async function enqueue(env: string, command: HostCommand, options?: EnqueueOptions): Promise<OutboxEntry> {
  return (await startOutbox()).enqueue(env, command, options);
}

export const newCommandId = (): string => randomUUID();

export async function retryEntry(commandId: string): Promise<void> {
  await (await startOutbox()).retry(commandId);
}

export async function discardEntry(commandId: string): Promise<void> {
  await (await startOutbox()).discard(commandId);
}

/** A session window now holds these block and queued ids. */
export function resolveOutbox(env: string, ids: ReadonlySet<string>): void {
  void startOutbox().then((engine) => engine.resolve(env, ids));
}

/** A non-command mutating method (06 §6.8): keyed and retried for 60 s when
 * the host has `mutations.idempotent`, tried once otherwise. */
export function mutate<T>(host: HostRuntime, method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  return runMutation<T>({
    idempotent: host.has("mutations.idempotent"),
    request: (key) => host.request(method, params, timeoutMs, { key }),
    newKey: randomUUID,
  });
}

// ── Background flush ─────────────────────────────────────────────────────────
// SDK 57 has no begin/end background-time API. A backgrounding host keeps its
// channel for a few seconds while the outbox flushes (`setBackgroundHold`);
// whatever is still unsent is retried by a BackgroundTask the OS runs later.

const OUTBOX_TASK = "mc-outbox-flush";
const TASK_BUDGET_MS = 25_000;

TaskManager.defineTask(OUTBOX_TASK, async () => {
  try {
    await startHosts();
    const engine = await startOutbox();
    const envs = [...new Set(engine.unsent().map((entry) => entry.hostEnv))];
    for (const env of envs) runtime(env)?.connect();
    await Promise.race([
      Promise.all(envs.map((env) => onlineThen(env, () => engine.flush(env)))),
      new Promise((resolve) => setTimeout(resolve, TASK_BUDGET_MS)),
    ]);
    if (!engine.unsent().length) await BackgroundTask.unregisterTaskAsync(OUTBOX_TASK).catch(() => undefined);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

function onlineThen(env: string, work: () => Promise<void>): Promise<void> {
  if (useHosts.getState().states[env]?.kind === "online") return work();
  return new Promise((resolve) => {
    const stop = useHosts.subscribe((state) => {
      if (state.states[env]?.kind !== "online") return;
      stop();
      resolve(work());
    });
  });
}

async function scheduleBackgroundFlush(engine: OutboxEngine): Promise<void> {
  if (!engine.unsent().length) return;
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (!(await TaskManager.isTaskRegisteredAsync(OUTBOX_TASK))) await BackgroundTask.registerTaskAsync(OUTBOX_TASK, { minimumInterval: 15 });
  } catch {
    // Simulators and restricted devices have no background tasks.
  }
}
