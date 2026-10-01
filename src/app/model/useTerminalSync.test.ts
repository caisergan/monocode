// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("../../integrations/harness/core/terminalSyncRunner", () => ({
  syncTerminalSession: mocks.sync,
}));

import {
  newSession,
  type Session,
} from "../../features/sessions/model/session";
import {
  TERMINAL_SYNC_BACKOFF,
  TERMINAL_SYNC_INTERVAL_MS,
  useTerminalSync,
} from "./useTerminalSync";

let container: HTMLDivElement;
let root: Root;
let sessionsRef: { current: Session[] };
let setSessions: ReturnType<typeof vi.fn>;
let api: ReturnType<typeof useTerminalSync>;

function Harness({ sessions }: { sessions: Session[] }) {
  api = useTerminalSync({ sessions, sessionsRef, setSessions: setSessions as never });
  return null;
}

const render = (sessions: Session[]) =>
  act(async () => root.render(createElement(Harness, { sessions })));

function terminal(id = "t1", overrides: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/work/app"),
    id,
    title: "Original",
    surface: "terminal",
    providerSessionId: "conv",
    terminalSync: { prefixBlocks: 0, syncedSize: 0 },
    ...overrides,
  };
}

function chat(id = "c1"): Session {
  return { ...newSession("claude", "/work/app"), id };
}

beforeEach(async () => {
  // Only the interval: React's async act needs the other timers to be real.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.sync.mockReset();
  mocks.sync.mockResolvedValue(null);
  setSessions = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("syncing a terminal session", () => {
  it("catches a terminal session up as soon as it is loaded, not at the next check", async () => {
    const sessions = [terminal()];
    sessionsRef = { current: sessions };
    await render(sessions);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.sync.mock.calls[0][0].id).toBe("t1");
  });

  it("never reads a chat session", async () => {
    const sessions = [chat()];
    sessionsRef = { current: sessions };
    await render(sessions);
    await act(async () => void vi.advanceTimersByTime(TERMINAL_SYNC_INTERVAL_MS * 3));
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("checks again on every interval, and only a session that is still in the terminal", async () => {
    const sessions = [terminal("t1"), chat("c1")];
    sessionsRef = { current: sessions };
    await render(sessions);
    mocks.sync.mockClear();
    await act(async () => void vi.advanceTimersByTime(TERMINAL_SYNC_INTERVAL_MS));
    expect(mocks.sync.mock.calls.map(([session]) => session.id)).toEqual(["t1"]);
  });

  it("does not check while the window is hidden", async () => {
    const sessions = [terminal()];
    sessionsRef = { current: sessions };
    await render(sessions);
    mocks.sync.mockClear();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => void vi.advanceTimersByTime(TERMINAL_SYNC_INTERVAL_MS * 2));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("does not start a second read of a session while one is still running", async () => {
    let release!: (session: Session | null) => void;
    mocks.sync.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const sessions = [terminal()];
    sessionsRef = { current: sessions };
    await render(sessions);
    await act(async () => {
      void api.syncNow("t1");
      void api.syncNow("t1");
    });
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    await act(async () => release(null));
    mocks.sync.mockResolvedValue(null);
    await act(async () => void (await api.syncNow("t1")));
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it("commits what the transcript said", async () => {
    const before = terminal();
    sessionsRef = { current: [before] };
    mocks.sync.mockResolvedValue({
      ...before,
      blocks: [{ id: "start:0", role: "user", text: "hi" }],
      terminalSync: { prefixBlocks: 0, syncedSize: 9 },
    });
    await render([before]);
    await act(async () => void (await api.syncNow("t1")));
    expect(sessionsRef.current[0].blocks).toHaveLength(1);
    expect(sessionsRef.current[0].terminalSync?.syncedSize).toBe(9);
    expect(setSessions).toHaveBeenCalled();
  });

  it("commits nothing when there is nothing new", async () => {
    const before = terminal();
    sessionsRef = { current: [before] };
    await render([before]);
    setSessions.mockClear();
    await act(async () => void (await api.syncNow("t1")));
    expect(setSessions).not.toHaveBeenCalled();
    expect(sessionsRef.current[0]).toBe(before);
  });

  it("keeps a change made while the transcript was being read, and takes only the transcript's part", async () => {
    const before = terminal();
    sessionsRef = { current: [before] };
    let release!: (session: Session | null) => void;
    mocks.sync.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await render([before]);
    await act(async () => void api.syncNow("t1"));
    // The user renames the session and the conversation gets bound meanwhile.
    sessionsRef.current = [{ ...before, title: "Renamed", providerSessionId: undefined }];
    await act(async () => {
      release({
        ...before,
        title: "From the transcript",
        providerSessionId: "discovered",
        blocks: [{ id: "start:0", role: "user", text: "hi" }],
        terminalSync: { prefixBlocks: 0, syncedSize: 5 },
      });
    });
    const merged = sessionsRef.current[0];
    expect(merged.title).toBe("Renamed");
    expect(merged.providerSessionId).toBe("discovered");
    expect(merged.blocks).toHaveLength(1);
    expect(merged.terminalSync?.syncedSize).toBe(5);
  });

  it("drops a read that finishes after the session went back to chat", async () => {
    const before = terminal();
    sessionsRef = { current: [before] };
    let release!: (session: Session | null) => void;
    mocks.sync.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await render([before]);
    await act(async () => void api.syncNow("t1"));
    const backToChat = { ...before, surface: undefined, terminalSync: undefined };
    sessionsRef.current = [backToChat];
    await act(async () => {
      release({ ...before, blocks: [{ id: "start:0", role: "user", text: "late" }] });
    });
    expect(sessionsRef.current[0]).toBe(backToChat);
  });

  it("backs off from a session whose last sync was slow, but not from one that was quick", async () => {
    const sessions = [terminal("slow"), terminal("quick")];
    sessionsRef = { current: sessions };
    const SLOW_MS = 20_000;
    mocks.sync.mockImplementation(async (session: Session) => {
      if (session.id === "slow") vi.setSystemTime(Date.now() + SLOW_MS);
      return null;
    });
    await render(sessions);
    // The sync at load read the slow one for SLOW_MS.
    mocks.sync.mockClear();
    await act(async () => void vi.advanceTimersByTime(TERMINAL_SYNC_INTERVAL_MS));
    expect(mocks.sync.mock.calls.map(([session]) => session.id)).toEqual(["quick"]);

    // It is checked again once SLOW_MS * backoff has passed since it finished.
    mocks.sync.mockClear();
    await act(async () =>
      void vi.advanceTimersByTime(SLOW_MS * TERMINAL_SYNC_BACKOFF),
    );
    expect(mocks.sync.mock.calls.map(([session]) => session.id)).toContain("slow");
  });

  it("does not make an explicit sync wait, even after a slow one", async () => {
    const sessions = [terminal()];
    sessionsRef = { current: sessions };
    mocks.sync.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 60_000);
      return null;
    });
    await render(sessions);
    mocks.sync.mockClear();
    await act(async () => void (await api.syncNow("t1")));
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  it("releases its timer when it unmounts", async () => {
    const sessions = [terminal()];
    sessionsRef = { current: sessions };
    await render(sessions);
    await act(async () => root.unmount());
    mocks.sync.mockClear();
    await act(async () => void vi.advanceTimersByTime(TERMINAL_SYNC_INTERVAL_MS * 3));
    expect(mocks.sync).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});
