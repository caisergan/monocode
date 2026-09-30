import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendUser } from "../../../integrations/harness/core/apply";
import { newSession, type Session } from "../model/session";
import { summaryFromSession } from "./sessionHistory";
import {
  getSession,
  persistFingerprint,
  sanitizeSessionForPersist,
  sanitizeTerminalSync,
} from "./sessionStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

function terminalSession(): Session {
  return {
    ...appendUser(newSession("claude", "/work/app"), "hi"),
    surface: "terminal",
    terminalSync: { afterRecord: "r9", prefixBlocks: 2, syncedSize: 4096 },
  };
}

const RECORD = {
  id: "s1",
  cwd: "/work/app",
  harness: "claude",
  model: "claude:opus-5-5",
  modelSettings: {},
  runtimeMode: "supervised",
  title: "Session",
  blocks: [],
  createdAt: 1,
  updatedAt: 2,
};

describe("terminal surface persistence", () => {
  it("saves the surface and sync cursor of a terminal session", () => {
    const payload = sanitizeSessionForPersist(terminalSession());
    expect(payload.surface).toBe("terminal");
    expect(payload.terminalSync).toEqual({
      afterRecord: "r9",
      prefixBlocks: 2,
      syncedSize: 4096,
    });
  });

  it("saves nothing extra for a chat session, even one that kept a cursor", () => {
    const chat: Session = {
      ...terminalSession(),
      surface: "chat",
    };
    const payload = sanitizeSessionForPersist(chat);
    expect(payload).not.toHaveProperty("surface");
    expect(payload).not.toHaveProperty("terminalSync");
  });

  it("reads a terminal record back with its cursor", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...RECORD,
      surface: "terminal",
      terminalSync: { afterRecord: "r9", prefixBlocks: 2, syncedSize: 4096 },
    });
    const session = await getSession("s1");
    expect(session?.surface).toBe("terminal");
    expect(session?.terminalSync).toEqual({
      afterRecord: "r9",
      prefixBlocks: 2,
      syncedSize: 4096,
    });
  });

  it("reads a terminal record with a missing cursor as a full replay", async () => {
    vi.mocked(invoke).mockResolvedValue({ ...RECORD, surface: "terminal" });
    const session = await getSession("s1");
    expect(session?.terminalSync).toEqual({ prefixBlocks: 0, syncedSize: 0 });
  });

  it("reads an old record, with no surface, as a chat session", async () => {
    vi.mocked(invoke).mockResolvedValue(RECORD);
    const session = await getSession("s1");
    expect(session?.surface).toBeUndefined();
    expect(session?.terminalSync).toBeUndefined();
  });

  it("ignores a surface it does not know", async () => {
    vi.mocked(invoke).mockResolvedValue({ ...RECORD, surface: "browser" });
    expect((await getSession("s1"))?.surface).toBeUndefined();
  });

  it("re-saves when the surface changes", () => {
    const chat = appendUser(newSession("claude", "/work/app"), "hi");
    expect(persistFingerprint({ ...chat, surface: "terminal" })).not.toBe(
      persistFingerprint(chat),
    );
  });

  it("marks the sidebar row of a terminal session", () => {
    expect(summaryFromSession(terminalSession()).surface).toBe("terminal");
    expect(
      summaryFromSession(newSession("claude", "/work/app")),
    ).not.toHaveProperty("surface");
  });
});

describe("sanitizeTerminalSync", () => {
  it("clamps garbage to a full replay", () => {
    expect(
      sanitizeTerminalSync({ afterRecord: 5, prefixBlocks: -1, syncedSize: "x" }),
    ).toEqual({ prefixBlocks: 0, syncedSize: 0 });
    expect(sanitizeTerminalSync(null)).toBeUndefined();
    expect(sanitizeTerminalSync([])).toBeUndefined();
  });
});
