import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSessionLinkedWorkItems } from "./sessionStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});

describe("setSessionLinkedWorkItems", () => {
  it("persists canonical GitHub work items through the metadata command", async () => {
    await setSessionLinkedWorkItems("session-1", [
      {
        kind: "pr",
        repo: "openai/codex",
        number: 42,
        url: "https://example.com/untrusted",
      },
    ]);

    expect(invoke).toHaveBeenCalledWith("session_set_linked_work_item", {
      sessionId: "session-1",
      linkedWorkItem: {
        kind: "pr",
        repo: "openai/codex",
        number: 42,
        url: "https://github.com/openai/codex/pull/42",
      },
    });
  });

  it("keeps the rest of the links beside the card's item", async () => {
    await setSessionLinkedWorkItems("session-1", [
      {
        kind: "pr",
        repo: "openai/codex",
        number: 43,
        url: "https://github.com/openai/codex/pull/43",
      },
      {
        kind: "issue",
        repo: "openai/codex",
        number: 7,
        url: "https://github.com/openai/codex/issues/7",
      },
    ]);

    expect(invoke).toHaveBeenCalledWith("session_set_linked_work_item", {
      sessionId: "session-1",
      linkedWorkItem: {
        kind: "pr",
        repo: "openai/codex",
        number: 43,
        url: "https://github.com/openai/codex/pull/43",
        more: [
          {
            kind: "issue",
            repo: "openai/codex",
            number: 7,
            url: "https://github.com/openai/codex/issues/7",
          },
        ],
      },
    });
  });

  it("uses null to remove every persisted link", async () => {
    await setSessionLinkedWorkItems("session-1", []);

    expect(invoke).toHaveBeenCalledWith("session_set_linked_work_item", {
      sessionId: "session-1",
      linkedWorkItem: null,
    });
  });
});
