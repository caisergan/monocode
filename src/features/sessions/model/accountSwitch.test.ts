// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  planProviderAccountSwitch,
  sessionOnProviderAccount,
} from "./accountSwitch";
import { pendingHandoff } from "./handoff";
import { newSession, type Session } from "./session";

function conversation(patch: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/work/app"),
    blocks: [
      { id: "u1", role: "user", text: "Fix the login form" },
      { id: "a1", role: "assistant", text: "Fixed the validation." },
    ],
    providerSessionId: "d35a3d8b-d7b9-4b7a-b919-01cd52ccd01a",
    providerAccountId: "account-work",
    ...patch,
  };
}

describe("planProviderAccountSwitch", () => {
  it("assigns an empty conversation either way", () => {
    const empty = newSession("claude", "/work/app");
    expect(planProviderAccountSwitch(empty, false)).toEqual({ kind: "assign" });
    expect(planProviderAccountSwitch(empty, true)).toEqual({ kind: "assign" });
  });

  it("opens a new conversation while the setting is off", () => {
    expect(planProviderAccountSwitch(conversation(), false)).toEqual({
      kind: "new",
    });
  });

  it("moves the conversation when the setting is on", () => {
    expect(planProviderAccountSwitch(conversation(), true)).toEqual({
      kind: "move",
      providerSessionId: "d35a3d8b-d7b9-4b7a-b919-01cd52ccd01a",
      fromAccountId: "account-work",
    });
  });

  it("moves a conversation that predates account pinning from the default account", () => {
    const plan = planProviderAccountSwitch(
      conversation({ providerAccountId: undefined }),
      true,
    );
    expect(plan).toMatchObject({ kind: "move", fromAccountId: "default" });
  });

  it("does not move a running or terminal conversation", () => {
    expect(
      planProviderAccountSwitch(conversation({ busy: true }), true),
    ).toEqual({ kind: "new" });
    expect(
      planProviderAccountSwitch(conversation({ surface: "terminal" }), true),
    ).toEqual({ kind: "new" });
  });

  it("assigns a conversation that never reached the provider", () => {
    expect(
      planProviderAccountSwitch(
        conversation({ providerSessionId: undefined }),
        true,
      ),
    ).toEqual({ kind: "assign" });
  });
});

describe("sessionOnProviderAccount", () => {
  it("keeps the provider thread when the transcript was copied", () => {
    const moved = sessionOnProviderAccount(
      conversation(),
      "account-home",
      true,
    );
    expect(moved.providerAccountId).toBe("account-home");
    expect(moved.providerSessionId).toBe(
      "d35a3d8b-d7b9-4b7a-b919-01cd52ccd01a",
    );
    expect(moved.blocks).toHaveLength(2);
  });

  it("starts a fresh thread with a recap when the copy failed", () => {
    const moved = sessionOnProviderAccount(
      conversation(),
      "account-home",
      false,
    );
    expect(moved.providerAccountId).toBe("account-home");
    expect(moved.providerSessionId).toBeUndefined();
    const recap = pendingHandoff(moved);
    expect(recap?.text).toContain("moved to another Claude Code account");
    expect(recap?.text).toContain("Fix the login form");
  });
});
