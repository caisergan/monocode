// Per-channel watch state (spec 06 §6.6): the host pushes small revision
// deltas for sessions a phone has open, and short "refetch" hints for lists.
// Nothing polls.

import type { Priority } from "@monocode/channel/envelope";
import type { SyncWindow, WatchSet, WindowedSync } from "@monocode/core/wire";
import type { HostStore, SessionChange } from "../store";
import { HostError } from "../errors";
import { BOOT_ID } from "../rpc";

export const MAX_WATCHED_SESSIONS = 8;
const MAX_WATCHED_PROJECTS = 64;
const SESSION_MIN_GAP_MS = 100;
const LIST_COALESCE_MS = 500;
/** Above this, deltas wait; the phone gets one catch-up delta later. */
const BACKPRESSURE_BYTES = 8 * 1024 * 1024;
const DRAINED_BYTES = 1024 * 1024;

type WatchedSession = {
  id: string;
  /** The last revision this channel was sent (not acknowledged). */
  lastSent?: number;
  window: SyncWindow;
  maxBlockChars?: number;
  lastSentAt: number;
  timer?: ReturnType<typeof setTimeout>;
  dirty: boolean;
};

export type WatchSink = {
  send(message: unknown, priority: Priority): void;
  /** Bytes waiting in this channel's queues and socket. */
  backlog(): number;
};

export class Watcher {
  private inbox = false;
  private projects = new Set<string>();
  private sessions = new Map<string, WatchedSession>();
  private projectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inboxTimer?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly store: HostStore,
    private readonly sink: WatchSink,
  ) {}

  /** Replaces the whole watch, then sends whatever the phone is missing. */
  set(input: WatchSet): void {
    const sessions = Array.isArray(input.sessions) ? input.sessions : [];
    if (sessions.length > MAX_WATCHED_SESSIONS)
      throw new HostError("invalid_params", `Watch at most ${MAX_WATCHED_SESSIONS} sessions`);
    const projects = Array.isArray(input.projects) ? input.projects : [];
    if (projects.length > MAX_WATCHED_PROJECTS)
      throw new HostError("invalid_params", `Watch at most ${MAX_WATCHED_PROJECTS} projects`);
    this.inbox = input.inbox === true;
    this.projects = new Set(projects.filter((id): id is string => typeof id === "string"));
    for (const watched of this.sessions.values()) clearTimeout(watched.timer);
    this.sessions = new Map();
    for (const entry of sessions) {
      if (!entry || typeof entry.id !== "string") continue;
      const window: SyncWindow = {
        ...(typeof entry.window?.anchor === "string" ? { anchor: entry.window.anchor } : {}),
        ...(Number.isSafeInteger(entry.window?.tailTurns) ? { tailTurns: entry.window!.tailTurns } : {}),
      };
      const watched: WatchedSession = {
        id: entry.id,
        lastSent: Number.isSafeInteger(entry.revision) ? entry.revision : undefined,
        window,
        maxBlockChars: Number.isSafeInteger(entry.maxBlockChars) ? entry.maxBlockChars : undefined,
        lastSentAt: 0,
        dirty: false,
      };
      this.sessions.set(entry.id, watched);
      this.flushSession(watched, true);
    }
  }

  onChange(change: SessionChange): void {
    if (this.closed) return;
    const watched = this.sessions.get(change.sessionId);
    if (watched) {
      if (change.deleted) {
        this.sessions.delete(change.sessionId);
        clearTimeout(watched.timer);
        this.sink.send({ t: "evt", e: "session.deleted", d: { sessionId: change.sessionId, projectId: change.projectId } }, 1);
      } else this.schedule(watched);
    } else if (change.deleted && this.projects.has(change.projectId))
      this.sink.send({ t: "evt", e: "session.deleted", d: { sessionId: change.sessionId, projectId: change.projectId } }, 1);
    if (this.projects.has(change.projectId) && !this.projectTimers.has(change.projectId))
      this.projectTimers.set(
        change.projectId,
        setTimeout(() => {
          this.projectTimers.delete(change.projectId);
          if (!this.closed)
            this.sink.send({ t: "evt", e: "project.sessions", d: { projectId: change.projectId } }, 1);
        }, LIST_COALESCE_MS),
      );
    if (this.inbox && change.inbox && !this.inboxTimer)
      this.inboxTimer = setTimeout(() => {
        this.inboxTimer = undefined;
        if (!this.closed)
          this.sink.send(
            { t: "evt", e: "inbox.changed", d: { boot: BOOT_ID, revision: this.store.inboxRevision } },
            1,
          );
      }, LIST_COALESCE_MS);
  }

  /** A project was added on the host. */
  projectsChanged(): void {
    if (!this.closed) this.sink.send({ t: "evt", e: "projects.changed", d: {} }, 1);
  }

  private schedule(watched: WatchedSession): void {
    if (watched.timer) return;
    const wait = Math.max(0, watched.lastSentAt + SESSION_MIN_GAP_MS - Date.now());
    watched.timer = setTimeout(() => {
      watched.timer = undefined;
      this.flushSession(watched, false);
    }, wait);
  }

  private flushSession(watched: WatchedSession, initial: boolean): void {
    if (this.closed || this.sessions.get(watched.id) !== watched) return;
    if (!initial && this.sink.backlog() > BACKPRESSURE_BYTES) {
      watched.dirty = true;
      this.drainSoon();
      return;
    }
    let sync: WindowedSync;
    try {
      sync = this.store.windowedSync(watched.id, watched.lastSent, watched.window, watched.maxBlockChars);
    } catch (error) {
      // The session is gone or unreadable; tell the phone once and stop.
      this.sessions.delete(watched.id);
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message))
        this.sink.send({ t: "evt", e: "session.deleted", d: { sessionId: watched.id } }, 1);
      return;
    }
    watched.dirty = false;
    // Later deltas cover the same window: pin its first block as the anchor.
    if (sync.window?.anchor) watched.window = { ...watched.window, anchor: sync.window.anchor };
    const revision = sync.kind === "unchanged" ? sync.revision : sync.value.revision;
    if (sync.kind === "unchanged" && !initial) return;
    watched.lastSent = revision;
    watched.lastSentAt = Date.now();
    this.sink.send(
      { t: "evt", e: "session.sync", d: { sessionId: watched.id, sync } },
      sync.kind === "snapshot" ? 2 : 1,
    );
  }

  private drainSoon(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.closed || this.sink.backlog() > DRAINED_BYTES) return;
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
      for (const watched of this.sessions.values()) if (watched.dirty) this.flushSession(watched, false);
    }, 50);
  }

  close(): void {
    this.closed = true;
    for (const watched of this.sessions.values()) clearTimeout(watched.timer);
    for (const timer of this.projectTimers.values()) clearTimeout(timer);
    clearTimeout(this.inboxTimer);
    clearInterval(this.drainTimer);
  }
}
