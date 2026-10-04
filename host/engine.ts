import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  ensureHostWorktree,
  renameHostWorktreeBranch,
  resolveHostWorktree,
} from "./git-worktrees";
import {
  applyHarnessEvent,
  stopStreaming,
} from "../src/integrations/harness/core/apply";
import { resolveModel } from "../src/features/sessions/model/models";
import { isVisionImage } from "../src/features/sessions/model/attachments";
import type {
  HarnessEvent,
  HarnessSessionInput,
} from "../src/integrations/harness/core/types";
import {
  HARNESS_LABEL,
  RUNTIME_MODES,
  canReplaceSessionTitle,
  formatSessionTitle,
  titleFromPrompt,
  type Attachment,
  type Block,
  type QueuedMessage,
  type Session,
} from "../src/features/sessions/model/session";
import {
  canDispatchQueuedHead,
  dequeueQueuedMessage,
  queuedHead,
} from "../src/features/sessions/model/messageQueue";
import { namedWorktreeBranch } from "../src/features/source-control/model/worktrees";
import {
  isRemoteProvider,
  type CreateInitial,
  type CreateWorktree,
  type HostCommand,
  type HostSession,
  type CommandReceipt,
  type RemoteProvider,
  type TurnOutcome,
} from "../src/features/connections/model/protocol";
import type { HostProvider } from "./providers";
import { HostStore } from "./store";
import { parseRemoteAttachments, resolveAttachments } from "./attachments";
import { HostError } from "./errors";

/** Bounds a session snapshot; the desktop's composer has no practical limit. */
const MAX_QUEUED = 100;

/** Hashes the parsed command, so retries match however the client ordered keys. */
const commandSignature = (command: HostCommand) =>
  createHash("sha256").update(JSON.stringify(command)).digest("hex");

/** The temporary branch of a `worktree: {mode: "new"}` create. Derived from
 * the command id so a retried create finds the same worktree. */
export const createWorktreeBranch = (commandId: string) =>
  `mc/${createHash("sha256").update(commandId).digest("hex").slice(0, 8)}`;

type Turn = {
  /** The user block id: a command id, or a queued message id. */
  id: string;
  text: string;
  compact?: boolean;
  attachments: Attachment[];
  intent?: "default" | "plan" | "build";
  /** A reviewed plan this turn builds. */
  plan?: Block;
};

// Streamed output is written in batches. Anything a user may need to act on
// (approvals, questions, errors, completion) is written immediately.
const FLUSH_MS = 120;
const BATCHED = new Set<string>([
  "message.delta",
  "reasoning.delta",
  "tool.updated",
  "agent.step",
  "status",
]);

const text = (value: unknown, label: string, max = 128): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error(`Invalid ${label}`);
  return value;
};

function modelSettings(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid model settings");
  const entries = Object.entries(value);
  if (
    entries.length > 20 ||
    entries.some(
      ([key, setting]) =>
        !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) ||
        typeof setting !== "string" ||
        setting.length > 128 ||
        setting.includes("\0"),
    )
  )
    throw new Error("Invalid model settings");
  return Object.fromEntries(entries) as Record<string, string>;
}

/** A message body: text, or empty text when files carry the message. */
function prompt(value: unknown, attachments: number): string {
  if (
    typeof value !== "string" ||
    value.length > 256_000 ||
    value.includes("\0") ||
    (!value.trim() && attachments === 0)
  )
    throw new Error("Invalid prompt");
  return value;
}

/** `default` or `plan`: a queued or initial message cannot build a plan. */
function messageIntent(value: unknown): { intent?: "default" | "plan" } {
  if (value === undefined) return {};
  if (value !== "default" && value !== "plan")
    throw new Error("Invalid turn intent");
  return { intent: value };
}

function parseWorktree(value: unknown): CreateWorktree {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid worktree");
  if (v.mode === "current") return { mode: "current" };
  if (v.mode === "existing")
    return { mode: "existing", cwd: text(v.cwd, "working copy", 4096) };
  if (v.mode === "new")
    return v.base === undefined
      ? { mode: "new" }
      : { mode: "new", base: text(v.base, "worktree base", 255) };
  throw new Error("Invalid worktree");
}

function parseInitial(value: unknown): CreateInitial {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid initial message");
  const v = value as Record<string, unknown>;
  const attachments = parseRemoteAttachments(v.attachments);
  return {
    text: prompt(v.text, attachments.length),
    ...(attachments.length ? { attachments } : {}),
    ...messageIntent(v.intent),
  };
}

export function parseCommand(input: unknown): HostCommand {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid command");
  const v = input as Record<string, unknown>;
  const commandId = text(v.commandId, "command ID");
  if (v.type === "create") {
    if (
      !isRemoteProvider(v.harness) ||
      !RUNTIME_MODES.includes(v.runtimeMode as never)
    )
      throw new Error("Invalid provider or permission mode");
    if (
      v.autoWorktreeBranch !== undefined &&
      (v.worktreeCwd === undefined ||
        typeof v.autoWorktreeBranch !== "string" ||
        !/^mc\/[a-z0-9]{8}$/.test(v.autoWorktreeBranch))
    )
      throw new Error("Invalid automatically created worktree branch");
    const worktree =
      v.worktree === undefined ? undefined : parseWorktree(v.worktree);
    if (
      worktree &&
      (v.worktreeCwd !== undefined || v.autoWorktreeBranch !== undefined)
    )
      throw new Error("Invalid worktree: send worktree or worktreeCwd, not both");
    return {
      type: "create",
      commandId,
      projectId: text(v.projectId, "project ID"),
      ...(v.worktreeCwd !== undefined
        ? { worktreeCwd: text(v.worktreeCwd, "working copy", 4096) }
        : {}),
      ...(v.autoWorktreeBranch !== undefined
        ? { autoWorktreeBranch: v.autoWorktreeBranch as string }
        : {}),
      harness: v.harness,
      model: text(v.model, "model", 200),
      ...(v.modelSettings !== undefined
        ? { modelSettings: modelSettings(v.modelSettings) }
        : {}),
      runtimeMode: v.runtimeMode as Session["runtimeMode"],
      ...(worktree ? { worktree } : {}),
      ...(v.initial !== undefined ? { initial: parseInitial(v.initial) } : {}),
    };
  }
  const sessionId = text(v.sessionId, "session ID");
  if (v.type === "queue") {
    const attachments = parseRemoteAttachments(v.attachments);
    return {
      type: "queue",
      commandId,
      sessionId,
      text: prompt(v.text, attachments.length),
      ...(attachments.length ? { attachments } : {}),
      ...messageIntent(v.intent),
    };
  }
  if (v.type === "unqueue")
    return {
      type: "unqueue",
      commandId,
      sessionId,
      queuedId: text(v.queuedId, "queued message ID"),
    };
  if (v.type === "resumeQueue")
    return { type: "resumeQueue", commandId, sessionId };
  if (v.type === "editQueued") {
    // Empty text is allowed when the item has files; checked against the item.
    if (
      typeof v.text !== "string" ||
      v.text.length > 256_000 ||
      v.text.includes("\0")
    )
      throw new Error("Invalid prompt");
    return {
      type: "editQueued",
      commandId,
      sessionId,
      queuedId: text(v.queuedId, "queued message ID"),
      text: v.text,
    };
  }
  if (v.type === "configure") {
    if (!RUNTIME_MODES.includes(v.runtimeMode as never))
      throw new Error("Invalid permission mode");
    return {
      type: "configure",
      commandId,
      sessionId,
      model: text(v.model, "model", 200),
      modelSettings: modelSettings(v.modelSettings),
      runtimeMode: v.runtimeMode as Session["runtimeMode"],
    };
  }
  if (v.type === "compact") return { type: "compact", commandId, sessionId };
  if (v.type === "send" || v.type === "draft") {
    const attachments = parseRemoteAttachments(v.attachments);
    if (
      typeof v.text !== "string" ||
      v.text.length > 256_000 ||
      v.text.includes("\0") ||
      (!v.text.trim() &&
        attachments.length === 0 &&
        !(v.type === "send" && v.draftBlockId !== undefined))
    )
      throw new Error("Invalid prompt");
    if (
      v.type === "send" &&
      v.intent !== undefined &&
      !["default", "plan", "build"].includes(String(v.intent))
    )
      throw new Error("Invalid turn intent");
    if (
      v.planBlockId !== undefined &&
      (v.type !== "send" || v.intent !== "build")
    )
      throw new Error("Invalid plan build");
    // Key order is part of the receipt signature; keep it stable.
    if (v.type === "draft")
      return {
        type: "draft",
        commandId,
        sessionId,
        text: v.text,
        ...(attachments.length ? { attachments } : {}),
      };
    return {
      type: "send",
      commandId,
      sessionId,
      text: v.text,
      ...(attachments.length ? { attachments } : {}),
      ...(v.type === "send" && v.intent
        ? { intent: v.intent as "default" | "plan" | "build" }
        : {}),
      ...(v.type === "send" && v.draftBlockId !== undefined
        ? { draftBlockId: text(v.draftBlockId, "draft block ID") }
        : {}),
      ...(v.type === "send" && v.planBlockId !== undefined
        ? { planBlockId: text(v.planBlockId, "plan block ID") }
        : {}),
    };
  }
  if (v.type === "removeDraft")
    return {
      type: "removeDraft",
      commandId,
      sessionId,
      draftBlockId: text(v.draftBlockId, "draft block ID"),
    };
  const runId = text(v.runId, "run ID");
  if (v.type === "cancel")
    return { type: "cancel", commandId, sessionId, runId };
  if (v.type === "steer")
    return {
      type: "steer",
      commandId,
      sessionId,
      queuedId: text(v.queuedId, "queued message ID"),
      runId,
    };
  if (!Number.isSafeInteger(v.requestId) || Number(v.requestId) < 0)
    throw new Error("Invalid request ID");
  const requestId = Number(v.requestId);
  if (v.type === "approve" && (v.decision === "allow" || v.decision === "deny"))
    return {
      type: "approve",
      commandId,
      sessionId,
      runId,
      requestId,
      decision: v.decision,
    };
  if (v.type === "answer") {
    const reply = v.reply as
      { kind?: string; answers?: unknown; custom?: unknown } | undefined;
    if (reply?.kind === "skipped")
      return {
        type: "answer",
        commandId,
        sessionId,
        runId,
        requestId,
        reply: { kind: "skipped" },
      };
    if (
      reply?.kind === "answered" &&
      reply.answers &&
      typeof reply.answers === "object" &&
      !Array.isArray(reply.answers)
    ) {
      const entries = Object.entries(reply.answers);
      if (
        entries.length > 50 ||
        entries.some(
          ([key, value]) =>
            key.length > 200 ||
            !Array.isArray(value) ||
            value.length > 50 ||
            value.some((x) => typeof x !== "string" || x.length > 10_000),
        )
      )
        throw new Error("Invalid question answers");
      if (
        reply.custom != null &&
        (typeof reply.custom !== "object" ||
          Array.isArray(reply.custom) ||
          Object.values(reply.custom).some(
            (x) => typeof x !== "string" || x.length > 10_000,
          ))
      )
        throw new Error("Invalid custom answers");
      return {
        type: "answer",
        commandId,
        sessionId,
        runId,
        requestId,
        reply: {
          kind: "answered",
          answers: Object.fromEntries(entries),
          ...(reply.custom
            ? { custom: reply.custom as Record<string, string> }
            : {}),
        },
      };
    }
  }
  throw new Error("Unsupported command");
}

/** The provider reported an error during the last turn. */
function lastTurnFailed(blocks: readonly Block[]): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].notice === "error") return true;
    if (blocks[i].role === "user" && !blocks[i].draft) return false;
  }
  return false;
}

export class HostEngine {
  private switchingProjects = new Set<string>();
  private running = new Map<
    string,
    {
      runId: string;
      done: Promise<void>;
      cancelled: boolean;
      persistenceFailed: boolean;
      /** Set by `steer`: send this queued message next, without pausing. */
      steer?: string;
    }
  >();
  /** Creates still making their worktree, so a duplicate waits for the first. */
  private inflight = new Map<
    string,
    { signature: string; receipt: Promise<CommandReceipt> }
  >();
  /** Running sessions, including streamed events not yet written to disk. */
  private live = new Map<
    string,
    {
      value: HostSession;
      events: HarnessEvent[];
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;

  constructor(
    readonly store: HostStore,
    private readonly providers: Partial<Record<RemoteProvider, HostProvider>>,
  ) {
    // Provider dispatch is not transactional with SQLite. Never replay a send
    // automatically after a crash; its external effects may already exist.
    for (const value of store.sessions()) {
      if (value.status === "running") {
        this.save(
          this.settled(
            value,
            "interrupted",
            "Host restarted. This turn was interrupted; inspect its work before continuing.",
            value.updatedAt,
          ),
          { type: "interrupted" },
        );
      }
      if (value.session.providerSessionId)
        this.provider(value.session.harness).bind(
          value.session.id,
          value.session.providerSessionId,
          value.session.cwd,
        );
    }
  }

  async openProject(path: string) {
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("Choose an absolute directory path on the host");
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory())
      throw new Error("Project path is not a directory");
    return this.store.addProject(cwd, basename(cwd));
  }

  async withIdleProject<T>(
    projectId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.switchingProjects.has(projectId))
      throw new Error("A branch switch is already in progress");
    if (
      this.store
        .summaries(projectId)
        .some((session) => session.status === "running")
    )
      throw new Error(
        "Wait for running host sessions before switching branches",
      );
    this.switchingProjects.add(projectId);
    try {
      return await action();
    } finally {
      this.switchingProjects.delete(projectId);
    }
  }

  private provider(id: string): HostProvider {
    const provider = this.providers[id as RemoteProvider];
    if (!provider) throw new Error(`${id} is not available on this host`);
    return provider;
  }

  private save(value: HostSession, event: unknown): HostSession {
    return this.store.transaction(() =>
      this.store.save(
        { ...value, revision: value.revision + 1, updatedAt: Date.now() },
        event,
      ),
    );
  }

  updateSession(id: string, patch: Parameters<HostStore["updateSession"]>[1]) {
    this.flush(id);
    const summary = this.store.updateSession(id, patch);
    const live = this.live.get(id);
    if (live) live.value = this.store.session(id);
    return summary;
  }

  private flush(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    clearTimeout(live.timer);
    live.timer = undefined;
    if (!live.events.length) return;
    const events = live.events;
    live.value = this.save(live.value, { type: "events", events });
    live.events = [];
  }

  private scheduledFlush(id: string, provider: HostProvider): void {
    try {
      this.flush(id);
    } catch (error) {
      const active = this.running.get(id);
      if (active) active.persistenceFailed = true;
      console.error(
        "Session persistence failed; stopping its provider:",
        error instanceof Error ? error.message : "unknown error",
      );
      void provider.stop(id);
    }
  }

  private retrySettlement(
    id: string,
    runId: string,
    provider: HostProvider,
  ): void {
    if (this.closing || this.retryTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      void (async () => {
        try {
          await provider.stop(id);
          this.flush(id);
          const latest = this.store.session(id);
          if (latest.runId === runId && latest.status === "running")
            this.save(
              this.settled(
                latest,
                "interrupted",
                "Session storage failed during this turn. Inspect its work before continuing.",
                latest.updatedAt,
              ),
              { type: "interrupted", reason: "persistence failure" },
            );
          this.live.delete(id);
          this.running.delete(id);
          if (latest.session.providerSessionId)
            provider.bind(
              id,
              latest.session.providerSessionId,
              latest.session.cwd,
            );
        } catch (error) {
          console.error(
            "Retrying session persistence:",
            error instanceof Error ? error.message : "unknown error",
          );
          this.retrySettlement(id, runId, provider);
        }
      })();
    }, 1_000);
    timer.unref?.();
    this.retryTimers.set(id, timer);
  }

  command(raw: unknown): CommandReceipt {
    if (this.closing) throw new Error("Host is stopping");
    const command = parseCommand(raw);
    return this.execute(command, commandSignature(command));
  }

  /** `command()` for creates that first make a worktree (spec 09 §9.6).
   * Every other command runs synchronously, as through `command()`. */
  async commandAsync(raw: unknown): Promise<CommandReceipt> {
    if (this.closing) throw new Error("Host is stopping");
    const command = parseCommand(raw);
    const signature = commandSignature(command);
    if (command.type !== "create" || command.worktree?.mode !== "new")
      return this.execute(command, signature);
    const previous = this.store.receipt(command.commandId, signature);
    if (previous) return previous;
    const pending = this.inflight.get(command.commandId);
    if (pending) {
      if (pending.signature !== signature)
        throw new Error("Command ID was already used with a different payload");
      return pending.receipt;
    }
    const base = command.worktree.base ?? "HEAD";
    const receipt = (async () => {
      const project = this.store.project(command.projectId);
      if (this.switchingProjects.has(project.id))
        throw new Error("Wait for the branch switch to finish");
      this.provider(command.harness);
      const branch = createWorktreeBranch(command.commandId);
      // A retry after a crash finds the worktree (or just the branch) the
      // first attempt made, instead of failing on it or making a second one.
      const tree = await ensureHostWorktree(project.cwd, branch, base);
      if (this.closing) throw new Error("Host is stopping");
      return this.execute(command, signature, { cwd: tree.path, branch });
    })().finally(() => this.inflight.delete(command.commandId));
    this.inflight.set(command.commandId, { signature, receipt });
    return receipt;
  }

  private execute(
    command: HostCommand,
    signature: string,
    worktree?: { cwd: string; branch: string },
  ): CommandReceipt {
    const previous = this.store.receipt(command.commandId, signature);
    if (previous) return previous;
    if (command.type === "create" && command.worktree?.mode === "new" && !worktree)
      throw new HostError(
        "invalid_params",
        "Invalid worktree: a new worktree is created through commands.dispatch",
      );
    // Commands apply to the latest state, including batched stream output.
    if (command.type !== "create") this.flush(command.sessionId);
    let effect: ((saved: HostSession) => void) | undefined;
    const { receipt, saved } = this.store.transaction(() => {
      let value: HostSession;
      if (command.type === "create") {
        const project = this.store.project(command.projectId);
        if (this.switchingProjects.has(project.id))
          throw new Error("Wait for the branch switch to finish");
        this.provider(command.harness);
        const cwd =
          worktree?.cwd ??
          resolveHostWorktree(
            project.cwd,
            command.worktree?.mode === "existing"
              ? command.worktree.cwd
              : command.worktreeCwd,
          );
        const autoWorktreeBranch = worktree?.branch ?? command.autoWorktreeBranch;
        const now = Date.now();
        value = {
          projectId: project.id,
          autoWorktreeBranch,
          revision: 0,
          status: "idle",
          createdAt: now,
          updatedAt: now,
          session: {
            id: randomUUID(),
            cwd,
            harness: command.harness,
            model: command.model,
            runtimeMode: command.runtimeMode,
            modelSettings: command.modelSettings ?? {},
            title: "New remote session",
            ...(autoWorktreeBranch
              ? { branch: autoWorktreeBranch, worktreeCwd: cwd }
              : {}),
            blocks: [],
          },
        };
        // The first message is part of the create: one receipt, and no
        // moment in which the session exists without it.
        if (command.initial)
          ({ value, effect } = this.beginTurn(value, {
            id: command.commandId,
            text: command.initial.text,
            attachments: resolveAttachments(
              this.store,
              command.initial.attachments ?? [],
            ),
            intent: command.initial.intent,
          }));
      } else {
        value = this.store.session(command.sessionId);
        if (
          (command.type === "send" || command.type === "compact") &&
          this.switchingProjects.has(value.projectId)
        )
          throw new Error("Wait for the branch switch to finish");
        const provider = this.provider(value.session.harness);
        const queued = value.session.queuedMessages ?? [];
        const findQueued = (id: string) => {
          const item = queued.find((message) => message.id === id);
          if (!item) throw new HostError("not_found", "Queued message not found");
          return item;
        };
        if (command.type === "configure") {
          if (value.status === "running")
            throw new Error(
              "Wait for the current turn before changing settings",
            );
          value = {
            ...value,
            session: {
              ...value.session,
              model: command.model,
              modelSettings: command.modelSettings,
              runtimeMode: command.runtimeMode,
            },
          };
        } else if (command.type === "draft") {
          if (
            value.status === "running" ||
            value.session.blocks.some((block) => block.draft)
          )
            throw new Error("This session cannot save another draft right now");
          const attachments = resolveAttachments(
            this.store,
            command.attachments ?? [],
          );
          value = {
            ...value,
            session: {
              ...value.session,
              title: value.session.blocks.length
                ? value.session.title
                : titleFromPrompt(
                    command.text,
                    value.session.harness,
                    attachments,
                  ),
              blocks: [
                ...value.session.blocks,
                {
                  id: command.commandId,
                  role: "user",
                  text: command.text,
                  ...(attachments.length ? { attachments } : {}),
                  draft: true,
                },
              ],
            },
          };
        } else if (command.type === "removeDraft") {
          const draft = value.session.blocks.find(
            (block) => block.id === command.draftBlockId && block.draft,
          );
          if (!draft) throw new Error("Draft not found");
          value = {
            ...value,
            session: {
              ...value.session,
              blocks: value.session.blocks.filter(
                (block) => block.id !== draft.id,
              ),
            },
          };
        } else if (command.type === "send" || command.type === "compact") {
          if (value.status === "running")
            throw new Error("This session is already running");
          const draft =
            command.type === "send" && command.draftBlockId
              ? value.session.blocks.find(
                  (block) => block.id === command.draftBlockId && block.draft,
                )
              : undefined;
          if (command.type === "send" && command.draftBlockId && !draft)
            throw new Error("Draft not found");
          const plan =
            command.type === "send" && command.planBlockId
              ? value.session.blocks.find(
                  (block) =>
                    block.id === command.planBlockId && block.role === "plan",
                )
              : undefined;
          if (
            command.type === "send" &&
            command.planBlockId &&
            (!plan ||
              !plan.text.trim() ||
              plan.streaming ||
              plan.plan?.status === "building" ||
              plan.plan?.status === "built")
          )
            throw new Error("Plan is not ready to build");
          ({ value, effect } = this.beginTurn(value, {
            id: command.commandId,
            text: command.type === "send" ? command.text : "/compact",
            compact: command.type === "compact",
            attachments:
              command.type === "send"
                ? (draft?.attachments ??
                  resolveAttachments(this.store, command.attachments ?? []))
                : [],
            intent: command.type === "send" ? command.intent : undefined,
            plan,
          }));
        } else if (command.type === "queue") {
          const attachments = resolveAttachments(
            this.store,
            command.attachments ?? [],
          );
          if (
            value.status !== "running" &&
            !queued.length &&
            !value.session.usageLimit
          )
            // Nothing to wait for: exactly a send.
            ({ value, effect } = this.beginTurn(value, {
              id: command.commandId,
              text: command.text,
              attachments,
              intent: command.intent,
            }));
          else {
            if (queued.length >= MAX_QUEUED)
              throw new HostError(
                "invalid_params",
                `Invalid queue: at most ${MAX_QUEUED} messages can wait`,
              );
            value = {
              ...value,
              session: {
                ...value.session,
                queuedMessages: [
                  ...queued,
                  {
                    id: command.commandId,
                    text: command.text,
                    attachments,
                    ...(command.intent ? { intent: command.intent } : {}),
                  },
                ],
              },
            };
          }
        } else if (command.type === "unqueue") {
          findQueued(command.queuedId);
          value = {
            ...value,
            session: dequeueQueuedMessage(value.session, command.queuedId),
          };
        } else if (command.type === "editQueued") {
          const item = findQueued(command.queuedId);
          if (!command.text.trim() && !item.attachments.length)
            throw new Error("Invalid prompt");
          value = {
            ...value,
            session: {
              ...value.session,
              queuedMessages: queued.map((message) =>
                message === item ? { ...message, text: command.text } : message,
              ),
            },
          };
        } else if (command.type === "resumeQueue") {
          // Resuming is the person's explicit go-ahead, so it also lifts the
          // hold a usage limit put on the queue.
          value = {
            ...value,
            session: {
              ...value.session,
              usageLimit: undefined,
              queueStatus: queued.length ? "active" : undefined,
            },
          };
          const head = queuedHead(value.session);
          if (value.status !== "running" && head && canDispatchQueuedHead(value.session))
            ({ value, effect } = this.beginQueued(value, head));
        } else {
          if (value.runId !== command.runId || value.status !== "running")
            throw new Error(
              "This request belongs to a finished or replaced turn",
            );
          if (command.type === "steer") {
            const item = findQueued(command.queuedId);
            value = {
              ...value,
              session: {
                ...value.session,
                queuedMessages: [
                  item,
                  ...queued.filter((message) => message !== item),
                ],
              },
            };
            effect = () => {
              const active = this.running.get(command.sessionId);
              if (active) {
                active.cancelled = true;
                active.steer = command.queuedId;
              }
              void provider
                .cancel(command.sessionId)
                .catch(() => provider.stop(command.sessionId));
            };
          } else if (command.type === "cancel") {
            effect = () => {
              const active = this.running.get(command.sessionId);
              if (active) active.cancelled = true;
              void provider
                .cancel(command.sessionId)
                .catch(() => provider.stop(command.sessionId));
            };
          } else if (command.type === "approve") {
            const pending = value.session.blocks.some(
              (block) =>
                block.approval?.requestId === command.requestId &&
                !block.approval.decided,
            );
            if (!pending) throw new Error("Approval is already resolved");
            value = {
              ...value,
              session: applyHarnessEvent(value.session, {
                type: "approval.resolved",
                requestId: command.requestId,
                decision: command.decision,
              }),
            };
            effect = () =>
              provider.approve(
                command.sessionId,
                command.requestId,
                command.decision,
              );
          } else {
            if (value.session.pendingQuestion?.requestId !== command.requestId)
              throw new Error("Question is already resolved");
            value = {
              ...value,
              session: { ...value.session, pendingQuestion: undefined },
            };
            effect = () =>
              provider.answer(
                command.sessionId,
                command.requestId,
                command.reply,
              );
          }
        }
      }
      const saved = this.store.save(
        {
          ...value,
          revision: value.revision + 1,
          // Creation already initialized both timestamps from the same clock read.
          updatedAt: command.type === "create" ? value.updatedAt : Date.now(),
        },
        { type: "command", command },
      );
      const result = {
        commandId: command.commandId,
        sessionId: saved.session.id,
        revision: saved.revision,
      };
      this.store.recordReceipt(signature, result);
      return { receipt: result, saved };
    });
    const live = this.live.get(saved.session.id);
    if (live) live.value = saved;
    // A receipt means durable host acceptance, not provider completion.
    effect?.(saved);
    return receipt;
  }

  /** Starts a turn whose user block is `turn.id`. Returns the running value
   * to save and the effect that runs the provider once it is saved. */
  private beginTurn(
    value: HostSession,
    turn: Turn,
  ): { value: HostSession; effect: (saved: HostSession) => void } {
    if (this.switchingProjects.has(value.projectId))
      throw new Error("Wait for the branch switch to finish");
    const provider = this.provider(value.session.harness);
    if (value.status === "running")
      throw new Error("This session is already running");
    if (turn.compact && !provider.compact)
      throw new Error("Context compaction is unavailable for this provider");
    const runId = randomUUID();
    const firstTurn =
      !turn.compact && !value.session.blocks.some((block) => !block.draft);
    const placeholderTitle =
      value.session.title === "New remote session" ||
      canReplaceSessionTitle(
        value.session.title,
        value.session.harness,
        HARNESS_LABEL[value.session.harness],
      );
    const model = resolveModel(value.session.harness, value.session.model);
    const { plan } = turn;
    return {
      value: {
        ...value,
        status: "running",
        runId,
        session: {
          ...value.session,
          busy: true,
          pendingQuestion: undefined,
          // A new turn is the next attempt; the desktop clears it on send too.
          usageLimit: undefined,
          title:
            firstTurn && placeholderTitle
              ? titleFromPrompt(
                  turn.text,
                  value.session.harness,
                  turn.attachments,
                )
              : value.session.title,
          blocks: [
            ...value.session.blocks
              .filter((block) => !block.draft)
              .map((block) =>
                block === plan
                  ? {
                      ...block,
                      plan: {
                        ...(block.plan ?? { status: "ready" as const }),
                        status: "building" as const,
                        approvedText: block.text,
                      },
                    }
                  : block,
              ),
            {
              id: turn.id,
              role: "user",
              text: turn.text,
              ...(turn.attachments.length
                ? { attachments: turn.attachments }
                : {}),
              startedAt: Date.now(),
              turnModel: {
                harness: value.session.harness,
                id: value.session.model,
                name:
                  model.id === value.session.model
                    ? model.name
                    : value.session.model.replace(/^[^:]+:/, ""),
              },
            },
          ],
        },
      },
      effect: (saved) => {
        this.run(
          saved,
          turn.compact ? null : turn.text,
          turn.intent,
          turn.attachments,
        );
        if (firstTurn)
          this.generateFirstTurnNames(saved, turn.text, placeholderTitle);
      },
    };
  }

  /** Sends a queued message as the next turn; its id becomes the block id. */
  private beginQueued(value: HostSession, item: QueuedMessage) {
    return this.beginTurn(
      { ...value, session: dequeueQueuedMessage(value.session, item.id) },
      {
        id: item.id,
        text: item.text,
        attachments: item.attachments,
        intent:
          item.intent === "plan" || item.intent === "default"
            ? item.intent
            : undefined,
      },
    );
  }

  /** After a turn settles: send the steered message, or the queue head when
   * the queue may run. A failure pauses the queue instead of looping. */
  private dispatchQueued(id: string, steer?: string): void {
    try {
      const value = this.store.session(id);
      if (value.status === "running") return;
      // A steered message removed meanwhile falls back to the normal rules.
      const item =
        (steer && value.session.queuedMessages?.find((message) => message.id === steer)) ||
        (canDispatchQueuedHead(value.session) ? queuedHead(value.session) : undefined);
      if (!item) return;
      const started = this.beginQueued(value, item);
      const saved = this.save(started.value, {
        type: "queue.dispatched",
        queuedId: item.id,
      });
      started.effect(saved);
    } catch (error) {
      console.error(
        "Could not send the next queued message:",
        error instanceof Error ? error.message : error,
      );
      try {
        const latest = this.store.session(id);
        if (latest.status !== "running" && latest.session.queuedMessages?.length)
          this.save(
            { ...latest, session: { ...latest.session, queueStatus: "paused" } },
            { type: "queue.paused" },
          );
      } catch {
        /* the session is gone */
      }
    }
  }

  private generateFirstTurnNames(
    value: HostSession,
    message: string,
    generateTitle: boolean,
  ): void {
    const provider = this.provider(value.session.harness);
    const { id, cwd, harness, title } = value.session;
    if (generateTitle && provider.generateTitle) {
      void provider
        .generateTitle({ sessionId: id, cwd, message })
        .then((generated) => {
          if (!generated) return;
          this.flush(id);
          const current = this.store.session(id);
          if (current.session.title !== title) return;
          const saved = this.save(
            {
              ...current,
              session: {
                ...current.session,
                title: formatSessionTitle(harness, generated.title),
              },
            },
            { type: "session.generatedTitle" },
          );
          const live = this.live.get(id);
          if (live) live.value = saved;
        })
        .catch((error) =>
          console.debug("[monocode] remote session title", error),
        );
    }
    const temporary = value.autoWorktreeBranch;
    if (temporary && provider.generateBranchName) {
      void provider
        .generateBranchName(cwd, message)
        .then(async (fragment) => {
          const branch = fragment ? namedWorktreeBranch(fragment) : null;
          if (!branch) return;
          // A title/branch request may finish after the conversation was deleted.
          const currentBeforeRename = this.store.session(id);
          if (currentBeforeRename.autoWorktreeBranch !== temporary) return;
          const project = this.store.project(value.projectId);
          await renameHostWorktreeBranch(project.cwd, cwd, temporary, branch,
            () => this.store.session(id).autoWorktreeBranch === temporary);
          this.flush(id);
          const current = this.store.session(id);
          const saved = this.save(
            {
              ...current,
              autoWorktreeBranch: undefined,
              session: { ...current.session, branch },
            },
            { type: "session.generatedBranch", branch },
          );
          const live = this.live.get(id);
          if (live) live.value = saved;
        })
        .catch((error) =>
          console.debug("[monocode] remote worktree branch", error),
        );
    }
  }

  private run(
    value: HostSession,
    prompt: string | null,
    intent?: "default" | "plan" | "build",
    attachments: Session["blocks"][number]["attachments"] = [],
  ): void {
    const { session, runId } = value;
    const provider = this.provider(session.harness);
    const active: {
      runId: string;
      done: Promise<void>;
      cancelled: boolean;
      persistenceFailed: boolean;
      steer?: string;
    } = { runId: runId!, done: Promise.resolve(), cancelled: false, persistenceFailed: false };
    this.running.set(session.id, active);
    this.live.set(session.id, { value, events: [] });
    active.done = Promise.resolve()
      .then(async () => {
        let error: string | undefined;
        try {
          if (!this.closing && !active.cancelled) {
            const input: HarnessSessionInput = {
              sessionId: session.id,
              cwd: session.cwd,
              model: session.model,
              modelSettings: session.modelSettings,
              runtimeMode: session.runtimeMode,
              intent,
              onEvent: (event) => this.event(session.id, runId!, event),
            };
            if (prompt === null) await provider.compact!(input);
            else
              await provider.send({
                ...input,
                text: prompt,
                attachments: attachments?.map((file) =>
                  isVisionImage(file.mimeType) &&
                  file.path &&
                  file.size <= 20 * 1024 * 1024
                    ? {
                        ...file,
                        data: readFileSync(file.path).toString("base64"),
                      }
                    : file,
                ),
              });
          }
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        }
        // Keep the session running until the old process has stopped. Otherwise
        // a follow-up can race cleanup and have its newly spawned child killed.
        await provider.stop(session.id);
        this.flush(session.id);
        this.live.delete(session.id);
        const latest = this.store.session(session.id);
        const current = latest.runId === runId;
        if (current) {
          const message = this.closing
            ? "Host stopped. This turn was interrupted."
            : active.persistenceFailed
              ? "Session storage failed during this turn. Inspect its work before continuing."
              : active.cancelled
              ? "Stopped by you."
              : error;
          this.save(
            this.settled(
              latest,
              this.closing || active.persistenceFailed ? "interrupted" : "idle",
              message,
              undefined,
              { cancelled: active.cancelled, error, steer: !!active.steer },
            ),
            { type: "settled", error, cancelled: active.cancelled },
          );
        }
        this.running.delete(session.id);
        // stop/forget releases callbacks and native resources; bind only retained
        // provider conversation identity for an explicit future follow-up.
        const persisted = this.store.session(session.id).session;
        if (persisted.providerSessionId)
          provider.bind(session.id, persisted.providerSessionId, persisted.cwd);
        // Only after the running entry is gone: the next turn registers its own.
        if (current && !this.closing) this.dispatchQueued(session.id, active.steer);
      })
      .catch((error) => {
        clearTimeout(this.live.get(session.id)?.timer);
        console.error(
          "Session persistence failed; stopping its provider:",
          error instanceof Error ? error.message : "unknown error",
        );
        void provider.stop(session.id);
        this.retrySettlement(session.id, runId!, provider);
      });
  }

  private event(id: string, runId: string, event: HarnessEvent): void {
    const live = this.live.get(id);
    if (!live || live.value.runId !== runId || live.value.status !== "running")
      return;
    const session = applyHarnessEvent(live.value.session, event);
    if (session === live.value.session) return;
    live.value = { ...live.value, session };
    live.events.push(event);
    if (!BATCHED.has(event.type))
      this.scheduledFlush(id, this.provider(session.harness));
    else
      live.timer ??= setTimeout(
        () => this.scheduledFlush(id, this.provider(session.harness)),
        FLUSH_MS,
      );
  }

  /** The settled value: streaming stopped, the outcome recorded (spec 09
   * §9.6), and the queue paused unless the turn simply finished. */
  private settled(
    value: HostSession,
    status: "idle" | "interrupted",
    message?: string,
    endedAt = Date.now(),
    turn: { cancelled?: boolean; error?: string; steer?: boolean } = {},
  ): HostSession {
    const stopped = stopStreaming(value.session, endedAt);
    const session = {
      ...stopped,
      blocks: stopped.blocks.map((block) =>
        block.role === "plan" && block.plan?.status === "building"
          ? {
              ...block,
              plan: {
                ...block.plan,
                status:
                  status === "idle" && !message
                    ? ("built" as const)
                    : ("ready" as const),
              },
            }
          : block,
      ),
    };
    const outcome: TurnOutcome = turn.cancelled
      ? "cancelled"
      : turn.error || lastTurnFailed(session.blocks)
        ? "failed"
        : status === "interrupted"
          ? "interrupted"
          : "finished";
    if (message)
      session.blocks.push({
        id: randomUUID(),
        role: "system",
        text: message,
        streaming: false,
      });
    // A steer's cancel hands over to the steered message instead.
    const pause =
      !turn.steer &&
      !!session.queuedMessages?.length &&
      (outcome !== "finished" || !!session.usageLimit);
    return {
      ...value,
      status,
      finishedAt: endedAt,
      lastTurnOutcome: outcome,
      session: pause ? { ...session, queueStatus: "paused" } : session,
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    // Creates still making a worktree stop before saving; a retry reuses it.
    await Promise.allSettled([...this.inflight.values()].map((entry) => entry.receipt));
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.all(
      [...this.running.keys()].map((id) =>
        this.provider(this.store.session(id).session.harness).stop(id),
      ),
    );
    await Promise.all([...this.running.values()].map((active) => active.done));
  }
}
