import { describe, expect, it } from "vitest";
import { RESULT_UNKNOWN, runMutation } from "../../outbox/mutate";
import {
  COMMIT_TIMEOUT_MS,
  commitAndPush,
  commitState,
  gitWritable,
  projectRunning,
  PUSH_TIMEOUT_MS,
  STAGE_TIMEOUT_MS,
  stageChanges,
  stageState,
  type Mutate,
} from "../git";
import type { GitChangedFile, GitDiffIndex } from "../types";

const failure = (code: string, retryable: boolean, message = code) => Object.assign(new Error(message), { code, retryable });

type Call = { method: string; params: Record<string, unknown>; timeoutMs: number; key?: string };

/** The outbox's `mutate` over a scripted host: the same `runMutation` with
 * a fake clock, so retries take no time. */
function harness(answers: Record<string, (() => unknown)[]>) {
  const calls: Call[] = [];
  let keys = 0;
  let t = 0;
  const mutate: Mutate = (method, params, timeoutMs) =>
    runMutation({
      idempotent: true,
      newKey: () => `key-${++keys}`,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      request: async (key) => {
        calls.push({ method, params, timeoutMs, key });
        const next = answers[String(params.action)]?.shift();
        if (!next) throw failure("offline", true);
        return next();
      },
    });
  let refreshes = 0;
  const refresh = async () => {
    refreshes++;
  };
  return { calls, mutate, refresh, refreshes: () => refreshes };
}

const ok = () => null;
const scope = { env: "env-1", projectId: "p-app", cwd: "/work/fix-auth" };

describe("commit and push", () => {
  it("send git.action through mutate, reusing one key across a commit's retries", async () => {
    const host = harness({
      commit: [
        () => {
          throw failure("offline", true);
        },
        () => {
          throw failure("branch_switching", true);
        },
        ok,
      ],
      push: [ok],
    });
    const result = await commitAndPush(host.mutate, scope, "Fix the token race", true, host.refresh);
    expect(result).toEqual({ committed: true, pushed: true });
    expect(host.calls.map((call) => [call.params.action, call.key])).toEqual([
      ["commit", "key-1"],
      ["commit", "key-1"],
      ["commit", "key-1"],
      ["push", "key-2"],
    ]);
    expect(host.calls[0]).toMatchObject({
      method: "git.action",
      params: { projectId: "p-app", cwd: "/work/fix-auth", action: "commit", message: "Fix the token race" },
    });
    expect(host.calls[3].params).toEqual({ projectId: "p-app", cwd: "/work/fix-auth", action: "push" });
  });

  it("gives push 120 s and commit the 60 s mutation timeout", async () => {
    const host = harness({ commit: [ok], push: [ok] });
    await commitAndPush(host.mutate, scope, "msg", true, host.refresh);
    expect(host.calls.map((call) => [call.params.action, call.timeoutMs])).toEqual([
      ["commit", 60_000],
      ["push", 120_000],
    ]);
    expect(PUSH_TIMEOUT_MS).toBe(120_000);
    expect(COMMIT_TIMEOUT_MS).toBe(60_000);
  });

  it("refreshes the index after the commit and after the push", async () => {
    const host = harness({ commit: [ok], push: [ok] });
    await commitAndPush(host.mutate, scope, "msg", true, host.refresh);
    expect(host.refreshes()).toBe(2);
  });

  it("commits without pushing, and without a cwd for the project folder", async () => {
    const host = harness({ commit: [ok] });
    const result = await commitAndPush(host.mutate, { env: "env-1", projectId: "p-app" }, "msg", false, host.refresh);
    expect(result).toEqual({ committed: true, pushed: false });
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].params).toEqual({ projectId: "p-app", action: "commit", message: "msg" });
    expect(host.refreshes()).toBe(1);
  });

  it("shows a host refusal, still refreshes, and never pushes", async () => {
    const host = harness({
      commit: [
        () => {
          throw failure("session_busy", false, "Wait for running host sessions before switching branches");
        },
      ],
      push: [ok],
    });
    const result = await commitAndPush(host.mutate, scope, "msg", true, host.refresh);
    expect(result).toEqual({ committed: false, pushed: false, error: "Wait for running host sessions before switching branches" });
    expect(host.calls).toHaveLength(1);
    expect(host.refreshes()).toBe(1);
  });

  it("says Result unknown when the retry window runs out", async () => {
    const host = harness({ commit: [] });
    const result = await commitAndPush(host.mutate, scope, "msg", true, host.refresh);
    expect(result).toEqual({ committed: false, pushed: false, error: RESULT_UNKNOWN });
    expect(new Set(host.calls.map((call) => call.key))).toEqual(new Set(["key-1"]));
    expect(host.refreshes()).toBe(1);
  });

  it("keeps the commit when only the push fails", async () => {
    const host = harness({ commit: [ok], push: [] });
    const result = await commitAndPush(host.mutate, scope, "msg", true, host.refresh);
    expect(result).toEqual({ committed: true, pushed: false, error: RESULT_UNKNOWN });
    expect(host.calls.filter((call) => call.params.action === "push").every((call) => call.key === "key-2")).toBe(true);
    expect(host.refreshes()).toBe(2);
  });
});

describe("staging", () => {
  it("sends stage and unstage for one file through mutate, reusing the key across retries", async () => {
    const host = harness({
      stage: [
        () => {
          throw failure("offline", true);
        },
        ok,
      ],
      unstage: [ok],
    });
    expect(await stageChanges(host.mutate, scope, { action: "stage", path: "src/a.ts" }, host.refresh)).toEqual({ done: true });
    expect(await stageChanges(host.mutate, scope, { action: "unstage", path: "src/b.ts" }, host.refresh)).toEqual({ done: true });
    expect(host.calls.map((call) => [call.method, call.params, call.key, call.timeoutMs])).toEqual([
      ["git.action", { projectId: "p-app", cwd: "/work/fix-auth", action: "stage", path: "src/a.ts" }, "key-1", 60_000],
      ["git.action", { projectId: "p-app", cwd: "/work/fix-auth", action: "stage", path: "src/a.ts" }, "key-1", 60_000],
      ["git.action", { projectId: "p-app", cwd: "/work/fix-auth", action: "unstage", path: "src/b.ts" }, "key-2", 60_000],
    ]);
    expect(STAGE_TIMEOUT_MS).toBe(60_000);
    expect(host.refreshes()).toBe(2);
  });

  it("sends stage all and unstage all without a path", async () => {
    const host = harness({ stageAll: [ok], unstageAll: [ok] });
    await stageChanges(host.mutate, { env: "env-1", projectId: "p-app" }, { action: "stageAll" }, host.refresh);
    await stageChanges(host.mutate, { env: "env-1", projectId: "p-app" }, { action: "unstageAll" }, host.refresh);
    expect(host.calls.map((call) => call.params)).toEqual([
      { projectId: "p-app", action: "stageAll" },
      { projectId: "p-app", action: "unstageAll" },
    ]);
  });

  it("shows a host refusal and still refreshes", async () => {
    const host = harness({
      stageAll: [
        () => {
          throw failure("session_busy", false, "Wait for running host sessions before switching branches");
        },
      ],
    });
    expect(await stageChanges(host.mutate, scope, { action: "stageAll" }, host.refresh)).toEqual({
      done: false,
      error: "Wait for running host sessions before switching branches",
    });
    expect(host.calls).toHaveLength(1);
    expect(host.refreshes()).toBe(1);
  });

  it("says Result unknown when the retry window runs out", async () => {
    const host = harness({ unstage: [] });
    expect(await stageChanges(host.mutate, scope, { action: "unstage", path: "src/a.ts" }, host.refresh)).toEqual({ done: false, error: RESULT_UNKNOWN });
    expect(new Set(host.calls.map((call) => call.key))).toEqual(new Set(["key-1"]));
    expect(host.refreshes()).toBe(1);
  });
});

const change = (patch: Partial<GitChangedFile> = {}): GitChangedFile => ({
  path: "src/a.ts",
  relative: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  staged: true,
  unstaged: false,
  ...patch,
});

const index = (patch: Partial<GitDiffIndex> = {}): GitDiffIndex => ({
  branch: "fix/auth",
  head: "abc",
  files: [change()],
  additions: 1,
  deletions: 0,
  remote: "origin",
  upstream: "origin/fix/auth",
  defaultBranch: "main",
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  headPushed: true,
  ...patch,
});

describe("when Commit is enabled", () => {
  const ready = { message: "Fix it", index: index(), running: false, busy: false, capable: true };

  it("allows commit and commit and push when idle with staged changes and a message", () => {
    expect(commitState(ready)).toEqual({ canCommit: true, canCommitPush: true });
  });

  it("disables both while a session in the project runs", () => {
    expect(commitState({ ...ready, running: true })).toEqual({ canCommit: false, canCommitPush: false });
  });

  it("disables both while a commit is in flight, or without git.action", () => {
    expect(commitState({ ...ready, busy: true }).canCommit).toBe(false);
    expect(commitState({ ...ready, capable: false }).canCommit).toBe(false);
  });

  it("needs a message and something staged, like the desktop", () => {
    expect(commitState({ ...ready, message: "   " }).canCommit).toBe(false);
    expect(commitState({ ...ready, index: index({ files: [change({ staged: false, unstaged: true })] }) }).canCommit).toBe(false);
    expect(commitState({ ...ready, index: undefined }).canCommit).toBe(false);
  });

  it("needs a remote and no divergence to push", () => {
    expect(commitState({ ...ready, index: index({ remote: null }) })).toEqual({ canCommit: true, canCommitPush: false });
    expect(commitState({ ...ready, index: index({ ahead: 1, behind: 2 }) })).toEqual({ canCommit: true, canCommitPush: false });
  });
});

describe("when staging is enabled", () => {
  const mixed = index({ files: [change({ relative: "a.ts", staged: true }), change({ relative: "b.ts", staged: false, unstaged: true })] });
  const ready = { index: mixed, running: false, busy: false, capable: true };

  it("allows every staging action when idle", () => {
    expect(stageState(ready)).toEqual({ canStage: true, canStageAll: true, canUnstageAll: true });
  });

  it("disables all of them while a session runs or another Git action is in flight", () => {
    const none = { canStage: false, canStageAll: false, canUnstageAll: false };
    expect(stageState({ ...ready, running: true })).toEqual(none);
    expect(stageState({ ...ready, busy: true })).toEqual(none);
    expect(stageState({ ...ready, capable: false })).toEqual(none);
  });

  it("offers Stage All and Unstage All only when their list has files", () => {
    expect(stageState({ ...ready, index: index({ files: [change({ staged: true, unstaged: false })] }) })).toEqual({
      canStage: true,
      canStageAll: false,
      canUnstageAll: true,
    });
    expect(stageState({ ...ready, index: index({ files: [change({ staged: false, unstaged: true })] }) })).toEqual({
      canStage: true,
      canStageAll: true,
      canUnstageAll: false,
    });
  });

  it("shares the rule with commit", () => {
    expect(gitWritable({ running: false, busy: false, capable: true })).toBe(true);
    expect(gitWritable({ running: true, busy: false, capable: true })).toBe(false);
    expect(commitState({ message: "m", index: mixed, running: false, busy: true, capable: true }).canCommit).toBe(false);
  });
});

describe("the disabled-while-running rule", () => {
  const report = (id: string, status: string, revision: number, projectId = "p-app") => ({ id, projectId, status, revision });

  it("is busy when any session in the project runs", () => {
    expect(projectRunning("p-app", [report("s1", "idle", 3), report("s2", "running", 5)])).toBe(true);
    expect(projectRunning("p-app", [report("s1", "idle", 3)])).toBe(false);
  });

  it("ignores other projects", () => {
    expect(projectRunning("p-app", [report("s9", "running", 1, "p-api")])).toBe(false);
  });

  it("trusts the newest report of each session across the inbox, the list and the open session", () => {
    const inbox = [report("s1", "running", 4)];
    const list = [report("s1", "idle", 6)];
    expect(projectRunning("p-app", inbox, list)).toBe(false);
    expect(projectRunning("p-app", [report("s1", "running", 7)], list)).toBe(true);
    // The open session's sync wins a tie.
    expect(projectRunning("p-app", inbox, [report("s1", "idle", 4)])).toBe(false);
  });
});
