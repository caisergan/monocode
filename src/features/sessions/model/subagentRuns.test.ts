import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import {
  latestTurnSubagents,
  runningSubagentNames,
  subagentElapsedMs,
  subagentRunState,
  subagentTokenTotals,
  visibleSubagents,
} from "./subagentRuns";

function agent(
  id: string,
  status: string,
  run: Partial<NonNullable<Block["agentRun"]>> = {},
): Block {
  return {
    id,
    role: "tool",
    text: `Agent ${id}`,
    tool: { callId: id, title: `Agent ${id}`, kind: "agent", status },
    agentRun: { name: id, steps: [], ...run },
  };
}

const user = (id: string, extra: Partial<Block> = {}): Block => ({
  id,
  role: "user",
  text: id,
  ...extra,
});

describe("subagent runs", () => {
  it("lists only the latest turn's runs, past messages sent into it", () => {
    const blocks = [
      user("first"),
      agent("old", "completed"),
      user("second"),
      agent("a", "in_progress"),
      user("steer", { sentAt: 5 }),
      {
        id: "bash",
        role: "tool",
        text: "Run ls",
        tool: { callId: "bash", title: "ls", kind: "execute" },
      } as Block,
      agent("b", "completed"),
    ];
    expect(latestTurnSubagents(blocks).map((block) => block.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("names only the runs still working, and none once the session stops", () => {
    const blocks = [
      user("go"),
      agent("a", "in_progress", { name: "Review the diff" }),
      agent("b", "completed"),
      agent("c", "in_progress", { name: "Run the tests" }),
    ];
    expect(runningSubagentNames(blocks, true)).toEqual([
      "Review the diff",
      "Run the tests",
    ]);
    expect(runningSubagentNames(blocks, false)).toEqual([]);
  });

  it("tells a stopped run from a failed one", () => {
    expect(subagentRunState(agent("a", "in_progress"), true)).toBe("running");
    expect(subagentRunState(agent("a", "in_progress"), false)).toBe("stopped");
    expect(subagentRunState(agent("a", "failed"), true)).toBe("failed");
    expect(
      subagentRunState(agent("a", "failed", { stopped: true }), true),
    ).toBe("stopped");
    expect(subagentRunState(agent("a", "completed"), true)).toBe("done");
  });

  it("times a run by the provider when it has finished", () => {
    const running = agent("a", "in_progress", { startedAt: 1_000 });
    expect(subagentElapsedMs(running, 61_000, true)).toBe(60_000);
    const done = agent("a", "completed", {
      startedAt: 1_000,
      endedAt: 4_000,
      usage: {
        uncached: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        durationMs: 3_725,
      },
    });
    expect(subagentElapsedMs(done, 99_000, false)).toBe(3_725);
    const replayed = agent("a", "completed", {
      startedAt: 1_000,
      endedAt: 1_000,
    });
    expect(subagentElapsedMs(replayed, 99_000, false)).toBeUndefined();
  });

  it("adds up the runs that reported tokens", () => {
    expect(subagentTokenTotals([agent("a", "completed")])).toBeUndefined();
    expect(
      subagentTokenTotals([
        agent("a", "completed", {
          usage: { uncached: 10, cacheRead: 100, cacheWrite: 5, output: 3 },
        }),
        agent("b", "in_progress"),
        agent("c", "in_progress", {
          usage: { uncached: 20, cacheRead: 0, cacheWrite: 0, output: 7 },
        }),
      ]),
    ).toEqual({ uncached: 30, cacheRead: 100, output: 10 });
  });

  it("makes room by hiding finished runs first, keeping order", () => {
    const runs = [
      agent("a", "in_progress"),
      agent("b", "completed"),
      agent("c", "in_progress"),
      agent("d", "completed"),
      agent("e", "in_progress"),
    ];
    const { visible, hidden } = visibleSubagents(runs, true, 3);
    expect(visible.map((block) => block.id)).toEqual(["a", "c", "e"]);
    expect(hidden.map((block) => block.id)).toEqual(["b", "d"]);
    expect(
      visibleSubagents(runs, true, 2).visible.map((block) => block.id),
    ).toEqual(["c", "e"]);
    // The run whose sheet is open keeps its chip.
    expect(
      visibleSubagents(runs, true, 3, "b").visible.map((block) => block.id),
    ).toEqual(["b", "c", "e"]);
  });
});
