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
import type {
  Artifact,
  ArtifactCard,
  ArtifactKind,
  ArtifactUpsert,
} from "../../artifacts/artifacts";
import type { QuickLaunch } from "../../quick-composer/model/quickComposer";
import type { Worktree, Worktrees } from "../../source-control/model/worktrees";
import { pathKey, projectName } from "../../../shared/lib/paths";
import type { SplitDir } from "../../workspace/model/layout";
import { consumeOperatorCommand } from "../../sessions/model/operatorCommand";
import { pendingInputForSession } from "../../notifications/model/approvalToast";
import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import { questionAnswers } from "../../orchestration/model/orchestration";
import {
  sessionConversationPage,
  sessionTurn,
  type SessionReadOptions,
} from "./sessionConversation";
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
import {
  CARD_FIELDS,
  parseCard,
  type MonoCard,
} from "../../monos/model/monoCards";
import {
  HABITS_MAX,
  checkHabitsNow,
  habitRunningSince,
  habitSchedule,
  habitScheduleLabel,
  newHabit,
  nextHabitRunAt,
  type Habit,
} from "../../monos/model/monoHabits";
import {
  memoryWithinBudget,
  MonoFileConflict,
  type AgentFilePath,
  type MonoFiles,
} from "../../monos/model/monoFiles";
import {
  addMemoryEntry,
  archiveMemoryEntries,
  fitMemoryBudget,
  memoryDate,
  memoryEntry,
  removeMemoryEntry,
  searchMemory,
  sinceDate,
  supersedeMemoryEntry,
  topicName,
} from "../../monos/model/monoMemory";

export type AppSessionListing = {
  id: string;
  title: string;
  harness: HarnessId;
  model: string;
  busy: boolean;
  state: AppSessionState;
  hasDraft: boolean;
  archived: boolean;
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
    notifyMonoId?: string,
  ): Promise<void>;
  sessions(cwd: string): Promise<AppSessionListing[]>;
  session(id: string): Promise<Session | null>;
  readConversation?(session: Session, options: SessionReadOptions): Promise<ReturnType<typeof sessionConversationPage>>;
  send(
    id: string,
    prompt: string,
    requestId: string,
    notifyMonoId?: string,
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
  stop(id: string): Promise<void>;
  remove(id: string, mode: "archive" | "delete"): Promise<void>;
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
  artifacts?(): Promise<Artifact[]>;
  artifact?(id: string): Promise<Artifact | null>;
  saveArtifact?(artifact: ArtifactUpsert): Promise<Artifact>;
  postArtifact?(sourceSessionId: string, card: ArtifactCard): void | Promise<void>;
  /** Whether the session is a Mono's own conversation, which owns memory. */
  isMono(sessionId: string): boolean;
  /**
   * The Mono a session works for: its own conversation or one of its habit
   * runs. Its projects are the ones it may name with "project".
   */
  monoOf?(sessionId: string): {
    id: string;
    projects: readonly string[];
    showStartedSessionsInSidebar?: boolean;
  } | undefined;
  /** A hidden run of one of a Mono's habits: it may remember, not schedule. */
  isHabitRun?(sessionId: string): boolean;
  /** Puts a card in the Mono's chat, or holds it for a habit run's report. */
  postCard?(sourceSessionId: string, card: MonoCard): void;
  habits?: {
    load(monoId: string): Promise<Habit[]>;
    update<T>(
      monoId: string,
      change: (habits: Habit[]) => { habits: Habit[]; result: T },
    ): Promise<T>;
  };
  agentFiles(monoId: string): Promise<MonoFiles>;
  readAgentFile(
    monoId: string,
    path: AgentFilePath,
  ): Promise<{ text: string | null; hash: string }>;
  /** Throws `MonoFileConflict` when the file moved past `hash`. */
  writeAgentFile(
    monoId: string,
    path: AgentFilePath,
    text: string,
    hash: string,
  ): Promise<string>;
  /** The clock entries are dated by; tests pin it. */
  now?(): Date;
};

const FIELDS = new Map<string, readonly string[]>([
  ["models.list", []],
  ["sessions.list", ["project"]],
  [
    "sessions.read",
    ["sessionId", "turnId", "before", "limit", "maxChars", "project"],
  ],
  [
    "sessions.send",
    ["sessionId", "prompt", "wait", "notify", "notifyOnComplete", "project"],
  ],
  [
    "sessions.wait",
    ["sessionId", "sessionIds", "turnId", "until", "timeoutSeconds", "project"],
  ],
  ["sessions.steer", ["sessionId", "prompt", "project"]],
  ["sessions.respond", ["sessionId", "requestId", "decision", "project"]],
  ["sessions.answer", ["sessionId", "requestId", "answers", "skip", "project"]],
  ["sessions.draft", ["sessionId", "prompt", "project"]],
  ["sessions.stop", ["sessionId", "project"]],
  ["sessions.archive", ["sessionId", "project"]],
  ["sessions.delete", ["sessionId", "project"]],
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
      "project",
      "notifyOnComplete",
    ],
  ],
  ["worktrees.list", ["project"]],
  ["worktrees.create", ["branch", "base", "existing", "project"]],
  ["folders.list", ["project"]],
  ["folders.move", ["sessionId", "folderId", "newFolderName", "project"]],
  ["notes.list", ["limit", "offset"]],
  ["notes.read", ["id"]],
  ["notes.write", ["id", "title", "body", "tags"]],
  ["artifacts.list", ["kind", "limit", "offset"]],
  ["artifacts.read", ["id"]],
  ["artifacts.write", ["id", "kind", "title", "body", "summary"]],
  ["soul.read", []],
  ["soul.update", ["text", "expectedHash"]],
  ["memory.read", ["topic"]],
  ["memory.search", ["query", "since"]],
  ["memory.add", ["fact", "topic", "until"]],
  ["memory.replace", ["find", "fact", "topic", "until"]],
  ["memory.remove", ["find", "topic"]],
  ["habits.list", []],
  ["habits.add", ["name", "instructions", "schedule"]],
  ["habits.update", ["id", "name", "instructions", "schedule", "enabled"]],
  ["habits.run", ["id"]],
  ["habits.remove", ["id"]],
  ["chat.card", [...CARD_FIELDS]],
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

/**
 * How the caller hears that a turn it sent has finished. `notify` and
 * `notifyOnComplete` are the same request: a Mono gets a report in its chat
 * once it is idle, and any other session is woken in its thread.
 */
function completionTarget(
  source: Session,
  input: Record<string, unknown>,
  host: AgentAppHost,
  defaultForMono = false,
): { monoId?: string; watch: boolean } {
  for (const field of ["notify", "notifyOnComplete"] as const)
    if (input[field] !== undefined && typeof input[field] !== "boolean")
      throw new Error(`${field} must be a boolean`);
  if (
    input.notify !== undefined &&
    input.notifyOnComplete !== undefined &&
    input.notify !== input.notifyOnComplete
  )
    throw new Error("notify and notifyOnComplete disagree; pass one of them");
  const requested = (input.notifyOnComplete ?? input.notify) as
    | boolean
    | undefined;
  const isMono = host.isMono(source.id);
  if (!(requested ?? (defaultForMono && isMono && !input.draft)))
    return { watch: false };
  if (input.draft === true)
    throw new Error(
      "An unsent draft cannot send a completion notification; omit draft:true",
    );
  return isMono ? { monoId: source.id, watch: false } : { watch: true };
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

/**
 * The project an action works in. A session works in its own; a Mono works on
 * several, so it names one with "project" (its path or name), and may leave it
 * out when it has one project or is in one of its own.
 */
function requireProject(
  source: Session,
  input: Record<string, unknown>,
  host: AgentAppHost,
): string {
  const mono = host.monoOf?.(source.id);
  const named = optionalString(input.project, "project", 4096);
  if (!mono) {
    if (named) throw new Error("project is only for a Mono");
    if (!looksLikeProject(source.cwd))
      throw new Error("Choose a project folder in this session first");
    return source.cwd;
  }
  const choices = () =>
    mono.projects.length
      ? mono.projects.map((path) => `${projectName(path)} (${path})`).join(", ")
      : "none yet; the user adds them from your details panel";
  if (named) {
    const byPath = mono.projects.find(
      (path) => pathKey(path) === pathKey(named),
    );
    const byName = mono.projects.filter(
      (path) => projectName(path) === named,
    );
    const match = byPath ?? (byName.length === 1 ? byName[0] : undefined);
    if (!match) throw new Error(`Not one of your projects. Yours: ${choices()}`);
    return match;
  }
  const own = mono.projects.find(
    (path) => pathKey(path) === pathKey(source.cwd),
  );
  if (own) return own;
  if (mono.projects.length === 1) return mono.projects[0];
  throw new Error(`Pass "project" to choose one. Yours: ${choices()}`);
}

/** A Mono's chat lives outside its projects; project access follows its roster. */
export function canAccessAgentAppProject(
  source: Session,
  cwd: string,
  monoProjects?: readonly string[],
): boolean {
  return (monoProjects ?? [source.cwd]).some(
    (project) => pathKey(project) === pathKey(cwd),
  );
}

async function projectSession(
  source: Session,
  id: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<Session> {
  const cwd = requireProject(source, input, host);
  if (!(await host.sessions(cwd)).some((session) => session.id === id))
    throw new Error("Session was not found in this project");
  const target = await host.session(id);
  if (!target || pathKey(target.cwd) !== pathKey(cwd))
    throw new Error("Session was not found in this project");
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
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<string> {
  if (ref === source.id || !SESSION_NAME.test(ref)) return ref;
  const named = namedSessionId(source, ref);
  const listed = await host.sessions(requireProject(source, input, host));
  return listed.some((session) => session.id === named) ? named : ref;
}

/** Resolve a session ID, or a name this operator gave one of its sessions. */
async function targetSession(
  source: Session,
  input: Record<string, unknown>,
  host: AgentAppHost,
  value: unknown = input.sessionId,
  field = "sessionId",
): Promise<Session> {
  const ref = requiredString(value, field, 256);
  if (ref === source.id) return source;
  return projectSession(
    source,
    await resolveSessionRef(source, ref, input, host),
    input,
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
  host: AgentAppHost,
): QuickLaunch {
  const cwd = requireProject(source, input, host);
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
  const currentWorktree =
    worktreeCwd ||
    (pathKey(cwd) === pathKey(source.cwd) ? source.worktreeCwd : undefined);
  return {
    cwd,
    prompt,
    ...(host.monoOf?.(source.id)?.showStartedSessionsInSidebar === false
      ? { sidebarHidden: true }
      : {}),
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
    // A Mono delegates work without navigating the user out of their chat.
    reveal: host.isMono(source.id) ? false : reveal,
    workspaceMode,
    ...(workspaceMode === "current" && currentWorktree
      ? { worktreeCwd: currentWorktree }
      : {}),
    ...(worktreeBase ? { worktreeBase } : {}),
  };
}

function memoryPath(topic: unknown): AgentFilePath {
  return topic === undefined
    ? "MEMORY.md"
    : `memory/${topicName(requiredString(topic, "topic", 80))}.md`;
}

async function handleSoul(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const monoId = host.isMono(source.id)
    ? host.monoOf?.(source.id)?.id
    : undefined;
  if (!monoId)
    throw new Error("Only a Mono's own conversation can manage its soul");
  if (action === "soul.read") {
    const files = await host.agentFiles(monoId);
    return { file: "SOUL.md", text: files.soul, hash: files.soulHash };
  }
  if (typeof input.text !== "string" || input.text.length > 240_000)
    throw new Error("text must be a string under 240000 characters");
  const expectedHash = requiredString(input.expectedHash, "expectedHash", 128);
  try {
    const hash = await host.writeAgentFile(
      monoId,
      "SOUL.md",
      input.text,
      expectedHash,
    );
    return { file: "SOUL.md", updated: true, hash };
  } catch (error) {
    if (error instanceof MonoFileConflict)
      throw new Error(
        "SOUL.md changed since you read it. Run soul.read and reapply the user's requested changes to the current text before calling soul.update again.",
      );
    throw error;
  }
}

/**
 * Read, change and write one memory file over the version it read, again
 * from the top when the user saved the same file in between.
 */
async function editAgentFile<T>(
  host: AgentAppHost,
  monoId: string,
  path: AgentFilePath,
  edit: (text: string) => { text: string; result: T },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const current = await host.readAgentFile(monoId, path);
    const fallback =
      current.text == null && path !== "MEMORY.md"
        ? `# ${path.slice("memory/".length, -".md".length)}\n\n`
        : "";
    const next = edit(current.text ?? fallback);
    try {
      if (next.text !== (current.text ?? ""))
        await host.writeAgentFile(monoId, path, next.text, current.hash);
      return next.result;
    } catch (error) {
      if (!(error instanceof MonoFileConflict) || attempt >= 2)
        throw error;
    }
  }
}

/**
 * Keeps MEMORY.md within what loads. The archive is written first, so a line
 * is never out of one file without already being in the other. If the user
 * saved MEMORY.md in between, the trim waits for the next write.
 */
async function keepMemoryInBudget(
  host: AgentAppHost,
  monoId: string,
  keep: string,
  date: string,
): Promise<string[]> {
  const memory = await host.readAgentFile(monoId, "MEMORY.md");
  const fitted = fitMemoryBudget(memory.text ?? "", keep, date);
  if (!fitted.moved.length) return [];
  await editAgentFile(host, monoId, "memory/archive.md", (archive) => ({
    text: archiveMemoryEntries(archive, fitted.moved, date),
    result: undefined,
  }));
  try {
    await host.writeAgentFile(monoId, "MEMORY.md", fitted.text, memory.hash);
  } catch (error) {
    if (!(error instanceof MonoFileConflict)) throw error;
    return [];
  }
  return fitted.moved;
}

async function handleMemory(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const monoId = host.monoOf?.(source.id)?.id;
  if (!monoId) throw new Error("Memory belongs to the Mono's conversation");
  const path = memoryPath(input.topic);
  const date = memoryDate(host.now?.() ?? new Date());
  const until = optionalString(input.until, "until", 10);
  const report = async (result: Record<string, unknown>, keep?: string) => {
    const moved =
      path === "MEMORY.md" && keep
        ? await keepMemoryInBudget(host, monoId, keep, date)
        : [];
    return {
      file: path,
      ...result,
      ...(moved.length
        ? { movedToArchive: moved.length, moved: moved.slice(0, 5) }
        : {}),
    };
  };
  switch (action) {
    case "memory.search": {
      const query =
        input.query === undefined
          ? ""
          : requiredString(input.query, "query", 500);
      const since =
        input.since === undefined
          ? undefined
          : sinceDate(
              requiredString(input.since, "since", 20),
              host.now?.() ?? new Date(),
            );
      const files = await host.agentFiles(monoId);
      const paths: AgentFilePath[] = [
        "MEMORY.md",
        ...files.topics.map((topic) => `memory/${topic}.md` as const),
        "memory/archive.md",
      ];
      const texts = await Promise.all(
        paths.map(async (file) => ({
          file,
          text:
            file === "MEMORY.md"
              ? files.memory
              : ((await host.readAgentFile(monoId, file)).text ?? ""),
        })),
      );
      const hits = searchMemory(texts, query, { since });
      return hits.length
        ? { hits }
        : { hits, note: "Nothing in memory matches. It may never have been saved." };
    }
    case "memory.read": {
      if (path !== "MEMORY.md") {
        const topic = await host.readAgentFile(monoId, path);
        if (topic.text == null) throw new Error("No such memory topic");
        return { file: path, text: topic.text };
      }
      const files = await host.agentFiles(monoId);
      const budget = memoryWithinBudget(files.memory);
      return {
        file: path,
        text: files.memory,
        lines: budget.lines,
        notLoaded: budget.droppedLines,
        topics: files.topics,
      };
    }
    case "memory.add": {
      const entry = memoryEntry(requiredString(input.fact, "fact"), date, until);
      const added = await editAgentFile(host, monoId, path, (text) => {
        const next = addMemoryEntry(text, entry);
        return { text: next.text, result: next.added };
      });
      return added
        ? report({ added: entry }, entry)
        : { file: path, alreadyRemembered: true };
    }
    case "memory.replace": {
      const find = requiredString(input.find, "find", 2000);
      const entry = memoryEntry(requiredString(input.fact, "fact"), date, until);
      await editAgentFile(host, monoId, path, (text) => ({
        text: supersedeMemoryEntry(text, find, entry, date),
        result: undefined,
      }));
      return report({ superseded: find, added: entry }, entry);
    }
    case "memory.remove": {
      const find = requiredString(input.find, "find", 2000);
      const removed = await editAgentFile(host, monoId, path, (text) => {
        const next = removeMemoryEntry(text, find);
        return { text: next.text, result: next.removed };
      });
      return { file: path, removed };
    }
  }
  throw new Error(`Unknown app action: ${action}`);
}

function habitView(habit: Habit) {
  return {
    id: habit.id,
    name: habit.name,
    instructions: habit.instructions,
    schedule: habitScheduleLabel(habit.schedule),
    enabled: habit.enabled,
    nextRun: habit.enabled ? new Date(habit.nextRunAt).toLocaleString() : null,
    ...(habitRunningSince(habit.id) != null ? { running: true } : {}),
    ...(habit.lastRunAt
      ? {
          lastRun: new Date(habit.lastRunAt).toLocaleString(),
          lastOutcome: habit.lastOutcome,
          ...(habit.lastError ? { lastError: habit.lastError } : {}),
        }
      : {}),
  };
}

async function handleHabits(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const habits = host.habits;
  // A habit's own run cannot schedule more runs.
  const monoId = host.isMono(source.id)
    ? host.monoOf?.(source.id)?.id
    : undefined;
  if (!habits || !monoId)
    throw new Error("Only a Mono's own conversation can manage its habits");
  const now = host.now?.() ?? new Date();
  const find = (list: Habit[]) => {
    const id = requiredString(input.id, "id", 128);
    const habit = list.find((entry) => entry.id === id);
    if (!habit) throw new Error("No habit with that id; run habits.list");
    return habit;
  };
  switch (action) {
    case "habits.list":
      return { habits: (await habits.load(monoId)).map(habitView) };
    case "habits.add": {
      const name = requiredString(input.name, "name", 80);
      const instructions = requiredString(input.instructions, "instructions", 4_000);
      const schedule = habitSchedule(input.schedule);
      const habit = await habits.update(monoId, (list) => {
        if (list.length >= HABITS_MAX)
          throw new Error(`A Mono can have at most ${HABITS_MAX} habits`);
        const created = newHabit(
          { name, instructions, schedule },
          now.getTime(),
        );
        return { habits: [...list, created], result: created };
      });
      return { habit: habitView(habit) };
    }
    case "habits.update": {
      const patch = {
        ...(input.name === undefined
          ? {}
          : { name: requiredString(input.name, "name", 80) }),
        ...(input.instructions === undefined
          ? {}
          : {
              instructions: requiredString(
                input.instructions,
                "instructions",
                4_000,
              ),
            }),
        ...(input.schedule === undefined
          ? {}
          : { schedule: habitSchedule(input.schedule) }),
      };
      if (input.enabled !== undefined && typeof input.enabled !== "boolean")
        throw new Error("enabled must be true or false");
      const habit = await habits.update(monoId, (list) => {
        const current = find(list);
        const next: Habit = {
          ...current,
          ...patch,
          ...(input.enabled === undefined
            ? {}
            : { enabled: input.enabled as boolean }),
        };
        // A new schedule, or turning it back on, counts from now.
        if (patch.schedule || (next.enabled && !current.enabled))
          next.nextRunAt = nextHabitRunAt(next.schedule, now.getTime());
        return {
          habits: list.map((entry) => (entry.id === next.id ? next : entry)),
          result: next,
        };
      });
      return { habit: habitView(habit) };
    }
    case "habits.run": {
      const running = habitRunningSince(requiredString(input.id, "id", 128));
      if (running != null)
        throw new Error(
          `That habit is already running (started ${new Date(running).toLocaleTimeString()}); its result will be posted here when it ends`,
        );
      const habit = await habits.update(monoId, (list) => {
        const next = { ...find(list), runRequested: true };
        return {
          habits: list.map((entry) => (entry.id === next.id ? next : entry)),
          result: next,
        };
      });
      checkHabitsNow();
      return {
        habit: habitView(habit),
        note: "It starts now, on its own. Whatever it finds is posted to this chat, or nothing if there is nothing to say.",
      };
    }
    case "habits.remove": {
      const removed = await habits.update(monoId, (list) => {
        const habit = find(list);
        return {
          habits: list.filter((entry) => entry.id !== habit.id),
          result: habit,
        };
      });
      return { removed: removed.name };
    }
  }
  throw new Error(`Unknown app action: ${action}`);
}

function artifactKind(value: unknown): ArtifactKind {
  if (value === undefined || value === "document") return "document";
  throw new Error('Unsupported artifact kind; only "document" is supported');
}

async function handleArtifacts(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  if (!(host.isMono(source.id) || host.isHabitRun?.(source.id)))
    throw new Error("Only a Mono can create or read artifacts");
  if (!host.artifact) throw new Error("Artifacts are unavailable");
  if (action === "artifacts.list") {
    if (!host.artifacts) throw new Error("Artifacts are unavailable");
    const kind =
      input.kind === undefined ? undefined : artifactKind(input.kind);
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
    const artifacts = (await host.artifacts()).filter(
      (artifact) => kind === undefined || artifact.kind === kind,
    );
    return {
      total: artifacts.length,
      offset,
      artifacts: artifacts
        .slice(offset as number, (offset as number) + (limit as number))
        .map(({ id, kind, title, updatedAt }) => ({
          id,
          kind,
          title,
          updatedAt,
        })),
    };
  }
  if (action === "artifacts.read") {
    const artifact = await host.artifact(requiredString(input.id, "id", 256));
    if (!artifact) throw new Error("Artifact was not found");
    return artifact;
  }
  if (!host.saveArtifact || !host.postArtifact)
    throw new Error("Artifacts are unavailable");
  const kind = artifactKind(input.kind);
  const id = optionalString(input.id, "id", 256);
  if (id && !/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error("Invalid artifact ID");
  const title =
    input.title === undefined
      ? undefined
      : requiredString(input.title, "title", 200);
  const body = input.body === undefined ? undefined : noteBody(input.body);
  const summary =
    input.summary === undefined
      ? undefined
      : requiredString(input.summary, "summary", 280);
  let artifact: Artifact;
  if (id) {
    if (title === undefined && body === undefined)
      throw new Error("Supply title or body to update an artifact");
    const current = await host.artifact(id);
    if (!current) throw new Error("Artifact was not found");
    if (current.kind !== kind)
      throw new Error("An artifact's kind cannot be changed");
    artifact = await host.saveArtifact({
      id,
      kind,
      title: title ?? current.title,
      body: body ?? current.body,
    });
  } else {
    if (body === undefined)
      throw new Error("body is required to create an artifact");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
      throw new Error("Invalid request ID");
    const createdId = `artifact-${source.id}-${requestId}`;
    const existing = await host.artifact(createdId);
    if (
      existing &&
      (existing.kind !== kind ||
        existing.title !== (title ?? noteTitle(body)) ||
        existing.body !== body)
    )
      throw new Error("Request ID was already used for another artifact");
    artifact =
      existing ??
      (await host.saveArtifact({
        id: createdId,
        kind,
        title: title ?? noteTitle(body),
        body,
        sourceSessionId: source.id,
        ...(looksLikeProject(source.cwd) ? { sourceCwd: source.cwd } : {}),
      }));
  }
  const card: ArtifactCard = {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    ...(summary ? { summary } : {}),
  };
  await host.postArtifact(source.id, card);
  return { ...card, saved: true, attached: true };
}

export async function handleAgentApp(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  fields(action, input);
  if (action.startsWith("artifacts."))
    return handleArtifacts(source, requestId, action, input, host);
  if (action.startsWith("soul."))
    return handleSoul(source, action, input, host);
  if (action.startsWith("memory."))
    return handleMemory(source, action, input, host);
  if (action.startsWith("habits."))
    return handleHabits(source, action, input, host);
  if (action === "chat.card") {
    if (
      !host.postCard ||
      !(host.isMono(source.id) || host.isHabitRun?.(source.id))
    )
      throw new Error("Only a Mono can put cards in its chat");
    const card = parseCard(input);
    host.postCard(source.id, card);
    return {
      posted: card.type,
      note: host.isMono(source.id)
        ? "It shows in the chat where you are in your reply."
        : "It goes out with your report, after its text; if you stay quiet, it is dropped.",
    };
  }
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
    case "sessions.list": {
      const cwd = requireProject(source, input, host);
      return {
        cwd,
        sessions: (await host.sessions(cwd)).map((listing) => {
          const name = sessionName(source, listing.id);
          return name ? { ...listing, name } : listing;
        }),
      };
    }
    case "sessions.read": {
      const target = await targetSession(source, input, host);
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
      const options = {
        before: optionalString(input.before, "before", 256),
        limit: input.limit as number | undefined,
        maxChars: input.maxChars as number | undefined,
      };
      return {
        ...(host.readConversation
          ? await host.readConversation(target, options)
          : sessionConversationPage(target, options)),
        ...describe(source, target),
      };
    }
    case "sessions.send": {
      const target = await targetSession(source, input, host);
      const prompt = agentPrompt(input.prompt);
      const completion = completionTarget(source, input, host);
      if (target.id === source.id)
        throw new Error(
          "Use the current conversation to continue this session",
        );
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
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
      const result = await host.send(
        target.id,
        prompt,
        appRequestId,
        ...(completion.monoId ? [completion.monoId] : []),
      );
      if (completion.watch)
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
        ...(completion.monoId ? { notifyOnComplete: true } : {}),
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
        refs.map((ref) =>
          targetSession(source, input, host, ref, "sessionIds"),
        ),
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
      const target = await targetSession(source, input, host);
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
      const target = await targetSession(source, input, host);
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
      const prompt = agentPrompt(input.prompt);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      const { id } = await targetSession(source, input, host);
      if (id === source.id)
        throw new Error("Use the composer to save a draft in this session");
      const result = await host.draft(
        id,
        prompt,
        `app-${source.id}-${requestId}`,
      );
      return { sessionId: id, saved: true, ...result };
    }
    case "sessions.stop":
    case "sessions.archive":
    case "sessions.delete": {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      const target = await targetSession(source, input, host);
      const id = target.id;
      if (id === source.id)
        throw new Error("Cannot stop, archive or delete the calling session");
      if (
        target.orchestrationLeadId ||
        host.isMono(id) ||
        host.isHabitRun?.(id)
      )
        throw new Error("Only regular project sessions can be managed here");
      if (action === "sessions.stop") {
        await host.stop(id);
        return { sessionId: id, stopped: true };
      }
      const mode = action === "sessions.archive" ? "archive" : "delete";
      await host.remove(id, mode);
      return {
        sessionId: id,
        [mode === "archive" ? "archived" : "deleted"]: true,
      };
    }
    case "sessions.start": {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error(
          "request ID must use letters, digits, underscores or hyphens",
        );
      const launch = startLaunch(source, input, host);
      const name =
        input.name === undefined
          ? undefined
          : requiredString(input.name, "name", 32);
      if (name !== undefined && !SESSION_NAME.test(name))
        throw new Error(
          "name must start with a lowercase letter and use up to 32 lowercase letters, digits, - or _",
        );
      const completion = completionTarget(source, input, host, true);
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
            ? await resolveSessionRef(source, beside, input, host)
            : source.id;
      if (besideSessionId)
        await host.start(
          launch,
          id,
          { direction: placement as SplitDir, besideSessionId },
          ...(completion.monoId ? [completion.monoId] : []),
        );
      else if (completion.monoId)
        await host.start(launch, id, undefined, completion.monoId);
      else await host.start(launch, id);
      // The launch turn carries the session ID as its request ID.
      if (completion.watch)
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
        ...(completion.monoId ? { notifyOnComplete: true } : {}),
      };
    }
    case "worktrees.list":
      return host.worktrees(requireProject(source, input, host));
    case "worktrees.create": {
      const cwd = requireProject(source, input, host);
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
      const cwd = requireProject(source, input, host);
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
      const cwd = requireProject(source, input, host);
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
