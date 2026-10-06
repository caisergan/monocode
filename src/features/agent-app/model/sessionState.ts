import { pendingApprovalForSession } from "../../notifications/model/approvalToast";
import type { Block, Session } from "../../sessions/model/session";

/**
 * What another agent needs to know about a session to drive it: whether it
 * can take a prompt, is still working, or is waiting on a decision.
 */
export type AppSessionState = "idle" | "working" | "blocked" | "usageLimited";

export const APP_SESSION_STATES: readonly AppSessionState[] = [
  "idle",
  "working",
  "blocked",
  "usageLimited",
];

/** States in which a turn has stopped making progress on its own. */
export const SETTLED_STATES: readonly AppSessionState[] = [
  "idle",
  "blocked",
  "usageLimited",
];

export function appSessionState(session: Session): AppSessionState {
  if (!session.worktreeRemoved && pendingApprovalForSession(session))
    return "blocked";
  if (session.busy) return "working";
  // Queued follow-ups dispatch on their own unless the user paused them.
  if (session.queuedMessages?.length && session.queueStatus !== "paused")
    return "working";
  if (session.usageLimit) return "usageLimited";
  return "idle";
}

/** A user block that began a turn; steering messages join the current one. */
export function isTurnStart(block: Block): boolean {
  return block.role === "user" && !block.draft && block.startedAt != null;
}

export function latestTurnId(session: Session): string | undefined {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    if (isTurnStart(session.blocks[i])) return session.blocks[i].id;
  }
  return undefined;
}

export function findTurn(
  session: Session,
  turnId: string,
): { index: number; block: Block } | undefined {
  // Any submitted user message is addressable, including older sessions
  // saved before turns recorded their start time.
  const index = session.blocks.findIndex(
    (block) => block.id === turnId && block.role === "user" && !block.draft,
  );
  return index < 0 ? undefined : { index, block: session.blocks[index] };
}

/** The turn a CLI request submitted, found by the request ID it carried. */
export function turnForRequest(
  session: Session,
  appRequestId: string,
): Block | undefined {
  return session.blocks.find(
    (block) =>
      block.appRequestId === appRequestId &&
      block.role === "user" &&
      !block.draft,
  );
}

/**
 * State of one turn rather than the session: a turn is finished once a later
 * turn has started, even while that later turn is still running.
 */
export function turnState(session: Session, turnId: string): AppSessionState {
  const turn = findTurn(session, turnId);
  if (!turn) throw new Error("turnId is not a submitted turn in this session");
  if (session.blocks.slice(turn.index + 1).some(isTurnStart)) return "idle";
  const state = appSessionState(session);
  // Queued follow-ups belong to later turns.
  return state === "working" && !session.busy ? "idle" : state;
}
