// The demo machine (12 §12.13): an in-process host that answers the phone's
// subset of the protocol from fixtures and simulates turns that stream, ask
// for approval or a question, and finish. It runs the real Noise channel over
// an in-memory socket, so everything above the transport is the production
// path. It pages session lists, serves older history, full blocks and
// attachments, sends `project.sessions` like the real host, and takes the
// write path: receipts by command id (with the host's error codes), keyed
// mutations, uploads, create with a first message and a worktree, the queue
// commands, answers, drafts and plans.
//
// Prompts steer the demo: "question" asks one, "plan" or Plan mode writes a
// plan, "usage limit" stops at a limit, "fail:" is refused for good, and
// "flaky" fails once with a retryable error.

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
  type ChannelErrorCode,
  type ClientMessage,
  type KeyPair,
  type Welcome,
} from "@monocode/channel";
import type { Attachment, Block, CommandReceipt, HostCommand, HostProject, HostSession, RemoteAttachment, TurnOutcome } from "@monocode/core/session";
import { compareInboxItems, lastAssistantText, pendingApproval, pendingQuestionSummary, sessionAttention } from "@monocode/core/summary";
import { truncateBlock, windowMeta, windowStart, olderBlocks } from "@monocode/core/window";
import type { InboxItem, SessionListItem, WatchSet } from "@monocode/core/wire";
import { hello } from "@/hosts/connect";
import type { Connected } from "@/hosts/connect";
import { answer, fixtureSession } from "@/transcript/fixtures";

export const DEMO_ENV = "00000000-0000-4000-8000-00000000d3e0";
const BOOT = "demo-boot";
const DAY = 24 * 3_600_000;

/** A 240×150 PNG of a test run, served by `attachments.read`. */
const DEMO_IMAGE_ID = "demo-failing-test";
const DEMO_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABvElEQVR42u3csQmEMACGUYcQC+urrxArd7hhsowgWLvGDeEsB4KNraRWL8YHr7OLX/WjKd5NB9koHAGCBkHDH4NeQojsn67fV2T/tJ2HiING0CBoBC1oBC1oBA1mOxA0ggZBQ1pBl1UN2RA0ggZBg6BB0AgaBA2CBkHDkUF/+h+3JmhBC1rQCFrQCFrQCFrQghY0CBoEDYIGQSNoyCnofpy4gBwFLWgELWhBI2hBI2hBCxqzHQgaQYOgQdAgaARttiOnqVHQCBoEjaAFjaAFjaDBDg2CBkGDoBE0+JbDUIWgBY2gBY2gBS1oQQta0ILGbAeCBkEjaBA0CBquDHoJAQ4naAQtaAQtaAQNgkbQZjsQNIIGQYOgQdDwnF+wvFpBCxpBCxpBCxpBCxpBI2gQNAgaBA2CRtBgtsP1wYJG0IJG0IJG0IIWtKARtNkOBA2CRtAgaBA0nB10Ow8kTsqCFrSgEbSgEbSgEbSgBS1oR4CgQdAgaBA0ggb3cuCSX0ELGkELGkELWtCCFrSgEbTZDgQNgkbQIGgQNAgaBI2gQdAgaBA0CBpBg6BB0CBoEDSCBkGDoEHQIGgEDQnbAO2auTPUugprAAAAAElFTkSuQmCC";
const DEMO_IMAGE_SIZE = 501;
/** Small reads (a multiple of three bytes) so the phone joins several. */
const IMAGE_CHUNK = 180;
const MAX_QUEUED = 100;
const TURN_MODEL = { harness: "claude" as const, id: "claude:opus-4-6", name: "Claude Opus 4.6" };

const OLD_TITLES = [
  "Migrate settings to the new store",
  "Investigate slow cold start",
  "Add keyboard shortcuts to the composer",
  "Clean up unused feature flags",
  "Fix the dark mode contrast in diffs",
  "Write release notes for 0.7",
  "Retry failed uploads",
  "Bump dependencies",
  "Explain the sync protocol",
  "Profile the file explorer",
  "Rename the session store",
  "Add tests for worktree switching",
];

/** A long test log, so the window carries a truncated copy (06 §6.7). */
function testLog(): string {
  const lines: string[] = [];
  for (let i = 0; lines.join("\n").length < 40_000; i++)
    lines.push(
      i % 37 === 36
        ? `  ✗ auth/session refresh races the token write (attempt ${i})`
        : `  ✓ auth/session case ${i}: refreshes a token that expires in ${i % 60}s (${(i * 7) % 90}ms)`,
    );
  return `> npm test -- auth --reporter verbose\n\n${lines.join("\n")}\n\nTests: 1 failed, ${lines.length - 1} passed`;
}

/** The host's errors (06 §6.11), so the phone sees real codes. */
class DemoError extends Error {
  constructor(
    readonly code: ChannelErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** When the last turn settled, as the host's `phoneSummary` reports it. */
function finishedAt(value: HostSession): number | undefined {
  if (value.status === "running") return undefined;
  const turn = [...value.session.blocks].reverse().find((block) => block.role === "user" && !block.draft);
  return value.finishedAt ?? (turn?.startedAt && turn.durationMs !== undefined ? turn.startedAt + turn.durationMs : undefined);
}

/** 8 hex chars from a string, standing in for the host's sha256 branch name. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

type Turn = { id: string; text: string; attachments?: Attachment[]; intent?: "default" | "plan" | "build"; planBlockId?: string };
type Waiting = { kind: "approval" | "question"; requestId: number; runId: string };
type DemoSession = { value: HostSession; timers: ReturnType<typeof setTimeout>[]; waiting?: Waiting; steer?: string };

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
  private projectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private receipts = new Map<string, { signature: string; receipt: Promise<CommandReceipt> }>();
  private mutations = new Map<string, { signature: string; result: unknown }>();
  private uploads = new Map<string, { size: number; data: string }>();
  private worktrees = new Map<string, { path: string; branch: string }[]>();
  private flaky = new Set<string>();
  private runs = 0;
  private requests = 100;

  constructor() {
    const now = Date.now();
    const make = (
      id: string,
      projectId: string,
      title: string,
      turns: number,
      ago: number,
      flags: { pinned?: boolean; archived?: boolean } = {},
    ): HostSession => {
      const blocks = fixtureSession(turns, id.length * 31 + turns);
      return {
        projectId,
        revision: 1,
        status: "idle",
        createdAt: now - ago - 3_600_000,
        updatedAt: now - ago,
        ...flags,
        session: {
          id,
          harness: "claude",
          model: "claude:opus-4-6",
          modelSettings: { effort: "high" },
          runtimeMode: "supervised",
          title,
          cwd: this.projects.find((p) => p.id === projectId)!.cwd,
          blocks,
        },
      };
    };
    const auth = make("s-auth", "p-app", "Fix flaky auth test", 6, 4 * 60_000);
    const blocks = auth.session.blocks;
    // The first prompt carries a screenshot; the last turn ran a long test log.
    const first = blocks.findIndex((block) => block.role === "user");
    blocks[first] = {
      ...blocks[first],
      attachments: [{ id: DEMO_IMAGE_ID, name: "failing-test.png", mimeType: "image/png", kind: "image", size: DEMO_IMAGE_SIZE }],
    };
    const command = "npm test -- auth --reporter verbose";
    const log: Block = { id: "t-log", role: "tool", text: command, tool: { kind: "execute", status: "completed", detail: command, preview: { kind: "shell", output: testLog() } } };
    blocks.splice(blocks.length - 1, 0, log);
    for (const value of [
      auth,
      make("s-perf", "p-app", "Profile the transcript scroll", 40, 3 * 3_600_000, { pinned: true }),
      make("s-api", "p-api", "Add pagination to /sessions", 12, 26 * 3_600_000),
      // Enough older sessions to page past the first 50.
      ...Array.from({ length: 58 }, (_, i) =>
        make(
          `s-old-${i}`,
          "p-app",
          OLD_TITLES[i % OLD_TITLES.length] + (i >= OLD_TITLES.length ? ` (${Math.floor(i / OLD_TITLES.length) + 1})` : ""),
          2,
          (8 + i) * DAY,
          { archived: i === 3 || i === 11 },
        ),
      ),
    ])
      this.sessions.set(value.session.id, { value, timers: [] });
    this.worktrees.set("p-app", [{ path: "/Users/demo/code/my-app-worktrees/fix-auth", branch: "fix/auth" }]);
  }

  attach(send: (message: unknown, priority: 0 | 1 | 2) => void): void {
    this.send = send;
    this.sent.clear();
  }

  private branch(id: string): string {
    return this.sessions.get(id)?.value.session.branch ?? (id === "s-auth" ? "fix/auth" : "main");
  }

  /** Like the host's inbox: running, needing input, or changed this week. */
  private inboxItems(): InboxItem[] {
    const items: InboxItem[] = [];
    const now = Date.now();
    for (const { value } of this.sessions.values()) {
      const project = this.projects.find((p) => p.id === value.projectId)!;
      const approval = pendingApproval(value);
      const question = pendingQuestionSummary(value);
      const finished = finishedAt(value);
      if (value.status !== "running" && !approval && !question && (value.archived || now - value.updatedAt > 7 * DAY)) continue;
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
        needsInput: !!approval || !!question,
        ...(approval ? { approval } : {}),
        ...(question ? { question } : {}),
        lastText: lastAssistantText(value.session.blocks),
        updatedAt: value.updatedAt,
        ...(finished ? { finishedAt: finished } : {}),
        revision: value.revision,
        branch: this.branch(value.session.id),
        ...(value.session.queuedMessages?.length ? { queueLength: value.session.queuedMessages.length } : {}),
        ...(value.pinned ? { pinned: true } : {}),
      });
    }
    return items.sort(compareInboxItems);
  }

  private summary(value: HostSession): SessionListItem {
    const project = this.projects.find((p) => p.id === value.projectId)!;
    const { session, blockRevisions: _revisions, finishedAt: _finished, lastTurnOutcome: _outcome, ...rest } = value;
    const finished = finishedAt(value);
    return {
      ...rest,
      id: session.id,
      title: session.title,
      harness: "claude",
      model: session.model,
      runtimeMode: session.runtimeMode,
      cwd: session.cwd,
      repo: project.name,
      branch: this.branch(session.id),
      needsInput: !!pendingApproval(value) || !!session.pendingQuestion,
      lastText: lastAssistantText(session.blocks),
      ...(session.queuedMessages?.length ? { queueLength: session.queuedMessages.length } : {}),
      ...(finished ? { finishedAt: finished } : {}),
    };
  }

  /** `sessions.page`, in the host's order and with its key cursors. */
  private page(params: Record<string, unknown>): { items: SessionListItem[]; cursor?: string } {
    const projectId = String(params.projectId ?? "");
    if (!this.projects.some((p) => p.id === projectId)) throw new DemoError("not_found", "Project is not registered on this machine");
    const archived = params.archived === "only" || params.archived === "include" ? params.archived : "exclude";
    const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 50)));
    const key = (value: HostSession): [number, number, string] => [value.pinned ? 1 : 0, value.updatedAt, value.session.id];
    const ordered = [...this.sessions.values()]
      .map((entry) => entry.value)
      .filter((value) => value.projectId === projectId)
      .filter((value) => (archived === "include" ? true : archived === "only" ? !!value.archived : !value.archived))
      .sort((a, b) => {
        const [ap, au, ai] = key(a);
        const [bp, bu, bi] = key(b);
        return bp - ap || bu - au || (ai < bi ? -1 : ai > bi ? 1 : 0);
      });
    const after = typeof params.cursor === "string" ? (JSON.parse(params.cursor) as [number, number, string]) : undefined;
    const start = after
      ? ordered.findIndex((value) => {
          const [p, u, i] = key(value);
          return p < after[0] || (p === after[0] && (u < after[1] || (u === after[1] && i > after[2])));
        })
      : 0;
    const slice = start < 0 ? [] : ordered.slice(start, start + limit);
    const more = start >= 0 && start + limit < ordered.length;
    return { items: slice.map((value) => this.summary(value)), ...(more ? { cursor: JSON.stringify(key(slice[slice.length - 1])) } : {}) };
  }

  /** `project.sessions` for a watched project, coalesced like the host's. */
  private projectChanged(projectId: string): void {
    if (!this.watch.projects?.includes(projectId) || this.projectTimers.has(projectId)) return;
    this.projectTimers.set(
      projectId,
      setTimeout(() => {
        this.projectTimers.delete(projectId);
        this.send?.({ t: "evt", e: "project.sessions", d: { projectId } }, 1);
      }, 500),
    );
  }

  private announce(projectId: string): void {
    this.inboxRevision++;
    this.projectChanged(projectId);
    this.send?.({ t: "evt", e: "inbox.changed", d: { boot: BOOT, revision: this.inboxRevision } }, 1);
  }

  private save(id: string, change: (value: HostSession) => HostSession): HostSession | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    const before = entry.value;
    const next = change(before);
    entry.value = { ...next, revision: before.revision + 1, updatedAt: Date.now() };
    this.pushSession(id, before);
    this.announce(entry.value.projectId);
    return entry.value;
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

  // ── Turns ─────────────────────────────────────────────────────────────────

  /** Starts a turn whose user block is `turn.id`, then simulates it: think,
   * read a file, then ask for approval, ask a question, write a plan, or
   * stop at a usage limit, depending on the prompt. */
  private beginTurn(id: string, turn: Turn): void {
    const entry = this.sessions.get(id)!;
    const runId = `run-${++this.runs}`;
    const started = Date.now();
    this.save(id, (value) => ({
      ...value,
      status: "running",
      runId,
      session: {
        ...value.session,
        usageLimit: undefined,
        title: value.session.blocks.some((block) => block.role === "user" && !block.draft) ? value.session.title : turn.text.trim().slice(0, 60) || "Image",
        blocks: [
          ...value.session.blocks.filter((block) => !block.draft),
          { id: turn.id, role: "user", text: turn.text, startedAt: started, turnModel: TURN_MODEL, ...(turn.attachments?.length ? { attachments: turn.attachments } : {}) },
        ],
      },
    }));
    const step = (delay: number, change: (value: HostSession) => HostSession) => entry.timers.push(setTimeout(() => this.save(id, change), delay));
    const append = (block: Block) => (value: HostSession): HostSession => ({ ...value, session: { ...value.session, blocks: [...value.session.blocks, block] } });
    step(600, append({ id: `${runId}-r`, role: "reasoning", text: "Looking at the failing test and the session store.", streaming: true }));
    step(1400, (value) =>
      append({ id: `${runId}-t1`, role: "tool", text: "Read src/auth/session.ts", tool: { kind: "read", status: "completed", preview: { kind: "read", path: "src/auth/session.ts" } } })({
        ...value,
        session: { ...value.session, blocks: value.session.blocks.map((b) => (b.id === `${runId}-r` ? { ...b, streaming: false } : b)) },
      }),
    );
    const text = turn.text.toLowerCase();
    if (turn.intent === "build" && turn.planBlockId) {
      const planId = turn.planBlockId;
      step(1600, (value) => ({ ...value, session: { ...value.session, blocks: value.session.blocks.map((b) => (b.id === planId ? { ...b, plan: { ...b.plan, status: "building" } } : b)) } }));
      entry.timers.push(setTimeout(() => this.streamAnswer(id, runId, "Built the plan: the session store now locks the token write.", () => this.markPlan(id, planId, "built")), 2_200));
    } else if (turn.intent === "plan" || /\bplan\b/.test(text)) {
      entry.timers.push(setTimeout(() => this.streamPlan(id, runId), 2_200));
    } else if (/question|\bask\b/.test(text)) {
      step(2200, (value) => {
        const requestId = ++this.requests;
        entry.waiting = { kind: "question", requestId, runId };
        return {
          ...value,
          session: {
            ...value.session,
            pendingQuestion: {
              requestId,
              title: "Before I change the store",
              questions: [
                {
                  id: "fix",
                  header: "Approach",
                  prompt: "How should the token refresh be serialised?",
                  multiSelect: false,
                  allowCustom: true,
                  options: [
                    { id: "lock", label: "A mutex around the write", description: "Smallest change; refreshes queue behind each other." },
                    { id: "single", label: "One in-flight refresh", description: "Later callers await the first refresh." },
                  ],
                },
                {
                  id: "tests",
                  header: "Tests",
                  prompt: "Which tests should I add?",
                  multiSelect: true,
                  allowCustom: false,
                  options: [
                    { id: "unit", label: "Unit tests" },
                    { id: "race", label: "A race reproduction" },
                  ],
                },
              ],
            },
          },
        };
      });
    } else if (/usage limit/.test(text)) {
      step(2200, (value) => this.settled({ ...value, session: { ...value.session, usageLimit: { resetsAt: Date.now() + 2 * 3_600_000 + 10 * 60_000 } } }, "paused"));
    } else {
      step(2200, (value) => {
        const requestId = ++this.requests;
        entry.waiting = { kind: "approval", requestId, runId };
        return append({ id: `${runId}-t2`, role: "tool", text: "npm test -- auth", tool: { kind: "execute", status: "pending", detail: "npm test -- auth" }, approval: { requestId } })(value);
      });
    }
  }

  private markPlan(id: string, planId: string, status: "building" | "built"): void {
    this.save(id, (value) => ({ ...value, session: { ...value.session, blocks: value.session.blocks.map((b) => (b.id === planId ? { ...b, plan: { ...b.plan, status } } : b)) } }));
  }

  private streamPlan(id: string, runId: string): void {
    const plan = [
      "## Serialise the token refresh",
      "",
      "1. Add a per-user lock in `src/auth/session.ts` around the token write.",
      "2. Make `refresh()` return the in-flight promise to later callers.",
      "3. Add a test that fires two refreshes and checks one write.",
    ].join("\n");
    this.save(id, (value) => ({ ...value, session: { ...value.session, blocks: [...value.session.blocks, { id: `${runId}-plan`, role: "plan", text: plan, plan: { status: "ready" } }] } }));
    this.sessions.get(id)!.timers.push(setTimeout(() => this.save(id, (value) => this.settled(value)), 300));
  }

  /** Streams an answer, then settles the turn. */
  private streamAnswer(id: string, runId: string, intro: string, then?: () => void): void {
    const entry = this.sessions.get(id)!;
    const reply = `${intro}\n\n${answer(() => Math.random(), true)}`;
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
          setTimeout(() => {
            this.save(id, (value) => this.settled(value));
            then?.();
            this.dispatchQueued(id);
          }, 200),
        );
    };
    entry.timers.push(setTimeout(tick, 400));
  }

  /** The turn's end: idle, with its duration and outcome; a limit pauses the
   * queue. */
  private settled(value: HostSession, queue?: "paused", outcome: TurnOutcome = "finished"): HostSession {
    const user = [...value.session.blocks].reverse().find((block) => block.role === "user");
    return {
      ...value,
      status: "idle",
      runId: undefined,
      finishedAt: Date.now(),
      lastTurnOutcome: outcome,
      session: {
        ...value.session,
        ...(queue && value.session.queuedMessages?.length ? { queueStatus: "paused" as const } : {}),
        blocks: value.session.blocks.map((block) => (block === user ? { ...block, durationMs: Date.now() - (block.startedAt ?? Date.now()) } : block)),
      },
    };
  }

  /** A settled session runs its queue head (06 §6.9), unless paused. A
   * steered message runs even then, and the queue stays paused. */
  private dispatchQueued(id: string, steer?: string): void {
    const entry = this.sessions.get(id);
    const queued = entry?.value.session.queuedMessages ?? [];
    if (!entry || entry.value.status === "running" || !queued.length) return;
    const steered = steer ? queued.find((message) => message.id === steer) : undefined;
    if (!steered && (entry.value.session.queueStatus === "paused" || entry.value.session.usageLimit)) return;
    const head = steered ?? queued[0];
    const rest = queued.filter((message) => message !== head);
    entry.value = { ...entry.value, session: { ...entry.value.session, queuedMessages: rest, queueStatus: rest.length ? entry.value.session.queueStatus : undefined } };
    this.beginTurn(id, { id: head.id, text: head.text, attachments: head.attachments, intent: head.intent === "plan" ? "plan" : "default" });
  }

  /** Cancels the running turn. `steer` is the queued message to send next. */
  private stopTurn(id: string, steer?: string): void {
    const entry = this.sessions.get(id)!;
    entry.timers.forEach(clearTimeout);
    entry.timers = [];
    entry.waiting = undefined;
    this.save(id, (value) => {
      const stopped = this.settled({
        ...value,
        session: {
          ...value.session,
          pendingQuestion: undefined,
          blocks: [...value.session.blocks.map((b) => (b.streaming ? { ...b, streaming: false } : b)), { id: `${Date.now()}-stop`, role: "system", text: "Stopped by you.", notice: "interrupt" }],
        },
      }, undefined, "cancelled");
      // A cancel pauses the queue; a steer runs its item next.
      return steer ? stopped : { ...stopped, session: { ...stopped.session, ...(stopped.session.queuedMessages?.length ? { queueStatus: "paused" as const } : {}) } };
    });
    if (steer) entry.timers.push(setTimeout(() => this.dispatchQueued(id, steer), 300));
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  /** `commands.dispatch`: one receipt per command id, like the host. */
  dispatch(command: HostCommand): Promise<CommandReceipt> {
    const signature = JSON.stringify(command);
    const previous = this.receipts.get(command.commandId);
    if (previous) {
      if (previous.signature !== signature) throw new DemoError("idempotency_conflict", "Command ID was already used with a different payload");
      return previous.receipt;
    }
    const receipt = this.execute(command);
    this.receipts.set(command.commandId, { signature, receipt });
    receipt.catch(() => this.receipts.delete(command.commandId));
    return receipt;
  }

  private attachments(files: readonly RemoteAttachment[] | undefined): Attachment[] {
    return (files ?? []).map((file) => {
      if (!this.uploads.has(file.id)) throw new DemoError("invalid_params", "Invalid attachment");
      return { id: file.id, name: file.name, mimeType: file.mimeType, kind: file.kind, size: file.size };
    });
  }

  private refuse(text: string, commandId: string): void {
    const prompt = text.trim().toLowerCase();
    if (prompt.startsWith("fail:")) throw new DemoError("provider_unavailable", "Claude is not available on this host");
    if (prompt.includes("flaky") && !this.flaky.has(commandId)) {
      this.flaky.add(commandId);
      throw new DemoError("branch_switching", "Wait for the branch switch to finish", true);
    }
  }

  private async execute(command: HostCommand): Promise<CommandReceipt> {
    if (command.type === "create") return this.create(command);
    const id = command.sessionId;
    const entry = this.sessions.get(id);
    if (!entry) throw new DemoError("not_found", "Session not found on this machine");
    const value = entry.value;
    const queued = value.session.queuedMessages ?? [];
    const findQueued = (queuedId: string) => {
      const item = queued.find((message) => message.id === queuedId);
      if (!item) throw new DemoError("not_found", "Queued message not found");
      return item;
    };
    const turnCheck = (runId: string) => {
      if (value.runId !== runId || value.status !== "running") throw new DemoError("stale_turn", "This request belongs to a finished or replaced turn");
    };
    switch (command.type) {
      case "send": {
        if (value.status === "running") throw new DemoError("session_busy", "This session is already running");
        this.refuse(command.text, command.commandId);
        const plan = command.planBlockId ? value.session.blocks.find((block) => block.id === command.planBlockId && block.role === "plan") : undefined;
        if (command.planBlockId && (!plan || plan.plan?.status === "building" || plan.plan?.status === "built"))
          throw new DemoError("plan_not_ready", "Plan is not ready to build");
        const draft = command.draftBlockId ? value.session.blocks.find((block) => block.id === command.draftBlockId && block.draft) : undefined;
        if (command.draftBlockId && !draft) throw new DemoError("not_found", "Draft not found");
        this.beginTurn(id, {
          id: command.commandId,
          text: draft?.text ?? command.text,
          attachments: draft?.attachments ?? this.attachments(command.attachments),
          intent: command.intent,
          planBlockId: command.planBlockId,
        });
        break;
      }
      case "queue": {
        this.refuse(command.text, command.commandId);
        const attachments = this.attachments(command.attachments);
        if (value.status !== "running" && !queued.length && !value.session.usageLimit)
          this.beginTurn(id, { id: command.commandId, text: command.text, attachments, intent: command.intent });
        else {
          if (queued.length >= MAX_QUEUED) throw new DemoError("invalid_params", `Invalid queue: at most ${MAX_QUEUED} messages can wait`);
          this.save(id, (v) => ({
            ...v,
            session: {
              ...v.session,
              queuedMessages: [...queued, { id: command.commandId, text: command.text, attachments, ...(command.intent ? { intent: command.intent } : {}) }],
              queueStatus: v.session.queueStatus ?? "active",
            },
          }));
        }
        break;
      }
      case "unqueue":
        findQueued(command.queuedId);
        this.save(id, (v) => {
          const rest = queued.filter((item) => item.id !== command.queuedId);
          return { ...v, session: { ...v.session, queuedMessages: rest, queueStatus: rest.length ? v.session.queueStatus : undefined } };
        });
        break;
      case "editQueued": {
        const item = findQueued(command.queuedId);
        if (!command.text.trim() && !item.attachments.length) throw new DemoError("invalid_params", "Invalid prompt");
        this.save(id, (v) => ({ ...v, session: { ...v.session, queuedMessages: queued.map((m) => (m === item ? { ...m, text: command.text } : m)) } }));
        break;
      }
      case "resumeQueue":
        this.save(id, (v) => ({ ...v, session: { ...v.session, usageLimit: undefined, queueStatus: queued.length ? "active" : undefined } }));
        this.dispatchQueued(id);
        break;
      case "steer": {
        turnCheck(command.runId);
        const item = findQueued(command.queuedId);
        entry.value = { ...value, session: { ...value.session, queuedMessages: [item, ...queued.filter((m) => m !== item)] } };
        this.stopTurn(id, command.queuedId);
        break;
      }
      case "cancel":
        turnCheck(command.runId);
        this.stopTurn(id);
        break;
      case "approve": {
        turnCheck(command.runId);
        if (entry.waiting?.kind !== "approval" || entry.waiting.requestId !== command.requestId) throw new DemoError("already_resolved", "Approval is already resolved");
        entry.waiting = undefined;
        this.save(id, (v) => ({
          ...v,
          session: {
            ...v.session,
            blocks: v.session.blocks.map((block) =>
              block.approval?.requestId === command.requestId && !block.approval.decided
                ? { ...block, approval: { ...block.approval, decided: command.decision }, tool: { ...block.tool, status: command.decision === "allow" ? "completed" : "failed" } }
                : block,
            ),
          },
        }));
        this.streamAnswer(id, command.runId, command.decision === "allow" ? "The tests ran." : "Skipped the test run.");
        break;
      }
      case "answer": {
        turnCheck(command.runId);
        if (entry.waiting?.kind !== "question" || value.session.pendingQuestion?.requestId !== command.requestId)
          throw new DemoError("already_resolved", "Question is already resolved");
        entry.waiting = undefined;
        this.save(id, (v) => ({ ...v, session: { ...v.session, pendingQuestion: undefined } }));
        const reply = command.reply.kind === "skipped" ? "No answer; going with a mutex." : `Going with: ${Object.values(command.reply.answers).flat().join(", ")}.`;
        this.streamAnswer(id, command.runId, reply);
        break;
      }
      case "configure":
        if (value.status === "running") throw new DemoError("session_busy", "Wait for the current turn before changing settings");
        this.save(id, (v) => ({ ...v, session: { ...v.session, model: command.model, modelSettings: command.modelSettings, runtimeMode: command.runtimeMode } }));
        break;
      case "compact":
        if (value.status === "running") throw new DemoError("session_busy", "This session is already running");
        this.save(id, (v) => ({
          ...v,
          session: { ...v.session, blocks: [...v.session.blocks, { id: command.commandId, role: "user", text: "/compact" }, { id: `${command.commandId}-c`, role: "system", text: "Context compacted." }] },
        }));
        break;
      case "draft":
        if (value.status === "running" || value.session.blocks.some((block) => block.draft))
          throw new DemoError("session_busy", "This session cannot save another draft right now");
        this.save(id, (v) => ({
          ...v,
          session: { ...v.session, blocks: [...v.session.blocks, { id: command.commandId, role: "user", text: command.text, draft: true, ...(command.attachments?.length ? { attachments: this.attachments(command.attachments) } : {}) }] },
        }));
        break;
      case "removeDraft":
        if (!value.session.blocks.some((block) => block.id === command.draftBlockId && block.draft)) throw new DemoError("not_found", "Draft not found");
        this.save(id, (v) => ({ ...v, session: { ...v.session, blocks: v.session.blocks.filter((block) => block.id !== command.draftBlockId) } }));
        break;
    }
    return { commandId: command.commandId, sessionId: id, revision: this.sessions.get(id)!.value.revision };
  }

  /** `create`, with a first message and a worktree when asked (06 §6.9). */
  private async create(command: Extract<HostCommand, { type: "create" }>): Promise<CommandReceipt> {
    const project = this.projects.find((p) => p.id === command.projectId);
    if (!project) throw new DemoError("not_found", "Project is not registered on this machine");
    if (command.harness !== "claude") throw new DemoError("provider_unavailable", `${command.harness} is not available on this host`);
    if (command.initial) this.refuse(command.initial.text, command.commandId);
    let cwd = command.worktree?.mode === "existing" ? command.worktree.cwd : (command.worktreeCwd ?? project.cwd);
    let branch: string | undefined;
    if (command.worktree?.mode === "new") {
      // Making a worktree takes a moment; a retry finds the same branch.
      branch = `mc/${shortHash(command.commandId)}`;
      const name = branch.slice(3);
      const trees = this.worktrees.get(project.id) ?? [];
      if (!trees.some((tree) => tree.branch === branch)) trees.push({ path: `${project.cwd}-worktrees/${name}`, branch });
      this.worktrees.set(project.id, trees);
      cwd = `${project.cwd}-worktrees/${name}`;
      await new Promise((resolve) => setTimeout(resolve, 700));
    } else if (command.worktree?.mode === "existing") branch = this.worktrees.get(project.id)?.find((tree) => tree.path === cwd)?.branch;
    const id = `s-${command.commandId.slice(0, 8)}`;
    const now = Date.now();
    this.sessions.set(id, {
      value: {
        projectId: project.id,
        revision: 0,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        session: {
          id,
          harness: "claude",
          model: command.model,
          modelSettings: command.modelSettings ?? {},
          runtimeMode: command.runtimeMode,
          title: "New remote session",
          cwd,
          ...(branch ? { branch, ...(cwd !== project.cwd ? { worktreeCwd: cwd } : {}) } : {}),
          blocks: [],
        },
      },
      timers: [],
    });
    if (command.initial)
      this.beginTurn(id, { id: command.commandId, text: command.initial.text, attachments: this.attachments(command.initial.attachments), intent: command.initial.intent });
    else this.announce(project.id);
    return { commandId: command.commandId, sessionId: id, revision: this.sessions.get(id)!.value.revision };
  }

  // ── Methods ───────────────────────────────────────────────────────────────

  /** Mutating methods with an envelope key run once (06 §6.8). */
  async handle(method: string, params: Record<string, unknown>, key?: string): Promise<unknown> {
    if (key && ["attachments.upload", "presence.update", "projects.open"].includes(method)) {
      const signature = `${method}|${JSON.stringify(params)}`;
      const previous = this.mutations.get(key);
      if (previous) {
        if (previous.signature !== signature) throw new DemoError("idempotency_conflict", "Idempotency key was already used with a different request");
        return previous.result;
      }
      const result = await this.call(method, params);
      this.mutations.set(key, { signature, result });
      return result;
    }
    return this.call(method, params);
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "inbox.list":
        return { boot: BOOT, revision: this.inboxRevision, items: this.inboxItems(), truncated: false };
      case "projects.list":
        return this.projects;
      case "projects.open": {
        const cwd = String(params.cwd ?? "").replace(/\/+$/, "");
        if (!cwd.startsWith("/")) throw new DemoError("invalid_params", "Choose an absolute directory path on the host");
        const existing = this.projects.find((p) => p.cwd === cwd);
        if (existing) return existing;
        const project = { id: `p-${shortHash(cwd)}`, cwd, name: cwd.split("/").pop() || cwd };
        this.projects.push(project);
        this.send?.({ t: "evt", e: "projects.changed", d: {} }, 1);
        return project;
      }
      case "models.list": {
        const settings = [
          { id: "fast", label: "Fast mode", kind: "toggle", value: "false", options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
          {
            id: "effort",
            label: "Effort",
            kind: "select",
            value: "high",
            options: [
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "max", label: "Max" },
            ],
          },
        ];
        return {
          models: {
            claude: [
              { id: "claude:opus-4-6", harness: "claude", name: "Claude Opus 4.6", settings },
              { id: "claude:sonnet-5", harness: "claude", name: "Claude Sonnet 5", settings },
            ],
          },
          errors: {},
        };
      }
      case "git.worktrees": {
        const project = this.projects.find((p) => p.id === params.projectId);
        if (!project) throw new DemoError("not_found", "Project is not registered on this machine");
        return [
          { path: project.cwd, branch: "main", head: "a1b2c3d", isMain: true, missing: false },
          ...(this.worktrees.get(project.id) ?? []).map((tree) => ({ path: tree.path, branch: tree.branch, head: "d4e5f6a", isMain: false, missing: false })),
        ];
      }
      case "git.branches":
        return { current: "main", branches: ["main", "fix/auth", "release/0.7"], remotes: [{ remote: "origin", name: "main" }] };
      case "presence.update":
        return {};
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
      case "sessions.page":
        return this.page(params);
      case "sessions.blocks": {
        const session = this.sessions.get(String(params.sessionId));
        if (!session) throw new DemoError("not_found", "Session not found on this machine");
        const older = olderBlocks(session.value.session.blocks, String(params.before), Number(params.turns) || 20);
        const max = Number(params.maxBlockChars) || 0;
        return {
          blocks: older.blocks.map((block) => truncateBlock(block, max)),
          hasOlder: older.olderTurns > 0,
          olderTurns: older.olderTurns,
          revision: session.value.revision,
        };
      }
      case "sessions.block": {
        const session = this.sessions.get(String(params.sessionId));
        const block = session?.value.session.blocks.find((item) => item.id === params.blockId);
        if (!session || !block) throw new DemoError("not_found", "Session not found on this machine");
        return { block, revision: session.value.revision };
      }
      case "attachments.upload": {
        const id = String(params.id ?? "");
        const offset = Number(params.offset);
        const size = Number(params.size);
        const data = String(params.data ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size > 20 * 1024 * 1024)
          throw new DemoError("invalid_params", "Invalid attachment chunk");
        const file = this.uploads.get(id) ?? { size, data: "" };
        const stored = (file.data.length / 4) * 3 - (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0);
        const bytes = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
        // Not in the host's code table (06 §6.11), so `internal`, as there.
        if (offset > stored) throw new DemoError("internal", "Attachment chunks are out of order");
        if (offset + bytes > size) throw new DemoError("invalid_params", "Invalid attachment chunk size");
        // A repeated chunk is already stored; offsets are multiples of three.
        if (offset === stored) this.uploads.set(id, { size, data: file.data + data });
        return { offset: offset + bytes };
      }
      case "attachments.read": {
        if (!this.sessions.has(String(params.sessionId))) throw new DemoError("not_found", "Session not found on this machine");
        const id = String(params.id);
        const upload = this.uploads.get(id);
        const image = id === DEMO_IMAGE_ID ? { data: DEMO_IMAGE, size: DEMO_IMAGE_SIZE } : upload;
        // Not in the host's code table (06 §6.11), so `internal`, as there.
        if (!image) throw new DemoError("internal", "Image attachment not found");
        const offset = Number(params.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > image.size || offset % 3) throw new DemoError("invalid_params", "Invalid attachment offset");
        const chunk = id === DEMO_IMAGE_ID ? IMAGE_CHUNK : 3 * 64 * 1024;
        const bytes = Math.min(chunk, image.size - offset);
        const start = (offset / 3) * 4;
        return { data: image.data.slice(start, start + Math.ceil(bytes / 3) * 4), offset: offset + bytes, size: image.size };
      }
      case "commands.dispatch":
        return this.dispatch(params as HostCommand);
      default:
        throw new DemoError("method_not_found", "Unsupported host method");
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
        capabilities: [
          "sessions",
          "approvals",
          "questions",
          "models.list",
          "channel.watch",
          "sessions.window",
          "sessions.page",
          "inbox",
          "devices",
          "attachments.read",
          "attachments.upload",
          "sessions.plan",
          "sessions.draft",
          "git.worktrees",
          "git.branches",
          "mutations.idempotent",
          "sessions.queue",
          "sessions.createWithPrompt",
          "presence",
        ],
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
    const reply = session;
    demo
      .handle(message.m, message.p ?? {}, message.key)
      .then((result) => reply.send({ t: "res", id: message.id, ok: true, r: result ?? null }, 0))
      .catch((error: unknown) => {
        const known = error instanceof DemoError ? error : undefined;
        reply.send(
          {
            t: "res",
            id: message.id,
            ok: false,
            e: { code: known?.code ?? "internal", message: (error as Error).message, retryable: known?.retryable ?? false },
          },
          0,
        );
      });
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
