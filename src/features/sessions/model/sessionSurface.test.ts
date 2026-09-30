import { describe, expect, it } from "vitest";
import { isBlankSession } from "../../projects/model/projectReturn";
import { shouldPersistSession } from "../data/sessionStore";
import { newSession, type Session } from "./session";
import {
  terminalRefusal,
  withChatSurface,
  withTerminalSurface,
} from "./sessionSurface";

const chat = (harness: "claude" | "codex" | "cursor" = "claude"): Session => ({
  ...newSession(harness, "/work/app"),
  blocks: [{ id: "u1", role: "user", text: "hi" }],
});

describe("terminalRefusal", () => {
  it("allows Claude Code and Codex chats", () => {
    expect(terminalRefusal(chat("claude"))).toBeNull();
    expect(terminalRefusal(chat("codex"))).toBeNull();
  });

  it("refuses other providers", () => {
    expect(terminalRefusal(chat("cursor"))).toMatch(/Claude Code and Codex/);
  });

  it("refuses a session that is already in the terminal", () => {
    const terminal = withTerminalSurface(chat(), { prefixBlocks: 1, syncedSize: 0 });
    expect(terminalRefusal(terminal)).toMatch(/already/);
  });

  it("refuses internal workers, inbox chats, removed worktrees and pending handoffs", () => {
    expect(terminalRefusal({ ...chat(), orchestrationLeadId: "lead" })).not.toBeNull();
    expect(
      terminalRefusal({
        ...chat(),
        inboxAsk: { kind: "issue", repo: "a/b", number: 1, title: "t", url: "u" } as never,
      }),
    ).not.toBeNull();
    expect(terminalRefusal({ ...chat(), worktreeRemoved: true })).toMatch(/working copy/);
    expect(
      terminalRefusal({
        ...chat(),
        pendingSwitch: { from: "codex" } as never,
      }),
    ).toMatch(/handoff/);
  });

  it("does not refuse a busy session, which the caller offers to stop", () => {
    expect(terminalRefusal({ ...chat(), busy: true })).toBeNull();
  });
});

describe("moving between surfaces", () => {
  it("keeps every block and takes over the sync cursor", () => {
    const session = chat();
    const terminal = withTerminalSurface(session, {
      afterRecord: "r1",
      prefixBlocks: 1,
      syncedSize: 42,
    });
    expect(terminal.surface).toBe("terminal");
    expect(terminal.blocks).toBe(session.blocks);
    expect(terminal.terminalSync).toEqual({
      afterRecord: "r1",
      prefixBlocks: 1,
      syncedSize: 42,
    });
  });

  it("drops the chat's in-flight state when the terminal takes over", () => {
    const terminal = withTerminalSurface(
      {
        ...chat(),
        busy: true,
        queuedMessages: [{ id: "q", text: "later" } as never],
        queueStatus: "paused",
      },
      { prefixBlocks: 1, syncedSize: 0 },
    );
    expect(terminal.busy).toBe(false);
    expect(terminal.queuedMessages).toBeUndefined();
    expect(terminal.queueStatus).toBeUndefined();
  });

  it("goes back to chat cleanly, leaving the conversation binding", () => {
    const terminal = withTerminalSurface(
      { ...chat(), providerSessionId: "abc" },
      { prefixBlocks: 1, syncedSize: 0 },
    );
    const back = withChatSurface(terminal);
    expect(back).not.toHaveProperty("surface");
    expect(back).not.toHaveProperty("terminalSync");
    expect(back.providerSessionId).toBe("abc");
  });
});

describe("a terminal session before its first prompt is read back", () => {
  const fresh = (providerSessionId?: string): Session =>
    withTerminalSurface(
      { ...newSession("claude", "/work/app"), providerSessionId },
      { prefixBlocks: 0, syncedSize: 0 },
    );

  it("is not a blank tab that can be replaced", () => {
    expect(isBlankSession(newSession("claude", "/work/app"))).toBe(true);
    expect(isBlankSession(fresh())).toBe(false);
  });

  it("is saved once bound to a conversation, so a restart can resume it", () => {
    expect(shouldPersistSession(fresh())).toBe(false);
    expect(shouldPersistSession(fresh("5b0f4d3e-7c1a-4a0e-9d55-2f1c8a6b9e10"))).toBe(true);
    expect(shouldPersistSession(newSession("claude", "/work/app"))).toBe(false);
  });
});
