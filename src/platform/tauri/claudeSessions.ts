import { invoke } from "@tauri-apps/api/core";

/** A Claude Code transcript found under `~/.claude/projects` for a project. */
export type ClaudeSessionSummary = {
  id: string;
  cwd: string;
  /** Claude's generated or user-set title, when the transcript has one. */
  title?: string | null;
  firstPrompt?: string | null;
  promptCount: number;
  gitBranch?: string | null;
  updatedAt: number;
  sizeBytes: number;
};

export function listClaudeSessions(
  cwd: string,
): Promise<ClaudeSessionSummary[]> {
  return invoke<ClaudeSessionSummary[]>("claude_list_sessions", { cwd });
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
