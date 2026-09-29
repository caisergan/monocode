// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSessionListing,
  AgentSessionQuery,
  AgentSessionSummary,
} from "../../../platform/tauri/agentSessions";

const api = vi.hoisted(() => ({
  listAgentSessions:
    vi.fn<(request: AgentSessionQuery) => Promise<AgentSessionListing>>(),
  importAgentSession:
    vi.fn<
      (
        session: AgentSessionSummary,
      ) => Promise<{ sessionId: string; cwd: string; existing: boolean }>
    >(),
}));

vi.mock("../../../platform/tauri/agentSessions", async (actual) => ({
  ...(await actual<typeof import("../../../platform/tauri/agentSessions")>()),
  listAgentSessions: api.listAgentSessions,
}));
vi.mock("../model/agentSessionImport", async (actual) => ({
  ...(await actual<typeof import("../model/agentSessionImport")>()),
  importAgentSession: api.importAgentSession,
}));

import { ImportSessionDialog } from "./ImportSessionDialog";

const NOW = new Date("2026-09-29T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;

let container: HTMLDivElement;
let root: Root;

function summary(
  overrides: Partial<AgentSessionSummary> & { id: string },
): AgentSessionSummary {
  return {
    harness: "claude",
    cwd: "/Users/me/code/monocode",
    title: null,
    firstPrompt: "first prompt",
    lastPrompt: "last prompt",
    gitBranch: "main",
    updatedAt: NOW - 2 * HOUR,
    sizeBytes: 100,
    folder: "ok",
    monocodeSessionId: null,
    ...overrides,
  };
}

function listing(
  sessions: AgentSessionSummary[],
  importedCount = 0,
): AgentSessionListing {
  return { sessions, importedCount, hasMore: false };
}

function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? "";
}

function row(text: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Sessions"] button',
    ),
  ].find((button) => button.textContent?.includes(text));
  expect(found, text).toBeDefined();
  return found!;
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function render(props: {
  cwd?: string;
  onOpen?: (sessionId: string, cwd: string) => void;
}) {
  act(() =>
    root.render(
      createElement(ImportSessionDialog, {
        cwd: props.cwd,
        projects: ["/Users/me/code/monocode"],
        onClose: () => undefined,
        onOpen: props.onOpen ?? (() => undefined),
      }),
    ),
  );
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listAgentSessions.mockReset();
  api.importAgentSession.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ImportSessionDialog", () => {
  it("lists terminal sessions from every folder like the sessions list", async () => {
    api.listAgentSessions.mockResolvedValue(
      listing(
        [
          summary({ id: "a", title: "Fix the build" }),
          summary({
            id: "b",
            cwd: "/Users/me/code/site",
            firstPrompt: "restyle the header",
            gitBranch: null,
          }),
          summary({ id: "c", cwd: "/Users/me", folder: "home" }),
        ],
        3,
      ),
    );
    await render({});

    expect(api.listAgentSessions).toHaveBeenCalledWith({
      cwd: undefined,
      query: undefined,
      limit: 15,
      includeImported: false,
      owner: expect.any(String),
    });
    expect(dialogText()).toContain("Import session");
    expect(row("Fix the build").textContent).toContain("monocode");
    expect(row("Fix the build").textContent).toContain("2h");
    // A folder that is not a project yet shows its path.
    expect(row("restyle the header").textContent).toContain("~/code/site");
    // Home-folder sessions become chats that belong to no project.
    expect(row("No project").disabled).toBe(false);
    expect(dialogText()).toContain("3 already in MonoCode · Show");
  });

  it("imports a session and asks again before importing one still open", async () => {
    const open = vi.fn();
    api.listAgentSessions.mockResolvedValue(
      listing([
        summary({ id: "old", title: "Older work" }),
        summary({ id: "live", title: "Live work", updatedAt: NOW - 30_000 }),
      ]),
    );
    api.importAgentSession.mockResolvedValue({
      sessionId: "mono-1",
      cwd: "/Users/me/code/monocode",
      existing: false,
    });
    await render({ onOpen: open });

    await act(async () => row("Older work").click());
    expect(api.importAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "old", cwd: "/Users/me/code/monocode" }),
    );
    expect(open).toHaveBeenCalledWith("mono-1", "/Users/me/code/monocode");

    await act(async () => row("Live work").click());
    expect(api.importAgentSession).toHaveBeenCalledTimes(1);
    expect(row("Live work").textContent).toContain(
      "May still be open in the terminal",
    );
    await act(async () => row("Live work").click());
    expect(api.importAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "live" }),
    );
  });

  it("imports a home-folder session as a chat without a project", async () => {
    const open = vi.fn();
    api.listAgentSessions.mockResolvedValue(
      listing([
        summary({
          id: "home",
          cwd: "/Users/me",
          folder: "home",
          title: "Notes",
        }),
        summary({
          id: "gone",
          cwd: "/Users/me/deleted",
          folder: "missing",
          title: "Gone",
        }),
      ]),
    );
    api.importAgentSession.mockResolvedValue({
      sessionId: "mono-2",
      cwd: "~",
      existing: false,
    });
    await render({ onOpen: open });

    expect(row("Notes").textContent).toContain("No project");
    await act(async () => row("Notes").click());
    expect(api.importAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "home", folder: "home" }),
    );
    expect(open).toHaveBeenCalledWith("mono-2", "~");

    // A deleted folder can't be resumed, but its transcript still imports.
    expect(row("Gone").disabled).toBe(false);
    expect(row("Gone").textContent).toContain("~/deleted");
    expect(row("Gone").textContent).toContain(
      "Folder no longer exists · imports without resuming",
    );
    api.importAgentSession.mockResolvedValue({
      sessionId: "gone",
      cwd: "~",
      existing: false,
    });
    await act(async () => row("Gone").click());
    expect(open).toHaveBeenLastCalledWith("gone", "~");
  });

  it("labels a worktree session with its project", async () => {
    const open = vi.fn();
    api.listAgentSessions.mockResolvedValue(
      listing([
        summary({
          id: "wt",
          title: "Worktree work",
          cwd: "/Users/me/code/monocode/.worktrees/feature",
          project: "/Users/me/code/monocode",
          gitBranch: "feature",
          monocodeSessionId: "m-wt",
        }),
      ]),
    );
    await render({ onOpen: open });
    expect(row("Worktree work").textContent).toContain("monocode");
    expect(row("Worktree work").textContent).not.toContain(".worktrees");
    await act(async () => row("Worktree work").click());
    expect(open).toHaveBeenCalledWith("m-wt", "/Users/me/code/monocode");
  });

  it("keeps the list and says so when a refresh fails", async () => {
    api.listAgentSessions.mockResolvedValue(
      listing([summary({ id: "a", title: "Still here" })]),
    );
    await render({});
    api.listAgentSessions.mockRejectedValue(new Error("disk"));
    await act(async () => button("Refresh").click());
    await flush();
    expect(dialogText()).toContain("Couldn’t load terminal sessions");
    expect(row("Still here")).toBeDefined();
  });

  it("opens a session MonoCode already has instead of importing it", async () => {
    const open = vi.fn();
    api.listAgentSessions.mockResolvedValue(listing([], 1));
    await render({ onOpen: open });
    expect(dialogText()).toContain(
      "Every recent session is already in MonoCode",
    );

    api.listAgentSessions.mockResolvedValue(
      listing([
        summary({ id: "known", title: "Known", monocodeSessionId: "m-9" }),
      ]),
    );
    await act(async () => button("Show").click());
    await flush();
    expect(api.listAgentSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeImported: true }),
    );
    expect(row("Known").textContent).toContain("Already in MonoCode");
    await act(async () => row("Known").click());
    expect(open).toHaveBeenCalledWith("m-9", "/Users/me/code/monocode");
    expect(api.importAgentSession).not.toHaveBeenCalled();
  });

  it("searches after a pause and says when nothing matches", async () => {
    api.listAgentSessions.mockResolvedValue(listing([summary({ id: "a" })]));
    await render({});

    api.listAgentSessions.mockResolvedValue(listing([]));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search conversations"]',
    )!;
    expect(input.placeholder).toBe("Search conversations...");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "  billing ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(api.listAgentSessions).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flush();
    expect(api.listAgentSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "billing" }),
    );
    expect(dialogText()).toContain("No matching sessions");
  });

  it("hides the already-imported count while searching", async () => {
    api.listAgentSessions.mockResolvedValue(listing([summary({ id: "a" })], 4));
    await render({});
    expect(dialogText()).toContain("4 already in MonoCode");

    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search conversations"]',
    )!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "billing");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flush();
    expect(dialogText()).not.toContain("already in MonoCode");
  });

  it("starts on one project and can widen to every folder", async () => {
    api.listAgentSessions.mockResolvedValue(listing([summary({ id: "a" })]));
    await render({ cwd: "/Users/me/code/monocode" });
    expect(api.listAgentSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/Users/me/code/monocode" }),
    );
    expect(button("monocode").getAttribute("aria-pressed")).toBe("true");

    await act(async () => button("All folders").click());
    await flush();
    expect(api.listAgentSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: undefined }),
    );
    expect(button("All folders").getAttribute("aria-pressed")).toBe("true");
  });

  it("lists only sessions without a project under Chats", async () => {
    api.listAgentSessions.mockResolvedValue(listing([summary({ id: "a" })]));
    await render({ cwd: "/Users/me/code/monocode" });

    api.listAgentSessions.mockResolvedValue(
      listing([
        summary({
          id: "home",
          cwd: "/Users/me",
          folder: "home",
          title: "Notes",
        }),
      ]),
    );
    await act(async () => button("Chats").click());
    await flush();
    const request = api.listAgentSessions.mock.lastCall![0];
    expect(request).toMatchObject({ cwd: undefined, projectless: true });
    expect(row("Notes").textContent).toContain("No project");

    api.listAgentSessions.mockResolvedValue(listing([]));
    await act(async () => button("Refresh").click());
    await flush();
    expect(dialogText()).toContain("No sessions without a project");

    await act(async () => button("monocode").click());
    await flush();
    expect(api.listAgentSessions.mock.lastCall![0]).toMatchObject({
      cwd: "/Users/me/code/monocode",
    });
    expect(api.listAgentSessions.mock.lastCall![0].projectless).toBeUndefined();
  });

  it("shows the empty illustration when there is nothing to import", async () => {
    api.listAgentSessions.mockResolvedValue(listing([]));
    await render({});
    expect(dialogText()).toContain(
      "Sessions you start in the terminal will show up here",
    );
  });

  it("asks the listing for the time filter instead of hiding rows", async () => {
    api.listAgentSessions.mockResolvedValue({
      sessions: [summary({ id: "a", title: "Recent" })],
      importedCount: 0,
      hasMore: true,
    });
    await render({});

    await act(async () => button("Filter sessions").click());
    const today = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
    ].find((item) => item.textContent?.includes("Today"));
    expect(today).toBeDefined();
    await act(async () => today!.click());
    await flush();

    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    expect(api.listAgentSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ since: midnight.getTime(), limit: 15 }),
    );
  });

  it("gives only the filter button an expanded state", async () => {
    api.listAgentSessions.mockResolvedValue(listing([summary({ id: "a" })]));
    await render({});
    expect(button("Filter sessions").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(button("Refresh").hasAttribute("aria-expanded")).toBe(false);
  });

  it("shows each session's agent and filters by agent", async () => {
    api.listAgentSessions.mockResolvedValue(
      listing([
        summary({ id: "c", title: "From Claude" }),
        summary({ id: "p", title: "From Pi", harness: "pi" }),
      ]),
    );
    await render({});
    // Each row leads with its own agent's icon.
    const icon = (title: string) => row(title).querySelector("svg")?.outerHTML;
    expect(icon("From Pi")).toBeDefined();
    expect(icon("From Pi")).not.toBe(icon("From Claude"));
    expect(api.listAgentSessions.mock.lastCall![0].harnesses).toBeUndefined();

    await act(async () => button("Filter sessions").click());
    const claude = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
    ].find((item) => item.textContent?.includes("Claude Code"));
    expect(claude).toBeDefined();
    await act(async () => claude!.click());
    await flush();
    expect(api.listAgentSessions.mock.lastCall![0].harnesses).toEqual([
      "pi",
      "omp",
    ]);
  });

  it("opens the filter menu above the dialog", async () => {
    api.listAgentSessions.mockResolvedValue(listing([summary({ id: "a" })]));
    await render({});
    await act(async () => button("Filter sessions").click());

    const layerOf = (element: Element | null) => {
      for (let node = element; node; node = node.parentElement) {
        const z = (node as HTMLElement).style?.zIndex;
        if (z) return Number(z);
      }
      return 0;
    };
    const menu = document.querySelector(
      '[role="menu"][aria-label="Filter sessions"]',
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(menu).not.toBeNull();
    expect(layerOf(menu)).toBeGreaterThan(layerOf(dialog));
  });
});
