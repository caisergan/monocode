import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import {
  latestTurnSubagentSummaries,
  latestTurnSubagents,
  subagentElapsedMs,
  subagentRunState,
  subagentSummariesBySession,
  subagentSummariesEqual,
  subagentSummaryElapsedMs,
  subagentTokenTotals,
  visibleSubagents,
  type SubagentSummary,
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

  it("sums up the latest turn's runs for the sidebar, finished ones too", () => {
    const blocks = [
      user("first"),
      agent("old", "completed"),
      user("go"),
      agent("a", "in_progress", {
        name: "Review the diff. Then report back.",
        agentType: "code-reviewer",
        startedAt: 1_000,
      }),
      agent("b", "completed", {
        name: "Run the tests",
        startedAt: 2_000,
        endedAt: 9_000,
        usage: {
          uncached: 1,
          cacheRead: 0,
          cacheWrite: 0,
          output: 1,
          durationMs: 6_500,
        },
      }),
    ];
    expect(latestTurnSubagentSummaries(blocks, true)).toEqual([
      {
        id: "a",
        name: "Review the diff.",
        brief: "Review the diff. Then report back.",
        kind: "code-reviewer",
        state: "running",
        startedAt: 1_000,
      },
      {
        id: "b",
        name: "Run the tests",
        brief: "Run the tests",
        state: "done",
        startedAt: 2_000,
        endedAt: 9_000,
        durationMs: 6_500,
      },
    ]);
    // Once the session stops, a run that never reported back has stopped.
    expect(
      latestTurnSubagentSummaries(blocks, false).map((run) => run.state),
    ).toEqual(["stopped", "done"]);
  });

  it("times a listed run like its block", () => {
    const running: SubagentSummary = {
      id: "a",
      name: "a",
      brief: "a",
      state: "running",
      startedAt: 1_000,
    };
    expect(subagentSummaryElapsedMs(running, 61_000)).toBe(60_000);
    expect(
      subagentSummaryElapsedMs(
        { ...running, state: "done", endedAt: 5_000, durationMs: 3_900 },
        99_000,
      ),
    ).toBe(3_900);
  });

  it("calls runs equal while only their steps and tokens move", () => {
    const before = latestTurnSubagentSummaries(
      [user("go"), agent("a", "in_progress", { startedAt: 1 })],
      true,
    );
    const streamed = latestTurnSubagentSummaries(
      [
        user("go"),
        agent("a", "in_progress", {
          startedAt: 1,
          steps: [{ id: "s", kind: "tool", text: "Read file" }],
          usage: { uncached: 900, cacheRead: 0, cacheWrite: 0, output: 40 },
        }),
      ],
      true,
    );
    expect(subagentSummariesEqual(before, streamed)).toBe(true);
    const finished = latestTurnSubagentSummaries(
      [user("go"), agent("a", "completed", { startedAt: 1 })],
      true,
    );
    expect(subagentSummariesEqual(before, finished)).toBe(false);
  });

  it("keeps each session's runs, and the whole map, while nothing listed changed", () => {
    const busy = {
      id: "busy",
      busy: true,
      blocks: [user("go"), agent("a", "in_progress")],
    };
    const idle = {
      id: "idle",
      blocks: [user("go"), agent("b", "completed")],
    };
    const quiet = { id: "quiet", blocks: [user("hello")] };
    const first = subagentSummariesBySession([busy, idle, quiet], new Map());
    expect([...first.keys()]).toEqual(["busy", "idle"]);

    // A step streaming in changes nothing the sidebar shows.
    const streamed = {
      ...busy,
      blocks: [
        user("go"),
        agent("a", "in_progress", {
          steps: [{ id: "s", kind: "tool", text: "Grep" }],
        }),
      ],
    };
    expect(subagentSummariesBySession([streamed, idle, quiet], first)).toBe(
      first,
    );

    // A run finishing replaces only its own session's runs.
    const finished = {
      ...busy,
      blocks: [user("go"), agent("a", "completed")],
    };
    const next = subagentSummariesBySession([finished, idle, quiet], first);
    expect(next).not.toBe(first);
    expect(next.get("busy")).not.toBe(first.get("busy"));
    expect(next.get("idle")).toBe(first.get("idle"));

    // A session whose new turn has no runs drops out.
    const fresh = { ...busy, blocks: [...busy.blocks, user("again")] };
    expect([
      ...subagentSummariesBySession([fresh, idle], next).keys(),
    ]).toEqual(["idle"]);
  });

  it("reads a session's blocks again only once they or its liveness change", () => {
    const blocks = [user("go"), agent("a", "in_progress")];
    const first = subagentSummariesBySession([{ id: "s", blocks }], new Map());
    const again = subagentSummariesBySession([{ id: "s", blocks }], new Map());
    expect(again.get("s")).toBe(first.get("s"));
    // The same blocks read live: the pending run is working, not stopped.
    const live = subagentSummariesBySession(
      [{ id: "s", blocks, busy: true }],
      first,
    );
    expect(live.get("s")?.[0].state).toBe("running");
    expect(first.get("s")?.[0].state).toBe("stopped");
  });

  it("leaves out a session running in the agent's own terminal", () => {
    const terminal = {
      id: "cli",
      busy: true,
      surface: "terminal" as const,
      blocks: [user("go"), agent("a", "in_progress")],
    };
    expect(subagentSummariesBySession([terminal], new Map()).size).toBe(0);
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
