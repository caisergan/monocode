// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaudeSessionListing,
  ClaudeSessionQuery,
  ClaudeSessionSummary,
} from "../../../platform/tauri/claudeSessions";

const api = vi.hoisted(() => ({
  listClaudeSessions:
    vi.fn<(request: ClaudeSessionQuery) => Promise<ClaudeSessionListing>>(),
  importClaudeSession:
    vi.fn<
      (cwd: string, id: string) => Promise<{ sessionId: string; existing: boolean }>
    >(),
}));

vi.mock("../../../platform/tauri/claudeSessions", () => ({
  listClaudeSessions: api.listClaudeSessions,
}));
vi.mock("../model/claudeSessionImport", () => ({
  importClaudeSession: api.importClaudeSession,
}));

import { ImportSessionDialog } from "./ImportSessionDialog";

const NOW = new Date("2026-09-29T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;

let container: HTMLDivElement;
let root: Root;

function summary(
  overrides: Partial<ClaudeSessionSummary> & { id: string },
): ClaudeSessionSummary {
  return {
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
  sessions: ClaudeSessionSummary[],
  importedCount = 0,
): ClaudeSessionListing {
  return { sessions, importedCount, hasMore: false };
}

function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? "";
}

function row(text: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[aria-label="Sessions"] button'),
  ].find((button) => button.textContent?.includes(text));
  expect(found, text).toBeDefined();
  return found!;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
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
  api.listClaudeSessions.mockReset();
  api.importClaudeSession.mockReset();
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
    api.listClaudeSessions.mockResolvedValue(
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

    expect(api.listClaudeSessions).toHaveBeenCalledWith({
      cwd: undefined,
      query: undefined,
      limit: 15,
      includeImported: false,
    });
    expect(dialogText()).toContain("Import session");
    expect(row("Fix the build").textContent).toContain("monocode");
    expect(row("Fix the build").textContent).toContain("2h");
    // A folder that is not a project yet shows its path.
    expect(row("restyle the header").textContent).toContain("~/code/site");
    const home = row("No project folder");
    expect(home.disabled).toBe(true);
    expect(dialogText()).toContain("3 already in MonoCode · Show");
  });

  it("imports a session and asks again before importing one still open", async () => {
    const open = vi.fn();
    api.listClaudeSessions.mockResolvedValue(
      listing([
        summary({ id: "old", title: "Older work" }),
        summary({ id: "live", title: "Live work", updatedAt: NOW - 30_000 }),
      ]),
    );
    api.importClaudeSession.mockResolvedValue({
      sessionId: "mono-1",
      existing: false,
    });
    await render({ onOpen: open });

    await act(async () => row("Older work").click());
    expect(api.importClaudeSession).toHaveBeenCalledWith(
      "/Users/me/code/monocode",
      "old",
    );
    expect(open).toHaveBeenCalledWith("mono-1", "/Users/me/code/monocode");

    await act(async () => row("Live work").click());
    expect(api.importClaudeSession).toHaveBeenCalledTimes(1);
    expect(row("Live work").textContent).toContain(
      "May still be open in the terminal",
    );
    await act(async () => row("Live work").click());
    expect(api.importClaudeSession).toHaveBeenLastCalledWith(
      "/Users/me/code/monocode",
      "live",
    );
  });

  it("opens a session MonoCode already has instead of importing it", async () => {
    const open = vi.fn();
    api.listClaudeSessions.mockResolvedValue(listing([], 1));
    await render({ onOpen: open });
    expect(dialogText()).toContain("Every recent session is already in MonoCode");

    api.listClaudeSessions.mockResolvedValue(
      listing([summary({ id: "known", title: "Known", monocodeSessionId: "m-9" })]),
    );
    await act(async () => button("Show").click());
    await flush();
    expect(api.listClaudeSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeImported: true }),
    );
    expect(row("Known").textContent).toContain("Already in MonoCode");
    await act(async () => row("Known").click());
    expect(open).toHaveBeenCalledWith("m-9", "/Users/me/code/monocode");
    expect(api.importClaudeSession).not.toHaveBeenCalled();
  });

  it("searches after a pause and says when nothing matches", async () => {
    api.listClaudeSessions.mockResolvedValue(listing([summary({ id: "a" })]));
    await render({});

    api.listClaudeSessions.mockResolvedValue(listing([]));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search conversations"]',
    )!;
    expect(input.placeholder).toBe("Search conversations...");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "  billing ",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(api.listClaudeSessions).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flush();
    expect(api.listClaudeSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "billing" }),
    );
    expect(dialogText()).toContain("No matching sessions");
  });

  it("starts on one project and can widen to every folder", async () => {
    api.listClaudeSessions.mockResolvedValue(listing([summary({ id: "a" })]));
    await render({ cwd: "/Users/me/code/monocode" });
    expect(api.listClaudeSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/Users/me/code/monocode" }),
    );
    expect(dialogText()).toContain("In monocode · Show all");

    await act(async () => button("Show all").click());
    await flush();
    expect(api.listClaudeSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: undefined }),
    );
  });

  it("shows the empty illustration when there is nothing to import", async () => {
    api.listClaudeSessions.mockResolvedValue(listing([]));
    await render({});
    expect(dialogText()).toContain(
      "Sessions you start in the terminal will show up here",
    );
  });
});
