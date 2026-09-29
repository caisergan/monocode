import {
  formatSessionTitle,
  titleFromPrompt,
  type HarnessId,
  type Session,
} from "../../../features/sessions/model/session";
import { appendUser, applyHarnessEvent, stopStreaming } from "./apply";
import type { HarnessEvent } from "./types";

const INTERRUPTED_BY_USER = "Interrupted by user.";
const COMPACTED = "Conversation compacted.";
const OPEN_TOOL_STATUSES = new Set(["pending", "in_progress", "running"]);

/** Where an imported conversation lives in MonoCode, and how it resumes. */
export type TranscriptImportTarget = {
  /**
   * The agent's conversation the next turn resumes. Omitted when it can't be
   * resumed (its folder is gone); the chat then keeps the transcript only.
   */
  providerSessionId?: string;
  /** MonoCode project, or "~" for a chat without one. */
  cwd: string;
  /** The linked git worktree the conversation ran in, inside `cwd`. */
  worktreeCwd?: string;
  branch?: string;
};

/** The same, with the agent's saved transcript records. */
export type TranscriptImportInput = TranscriptImportTarget & {
  records: Record<string, unknown>[];
};

/** Milliseconds from a record's ISO `timestamp`. */
export function recordTimestamp(
  record: Record<string, unknown>,
): number | undefined {
  const value = record.timestamp;
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** A prompt's text with a note for images the import leaves out. */
export function promptWithImageNote(text: string, imageCount: number): string {
  if (imageCount <= 0) return text;
  const note = `_${imageCount} image${imageCount === 1 ? "" : "s"} not imported_`;
  return text ? `${text}\n\n${note}` : note;
}

/**
 * Builds a MonoCode session while an importer replays an agent transcript
 * through the same events its live adapter emits, so an imported chat renders
 * like one that ran here. It owns what every transcript shares: turns opened
 * by prompts and timed from record timestamps, tool calls that never got a
 * result, interruptions, compactions and the title.
 */
export class TranscriptReplay {
  session: Session;
  private turnOpen = false;
  private turnStart: number | undefined;
  private turnEnd: number | undefined;
  private firstPrompt: string | undefined;
  private lastContext: number | undefined;

  constructor(base: Session, target: TranscriptImportTarget) {
    this.session = {
      ...base,
      ...(target.providerSessionId
        ? { providerSessionId: target.providerSessionId }
        : {}),
      ...(target.worktreeCwd ? { worktreeCwd: target.worktreeCwd } : {}),
      ...(target.branch ? { branch: target.branch } : {}),
    };
  }

  /** A turn is open between a prompt and the next prompt or interruption. */
  get inTurn(): boolean {
    return this.turnOpen;
  }

  emit(event: HarnessEvent): void {
    this.session = applyHarnessEvent(this.session, event);
  }

  /** Start a turn with the user's prompt; `text` is shown as typed. */
  prompt(text: string, imageCount: number, at: number | undefined): void {
    this.closeTurn();
    this.session = appendUser(
      this.session,
      promptWithImageNote(text, imageCount),
    );
    this.firstPrompt ??= text;
    this.turnOpen = true;
    this.turnStart = at;
    this.turnEnd = at;
  }

  /** The turn was still running at `at`. */
  touch(at: number | undefined): void {
    if (this.turnOpen && at != null) this.turnEnd = at;
  }

  /** Tokens in context after the latest reply. */
  context(used: number | undefined): void {
    if (used !== undefined) this.lastContext = used;
  }

  /** The user stopped the running turn. */
  interrupt(): void {
    if (!this.turnOpen) return;
    this.closeTurn();
    this.notice(INTERRUPTED_BY_USER, "interrupt");
  }

  compacted(): void {
    this.closeTurn();
    this.emit({ type: "status", text: COMPACTED });
  }

  notice(text: string, notice?: "error" | "interrupt"): void {
    this.session = {
      ...this.session,
      blocks: [
        ...this.session.blocks,
        {
          id: crypto.randomUUID(),
          role: "system",
          text,
          ...(notice ? { notice } : {}),
        },
      ],
    };
  }

  /**
   * End the open turn: stamp its prompt with the recorded start and length,
   * seal streams, and cancel tool calls the transcript never answered (the
   * session was interrupted, killed, or is still running in the terminal).
   */
  closeTurn(): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const { turnStart, turnEnd } = this;
    const blocks = this.session.blocks.slice();
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].role !== "user") continue;
      blocks[i] = {
        ...blocks[i],
        ...(turnStart != null ? { startedAt: turnStart } : {}),
        ...(turnStart != null && turnEnd != null
          ? { durationMs: Math.max(0, turnEnd - turnStart) }
          : {}),
      };
      break;
    }
    this.session = cancelOpenTools(stopStreaming({ ...this.session, blocks }));
  }

  /** The finished session, titled by the transcript or its first prompt. */
  finish(harness: HarnessId, title: string | undefined): Session {
    this.closeTurn();
    if (this.lastContext !== undefined) {
      this.emit({ type: "context", used: this.lastContext });
    }
    return {
      ...this.session,
      busy: false,
      title: title
        ? formatSessionTitle(harness, title)
        : titleFromPrompt(this.firstPrompt ?? "", harness),
    };
  }
}

function cancelOpenTools(session: Session): Session {
  let changed = false;
  const blocks = session.blocks.map((block) => {
    const status = block.tool?.status?.toLowerCase() ?? "";
    if (!block.tool || !OPEN_TOOL_STATUSES.has(status)) return block;
    changed = true;
    return {
      ...block,
      streaming: false,
      tool: { ...block.tool, status: "cancelled" },
    };
  });
  return changed ? { ...session, blocks } : session;
}
