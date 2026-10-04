// One open session's window (06 §6.7): the blocks from an anchor to the
// end, kept current by `session.sync` events. Listeners get the new value
// directly; the transcript is fed without a React render. The window paints
// from the cache first and is persisted as it changes (12 §12.7).

import { applySessionSync, type Block, type HostSession, type SessionSync } from "@monocode/core/session";
import type { WindowMeta, WindowedSync } from "@monocode/core/wire";
import type { HostRuntime } from "@/hosts/runtime";
import { openCache } from "@/storage/cache";
import { hasOlder, mergeOlder, type OlderPage } from "./older";

const TAIL_TURNS = 20;
const OLDER_TURNS = 20;
const MAX_BLOCK_CHARS = 20_000;
/** Persist at most this often while a turn streams; at once on settle. */
const PERSIST_MS = 1_000;
/** How long the watch waits for the cached window before going without. */
const RESTORE_WAIT_MS = 250;

export type WindowState = {
  value?: HostSession;
  window?: WindowMeta;
  /** "cached" until the first sync after the current watch was sent. */
  freshness: "cached" | "live";
  loadingOlder: boolean;
  error?: string;
};

const openWindows = new Map<string, SessionWindow>();

/** The window an open session screen holds, for sheets above it. */
export function openWindow(env: string, sessionId: string): SessionWindow | undefined {
  return openWindows.get(`${env}/${sessionId}`);
}

export class SessionWindow {
  state: WindowState = { freshness: "cached", loadingOlder: false };
  private listeners = new Set<(state: WindowState) => void>();
  private stopWatch?: () => void;
  private stopEvents?: () => void;
  private closed = false;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persisted?: string;

  constructor(
    private readonly host: HostRuntime,
    readonly sessionId: string,
  ) {}

  private get key(): string {
    return `${this.host.env}/${this.sessionId}`;
  }

  subscribe(listener: (state: WindowState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<WindowState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  open(): void {
    openWindows.set(this.key, this);
    this.stopEvents = this.host.subscribe((event) => {
      if (event.type === "state" && event.state.kind !== "online") this.set({ freshness: "cached" });
      if (event.type !== "evt") return;
      const data = event.data as { sessionId?: string; sync?: WindowedSync };
      if (data.sessionId !== this.sessionId) return;
      if (event.name === "session.sync" && data.sync) this.apply(data.sync);
      if (event.name === "session.deleted") this.set({ error: "This session was deleted." });
    });
    // The watch carries the cached revision and anchor, so the host answers
    // with a delta or "unchanged" instead of a full snapshot.
    const restored = this.restore().catch(() => undefined);
    void Promise.race([restored, new Promise((resolve) => setTimeout(resolve, RESTORE_WAIT_MS))]).then(() => {
      if (this.closed) return;
      this.stopWatch = this.host.watchSession(this.sessionId, {
        current: () => ({
          revision: this.state.value?.revision,
          window: this.state.window?.anchor ? { anchor: this.state.window.anchor } : { tailTurns: TAIL_TURNS },
        }),
      });
    });
  }

  close(): void {
    this.closed = true;
    if (openWindows.get(this.key) === this) openWindows.delete(this.key);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      void this.persist();
    }
    this.stopWatch?.();
    this.stopEvents?.();
    this.listeners.clear();
  }

  /** A block of the window, as last synced (possibly truncated in transit). */
  block(id: string): Block | undefined {
    return this.state.value?.session.blocks.find((block) => block.id === id);
  }

  private async restore(): Promise<void> {
    if (this.host.record.demo) return;
    const cache = await openCache();
    if (!cache || this.closed || this.state.value) return;
    const cached = await cache.loadWindow(this.host.env, this.sessionId);
    if (!cached || this.closed || this.state.value) return;
    this.persisted = this.persistKey(cached.value, cached.window);
    this.set({ value: cached.value, window: cached.window, freshness: "cached" });
  }

  private persistKey(value: HostSession, window?: WindowMeta): string {
    return `${value.revision}|${window?.anchor ?? ""}|${value.session.blocks.length}`;
  }

  private schedulePersist(): void {
    if (this.host.record.demo || !this.state.value) return;
    if (this.state.value.status === "running") {
      this.persistTimer ??= setTimeout(() => {
        this.persistTimer = undefined;
        void this.persist();
      }, PERSIST_MS);
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    void this.persist();
  }

  private async persist(): Promise<void> {
    const { value, window } = this.state;
    if (!value) return;
    const key = this.persistKey(value, window);
    if (key === this.persisted) return;
    this.persisted = key;
    const cache = await openCache();
    await cache?.saveWindow(this.host.env, this.sessionId, { revision: value.revision, value, window }).catch(() => undefined);
  }

  private apply(sync: WindowedSync): void {
    try {
      const value = applySessionSync(this.state.value, sync as SessionSync);
      this.set({ value, window: sync.window ?? this.state.window, freshness: "live", error: undefined });
      this.schedulePersist();
    } catch {
      // Base mismatch: ask for a fresh snapshot of the same window.
      void this.host
        .request<WindowedSync>("sessions.sync", {
          sessionId: this.sessionId,
          window: this.state.window?.anchor ? { anchor: this.state.window.anchor } : { tailTurns: TAIL_TURNS },
          maxBlockChars: MAX_BLOCK_CHARS,
        })
        .then((fresh) => {
          if (fresh.kind !== "snapshot") return;
          this.set({ value: fresh.value, window: fresh.window, freshness: "live" });
          this.schedulePersist();
        })
        .catch(() => undefined);
    }
  }

  get hasOlder(): boolean {
    return hasOlder(this.state.window);
  }

  /** Prepends the turns before the window; the first returned block becomes
   * the new anchor, which the next watch.set carries. */
  async loadOlder(): Promise<void> {
    const first = this.state.value?.session.blocks[0];
    if (!first || this.state.loadingOlder || !this.hasOlder) return;
    this.set({ loadingOlder: true });
    try {
      const older = await this.host.request<OlderPage>("sessions.blocks", {
        sessionId: this.sessionId,
        before: first.id,
        turns: OLDER_TURNS,
        maxBlockChars: MAX_BLOCK_CHARS,
      });
      const current = this.state.value;
      const merged = current ? mergeOlder({ value: current, window: this.state.window }, first.id, older) : undefined;
      this.set({ loadingOlder: false, ...(merged ? { value: merged.value, window: merged.window } : {}) });
      if (merged) {
        this.host.refreshWatch();
        this.schedulePersist();
      }
    } catch (error) {
      this.set({ loadingOlder: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
