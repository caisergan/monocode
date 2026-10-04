// One open session's window (06 §6.7): the blocks from an anchor to the
// end, kept current by `session.sync` events. Listeners get the new value
// directly; the transcript is fed without a React render.

import { applySessionSync, type Block, type HostSession, type SessionSync } from "@monocode/core/session";
import type { WindowMeta, WindowedSync } from "@monocode/core/wire";
import type { HostRuntime } from "@/hosts/runtime";

const TAIL_TURNS = 20;
const OLDER_TURNS = 20;

export type WindowState = {
  value?: HostSession;
  window?: WindowMeta;
  /** "cached" until the first sync after the current watch was sent. */
  freshness: "cached" | "live";
  loadingOlder: boolean;
  error?: string;
};

export class SessionWindow {
  state: WindowState = { freshness: "cached", loadingOlder: false };
  private listeners = new Set<(state: WindowState) => void>();
  private stopWatch?: () => void;
  private stopEvents?: () => void;

  constructor(
    private readonly host: HostRuntime,
    readonly sessionId: string,
  ) {}

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
    this.stopEvents = this.host.subscribe((event) => {
      if (event.type === "state" && event.state.kind !== "online") this.set({ freshness: "cached" });
      if (event.type !== "evt") return;
      const data = event.data as { sessionId?: string; sync?: WindowedSync };
      if (data.sessionId !== this.sessionId) return;
      if (event.name === "session.sync" && data.sync) this.apply(data.sync);
      if (event.name === "session.deleted") this.set({ error: "This session was deleted." });
    });
    this.stopWatch = this.host.watchSession(this.sessionId, {
      current: () => ({
        revision: this.state.value?.revision,
        window: this.state.window?.anchor ? { anchor: this.state.window.anchor } : { tailTurns: TAIL_TURNS },
      }),
    });
  }

  close(): void {
    this.stopWatch?.();
    this.stopEvents?.();
    this.listeners.clear();
  }

  private apply(sync: WindowedSync): void {
    try {
      const value = applySessionSync(this.state.value, sync as SessionSync);
      this.set({ value, window: sync.window ?? this.state.window, freshness: "live", error: undefined });
    } catch {
      // Base mismatch: ask for a fresh snapshot of the same window.
      void this.host
        .request<WindowedSync>("sessions.sync", {
          sessionId: this.sessionId,
          window: this.state.window?.anchor ? { anchor: this.state.window.anchor } : { tailTurns: TAIL_TURNS },
          maxBlockChars: 20_000,
        })
        .then((fresh) => {
          if (fresh.kind === "snapshot") this.set({ value: fresh.value, window: fresh.window, freshness: "live" });
        })
        .catch(() => undefined);
    }
  }

  get hasOlder(): boolean {
    return (this.state.window?.olderTurns ?? 0) > 0;
  }

  /** Prepends the turns before the window; the first returned block becomes
   * the new anchor, which the next watch.set carries. */
  async loadOlder(): Promise<void> {
    const value = this.state.value;
    const first = value?.session.blocks[0];
    if (!value || !first || this.state.loadingOlder || !this.hasOlder) return;
    this.set({ loadingOlder: true });
    try {
      const older = await this.host.request<{ blocks: Block[]; olderTurns: number; revision: number }>(
        "sessions.blocks",
        { sessionId: this.sessionId, before: first.id, turns: OLDER_TURNS, maxBlockChars: 20_000 },
      );
      const current = this.state.value!;
      const blocks = [...older.blocks, ...current.session.blocks];
      this.set({
        value: { ...current, session: { ...current.session, blocks } },
        window: {
          anchor: blocks[0]?.id ?? null,
          olderTurns: older.olderTurns,
          olderBlocks: Math.max(0, (this.state.window?.olderBlocks ?? 0) - older.blocks.length),
        },
        loadingOlder: false,
      });
      this.host.refreshWatch();
    } catch (error) {
      this.set({ loadingOlder: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
