import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mobileTranscript } from "../src/features/mobile/model/mobileTranscript";
import {
  turnsBefore,
  watchUpdate,
  watchWindow,
  type WatchBaseline,
} from "../src/features/mobile/model/mobileWatch";
import {
  highlightDiffForMobile,
  highlightForMobile,
  highlightInBackground,
  highlightProgress,
} from "../src/features/mobile/model/mobileHighlight";
import { buildUnifiedFile } from "../src/features/source-control/model/unifiedDiff";
import {
  HARNESS_TITLE,
  RUNTIME_MODES,
  RUNTIME_MODE_HINT,
  RUNTIME_MODE_LABEL,
  sessionDisplayTitle,
  type Block,
  type HarnessId,
  type RuntimeMode,
  type Session,
} from "../src/features/sessions/model/session";
import {
  mergeModelSettings,
  modelsFor,
  resolveModel,
} from "../src/features/sessions/model/models";
import {
  CUSTOM_OPTION_ID,
  buildQuestionReply,
  type UserQuestionPrompt,
  type UserQuestionReply,
} from "../src/features/sessions/model/userQuestion";
import type {
  HostModelCatalog,
  HostSession,
  HostSessionSummary,
  RemoteAttachment,
  RemoteProvider,
} from "../src/features/connections/model/protocol";
import type { HostEngine } from "./engine";
import { attachmentPath, MAX_REMOTE_ATTACHMENT_BYTES } from "./attachments";
import {
  createHostWorktree,
  hostWorktrees,
  resolveHostWorktreeAsync,
} from "./git-worktrees";
import {
  hostFileDiff,
  hostGitAction,
  hostGitIndex,
  listHostFiles,
  readHostFile,
  searchHostFiles,
} from "./workspace";
import { phoneReach, type PhoneReach } from "./tailscale";

// The phone app speaks to a paired desktop in requests shaped around what it
// shows: a workspace, conversations as turns, a project's files and changes.
// This answers the same requests from the host's own sessions, so a phone
// can carry on with this machine while no desktop is running. Phones reach
// it through Tailscale Serve (see ./tailscale.ts), never a public port.

/** Advertised by `environment.describe` once a host answers phones. */
export const PHONE_CAPABILITY = "phones.direct";
const PHONE_LINK_VERSION = 1;
/** A message's attachments arrive inline; the phone caps them at 24 MiB. */
const MAX_PHONE_BODY = 32 * 1024 * 1024;
const MAX_PHONE_ATTACHMENTS = 10;
/** As long as a desktop's pairing code lives. */
const INVITE_MS = 15 * 60_000;
const MAX_INVITES = 8;
/** A long poll waits at most this long, under Tailscale Serve's own timeout. */
const MAX_WAIT_MS = 25_000;
/** A watch the phone stopped polling is dropped after this. */
const WATCH_IDLE_MS = 90_000;
const MAX_WATCHES_PER_DEVICE = 4;
const MAX_WATCHES = 32;
/** Turns a watch opens on when the phone does not say; older ones page in. */
const DEFAULT_TAIL = 3;
const MAX_PAGE = 100;
/** Each project's most recent sessions ride the workspace poll. */
const RECENT_SESSIONS = 20;
const SESSION_PAGE_MAX = 100;
const BRANCH_TTL_MS = 10_000;
/** Bursts of streamed output coalesce into one frame. */
const FRAME_SETTLE_MS = 40;
const PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const PUSH_BODY_CHARS = 178;
/** As the desktop's project colours, in the order it hands them out. */
const PROJECT_COLORS = [
  "#459bf7",
  "#ea603e",
  "#f4c025",
  "#39c66d",
  "#e25a9e",
  "#b069d3",
  "#37beb3",
  "#ef8539",
];
const PREFERRED_PROVIDERS: RemoteProvider[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "pi",
  "omp",
  "fx",
  "hermes",
  "antigravity",
  "devin",
];

const exec = promisify(execFile);

type Params = Record<string, unknown>;
type PhoneApproval = {
  requestId: number;
  title: string;
  detail?: string;
  kind?: string;
};
type PhoneWatch = {
  id: string;
  deviceId: string;
  conversationId: string;
  baseline: WatchBaseline | null;
  /** The approval as last sent, as JSON. */
  approval: string | null;
  tail: number;
  incremental: boolean;
  from: string | null;
  /** Frames are numbered; a phone that lost a reply asks for it again. */
  seq: number;
  last: unknown[];
  polled: number;
};
type Catalogs = (projectId?: unknown) => Promise<HostModelCatalog>;

export class PhoneLink {
  private watches = new Map<string, PhoneWatch>();
  private waiters = new Map<string, Set<() => void>>();
  private branches = new Map<string, { at: number; branch: Promise<string> }>();
  /** Sessions whose current turn a phone started: theirs to be told of. */
  private phoneTurns = new Set<string>();
  /** How each session stood when last seen, for notifications. */
  private seen = new Map<string, { running: boolean; input?: string }>();
  private stopListening: () => void;
  private closed = false;
  private readonly name = hostname();

  constructor(
    private readonly engine: HostEngine,
    private readonly providers: RemoteProvider[],
    private readonly catalogs: Catalogs,
    private readonly port: number,
    private readonly pushEndpoint = PUSH_ENDPOINT,
  ) {
    for (const value of engine.store.sessions()) this.seen.set(value.session.id, stance(value));
    this.stopListening = engine.store.onSessionChange((id) => {
      for (const wake of this.waiters.get(id) ?? []) wake();
      this.notifyChange(id);
    });
  }

  close(): void {
    this.closed = true;
    this.stopListening();
    for (const waiters of this.waiters.values()) for (const wake of waiters) wake();
  }

  // MARK: pairing, from a desktop over /rpc

  /** A one-use code for a phone, and the link its QR code holds. */
  async invite(params: Params): Promise<PhoneInvite> {
    const url = typeof params.url === "string" && params.url.trim() ? phoneUrl(params.url) : undefined;
    return createPhoneInvite(this.engine.store, await phoneReach(this.port), url);
  }

  /** Whether the phone holding `code` has paired, and as what. */
  inviteStatus(params: Params): { paired: string | null; expired: boolean } {
    const invite = this.engine.store.phoneInvite(digest(String(params.code ?? "")));
    if (!invite) return { paired: null, expired: true };
    return {
      paired: invite.paired,
      expired: !invite.paired && invite.expires <= Date.now(),
    };
  }

  // MARK: requests from phones on /mobile

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, value: object): void => {
      response.writeHead(status).end(JSON.stringify(value));
    };
    try {
      if (request.headers.origin || request.method !== "POST")
        return reply(403, { ok: false, error: "Unsupported request origin or route" });
      const input = await readBody(request);
      if (input.version !== PHONE_LINK_VERSION)
        throw new Error("Update the MonoCode app to connect to this machine");
      const method = String(input.method ?? "");
      const params =
        input.params && typeof input.params === "object" && !Array.isArray(input.params)
          ? (input.params as Params)
          : {};
      const id = typeof input.id === "string" ? input.id : "";
      if (method === "device.enroll") return reply(200, { ok: true, result: this.enroll(params) });
      const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      const deviceId = token ? this.engine.store.deviceId(token) : undefined;
      if (!token || !deviceId)
        return reply(401, {
          ok: false,
          error: "This phone is no longer paired with this machine. Pair it again.",
        });
      const result = await this.dispatch(deviceId, token, method, params, id);
      reply(200, { ok: true, result: result ?? null });
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        reply(200, {
          ok: false,
          error: error instanceof Error ? error.message : "Request failed",
        });
    }
  }

  private enroll(params: Params) {
    const name =
      typeof params.name === "string" && params.name.trim()
        ? params.name.trim().slice(0, 100)
        : "Phone";
    const store = this.engine.store;
    const device = store.transaction(() => {
      if (!store.usePhoneInvite(digest(String(params.code ?? "")), name))
        throw new Error("This code expired or was used. Make a new one on your desktop.");
      return store.issueDevice(name);
    });
    return {
      token: device.token,
      deviceId: device.id,
      name: this.name,
      environmentId: this.engine.store.environmentId,
    };
  }

  private async dispatch(
    deviceId: string,
    token: string,
    method: string,
    params: Params,
    id: string,
  ): Promise<unknown> {
    switch (method) {
      case "workspace.list":
        return this.workspace();
      case "sessions.list":
        return this.sessionPage(params);
      case "conversation.read":
        return this.conversation(this.sessionId(params));
      case "conversation.older":
        return this.older(params);
      case "conversation.watch":
        return this.openWatch(deviceId, params);
      case "watch.next":
        return this.nextFrames(deviceId, params);
      case "watch.close": {
        const watch = this.watches.get(String(params.watchId ?? ""));
        if (watch?.deviceId === deviceId) {
          this.watches.delete(watch.id);
          // Its poll in flight answers now rather than at the end of its wait.
          for (const wake of this.waiters.get(watch.conversationId) ?? []) wake();
        }
        return null;
      }
      case "models.list":
        return this.models(params);
      case "session.start":
        return this.start(params, commandId(id));
      case "conversation.send":
        return this.send(params, commandId(id));
      case "session.cancel":
        return this.cancel(params, commandId(id));
      case "session.configure":
        return this.configure(params, commandId(id));
      case "session.approve":
        return this.approve(params, commandId(id));
      case "session.answerQuestion":
        return this.answer(params, commandId(id));
      case "session.keepQuestionOpen":
        // The host has no timed questions of its own to hold open.
        return { sessionId: this.sessionId(params) };
      case "session.rename": {
        const title = typeof params.title === "string" ? params.title.trim() : "";
        if (!title || title.length > 200) throw new Error("Enter a title under 200 characters");
        const sessionId = this.sessionId(params);
        this.engine.updateSession(sessionId, { title });
        return { sessionId };
      }
      case "session.archive": {
        const sessionId = this.sessionId(params);
        this.engine.updateSession(sessionId, { archived: true });
        return { sessionId };
      }
      case "session.delete": {
        const sessionId = this.sessionId(params);
        this.engine.store.deleteSession(sessionId);
        return { sessionId };
      }
      case "session.resumeUsage":
      case "session.resumeUsageAtReset":
        throw new Error("Resume this session from your desktop");
      case "device.push": {
        const pushToken = params.token;
        if (pushToken !== null && (typeof pushToken !== "string" || !/^Expo(nent)?PushToken\[[^\]]{1,200}\]$/.test(pushToken)))
          throw new Error("Invalid push token");
        const disabled = Array.isArray(params.disabled)
          ? params.disabled.filter((entry): entry is string => typeof entry === "string").slice(0, 10)
          : [];
        this.engine.store.setPhonePush(deviceId, pushToken, disabled);
        return null;
      }
      case "device.leave":
        this.engine.store.revokeToken(token);
        for (const [key, watch] of this.watches) if (watch.deviceId === deviceId) this.watches.delete(key);
        return null;
      case "project.files":
        return this.files(params);
      case "project.file":
        return this.file(params);
      case "project.fileHighlight":
        return highlightProgress(String(params.job ?? ""), Math.max(0, Number(params.from) || 0));
      case "project.search":
        return this.search(params);
      case "project.changes":
        return this.changes(params);
      case "project.git":
        return this.git(params);
      case "project.gitAction":
        return this.gitAction(params);
      case "project.worktrees":
        return this.worktrees(params);
      default:
        if (method.startsWith("mono.")) throw new Error("Monos live on your desktop");
        if (method === "accounts.usage")
          throw new Error("Account usage shows on your desktop");
        throw new Error("This machine can't do that from the phone yet");
    }
  }

  // MARK: the workspace

  private async workspace() {
    const projects = this.engine.store.projects();
    const sessions: ReturnType<PhoneLink["phoneSession"]>[] = [];
    const listed = await Promise.all(
      projects.map(async (project) => {
        const summaries = this.engine.store
          .summaries(project.id)
          .filter((summary) => !summary.archived && !summary.draft);
        const recent = summaries.filter(
          (summary, index) => index < RECENT_SESSIONS || summary.status === "running",
        );
        const branches = await Promise.all(
          recent.map((summary) => this.branch(summary.cwd ?? project.cwd)),
        );
        recent.forEach((summary, index) =>
          sessions.push(this.phoneSession(summary, project.cwd, branches[index])),
        );
        return { project, summaries, branch: await this.branch(project.cwd) };
      }),
    );
    return {
      projects: listed.map(({ project, summaries, branch }, index) => {
        const defaults = this.defaults(summaries[0]);
        return {
          id: project.id,
          path: project.cwd,
          name: project.name || basename(project.cwd),
          machine: this.name,
          branch,
          color: PROJECT_COLORS[colorIndex(project.cwd, index)],
          additions: 0,
          deletions: 0,
          busy: summaries.some((summary) => summary.status === "running"),
          defaultHarness: defaults.harness,
          defaultModel: defaults.model,
          defaultModelName: resolveModel(defaults.harness, defaults.model).name,
          defaultRuntimeMode: defaults.runtimeMode,
        };
      }),
      monos: [],
      sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
      push: true,
      approvals: true,
    };
  }

  /** A host session as the phone lists it. */
  private phoneSession(summary: HostSessionSummary, projectCwd: string, branch: string) {
    const running = summary.status === "running";
    const waiting = summary.needsInput ? this.waitingOn(summary.id) : undefined;
    return {
      id: summary.id,
      projectId: summary.projectId,
      title: sessionDisplayTitle(summary.title, summary.harness),
      harness: summary.harness,
      model: summary.model ?? "",
      modelName: resolveModel(summary.harness, summary.model).name,
      branch,
      ...(summary.cwd && summary.cwd !== projectCwd ? { worktreePath: summary.cwd } : {}),
      ...(summary.runtimeMode ? { runtimeMode: summary.runtimeMode } : {}),
      updatedAt: summary.updatedAt,
      busy: running,
      ...(waiting ? { waiting } : {}),
    };
  }

  private waitingOn(sessionId: string): "approval" | "question" | undefined {
    const session = this.engine.store.session(sessionId).session;
    if (pendingApproval(session)) return "approval";
    return session.pendingQuestion ? "question" : undefined;
  }

  /** What a new session in a project starts with: as its latest one did,
   *  else the first provider this host has, supervised. */
  private defaults(latest?: HostSessionSummary): {
    harness: RemoteProvider;
    model: string;
    runtimeMode: RuntimeMode;
  } {
    if (latest && this.providers.includes(latest.harness)) {
      return {
        harness: latest.harness,
        model: resolveModel(latest.harness, latest.model).id,
        runtimeMode: latest.runtimeMode ?? "supervised",
      };
    }
    const harness =
      PREFERRED_PROVIDERS.find((provider) => this.providers.includes(provider)) ??
      this.providers[0] ??
      "claude";
    return { harness, model: resolveModel(harness).id, runtimeMode: "supervised" };
  }

  private branch(cwd: string): Promise<string> {
    const cached = this.branches.get(cwd);
    if (cached && Date.now() - cached.at < BRANCH_TTL_MS) return cached.branch;
    const branch = exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      timeout: 2_000,
    })
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
    this.branches.set(cwd, { at: Date.now(), branch });
    return branch;
  }

  /** One page of a project's sessions, newest first, as the Sessions sheet asks. */
  private async sessionPage(params: Params) {
    const project = this.engine.store.project(String(params.projectId ?? ""));
    const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
    const offset = Math.max(0, Number(params.offset) || 0);
    const limit = Math.min(SESSION_PAGE_MAX, Math.max(1, Number(params.limit) || 30));
    const since = Number(params.since) || 0;
    const hidden = Array.isArray(params.hiddenHarnesses) ? params.hiddenHarnesses : [];
    const matches = this.engine.store
      .summaries(project.id)
      .filter((summary) => !summary.archived && !summary.draft)
      .filter((summary) => since <= 0 || summary.updatedAt >= since)
      .filter((summary) => !hidden.includes(summary.harness))
      .filter(
        (summary) =>
          !query ||
          [summary.title, summary.model ?? ""].some((field) =>
            field.toLowerCase().includes(query),
          ),
      );
    const page = matches.slice(offset, offset + limit);
    const branches = await Promise.all(page.map((summary) => this.branch(summary.cwd ?? project.cwd)));
    return {
      sessions: page.map((summary, index) => this.phoneSession(summary, project.cwd, branches[index])),
      hasMore: offset + limit < matches.length,
    };
  }

  // MARK: conversations

  private sessionId(params: Params): string {
    const id = String(params.conversationId ?? params.sessionId ?? "");
    if (id.startsWith("mono:")) throw new Error("Monos live on your desktop");
    this.engine.store.session(id);
    return id;
  }

  private conversation(id: string, range?: (turnIds: string[]) => [number, number]) {
    const value = this.engine.store.session(id);
    const busy = value.status === "running";
    const session = value.session;
    return {
      id,
      messages: session.blocks
        .filter(
          (block) =>
            (block.role === "user" || block.role === "assistant") &&
            !block.internal &&
            !block.draft,
        )
        .slice(-200)
        .map((block) => ({ id: block.id, role: block.role, text: block.text })),
      turns: mobileTranscript(
        { ...session, busy },
        {
          busy,
          pendingQuestion: !!session.pendingQuestion,
          backgroundTasks: session.backgroundTasks,
          range,
        },
      ),
      busy,
      usageLimit: null,
      question: phoneQuestion(session.pendingQuestion),
      approval: pendingApproval(session) ?? null,
    };
  }

  private older(params: Params) {
    const id = this.sessionId(params);
    let older = false;
    const conversation = this.conversation(id, (turnIds) => {
      const page = turnsBefore(
        turnIds,
        String(params.before ?? ""),
        Math.min(MAX_PAGE, Math.max(1, Number(params.limit) || DEFAULT_TAIL)),
      );
      older = page.older;
      return [page.start, page.end];
    });
    return { turns: conversation.turns, older };
  }

  private openWatch(deviceId: string, params: Params) {
    this.dropIdleWatches();
    const conversationId = this.sessionId(params);
    const mine = [...this.watches.values()].filter((watch) => watch.deviceId === deviceId);
    // The phone's oldest watch goes first: it reopens what it still shows.
    if (mine.length >= MAX_WATCHES_PER_DEVICE)
      this.watches.delete(mine.sort((a, b) => a.polled - b.polled)[0].id);
    if (this.watches.size >= MAX_WATCHES) throw new Error("This machine is watching too many conversations");
    const watch: PhoneWatch = {
      id: randomBytes(12).toString("base64url"),
      deviceId,
      conversationId,
      baseline: null,
      approval: null,
      tail: Math.min(MAX_PAGE, Math.max(1, Number(params.tail) || DEFAULT_TAIL)),
      incremental: params.incremental === true,
      from: typeof params.from === "string" ? params.from : null,
      seq: 0,
      last: [],
      polled: Date.now(),
    };
    this.watches.set(watch.id, watch);
    return { watchId: watch.id };
  }

  /**
   * The watch's next frames: at once when the conversation changed since the
   * last ones, otherwise when it next does, or none after `wait`. Each reply
   * carries the number of its frames; asked again for the same number, the
   * phone lost that reply and gets it again.
   */
  private async nextFrames(deviceId: string, params: Params) {
    const watch = this.watches.get(String(params.watchId ?? ""));
    if (!watch || watch.deviceId !== deviceId)
      throw new Error("Transcript window needs to reopen");
    watch.polled = Date.now();
    const after = Number(params.after);
    if (Number.isSafeInteger(after) && after === watch.seq - 1)
      return { seq: watch.seq, updates: watch.last };
    if (Number.isSafeInteger(after) && after !== watch.seq)
      throw new Error("Transcript window needs to reopen");
    const deadline = Date.now() + Math.min(MAX_WAIT_MS, Math.max(0, Number(params.wait) || 0));
    for (;;) {
      if (this.closed) throw new Error("This machine's host is restarting");
      if (!this.watches.has(watch.id)) throw new Error("Transcript window needs to reopen");
      const frame = this.frame(watch);
      if (frame) {
        watch.seq += 1;
        watch.last = [frame];
        return { seq: watch.seq, updates: watch.last };
      }
      const left = deadline - Date.now();
      if (left <= 0) return { seq: watch.seq, updates: [] };
      await this.changeOf(watch.conversationId, left);
      await new Promise((resolve) => setTimeout(resolve, FRAME_SETTLE_MS));
      watch.polled = Date.now();
    }
  }

  /** What changed for a watch since its baseline; null when nothing did. */
  private frame(watch: PhoneWatch): object | null {
    let conversation: ReturnType<PhoneLink["conversation"]>;
    let older = false;
    try {
      conversation = this.conversation(watch.conversationId, (turnIds) => {
        const window = watchWindow(turnIds, watch.from, watch.tail);
        watch.from = window.from;
        older = window.older;
        return [window.start, turnIds.length];
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const gone = message.includes("not found")
        ? "This session is no longer on this machine"
        : message;
      if (watch.baseline === null && watch.seq > 0) return null;
      watch.baseline = { busy: false, older: false, question: "null", order: [], turns: new Map() };
      return { error: gone };
    }
    const next = watchUpdate(
      watch.baseline,
      {
        busy: conversation.busy,
        older,
        turns: conversation.turns,
        question: conversation.question as UserQuestionPrompt | null,
        usageLimit: null,
      },
      watch.incremental,
    );
    const approval = JSON.stringify(conversation.approval);
    if (!next && approval === watch.approval) return null;
    if (next) watch.baseline = next.baseline;
    const update: Record<string, unknown> = { ...(next?.update ?? {}) };
    if (approval !== watch.approval) update.approval = conversation.approval;
    watch.approval = approval;
    return update;
  }

  /** Resolves when the session next changes, or after `ms`. */
  private changeOf(sessionId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(sessionId) ?? new Set();
      this.waiters.set(sessionId, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (!waiters.size) this.waiters.delete(sessionId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  private dropIdleWatches() {
    const now = Date.now();
    for (const [id, watch] of this.watches)
      if (now - watch.polled > WATCH_IDLE_MS) this.watches.delete(id);
  }

  // MARK: models

  private async models(params: Params) {
    const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";
    const current = conversationId ? this.engine.store.session(this.sessionId(params)) : undefined;
    const projectId = current?.projectId ?? String(params.projectId ?? "");
    const project = this.engine.store.project(projectId);
    // Probes each provider's CLI and fills the shared model lists.
    await this.catalogs(project.id).catch(() => undefined);
    const defaults = this.defaults(this.engine.store.summaries(project.id)[0]);
    const harness = (current?.session.harness as RemoteProvider | undefined) ?? defaults.harness;
    const model = resolveModel(harness, current?.session.model ?? defaults.model);
    return {
      harnesses: this.providers.map((id) => ({ id, label: HARNESS_TITLE[id] })),
      models: this.providers.flatMap((provider) =>
        modelsFor(provider).map((entry) => ({
          id: entry.id,
          harness: entry.harness,
          name: entry.name,
          provider: entry.provider?.name,
          settings: entry.settings ?? [],
        })),
      ),
      runtimeModes: RUNTIME_MODES.map((id) => ({
        id,
        label: RUNTIME_MODE_LABEL[id],
        hint: RUNTIME_MODE_HINT[id],
      })),
      current: {
        harness: model.harness,
        model: model.id,
        modelSettings: mergeModelSettings(model, current?.session.modelSettings),
        runtimeMode: current?.session.runtimeMode ?? defaults.runtimeMode,
      },
    };
  }

  /** The model sheet's choice, keeping only what this host can run. */
  private choice(params: Params, fallback: { harness: RemoteProvider; model: string; modelSettings?: Record<string, string>; runtimeMode: RuntimeMode }) {
    const harness = this.providers.find((id) => id === params.harness);
    const picked = typeof params.model === "string" && params.model.length <= 256 ? params.model : undefined;
    const model = harness ? resolveModel(harness, picked) : resolveModel(fallback.harness, fallback.model);
    const raw = params.modelSettings;
    const settings =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string" && entry[1].length <= 64,
            ),
          )
        : fallback.modelSettings;
    const runtimeMode = RUNTIME_MODES.find((mode) => mode === params.runtimeMode) ?? fallback.runtimeMode;
    return {
      harness: model.harness as RemoteProvider,
      model: model.id,
      modelSettings: mergeModelSettings(model, settings),
      runtimeMode,
    };
  }

  // MARK: commands

  private async start(params: Params, commandId: string) {
    const project = this.engine.store.project(String(params.projectId ?? ""));
    const text = messageText(params);
    const pick = () => this.choice(params, this.defaults(this.engine.store.summaries(project.id)[0]));
    let choice = pick();
    // Some providers (Codex) list their models only once their CLI is asked.
    if (!choice.model) {
      await this.catalogs(project.id).catch(() => undefined);
      choice = pick();
    }
    if (!choice.model) throw new Error("Choose a model for this session first");
    if (!this.providers.includes(choice.harness))
      throw new Error(`${HARNESS_TITLE[choice.harness as HarnessId]} is not installed on this machine`);
    const attachments = this.stage(params.attachments, commandId);
    // A new worktree off HEAD, named as the desktop's composer names one, so
    // the first turn renames its branch; or one of the project's worktrees.
    let worktreeCwd: string | undefined;
    let autoWorktreeBranch: string | undefined;
    if (params.workspaceMode === "worktree") {
      autoWorktreeBranch = `mc/${createHash("sha256").update(commandId).digest("hex").slice(0, 8)}`;
      const existing = (await hostWorktrees(project.cwd)).worktrees.find(
        (tree) => tree.branch === autoWorktreeBranch && !tree.missing,
      );
      worktreeCwd = (
        existing ?? (await createHostWorktree(project.cwd, autoWorktreeBranch, "HEAD", false))
      ).path;
    } else if (typeof params.worktreePath === "string") {
      worktreeCwd = await this.worktree(project.cwd, params.worktreePath);
    }
    const created = this.engine.command({
      type: "create",
      commandId: `${commandId}:create`,
      projectId: project.id,
      ...(worktreeCwd ? { worktreeCwd } : {}),
      ...(autoWorktreeBranch ? { autoWorktreeBranch } : {}),
      harness: choice.harness,
      model: choice.model,
      modelSettings: choice.modelSettings,
      runtimeMode: choice.runtimeMode,
    });
    this.engine.command({
      type: "send",
      commandId: `${commandId}:send`,
      sessionId: created.sessionId,
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    this.phoneTurns.add(created.sessionId);
    return { sessionId: created.sessionId };
  }

  /** A message from the phone: a new turn, or mid-turn one the agent reads
   *  now when its provider takes one. */
  private send(params: Params, commandId: string) {
    const sessionId = this.sessionId(params);
    const text = messageText(params);
    const attachments = this.stage(params.attachments, commandId);
    const value = this.engine.store.session(sessionId);
    // A retry of a message already taken: the turn it started may be running.
    if (value.session.blocks.some((block) => block.id === commandId)) return { sessionId };
    const running = value.status === "running" && value.runId;
    if (running && !this.engine.canSteer(value.session.harness as RemoteProvider))
      throw new Error(
        `${HARNESS_TITLE[value.session.harness]} can't take a message mid-turn. Send it once this turn finishes.`,
      );
    this.engine.command(
      running
        ? { type: "steer", commandId, sessionId, runId: value.runId, text, ...(attachments.length ? { attachments } : {}) }
        : { type: "send", commandId, sessionId, text, ...(attachments.length ? { attachments } : {}) },
    );
    this.phoneTurns.add(sessionId);
    return { sessionId };
  }

  private cancel(params: Params, commandId: string) {
    const sessionId = this.sessionId(params);
    const value = this.engine.store.session(sessionId);
    if (value.status === "running" && value.runId)
      this.engine.command({ type: "cancel", commandId, sessionId, runId: value.runId });
    return { sessionId };
  }

  private configure(params: Params, commandId: string) {
    const sessionId = this.sessionId(params);
    const value = this.engine.store.session(sessionId);
    const session = value.session;
    if (typeof params.harness === "string" && params.harness !== session.harness)
      throw new Error("Start a new session to use another provider on this machine");
    const choice = this.choice(
      { ...params, harness: session.harness, model: params.model ?? session.model },
      {
        harness: session.harness as RemoteProvider,
        model: session.model,
        modelSettings: session.modelSettings,
        runtimeMode: session.runtimeMode,
      },
    );
    this.engine.command({
      type: "configure",
      commandId,
      sessionId,
      model: choice.model,
      modelSettings: choice.modelSettings,
      runtimeMode: choice.runtimeMode,
    });
    return { sessionId };
  }

  private approve(params: Params, commandId: string) {
    const sessionId = this.sessionId(params);
    const value = this.engine.store.session(sessionId);
    const approval = pendingApproval(value.session);
    if (!approval || approval.requestId !== params.requestId || !value.runId)
      throw new Error("This request was already answered");
    if (params.decision !== "allow" && params.decision !== "deny")
      throw new Error("Choose Allow or Deny");
    this.engine.command({
      type: "approve",
      commandId,
      sessionId,
      runId: value.runId,
      requestId: approval.requestId,
      decision: params.decision,
    });
    return { sessionId };
  }

  private answer(params: Params, commandId: string) {
    const sessionId = this.sessionId(params);
    const value = this.engine.store.session(sessionId);
    const question = value.session.pendingQuestion;
    if (!question || question.requestId !== params.requestId || !value.runId)
      throw new Error("This question was already answered");
    const reply = questionReply(params.reply, question);
    if (!reply) throw new Error("Choose an answer or skip the question");
    this.engine.command({
      type: "answer",
      commandId,
      sessionId,
      runId: value.runId,
      requestId: question.requestId,
      reply,
    });
    return { sessionId };
  }

  /** The phone's attachments, written where uploaded ones go. Their IDs come
   *  from the command's, so a retried send writes the same files. */
  private stage(value: unknown, commandId: string): RemoteAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_PHONE_ATTACHMENTS)
      throw new Error(`Attach up to ${MAX_PHONE_ATTACHMENTS} files`);
    mkdirSync(this.engine.store.attachmentDir, { recursive: true, mode: 0o700 });
    return value.map((item: unknown, index) => {
      const { name, mimeType, data } = (item ?? {}) as Record<string, unknown>;
      if (typeof name !== "string" || !name.trim() || name.length > 255)
        throw new Error("An attachment is missing its name");
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        throw new Error(`${name} could not be read`);
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > MAX_REMOTE_ATTACHMENT_BYTES) throw new Error(`${name} is larger than 20 MB`);
      const type = typeof mimeType === "string" && mimeType.trim() ? mimeType.slice(0, 128) : "application/octet-stream";
      const id = uuidFrom(`${commandId}:${index}`);
      const path = attachmentPath(this.engine.store, id);
      if (!existsSync(path) || statSync(path).size !== bytes.length)
        writeFileSync(path, bytes, { mode: 0o600 });
      return {
        id,
        name,
        mimeType: type,
        kind: type.startsWith("image/") ? "image" : type.startsWith("audio/") ? "audio" : "file",
        size: bytes.length,
      };
    });
  }

  // MARK: files and changes

  /** The project's checkout, or one of its worktrees by the path the phone sent. */
  private async root(params: Params): Promise<string> {
    const project = this.engine.store.project(String(params.projectId ?? ""));
    return typeof params.worktreePath === "string"
      ? this.worktree(project.cwd, params.worktreePath)
      : project.cwd;
  }

  private async worktree(cwd: string, path: string): Promise<string> {
    const tree = (await hostWorktrees(cwd)).worktrees.find(
      (tree) => !tree.missing && tree.path === path,
    );
    if (!tree) throw new Error("That worktree is no longer available");
    return resolveHostWorktreeAsync(cwd, tree.path);
  }

  private async files(params: Params) {
    const root = await this.root(params);
    const entries = await listHostFiles(root, String(params.path ?? "") || ".");
    return {
      entries: entries.map((entry) => ({ name: entry.name, isDir: entry.isDir, ignored: entry.ignored })),
    };
  }

  /** A text file by its path, or as a transcript names it: shortened to its
   *  name (`Composer.tsx`) or with a line (`app.ts:12`), as desktop links find it. */
  private async file(params: Params) {
    const root = await this.root(params);
    let path = String(params.path ?? "");
    let text: string;
    try {
      text = await readHostFile(root, path);
    } catch (error) {
      const bare = path.replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, "");
      const read = (candidate: string) =>
        readHostFile(root, candidate).then(
          (contents) => ({ contents, candidate }),
          () => undefined,
        );
      let found = bare && bare !== path ? await read(bare) : undefined;
      if (!found && bare) {
        const match = (await searchHostFiles(root, bare.split("/").pop()!).catch(() => [])).find(
          (entry) => entry.path === bare || entry.path.endsWith(`/${bare}`),
        );
        if (match && match.path !== path) found = await read(match.path);
      }
      if (!found) throw error;
      text = found.contents;
      path = found.candidate;
    }
    const highlighted = await highlightForMobile(path, text);
    const highlightJob = highlighted ? undefined : highlightInBackground(path, text);
    return {
      path,
      text,
      truncated: false,
      ...(highlighted ? { highlighted } : {}),
      ...(highlightJob ? { highlightJob } : {}),
    };
  }

  private async search(params: Params) {
    const root = await this.root(params);
    const query = String(params.query ?? "");
    if (!query.trim()) return { results: [] };
    const found = await searchHostFiles(root, query);
    return {
      results: found
        .filter((entry) => !entry.isDir)
        .slice(0, 50)
        .map((entry) => ({ path: entry.path, name: entry.name })),
    };
  }

  private async changes(params: Params) {
    const root = await this.root(params);
    const index = await hostGitIndex(root);
    let budget = 1_000_000;
    const files = [];
    for (const file of index.files) {
      let lines: (ReturnType<typeof buildUnifiedFile>["lines"][number] & { runs?: [string, number][] })[] = [];
      let palette: string[] | undefined;
      if (budget > 0 && files.length < 30) {
        const diff = await hostFileDiff(root, file.relative, !file.unstaged).catch(() => null);
        if (diff && !diff.binary && !diff.tooLarge && diff.original.length + diff.current.length <= budget) {
          budget -= diff.original.length + diff.current.length;
          lines = buildUnifiedFile(diff.original, diff.current).lines;
          const highlighted = await highlightDiffForMobile(file.relative, diff.original, diff.current, lines);
          if (highlighted) ({ lines, palette } = highlighted);
        }
      }
      files.push({
        relative: file.relative,
        status: ["added", "deleted", "untracked"].includes(file.status) ? file.status : "modified",
        additions: file.additions,
        deletions: file.deletions,
        staged: file.staged,
        unstaged: file.unstaged,
        lines,
        ...(palette ? { palette } : {}),
      });
    }
    return {
      branch: index.branch ?? "",
      files,
      ...(typeof params.worktreePath === "string" ? { worktreePath: params.worktreePath } : {}),
    };
  }

  private async git(params: Params) {
    const index = await hostGitIndex(await this.root(params));
    return {
      branch: index.branch ?? "",
      files: index.files.length,
      remote: Boolean(index.remote),
      upstream: Boolean(index.upstream),
      defaultBranch: index.defaultBranch ?? "",
      ahead: index.ahead,
      behind: index.behind,
      aheadOfDefault: index.aheadOfDefault,
      canGenerate: false,
      pr: null,
    };
  }

  /** The Changes page's actions, as the host's own Git commands run them. */
  private async gitAction(params: Params): Promise<{ message?: string; url?: string }> {
    const project = this.engine.store.project(String(params.projectId ?? ""));
    const root = await this.root(params);
    const paths = Array.isArray(params.paths)
      ? params.paths.filter((path): path is string => typeof path === "string")
      : [];
    const run = (action: string, path?: string, message?: string) =>
      this.engine.withIdleProject(project.id, () => hostGitAction(root, action, path, message));
    switch (params.action) {
      case "stage":
      case "unstage":
        for (const path of paths) await hostGitAction(root, params.action, path);
        return {};
      case "stageAll":
      case "unstageAll":
        await hostGitAction(root, params.action);
        return {};
      case "commit": {
        await run("commit", undefined, typeof params.message === "string" ? params.message : "");
        if (params.push !== true && params.createPr !== true) return {};
        await hostGitAction(root, "push");
        if (params.createPr !== true) return {};
        return { url: String((await hostGitAction(root, "createPr")) ?? "") };
      }
      case "sync":
        await hostGitAction(root, "push");
        return {};
      case "pr": {
        if ((await hostGitIndex(root)).ahead > 0) await hostGitAction(root, "push");
        return { url: String((await hostGitAction(root, "createPr")) ?? "") };
      }
      case "generate":
        throw new Error("Write the commit message here; this machine can't generate one yet");
      default:
        throw new Error("This machine can't do that Git action from the phone");
    }
  }

  private async worktrees(params: Params) {
    const project = this.engine.store.project(String(params.projectId ?? ""));
    const { worktrees } = await hostWorktrees(project.cwd);
    return {
      worktrees: worktrees
        .filter((tree) => !tree.isMain && !tree.missing)
        .map((tree) => ({ path: tree.path, name: tree.branch ?? basename(tree.path) })),
    };
  }

  // MARK: notifications

  /**
   * Tells paired phones of a session that finished or stopped for them, as
   * the desktop does: only for a turn a phone started, which its finish ends.
   */
  private notifyChange(id: string) {
    let value: HostSession;
    try {
      value = this.engine.store.session(id);
    } catch {
      this.seen.delete(id);
      this.phoneTurns.delete(id);
      return;
    }
    const before = this.seen.get(id);
    const now = stance(value);
    this.seen.set(id, now);
    if (!before || !this.phoneTurns.has(id)) return;
    if (now.input && now.input !== before.input) {
      this.push("agentInput", value, now.input === "approval" ? "Needs your approval" : "Has a question for you");
    } else if (before.running && !now.running) {
      this.phoneTurns.delete(id);
      if (!now.input) this.push("agentFinished", value, lastReply(value.session) || "Finished");
    }
  }

  private push(category: string, value: HostSession, body: string) {
    const targets = this.engine.store
      .phonePushTargets()
      .filter((target) => !target.disabled.includes(category));
    if (!targets.length) return;
    const project = (() => {
      try {
        return this.engine.store.project(value.projectId);
      } catch {
        return undefined;
      }
    })();
    const messages = targets.map((target) => ({
      to: target.token,
      title: sessionDisplayTitle(value.session.title, value.session.harness),
      ...(project ? { subtitle: project.name } : {}),
      body,
      data: { projectId: value.projectId, sessionId: value.session.id },
      sound: "default",
      priority: "high",
      channelId: "sessions",
    }));
    void (async () => {
      try {
        const response = await fetch(this.pushEndpoint, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(15_000),
        });
        const tickets = ((await response.json().catch(() => ({}))) as { data?: { details?: { error?: string } }[] }).data;
        tickets?.forEach((ticket, index) => {
          if (ticket?.details?.error === "DeviceNotRegistered")
            this.engine.store.forgetPushToken(messages[index].to);
        });
      } catch (error) {
        console.error("Could not notify paired phones:", error instanceof Error ? error.message : error);
      }
    })();
  }
}

// MARK: helpers

export type PhoneInvite = {
  code: string;
  /** Unix seconds, as the desktop's own codes. */
  expires: number;
  /** Where the phone will reach this host, and the link holding it; null
   *  until Tailscale Serve is on or an address is given. */
  url: string | null;
  link: string | null;
  name: string;
  reach: PhoneReach;
};

/** A one-use pairing code, and the `monocode://pair` link a phone scans:
 *  the same scheme a desktop's code uses, holding where this host is. */
export function createPhoneInvite(
  store: HostEngine["store"],
  reach: PhoneReach,
  url?: string,
): PhoneInvite {
  const code = randomBytes(24).toString("base64url");
  const expires = Date.now() + INVITE_MS;
  store.addPhoneInvite(digest(code), expires, MAX_INVITES);
  const chosen = url ?? (reach.state === "ready" ? reach.url : null);
  const name = hostname();
  const payload = {
    version: 1,
    kind: "host",
    name,
    environmentId: store.environmentId,
    url: chosen,
    code,
    expires: Math.floor(expires / 1000),
  };
  return {
    code,
    expires: payload.expires,
    url: chosen,
    link: chosen
      ? `monocode://pair?i=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`
      : null,
    name,
    reach,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The host's command IDs, from the phone's request ID. */
function commandId(id: string): string {
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id)) throw new Error("Invalid request ID");
  return `phone:${id}`;
}

function messageText(params: Params): string {
  const text = typeof params.text === "string" ? params.text.trim() : "";
  const files = Array.isArray(params.attachments) && params.attachments.length > 0;
  if ((!text && !files) || text.length > 100_000)
    throw new Error("Enter a message under 100,000 characters");
  return text;
}

/** A stable attachment ID in the UUID form the host's store accepts. */
function uuidFrom(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = "89ab"[parseInt(hex[16], 16) % 4];
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function colorIndex(path: string, fallback: number): number {
  let hash = 0;
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash || fallback) % PROJECT_COLORS.length;
}

/** A URL a phone may be sent to: HTTPS anywhere, HTTP only inside a tailnet. */
export function phoneUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter the machine's address, like https://name.tailnet.ts.net");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Enter only the machine's address");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && tailnetHost(url.hostname)))
    throw new Error("Use an https address, or a Tailscale one for http");
  return url.origin;
}

export function tailnetHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name.endsWith(".ts.net") || name === "localhost" || name === "127.0.0.1" || name === "::1") return true;
  const octets = name.split(".").map(Number);
  // Tailscale's 100.64.0.0/10 and its IPv6 range.
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255))
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  return name.startsWith("fd7a:115c:a1e0:");
}

async function readBody(request: IncomingMessage): Promise<Params> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PHONE_BODY) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value as Params;
}

/** The approval an agent waits on, as the phone's card shows it. */
export function pendingApproval(session: Session): PhoneApproval | undefined {
  const block = [...session.blocks].reverse().find(
    (entry: Block) => entry.approval && !entry.approval.decided,
  );
  if (!block?.approval) return undefined;
  const title = block.tool?.title?.trim() || block.text?.trim() || "Approval required";
  const detail = (block.tool?.preview?.title ?? block.tool?.detail ?? "").trim();
  return {
    requestId: block.approval.requestId,
    title: title.slice(0, 500),
    ...(detail && detail !== title ? { detail: detail.slice(0, 4_000) } : {}),
    ...(block.tool?.kind ? { kind: block.tool.kind } : {}),
  };
}

function phoneQuestion(question: Session["pendingQuestion"]) {
  return question
    ? {
        requestId: question.requestId,
        title: question.title,
        questions: question.questions,
        autoResolveAt: question.autoResolveAt,
      }
    : null;
}

/** The phone's answers, keeping only the questions and options asked, rebuilt
 *  as the desktop's card builds them. Undefined when nothing is answered. */
export function questionReply(value: unknown, prompt: UserQuestionPrompt): UserQuestionReply | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const reply = value as Record<string, unknown>;
  if (reply.kind === "skipped") return { kind: "skipped" };
  if (reply.kind !== "answered") return;
  const record = (field: unknown) =>
    field && typeof field === "object" && !Array.isArray(field) ? (field as Record<string, unknown>) : {};
  const answers: Record<string, string[]> = {};
  const custom: Record<string, string> = {};
  for (const question of prompt.questions) {
    const selected = record(reply.answers)[question.id];
    if (Array.isArray(selected))
      answers[question.id] = selected.filter(
        (id): id is string =>
          (id === CUSTOM_OPTION_ID && question.allowCustom) ||
          question.options.some((option) => option.id === id),
      );
    const text = record(reply.custom)[question.id];
    if (typeof text === "string" && text.length <= 10_000) custom[question.id] = text;
  }
  const rebuilt = buildQuestionReply(prompt.questions, answers, custom);
  return rebuilt.kind === "answered" ? rebuilt : undefined;
}

function stance(value: HostSession): { running: boolean; input?: string } {
  const approval = pendingApproval(value.session);
  return {
    running: value.status === "running",
    ...(approval ? { input: "approval" } : value.session.pendingQuestion ? { input: "question" } : {}),
  };
}

/** The turn's last reply, one line, short enough for a notification. */
function lastReply(session: Session): string {
  const block = [...session.blocks]
    .reverse()
    .find((entry) => entry.role === "assistant" && !entry.internal && entry.text?.trim());
  const text = (block?.text ?? "").replace(/\s+/g, " ").trim();
  return text.length > PUSH_BODY_CHARS ? `${text.slice(0, PUSH_BODY_CHARS - 1)}…` : text;
}
