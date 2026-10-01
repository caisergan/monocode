// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
  accountExists: vi.fn(),
  selectedAccount: vi.fn(),
  createWorktree: vi.fn(),
  alive: vi.fn(),
  kill: vi.fn(),
  initialSync: vi.fn(),
  sync: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: mocks.ask,
  message: mocks.message,
}));
vi.mock("../../features/providers/model/providerAccounts", () => ({
  providerAccountExists: mocks.accountExists,
  selectedProviderAccountId: mocks.selectedAccount,
  supportsProviderAccounts: (harness: string) =>
    harness === "claude" || harness === "codex",
}));
vi.mock("../../features/source-control/model/worktrees", () => ({
  createWorktree: mocks.createWorktree,
  temporaryWorktreeBranchName: () => "mc/abc",
}));
vi.mock("../../features/terminal/model/sessionTerminal", () => ({
  isSessionTerminalAlive: mocks.alive,
  killSessionTerminal: mocks.kill,
}));
vi.mock("../../integrations/harness/core/terminalSyncRunner", () => ({
  initialTerminalSync: mocks.initialSync,
  syncTerminalSession: mocks.sync,
}));

import {
  newSession,
  type Session,
} from "../../features/sessions/model/session";
import { useSessionSurface } from "./useSessionSurface";

type Surface = ReturnType<typeof useSessionSurface>;

let container: HTMLDivElement;
let root: Root;
let surface: Surface;
let sessionsRef: { current: Session[] };
let setSessions: ReturnType<typeof vi.fn>;
let stopChat: ReturnType<typeof vi.fn>;

function Harness() {
  surface = useSessionSurface({
    sessionsRef,
    setSessions: setSessions as never,
    stopChat: stopChat as never,
  });
  return null;
}

function chat(overrides: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/work/app"),
    id: "s1",
    blocks: [{ id: "u1", role: "user", text: "hi" }],
    providerSessionId: "5b0f4d3e-7c1a-4a0e-9d55-2f1c8a6b9e10",
    providerAccountId: "work",
    ...overrides,
  };
}

const current = () => sessionsRef.current[0];

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const key of Object.keys(mocks) as Array<keyof typeof mocks>) {
    const value = mocks[key];
    if (typeof value === "function") (value as ReturnType<typeof vi.fn>).mockReset();
  }
  mocks.calls.length = 0;
  mocks.ask.mockResolvedValue(true);
  mocks.accountExists.mockReturnValue(true);
  mocks.alive.mockResolvedValue(false);
  mocks.kill.mockImplementation(async () => void mocks.calls.push("kill"));
  mocks.initialSync.mockImplementation(async (session: Session) => {
    mocks.calls.push("initialSync");
    return { prefixBlocks: session.blocks.length, syncedSize: 7, startedAt: 1 };
  });
  mocks.sync.mockResolvedValue(null);
  sessionsRef = { current: [chat()] };
  setSessions = vi.fn();
  stopChat = vi.fn(async () => void mocks.calls.push("stopChat"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("openInTerminal", () => {
  it("stops the chat before anything about the terminal is decided, then switches", async () => {
    let ok = false;
    await act(async () => {
      ok = await surface.openInTerminal("s1");
    });
    expect(ok).toBe(true);
    expect(mocks.calls).toEqual(["stopChat", "initialSync"]);
    expect(current().surface).toBe("terminal");
    expect(current().terminalSync).toEqual({
      prefixBlocks: 1,
      syncedSize: 7,
      startedAt: 1,
    });
    expect(setSessions).toHaveBeenCalledWith(sessionsRef.current);
  });

  it("does not touch a busy session unless the user agrees to stop it", async () => {
    sessionsRef.current = [chat({ busy: true })];
    mocks.ask.mockResolvedValue(false);
    await act(async () => void (await surface.openInTerminal("s1")));
    expect(stopChat).not.toHaveBeenCalled();
    expect(current().surface).toBeUndefined();

    mocks.ask.mockResolvedValue(true);
    await act(async () => void (await surface.openInTerminal("s1")));
    expect(stopChat).toHaveBeenCalledTimes(1);
    expect(current().surface).toBe("terminal");
    expect(current().busy).toBe(false);
  });

  it.each([
    ["an unsupported provider", { harness: "cursor" as const }],
    ["an orchestration worker", { orchestrationLeadId: "lead" }],
    ["a removed working copy", { worktreeRemoved: true }],
  ])("refuses %s without stopping anything", async (_name, overrides) => {
    sessionsRef.current = [chat(overrides)];
    let ok = true;
    await act(async () => {
      ok = await surface.openInTerminal("s1");
    });
    expect(ok).toBe(false);
    expect(mocks.message).toHaveBeenCalled();
    expect(stopChat).not.toHaveBeenCalled();
    expect(current().surface).toBeUndefined();
  });

  it("refuses a conversation on a provider account that no longer exists", async () => {
    mocks.accountExists.mockReturnValue(false);
    await act(async () => void (await surface.openInTerminal("s1")));
    expect(mocks.message.mock.calls[0][0]).toMatch(/removed provider account/);
    expect(current().surface).toBeUndefined();
  });

  it("gives a brand new conversation the project's selected account, but leaves an existing one alone", async () => {
    mocks.selectedAccount.mockReturnValue("team");
    sessionsRef.current = [chat({ providerAccountId: undefined, providerSessionId: undefined })];
    await act(async () => void (await surface.openInTerminal("s1")));
    expect(current().providerAccountId).toBe("team");

    sessionsRef.current = [chat({ providerAccountId: undefined })];
    await act(async () => void (await surface.openInTerminal("s1")));
    // It has a conversation already, and that lives in the default account.
    expect(current().providerAccountId).toBeUndefined();
  });

  it("creates the worktree before the CLI can start, and keeps it in the session", async () => {
    mocks.createWorktree.mockResolvedValue({ path: "/work/app-wt", branch: "mc/abc" });
    sessionsRef.current = [chat({ workspaceMode: "worktree", worktreeBase: "main" })];
    await act(async () => void (await surface.openInTerminal("s1")));
    expect(mocks.createWorktree).toHaveBeenCalledWith("/work/app", "mc/abc", "main", false);
    expect(current().worktreeCwd).toBe("/work/app-wt");
    expect(current().workspaceMode).toBeUndefined();
    // The sync cursor is taken from the working copy the CLI will run in.
    expect(mocks.initialSync.mock.calls[0][0].worktreeCwd).toBe("/work/app-wt");
  });

  it("leaves the session as chat, and says why, when the worktree cannot be created", async () => {
    mocks.createWorktree.mockRejectedValue(new Error("branch exists"));
    sessionsRef.current = [chat({ workspaceMode: "worktree" })];
    let ok = true;
    await act(async () => {
      ok = await surface.openInTerminal("s1");
    });
    expect(ok).toBe(false);
    expect(current().surface).toBeUndefined();
    expect(mocks.message.mock.calls[0][0]).toMatch(/branch exists/);
  });

  it("does not switch when the existing transcript cannot be read", async () => {
    mocks.initialSync.mockRejectedValue(new Error("too large"));
    let ok = true;
    await act(async () => {
      ok = await surface.openInTerminal("s1");
    });
    expect(ok).toBe(false);
    expect(current().surface).toBeUndefined();
  });

  it("ignores a second request while the first is still moving the session", async () => {
    let release!: () => void;
    stopChat.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    let first!: Promise<boolean>;
    let second = true;
    await act(async () => {
      first = surface.openInTerminal("s1");
      second = await surface.openInTerminal("s1");
    });
    expect(second).toBe(false);
    await act(async () => {
      release();
      await first;
    });
    expect(stopChat).toHaveBeenCalledTimes(1);
  });
});

describe("openAsChat", () => {
  function terminalSession(overrides: Partial<Session> = {}) {
    return chat({
      surface: "terminal",
      terminalSync: { prefixBlocks: 1, syncedSize: 7 },
      ...overrides,
    });
  }

  it("does nothing for a session that is not in the terminal", async () => {
    let ok = true;
    await act(async () => {
      ok = await surface.openAsChat("s1");
    });
    expect(ok).toBe(false);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("keeps the agent running if the user declines", async () => {
    sessionsRef.current = [terminalSession()];
    mocks.alive.mockResolvedValue(true);
    mocks.ask.mockResolvedValue(false);
    await act(async () => void (await surface.openAsChat("s1")));
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(current().surface).toBe("terminal");
  });

  it("does not ask when the agent has already exited", async () => {
    sessionsRef.current = [terminalSession()];
    await act(async () => void (await surface.openAsChat("s1")));
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(current().surface).toBeUndefined();
  });

  it("stops the agent, then reads what it wrote, then hands the session to chat", async () => {
    sessionsRef.current = [terminalSession()];
    mocks.alive.mockResolvedValue(true);
    mocks.sync.mockImplementation(async (session: Session) => {
      mocks.calls.push("sync");
      return {
        ...session,
        blocks: [...session.blocks, { id: "t:0", role: "assistant" as const, text: "from the CLI" }],
      };
    });
    await act(async () => void (await surface.openAsChat("s1")));
    expect(mocks.calls).toEqual(["kill", "sync"]);
    expect(current().surface).toBeUndefined();
    expect(current().terminalSync).toBeUndefined();
    expect(current().blocks.map((block) => block.text)).toEqual(["hi", "from the CLI"]);
    expect(current().providerSessionId).toBe("5b0f4d3e-7c1a-4a0e-9d55-2f1c8a6b9e10");
  });

  it("still returns to chat when the final read fails", async () => {
    sessionsRef.current = [terminalSession()];
    mocks.sync.mockRejectedValue(new Error("unreadable"));
    await act(async () => void (await surface.openAsChat("s1")));
    expect(current().surface).toBeUndefined();
    expect(current().blocks).toHaveLength(1);
  });
});

describe("bindProviderSession", () => {
  it("stores the id once, and does not rewrite the session for the same id", () => {
    surface.bindProviderSession("s1", "new-id");
    expect(current().providerSessionId).toBe("new-id");
    expect(setSessions).toHaveBeenCalledTimes(1);
    surface.bindProviderSession("s1", "new-id");
    expect(setSessions).toHaveBeenCalledTimes(1);
    surface.bindProviderSession("missing", "x");
    expect(setSessions).toHaveBeenCalledTimes(1);
  });
});
