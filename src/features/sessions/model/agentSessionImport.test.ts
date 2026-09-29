import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../data/sessionStore";
import type { Session } from "./session";

const api = vi.hoisted(() => ({
  readAgentSession: vi.fn(),
  listSessionsByProject: vi.fn(),
  listProjectlessSessions: vi.fn(),
  upsertSession: vi.fn(),
}));

vi.mock("../../../platform/tauri/agentSessions", () => ({
  readAgentSession: api.readAgentSession,
}));
vi.mock("../data/sessionStore", () => ({
  listSessionsByProject: api.listSessionsByProject,
  listProjectlessSessions: api.listProjectlessSessions,
  upsertSession: api.upsertSession,
}));

import type { AgentSessionSummary } from "../../../platform/tauri/agentSessions";
import {
  agentImportPlan,
  folderGoneNotice,
  importAgentSession,
} from "./agentSessionImport";

const transcript = [
  {
    uuid: "u1",
    parentUuid: null,
    type: "user",
    message: { role: "user", content: "rename my photos" },
  },
];

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.readAgentSession.mockResolvedValue(transcript);
  api.upsertSession.mockImplementation(async (session: Session) => session);
});

function summary(overrides: Partial<AgentSessionSummary> & { id: string }) {
  return {
    harness: "claude" as const,
    cwd: "/Users/me/code/app",
    folder: "ok" as const,
    project: null,
    gitBranch: null,
    ...overrides,
  };
}

describe("agentImportPlan", () => {
  it("places a session where MonoCode would have run it", () => {
    expect(agentImportPlan(summary({ id: "a" }))).toEqual({
      cwd: "/Users/me/code/app",
      resumable: true,
    });
    expect(
      agentImportPlan(
        summary({
          id: "b",
          cwd: "/Users/me/code/app/.worktrees/fix",
          project: "/Users/me/code/app",
          gitBranch: "fix",
        }),
      ),
    ).toEqual({
      cwd: "/Users/me/code/app",
      worktreeCwd: "/Users/me/code/app/.worktrees/fix",
      branch: "fix",
      resumable: true,
    });
    expect(
      agentImportPlan(summary({ id: "c", cwd: "/Users/me", folder: "home" })),
    ).toEqual({ cwd: "~", resumable: true });
    expect(agentImportPlan(summary({ id: "d", folder: "missing" }))).toEqual({
      cwd: "~",
      resumable: false,
    });
  });
});

describe("importAgentSession", () => {
  it("saves a home-folder session as a chat without a project", async () => {
    api.listProjectlessSessions.mockResolvedValue([]);

    const result = await importAgentSession(
      summary({ id: "claude-1", cwd: "/Users/me", folder: "home" }),
    );

    expect(api.readAgentSession).toHaveBeenCalledWith(
      "claude",
      "/Users/me",
      "claude-1",
    );
    expect(api.listSessionsByProject).not.toHaveBeenCalled();
    const saved = api.upsertSession.mock.calls[0][0] as Session;
    expect(saved.cwd).toBe("~");
    expect(saved.providerSessionId).toBe("claude-1");
    expect(result).toEqual({ sessionId: saved.id, cwd: "~", existing: false });
  });

  it("joins a worktree session to its project", async () => {
    api.listSessionsByProject.mockResolvedValue([]);
    const worktree = "/Users/me/code/app/.worktrees/fix";

    await importAgentSession(
      summary({
        id: "claude-3",
        cwd: worktree,
        project: "/Users/me/code/app",
        gitBranch: "fix",
      }),
    );

    expect(api.listSessionsByProject).toHaveBeenCalledWith(
      "/Users/me/code/app",
    );
    expect(api.readAgentSession).toHaveBeenCalledWith(
      "claude",
      worktree,
      "claude-3",
    );
    const saved = api.upsertSession.mock.calls[0][0] as Session;
    expect(saved.cwd).toBe("/Users/me/code/app");
    expect(saved.worktreeCwd).toBe(worktree);
    expect(saved.branch).toBe("fix");
    expect(saved.providerSessionId).toBe("claude-3");
  });

  it("keeps a session whose folder is gone without resuming it", async () => {
    api.listProjectlessSessions.mockResolvedValue([]);

    const result = await importAgentSession(
      summary({ id: "claude-4", cwd: "/Users/me/gone", folder: "missing" }),
    );

    const saved = api.upsertSession.mock.calls[0][0] as Session;
    expect(saved.id).toBe("claude-4");
    expect(saved.cwd).toBe("~");
    expect(saved.providerSessionId).toBeUndefined();
    expect(saved.blocks.at(-1)).toMatchObject({
      role: "system",
      text: folderGoneNotice("claude"),
    });
    expect(result).toEqual({
      sessionId: "claude-4",
      cwd: "~",
      existing: false,
    });

    // Importing it again opens that chat, found by its own id.
    api.upsertSession.mockClear();
    api.listProjectlessSessions.mockResolvedValue([
      { id: "claude-4", harness: "claude" } as SessionSummary,
    ]);
    await expect(
      importAgentSession(
        summary({ id: "claude-4", cwd: "/Users/me/gone", folder: "missing" }),
      ),
    ).resolves.toEqual({ sessionId: "claude-4", cwd: "~", existing: true });
    expect(api.upsertSession).not.toHaveBeenCalled();
  });

  it("opens the chat that already holds the conversation", async () => {
    api.listProjectlessSessions.mockResolvedValue([
      {
        id: "mono-1",
        harness: "claude",
        providerSessionId: "claude-1",
      } as SessionSummary,
    ]);

    const result = await importAgentSession(
      summary({ id: "claude-1", cwd: "/Users/me", folder: "home" }),
    );

    expect(result).toEqual({ sessionId: "mono-1", cwd: "~", existing: true });
    expect(api.readAgentSession).not.toHaveBeenCalled();
    expect(api.upsertSession).not.toHaveBeenCalled();
  });

  it("imports a Pi session through Pi's converter and resumes it", async () => {
    api.listSessionsByProject.mockResolvedValue([
      // A Claude chat with the same id is not this Pi conversation.
      {
        id: "m",
        harness: "claude",
        providerSessionId: "pi-1",
      } as SessionSummary,
    ]);
    api.readAgentSession.mockResolvedValue([
      { type: "session", version: 3, id: "pi-1", cwd: "/Users/me/code/app" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "tidy up" }] },
      },
    ]);

    const result = await importAgentSession(
      summary({ id: "pi-1", harness: "pi" }),
    );

    expect(api.readAgentSession).toHaveBeenCalledWith(
      "pi",
      "/Users/me/code/app",
      "pi-1",
    );
    const saved = api.upsertSession.mock.calls[0][0] as Session;
    expect(saved.harness).toBe("pi");
    expect(saved.providerSessionId).toBe("pi-1");
    expect(saved.blocks[0]).toMatchObject({ role: "user", text: "tidy up" });
    expect(result.existing).toBe(false);
  });
});
