import { pendingInputForSession } from "../../notifications/model/approvalToast";
import type { Session } from "../../sessions/model/session";
import { sessionTurn } from "./sessionConversation";
import {
  appSessionState,
  turnForRequest,
  turnState,
  type AppSessionState,
} from "./sessionState";

/** A turn the operator asked to hear about once it settles. */
export type OperatorWatch = {
  operatorId: string;
  sessionId: string;
  /** Request ID carried by the watched turn's user block. */
  appRequestId: string;
  /** How the operator addresses the session: its name, or its ID. */
  label: string;
  /** Approval or question already reported, so it is announced only once. */
  announcedRequestId?: number;
};

export type OperatorNotice = {
  watch: OperatorWatch;
  state: AppSessionState | "closed";
  turnId?: string;
  session?: Session;
};

/** Most automatic updates an operator receives between two user messages. */
export const MAX_OPERATOR_WAKES = 20;
const MAX_WATCHES_PER_OPERATOR = 32;

export const sameWatch = (a: OperatorWatch, b: OperatorWatch) =>
  a.operatorId === b.operatorId &&
  a.sessionId === b.sessionId &&
  a.appRequestId === b.appRequestId;

/** Register a watch once; an operator's oldest watches give way to new ones. */
export function addOperatorWatch(
  watches: OperatorWatch[],
  watch: OperatorWatch,
): OperatorWatch[] {
  if (watches.some((entry) => sameWatch(entry, watch))) return watches;
  const next = [...watches, watch];
  const mine = next.filter((entry) => entry.operatorId === watch.operatorId);
  if (mine.length <= MAX_WATCHES_PER_OPERATOR) return next;
  const dropped = mine[0];
  return next.filter((entry) => entry !== dropped);
}

/**
 * Split watches into notices that are ready now and watches to keep. A
 * blocked turn is reported once per request and stays watched until it ends.
 */
export function collectOperatorNotices(
  watches: OperatorWatch[],
  session: (id: string) => Session | undefined,
): { notices: OperatorNotice[]; remaining: OperatorWatch[] } {
  const notices: OperatorNotice[] = [];
  const remaining: OperatorWatch[] = [];
  for (const watch of watches) {
    const target = session(watch.sessionId);
    if (!target) {
      notices.push({ watch, state: "closed" });
      continue;
    }
    const turn = turnForRequest(target, watch.appRequestId);
    if (!turn) {
      remaining.push(watch);
      continue;
    }
    const state = turnState(target, turn.id);
    if (state === "working") {
      remaining.push(watch);
      continue;
    }
    if (state === "blocked") {
      const requestId = pendingInputForSession(target)?.requestId;
      if (requestId === watch.announcedRequestId) {
        remaining.push(watch);
        continue;
      }
      const announced = { ...watch, announcedRequestId: requestId };
      remaining.push(announced);
      notices.push({
        watch: announced,
        state,
        turnId: turn.id,
        session: target,
      });
      continue;
    }
    notices.push({ watch, state, turnId: turn.id, session: target });
  }
  return { notices, remaining };
}

/**
 * The operator saw this session's state through a wait, so it needs no wake
 * for it: settled turns stop being watched and a reported block is announced.
 */
export function markOperatorWatchesSeen(
  watches: OperatorWatch[],
  operatorId: string,
  session: Session,
): OperatorWatch[] {
  return watches.flatMap((watch) => {
    if (watch.operatorId !== operatorId || watch.sessionId !== session.id)
      return [watch];
    const turn = turnForRequest(session, watch.appRequestId);
    if (!turn) return [watch];
    const state = turnState(session, turn.id);
    if (state === "working") return [watch];
    if (state === "blocked")
      return [
        {
          ...watch,
          announcedRequestId: pendingInputForSession(session)?.requestId,
        },
      ];
    return [];
  });
}

const RESULT_CHARS = 3000;

/** The turn MonoCode writes to wake an idle operator with its updates. */
export function operatorWakePrompt(notices: OperatorNotice[]): string {
  const lines = notices.map(({ watch, state, turnId, session }) => {
    const who = `${watch.label} (${watch.sessionId})`;
    if (state === "closed" || !session)
      return `- ${who} was closed or deleted before its turn finished.`;
    if (state === "blocked") {
      const pending = pendingInputForSession(session);
      return `- ${who} is blocked on ${pending?.kind === "question" ? "a question" : "an approval"} (requestId ${pending?.requestId}): ${pending?.label ?? "unknown"}${pending?.detail ? `\n  ${pending.detail.slice(0, 1000)}` : ""}${pending?.questions ? `\n  ${JSON.stringify(pending.questions)}` : ""}\n  Decide it with sessions.respond or sessions.answer, or ask the user when the call is theirs.`;
    }
    if (state === "usageLimited")
      return `- ${who} stopped at a provider usage limit${session.usageLimit?.resetsAt ? ` until ${new Date(session.usageLimit.resetsAt).toISOString()}` : ""}.`;
    const turn = turnId ? sessionTurn(session, turnId, RESULT_CHARS) : null;
    const reply = turn?.assistant
      ? `${turn.assistant.text}${turn.assistant.truncated ? `\n  [truncated; read turnId ${turnId} with sessions.read for the full message]` : ""}`
      : "(no reply text)";
    return `- ${who} finished turn ${turnId} (${appSessionState(session)} now). Final message:\n${reply}`;
  });
  return `MonoCode update on sessions you asked to be notified about:\n\n${lines.join("\n\n")}\n\nContinue the user's request with these results. Use the app CLI to read more, send follow-ups or decide blocked requests.`;
}
