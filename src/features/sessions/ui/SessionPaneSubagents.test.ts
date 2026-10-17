// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import {
  closeSubagentSheet,
  openSubagentSheet,
  peekSubagentSheet,
} from "../model/subagentSheets";
import { SessionPane, type SessionPaneProps } from "./SessionPane";

// The composer is only the dock's stand here.
vi.mock("./Composer", () => ({
  Composer: ({ children }: { children?: ReactNode }) =>
    createElement("div", { "data-composer": "" }, children),
}));
vi.mock("../hooks/useFileDrop", () => ({ useFileDrop: () => false }));
vi.mock("./AgentTranscript", () => ({
  AgentTranscript: () => null,
  SubagentTrail: () => null,
}));
const noRuns = vi.hoisted(() => [] as never[]);
vi.mock("../../orchestration/model/orchestration", async (original) => ({
  ...(await original<
    typeof import("../../orchestration/model/orchestration")
  >()),
  orchestrator: {
    subscribe: () => () => {},
    snapshot: () => noRuns,
    hydrate: async () => {},
  },
}));

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  // The sheet skips its unfold, which happy-dom can't cancel cleanly.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await settle();
  vi.unstubAllGlobals();
});

function agentRun(id: string, name: string, status: string): Block {
  return {
    id,
    role: "tool",
    text: name,
    tool: { callId: `call-${id}`, title: name, kind: "agent", status },
    agentRun: { name, steps: [] },
  };
}

const noop = () => {};
function props(id = "parent"): SessionPaneProps {
  return {
    session: {
      id,
      title: "Expand the question bank",
      cwd: "/repo",
      harness: "claude",
      model: "",
      modelSettings: {},
      runtimeMode: "supervised",
      busy: true,
      blocks: [
        { id: "go", role: "user", text: "Fan out" },
        agentRun("run-a", "Company questions A", "in_progress"),
        agentRun("run-b", "Level questions E", "in_progress"),
      ],
    },
    visible: true,
    focused: true,
    inSplit: false,
    composerFocused: false,
    recents: [],
    onFocus: noop,
    onClose: noop,
    onCwdChange: noop,
    onBranchChange: noop,
    onWorkspaceModeChange: noop,
    onWorktreeBaseChange: noop,
    onModelChange: noop,
    onModelSettingsChange: noop,
    onRuntimeModeChange: noop,
    onSubmit: noop,
    onSaveDraft: noop,
    onRemoveDraft: noop,
    onStop: noop,
    onCompactContext: () => false,
    onPlaceSessionInFolder: noop,
    onDeleteQueuedMessage: noop,
    onEditQueuedMessage: noop,
    onQueuedMessageEditingChange: noop,
    onSteerQueuedMessage: noop,
    onResumeQueue: noop,
    onUsageLimitResume: noop,
    onUsageLimitResumeAtReset: noop,
    onUsageLimitDismiss: noop,
    onApproval: noop,
    onQuestionReply: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
    onOpenPlan: noop,
    onBuildPlan: noop,
    onNewTerminal: noop,
  };
}

function render(pane: SessionPaneProps) {
  act(() => root.render(createElement(SessionPane, pane)));
}

const dock = () => container.querySelector("[data-subagent-dock]");
const sheet = () => container.querySelector("[data-subagent-sheet]");

it("docks the turn's runs on the composer", () => {
  render(props());
  expect(dock()).not.toBeNull();
  expect(dock()?.getAttribute("data-open")).toBe("true");
});

it("opens the run the sidebar chose, and closes it on leaving the session", async () => {
  // A sidebar row writes the run first, then brings the session forward.
  openSubagentSheet("parent", "run-b");
  render(props());
  expect(sheet()?.getAttribute("data-state")).toBe("open");
  expect(
    sheet()?.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
  ).toBe("Subagent: Level questions E");

  // Its close button folds it for the sidebar too.
  act(() =>
    sheet()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
  );
  expect(peekSubagentSheet("parent")).toBeNull();

  // Moving the pane to another session closes the one it left.
  act(() => openSubagentSheet("parent", "run-a"));
  render(props("other"));
  await act(settle);
  expect(peekSubagentSheet("parent")).toBeNull();
  closeSubagentSheet("other");
});
