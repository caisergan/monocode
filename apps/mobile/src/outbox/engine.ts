// The outbox engine (06 §6.8, 12 §12.8). Every command is written to the
// outbox before its first send and sent FIFO per session while its host is
// online. A receipt acks it; send, queue and create entries then stay on
// screen until their user block arrives. Errors either end the entry (failed,
// or discarded with a quiet notice) or send it back to pending with backoff.
//
// Pure: storage, transport, clock and timers are injected, so the state
// machine runs the same in the app and in tests.

import type { ChannelError } from "@monocode/channel";
import type { CommandReceipt, HostCommand } from "@monocode/core/session";
import { outboxSessionKey, type OutboxEntry, type OutboxPatch, type OutboxState } from "../storage/repo";
import { EXPIRED, EXPIRY_MS, OPTIMISTIC_MS, backoffMs, classify, discardOnExpiry, isOptimistic, toChannelError } from "./policy";

/** The storage the engine needs; `OutboxTable` and `MemoryOutbox` have it. */
export interface OutboxStore {
  put(entry: OutboxEntry): Promise<void>;
  list(filter?: { env?: string; sessionKey?: string; states?: readonly OutboxState[] }): Promise<OutboxEntry[]>;
  update(commandId: string, patch: OutboxPatch): Promise<OutboxEntry | undefined>;
  rewriteSession(env: string, localSessionId: string, sessionId: string): Promise<number>;
  delete(commandId: string): Promise<boolean>;
}

/** One host as the engine sees it. */
export type OutboxTransport = {
  online(): boolean;
  /** `commands.dispatch`; rejects with a ChannelError-shaped error. */
  dispatch(command: HostCommand): Promise<CommandReceipt>;
  /** A host with a new entry is connected at once. */
  connect(): void;
};

export type OutboxDeps = {
  store: OutboxStore;
  transport: (env: string) => OutboxTransport | undefined;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** The host's entries changed; `entries` are in send order. */
  onChange?: (env: string, entries: OutboxEntry[]) => void;
  /** A quiet notice, e.g. "Answered on another device". */
  onNotice?: (env: string, notice: string, entry: OutboxEntry) => void;
  /** A create's receipt named the host's id for a local session. */
  onSessionCreated?: (env: string, localSessionId: string, sessionId: string) => void;
};

export type EnqueueOptions = {
  /** For commands that follow a create: the local id in their sessionId. */
  localSessionId?: string;
  /** The create that must be acked first. */
  dependsOn?: string;
};

/** A dependent whose create is gone without having named its session. */
const ORPHANED: ChannelError = { code: "not_found", message: "This session was never created.", retryable: false };

export class OutboxEngine {
  private entries = new Map<string, OutboxEntry>();
  private inflight = new Map<string, Promise<void>>();
  private failures = new Map<string, { count: number; nextAt: number }>();
  private timers = new Map<string, { at: number; timer: unknown }>();
  private aliases = new Map<string, string>();
  private lastCreatedAt = 0;
  private loaded = false;
  readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly deps: OutboxDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.ready = this.load();
  }

  /** Reads the table. Entries left `sending` by a previous launch were never
   * answered, so they go back to pending; a create acked just before a crash
   * gets its dependents rewritten. */
  private async load(): Promise<void> {
    const all = await this.deps.store.list();
    for (const entry of all) {
      this.entries.set(entry.commandId, entry);
      this.lastCreatedAt = Math.max(this.lastCreatedAt, entry.createdAt);
    }
    for (const entry of all) {
      if (entry.state === "sending") await this.patch(entry.commandId, { state: "pending" });
      if (entry.command.type === "create" && entry.state === "acked" && entry.receipt && entry.localSessionId)
        await this.rewrite(entry.hostEnv, entry.localSessionId, entry.receipt.sessionId);
    }
    this.loaded = true;
    for (const env of this.envs()) {
      this.changed(env);
      this.pump(env);
    }
  }

  /** Hosts with entries. */
  envs(): Set<string> {
    return new Set([...this.entries.values()].map((entry) => entry.hostEnv));
  }

  /** A host's entries in send order. */
  list(env: string): OutboxEntry[] {
    return [...this.entries.values()].filter((entry) => entry.hostEnv === env).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(commandId: string): OutboxEntry | undefined {
    return this.entries.get(commandId);
  }

  /** The host's id for a session created from this phone, once known. */
  resolveSession(localSessionId: string): string | undefined {
    return this.aliases.get(localSessionId);
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  /** Writes the entry, then wakes the sender (rule 1). */
  async enqueue(env: string, command: HostCommand, options: EnqueueOptions = {}): Promise<OutboxEntry> {
    await this.ready;
    // Strictly increasing, so send order never depends on clock resolution.
    const createdAt = Math.max(this.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    const entry: OutboxEntry = {
      commandId: command.commandId,
      hostEnv: env,
      command,
      ...(options.localSessionId ? { localSessionId: options.localSessionId } : {}),
      ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
      createdAt,
      expiresAt: createdAt + EXPIRY_MS[command.type],
      attempts: 0,
      state: "pending",
    };
    await this.deps.store.put(entry);
    this.entries.set(entry.commandId, entry);
    this.changed(env);
    const transport = this.deps.transport(env);
    if (transport?.online()) this.pump(env);
    else transport?.connect();
    return entry;
  }

  /** Retry a failed entry with the same command id and a fresh expiry. */
  async retry(commandId: string): Promise<void> {
    await this.ready;
    const entry = this.entries.get(commandId);
    if (!entry || entry.state !== "failed") return;
    this.failures.delete(commandId);
    await this.patch(commandId, { state: "pending", error: undefined, expiresAt: this.now() + EXPIRY_MS[entry.command.type] });
    const transport = this.deps.transport(entry.hostEnv);
    if (transport?.online()) this.pump(entry.hostEnv);
    else transport?.connect();
  }

  /** Drops an entry; a create takes the commands waiting on it along. */
  async discard(commandId: string): Promise<void> {
    await this.ready;
    await this.remove(commandId);
  }

  /** Optimistic entries whose user block (or queued item) is now in the
   * session: the host has it, so the copy on screen can go. */
  async resolve(env: string, ids: ReadonlySet<string>): Promise<void> {
    await this.ready;
    for (const entry of this.list(env))
      if (isOptimistic(entry.command.type) && ids.has(entry.commandId)) await this.remove(entry.commandId);
  }

  /** Expired entries fail (or are dropped), and acked optimistic entries
   * whose block never came are deleted after 10 min (rules 3 and 6). */
  async sweep(): Promise<void> {
    await this.ready;
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if ((entry.state === "pending" || entry.state === "sending") && entry.expiresAt <= now && !this.inflight.has(entry.commandId))
        await this.expire(entry);
      else if (entry.state === "acked" && (entry.ackedAt ?? 0) + OPTIMISTIC_MS <= now) await this.remove(entry.commandId);
    }
  }

  /** The host is online again: backoff resets and the queue drains. */
  hostOnline(env: string): void {
    for (const entry of this.list(env)) this.failures.delete(entry.commandId);
    const timer = this.timers.get(env);
    if (timer) {
      this.clearTimer(timer.timer);
      this.timers.delete(env);
    }
    this.pump(env);
  }

  /** Sends everything sendable for a host and waits for the answers, e.g.
   * while the app moves to the background. */
  async flush(env: string): Promise<void> {
    await this.ready;
    for (let round = 0; round < 64; round++) {
      this.pump(env);
      const running = this.list(env)
        .map((entry) => this.inflight.get(entry.commandId))
        .filter((work): work is Promise<void> => !!work);
      if (!running.length) return;
      await Promise.allSettled(running);
    }
  }

  /** A host was removed: its entries go with it. */
  async forget(env: string): Promise<void> {
    await this.ready;
    for (const entry of this.list(env)) {
      await this.deps.store.delete(entry.commandId);
      this.entries.delete(entry.commandId);
      this.failures.delete(entry.commandId);
    }
    this.changed(env);
  }

  /** Entries the sender may still send (not acked or failed). */
  unsent(env?: string): OutboxEntry[] {
    return [...this.entries.values()].filter(
      (entry) => (env === undefined || entry.hostEnv === env) && (entry.state === "pending" || entry.state === "sending"),
    );
  }

  // ── The sender ──────────────────────────────────────────────────────────

  /** Starts the next send for every session whose head is ready (rule 2). */
  private pump(env: string): void {
    if (!this.loaded) return;
    const transport = this.deps.transport(env);
    if (!transport?.online()) return;
    const now = this.now();
    const groups = new Map<string, OutboxEntry[]>();
    for (const entry of this.list(env)) {
      const key = outboxSessionKey(entry) ?? `command:${entry.commandId}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    let wake = Infinity;
    for (const group of groups.values()) {
      for (const entry of group) {
        // Acked and failed entries no longer hold their session up.
        if (entry.state === "acked" || entry.state === "failed") continue;
        if (this.inflight.has(entry.commandId)) break;
        if (entry.expiresAt <= now) {
          void this.expire(entry).then(() => this.pump(env));
          break;
        }
        const dependency = this.dependency(entry);
        if (dependency === "wait") break;
        if (dependency === "orphaned") {
          void this.patch(entry.commandId, { state: "failed", error: ORPHANED });
          continue;
        }
        const backoff = this.failures.get(entry.commandId);
        if (backoff && backoff.nextAt > now) {
          wake = Math.min(wake, backoff.nextAt);
          break;
        }
        this.send(entry, transport);
        break;
      }
    }
    if (wake < Infinity) this.wakeAt(env, wake);
  }

  private dependency(entry: OutboxEntry): "ready" | "wait" | "orphaned" {
    if (!entry.dependsOn) return "ready";
    const create = this.entries.get(entry.dependsOn);
    if (create) return create.state === "acked" && !entry.localSessionId ? "ready" : "wait";
    return entry.localSessionId ? "orphaned" : "ready";
  }

  private wakeAt(env: string, at: number): void {
    const existing = this.timers.get(env);
    if (existing && existing.at <= at) return;
    if (existing) this.clearTimer(existing.timer);
    const timer = this.setTimer(() => {
      this.timers.delete(env);
      this.pump(env);
    }, Math.max(0, at - this.now()));
    this.timers.set(env, { at, timer });
  }

  private send(entry: OutboxEntry, transport: OutboxTransport): void {
    const id = entry.commandId;
    const work = (async () => {
      const sending = await this.patch(id, { state: "sending", attempts: entry.attempts + 1 });
      if (!sending) return;
      let receipt: CommandReceipt;
      try {
        receipt = await transport.dispatch(sending.command);
      } catch (error) {
        await this.failed(sending, toChannelError(error));
        return;
      }
      await this.acked(sending, receipt);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(id);
        this.pump(entry.hostEnv);
      });
    this.inflight.set(id, work);
  }

  /** Rule 3. */
  private async acked(entry: OutboxEntry, receipt: CommandReceipt): Promise<void> {
    const { commandId: id, hostEnv: env, command } = entry;
    this.failures.delete(id);
    if (!isOptimistic(command.type)) {
      await this.remove(id);
      return;
    }
    const acked = await this.patch(id, { state: "acked", receipt, ackedAt: this.now(), error: undefined });
    if (!acked || command.type !== "create") return;
    if (entry.localSessionId) await this.rewrite(env, entry.localSessionId, receipt.sessionId);
    // A create without a first message has no block to wait for.
    if (!command.initial) await this.remove(id);
  }

  /** Rules 4 and 5. */
  private async failed(entry: OutboxEntry, error: ChannelError): Promise<void> {
    const id = entry.commandId;
    const verdict = classify(error, entry.command.type);
    if (verdict.kind === "discard") {
      await this.remove(id);
      this.deps.onNotice?.(entry.hostEnv, verdict.notice, entry);
      return;
    }
    if (verdict.kind === "fail") {
      this.failures.delete(id);
      await this.patch(id, { state: "failed", error });
      return;
    }
    const count = (this.failures.get(id)?.count ?? 0) + 1;
    const nextAt = this.now() + backoffMs(count);
    this.failures.set(id, { count, nextAt });
    await this.patch(id, { state: "pending", error });
    this.wakeAt(entry.hostEnv, nextAt);
  }

  /** Rule 6. */
  private async expire(entry: OutboxEntry): Promise<void> {
    if (discardOnExpiry(entry.command.type)) await this.remove(entry.commandId);
    else await this.patch(entry.commandId, { state: "failed", error: EXPIRED });
  }

  /** After a create's receipt: the commands that followed it get the host's
   * session id, in SQLite and here. */
  private async rewrite(env: string, localSessionId: string, sessionId: string): Promise<void> {
    await this.deps.store.rewriteSession(env, localSessionId, sessionId);
    for (const entry of await this.deps.store.list({ env })) this.entries.set(entry.commandId, entry);
    this.aliases.set(localSessionId, sessionId);
    this.changed(env);
    this.deps.onSessionCreated?.(env, localSessionId, sessionId);
  }

  private async patch(commandId: string, patch: OutboxPatch): Promise<OutboxEntry | undefined> {
    const next = await this.deps.store.update(commandId, patch);
    const env = (next ?? this.entries.get(commandId))?.hostEnv;
    if (next) this.entries.set(commandId, next);
    else this.entries.delete(commandId);
    if (env) this.changed(env);
    return next;
  }

  private async remove(commandId: string): Promise<void> {
    const entry = this.entries.get(commandId);
    await this.deps.store.delete(commandId);
    this.entries.delete(commandId);
    this.failures.delete(commandId);
    if (!entry) return;
    if (entry.command.type === "create")
      for (const dependent of [...this.entries.values()])
        if (dependent.dependsOn === commandId && dependent.localSessionId) await this.remove(dependent.commandId);
    this.changed(entry.hostEnv);
  }

  private changed(env: string): void {
    if (this.loaded) this.deps.onChange?.(env, this.list(env));
  }
}
