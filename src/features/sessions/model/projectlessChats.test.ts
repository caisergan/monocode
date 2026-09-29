// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  shouldPersistSession,
  type SessionSummary,
} from "../data/sessionStore";
import {
  loadChatsHidden,
  mergeProjectlessChats,
  saveChatsHidden,
} from "./projectlessChats";
import { newSession, type Session } from "./session";

function saved(
  id: string,
  updatedAt: number,
  extra: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    cwd: "~",
    harness: "claude",
    model: "",
    runtimeMode: "default",
    title: `Saved ${id}`,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  } as SessionSummary;
}

function open(id: string, extra: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "~"),
    id,
    title: `Open ${id}`,
    blocks: [{ id: `${id}-u`, role: "user", text: "hi" }],
    ...extra,
  };
}

describe("mergeProjectlessChats", () => {
  it("lists saved chats, with live titles and busy state for open ones", () => {
    const chats = mergeProjectlessChats(
      [saved("a", 200), saved("b", 100)],
      [open("b", { busy: true })],
    );
    expect(chats).toEqual([
      {
        id: "a",
        title: "Saved a",
        harness: "claude",
        updatedAt: 200,
        busy: false,
      },
      {
        id: "b",
        title: "Open b",
        harness: "claude",
        updatedAt: 100,
        busy: true,
      },
    ]);
  });

  it("leads with open chats that are not saved yet", () => {
    const chats = mergeProjectlessChats([saved("a", 200)], [open("new")]);
    expect(chats.map((chat) => chat.id)).toEqual(["new", "a"]);
    expect(chats[0].updatedAt).toBeUndefined();
  });

  it("leaves out archived and draft rows, blank tabs, project chats and Ask", () => {
    const chats = mergeProjectlessChats(
      [
        saved("archived", 3, { archived: true }),
        saved("draft", 2, { draft: true }),
      ],
      [
        open("blank", { blocks: [] }),
        open("project", { cwd: "/work/site" }),
        open("worker", { orchestrationLeadId: "lead" }),
      ],
    );
    expect(chats).toEqual([]);
  });
});

describe("projectless chat persistence", () => {
  afterEach(() => localStorage.clear());

  it("saves a chat without a project once it has a message", () => {
    expect(shouldPersistSession(open("chat"))).toBe(true);
    expect(shouldPersistSession(open("blank", { blocks: [] }))).toBe(false);
  });

  it("remembers whether the Chats section is hidden", () => {
    expect(loadChatsHidden()).toBe(false);
    saveChatsHidden(true);
    expect(loadChatsHidden()).toBe(true);
    saveChatsHidden(false);
    expect(loadChatsHidden()).toBe(false);
  });
});
