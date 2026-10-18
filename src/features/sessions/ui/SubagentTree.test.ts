// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentSummary } from "../model/subagentRuns";
import {
  closeSubagentSheet,
  holdSubagentSheet,
  openSubagentSheet,
  peekSubagentSheet,
} from "../model/subagentSheets";
import {
  SubagentTree,
  SubagentTreeToggle,
  subagentTreeId,
} from "./SubagentTree";

let container: HTMLDivElement;
let root: Root;
const releases: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function run(
  id: string,
  name: string,
  state: SubagentSummary["state"],
  extra: Partial<SubagentSummary> = {},
): SubagentSummary {
  return { id, name, brief: name, state, ...extra };
}

type TreeProps = ComponentProps<typeof SubagentTree>;

function tree(props: Partial<TreeProps> & Pick<TreeProps, "sessionId">) {
  return createElement(SubagentTree, {
    sessionTitle: "Expand the question bank",
    runs: [],
    live: true,
    active: true,
    expanded: true,
    onOpenSession: vi.fn(),
    ...props,
  });
}

function rows() {
  return [
    ...container.querySelectorAll<HTMLButtonElement>("[data-subagent-run]"),
  ];
}

/** A pane showing the session, as SessionPane holds it. */
function showInPane(sessionId: string) {
  act(() => {
    releases.push(holdSubagentSheet(sessionId));
  });
}

describe("subagent tree", () => {
  it("lists each run under its session with where it stands", () => {
    act(() =>
      root.render(
        tree({
          sessionId: "tree-list",
          runs: [
            run("a", "Explore the shell", "running", {
              startedAt: Date.now() - 65_000,
              kind: "Explore · Haiku 5.5",
            }),
            run("b", "Review the diff", "done"),
            run("c", "Audit tokens", "failed"),
            run("d", "Lint", "stopped"),
          ],
        }),
      ),
    );
    const list = container.querySelector("ul")!;
    expect(list.id).toBe(subagentTreeId("tree-list"));
    expect(list.getAttribute("aria-label")).toBe(
      "Subagents of Expand the question bank",
    );
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Explore the shell, working. Open its work",
      "Review the diff, done. Open its work",
      "Audit tokens, failed. Open its work",
      "Lint, stopped. Open its work",
    ]);
    expect(rows()[0].textContent).toContain("1m 5s");
    expect(rows()[0].title).toBe("Explore the shell\nExplore · Haiku 5.5");
    expect(rows()[3].textContent).toContain("stopped");
    expect(
      container
        .querySelector("[data-subagent-tree]")
        ?.getAttribute("data-open"),
    ).toBe("true");
  });

  it("opens a run's sheet and brings its session forward", () => {
    const onOpenSession = vi.fn();
    const runs = [run("a", "One", "running"), run("b", "Two", "running")];
    act(() =>
      root.render(tree({ sessionId: "tree-open", runs, onOpenSession })),
    );
    act(() => rows()[1].click());
    // The sheet is chosen first, so the pane finds it as it mounts.
    expect(peekSubagentSheet("tree-open")).toBe("b");
    expect(onOpenSession).toHaveBeenCalledWith("tree-open");

    showInPane("tree-open");
    expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
    ]);

    // Choosing the open run again folds its sheet, without a trip forward.
    onOpenSession.mockClear();
    act(() => rows()[1].click());
    expect(peekSubagentSheet("tree-open")).toBeNull();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("folds the open run's sheet on Esc from its row", () => {
    act(() =>
      root.render(
        tree({ sessionId: "tree-esc", runs: [run("a", "One", "running")] }),
      ),
    );
    act(() => openSubagentSheet("tree-esc", "a"));
    showInPane("tree-esc");
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      rows()[0].dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(peekSubagentSheet("tree-esc")).toBeNull();
  });

  it("marks the open run only while its session is in front", () => {
    const runs = [run("a", "One", "running")];
    act(() => openSubagentSheet("tree-front", "a"));
    showInPane("tree-front");
    act(() =>
      root.render(tree({ sessionId: "tree-front", runs, active: false })),
    );
    expect(rows()[0].getAttribute("aria-pressed")).toBe("false");
    act(() => root.render(tree({ sessionId: "tree-front", runs })));
    expect(rows()[0].getAttribute("aria-pressed")).toBe("true");
    act(() => closeSubagentSheet("tree-front"));
  });

  it("shows how the runs ended for a moment after the turn, then folds", () => {
    vi.useFakeTimers();
    const props = { sessionId: "tree-linger" };
    act(() =>
      root.render(tree({ ...props, runs: [run("a", "One", "running")] })),
    );
    act(() =>
      root.render(
        tree({ ...props, live: false, runs: [run("a", "One", "done")] }),
      ),
    );
    expect(rows()[0].getAttribute("aria-label")).toBe(
      "One, done. Open its work",
    );
    // Two seconds, as long as Claude keeps its finished agents up.
    act(() => vi.advanceTimersByTime(1_900));
    expect(
      container
        .querySelector("[data-subagent-tree]")
        ?.getAttribute("data-open"),
    ).toBe("true");
    act(() => vi.advanceTimersByTime(200));
    expect(
      container
        .querySelector("[data-subagent-tree]")
        ?.getAttribute("data-open"),
    ).toBe("false");
    act(() => vi.advanceTimersByTime(400));
    expect(container.querySelector("[data-subagent-tree]")).toBeNull();
  });

  it("stays while one of its runs is open in front", () => {
    vi.useFakeTimers();
    const props = { sessionId: "tree-viewing" };
    act(() => openSubagentSheet("tree-viewing", "a"));
    showInPane("tree-viewing");
    act(() =>
      root.render(tree({ ...props, runs: [run("a", "One", "running")] })),
    );
    const done = [run("a", "One", "done")];
    act(() => root.render(tree({ ...props, live: false, runs: done })));
    act(() => vi.advanceTimersByTime(5_000));
    expect(rows()).toHaveLength(1);

    // Closing the sheet lets the finished tree go.
    act(() => closeSubagentSheet("tree-viewing"));
    act(() => vi.advanceTimersByTime(2_400));
    expect(container.querySelector("[data-subagent-tree]")).toBeNull();
  });

  it("never shows for a session that is not working", () => {
    act(() =>
      root.render(
        tree({
          sessionId: "tree-idle",
          live: false,
          runs: [run("a", "One", "done")],
        }),
      ),
    );
    expect(container.querySelector("[data-subagent-tree]")).toBeNull();
  });

  it("folds under the card's toggle, out of the tab order", () => {
    act(() =>
      root.render(
        tree({
          sessionId: "tree-folded",
          expanded: false,
          runs: [run("a", "One", "running")],
        }),
      ),
    );
    const folded = container.querySelector("[data-subagent-tree]")!;
    expect(folded.getAttribute("data-open")).toBe("false");
    expect(folded.hasAttribute("inert")).toBe(true);
  });
});

describe("subagent tree toggle", () => {
  it("counts the turn's runs and folds the tree, not the card", () => {
    const onToggle = vi.fn();
    const onCardClick = vi.fn();
    const onCardPointerDown = vi.fn();
    const card = (expanded: boolean) =>
      createElement(
        "div",
        { onClick: onCardClick, onPointerDown: onCardPointerDown },
        createElement(SubagentTreeToggle, {
          sessionId: "toggle",
          runs: [
            run("run-a", "Review the diff", "running"),
            run("run-b", "Run the tests", "running"),
            run("run-c", "Map the schema", "done"),
          ],
          expanded,
          onToggle,
        }),
      );
    act(() => root.render(card(true)));
    const toggle = container.querySelector<HTMLElement>(
      "[data-subagent-count]",
    )!;
    expect(toggle.getAttribute("aria-label")).toBe(
      "3 subagents, 2 running",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(
      subagentTreeId("toggle"),
    );
    expect(toggle.textContent).toBe("3");

    // Unfolded, the tree below already names them.
    act(() => {
      toggle.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    act(() => {
      toggle.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    act(() => toggle.click());
    expect(onToggle).toHaveBeenCalledWith("toggle");
    expect(onCardClick).not.toHaveBeenCalled();
    expect(onCardPointerDown).not.toHaveBeenCalled();

    act(() => root.render(card(false)));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      toggle.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      toggle.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const tooltip = document.body.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain("2 running");
    expect(tooltip.textContent).toContain("Review the diff");
    expect(tooltip.textContent).toContain("Run the tests");
    expect(tooltip.textContent).toContain("Map the schema");
  });
});
