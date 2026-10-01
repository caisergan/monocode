import { supportsTerminalSurface } from "../../../integrations/harness/core/terminalLaunch";
import { isRemoteProjectPath } from "../../projects/model/recents";
import { isPreparingHandoff } from "./handoff";
import {
  isTerminalSession,
  type Session,
  type TerminalSync,
} from "./session";

/**
 * Why a session cannot move to the terminal, or null when it can. A session
 * that is busy is not refused: the caller offers to stop it.
 */
export function terminalRefusal(session: Session): string | null {
  if (isTerminalSession(session)) return "This session is already in the terminal.";
  if (!supportsTerminalSurface(session.harness)) {
    return "Only Claude Code and Codex sessions can run in a terminal.";
  }
  if (isRemoteProjectPath(session.cwd)) {
    return "Sessions on another machine cannot run in a terminal yet.";
  }
  if (session.inboxAsk || session.orchestrationLeadId) {
    return "This conversation cannot run in a terminal.";
  }
  if (session.worktreeRemoved) {
    return "Select a working copy before opening this session in the terminal.";
  }
  if (session.pendingSwitch || isPreparingHandoff(session)) {
    return "Finish the handoff before opening this session in the terminal.";
  }
  return null;
}

/**
 * The session as the terminal takes it over. Blocks it already has stay as
 * they are; `sync` says how much of the CLI's transcript they account for.
 */
export function withTerminalSurface(
  session: Session,
  sync: TerminalSync,
): Session {
  return {
    ...session,
    surface: "terminal",
    terminalSync: sync,
    busy: false,
    queuedMessages: undefined,
    queueStatus: undefined,
    editingQueuedMessageId: undefined,
    usageLimit: undefined,
  };
}

/** The session back in MonoCode's own chat. */
export function withChatSurface(session: Session): Session {
  const { surface: _surface, terminalSync: _terminalSync, ...rest } = session;
  return rest;
}
