import { isHarnessAvailable } from "../../../integrations/harness/core/availability";
import { looksLikeProject } from "../../projects/model/recents";
import {
  mergeModelSettings,
  modelsFor,
  preferredModelId,
  requestedModelSettings,
  resolveModel,
} from "../../sessions/model/models";
import {
  HARNESSES,
  RUNTIME_MODE_HINT,
  RUNTIME_MODE_LABEL,
  RUNTIME_MODES,
  type HarnessId,
  type Session,
} from "../../sessions/model/session";
import {
  loadSessionFolders,
  placeSessionInFolder,
  saveSessionFolders,
} from "../../sessions/model/sessionFolders";
import {
  normalizeNoteTags,
  noteTitle,
  type Note,
  type NoteUpsert,
} from "../../notes";
import type { QuickLaunch } from "../../quick-composer/model/quickComposer";
import type { Worktree, Worktrees } from "../../source-control/model/worktrees";
import { pathKey } from "../../../shared/lib/paths";
import type { SplitDir } from "../../workspace/model/layout";
import { consumeOperatorCommand } from "../../sessions/model/operatorCommand";
import { pendingInputForSession } from "../../notifications/model/approvalToast";
import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import { questionAnswers } from "../../orchestration/model/orchestration";
import { sessionConversationPage, sessionTurn } from "./sessionConversation";
import type { OperatorWatch } from "./operatorWatches";
import {
  APP_SESSION_STATES,
  SETTLED_STATES,
  appSessionState,
  latestTurnId,
  turnForRequest,
  turnState,
  type AppSessionState,
} from "./sessionState";

export type AppSessionListing = {
  id: string;
  title: string;
  harness: HarnessId;
  model: string;
  busy: boolean;
  state: AppSessionState;
  hasDraft: boolean;
};

export type AppSessionPlacement = {
  direction: SplitDir;
  besideSessionId: string;
};

export type AgentAppHost = {
  start(
    launch: QuickLaunch,
    id: string,
    placement?: AppSessionPlacement,
  ): Promise<void>;
  sessions(cwd: string): Promise<AppSessionListing[]>;
  session(id: string): Promise<Session | null>;
  send(
    id: string,
    prompt: string,
    requestId: string,
  ): Promise<{ alreadySubmitted: boolean; turnId?: string }>;
  /** Guide a running turn without discarding its work. */
  steer(id: string, prompt: string): Promise<void>;
  respond(id: string, requestId: number, decision: ApprovalDecision): void;
  answer(id: string, requestId: number, reply: UserQuestionReply): void;
  /** Advances whenever any session changes. */
  revision(): number;
  /** Resolves once the revision passes `since`, or after the timeout. */
  changed(since: number, timeoutMs: number): Promise<void>;
  /** Wake the operator when this turn settles. */
  watch(watch: OperatorWatch): void;
  /** The operator saw this session's state, so it needs no wake for it. */
  seen(operatorId: string, sessionId: string): void;
  draft(
    id: string,
    prompt: string,
    requestId: string,
  ): Promise<{ alreadySaved: boolean; draft: boolean }>;
  worktrees(cwd: string): Promise<Worktrees>;
  createWorktree(
    cwd: string,
    branch: string,
    base: string,
    existing: boolean,
  ): Promise<Worktree>;
  notes(): Promise<Note[]>;
  note(id: string): Promise<Note | null>;
  saveNote(note: NoteUpsert): Promise<Note>;
};

const FIELDS = new Map<string, readonly string[]>([
  ["models.list", []],
  ["sessions.list", []],
  ["sessions.read", ["sessionId", "turnId", "before", "limit", "maxChars"]],
  ["sessions.send", ["sessionId", "prompt", "wait", "notify"]],
  [
    "sessions.wait",
    ["sessionId", "sessionIds", "turnId", "until", "timeoutSeconds"],
  ],
  ["sessions.steer", ["sessionId", "prompt"]],
  ["sessions.respond", ["sessionId", "requestId", "decision"]],
  ["sessions.answer", ["sessionId", "requestId", "answers", "skip"]],
  ["sessions.draft", ["sessionId", "prompt"]],
  [
    "sessions.start",
    [
      "prompt",
      "name",
      "notify",
      "draft",
      "harness",
      "model",
      "modelSettings",
      "effort",
      "runtimeMode",
      "reveal",
      "workspaceMode",
      "worktreeBase",
      "worktreeCwd",
      "placement",
      "besideSessionId",
    ],
  ],
  ["worktrees.list", []],
  ["worktrees.create", ["branch", "base", "existing"]],
  ["folders.list", []],
  ["folders.move", ["sessionId", "folderId", "newFolderName"]],
  ["notes.list", ["limit", "offset"]],
  ["notes.read", ["id"]],
  ["notes.write", ["id", "title", "body", "tags"]],
]);

function fields(action: string, input: Record<string, unknown>) {
  const allowed = FIELDS.get(action);
  if (!allowed) throw new Error(`Unknown app action: ${action}`);
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new Error(`Unknown ${action} fields: ${unknown.join(", ")}`);
}

function requiredString(value: unknown, name: string, max = 30_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `${name} must be a non-empty string under ${max} characters`,
    );
  return value.trim();
}

function agentPrompt(value: unknown): string {
  const prompt = requiredString(value, "prompt", 240_000);
  if (consumeOperatorCommand(prompt).matched)
    throw new Error("App calls cannot enable /operator in another session");
  return prompt;
}

function optionalString(
  value: unknown,
  name: string,
  max = 512,
): string | undefined {
  return value === undefined ? undefined : requiredString(value, name, max);
}

function noteBody(value: unknown): string {
  if (typeof value !== "string" || value.length > 240_000)
    throw new Error("body must be a string under 240000 characters");
  return value.replace(/\r\n?/g, "\n");
}

function noteTags(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((tag) => typeof tag !== "string" || tag.length > 48)
  )
    throw new Error(
      "tags must be an array of at most 20 strings under 48 characters each",
    );
  return normalizeNoteTags(value as string[]);
}

function requireProject(source: Session): string {
  if (!looksLikeProject(source.cwd))
    throw new Error("Choose a project folder in this session first");
  return source.cwd;
}

async function projectSession(
  source: Session,
  id: string,
  host: AgentAppHost,
): Promise<Session> {
  const cwd = requireProject(source);
  if (!(await host.sessions(cwd)).some((session) => session.id === id))
    throw new Error("Session was not found in this project");
  const target = await host.session(id);
  if (!target) throw new Error("Session was not found in this project");
  return target;
}

/** A name an operator gives a session it starts; IDs are longer than this. */
const SESSION_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

const namedSessionId = (source: Session, name: string) =>
  `app-${source.id}-${name}`;

/** The name this operator gave a session, when it started it with one. */
function sessionName(source: Session, id: string): string | undefined {
  const prefix = `app-${source.id}-`;
  if (!id.startsWith(prefix)) return undefined;
  const suffix = id.slice(prefix.length);
  return SESSION_NAME.test(suffix) ? suffix : undefined;
}

/** Sessions this operator started; only these take decisions from it. */
const startedBy = (source: Session, id: string) =>
  id.startsWith(`app-${source.id}-`);

/**
 * A name this operator gave one of its sessions, as that session's ID. Any
 * other value is returned unchanged, so short IDs keep working.
 */
async function resolveSessionRef(
  source: Session,
  ref: string,
  host: AgentAppHost,
): Promise<string> {
  if (ref === source.id || !SESSION_NAME.test(ref)) return ref;
  const named = namedSessionId(source, ref);
  const listed = await host.sessions(requireProject(source));
  return listed.some((session) => session.id === named) ? named : ref;
}

/** Resolve a session ID, or a name this operator gave one of its sessions. */
async function targetSession(
  source: Session,
  value: unknown,
  host: AgentAppHost,
  field = "sessionId",
): Promise<Session> {
  const ref = requiredString(value, field, 256);
  if (ref === source.id) return source;
  return projectSession(
    source,
    await resolveSessionRef(source, ref, host),
    host,
  );
}

function label(source: Session, session: Session) {
  return sessionName(source, session.id) ?? session.id;
}

/** The fields every driving command reports about a session. */
function describe(source: Session, session: Session, turnId?: string) {
  const state = turnId ? turnState(session, turnId) : appSessionState(session);
  const name = sessionName(source, session.id);
  const needsInput =
    state === "blocked" ? pendingInputForSession(session) : undefined;
  return {
    sessionId: session.id,
    ...(name ? { name } : {}),
    state,
    ...(needsInput ? { needsInput } : {}),
    ...(state === "usageLimited" && session.usageLimit?.resetsAt != null
      ? {
          usageLimitResetsAt: new Date(
            session.usageLimit.resetsAt,
          ).toISOString(),
        }
      : {}),
    latestTurnId: latestTurnId(session) ?? null,
  };
}

/** The CLI and app relay give up after 35 seconds; leave room for the reply. */
const MAX_WAIT_SECONDS = 25;
const MAX_SEND_WAIT_SECONDS = 20;

function waitSeconds(value: unknown, max: number): number {
  const seconds = value ?? Math.min(20, max);
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > max
  )
    throw new Error(`timeoutSeconds must be 0 to ${max}`);
  return seconds;
}

function untilStates(value: unknown): readonly AppSessionState[] {
  if (value === undefined) return SETTLED_STATES;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (state) => !APP_SESSION_STATES.includes(state as AppSessionState),
    )
  )
    throw new Error(
      `until must be a non-empty array of: ${APP_SESSION_STATES.join(", ")}`,
    );
  return value as AppSessionState[];
}

/** Re-check after every session change until `check` answers or time runs out. */
async function waitUntil<T>(
  host: AgentAppHost,
  timeoutMs: number,
  check: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const since = host.revision();
    const hit = await check();
    if (hit !== undefined) return hit;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await host.changed(since, remaining);
  }
}

function blockedMessage(source: Session, target: Session): string {
  const pending = pendingInputForSession(target);
  const what = pending
    ? `${pending.kind === "question" ? "a question" : "an approval"} "${pending.label}" (requestId ${pending.requestId})`
    : "a decision";
  return `${label(source, target)} is blocked on ${what}. ${
    startedBy(source, target.id)
      ? "Decide it with sessions.respond or sessions.answer"
      : "Ask the user to answer it in MonoCode"
  }, then send.`;
}

/** Two short body paragraphs, with a hard cap independent of Markdown length. */
export function notePreview(body: string): string {
  return body
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n\n")
    .slice(0, 400);
}

function startLaunch(
  source: Session,
  input: Record<string, unknown>,
): QuickLaunch {
  const cwd = requireProject(source);
  const prompt = agentPrompt(input.prompt);
  const draft = input.draft ?? false;
  if (typeof draft !== "boolean") throw new Error("draft must be a boolean");
  const harness = input.harness ?? source.harness;
  if (!HARNESSES.includes(harness as HarnessId))
    throw new Error("Unknown harness; run models.list for available providers");
  const chosenHarness = harness as HarnessId;
  if (!isHarnessAvailable(chosenHarness))
    throw new Error(`${chosenHarness} is not available in MonoCode`);
  const requestedModel = optionalString(input.model, "model");
  const model = requestedModel
    ? modelsFor(chosenHarness).find((entry) => entry.id === requestedModel)
    : resolveModel(
        chosenHarness,
        chosenHarness === source.harness
          ? source.model
          : preferredModelId(chosenHarness),
      );
  if (!model || model.harness !== chosenHarness)
    throw new Error("Unknown model; run models.list for exact model IDs");
  const requestedSettings = requestedModelSettings(
    model,
    input.modelSettings,
    input.effort,
    "models.list",
  );
  const runtimeMode = input.runtimeMode ?? source.runtimeMode;
  if (!RUNTIME_MODES.includes(runtimeMode as Session["runtimeMode"]))
    throw new Error(`runtimeMode must be one of: ${RUNTIME_MODES.join(", ")}`);
  const reveal = input.reveal ?? false;
  if (typeof reveal !== "boolean") throw new Error("reveal must be a boolean");
  const workspaceMode = input.workspaceMode ?? "current";
  if (workspaceMode !== "current" && workspaceMode !== "worktree")
    throw new Error("workspaceMode must be current or worktree");
  const worktreeBase = optionalString(input.worktreeBase, "worktreeBase");
  if (worktreeBase && workspaceMode !== "worktree")
    throw new Error("worktreeBase requires workspaceMode worktree");
  const worktreeCwd = optionalString(input.worktreeCwd, "worktreeCwd");
  if (worktreeCwd && workspaceMode !== "current")
    throw new Error("worktreeCwd requires workspaceMode current");
  return {
    cwd,
    prompt,
    ...(draft ? { draft: true } : {}),
    harness: chosenHarness,
    model: model.id,
    modelSettings: mergeModelSettings(model, {
      ...(chosenHarness === source.harness && model.id === source.model
        ? source.modelSettings
        : {}),
      ...requestedSettings,
    }),
    runtimeMode: runtimeMode as Session["runtimeMode"],
    reveal,
    workspaceMode,
    ...(workspaceMode === "current" && (worktreeCwd || source.worktreeCwd)
      ? { worktreeCwd: worktreeCwd || source.worktreeCwd }
      : {}),
    ...(worktreeBase ? { worktreeBase } : {}),
  };
}

export async function handleAgentApp(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  fields(action, input);
  switch (action) {
    case "models.list":
      return {
        runtimeModes: RUNTIME_MODES.map((id) => ({
          id,
          label: RUNTIME_MODE_LABEL[id],
          description: RUNTIME_MODE_HINT[id],
        })),
        harnesses: HARNESSES.map((harness) => ({
          id: harness,
          available: isHarnessAvailable(harness),
          models: modelsFor(harness).map((model) => ({
            id: model.id,
            name: model.name,
            settings: model.settings ?? [],
          })),
        })),
      };
    case "sessions.list":
      return {
        cwd: requireProject(source),
        sessions: (await host.sessions(source.cwd)).map((listing) => {
          const name = sessionName(source, listing.id);
          return name ? { ...listing, name } : listing;
        }),
      };
    case "sessions.read": {
      const target = await targetSession(source, input.sessionId, host);
      if (input.turnId !== undefined) {
        if (input.before !== undefined || input.limit !== undefined)
          throw new Error("turnId reads one turn; omit before and limit");
        const turnId = requiredString(input.turnId, "turnId", 256);
        return {
          title: target.title,
          ...describe(source, target),
          turn: sessionTurn(
            target,
            turnId,
            input.maxChars as number | undefined,
          ),
        };
      }
      return {
        ...sessionConversationPage(target, {
          before: optionalString(input.before, "before", 256),
          limit: input.limit as number | undefined,
          maxChars: input.maxChars as number | undefined,
        }),
        ...describe(source, target),
      };
    }
    case "sessions.send": {
      const target = await targetSession(source, input.sessionId, host);
      const prompt = agentPrompt(input.prompt);
      if (target.id === source.id)
        throw new Error(
          "Use the current conversation to continue this session",
        );
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      const notify = input.notify ?? false;
      if (typeof notify !== "boolean")
        throw new Error("notify must be a boolean");
      const wait =
        input.wait === undefined || input.wait === false
          ? undefined
          : input.wait === true
            ? {}
            : input.wait;
      if (
        wait !== undefined &&
        (typeof wait !== "object" || Array.isArray(wait))
      )
        throw new Error(
          "wait must be true or an object with timeoutSeconds and until",
        );
      const waitOptions = wait as Record<string, unknown> | undefined;
      const unknownWait = Object.keys(waitOptions ?? {}).filter(
        (key) => key !== "timeoutSeconds" && key !== "until",
      );
      if (unknownWait.length)
        throw new Error(
          `Unknown sessions.send wait fields: ${unknownWait.join(", ")}`,
        );
      const timeoutMs = waitOptions
        ? waitSeconds(waitOptions.timeoutSeconds, MAX_SEND_WAIT_SECONDS) * 1000
        : 0;
      const until = waitOptions ? untilStates(waitOptions.until) : [];
      const appRequestId = `app-${source.id}-${requestId}`;
      // A retry of a turn that already started is not a send to a busy session.
      if (!turnForRequest(target, appRequestId)) {
        const state = appSessionState(target);
        if (state === "blocked")
          throw new Error(blockedMessage(source, target));
        if (state === "working")
          throw new Error(
            target.busy
              ? `${label(source, target)} is still working. Wait for it with sessions.wait, or redirect the running turn with sessions.steer.`
              : `${label(source, target)} has queued follow-ups to run first. Wait for them with sessions.wait.`,
          );
      }
      const result = await host.send(target.id, prompt, appRequestId);
      if (notify)
        host.watch({
          operatorId: source.id,
          sessionId: target.id,
          appRequestId,
          label: label(source, target),
        });
      // A submission that waited on project sync lands its turn shortly after.
      const turnId =
        result.turnId ??
        (await waitUntil(host, waitOptions ? 0 : 2000, async () => {
          const live = await host.session(target.id);
          return (live && turnForRequest(live, appRequestId)?.id) || undefined;
        }));
      const sent = {
        sessionId: target.id,
        submitted: true,
        alreadySubmitted: result.alreadySubmitted,
        turnId: turnId ?? null,
      };
      if (!waitOptions)
        return turnId
          ? sent
          : {
              ...sent,
              note: "The turn has not started yet. Find it with sessions.wait on this session.",
            };
      const settled = await waitUntil(host, timeoutMs, async () => {
        const live = await host.session(target.id);
        if (!live) return { live: null, turnId: null };
        const turn = turnForRequest(live, appRequestId);
        return turn && until.includes(turnState(live, turn.id))
          ? { live, turnId: turn.id }
          : undefined;
      });
      const live = settled ? settled.live : await host.session(target.id);
      const waitedTurnId =
        settled?.turnId ?? (live && turnForRequest(live, appRequestId)?.id);
      if (!live) return { ...sent, matched: true, state: "closed" };
      host.seen(source.id, live.id);
      if (!waitedTurnId)
        return {
          ...sent,
          matched: false,
          state: "pending",
          note: "The turn has not started yet. Check it again with sessions.wait.",
        };
      const current = describe(source, live, waitedTurnId);
      return {
        ...sent,
        turnId: waitedTurnId,
        matched: !!settled,
        ...current,
        ...(current.state === "idle"
          ? { turn: sessionTurn(live, waitedTurnId) }
          : {}),
      };
    }
    case "sessions.wait": {
      const single = input.sessionId !== undefined;
      if (single === (input.sessionIds !== undefined))
        throw new Error("Supply exactly one of sessionId or sessionIds");
      const refs = single ? [input.sessionId] : input.sessionIds;
      if (
        !Array.isArray(refs) ||
        !refs.length ||
        refs.length > 8 ||
        new Set(refs).size !== refs.length
      )
        throw new Error("sessionIds must hold 1 to 8 distinct sessions");
      const turnId =
        input.turnId === undefined
          ? undefined
          : requiredString(input.turnId, "turnId", 256);
      if (turnId && !single)
        throw new Error("turnId waits on one session; use sessionId");
      const until = untilStates(input.until);
      const timeoutMs =
        waitSeconds(input.timeoutSeconds, MAX_WAIT_SECONDS) * 1000;
      const targets = await Promise.all(
        refs.map((ref) => targetSession(source, ref, host, "sessionIds")),
      );
      if (targets.some((target) => target.id === source.id))
        throw new Error("A session cannot wait on itself");
      // Validate the turn before waiting on it.
      if (turnId) turnState(targets[0], turnId);
      const snapshot = () =>
        Promise.all(targets.map((target) => host.session(target.id)));
      const ready = await waitUntil(host, timeoutMs, async () => {
        const live = await snapshot();
        return live.some(
          (session) =>
            !session ||
            until.includes(
              turnId ? turnState(session, turnId) : appSessionState(session),
            ),
        )
          ? live
          : undefined;
      });
      const live = ready ?? (await snapshot());
      for (const session of live) if (session) host.seen(source.id, session.id);
      const sessions = live.map((session, index) =>
        session
          ? describe(source, session, turnId)
          : { sessionId: targets[index].id, state: "closed" as const },
      );
      const first = live[0];
      return {
        matched: !!ready,
        sessions,
        ...(turnId && first && sessions[0].state === "idle"
          ? { turn: sessionTurn(first, turnId) }
          : {}),
      };
    }
    case "sessions.steer": {
      const target = await targetSession(source, input.sessionId, host);
      const prompt = agentPrompt(input.prompt);
      if (target.id === source.id)
        throw new Error("A session cannot steer itself");
      if (!target.busy)
        throw new Error(
          `${label(source, target)} is not running a turn; use sessions.send.`,
        );
      if (appSessionState(target) === "blocked")
        throw new Error(blockedMessage(source, target));
      await host.steer(target.id, prompt);
      return { sessionId: target.id, steered: true };
    }
    case "sessions.respond":
    case "sessions.answer": {
      const target = await targetSession(source, input.sessionId, host);
      if (!startedBy(source, target.id))
        throw new Error(
          "Only sessions you started can take your decisions; ask the user to answer this one in MonoCode",
        );
      const kind = action === "sessions.respond" ? "approval" : "question";
      const pending = pendingInputForSession(target);
      if (pending?.kind !== kind)
        throw new Error(
          `${label(source, target)} is not waiting on ${kind === "approval" ? "an approval" : "a question"}. Check needsInput from sessions.wait or sessions.list first.`,
        );
      if (input.requestId !== pending.requestId)
        throw new Error(
          `Stale requestId. ${label(source, target)} is waiting on ${pending.requestId}.`,
        );
      if (kind === "approval") {
        const decision = input.decision;
        if (decision !== "allow" && decision !== "deny")
          throw new Error('decision must be "allow" or "deny"');
        host.respond(target.id, pending.requestId, decision);
        return { sessionId: target.id, decision };
      }
      const reply: UserQuestionReply =
        input.skip === true
          ? { kind: "skipped" }
          : {
              kind: "answered",
              answers: questionAnswers(input.answers, pending.questions),
            };
      host.answer(target.id, pending.requestId, reply);
      return { sessionId: target.id, answered: reply.kind === "answered" };
    }
    case "sessions.draft": {
      const id = requiredString(input.sessionId, "sessionId", 256);
      const prompt = agentPrompt(input.prompt);
      if (id === source.id)
        throw new Error("Use the composer to save a draft in this session");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      await projectSession(source, id, host);
      const result = await host.draft(
        id,
        prompt,
        `app-${source.id}-${requestId}`,
      );
      return { sessionId: id, saved: true, ...result };
    }
    case "sessions.start": {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error(
          "request ID must use letters, digits, underscores or hyphens",
        );
      const launch = startLaunch(source, input);
      const name =
        input.name === undefined
          ? undefined
          : requiredString(input.name, "name", 32);
      if (name !== undefined && !SESSION_NAME.test(name))
        throw new Error(
          "name must start with a lowercase letter and use up to 32 lowercase letters, digits, - or _",
        );
      const notify = input.notify ?? false;
      if (typeof notify !== "boolean")
        throw new Error("notify must be a boolean");
      if (notify && launch.draft)
        throw new Error("notify needs a submitted prompt; omit draft:true");
      const id = name
        ? namedSessionId(source, name)
        : `app-${source.id}-${requestId}`;
      if (name && (await host.session(id)))
        throw new Error(
          `You already have a session named "${name}". Send to it with sessions.send, or choose another name.`,
        );
      if (input.worktreeCwd !== undefined) {
        const chosen = (await host.worktrees(launch.cwd)).worktrees.find(
          (tree) =>
            !tree.missing &&
            pathKey(tree.path) === pathKey(launch.worktreeCwd!),
        );
        if (!chosen)
          throw new Error(
            "Worktree is unavailable in this project; run worktrees.list",
          );
        launch.worktreeCwd =
          pathKey(chosen.path) === pathKey(launch.cwd)
            ? undefined
            : chosen.path;
      }
      const placement = input.placement ?? "tab";
      if (placement !== "tab" && placement !== "right" && placement !== "down")
        throw new Error("placement must be tab, right or down");
      if (input.besideSessionId !== undefined && placement === "tab")
        throw new Error("besideSessionId requires placement right or down");
      const beside = optionalString(
        input.besideSessionId,
        "besideSessionId",
        256,
      );
      const besideSessionId =
        placement === "tab"
          ? undefined
          : beside
            ? await resolveSessionRef(source, beside, host)
            : source.id;
      if (besideSessionId)
        await host.start(launch, id, {
          direction: placement as SplitDir,
          besideSessionId,
        });
      else await host.start(launch, id);
      // The launch turn carries the session ID as its request ID.
      if (notify)
        host.watch({
          operatorId: source.id,
          sessionId: id,
          appRequestId: id,
          label: name ?? id,
        });
      return {
        id,
        ...(name ? { name } : {}),
        cwd: launch.cwd,
        harness: launch.harness,
        model: launch.model,
        submitted: !launch.draft,
        draft: !!launch.draft,
      };
    }
    case "worktrees.list":
      return host.worktrees(requireProject(source));
    case "worktrees.create": {
      const cwd = requireProject(source);
      const branch = requiredString(input.branch, "branch", 400);
      const existing = input.existing ?? false;
      if (typeof existing !== "boolean")
        throw new Error("existing must be a boolean");
      const base = optionalString(input.base, "base", 400);
      if (existing && base)
        throw new Error("base cannot be set for an existing branch");
      return host.createWorktree(cwd, branch, base ?? "HEAD", existing);
    }
    case "folders.list": {
      const cwd = requireProject(source);
      return {
        cwd,
        folders: loadSessionFolders(cwd).map(({ id, name, sessionIds }) => ({
          id,
          name,
          sessionIds,
        })),
      };
    }
    case "folders.move": {
      const cwd = requireProject(source);
      const sessionId = requiredString(input.sessionId, "sessionId", 256);
      const folderId = optionalString(input.folderId, "folderId", 256);
      const newFolderName = optionalString(
        input.newFolderName,
        "newFolderName",
        100,
      );
      if (!!folderId === !!newFolderName)
        throw new Error("Supply exactly one of folderId or newFolderName");
      if (
        !(await host.sessions(cwd)).some((session) => session.id === sessionId)
      )
        throw new Error("Session was not found in this project");
      const folders = loadSessionFolders(cwd);
      if (folderId && !folders.some((folder) => folder.id === folderId))
        throw new Error("Folder was not found in this project");
      const next = placeSessionInFolder(
        folders,
        sessionId,
        folderId
          ? { kind: "existing", folderId }
          : { kind: "new", name: newFolderName! },
      );
      saveSessionFolders(cwd, next);
      const folder = next.find((entry) => entry.sessionIds.includes(sessionId));
      return { sessionId, folderId: folder?.id, folderName: folder?.name };
    }
    case "notes.list": {
      const limit = input.limit ?? 30;
      const offset = input.offset ?? 0;
      if (
        !Number.isInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 100
      )
        throw new Error("limit must be an integer from 1 to 100");
      if (!Number.isInteger(offset) || (offset as number) < 0)
        throw new Error("offset must be a non-negative integer");
      const notes = await host.notes();
      return {
        total: notes.length,
        offset,
        notes: notes
          .slice(offset as number, (offset as number) + (limit as number))
          .map((note) => ({
            id: note.id,
            title: note.title,
            preview: notePreview(note.body),
            tags: note.tags,
            sourceCwd: note.sourceCwd,
          })),
      };
    }
    case "notes.read": {
      const id = requiredString(input.id, "id", 256);
      const note = await host.note(id);
      if (!note) throw new Error("Note was not found");
      return note;
    }
    case "notes.write": {
      const id = optionalString(input.id, "id", 256);
      if (id && !/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error("Invalid note ID");
      const title =
        input.title === undefined
          ? undefined
          : requiredString(input.title, "title", 200);
      const body = input.body === undefined ? undefined : noteBody(input.body);
      const tags = input.tags === undefined ? undefined : noteTags(input.tags);
      if (id) {
        if (title === undefined && body === undefined && tags === undefined)
          throw new Error("Supply title, body or tags to update a note");
        const current = await host.note(id);
        if (!current) throw new Error("Note was not found");
        return host.saveNote({
          id,
          title: title ?? current.title,
          body: body ?? current.body,
          tags: tags ?? current.tags,
        });
      }
      if (body === undefined)
        throw new Error("body is required to create a note");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      const createdId = `app-${source.id}-${requestId}`;
      const existing = await host.note(createdId);
      if (existing) {
        if (
          existing.title !== (title ?? noteTitle(body)) ||
          existing.body !== body ||
          JSON.stringify(existing.tags) !== JSON.stringify(tags ?? [])
        )
          throw new Error("Request ID was already used for another note");
        return existing;
      }
      return host.saveNote({
        id: createdId,
        title: title ?? noteTitle(body),
        body,
        tags: tags ?? [],
        sourceSessionId: source.id,
        ...(looksLikeProject(source.cwd) ? { sourceCwd: source.cwd } : {}),
      });
    }
  }
}
