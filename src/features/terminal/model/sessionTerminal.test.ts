import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  stat: vi.fn(),
  status: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask }));
vi.mock("../../../platform/tauri/agentSessions", () => ({
  statAgentSession: mocks.stat,
}));
vi.mock("../../../platform/tauri/pty", () => ({
  getPtyStatus: mocks.status,
  killPty: mocks.kill,
}));

import {
  confirmCloseSessionTerminals,
  countLiveSessionTerminals,
  killSessionTerminal,
  sessionPtyId,
  sessionTerminalLaunch,
} from "./sessionTerminal";

const UUID = "5b0f4d3e-7c1a-4a0e-9d55-2f1c8a6b9e10";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    harness: "claude" as const,
    model: "claude:opus-5-5",
    modelSettings: {},
    runtimeMode: "supervised" as const,
    cwd: "/work/app",
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("sessionPtyId", () => {
  it("is stable per session, so a remounted view finds the same PTY", () => {
    expect(sessionPtyId("abc")).toBe("session:abc");
  });
});

describe("sessionTerminalLaunch", () => {
  it("gives a new Claude conversation an id and stores it before spawning", async () => {
    const bind = vi.fn();
    const launch = await sessionTerminalLaunch(session(), bind);
    expect(bind).toHaveBeenCalledTimes(1);
    const [sessionId, id] = bind.mock.calls[0];
    expect(sessionId).toBe("s1");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(launch.args).toEqual(expect.arrayContaining(["--session-id", id]));
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it("resumes a Claude conversation the CLI has saved", async () => {
    mocks.stat.mockResolvedValue({ size: 10, modifiedAt: 1 });
    const bind = vi.fn();
    const launch = await sessionTerminalLaunch(
      session({ providerSessionId: UUID, providerAccountId: "work" }),
      bind,
    );
    expect(mocks.stat).toHaveBeenCalledWith("claude", "/work/app", UUID, "work");
    expect(launch.args).toEqual(expect.arrayContaining(["--resume", UUID]));
    expect(launch.args).not.toContain("--session-id");
    expect(launch.providerAccountId).toBe("work");
    expect(bind).not.toHaveBeenCalled();
  });

  it("starts a bound Claude conversation the CLI has not saved yet under the same id", async () => {
    mocks.stat.mockResolvedValue(null);
    const launch = await sessionTerminalLaunch(
      session({ providerSessionId: UUID }),
      vi.fn(),
    );
    expect(launch.args).toEqual(expect.arrayContaining(["--session-id", UUID]));
    expect(launch.args).not.toContain("--resume");
  });

  it("reads the transcript from the working copy the CLI will run in", async () => {
    mocks.stat.mockResolvedValue(null);
    await sessionTerminalLaunch(
      session({ providerSessionId: UUID, worktreeCwd: "/work/app-wt" }),
      vi.fn(),
    );
    expect(mocks.stat.mock.calls[0][1]).toBe("/work/app-wt");
  });

  it("treats an unreadable transcript as not saved", async () => {
    mocks.stat.mockRejectedValue(new Error("nope"));
    const launch = await sessionTerminalLaunch(
      session({ providerSessionId: UUID }),
      vi.fn(),
    );
    expect(launch.args).toContain("--session-id");
  });

  it("starts a bare codex for a new conversation", async () => {
    const fresh = await sessionTerminalLaunch(
      session({ harness: "codex", model: "codex:gpt-5.5" }),
      vi.fn(),
    );
    expect(fresh.args).not.toContain("resume");
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it("resumes a Codex conversation it has saved", async () => {
    mocks.stat.mockResolvedValue({ size: 10, modifiedAt: 1 });
    const resumed = await sessionTerminalLaunch(
      session({ harness: "codex", model: "codex:gpt-5.5", providerSessionId: UUID }),
      vi.fn(),
    );
    expect(resumed.args.slice(0, 2)).toEqual(["resume", UUID]);
  });

  it("starts Codex fresh when the conversation it knew was never saved", async () => {
    mocks.stat.mockResolvedValue(null);
    const launch = await sessionTerminalLaunch(
      session({ harness: "codex", model: "codex:gpt-5.5", providerSessionId: UUID }),
      vi.fn(),
    );
    expect(launch.args).not.toContain("resume");
    expect(launch.args).not.toContain(UUID);
  });

  it("refuses a provider without a terminal surface", async () => {
    await expect(
      sessionTerminalLaunch(session({ harness: "cursor" }), vi.fn()),
    ).rejects.toThrow(/cannot run in a terminal/);
  });
});

describe("closing sessions with a live agent", () => {
  const chat = { id: "c1", title: "Chat", harness: "claude" as const };
  const terminal = {
    id: "t1",
    title: "Fix login",
    harness: "claude" as const,
    surface: "terminal" as const,
  };

  it("does not ask about chat sessions or terminals that already ended", async () => {
    mocks.status.mockRejectedValue(new Error("Terminal is not running"));
    expect(await confirmCloseSessionTerminals([chat, terminal])).toBe(true);
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.status).toHaveBeenCalledWith("session:t1");
  });

  it("asks when the agent is still running, and honors the answer", async () => {
    mocks.status.mockResolvedValue({ foreground: null });
    mocks.ask.mockResolvedValue(false);
    expect(await confirmCloseSessionTerminals([terminal])).toBe(false);
    expect(mocks.ask.mock.calls[0][0]).toContain("Fix login");
    mocks.ask.mockResolvedValue(true);
    expect(await confirmCloseSessionTerminals([terminal])).toBe(true);
  });
});

describe("countLiveSessionTerminals", () => {
  it("counts only terminal sessions whose agent is running", async () => {
    mocks.status.mockImplementation(async (id: string) => {
      if (id === "session:t2") throw new Error("Terminal is not running");
      return { foreground: null };
    });
    const count = await countLiveSessionTerminals([
      { id: "c1" },
      { id: "t1", surface: "terminal" },
      { id: "t2", surface: "terminal" },
      { id: "t3", surface: "terminal" },
    ]);
    expect(count).toBe(2);
    // A chat session is never asked about.
    expect(mocks.status.mock.calls.map(([id]) => id)).not.toContain("session:c1");
  });

  it("is zero without any terminal sessions", async () => {
    expect(await countLiveSessionTerminals([{ id: "c1" }])).toBe(0);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});

describe("killSessionTerminal", () => {
  it("kills the session's PTY", async () => {
    await killSessionTerminal("s9");
    expect(mocks.kill).toHaveBeenCalledWith("session:s9");
  });
});
