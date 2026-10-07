import { pinnedProviderAccountId } from "../../providers/model/providerAccounts";
import { appendReadyHandoff, buildDeterministicHandoff } from "./handoff";
import { HARNESS_TITLE, isTerminalSession, type Session } from "./session";

/** What picking another provider account does to the open conversation. */
export type ProviderAccountSwitchPlan =
  /** Nothing to carry over: the conversation just takes the new account. */
  | { kind: "assign" }
  /** The conversation stays put and a new one opens on the new account. */
  | { kind: "new" }
  /** Copy the provider transcript to the new account and resume it there. */
  | { kind: "move"; providerSessionId: string; fromAccountId?: string };

export function planProviderAccountSwitch(
  session: Session,
  continueOnSwitch: boolean,
): ProviderAccountSwitchPlan {
  if (session.blocks.length === 0 && !session.busy) return { kind: "assign" };
  // A running turn or the agent's own terminal is writing the transcript.
  if (!continueOnSwitch || session.busy || isTerminalSession(session)) {
    return { kind: "new" };
  }
  // No provider thread yet, so the agent holds no history to lose.
  if (!session.providerSessionId) return { kind: "assign" };
  return {
    kind: "move",
    providerSessionId: session.providerSessionId,
    fromAccountId: pinnedProviderAccountId(session),
  };
}

/**
 * The conversation on its new account. When its transcript could not be
 * copied (the old account was removed, say), the new account starts a fresh
 * provider thread seeded with a recap of this one.
 */
export function sessionOnProviderAccount(
  session: Session,
  accountId: string,
  transcriptCopied: boolean,
): Session {
  if (transcriptCopied) return { ...session, providerAccountId: accountId };
  const recap = appendReadyHandoff(
    session,
    session.harness,
    session.harness,
    `This conversation moved to another ${HARNESS_TITLE[session.harness]} account, which could not open its earlier history. Continue from this recap and recheck the files before making changes.\n\n${buildDeterministicHandoff(session)}`,
  );
  return {
    ...recap,
    providerAccountId: accountId,
    providerSessionId: undefined,
    context: undefined,
  };
}
