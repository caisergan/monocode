// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatSessionTitle } from "../../features/sessions/model/session";
import type { SubagentSummary } from "../../features/sessions/model/subagentRuns";
import {
  closeSubagentSheet,
  peekSubagentSheet,
} from "../../features/sessions/model/subagentSheets";
import { Sidebar } from "./Sidebar";

// Keep native services out of these sidebar interaction tests.
vi.mock("../../features/source-control/hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: vi.fn(() => null),
}));
vi.mock("../../features/source-control/hooks/useGitFileStatuses", () => ({
  useGitFileStatuses: () => ({ files: new Map(), dirs: new Map() }),
}));
vi.mock("./SidebarUpdate", () => ({ SidebarUpdateFooter: () => null }));
vi.mock("../../features/files/ui/FileTree", () => ({
  FileTree: () => null,
}));
vi.mock("../../features/orchestration/model/pastWorkers", async (actual) => ({
  ...(await actual<
    typeof import("../../features/orchestration/model/pastWorkers")
  >()),
  loadPastWorkers: vi.fn().mockResolvedValue([]),
}));

const SESSION = "subagent-parent";
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof Sidebar>;

function run(
  id: string,
  name: string,
  state: SubagentSummary["state"],
): SubagentSummary {
  return { id, name, brief: name, state };
}

function render() {
  root.render(createElement(Sidebar, props));
}

const card = () =>
  container.querySelector<HTMLElement>(`[data-session-card="${SESSION}"]`)!;
const tree = () =>
  container.querySelector<HTMLElement>(`[data-subagent-tree="${SESSION}"]`);
const rows = () => [
  ...container.querySelectorAll<HTMLButtonElement>("[data-subagent-run]"),
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  props = {
    cwd: "/workspace/project",
    open: true,
    sessions: [
      {
        id: SESSION,
        cwd: "/workspace/project",
        harness: "claude",
        model: "",
        runtimeMode: "supervised",
        title: formatSessionTitle("claude", "Expand the question bank"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    busySessionIds: new Set([SESSION]),
    approvalSessionIds: new Set(),
    subagentRuns: new Map([
      [
        SESSION,
        [
          run("run-a", "Company questions A", "running"),
          run("run-b", "Level questions E", "done"),
        ],
      ],
    ]),
    activeSessionId: SESSION,
    status: "idle",
    pending: false,
    tab: "sessions",
    filesSearchOpen: false,
    onSelectSession: vi.fn(),
    onPrefetchSession: vi.fn(),
    onOpenFile: vi.fn(),
    onTabChange: vi.fn(),
    onFilesSearchOpenChange: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  closeSubagentSheet(SESSION);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("hangs a working session's subagents beneath its card", async () => {
  await act(async () => render());
  expect(tree()).not.toBeNull();
  // Beneath the card, not inside it, so they read as its children.
  expect(card().contains(tree())).toBe(false);
  expect(card().closest("li")?.contains(tree())).toBe(true);
  expect(rows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("Company questions A"),
    expect.stringContaining("Level questions E"),
  ]);
  // The card counts the turn's runs, finished ones too.
  expect(
    card().querySelector("[data-subagent-count]")?.getAttribute("aria-label"),
  ).toBe("2 subagents, 1 running");
});

it("opens a run from its row without pressing on the card", async () => {
  await act(async () => render());
  act(() => {
    rows()[1].dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  // The card warms its transcript on press; a row is not a press on it.
  expect(props.onPrefetchSession).not.toHaveBeenCalled();
  act(() => rows()[1].click());
  expect(peekSubagentSheet(SESSION)).toBe("run-b");
  expect(props.onSelectSession).toHaveBeenCalledWith(SESSION);
  expect(card().getAttribute("data-session-selected")).toBeNull();
});

it("folds the tree from the card's count without opening the session", async () => {
  await act(async () => render());
  const toggle = card().querySelector<HTMLElement>("[data-subagent-count]")!;
  act(() => toggle.click());
  expect(tree()?.getAttribute("data-open")).toBe("false");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  act(() => toggle.click());
  expect(tree()?.getAttribute("data-open")).toBe("true");
  expect(props.onSelectSession).not.toHaveBeenCalled();
});

it("folds a session's tree once another is in front, and keeps its count", async () => {
  props = { ...props, activeSessionId: "another-session" };
  await act(async () => render());
  expect(tree()?.getAttribute("data-open")).toBe("false");
  const toggle = card().querySelector<HTMLElement>("[data-subagent-count]")!;
  expect(toggle.textContent).toBe("2");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  // The count brings the session forward with its runs showing.
  act(() => toggle.click());
  expect(props.onSelectSession).toHaveBeenCalledWith(SESSION);
  props = { ...props, activeSessionId: SESSION };
  act(() => render());
  expect(tree()?.getAttribute("data-open")).toBe("true");
});

it("keeps the count after the turn, and the count opens its runs again", async () => {
  vi.useFakeTimers();
  props = {
    ...props,
    busySessionIds: new Set(),
    subagentRuns: new Map([
      [
        SESSION,
        [
          run("run-a", "Company questions A", "done"),
          run("run-b", "Level questions E", "done"),
        ],
      ],
    ]),
  };
  await act(async () => render());
  // A turn that is over shows how its runs ended for a moment, then folds.
  await act(async () => {
    vi.advanceTimersByTime(3_000);
  });
  expect(tree()?.getAttribute("data-open") ?? "false").toBe("false");
  const toggle = card().querySelector<HTMLElement>("[data-subagent-count]")!;
  expect(toggle.getAttribute("aria-label")).toBe("2 subagents");

  act(() => toggle.click());
  expect(tree()?.getAttribute("data-open")).toBe("true");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(props.onSelectSession).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(3_000);
  });
  expect(tree()?.getAttribute("data-open")).toBe("true");
  vi.useRealTimers();
});
