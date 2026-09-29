import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../data/sessionStore";
import type { Session } from "./session";

const api = vi.hoisted(() => ({
  readClaudeSession: vi.fn(),
  listSessionsByProject: vi.fn(),
  listProjectlessSessions: vi.fn(),
  upsertSession: vi.fn(),
}));

vi.mock("../../../platform/tauri/claudeSessions", () => ({
  readClaudeSession: api.readClaudeSession,
}));
vi.mock("../data/sessionStore", () => ({
  listSessionsByProject: api.listSessionsByProject,
  listProjectlessSessions: api.listProjectlessSessions,
  upsertSession: api.upsertSession,
}));

import { importClaudeSession } from "./claudeSessionImport";

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
  api.readClaudeSession.mockResolvedValue(transcript);
  api.upsertSession.mockImplementation(async (session: Session) => session);
});

describe("importClaudeSession", () => {
  it("saves a home-folder session as a chat without a project", async () => {
    api.listProjectlessSessions.mockResolvedValue([]);

    const result = await importClaudeSession("/Users/me", "claude-1", "~");

    expect(api.readClaudeSession).toHaveBeenCalledWith("/Users/me", "claude-1");
    expect(api.listSessionsByProject).not.toHaveBeenCalled();
    const saved = api.upsertSession.mock.calls[0][0] as Session;
    expect(saved.cwd).toBe("~");
    expect(saved.providerSessionId).toBe("claude-1");
    expect(result).toEqual({ sessionId: saved.id, existing: false });
  });

  it("opens the chat that already holds the conversation", async () => {
    api.listProjectlessSessions.mockResolvedValue([
      {
        id: "mono-1",
        harness: "claude",
        providerSessionId: "claude-1",
      } as SessionSummary,
    ]);

    const result = await importClaudeSession("/Users/me", "claude-1", "~");

    expect(result).toEqual({ sessionId: "mono-1", existing: true });
    expect(api.readClaudeSession).not.toHaveBeenCalled();
    expect(api.upsertSession).not.toHaveBeenCalled();
  });
});
