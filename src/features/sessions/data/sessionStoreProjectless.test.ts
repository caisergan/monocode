import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendUser } from "../../../integrations/harness/core/apply";
import { newSession } from "../model/session";
import {
  onProjectlessSessionsChange,
  setSessionArchived,
  upsertSession,
} from "./sessionStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("onProjectlessSessionsChange", () => {
  it("fires after saving a chat without a project or archiving any chat", async () => {
    const listener = vi.fn();
    const stop = onProjectlessSessionsChange(listener);
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "session_upsert"
        ? { ...(args as { session: object }).session, updatedAt: 1 }
        : undefined,
    );

    await upsertSession(appendUser(newSession("claude", "/work/app"), "hi"));
    expect(listener).not.toHaveBeenCalled();
    await upsertSession(appendUser(newSession("claude", "~"), "hi"));
    expect(listener).toHaveBeenCalledTimes(1);
    await setSessionArchived("chat-1", true);
    expect(listener).toHaveBeenCalledTimes(2);

    stop();
    await setSessionArchived("chat-1", false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
