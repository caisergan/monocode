// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunMeta, Block } from "../model/session";
import { SubagentDock } from "./SubagentDock";
import { SubagentSheet } from "./SubagentSheet";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function run(
  id: string,
  name: string,
  status: string,
  meta: Partial<AgentRunMeta> = {},
): Block {
  return {
    id,
    role: "tool",
    text: name,
    tool: { callId: `call-${id}`, title: name, kind: "agent", status },
    agentRun: { name, steps: [], ...meta },
  };
}

const usage = (uncached: number, output: number) => ({
  uncached,
  cacheRead: 1_000,
  cacheWrite: 0,
  output,
});

describe("subagent dock", () => {
  it("shows each run with its state and the runs' tokens together", () => {
    const onOpen = vi.fn();
    act(() =>
      root.render(
        createElement(SubagentDock, {
          runs: [
            run("a", "Explore the shell", "in_progress", {
              startedAt: Date.now() - 65_000,
              usage: usage(12_000, 3_000),
            }),
            run("b", "Review the diff", "completed", {
              usage: usage(8_000, 1_000),
            }),
            run("c", "Audit tokens", "failed", { stopped: true }),
          ],
          live: true,
          onOpen,
        }),
      ),
    );
    const chips = [
      ...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    ];
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "Explore the shell, working. Open its work",
      "Review the diff, done. Open its work",
      "Audit tokens, stopped. Open its work",
    ]);
    expect(chips[0].textContent).toContain("1m 5s");
    expect(chips[2].textContent).toContain("stopped");
    expect(container.textContent).toContain("1 agent working");
    expect(container.textContent).toContain("↑20K");
    expect(container.textContent).toContain("↓4K");

    act(() => chips[1].click());
    expect(onOpen).toHaveBeenCalledWith("b", expect.any(HTMLElement));
  });

  it("folds finished runs behind a count, never the open one", () => {
    const runs = [
      run("a", "One", "completed"),
      run("b", "Two", "in_progress"),
      run("c", "Three", "in_progress"),
      run("d", "Four", "in_progress"),
    ];
    act(() =>
      root.render(
        createElement(SubagentDock, {
          runs,
          live: true,
          selectedId: "a",
          onOpen: vi.fn(),
        }),
      ),
    );
    const labels = [
      ...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    ].map((chip) => chip.textContent);
    expect(labels).toEqual([
      expect.stringContaining("One"),
      expect.stringContaining("Three"),
      expect.stringContaining("Four"),
    ]);
    expect(container.textContent).toContain("+1");
    expect(
      container
        .querySelector("[data-subagent-dock]")
        ?.getAttribute("data-attached"),
    ).toBe("true");
  });

  it("holds the finished runs a moment after the turn, then folds", () => {
    vi.useFakeTimers();
    const runs = [run("a", "One", "in_progress")];
    const dock = (live: boolean, list: Block[]) =>
      createElement(SubagentDock, { runs: list, live, onOpen: vi.fn() });
    act(() => root.render(dock(true, runs)));
    expect(container.querySelector("[data-subagent-dock]")).not.toBeNull();

    const done = [run("a", "One", "completed")];
    act(() => root.render(dock(false, done)));
    expect(container.textContent).toContain("Agent done");
    act(() => vi.advanceTimersByTime(1_700));
    expect(
      container
        .querySelector("[data-subagent-dock]")
        ?.getAttribute("data-open"),
    ).toBe("false");
    act(() => vi.advanceTimersByTime(400));
    expect(container.querySelector("[data-subagent-dock]")).toBeNull();
  });

  it("stays away from a session that is not working", () => {
    act(() =>
      root.render(
        createElement(SubagentDock, {
          runs: [run("a", "One", "completed")],
          live: false,
          onOpen: vi.fn(),
        }),
      ),
    );
    expect(container.querySelector("[data-subagent-dock]")).toBeNull();
  });
});

describe("subagent sheet", () => {
  function sheet(
    block: Block,
    props: { canStop?: boolean; live?: boolean } = {},
  ) {
    const onStop = vi.fn();
    act(() =>
      root.render(
        createElement(SubagentSheet, {
          run: block,
          live: props.live ?? true,
          conversationAvailable: false,
          canStop: props.canStop ?? true,
          onClose: vi.fn(),
          onStop,
        }),
      ),
    );
    return onStop;
  }

  it("shows a running run's cost and stops only that run", () => {
    const onStop = sheet(
      run("a", "Explore the shell", "in_progress", {
        agentType: "explorer",
        startedAt: Date.now() - 5_000,
        usage: {
          uncached: 48_200,
          cacheRead: 612_000,
          cacheWrite: 46_100,
          output: 9_400,
          contextUsed: 61_300,
          contextWindow: 200_000,
          toolUses: 14,
        },
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("explorer");
    expect(text).toContain("Working 5s");
    expect(text).toContain("14 tool calls");
    expect(text).toContain("↑ 48K");
    expect(text).toContain("↓ 9.4K");
    expect(text).toContain("612K");
    expect(text).toContain("61K / 200K");

    const stop = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop",
    )!;
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledWith("call-a");
    expect(stop.textContent).toBe("Stopping…");
  });

  it("offers no stop once a run is over, and shows its brief as context", () => {
    sheet(
      run("a", "Review the diff", "completed", {
        prompt: "Review the diff for **correctness**.",
      }),
    );
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Stop",
      ),
    ).toBe(false);
    expect(container.textContent).toContain("No token counts");
    const context = [...container.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "Context",
    ) as HTMLButtonElement;
    act(() => context.click());
    expect(container.textContent).toContain("Brief");
    expect(container.textContent).toContain("correctness");
    expect(container.textContent).toContain(
      "provider doesn't share its full conversation",
    );
  });
});
