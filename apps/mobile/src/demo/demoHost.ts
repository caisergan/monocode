// The demo machine (12 §12.13): an in-process host that answers the phone's
// subset of the protocol from fixtures and simulates turns that stream, ask
// for approval and finish. It runs the real Noise channel over an in-memory
// socket, so everything above the transport is the production path.

import {
  FRAME_HANDSHAKE_1,
  FRAME_HANDSHAKE_2,
  IKResponder,
  SecureSession,
  channelPrologue,
  generateKeyPair,
  hostFingerprint,
  memorySocketPair,
  openChannel,
  toBase64Url,
  utf8,
  type ClientMessage,
  type KeyPair,
  type Welcome,
} from "@monocode/channel";
import type { HostProject, HostSession } from "@monocode/core/session";
import { compareInboxItems, lastAssistantText, pendingApproval, sessionAttention } from "@monocode/core/summary";
import { truncateBlock, windowMeta, windowStart, olderBlocks } from "@monocode/core/window";
import type { InboxItem, WatchSet } from "@monocode/core/wire";
import { hello } from "@/hosts/connect";
import type { Connected } from "@/hosts/connect";
import { answer, fixtureSession } from "@/transcript/fixtures";

export const DEMO_ENV = "00000000-0000-4000-8000-00000000d3e0";
const BOOT = "demo-boot";

type DemoSession = { value: HostSession; timers: ReturnType<typeof setTimeout>[] };

class DemoHost {
  readonly key = generateKeyPair();
  readonly fingerprint = hostFingerprint(this.key.publicKey);
  private projects: HostProject[] = [
    { id: "p-app", cwd: "/Users/demo/code/my-app", name: "my-app" },
    { id: "p-api", cwd: "/Users/demo/code/api", name: "api" },
  ];
  private sessions = new Map<string, DemoSession>();
  private inboxRevision = 1;
  private send?: (message: unknown, priority: 0 | 1 | 2) => void;
  private watch: WatchSet = {};
  private sent = new Map<string, number>();

  constructor() {
    const now = Date.now();
    const make = (id: string, projectId: string, title: string, turns: number, ago: number): HostSession => {
      const blocks = fixtureSession(turns, id.length * 31 + turns);
      return {
        projectId,
        revision: 1,
        status: "idle",
        createdAt: now - ago - 3_600_000,
        updatedAt: now - ago,
        session: {
          id,
          harness: "claude",
          model: "claude:opus-4-6",
          modelSettings: {},
          runtimeMode: "supervised",
          title,
          cwd: this.projects.find((p) => p.id === projectId)!.cwd,
          blocks,
        },
      };
    };
    for (const value of [
      make("s-auth", "p-app", "Fix flaky auth test", 6, 4 * 60_000),
      make("s-perf", "p-app", "Profile the transcript scroll", 40, 3 * 3_600_000),
      make("s-api", "p-api", "Add pagination to /sessions", 12, 26 * 3_600_000),
    ])
      this.sessions.set(value.session.id, { value, timers: [] });
  }

  attach(send: (message: unknown, priority: 0 | 1 | 2) => void): void {
    this.send = send;
    this.sent.clear();
  }

  private inboxItems(): InboxItem[] {
    const items: InboxItem[] = [];
    for (const { value } of this.sessions.values()) {
      const project = this.projects.find((p) => p.id === value.projectId)!;
      const approval = pendingApproval(value);
      items.push({
        sessionId: value.session.id,
        projectId: project.id,
        projectName: project.name,
        title: value.session.title,
        harness: "claude",
        model: value.session.model,
        runtimeMode: value.session.runtimeMode,
        status: value.status,
        runId: value.runId,
        attention: sessionAttention(value),
        needsInput: !!approval,
        ...(approval ? { approval } : {}),
        lastText: lastAssistantText(value.session.blocks),
        updatedAt: value.updatedAt,
        revision: value.revision,
        branch: value.session.id === "s-auth" ? "fix/auth" : "main",
      });
    }
    return items.sort(compareInboxItems);
  }

  private save(id: string, change: (value: HostSession) => HostSession): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    const before = entry.value;
    const next = change(before);
    entry.value = { ...next, revision: before.revision + 1, updatedAt: Date.now() };
    this.inboxRevision++;
    this.pushSession(id, before);
    this.send?.({ t: "evt", e: "inbox.changed", d: { boot: BOOT, revision: this.inboxRevision } }, 1);
  }

  /** Sends the watching phone a delta (or snapshot) for one session. */
  private pushSession(id: string, before?: HostSession): void {
    const watched = this.watch.sessions?.find((entry) => entry.id === id);
    const entry = this.sessions.get(id);
    if (!watched || !entry || !this.send) return;
    const value = entry.value;
    const { start } = windowStart(value.session.blocks, watched.window ?? { tailTurns: 20 });
    const meta = windowMeta(value.session.blocks, start);
    const lastSent = this.sent.get(id);
    const blocks = value.session.blocks.slice(start).map((block) => truncateBlock(block, 20_000));
    let sync;
    if (lastSent === undefined || !before || lastSent !== before.revision) {
      sync = { kind: "snapshot", value: { ...value, session: { ...value.session, blocks } }, window: meta };
    } else {
      const old = new Map(before.session.blocks.map((block) => [block.id, block]));
      const { blocks: _all, ...session } = value.session;
      sync = {
        kind: "delta",
        base: before.revision,
        value: { ...value, session },
        blockIds: blocks.map((block) => block.id),
        blocks: blocks.filter((block) => old.get(block.id) !== block),
        window: meta,
      };
    }
    this.sent.set(id, value.revision);
    this.send({ t: "evt", e: "session.sync", d: { sessionId: id, sync } }, 1);
  }

  /** A turn that streams, asks to run a command, then answers. */
  private runTurn(id: string, text: string, commandId: string): void {
    const entry = this.sessions.get(id)!;
    const runId = `run-${Date.now()}`;
    const started = Date.now();
    this.save(id, (value) => ({
      ...value,
      status: "running",
      runId,
      session: {
        ...value.session,
        blocks: [...value.session.blocks, { id: commandId, role: "user", text, startedAt: started, turnModel: { harness: "claude", id: "claude:opus-4-6", name: "Claude Opus 4.6" } }],
      },
    }));
    const steps: [number, (value: HostSession) => HostSession][] = [
      [600, (value) => ({ ...value, session: { ...value.session, blocks: [...value.session.blocks, { id: `${runId}-r`, role: "reasoning", text: "Looking at the failing test and the session store.", streaming: true }] } })],
      [1400, (value) => ({ ...value, session: { ...value.session, blocks: [...value.session.blocks.map((b) => (b.id === `${runId}-r` ? { ...b, streaming: false } : b)), { id: `${runId}-t1`, role: "tool", text: "Read src/auth/session.ts", tool: { kind: "read", status: "completed", preview: { kind: "read", path: "src/auth/session.ts" } } }] } })],
      [2200, (value) => ({ ...value, session: { ...value.session, blocks: [...value.session.blocks, { id: `${runId}-t2`, role: "tool", text: "npm test -- auth", tool: { kind: "execute", status: "pending", detail: "npm test -- auth" }, approval: { requestId: 7 } }] } })],
    ];
    for (const [delay, step] of steps) entry.timers.push(setTimeout(() => this.save(id, step), delay));
  }

  private continueTurn(id: string, decision: "allow" | "deny"): void {
    const entry = this.sessions.get(id)!;
    const runId = entry.value.runId;
    this.save(id, (value) => ({
      ...value,
      session: {
        ...value.session,
        blocks: value.session.blocks.map((block) =>
          block.approval?.requestId === 7 && !block.approval.decided
            ? { ...block, approval: { ...block.approval, decided: decision }, tool: { ...block.tool, status: decision === "allow" ? "completed" : "failed" } }
            : block,
        ),
      },
    }));
    const reply = answer(() => Math.random(), true);
    const answerId = `${runId}-a`;
    let offset = 0;
    const tick = () => {
      offset = Math.min(reply.length, offset + 3);
      this.save(id, (value) => {
        const blocks = value.session.blocks.filter((block) => block.id !== answerId);
        return { ...value, session: { ...value.session, blocks: [...blocks, { id: answerId, role: "assistant", text: reply.slice(0, offset), streaming: offset < reply.length }] } };
      });
      if (offset < reply.length) entry.timers.push(setTimeout(tick, 33));
      else
        entry.timers.push(
          setTimeout(
            () =>
              this.save(id, (value) => {
                const user = [...value.session.blocks].reverse().find((block) => block.role === "user");
                return {
                  ...value,
                  status: "idle",
                  session: {
                    ...value.session,
                    blocks: value.session.blocks.map((block) =>
                      block === user ? { ...block, durationMs: Date.now() - (block.startedAt ?? Date.now()) } : block,
                    ),
                  },
                };
              }),
            200,
          ),
        );
    };
    entry.timers.push(setTimeout(tick, 400));
  }

  handle(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "inbox.list":
        return { boot: BOOT, revision: this.inboxRevision, items: this.inboxItems(), truncated: false };
      case "projects.list":
        return this.projects;
      case "models.list":
        return { models: { claude: [{ id: "claude:opus-4-6", harness: "claude", name: "Claude Opus 4.6" }, { id: "claude:sonnet-5", harness: "claude", name: "Claude Sonnet 5" }] }, errors: {} };
      case "watch.set": {
        this.watch = params as WatchSet;
        this.sent.clear();
        for (const entry of this.watch.sessions ?? []) {
          const session = this.sessions.get(entry.id);
          if (!session) continue;
          if (entry.revision === session.value.revision) {
            this.sent.set(entry.id, entry.revision);
            const { start } = windowStart(session.value.session.blocks, entry.window ?? {});
            this.send?.({ t: "evt", e: "session.sync", d: { sessionId: entry.id, sync: { kind: "unchanged", revision: entry.revision, window: windowMeta(session.value.session.blocks, start) } } }, 1);
          } else this.pushSession(entry.id);
        }
        return {};
      }
      case "sessions.blocks": {
        const session = this.sessions.get(String(params.sessionId));
        if (!session) throw new Error("Session not found on this machine");
        const older = olderBlocks(session.value.session.blocks, String(params.before), Number(params.turns) || 20);
        return { blocks: older.blocks, hasOlder: older.olderTurns > 0, olderTurns: older.olderTurns, revision: session.value.revision };
      }
      case "commands.dispatch": {
        const command = params as { type: string; commandId: string; sessionId?: string; text?: string; decision?: "allow" | "deny"; projectId?: string };
        if (command.type === "create") {
          const id = `s-${command.commandId.slice(0, 8)}`;
          const project = this.projects.find((p) => p.id === command.projectId) ?? this.projects[0];
          this.sessions.set(id, {
            value: {
              projectId: project.id,
              revision: 0,
              status: "idle",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              session: { id, harness: "claude", model: "claude:opus-4-6", modelSettings: {}, runtimeMode: "supervised", title: "New session", cwd: project.cwd, blocks: [] },
            },
            timers: [],
          });
          return { commandId: command.commandId, sessionId: id, revision: 0 };
        }
        const id = String(command.sessionId);
        const session = this.sessions.get(id);
        if (!session) throw new Error("Session not found on this machine");
        if (command.type === "send") {
          if (session.value.status === "running") throw new Error("This session is already running");
          if (!session.value.session.blocks.length)
            this.save(id, (value) => ({ ...value, session: { ...value.session, title: String(command.text).slice(0, 60) } }));
          this.runTurn(id, String(command.text), command.commandId);
        } else if (command.type === "approve") this.continueTurn(id, command.decision ?? "allow");
        else if (command.type === "cancel") {
          session.timers.forEach(clearTimeout);
          session.timers = [];
          this.save(id, (value) => ({ ...value, status: "idle", session: { ...value.session, blocks: [...value.session.blocks, { id: `${Date.now()}-stop`, role: "system", text: "Stopped by you.", notice: "interrupt" }] } }));
        }
        return { commandId: command.commandId, sessionId: id, revision: session.value.revision };
      }
      default:
        throw new Error("Unsupported host method");
    }
  }
}

const demo = new DemoHost();

/** Opens a channel to the demo host over an in-memory socket pair. */
export async function connectDemo(deviceKey: KeyPair, n: number): Promise<Connected> {
  const [phone, side] = memorySocketPair();
  const responder = new IKResponder({ staticKey: demo.key, prologue: utf8(channelPrologue(DEMO_ENV)) });
  let session: SecureSession | undefined;
  side.onFrame = (frame) => {
    if (!session) {
      if (frame[0] !== FRAME_HANDSHAKE_1) return;
      responder.readMessage1(frame.subarray(1));
      const welcome: Welcome = {
        ok: true,
        channel: 1,
        env: DEMO_ENV,
        boot: BOOT,
        time: Date.now(),
        host: { name: "Demo", platform: "darwin", version: "demo", fingerprint: demo.fingerprint },
        device: { id: "demo-device", name: "This phone", role: "member" },
        capabilities: ["sessions", "approvals", "questions", "models.list", "channel.watch", "sessions.window", "sessions.page", "inbox", "devices"],
        providers: ["claude"],
        endpoints: [],
        relay: null,
        push: { enabled: false },
        limits: { maxMessage: 16 * 1024 * 1024, maxInFlight: 64, maxWatchedSessions: 8 },
      };
      const { message, transport } = responder.writeMessage2(utf8(JSON.stringify(welcome)));
      side.send(Uint8Array.of(FRAME_HANDSHAKE_2, ...message));
      session = new SecureSession(transport, side, { compress: false });
      demo.attach((message, priority) => session?.send(message, priority));
      return;
    }
    const message = session.receive(frame) as ClientMessage | undefined;
    if (!message) return;
    if (message.t === "ping") session.send({ t: "pong", ts: message.ts, now: Date.now() }, 0);
    if (message.t !== "req") return;
    try {
      const result = demo.handle(message.m, message.p ?? {});
      session.send({ t: "res", id: message.id, ok: true, r: result ?? null }, 0);
    } catch (error) {
      session.send({ t: "res", id: message.id, ok: false, e: { code: "invalid_params", message: (error as Error).message, retryable: false } }, 0);
    }
  };
  const { channel, reply } = await openChannel(phone, {
    env: DEMO_ENV,
    hostKey: toBase64Url(demo.key.publicKey),
    deviceKey,
    hello: hello(DEMO_ENV, n),
    compress: false,
  });
  return { channel, reply, candidate: { key: "demo", url: "memory://demo", endpoint: { kind: "manual", addr: "demo", port: 1 }, label: "Demo" }, rttMs: 0 };
}

export function demoRecord() {
  return {
    env: DEMO_ENV,
    label: "Demo",
    color: "hsl(211 92% 62%)",
    hostName: "Demo",
    platform: "darwin",
    fingerprint: demo.fingerprint,
    hostKey: toBase64Url(demo.key.publicKey),
    deviceId: "demo-device",
    role: "member" as const,
    endpoints: [],
    pairedAt: Date.now(),
    demo: true,
  };
}
