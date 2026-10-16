import type { BuiltinSkill } from "../../skills/model/skills";

export const QUEUE_COMMAND: BuiltinSkill = {
  kind: "builtin",
  name: "queue",
  invocation: "queue",
  description: "Send this after the current turn finishes.",
  scope: "builtin",
  source: "monocode",
};

/** Consume `/queue` when it is used as the leading composer command. */
export function consumeQueueCommand(text: string): {
  text: string;
  matched: boolean;
} {
  const match = text.match(/^\s*\/queue(?=\s|$)\s*/i);
  if (!match) return { text, matched: false };
  return { text: text.slice(match[0].length), matched: true };
}
