import { leafIds, type WorkspaceTab } from "../../workspace/model/layout";
import type { Block, Session } from "../../sessions/model/session";
import { toolCallLabel } from "../../sessions/model/transcriptActivity";

export type PendingApprovalNotice = {
  sessionId: string;
  requestId: number;
  label: string;
  kind: "approval" | "question";
  block?: Block;
};

/** Latest undecided approval or clarifying question in a session, if any. */
export function pendingApprovalForSession(
  session: Session,
): PendingApprovalNotice | null {
  if (session.pendingQuestion) {
    return {
      sessionId: session.id,
      requestId: session.pendingQuestion.requestId,
      label:
        session.pendingQuestion.title ||
        session.pendingQuestion.questions[0]?.prompt ||
        "Question",
      kind: "question",
    };
  }
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (!block.approval || block.approval.decided) continue;
    return {
      sessionId: session.id,
      requestId: block.approval.requestId,
      label: toolCallLabel(block, session.cwd),
      kind: "approval",
      block,
    };
  }
  return null;
}

export type PendingInput = {
  kind: "approval" | "question";
  requestId: number;
  label: string;
  detail?: string;
  questions?: NonNullable<Session["pendingQuestion"]>["questions"];
};

/**
 * What an agent driving this session needs in order to decide for it: the
 * approval's command or the question and its options.
 */
export function pendingInputForSession(
  session: Session,
): PendingInput | undefined {
  const pending = pendingApprovalForSession(session);
  if (!pending) return undefined;
  return {
    kind: pending.kind,
    requestId: pending.requestId,
    label: pending.label,
    detail:
      pending.kind === "approval"
        ? (pending.block?.tool?.detail?.trim() ?? pending.block?.text)
        : undefined,
    questions: session.pendingQuestion?.questions,
  };
}

/** True when the conversation pane for this session is focused and active. */
export function isSessionConversationFocused(
  sessionId: string,
  activeTabId: string,
  tabs: WorkspaceTab[],
  composerFocused: boolean,
): boolean {
  const tab = tabs.find((entry) => entry.id === activeTabId);
  if (!tab) return false;
  if (!leafIds(tab.layout).includes(sessionId)) return false;
  if (tab.focusedId !== sessionId) return false;
  return composerFocused;
}

export function hiddenApprovalNotices(
  sessions: Session[],
  activeTabId: string,
  tabs: WorkspaceTab[],
  composerFocused: boolean,
): Array<PendingApprovalNotice & { session: Session }> {
  const notices: Array<PendingApprovalNotice & { session: Session }> = [];
  for (const session of sessions) {
    if (session.inboxAsk) continue;
    // An orchestrated worker answers to its lead, never to the user directly.
    if (session.orchestrationLeadId) continue;
    const pending = pendingApprovalForSession(session);
    if (!pending) continue;
    if (
      isSessionConversationFocused(
        session.id,
        activeTabId,
        tabs,
        composerFocused,
      )
    ) {
      continue;
    }
    notices.push({ ...pending, session });
  }
  return notices;
}
