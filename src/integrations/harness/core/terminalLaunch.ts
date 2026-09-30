import type { PtyLaunch } from "../../../platform/tauri/pty";
import { nativeModelId } from "../../../features/sessions/model/models";
import type {
  HarnessId,
  RuntimeMode,
} from "../../../features/sessions/model/session";
import {
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  runtimeModeToPermission,
} from "../providers/claude/claudeProtocol";

/** Providers whose real CLI a session can run in. */
export type TerminalHarness = PtyLaunch["harness"];

export function supportsTerminalSurface(
  harness: HarnessId,
): harness is TerminalHarness {
  return harness === "claude" || harness === "codex";
}

/**
 * Whether the provider conversation already exists on disk. A new Claude
 * conversation is created with a `--session-id` MonoCode picked; once its
 * transcript exists that id can only be resumed. Codex has no id to hand in,
 * so a new conversation is simply a bare `codex`.
 */
export type TerminalConversation =
  | { kind: "new"; id?: string }
  | { kind: "resume"; id: string };

export type TerminalLaunchInput = {
  harness: TerminalHarness;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  conversation: TerminalConversation;
  providerAccountId?: string | null;
};

/**
 * Arguments for the agent's own CLI, mirroring what the chat path sends over
 * its protocol. Not passed: the chat path's `--settings` JSON, which carries
 * MonoCode's hooks and approval plumbing. In a terminal the CLI asks for
 * approvals itself.
 */
export function buildTerminalLaunch(input: TerminalLaunchInput): PtyLaunch {
  const args =
    input.harness === "claude"
      ? claudeTerminalArgs(input)
      : codexTerminalArgs(input);
  return {
    harness: input.harness,
    args,
    providerAccountId: input.providerAccountId ?? null,
  };
}

function claudeTerminalArgs(input: TerminalLaunchInput): string[] {
  const native = nativeModelId(input.model);
  const args: string[] = [];
  const model = input.model
    ? resolveClaudeApiModelId(native, input.modelSettings.context)
    : undefined;
  if (model) args.push("--model", model);
  const effort = normalizeClaudeCliEffort(input.modelSettings.effort, native);
  if (effort) args.push("--effort", effort);
  const permission = runtimeModeToPermission(input.runtimeMode);
  args.push("--permission-mode", permission);
  if (permission === "bypassPermissions") {
    args.push("--allow-dangerously-skip-permissions");
  }
  const { conversation } = input;
  if (conversation.kind === "resume") {
    args.push("--resume", conversation.id);
  } else {
    if (!conversation.id) {
      throw new Error("A new Claude terminal conversation needs a session id.");
    }
    args.push("--session-id", conversation.id);
  }
  return args;
}

/**
 * `codex` and `codex resume` take the same flags. The CLI's `-a` accepts only
 * `on-request` and `never`, so Supervised is a read-only sandbox that asks
 * before anything more, rather than the chat path's `untrusted` policy.
 */
export function codexRuntimeModeArgs(mode: RuntimeMode): string[] {
  switch (mode) {
    case "supervised":
      return ["-a", "on-request", "-s", "read-only"];
    case "auto-accept-edits":
      return ["-a", "on-request", "-s", "workspace-write"];
    case "auto":
      // Routes approvals through automatic review inside workspace-write,
      // like the chat path's `auto_review` reviewer.
      return ["--approve-for-me"];
    case "full-access":
      return ["-a", "on-request", "-s", "danger-full-access"];
  }
}

function codexTerminalArgs(input: TerminalLaunchInput): string[] {
  const args: string[] = [];
  if (input.conversation.kind === "resume") {
    args.push("resume", input.conversation.id);
  }
  if (input.model) args.push("-m", nativeModelId(input.model));
  const effort = input.modelSettings.reasoningEffort?.trim();
  if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  args.push(...codexRuntimeModeArgs(input.runtimeMode));
  return args;
}
