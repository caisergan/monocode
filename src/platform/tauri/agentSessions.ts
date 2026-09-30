import { invoke } from "@tauri-apps/api/core";

/** Agents whose terminal sessions MonoCode can import. */
export const IMPORTABLE_HARNESSES = ["claude", "pi", "omp"] as const;

export type ImportableHarness = (typeof IMPORTABLE_HARNESSES)[number];

/** Whether a session's folder can hold a MonoCode chat. */
export type AgentSessionFolder = "ok" | "home" | "missing";

/** A session an agent CLI saved on disk (Claude Code, Pi, omp). */
export type AgentSessionSummary = {
  harness: ImportableHarness;
  id: string;
  cwd: string;
  /** The agent's generated or user-set title, when the transcript has one. */
  title?: string | null;
  firstPrompt: string;
  lastPrompt: string;
  gitBranch?: string | null;
  updatedAt: number;
  sizeBytes: number;
  folder: AgentSessionFolder;
  /** The main checkout when `cwd` is one of its linked git worktrees. */
  project?: string | null;
  /** The MonoCode session already bound to this conversation. */
  monocodeSessionId?: string | null;
};

export type AgentSessionListing = {
  sessions: AgentSessionSummary[];
  /**
   * Conversations left out because MonoCode already has them, across every
   * session in scope. The search query does not narrow it.
   */
  importedCount: number;
  /** Older sessions exist past `limit`. */
  hasMore: boolean;
};

export type AgentSessionQuery = {
  /** Only these agents; every importable agent when omitted. */
  harnesses?: ImportableHarness[];
  /**
   * Only sessions started in this folder or its worktrees; every folder when
   * omitted.
   */
  cwd?: string;
  /** Case-insensitive match on the title, prompts, folder name and session id. */
  query?: string;
  limit?: number;
  /** Also list conversations MonoCode already has. */
  includeImported?: boolean;
  /** A newer listing with the same owner makes this one stop early. */
  owner?: string;
  /** Only sessions changed at or after this time (ms since the epoch). */
  since?: number;
  /**
   * Only sessions that import as a chat without a project: started in the
   * home folder, or in one that no longer exists. Ignored with `cwd`.
   */
  projectless?: boolean;
};

/** Newest first. Searching looks through the 500 most recent sessions. */
export function listAgentSessions(
  request: AgentSessionQuery,
): Promise<AgentSessionListing> {
  return invoke<AgentSessionListing>("agent_list_sessions", { request });
}

/** Transcript records with heavy payloads (images, raw tool output) removed. */
export function readAgentSession(
  harness: ImportableHarness,
  cwd: string,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>("agent_read_session", {
    harness,
    cwd,
    sessionId,
  });
}
