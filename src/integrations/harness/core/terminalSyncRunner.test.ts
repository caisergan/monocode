import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  read: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../../platform/tauri/agentSessions", () => ({
  statAgentSession: mocks.stat,
  readAgentSession: mocks.read,
  listAgentSessions: mocks.list,
}));

import {
  newSession,
  type Session,
} from "../../../features/sessions/model/session";
import { initialTerminalSync, syncTerminalSession } from "./terminalSyncRunner";

const ID = "5b0f4d3e-7c1a-4a0e-9d55-2f1c8a6b9e10";

const records = [
  {
    uuid: "r1",
    parentUuid: null,
    type: "user",
    message: { role: "user", content: "hello" },
  },
  {
    uuid: "r2",
    parentUuid: "r1",
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "hi there" }],
    },
  },
];

function terminalSession(overrides: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/work/app"),
    providerSessionId: ID,
    providerAccountId: "work",
    surface: "terminal",
    terminalSync: { prefixBlocks: 0, syncedSize: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.stat.mockReset();
  mocks.read.mockReset();
  mocks.list.mockReset();
});

describe("initialTerminalSync", () => {
  it("accounts for every block and every record the CLI has already written", async () => {
    mocks.stat.mockResolvedValue({ size: 500, modifiedAt: 1 });
    mocks.read.mockResolvedValue(records);
    const session = {
      ...terminalSession(),
      blocks: [{ id: "b1", role: "user" as const, text: "hello" }],
    };
    expect(await initialTerminalSync(session)).toEqual({
      afterRecord: "r2",
      prefixBlocks: 1,
      syncedSize: 500,
      startedAt: expect.any(Number),
    });
    expect(mocks.stat).toHaveBeenCalledWith("claude", "/work/app", ID, "work");
  });

  it("has no cursor for a conversation the CLI has not saved yet", async () => {
    mocks.stat.mockResolvedValue(null);
    expect(await initialTerminalSync(terminalSession())).toEqual({
      prefixBlocks: 0,
      syncedSize: 0,
      startedAt: expect.any(Number),
    });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("has no cursor for a session with no conversation yet", async () => {
    expect(
      await initialTerminalSync(terminalSession({ providerSessionId: undefined })),
    ).toEqual({ prefixBlocks: 0, syncedSize: 0, startedAt: expect.any(Number) });
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it("refuses to guess when a saved transcript cannot be read", async () => {
    mocks.stat.mockResolvedValue({ size: 5, modifiedAt: 1 });
    mocks.read.mockRejectedValue(new Error("too large"));
    await expect(initialTerminalSync(terminalSession())).rejects.toThrow(
      "too large",
    );
  });
});

describe("syncTerminalSession", () => {
  it("reads new records into blocks and remembers the size", async () => {
    mocks.stat.mockResolvedValue({ size: 300, modifiedAt: 2 });
    mocks.read.mockResolvedValue(records);
    const next = await syncTerminalSession(terminalSession());
    expect(next?.blocks.map((block) => block.text)).toEqual(["hello", "hi there"]);
    expect(next?.terminalSync).toEqual({ prefixBlocks: 0, syncedSize: 300 });
    expect(mocks.read).toHaveBeenCalledWith("claude", "/work/app", ID, "work");
  });

  it("does not read a transcript whose size has not changed", async () => {
    mocks.stat.mockResolvedValue({ size: 300, modifiedAt: 2 });
    const session = terminalSession({
      terminalSync: { prefixBlocks: 0, syncedSize: 300 },
    });
    expect(await syncTerminalSession(session)).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("reads from the working copy the CLI runs in", async () => {
    mocks.stat.mockResolvedValue({ size: 1, modifiedAt: 2 });
    mocks.read.mockResolvedValue(records);
    await syncTerminalSession(terminalSession({ worktreeCwd: "/work/app-wt" }));
    expect(mocks.stat.mock.calls[0][1]).toBe("/work/app-wt");
    expect(mocks.read.mock.calls[0][1]).toBe("/work/app-wt");
  });

  it("does nothing until the CLI has saved the conversation", async () => {
    mocks.stat.mockResolvedValue(null);
    expect(await syncTerminalSession(terminalSession())).toBeNull();
  });

  it("ignores chat sessions and sessions with no conversation", async () => {
    expect(
      await syncTerminalSession({ ...terminalSession(), surface: undefined }),
    ).toBeNull();
    expect(
      await syncTerminalSession(terminalSession({ providerSessionId: undefined })),
    ).toBeNull();
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it("says why it stopped when the transcript cannot be read, once", async () => {
    mocks.stat.mockResolvedValue({ size: 9, modifiedAt: 2 });
    mocks.read.mockRejectedValue(new Error("This Claude Code session is too large to import"));
    const failed = await syncTerminalSession(terminalSession());
    expect(failed?.terminalSync?.error).toMatch(/too large/);
    expect(failed?.blocks).toEqual([]);
    // The same failure again changes nothing, so it does not re-render or re-save.
    expect(await syncTerminalSession(failed!)).toBeNull();
  });

  it("clears the reason once a sync succeeds", async () => {
    mocks.stat.mockResolvedValue({ size: 9, modifiedAt: 2 });
    mocks.read.mockResolvedValue(records);
    const stuck = terminalSession({
      terminalSync: { prefixBlocks: 0, syncedSize: 9, error: "too large" },
    });
    const next = await syncTerminalSession(stuck);
    expect(next?.terminalSync?.error).toBeUndefined();
    expect(next?.blocks).toHaveLength(2);
  });
});

describe("finding a new Codex conversation", () => {
  const CODEX_ID = "01a0e30f-534b-7dc1-bfbc-204d96cc23cf";
  const STARTED = 1_790_000_000_000;

  function codexSession(overrides: Partial<Session> = {}): Session {
    return {
      ...newSession("codex", "/work/app"),
      surface: "terminal",
      terminalSync: { prefixBlocks: 0, syncedSize: 0, startedAt: STARTED },
      ...overrides,
    };
  }

  const rollout = [
    { type: "event_msg", timestamp: "2026-09-30T10:00:00Z", payload: { type: "user_message", message: "hello codex" } },
    { type: "event_msg", timestamp: "2026-09-30T10:00:01Z", payload: { type: "agent_message", message: "hi" } },
  ];

  it("binds the conversation saved since the CLI started in the session's folder", async () => {
    mocks.list.mockResolvedValue({
      sessions: [{ id: CODEX_ID, cwd: "/work/app/", monocodeSessionId: null }],
    });
    mocks.stat.mockResolvedValue({ size: 80, modifiedAt: 1 });
    mocks.read.mockResolvedValue(rollout);
    const next = await syncTerminalSession(codexSession());
    expect(next?.providerSessionId).toBe(CODEX_ID);
    expect(next?.blocks.map((block) => block.text)).toEqual(["hello codex", "hi"]);
    const query = mocks.list.mock.calls[0][0];
    expect(query.harnesses).toEqual(["codex"]);
    expect(query.cwd).toBe("/work/app");
    expect(query.since).toBeLessThan(STARTED);
    // The default listing leaves out conversations MonoCode already has.
    expect(query.includeImported).toBeUndefined();
  });

  it("does not take a conversation another MonoCode session already owns", async () => {
    mocks.list.mockResolvedValue({
      sessions: [
        { id: "other-1", cwd: "/work/app", monocodeSessionId: "s-9" },
        { id: CODEX_ID, cwd: "/work/app", monocodeSessionId: null },
      ],
    });
    mocks.stat.mockResolvedValue({ size: 80, modifiedAt: 1 });
    mocks.read.mockResolvedValue(rollout);
    expect((await syncTerminalSession(codexSession()))?.providerSessionId).toBe(CODEX_ID);
  });

  it("ignores a conversation from a different folder", async () => {
    mocks.list.mockResolvedValue({
      sessions: [{ id: CODEX_ID, cwd: "/work/other", monocodeSessionId: null }],
    });
    expect(await syncTerminalSession(codexSession())).toBeNull();
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it("waits while nothing has been saved yet", async () => {
    mocks.list.mockResolvedValue({ sessions: [] });
    expect(await syncTerminalSession(codexSession())).toBeNull();
  });

  it("looks in the session's account when it has one", async () => {
    mocks.list.mockResolvedValue({ sessions: [] });
    await syncTerminalSession(codexSession({ providerAccountId: "work" }));
    expect(mocks.list.mock.calls[0][0].providerAccountId).toBe("work");
  });

  it("does not look without knowing when the CLI started", async () => {
    const session = codexSession({ terminalSync: { prefixBlocks: 0, syncedSize: 0 } });
    expect(await syncTerminalSession(session)).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("does not guess for Claude, which is given its id up front", async () => {
    const session = {
      ...terminalSession({ providerSessionId: undefined }),
      terminalSync: { prefixBlocks: 0, syncedSize: 0, startedAt: STARTED },
    };
    expect(await syncTerminalSession(session)).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("reads a Codex rollout by the same cursor once it is bound", async () => {
    mocks.stat.mockResolvedValue({ size: 200, modifiedAt: 1 });
    mocks.read.mockResolvedValue(rollout);
    const session = codexSession({ providerSessionId: CODEX_ID });
    const first = await syncTerminalSession(session);
    expect(first?.blocks).toHaveLength(2);
    expect(first?.terminalSync?.syncedSize).toBe(200);
  });
});
