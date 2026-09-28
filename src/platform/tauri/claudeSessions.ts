import { invoke } from "@tauri-apps/api/core";

/** Whether a session's folder can hold a MonoCode chat. */
export type ClaudeSessionFolder = "ok" | "home" | "missing";

/** A Claude Code transcript found under `~/.claude/projects`. */
export type ClaudeSessionSummary = {
  id: string;
  cwd: string;
  /** Claude's generated or user-set title, when the transcript has one. */
  title?: string | null;
  firstPrompt: string;
  lastPrompt: string;
  gitBranch?: string | null;
  updatedAt: number;
  sizeBytes: number;
  folder: ClaudeSessionFolder;
  /** The MonoCode session already bound to this conversation. */
  monocodeSessionId?: string | null;
};

export type ClaudeSessionListing = {
  sessions: ClaudeSessionSummary[];
  /** Conversations left out because MonoCode already has them. */
  importedCount: number;
  /** Older sessions exist past `limit`. */
  hasMore: boolean;
};

export type ClaudeSessionQuery = {
  /** Only sessions started in this folder; every folder when omitted. */
  cwd?: string;
  /** Case-insensitive match on the title, prompts and folder name. */
  query?: string;
  limit?: number;
  /** Also list conversations MonoCode already has. */
  includeImported?: boolean;
};

/** Newest first. Searching looks through the 500 most recent sessions. */
export function listClaudeSessions(
  request: ClaudeSessionQuery,
): Promise<ClaudeSessionListing> {
  return invoke<ClaudeSessionListing>("claude_list_sessions", { request });
}

/** Transcript records with heavy payloads (images, raw tool results) removed. */
export function readClaudeSession(
  cwd: string,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>("claude_read_session", {
    cwd,
    sessionId,
  });
}
