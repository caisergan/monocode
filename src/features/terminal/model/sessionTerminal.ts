import { ask } from "@tauri-apps/plugin-dialog";
import {
  buildTerminalLaunch,
  supportsTerminalSurface,
} from "../../../integrations/harness/core/terminalLaunch";
import { statAgentSession } from "../../../platform/tauri/agentSessions";
import {
  getPtyStatus,
  killPty,
  type PtyLaunch,
} from "../../../platform/tauri/pty";
import {
  sessionDisplayTitle,
  sessionWorkCwd,
  type Session,
} from "../../sessions/model/session";

/**
 * A session's terminal is one PTY named after the session, so a view that
 * mounts again finds the same process.
 */
export function sessionPtyId(sessionId: string): string {
  return `session:${sessionId}`;
}

type LaunchSession = Pick<
  Session,
  | "id"
  | "harness"
  | "model"
  | "modelSettings"
  | "runtimeMode"
  | "cwd"
  | "worktreeCwd"
  | "providerSessionId"
  | "providerAccountId"
>;

/**
 * The CLI command line for a session that has to be started. A conversation
 * that the CLI has already saved is resumed; one that has not is created.
 *
 * Claude takes an id for a new conversation, so MonoCode picks it and
 * `bindProviderSession` stores it before anything spawns. Without that, a
 * restart before the first prompt would resume an id the CLI never saved.
 * Codex chooses its own id, which is found afterwards, so a session with no
 * `providerSessionId` starts a bare `codex`.
 */
export async function sessionTerminalLaunch(
  session: LaunchSession,
  bindProviderSession: (sessionId: string, providerSessionId: string) => void,
): Promise<PtyLaunch> {
  const { harness } = session;
  if (!supportsTerminalSurface(harness)) {
    throw new Error(`${harness} cannot run in a terminal.`);
  }
  const base = {
    harness,
    model: session.model,
    modelSettings: session.modelSettings,
    runtimeMode: session.runtimeMode,
    providerAccountId: session.providerAccountId,
  };
  const known = session.providerSessionId;
  const saved = known
    ? await statAgentSession(
        harness,
        sessionWorkCwd(session),
        known,
        session.providerAccountId,
      ).catch(() => null)
    : null;
  if (harness === "codex") {
    // Codex resumes only a conversation it has saved, and gives a new one an
    // id of its own, found afterwards.
    return buildTerminalLaunch({
      ...base,
      conversation: known && saved ? { kind: "resume", id: known } : { kind: "new" },
    });
  }
  if (!known) {
    const id = crypto.randomUUID();
    bindProviderSession(session.id, id);
    return buildTerminalLaunch({ ...base, conversation: { kind: "new", id } });
  }
  return buildTerminalLaunch({
    ...base,
    conversation: saved
      ? { kind: "resume", id: known }
      : { kind: "new", id: known },
  });
}

/** Whether the session's PTY is running right now. */
export async function isSessionTerminalAlive(
  sessionId: string,
): Promise<boolean> {
  return getPtyStatus(sessionPtyId(sessionId)).then(
    () => true,
    () => false,
  );
}

export function killSessionTerminal(sessionId: string): Promise<void> {
  return killPty(sessionPtyId(sessionId));
}

/**
 * Confirm closing sessions whose agent CLI is still running. The shell check
 * used for ordinary terminals does not apply: the agent is the PTY's own
 * process, never a foreground job under a shell, and nothing here can tell an
 * idle agent from a working one.
 */
export async function confirmCloseSessionTerminals(
  sessions: Array<Pick<Session, "id" | "title" | "harness" | "surface">>,
): Promise<boolean> {
  const terminal = sessions.filter((session) => session.surface === "terminal");
  const alive: typeof terminal = [];
  for (const session of terminal) {
    if (await isSessionTerminalAlive(session.id)) alive.push(session);
  }
  if (alive.length === 0) return true;
  const name = (session: (typeof alive)[number]) =>
    `"${sessionDisplayTitle(session.title, session.harness)}"`;
  const message =
    alive.length === 1
      ? `The agent is still running in ${name(alive[0])}. Close it anyway?`
      : `The agent is still running in:\n${alive
          .map((session) => `• ${name(session)}`)
          .join("\n")}\n\nClose them anyway?`;
  return ask(message, { title: "MonoCode", kind: "warning" });
}
