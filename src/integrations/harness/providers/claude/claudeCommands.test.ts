import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: Array<{ id: string; args: string[]; cwd: string }> = [];
const killed: string[] = [];
const lines = new Map<string, (line: string) => void>();
const exits = new Map<string, (code?: number | null) => void>();
const releaseBridge = vi.fn();
let spawnError: Error | null = null;

vi.mock("../../core/child", () => ({
  acquireHarnessBridge: async () => releaseBridge,
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (
    id: string,
    _path: string,
    args: string[],
    cwd: string,
  ) => {
    if (spawnError) throw spawnError;
    spawned.push({ id, args, cwd });
  },
  killChild: async (id: string) => {
    killed.push(id);
  },
  unwatchChild: (id: string) => {
    lines.delete(id);
    exits.delete(id);
  },
  watchChild: (
    id: string,
    line: (l: string) => void,
    exit: (code?: number | null) => void,
  ) => {
    lines.set(id, line);
    exits.set(id, exit);
  },
  writeChild: async () => undefined,
}));

const { claudeCommandProvider, noteClaudeCommands, __claudeCommandsTestReset } =
  await import("./claudeCommands");

const advisor = {
  name: "advisor",
  invocation: "advisor",
  source: "claude" as const,
  description: "Consult a stronger model",
  origin: "built-in",
  inputHint: "[opus|off]",
};

/** The probe's `initialize` reply. */
function reply(commands: unknown[]) {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "monocode_commands",
      response: { commands },
    },
  });
}

const spawnedProbe = () =>
  vi.waitFor(() => {
    expect(spawned).toHaveLength(1);
    return spawned[0]!;
  });

beforeEach(() => {
  vi.useFakeTimers();
  spawned.length = 0;
  killed.length = 0;
  lines.clear();
  exits.clear();
  releaseBridge.mockClear();
  spawnError = null;
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  __claudeCommandsTestReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("claude command discovery", () => {
  it("asks a throwaway process once per folder and keeps the answer", async () => {
    const first = claudeCommandProvider.discover({ cwd: "/repo/" });
    const second = claudeCommandProvider.discover({ cwd: "/repo" });
    const probe = await spawnedProbe();

    expect(probe.cwd).toBe("/repo");
    expect(probe.args).toEqual(
      expect.arrayContaining([
        "--no-session-persistence",
        "--strict-mcp-config",
      ]),
    );
    expect(probe.args).not.toContain("--include-partial-messages");
    expect(probe.args[probe.args.indexOf("--settings") + 1]).toBe(
      JSON.stringify({ disableAllHooks: true }),
    );

    lines.get(probe.id)!(
      reply([
        {
          name: "advisor",
          description: "Consult a stronger model",
          argumentHint: "[opus|off]",
          builtin: true,
        },
      ]),
    );
    await expect(first).resolves.toEqual([advisor]);
    await expect(second).resolves.toEqual([advisor]);
    expect(killed).toEqual([probe.id]);
    expect(releaseBridge).toHaveBeenCalledOnce();

    await expect(
      claudeCommandProvider.discover({ cwd: "/repo" }),
    ).resolves.toEqual([advisor]);
    expect(spawned).toHaveLength(1);
  });

  it("lists nothing when the probe fails and waits before trying again", async () => {
    spawnError = new Error("claude is not installed");
    await expect(
      claudeCommandProvider.discover({ cwd: "/repo" }),
    ).resolves.toEqual([]);
    expect(releaseBridge).toHaveBeenCalledOnce();

    spawnError = null;
    await expect(
      claudeCommandProvider.discover({ cwd: "/repo" }),
    ).resolves.toEqual([]);
    expect(spawned).toHaveLength(0);

    vi.advanceTimersByTime(30_001);
    const retry = claudeCommandProvider.discover({ cwd: "/repo" });
    const probe = await spawnedProbe();
    lines.get(probe.id)!(reply([{ name: "advisor" }]));
    await expect(retry).resolves.toMatchObject([{ name: "advisor" }]);
  });

  it("does not wait on a Claude Code too old to list its commands", async () => {
    const pending = claudeCommandProvider.discover({ cwd: "/repo" });
    const probe = await spawnedProbe();
    lines.get(probe.id)!(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "monocode_commands" },
      }),
    );

    await expect(pending).resolves.toEqual([]);
    await expect(
      claudeCommandProvider.discover({ cwd: "/repo" }),
    ).resolves.toEqual([]);
    expect(spawned).toHaveLength(1);
  });

  it("gives up on a probe that never answers", async () => {
    const pending = claudeCommandProvider.discover({ cwd: "/repo" });
    const probe = await spawnedProbe();
    await vi.advanceTimersByTimeAsync(8_001);

    await expect(pending).resolves.toEqual([]);
    expect(killed).toEqual([probe.id]);
  });

  it("takes a running session's list without probing and tells open pickers", async () => {
    const onCommands = vi.fn();
    const stop = claudeCommandProvider.subscribe!(
      { cwd: "/repo/" },
      onCommands,
    );
    const elsewhere = vi.fn();
    claudeCommandProvider.subscribe!({ cwd: "/other" }, elsewhere);

    noteClaudeCommands("/repo", [advisor]);
    noteClaudeCommands("/repo", [{ ...advisor }]);

    expect(onCommands).toHaveBeenCalledOnce();
    expect(onCommands).toHaveBeenCalledWith([advisor]);
    expect(elsewhere).not.toHaveBeenCalled();
    await expect(
      claudeCommandProvider.discover({ cwd: "/repo" }),
    ).resolves.toEqual([advisor]);
    expect(spawned).toHaveLength(0);

    stop();
    noteClaudeCommands("/repo", []);
    expect(onCommands).toHaveBeenCalledOnce();
  });
});
