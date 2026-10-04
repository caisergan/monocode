// One runtime per paired host (12 §12.4), outside React: connection state,
// the channel, the watch, reconnects. Screens subscribe; streaming session
// events go straight to their listeners, not through React state.

import {
  ChannelRequestError,
  HandshakeFailure,
  isPairingWelcome,
  type Channel,
  type KeyPair,
  type Welcome,
} from "@monocode/channel";
import type { InboxList, SyncWindow, WatchSet } from "@monocode/core/wire";
import { race } from "./connect";
import { connectDemo } from "@/demo/demoHost";
import { HandshakeCounter, saveHostRecord } from "./secrets";
import type { HostConnState, HostRecord } from "./types";

const PING_MS = 15_000;
const REQUEST_WAIT_MS = 15_000;
const BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const LINGER_MS = 30_000;

export type SessionInterest = {
  /** What the phone holds now; sent with every watch.set. */
  current: () => { revision?: number; window: SyncWindow };
};

type RuntimeEvent =
  | { type: "state"; state: HostConnState }
  | { type: "evt"; name: string; data: unknown }
  | { type: "inbox"; inbox: InboxList };

export class HostRuntime {
  state: HostConnState = { kind: "idle" };
  inbox?: InboxList;
  private channel?: Channel;
  private counter: HandshakeCounter;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private waiters = new Set<() => void>();
  private attempt = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private connecting = false;
  private disposed = false;
  private preferred?: string;
  private inboxWatchers = 0;
  private sessions = new Map<string, { interest: SessionInterest; count: number; linger?: ReturnType<typeof setTimeout> }>();
  private watchTimer?: ReturnType<typeof setTimeout>;
  private inboxLoading?: Promise<void>;

  constructor(
    public record: HostRecord,
    private readonly deviceKey: KeyPair,
  ) {
    this.counter = new HandshakeCounter(record.env);
  }

  get env(): string {
    return this.record.env;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setState(state: HostConnState): void {
    this.state = state;
    this.emit({ type: "state", state });
    if (state.kind === "online") {
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }
  }

  /** No-op when online; skips any backoff wait for user and OS reasons. */
  connect(): void {
    if (this.disposed || this.connecting || this.state.kind === "online") return;
    if (this.state.kind === "blocked") return;
    clearTimeout(this.retry);
    this.connecting = true;
    this.setState(this.state.kind === "idle" || this.state.kind === "offline" ? { kind: "connecting" } : this.state);
    const attempt = this.record.demo
      ? connectDemo(this.deviceKey, 1)
      : race({
          env: this.record.env,
          hostKey: this.record.hostKey,
          deviceKey: this.deviceKey,
          endpoints: this.record.endpoints,
          preferred: this.preferred,
          nextCounter: () => this.counter.next(),
        });
    void attempt
      .then(({ channel, reply, candidate, rttMs }) => {
        this.connecting = false;
        if (this.disposed || isPairingWelcome(reply)) {
          channel.close();
          return;
        }
        this.attach(channel, reply as Welcome);
        this.preferred = candidate.key;
        this.attempt = 0;
        this.setState({ kind: "online", endpoint: candidate.key, via: candidate.endpoint.kind, rttMs, since: Date.now() });
      })
      .catch((error: Error) => {
        this.connecting = false;
        if (this.disposed) return;
        if (error instanceof HandshakeFailure && error.authenticated) {
          const reason = error.code;
          if (
            reason === "device_revoked" ||
            reason === "unknown_device" ||
            reason === "host_identity_changed" ||
            reason === "protocol_incompatible"
          ) {
            this.setState({ kind: "blocked", reason });
            return;
          }
        }
        const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)] * (0.8 + Math.random() * 0.4);
        this.attempt += 1;
        this.setState({
          kind: "offline",
          reason: "host_unreachable",
          retryAt: Date.now() + delay,
          lastOnlineAt: this.record.lastOnlineAt,
        });
        this.retry = setTimeout(() => this.connect(), delay);
      });
  }

  private attach(channel: Channel, welcome: Welcome): void {
    this.channel = channel;
    this.record = {
      ...this.record,
      hostName: welcome.host.name,
      fingerprint: welcome.host.fingerprint,
      endpoints: welcome.endpoints.length ? welcome.endpoints : this.record.endpoints,
      lastOnlineAt: Date.now(),
      lastWelcome: {
        host: welcome.host,
        capabilities: welcome.capabilities,
        providers: welcome.providers,
        limits: welcome.limits,
      },
    };
    if (!this.record.demo) void saveHostRecord(this.record);
    channel.onEvent((name, data) => this.event(name, data));
    channel.onClose((info) => {
      if (this.channel !== channel) return;
      this.channel = undefined;
      clearInterval(this.ping);
      if (info.bye === "device_revoked") {
        this.setState({ kind: "blocked", reason: "device_revoked" });
        return;
      }
      if (this.disposed) return;
      this.setState({ kind: "reconnecting", since: Date.now() });
      this.connect();
    });
    clearInterval(this.ping);
    this.ping = setInterval(() => {
      channel.ping({ visible: true }).catch(() => channel.close(4000, "ping timeout"));
    }, PING_MS);
    this.sendWatch();
    if (this.inboxWatchers > 0) void this.refreshInbox();
  }

  private event(name: string, data: unknown): void {
    if (name === "inbox.changed") void this.refreshInbox();
    if (name === "host.endpoints") {
      const endpoints = (data as { endpoints?: HostRecord["endpoints"] }).endpoints;
      if (endpoints?.length) {
        this.record = { ...this.record, endpoints };
        void saveHostRecord(this.record);
      }
    }
    this.emit({ type: "evt", name, data });
  }

  /** Reads wait up to 15 s for a channel, then fail with `offline`. */
  async request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this.channel) {
      this.connect();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new ChannelRequestError({ code: "offline", message: `${this.record.label} is offline`, retryable: true }));
        }, REQUEST_WAIT_MS);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
    return this.channel!.request<T>(method, params, { timeoutMs });
  }

  // ── Watch ────────────────────────────────────────────────────────────────

  watchInbox(): () => void {
    this.inboxWatchers += 1;
    this.scheduleWatch();
    if (this.channel) void this.refreshInbox();
    else this.connect();
    return () => {
      this.inboxWatchers -= 1;
      this.scheduleWatch();
    };
  }

  watchSession(id: string, interest: SessionInterest): () => void {
    const existing = this.sessions.get(id);
    if (existing) {
      clearTimeout(existing.linger);
      existing.linger = undefined;
      existing.count += 1;
      existing.interest = interest;
    } else this.sessions.set(id, { interest, count: 1 });
    this.scheduleWatch(true);
    this.connect();
    return () => {
      const entry = this.sessions.get(id);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count > 0) return;
      // A quick back-and-forth keeps the watch.
      entry.linger = setTimeout(() => {
        this.sessions.delete(id);
        this.scheduleWatch();
      }, LINGER_MS);
    };
  }

  /** Re-sends the watch, e.g. after loading older history moved the anchor. */
  refreshWatch(): void {
    this.scheduleWatch(true);
  }

  private scheduleWatch(now = false): void {
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => this.sendWatch(), now ? 0 : 50);
  }

  private sendWatch(): void {
    if (!this.channel) return;
    const watch: WatchSet = {
      inbox: this.inboxWatchers > 0,
      sessions: [...this.sessions.entries()].slice(-8).map(([id, entry]) => {
        const current = entry.interest.current();
        return {
          id,
          ...(current.revision !== undefined ? { revision: current.revision } : {}),
          window: current.window,
          maxBlockChars: 20_000,
        };
      }),
    };
    this.channel.request("watch.set", watch as Record<string, unknown>).catch(() => undefined);
  }

  refreshInbox(): Promise<void> {
    if (this.inboxLoading) return this.inboxLoading;
    this.inboxLoading = this.request<InboxList>("inbox.list", { limit: 200 })
      .then((inbox) => {
        this.inbox = inbox;
        this.emit({ type: "inbox", inbox });
      })
      .catch(() => undefined)
      .finally(() => {
        this.inboxLoading = undefined;
      });
    return this.inboxLoading;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  onForeground(): void {
    if (this.state.kind === "blocked") return;
    if (this.channel) {
      this.channel.ping({ visible: true }, 2_000).catch(() => this.channel?.close(4000, "verify failed"));
    } else {
      this.attempt = 0;
      this.connect();
    }
  }

  onBackground(): void {
    clearTimeout(this.retry);
    this.channel?.sayBye("background");
    this.channel = undefined;
    clearInterval(this.ping);
    this.setState({ kind: "idle" });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.channel?.sayBye("background");
    this.listeners.clear();
  }
}
