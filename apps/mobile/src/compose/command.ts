// What the composer sends (11 §11.17): the slash picker's commands, the mode
// a leading /plan or /draft selects, and the command a Send becomes. Pure.

import type { HostCommand, RemoteAttachment } from "@monocode/core/session";

export type ComposerMode = "default" | "plan" | "draft";

export type SlashCommand = { name: "/plan" | "/draft" | "/compact"; description: string };

/** Verbatim from the desktop; /plan and /draft need their capabilities. */
export function slashCommands(capabilities: { plan: boolean; draft: boolean }): SlashCommand[] {
  return [
    ...(capabilities.plan ? [{ name: "/plan" as const, description: "Create a reviewable implementation plan before changing files." }] : []),
    ...(capabilities.draft ? [{ name: "/draft" as const, description: "Save this message without starting the agent." }] : []),
    { name: "/compact", description: "Summarize older conversation context to free space." },
  ];
}

/** The picker opens while the input is a bare `/word` at the start. */
export function slashMatches(text: string, commands: readonly SlashCommand[]): SlashCommand[] | undefined {
  const match = /^\/(\S*)$/.exec(text);
  if (!match) return undefined;
  const query = match[1].toLowerCase();
  return commands.filter((command) => command.name.slice(1).startsWith(query));
}

/** A leading /plan or /draft switches the mode; the rest is the message. */
export function leadingMode(text: string): { mode?: "plan" | "draft"; rest: string } {
  const match = /^\/(plan|draft)(?:\s+|$)/.exec(text);
  if (!match) return { rest: text };
  return { mode: match[1] as "plan" | "draft", rest: text.slice(match[0].length) };
}

/** The desktop's Build prompt (`plan.ts`), sent with `intent: "build"`. */
export function buildPlanPrompt(plan: string): string {
  return [
    "The user reviewed and explicitly approved the following implementation plan. Implement it now, using this exact edited version as the source of truth.",
    "",
    "<approved_plan>",
    plan.trim(),
    "</approved_plan>",
  ].join("\n");
}

export type ComposeInput = {
  commandId: string;
  sessionId: string;
  text: string;
  attachments: readonly RemoteAttachment[];
  mode: ComposerMode;
  /** A turn is running, or messages already wait: Send queues. */
  queue: boolean;
  running: boolean;
  capabilities: { queue: boolean };
};

export type Composed = { command: HostCommand } | { error: string };

/** The command for one Send, or why there is none. */
export function composeCommand(input: ComposeInput): Composed {
  const { commandId, sessionId, attachments } = input;
  const leading = leadingMode(input.text);
  const mode = leading.mode ?? input.mode;
  const text = leading.rest.trim();
  const files = attachments.length ? { attachments: [...attachments] } : {};
  if (text === "/compact" && !attachments.length) {
    if (input.running) return { error: "Wait for the agent to finish, or stop it." };
    return { command: { type: "compact", commandId, sessionId } };
  }
  if (!text && !attachments.length) return { error: "Write a message first." };
  if (mode === "draft") {
    if (input.running) return { error: "Wait for the agent to finish, or stop it." };
    return { command: { type: "draft", commandId, sessionId, text, ...files } };
  }
  const intent = mode === "plan" ? { intent: "plan" as const } : {};
  if (input.queue) {
    if (!input.capabilities.queue) return { error: "Wait for the agent to finish, or stop it." };
    return { command: { type: "queue", commandId, sessionId, text, ...files, ...intent } };
  }
  return { command: { type: "send", commandId, sessionId, text, ...files, ...intent } };
}
