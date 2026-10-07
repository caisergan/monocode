import type { Block, Session } from "../../sessions/model/session";
import { operatorUserPrompt } from "../../sessions/model/operatorCommand";
import { findTurn, isTurnStart } from "./sessionState";

type Exchange = { user: Block; assistants: Block[] };

export type SessionReadOptions = {
  before?: string;
  limit?: number;
  maxChars?: number;
};

function capped(text: string, maxChars: number) {
  const trimmed = text.trim();
  return {
    text: trimmed.slice(0, maxChars),
    truncated: trimmed.length > maxChars,
  };
}

/** Show conversation prose only, with a stable cursor for older exchanges. */
export function sessionConversationPage(
  session: Session,
  options: SessionReadOptions = {},
) {
  const limit = options.limit ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 3)
    throw new Error("limit must be an integer from 1 to 3");
  const maxChars = readLimit(options.maxChars, 1200);

  const exchanges: Exchange[] = [];
  for (const block of session.blocks) {
    if (
      block.role === "user" &&
      (!block.internal || block.monoSessionCompletion) &&
      !block.draft
    ) {
      exchanges.push({ user: block, assistants: [] });
    } else if (
      block.role === "assistant" &&
      !block.internal &&
      block.text.trim() &&
      exchanges.length > 0
    ) {
      exchanges[exchanges.length - 1].assistants.push(block);
    }
  }

  const end = options.before
    ? exchanges.findIndex((exchange) => exchange.user.id === options.before)
    : exchanges.length;
  if (end < 0) throw new Error("before is not a turn ID in this session");
  const start = Math.max(0, end - limit);
  const selected = exchanges.slice(start, end);
  return {
    sessionId: session.id,
    title: session.title,
    busy: !!session.busy,
    hasDraft: session.blocks.some(
      (block) => block.role === "user" && block.draft,
    ),
    turns: selected.map(({ user, assistants }) => ({
      turnId: user.id,
      user: capped(
        user.monoSessionCompletion
          ? user.monoSessionCompletion.sessionCount
            ? `MonoCode: results from ${user.monoSessionCompletion.sessionCount} sessions`
            : `MonoCode: session ${user.monoSessionCompletion.status}: ${user.monoSessionCompletion.title}`
          : operatorUserPrompt(user),
        maxChars,
      ),
      assistant: assistants.length
        ? capped(assistants[assistants.length - 1].text, maxChars)
        : null,
      earlierAssistantMessages: Math.max(0, assistants.length - 1),
    })),
    nextBefore: start > 0 ? selected[0]?.user.id : null,
  };
}

export const MAX_READ_CHARS = 20_000;

function readLimit(value: number | undefined, fallback: number): number {
  const maxChars = value ?? fallback;
  if (
    !Number.isInteger(maxChars) ||
    maxChars < 200 ||
    maxChars > MAX_READ_CHARS
  )
    throw new Error(
      `maxChars must be an integer from 200 to ${MAX_READ_CHARS}`,
    );
  return maxChars;
}

/**
 * One turn's prompt and the agent's final message, including replies that
 * followed steering messages sent while it ran.
 */
export function sessionTurn(
  session: Session,
  turnId: string,
  maxChars?: number,
) {
  const limit = readLimit(maxChars, 8000);
  const turn = findTurn(session, turnId);
  if (!turn) throw new Error("turnId is not a submitted turn in this session");
  const rest = session.blocks.slice(turn.index + 1);
  const end = rest.findIndex(isTurnStart);
  const assistants = (end < 0 ? rest : rest.slice(0, end)).filter(
    (block) =>
      block.role === "assistant" && !block.internal && block.text.trim(),
  );
  return {
    turnId,
    user: capped(operatorUserPrompt(turn.block), limit),
    assistant: assistants.length
      ? capped(assistants[assistants.length - 1].text, limit)
      : null,
    earlierAssistantMessages: Math.max(0, assistants.length - 1),
  };
}
