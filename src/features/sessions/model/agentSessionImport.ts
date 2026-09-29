import { claudeTranscriptToSession } from "../../../integrations/harness/providers/claude/claudeImport";
import {
  readAgentSession,
  type AgentSessionSummary,
  type ImportableHarness,
} from "../../../platform/tauri/agentSessions";
import { HARNESS_TITLE } from "./session";
import {
  listProjectlessSessions,
  listSessionsByProject,
  upsertSession,
} from "../data/sessionStore";

export type AgentSessionImport = {
  /** MonoCode session to open. */
  sessionId: string;
  /** Its MonoCode cwd: the project, or "~" for a chat without one. */
  cwd: string;
  /** The conversation was already in MonoCode; nothing was written. */
  existing: boolean;
};

/** Where an imported conversation lives in MonoCode. */
export type AgentImportPlan = {
  /** The project it joins, or "~" for a chat without one. */
  cwd: string;
  /** The linked worktree it ran in, when `cwd` is that worktree's project. */
  worktreeCwd?: string;
  branch?: string;
  /**
   * An agent only resumes a conversation from the folder it ran in. When that
   * folder is gone the chat keeps the transcript, and its next message starts
   * a new conversation.
   */
  resumable: boolean;
};

type ImportableSession = Pick<
  AgentSessionSummary,
  "harness" | "id" | "cwd" | "folder" | "project" | "gitBranch"
>;

/**
 * A session started in the home folder becomes a chat without a project
 * ("~"), which still runs from home. One started in a linked worktree joins
 * the worktree's project, as a chat MonoCode ran in that worktree would.
 */
export function agentImportPlan(
  session: Omit<ImportableSession, "harness" | "id">,
): AgentImportPlan {
  if (session.folder === "home") return { cwd: "~", resumable: true };
  if (session.folder === "missing") return { cwd: "~", resumable: false };
  if (session.project) {
    return {
      cwd: session.project,
      worktreeCwd: session.cwd,
      ...(session.gitBranch ? { branch: session.gitBranch } : {}),
      resumable: true,
    };
  }
  return { cwd: session.cwd, resumable: true };
}

export function folderGoneNotice(harness: ImportableHarness): string {
  return `The folder this conversation ran in no longer exists, so the next message starts a new ${HARNESS_TITLE[harness]} conversation.`;
}

/**
 * MonoCode chats already holding one of `harness`'s conversations in `cwd`
 * ("~" for chats without a project), keyed by the agent's session id.
 * MonoCode's own chats land in the same transcript directory, so the picker
 * uses this to open them instead of importing a duplicate. A chat imported
 * without a resumable conversation took the agent's session id as its own.
 */
export async function agentSessionsInMonoCode(
  cwd: string,
  harness: ImportableHarness,
): Promise<Map<string, string>> {
  const saved = await (
    cwd === "~" ? listProjectlessSessions() : listSessionsByProject(cwd)
  ).catch(() => []);
  const bound = new Map<string, string>();
  for (const session of saved) {
    if (session.harness !== harness) continue;
    if (session.providerSessionId) {
      bound.set(session.providerSessionId, session.id);
    }
    if (!bound.has(session.id)) bound.set(session.id, session.id);
  }
  return bound;
}

/**
 * Save an agent's terminal conversation as a MonoCode chat. The chat keeps
 * the agent's session id, so the next message resumes that conversation.
 */
export async function importAgentSession(
  summary: ImportableSession,
): Promise<AgentSessionImport> {
  const plan = agentImportPlan(summary);
  const existing = (
    await agentSessionsInMonoCode(plan.cwd, summary.harness)
  ).get(summary.id);
  if (existing) return { sessionId: existing, cwd: plan.cwd, existing: true };

  const records = await readAgentSession(
    summary.harness,
    summary.cwd,
    summary.id,
  );
  let session = claudeTranscriptToSession({
    records,
    cwd: plan.cwd,
    ...(plan.resumable ? { providerSessionId: summary.id } : {}),
    ...(plan.worktreeCwd ? { worktreeCwd: plan.worktreeCwd } : {}),
    ...(plan.branch ? { branch: plan.branch } : {}),
  });
  if (!session.blocks.some((block) => block.role === "user")) {
    throw new Error(
      `That ${HARNESS_TITLE[summary.harness]} session has no messages to import.`,
    );
  }
  if (!plan.resumable) {
    session = {
      ...session,
      id: summary.id,
      blocks: [
        ...session.blocks,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: folderGoneNotice(summary.harness),
        },
      ],
    };
  }
  if (!(await upsertSession(session))) {
    throw new Error("Could not save the imported conversation.");
  }
  return { sessionId: session.id, cwd: plan.cwd, existing: false };
}

export const SESSION_IMPORT_EVENT = "monocode:import-session";

/**
 * Ask the app to open the import sheet, scoped to `cwd` when given. The
 * scope is only a starting point; the sheet can show every folder.
 */
export function requestSessionImport(cwd?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SessionImportRequest>(SESSION_IMPORT_EVENT, {
      detail: { cwd: cwd || undefined },
    }),
  );
}

/** Which sessions the import sheet opens on: one project's, or every folder's. */
export type SessionImportRequest = { cwd?: string };
