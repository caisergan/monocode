import { describe, expect, it } from "vitest";
import type { RuntimeMode } from "../../../features/sessions/model/session";
import {
  buildTerminalLaunch,
  codexRuntimeModeArgs,
  supportsTerminalSurface,
  type TerminalLaunchInput,
} from "./terminalLaunch";

const UUID = "5b0f4d3e-7c1a-4a0e-9d55-2f1c8a6b9e10";

function claude(overrides: Partial<TerminalLaunchInput> = {}) {
  return buildTerminalLaunch({
    harness: "claude",
    model: "claude:opus-5-5",
    modelSettings: {},
    runtimeMode: "supervised",
    conversation: { kind: "new", id: UUID },
    ...overrides,
  });
}

function codex(overrides: Partial<TerminalLaunchInput> = {}) {
  return buildTerminalLaunch({
    harness: "codex",
    model: "codex:gpt-5.5",
    modelSettings: {},
    runtimeMode: "supervised",
    conversation: { kind: "new" },
    ...overrides,
  });
}

describe("supportsTerminalSurface", () => {
  it("is Claude Code and Codex only", () => {
    expect(supportsTerminalSurface("claude")).toBe(true);
    expect(supportsTerminalSurface("codex")).toBe(true);
    for (const harness of ["cursor", "opencode", "pi", "omp", "grok"] as const) {
      expect(supportsTerminalSurface(harness)).toBe(false);
    }
  });
});

describe("Claude terminal launch", () => {
  it("starts a new conversation under the id MonoCode chose", () => {
    const launch = claude();
    expect(launch.harness).toBe("claude");
    expect(launch.args).toEqual([
      "--model",
      "claude-opus-5-5",
      "--permission-mode",
      "default",
      "--session-id",
      UUID,
    ]);
    expect(launch.args).not.toContain("--resume");
  });

  it("resumes an existing conversation without a new session id", () => {
    const { args } = claude({ conversation: { kind: "resume", id: UUID } });
    expect(args).toEqual(expect.arrayContaining(["--resume", UUID]));
    expect(args).not.toContain("--session-id");
  });

  it("refuses to start a new conversation without an id", () => {
    expect(() => claude({ conversation: { kind: "new" } })).toThrow(
      /needs a session id/,
    );
  });

  it.each<[RuntimeMode, string]>([
    ["supervised", "default"],
    ["auto-accept-edits", "acceptEdits"],
    ["auto", "auto"],
    ["full-access", "bypassPermissions"],
  ])("maps %s to --permission-mode %s", (runtimeMode, permission) => {
    const { args } = claude({ runtimeMode });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(permission);
  });

  it("allows the bypass only in full access", () => {
    expect(claude({ runtimeMode: "full-access" }).args).toContain(
      "--allow-dangerously-skip-permissions",
    );
    expect(claude({ runtimeMode: "auto" }).args).not.toContain(
      "--allow-dangerously-skip-permissions",
    );
  });

  it("passes effort, normalized for the CLI", () => {
    const high = claude({ modelSettings: { effort: "high" } }).args;
    expect(high.slice(high.indexOf("--effort"), high.indexOf("--effort") + 2))
      .toEqual(["--effort", "high"]);
    const ultracode = claude({ modelSettings: { effort: "ultracode" } }).args;
    expect(ultracode[ultracode.indexOf("--effort") + 1]).toBe("xhigh");
    // `ultrathink` is a prompt prefix, not a CLI effort.
    expect(claude({ modelSettings: { effort: "ultrathink" } }).args).not.toContain(
      "--effort",
    );
  });

  it("selects the 1m context window on the model id", () => {
    const { args } = claude({ modelSettings: { context: "1m" } });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5[1m]");
  });

  it("never sends the chat path's settings or stream flags", () => {
    const { args } = claude({ runtimeMode: "full-access" });
    for (const flag of [
      "--settings",
      "--output-format",
      "--input-format",
      "--permission-prompt-tool",
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("carries the provider account through", () => {
    expect(claude({ providerAccountId: "work" }).providerAccountId).toBe("work");
    expect(claude().providerAccountId).toBeNull();
  });
});

describe("Codex terminal launch", () => {
  it("starts a new conversation with no id argument", () => {
    const launch = codex();
    expect(launch.harness).toBe("codex");
    expect(launch.args).not.toContain("resume");
    expect(launch.args).toEqual([
      "-m",
      "gpt-5.5",
      "-a",
      "on-request",
      "-s",
      "read-only",
    ]);
  });

  it("resumes with the subcommand first, then the same flags", () => {
    const { args } = codex({ conversation: { kind: "resume", id: UUID } });
    expect(args.slice(0, 2)).toEqual(["resume", UUID]);
    expect(args).toEqual(expect.arrayContaining(["-m", "gpt-5.5", "-s", "read-only"]));
  });

  it.each<[RuntimeMode, string[]]>([
    ["supervised", ["-a", "on-request", "-s", "read-only"]],
    ["auto-accept-edits", ["-a", "on-request", "-s", "workspace-write"]],
    ["auto", ["--approve-for-me"]],
    ["full-access", ["-a", "on-request", "-s", "danger-full-access"]],
  ])("maps %s to the CLI's sandbox flags", (runtimeMode, flags) => {
    expect(codexRuntimeModeArgs(runtimeMode)).toEqual(flags);
    expect(codex({ runtimeMode }).args.slice(-flags.length)).toEqual(flags);
  });

  it("never asks the CLI for an approval policy it rejects", () => {
    for (const mode of [
      "supervised",
      "auto-accept-edits",
      "auto",
      "full-access",
    ] as const) {
      const args = codexRuntimeModeArgs(mode);
      const value = args[args.indexOf("-a") + 1];
      if (args.includes("-a")) expect(["on-request", "never"]).toContain(value);
    }
  });

  it("passes reasoning effort as a config override", () => {
    const { args } = codex({ modelSettings: { reasoningEffort: "high" } });
    const at = args.indexOf("-c");
    expect(args[at + 1]).toBe('model_reasoning_effort="high"');
  });

  it("omits the model and effort when none is set", () => {
    const { args } = codex({ model: "" });
    expect(args).not.toContain("-m");
    expect(args).not.toContain("-c");
  });
});
