import { claudeTranscriptToSession } from "../../../integrations/harness/providers/claude/claudeImport";
import { readClaudeSession } from "../../../platform/tauri/claudeSessions";
import {
  listProjectlessSessions,
  listSessionsByProject,
  upsertSession,
} from "../data/sessionStore";

export type ClaudeSessionImport = {
  /** MonoCode session to open. */
  sessionId: string;
  /** The Claude conversation was already in MonoCode; nothing was written. */
  existing: boolean;
};

/**
 * MonoCode chats already bound to a Claude conversation in `cwd` ("~" for
 * chats without a project), keyed by the Claude session id. MonoCode's own
 * Claude chats land in the same transcript directory, so the picker uses this
 * to open them instead of importing a duplicate.
 */
export async function claudeSessionsInMonoCode(
  cwd: string,
): Promise<Map<string, string>> {
  const saved = await (
    cwd === "~" ? listProjectlessSessions() : listSessionsByProject(cwd)
  ).catch(() => []);
  const bound = new Map<string, string>();
  for (const session of saved) {
    if (session.harness === "claude" && session.providerSessionId) {
      bound.set(session.providerSessionId, session.id);
    }
  }
  return bound;
}

/**
 * Save a Claude Code conversation as a MonoCode chat. The chat keeps the
 * Claude session id, so the next message resumes that conversation.
 * `target` is the chat's MonoCode cwd: "~" for a session started in the home
 * folder, which still runs there and so still finds its transcript.
 */
export async function importClaudeSession(
  cwd: string,
  claudeSessionId: string,
  target: string = cwd,
): Promise<ClaudeSessionImport> {
  const existing = (await claudeSessionsInMonoCode(target)).get(
    claudeSessionId,
  );
  if (existing) return { sessionId: existing, existing: true };

  const records = await readClaudeSession(cwd, claudeSessionId);
  const session = claudeTranscriptToSession({
    records,
    providerSessionId: claudeSessionId,
    cwd: target,
  });
  if (!session.blocks.some((block) => block.role === "user")) {
    throw new Error("That Claude Code session has no messages to import.");
  }
  if (!(await upsertSession(session))) {
    throw new Error("Could not save the imported conversation.");
  }
  return { sessionId: session.id, existing: false };
}

export const CLAUDE_SESSION_IMPORT_EVENT = "monocode:import-claude-session";

/**
 * Ask the app to open the import sheet, scoped to `cwd` when given. The
 * scope is only a starting point; the sheet can show every folder.
 */
export function requestClaudeSessionImport(cwd?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SessionImportRequest>(CLAUDE_SESSION_IMPORT_EVENT, {
      detail: { cwd: cwd || undefined },
    }),
  );
}

/** Which sessions the import sheet opens on: one project's, or every folder's. */
export type SessionImportRequest = { cwd?: string };
