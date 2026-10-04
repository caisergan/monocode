// Milestone M3 commands (spec 06 §6.9, 09 §9.6): turn outcomes, the session
// queue, and `create` with `initial` and a new worktree.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendTurnInput } from "../src/integrations/harness/core/types";
import type { HostSession } from "../src/features/connections/model/protocol";
import type { HostProvider } from "./providers";
import { HostEngine, createWorktreeBranch, parseCommand } from "./engine";
import { HostStore } from "./store";
import { hostWorktrees } from "./git-worktrees";
import { createHostRpc } from "./rpc";

// The engine's own git calls inherit process.env. The pre-push hook sets
// GIT_DIR, which would point them at the real repository, so drop every
// inherited GIT_* variable for this file.
const inherited = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_"));
beforeAll(() => {
  for (const [key] of inherited) delete process.env[key];
});
afterAll(() => {
  for (const [key, value] of inherited) process.env[key] = value;
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Turn = { input: SendTurnInput; finish: () => void; fail: (error: Error) => void };

function fakeProvider(turns: Turn[]): HostProvider {
  return {
    send: vi.fn(
      (input) =>
        new Promise<void>((resolve, reject) => {
          turns.push({ input, finish: resolve, fail: reject });
        }),
    ),
    cancel: vi.fn(async () => turns.at(-1)?.finish()),
    stop: vi.fn(async () => turns.at(-1)?.finish()),
    bind: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
}

function setup(directory = mkdtempSync(join(tmpdir(), "monocode-commands-test-"))) {
  const store = new HostStore(join(directory, "host.db"));
  const project = store.addProject(directory, "Test");
  const turns: Turn[] = [];
  const provider = fakeProvider(turns);
  const engine = new HostEngine(store, { codex: provider });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await engine.close();
    store.close();
  };
  cleanups.push(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (extra: Record<string, unknown> = {}) =>
    engine.command({
      type: "create",
      commandId: crypto.randomUUID(),
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
      ...extra,
    }).sessionId;
  const send = (sessionId: string, text = "Work", commandId: string = crypto.randomUUID()) =>
    engine.command({ type: "send", commandId, sessionId, text });
  const queue = (sessionId: string, commandId: string, text = commandId) =>
    engine.command({ type: "queue", commandId, sessionId, text });
  /** Waits until `count` provider turns have started. */
  const started = (count: number) => vi.waitFor(() => expect(turns).toHaveLength(count));
  const settledIdle = (id: string) => vi.waitFor(() => expect(store.session(id).status).not.toBe("running"));
  return { directory, store, project, engine, provider, turns, create, send, queue, started, settledIdle, close };
}

const userBlocks = (value: HostSession) =>
  value.session.blocks.filter((block) => block.role === "user").map((block) => block.id);

describe("turn outcome", () => {
  it("records when each turn settled and how it ended", async () => {
    const s = setup();
    const id = s.create();
    expect(s.store.session(id).lastTurnOutcome).toBeUndefined();

    s.send(id);
    await s.started(1);
    s.turns[0].finish();
    await s.settledIdle(id);
    const finished = s.store.session(id);
    expect(finished).toMatchObject({ status: "idle", lastTurnOutcome: "finished" });
    expect(finished.finishedAt).toBeGreaterThanOrEqual(finished.session.blocks[0].startedAt!);
    // The phone's summary extras read the stored fields.
    expect(s.store.page(s.project.id).items[0]).toMatchObject({ finishedAt: finished.finishedAt });
    expect(s.store.inbox().items[0]).toMatchObject({ attention: "finished", finishedAt: finished.finishedAt });

    s.send(id);
    await s.started(2);
    s.turns[1].fail(new Error("provider crashed"));
    await s.settledIdle(id);
    expect(s.store.session(id).lastTurnOutcome).toBe("failed");
    // A thrown error leaves a plain system block; the outcome still marks it.
    expect(s.store.inbox().items[0].attention).toBe("error");

    s.send(id);
    await s.started(3);
    s.turns[2].input.onEvent({ type: "session.error", message: "Rate limited" });
    s.turns[2].finish();
    await s.settledIdle(id);
    expect(s.store.session(id).lastTurnOutcome).toBe("failed");

    s.send(id);
    await s.started(4);
    const { runId } = s.store.session(id);
    s.engine.command({ type: "cancel", commandId: "cancel", sessionId: id, runId: runId! });
    await s.settledIdle(id);
    expect(s.store.session(id)).toMatchObject({ status: "idle", lastTurnOutcome: "cancelled" });
  });

  it("marks a turn the host restart interrupted", async () => {
    const s = setup();
    const id = s.create();
    const value = s.store.session(id);
    s.store.transaction(() =>
      s.store.save({ ...value, revision: value.revision + 1, status: "running", runId: "lost" }, { type: "test" }),
    );
    const restarted = new HostEngine(s.store, { codex: fakeProvider([]) });
    cleanups.push(() => restarted.close());
    expect(s.store.session(id)).toMatchObject({ status: "interrupted", lastTurnOutcome: "interrupted" });
    expect(s.store.session(id).finishedAt).toBe(value.updatedAt);
  });
});

describe("session queue", () => {
  it("sends at once when the session is idle with nothing queued", async () => {
    const s = setup();
    const id = s.create();
    const receipt = s.queue(id, "now", "Start right away");
    await s.started(1);
    expect(receipt).toEqual({ commandId: "now", sessionId: id, revision: 2 });
    expect(s.store.session(id)).toMatchObject({ status: "running" });
    expect(userBlocks(s.store.session(id))).toEqual(["now"]);
    expect(s.store.session(id).session.queuedMessages).toBeUndefined();
    // Retrying the command returns the stored receipt and sends nothing new.
    expect(s.queue(id, "now", "Start right away")).toEqual(receipt);
    s.turns[0].finish();
  });

  it("waits behind a running turn, then sends the head as each turn finishes", async () => {
    const s = setup();
    const id = s.create();
    s.send(id, "First", "first");
    await s.started(1);
    s.queue(id, "q1", "Second");
    s.queue(id, "q2", "Third");
    expect(s.store.session(id).session.queuedMessages?.map((item) => [item.id, item.text])).toEqual([
      ["q1", "Second"],
      ["q2", "Third"],
    ]);
    expect(s.store.page(s.project.id).items[0].queueLength).toBe(2);

    s.turns[0].finish();
    await s.started(2);
    expect(s.turns[1].input.text).toBe("Second");
    // The queued id becomes the user block id, so the phone's outbox resolves.
    await vi.waitFor(() => expect(userBlocks(s.store.session(id))).toEqual(["first", "q1"]));
    expect(s.store.session(id).session.queuedMessages?.map((item) => item.id)).toEqual(["q2"]);

    s.turns[1].finish();
    await s.started(3);
    expect(s.turns[2].input.text).toBe("Third");
    s.turns[2].finish();
    await s.settledIdle(id);
    expect(userBlocks(s.store.session(id))).toEqual(["first", "q1", "q2"]);
    expect(s.store.session(id).session.queuedMessages).toBeUndefined();
    expect(s.store.page(s.project.id).items[0].queueLength).toBeUndefined();
  });

  it.each([
    ["an error", (s: ReturnType<typeof setup>) => s.turns[0].fail(new Error("boom"))],
    [
      "a cancel",
      (s: ReturnType<typeof setup>, id: string) =>
        s.engine.command({ type: "cancel", commandId: "stop", sessionId: id, runId: s.store.session(id).runId! }),
    ],
    [
      "a usage limit",
      (s: ReturnType<typeof setup>) => {
        s.turns[0].input.onEvent({ type: "usage.limited", resetsAt: Date.now() + 60_000 });
        s.turns[0].finish();
      },
    ],
  ])("pauses after %s and sends again on resumeQueue", async (_label, end) => {
    const s = setup();
    const id = s.create();
    s.send(id, "First", "first");
    await s.started(1);
    s.queue(id, "later", "Later");
    end(s, id);
    await s.settledIdle(id);
    expect(s.store.session(id).session.queueStatus).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.turns).toHaveLength(1);
    // A new queue command while paused waits too.
    s.queue(id, "more", "More");
    expect(s.store.session(id).session.queuedMessages?.map((item) => item.id)).toEqual(["later", "more"]);

    s.engine.command({ type: "resumeQueue", commandId: "resume", sessionId: id });
    await s.started(2);
    expect(s.turns[1].input.text).toBe("Later");
    expect(s.store.session(id).session).toMatchObject({ queueStatus: "active", usageLimit: undefined });
    s.turns[1].finish();
    await s.started(3);
    s.turns[2].finish();
    await s.settledIdle(id);
    expect(userBlocks(s.store.session(id))).toEqual(["first", "later", "more"]);
  });

  it("pauses a queue whose turn the host restart interrupted", () => {
    const s = setup();
    const id = s.create();
    const value = s.store.session(id);
    s.store.transaction(() =>
      s.store.save(
        {
          ...value,
          revision: value.revision + 1,
          status: "running",
          runId: "lost",
          session: { ...value.session, queuedMessages: [{ id: "waiting", text: "Next", attachments: [] }] },
        },
        { type: "test" },
      ),
    );
    const restarted = new HostEngine(s.store, { codex: fakeProvider([]) });
    cleanups.push(() => restarted.close());
    expect(s.store.session(id).session.queueStatus).toBe("paused");
  });

  it("removes and edits waiting messages in place", async () => {
    const s = setup();
    const id = s.create();
    s.send(id, "First", "first");
    await s.started(1);
    s.queue(id, "a", "A");
    s.queue(id, "b", "B");
    s.queue(id, "c", "C");
    s.engine.command({ type: "unqueue", commandId: "drop-b", sessionId: id, queuedId: "b" });
    s.engine.command({ type: "editQueued", commandId: "edit-c", sessionId: id, queuedId: "c", text: "C, revised" });
    expect(s.store.session(id).session.queuedMessages?.map((item) => [item.id, item.text])).toEqual([
      ["a", "A"],
      ["c", "C, revised"],
    ]);
    expect(() => s.engine.command({ type: "unqueue", commandId: "drop-x", sessionId: id, queuedId: "b" })).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() =>
      s.engine.command({ type: "editQueued", commandId: "edit-empty", sessionId: id, queuedId: "a", text: "  " }),
    ).toThrow("Invalid prompt");
    s.turns[0].finish();
    await s.started(2);
    expect(s.turns[1].input.text).toBe("A");
    s.turns[1].finish();
    await s.started(3);
    expect(s.turns[2].input.text).toBe("C, revised");
    s.turns[2].finish();
  });

  it("steers: cancels the run and sends the chosen message next, without pausing", async () => {
    const s = setup();
    const id = s.create();
    s.send(id, "First", "first");
    await s.started(1);
    s.queue(id, "a", "A");
    s.queue(id, "b", "B");
    const { runId } = s.store.session(id);
    expect(() =>
      s.engine.command({ type: "steer", commandId: "wrong-run", sessionId: id, queuedId: "b", runId: "old" }),
    ).toThrow("This request belongs to a finished or replaced turn");
    expect(() =>
      s.engine.command({ type: "steer", commandId: "wrong-item", sessionId: id, queuedId: "zz", runId: runId! }),
    ).toThrow(expect.objectContaining({ code: "not_found" }));

    s.engine.command({ type: "steer", commandId: "steer", sessionId: id, queuedId: "b", runId: runId! });
    expect(s.store.session(id).session.queuedMessages?.map((item) => item.id)).toEqual(["b", "a"]);
    expect(s.provider.cancel).toHaveBeenCalledWith(id);
    await s.started(2);
    expect(s.turns[1].input.text).toBe("B");
    await vi.waitFor(() => expect(userBlocks(s.store.session(id))).toEqual(["first", "b"]));
    const steered = s.store.session(id);
    expect(steered.lastTurnOutcome).toBe("cancelled");
    expect(steered.session.queueStatus).not.toBe("paused");
    // The rest of the queue keeps going.
    s.turns[1].finish();
    await s.started(3);
    expect(s.turns[2].input.text).toBe("A");
    s.turns[2].finish();
  });
});

describe("steer fallback", () => {
  it("sends the queue head if the steered message was removed before the turn stopped", async () => {
    const s = setup();
    const id = s.create();
    s.send(id, "First", "first");
    await s.started(1);
    s.queue(id, "a", "A");
    s.queue(id, "b", "B");
    // Hold the cancel so the item can be removed while the turn still runs.
    let stop!: () => void;
    vi.mocked(s.provider.cancel).mockImplementationOnce(() => new Promise<void>((resolve) => (stop = resolve)));
    s.engine.command({ type: "steer", commandId: "steer", sessionId: id, queuedId: "b", runId: s.store.session(id).runId! });
    s.engine.command({ type: "unqueue", commandId: "drop-b", sessionId: id, queuedId: "b" });
    s.turns[0].finish();
    stop();
    await s.started(2);
    expect(s.turns[1].input.text).toBe("A");
    s.turns[1].finish();
  });
});

describe("create with initial", () => {
  it("creates the session and starts its first turn in one command", async () => {
    const s = setup();
    const command = {
      type: "create",
      commandId: "create-and-send",
      projectId: s.project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
      worktree: { mode: "current" },
      initial: { text: "Fix the login page", intent: "plan" },
    };
    const receipt = s.engine.command(command);
    expect(receipt).toMatchObject({ commandId: "create-and-send", revision: 1 });
    const value = s.store.session(receipt.sessionId);
    // One saved revision holds the session, its first message and the run.
    expect(value).toMatchObject({ revision: 1, status: "running", session: { cwd: s.directory } });
    expect(userBlocks(value)).toEqual(["create-and-send"]);
    await s.started(1);
    expect(s.turns[0].input).toMatchObject({ text: "Fix the login page", intent: "plan" });
    // A retry is answered from the receipt; a reused id with another payload is not.
    expect(s.engine.command(command)).toEqual(receipt);
    expect(s.store.sessions()).toHaveLength(1);
    expect(() => s.engine.command({ ...command, initial: { text: "Something else" } })).toThrow(
      "Command ID was already used with a different payload",
    );
    s.turns[0].finish();
  });

  it("refuses a new worktree on the synchronous path", () => {
    const s = setup();
    expect(() =>
      s.engine.command({
        type: "create",
        commandId: "sync-new",
        projectId: s.project.id,
        harness: "codex",
        model: "codex:test",
        runtimeMode: "supervised",
        worktree: { mode: "new" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_params" }));
  });
});

describe("create with a new worktree", () => {
  function repository() {
    const cwd = mkdtempSync(join(tmpdir(), "monocode-create-worktree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, env: process.env });
    git("init", "-q");
    git("checkout", "-q", "-b", "main");
    writeFileSync(join(cwd, "file.txt"), "initial\n");
    git("add", "file.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial");
    return cwd;
  }

  it("creates the worktree, survives a crash before the receipt, and reuses it on retry", async () => {
    const cwd = repository();
    const root = (await hostWorktrees(cwd)).defaultRoot;
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const first = setup(cwd);
    const command = {
      type: "create",
      commandId: "phone-create-1",
      projectId: first.project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
      worktree: { mode: "new", base: "main" },
      initial: { text: "Start in a fresh worktree" },
    };
    const branch = createWorktreeBranch(command.commandId);
    expect(branch).toMatch(/^mc\/[0-9a-f]{8}$/);

    // The process dies after git made the worktree, before the receipt.
    vi.spyOn(first.store, "recordReceipt").mockImplementationOnce(() => {
      throw new Error("simulated crash");
    });
    await expect(first.engine.commandAsync(command)).rejects.toThrow("simulated crash");
    const made = (await hostWorktrees(cwd)).worktrees.filter((tree) => tree.branch === branch);
    expect(made).toHaveLength(1);
    expect(first.store.sessions()).toHaveLength(0);
    expect(first.turns).toHaveLength(0);
    await first.close();

    // The host restarts and the phone's outbox retries the same command.
    const second = setup(cwd);
    const rpc = createHostRpc(second.engine, ["codex"]);
    const call = () =>
      rpc.dispatch("commands.dispatch", command, {
        principal: { deviceId: "phone", role: "member", kind: "mobile", name: "Phone" },
        transport: "direct",
      });
    const [receipt, duplicate] = (await Promise.all([call(), call()])) as { sessionId: string }[];
    expect(duplicate).toEqual(receipt);
    const trees = (await hostWorktrees(cwd)).worktrees.filter((tree) => tree.branch === branch);
    expect(trees).toEqual([expect.objectContaining({ path: made[0].path })]);
    expect(second.store.sessions()).toHaveLength(1);
    const value = second.store.session(receipt.sessionId);
    expect(value).toMatchObject({
      status: "running",
      autoWorktreeBranch: branch,
      session: { cwd: made[0].path, worktreeCwd: made[0].path, branch },
    });
    expect(userBlocks(value)).toEqual(["phone-create-1"]);
    await second.started(1);
    expect(second.turns[0].input).toMatchObject({ cwd: made[0].path, text: "Start in a fresh worktree" });
    await expect(call()).resolves.toEqual(receipt);
    second.turns[0].finish();
    await second.settledIdle(receipt.sessionId);
  });

  it("recreates the worktree from a branch an earlier attempt left behind", async () => {
    const cwd = repository();
    const root = (await hostWorktrees(cwd)).defaultRoot;
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const s = setup(cwd);
    const branch = createWorktreeBranch("branch-only");
    execFileSync("git", ["branch", branch, "main"], { cwd, env: process.env });
    const receipt = await s.engine.commandAsync({
      type: "create",
      commandId: "branch-only",
      projectId: s.project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
      worktree: { mode: "new" },
    });
    const tree = (await hostWorktrees(cwd)).worktrees.find((item) => item.branch === branch);
    expect(tree).toBeDefined();
    expect(s.store.session(receipt.sessionId)).toMatchObject({ status: "idle", session: { cwd: tree!.path } });
  });
});

describe("command validation", () => {
  const base = { commandId: "c", sessionId: "s" };
  const create = { type: "create", commandId: "c", projectId: "p", harness: "codex", model: "m", runtimeMode: "supervised" };

  it("accepts the new shapes", () => {
    expect(parseCommand({ ...create, worktree: { mode: "existing", cwd: "/tmp/x" } })).toMatchObject({
      worktree: { mode: "existing", cwd: "/tmp/x" },
    });
    expect(parseCommand({ ...create, worktree: { mode: "new" }, initial: { text: "Hi" } })).toEqual({
      ...create,
      worktree: { mode: "new" },
      initial: { text: "Hi" },
    });
    expect(parseCommand({ type: "queue", ...base, text: "Next", intent: "plan" })).toEqual({
      type: "queue",
      ...base,
      text: "Next",
      intent: "plan",
    });
    expect(parseCommand({ type: "unqueue", ...base, queuedId: "q" })).toEqual({ type: "unqueue", ...base, queuedId: "q" });
    expect(parseCommand({ type: "resumeQueue", ...base })).toEqual({ type: "resumeQueue", ...base });
    expect(parseCommand({ type: "editQueued", ...base, queuedId: "q", text: "" })).toEqual({
      type: "editQueued",
      ...base,
      queuedId: "q",
      text: "",
    });
    expect(parseCommand({ type: "steer", ...base, queuedId: "q", runId: "r" })).toEqual({
      type: "steer",
      ...base,
      queuedId: "q",
      runId: "r",
    });
  });

  it.each([
    [{ ...create, worktree: { mode: "new" }, worktreeCwd: "/tmp/x" }, "Invalid worktree"],
    [{ ...create, worktree: { mode: "elsewhere" } }, "Invalid worktree"],
    [{ ...create, worktree: { mode: "existing" } }, "Invalid working copy"],
    [{ ...create, worktree: { mode: "new", base: "" } }, "Invalid worktree base"],
    [{ ...create, initial: { text: "  " } }, "Invalid prompt"],
    [{ ...create, initial: { text: "Hi", intent: "build" } }, "Invalid turn intent"],
    [{ ...create, initial: "Hi" }, "Invalid initial message"],
    [{ type: "queue", ...base, text: "" }, "Invalid prompt"],
    [{ type: "queue", ...base, text: "Hi", intent: "build" }, "Invalid turn intent"],
    [{ type: "unqueue", ...base }, "Invalid queued message ID"],
    [{ type: "editQueued", ...base, queuedId: "q", text: "a\0b" }, "Invalid prompt"],
    [{ type: "steer", ...base, queuedId: "q" }, "Invalid run ID"],
  ])("rejects %j", (input, message) => {
    expect(() => parseCommand(input)).toThrow(message);
  });
});
