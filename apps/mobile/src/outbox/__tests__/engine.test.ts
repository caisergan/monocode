import { beforeEach, describe, expect, it } from "vitest";
import type { CommandReceipt, HostCommand } from "@monocode/core/session";
import { CacheRepo, outboxSessionKey, type OutboxEntry } from "../../storage/repo";
import { migrate } from "../../storage/schema";
import { memorySql } from "../../storage/__tests__/memorySql";
import { OutboxEngine } from "../engine";
import { MemoryOutbox } from "../memory";
import { EXPIRY_MS, OPTIMISTIC_MS, backoffMs, classify, isExpiredError } from "../policy";

const ENV = "h1";

/** The engine's clock and timers, advanced by hand. */
class Clock {
  t = 1_000_000;
  private timers: { at: number; run: () => void }[] = [];
  now = () => this.t;
  set = (run: () => void, ms: number) => {
    const timer = { at: this.t + ms, run };
    this.timers.push(timer);
    return timer;
  };
  clear = (timer: unknown) => {
    this.timers = this.timers.filter((item) => item !== timer);
  };
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.timers.filter((timer) => timer.at <= this.t);
    this.timers = this.timers.filter((timer) => timer.at > this.t);
    for (const timer of due) timer.run();
    await settle();
  }
}

/** Lets the SQL promises and the sender's continuations run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const error = (code: string, retryable = false) => Object.assign(new Error(code), { code, retryable });

/** A host whose answers the test gives one by one. */
class FakeHost {
  online = true;
  connects = 0;
  calls: HostCommand[] = [];
  private waiting: { command: HostCommand; resolve: (receipt: CommandReceipt) => void; reject: (error: unknown) => void }[] = [];

  transport = {
    online: () => this.online,
    connect: () => {
      this.connects++;
    },
    dispatch: (command: HostCommand) =>
      new Promise<CommandReceipt>((resolve, reject) => {
        this.calls.push(command);
        this.waiting.push({ command, resolve, reject });
      }),
  };

  ids(): string[] {
    return this.calls.map((command) => command.commandId);
  }

  private take(commandId: string) {
    const index = this.waiting.findIndex((item) => item.command.commandId === commandId);
    if (index < 0) throw new Error(`${commandId} is not in flight`);
    return this.waiting.splice(index, 1)[0];
  }

  async ack(commandId: string, sessionId = "s1"): Promise<void> {
    this.take(commandId).resolve({ commandId, sessionId, revision: 2 });
    await settle();
  }

  async fail(commandId: string, failure: unknown): Promise<void> {
    this.take(commandId).reject(failure);
    await settle();
  }
}

const send = (commandId: string, sessionId = "s1"): HostCommand => ({ type: "send", commandId, sessionId, text: `text ${commandId}` });
const approve = (commandId: string, sessionId = "s1"): HostCommand => ({
  type: "approve",
  commandId,
  sessionId,
  runId: "run-1",
  requestId: 7,
  decision: "allow",
});

describe("outbox engine", () => {
  let repo: CacheRepo;
  let clock: Clock;
  let host: FakeHost;
  let notices: string[];
  let created: [string, string][];
  let engine: OutboxEngine;

  const start = async () => {
    engine = new OutboxEngine({
      store: repo.outbox,
      transport: (env) => (env === ENV ? host.transport : undefined),
      now: clock.now,
      setTimer: clock.set,
      clearTimer: clock.clear,
      onNotice: (_env, notice) => notices.push(notice),
      onSessionCreated: (_env, local, sessionId) => created.push([local, sessionId]),
    });
    await engine.ready;
    await settle();
  };

  beforeEach(async () => {
    const { sql } = memorySql();
    await migrate(sql);
    repo = new CacheRepo(sql);
    clock = new Clock();
    host = new FakeHost();
    notices = [];
    created = [];
    await start();
  });

  describe("receipts", () => {
    it("writes the entry before its first send, then marks it sending", async () => {
      host.online = false;
      await engine.enqueue(ENV, send("c1"));
      expect(await repo.outbox.get("c1")).toMatchObject({ state: "pending", attempts: 0, expiresAt: clock.t + EXPIRY_MS.send });
      expect(host.calls).toEqual([]);
      expect(host.connects).toBe(1);
      host.online = true;
      engine.hostOnline(ENV);
      await settle();
      expect(host.ids()).toEqual(["c1"]);
      expect(await repo.outbox.get("c1")).toMatchObject({ state: "sending", attempts: 1 });
    });

    it("keeps an acked send as Sending… until its user block arrives", async () => {
      await engine.enqueue(ENV, send("c1"));
      await settle();
      await host.ack("c1");
      expect(await repo.outbox.get("c1")).toMatchObject({ state: "acked", receipt: { sessionId: "s1" }, ackedAt: clock.t });
      await engine.resolve(ENV, new Set(["other"]));
      expect(engine.get("c1")?.state).toBe("acked");
      await engine.resolve(ENV, new Set(["c1"]));
      expect(await repo.outbox.get("c1")).toBeUndefined();
      expect(engine.list(ENV)).toEqual([]);
    });

    it("resolves a queue entry when its queued item shows up", async () => {
      await engine.enqueue(ENV, { type: "queue", commandId: "q1", sessionId: "s1", text: "later" });
      await settle();
      await host.ack("q1");
      expect(engine.get("q1")?.state).toBe("acked");
      await engine.resolve(ENV, new Set(["q1"]));
      expect(engine.get("q1")).toBeUndefined();
    });

    it("deletes other commands as soon as their receipt arrives", async () => {
      await engine.enqueue(ENV, approve("a1"));
      await engine.enqueue(ENV, { type: "unqueue", commandId: "u1", sessionId: "s2", queuedId: "q1" });
      await settle();
      await host.ack("a1");
      await host.ack("u1", "s2");
      expect(await repo.outbox.list()).toEqual([]);
    });

    it("deletes an acked optimistic entry after 10 min without its block", async () => {
      await engine.enqueue(ENV, send("c1"));
      await settle();
      await host.ack("c1");
      await clock.advance(OPTIMISTIC_MS - 1);
      await engine.sweep();
      expect(engine.get("c1")?.state).toBe("acked");
      await clock.advance(1);
      await engine.sweep();
      expect(await repo.outbox.get("c1")).toBeUndefined();
    });

    it("sends FIFO per session, and sessions in parallel", async () => {
      await engine.enqueue(ENV, send("a", "s1"));
      await engine.enqueue(ENV, send("b", "s1"));
      await engine.enqueue(ENV, send("c", "s2"));
      await settle();
      expect(host.ids()).toEqual(["a", "c"]);
      await host.ack("c", "s2");
      expect(host.ids()).toEqual(["a", "c"]);
      await host.ack("a");
      expect(host.ids()).toEqual(["a", "c", "b"]);
    });
  });

  describe("errors", () => {
    it("fails on a non-retryable error; Retry resends the same command id; Discard drops it", async () => {
      await engine.enqueue(ENV, send("c1"));
      await engine.enqueue(ENV, send("c2"));
      await settle();
      await host.fail("c1", error("session_busy"));
      expect(await repo.outbox.get("c1")).toMatchObject({ state: "failed", error: { code: "session_busy", retryable: false } });
      // A failed entry no longer holds its session up.
      expect(host.ids()).toEqual(["c1", "c2"]);
      await host.ack("c2");

      await engine.retry("c1");
      await settle();
      expect(host.ids()).toEqual(["c1", "c2", "c1"]);
      expect(engine.get("c1")).toMatchObject({ state: "sending", attempts: 2 });
      await host.fail("c1", error("provider_unavailable"));
      expect(engine.get("c1")?.state).toBe("failed");

      await engine.discard("c1");
      expect(await repo.outbox.get("c1")).toBeUndefined();
      expect(notices).toEqual([]);
    });

    it("treats unknown and internal errors as failures, not retries", async () => {
      await engine.enqueue(ENV, send("c1"));
      await settle();
      await host.fail("c1", error("internal"));
      expect(engine.get("c1")?.state).toBe("failed");
    });

    it("discards already_resolved and stale_turn with quiet notices", async () => {
      await engine.enqueue(ENV, approve("a1", "s1"));
      await engine.enqueue(ENV, { type: "answer", commandId: "q1", sessionId: "s2", runId: "r", requestId: 3, reply: { kind: "skipped" } });
      await engine.enqueue(ENV, approve("a2", "s3"));
      await settle();
      await host.fail("a1", error("already_resolved"));
      await host.fail("q1", error("stale_turn"));
      await host.fail("a2", error("stale_turn"));
      expect(await repo.outbox.list()).toEqual([]);
      expect(notices).toEqual([
        "Answered on another device",
        "This request ended before your answer arrived.",
        "This approval is no longer needed",
      ]);
    });

    it("backs off 1, 2, 4 … s after retryable and transport errors", async () => {
      await engine.enqueue(ENV, send("c1"));
      await settle();
      await host.fail("c1", error("offline", true));
      expect(engine.get("c1")).toMatchObject({ state: "pending", error: { code: "offline" } });
      await clock.advance(999);
      expect(host.calls).toHaveLength(1);
      await clock.advance(1);
      expect(host.calls).toHaveLength(2);
      await host.fail("c1", error("rate_limited", true));
      await clock.advance(1_999);
      expect(host.calls).toHaveLength(2);
      await clock.advance(1);
      expect(host.calls).toHaveLength(3);
      // A plain transport failure (no code) is retried too.
      await host.fail("c1", new Error("socket closed"));
      await clock.advance(4_000);
      expect(host.calls).toHaveLength(4);
      await host.ack("c1");
      expect(host.ids()).toEqual(["c1", "c1", "c1", "c1"]);
      expect(engine.get("c1")).toMatchObject({ state: "acked", attempts: 4 });
    });

    it("resets the backoff when the host comes back online", async () => {
      await engine.enqueue(ENV, send("c1"));
      await settle();
      await host.fail("c1", error("timeout", true));
      await clock.advance(1_000);
      await host.fail("c1", error("timeout", true));
      expect(host.calls).toHaveLength(2);
      host.online = false;
      host.online = true;
      engine.hostOnline(ENV);
      await settle();
      expect(host.calls).toHaveLength(3);
    });

    it("caps the backoff at 30 s", () => {
      expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    });

    it("classifies the spec's codes", () => {
      for (const code of ["invalid_params", "session_busy", "not_found", "idempotency_conflict", "capability_missing", "provider_unavailable"])
        expect(classify({ code: code as never, message: "", retryable: false }, "send").kind).toBe("fail");
      expect(classify({ code: "branch_switching", message: "", retryable: true }, "send").kind).toBe("retry");
      expect(classify({ code: "already_resolved", message: "", retryable: false }, "answer")).toEqual({
        kind: "discard",
        notice: "Answered on another device",
      });
    });
  });

  describe("expiry", () => {
    it("sets the per-command expiry from the table", async () => {
      host.online = false;
      const commands: HostCommand[] = [
        { type: "steer", commandId: "st", sessionId: "s1", queuedId: "q", runId: "r" },
        { type: "editQueued", commandId: "ed", sessionId: "s2", queuedId: "q", text: "x" },
        { type: "queue", commandId: "qu", sessionId: "s3", text: "x" },
        { type: "cancel", commandId: "ca", sessionId: "s4", runId: "r" },
      ];
      for (const command of commands) {
        const entry = await engine.enqueue(ENV, command);
        expect(entry.expiresAt - entry.createdAt).toBe(EXPIRY_MS[command.type]);
      }
      expect(EXPIRY_MS).toMatchObject({ steer: 600_000, editQueued: 3_600_000, queue: 86_400_000, cancel: 600_000, create: 86_400_000 });
    });

    it("fails expired commands with Not sent, and drops approve, answer and cancel", async () => {
      host.online = false;
      await engine.enqueue(ENV, send("c1", "s1"));
      await engine.enqueue(ENV, approve("a1", "s2"));
      await engine.enqueue(ENV, { type: "cancel", commandId: "x1", sessionId: "s3", runId: "r" });
      await clock.advance(EXPIRY_MS.approve + 10);
      await engine.sweep();
      expect(engine.get("a1")).toBeUndefined();
      expect(engine.get("x1")).toBeUndefined();
      expect(engine.get("c1")?.state).toBe("pending");
      await clock.advance(EXPIRY_MS.send);
      await engine.sweep();
      const failed = await repo.outbox.get("c1");
      expect(failed?.state).toBe("failed");
      expect(isExpiredError(failed?.error)).toBe(true);
      // Retry gives it a fresh expiry and sends the same command id.
      host.online = true;
      await engine.retry("c1");
      engine.hostOnline(ENV);
      await settle();
      expect(host.ids()).toEqual(["c1"]);
      expect(engine.get("c1")?.expiresAt).toBe(clock.t + EXPIRY_MS.send);
    });
  });

  describe("create", () => {
    const create = (commandId: string, initial = true): HostCommand => ({
      type: "create",
      commandId,
      projectId: "p1",
      harness: "claude",
      model: "claude:opus",
      runtimeMode: "supervised",
      worktree: { mode: "new", base: "main" },
      ...(initial ? { initial: { text: "first", intent: "default" as const } } : {}),
    });

    it("rewrites dependsOn and localSessionId after the receipt, then sends the dependents", async () => {
      await engine.enqueue(ENV, create("k1"), { localSessionId: "local-1" });
      await engine.enqueue(ENV, send("c2", "local-1"), { localSessionId: "local-1", dependsOn: "k1" });
      await settle();
      expect(host.ids()).toEqual(["k1"]);
      expect(engine.list(ENV).map(outboxSessionKey)).toEqual(["local-1", "local-1"]);

      await host.ack("k1", "s-real");
      expect(host.ids()).toEqual(["k1", "c2"]);
      expect(host.calls[1]).toMatchObject({ sessionId: "s-real" });
      const dependent = await repo.outbox.get("c2");
      expect(dependent?.localSessionId).toBeUndefined();
      expect(dependent?.command).toMatchObject({ sessionId: "s-real" });
      // The create (with its first message) waits for its block under the real id.
      expect(engine.get("k1")).toMatchObject({ state: "acked", receipt: { sessionId: "s-real" } });
      expect((await repo.outbox.list({ sessionKey: "s-real" })).map((entry) => entry.commandId)).toEqual(["k1", "c2"]);
      expect(created).toEqual([["local-1", "s-real"]]);
      expect(engine.resolveSession("local-1")).toBe("s-real");

      await engine.resolve(ENV, new Set(["k1"]));
      expect(engine.get("k1")).toBeUndefined();
    });

    it("holds the dependents while the create fails, and drops them with it", async () => {
      await engine.enqueue(ENV, create("k1"), { localSessionId: "local-1" });
      await engine.enqueue(ENV, send("c2", "local-1"), { localSessionId: "local-1", dependsOn: "k1" });
      await settle();
      await host.fail("k1", error("provider_unavailable"));
      expect(engine.get("k1")?.state).toBe("failed");
      expect(engine.get("c2")?.state).toBe("pending");
      expect(host.ids()).toEqual(["k1"]);
      await engine.discard("k1");
      expect(await repo.outbox.list()).toEqual([]);
    });

    it("deletes a create without a first message on its receipt", async () => {
      await engine.enqueue(ENV, create("k1", false), { localSessionId: "local-1" });
      await settle();
      await host.ack("k1", "s-real");
      expect(engine.list(ENV)).toEqual([]);
      expect(engine.resolveSession("local-1")).toBe("s-real");
    });
  });

  describe("restarts", () => {
    it("sends again what a previous launch left sending, with the same command id", async () => {
      const left: OutboxEntry = {
        commandId: "old",
        hostEnv: ENV,
        command: send("old"),
        createdAt: 1,
        expiresAt: clock.t + 1_000_000,
        attempts: 1,
        state: "sending",
      };
      await repo.outbox.put(left);
      await start();
      expect(host.ids()).toEqual(["old"]);
      expect(engine.get("old")).toMatchObject({ state: "sending", attempts: 2 });
    });

    it("finishes a create's rewrite that a crash interrupted", async () => {
      await repo.outbox.put({
        commandId: "k1",
        hostEnv: ENV,
        command: { type: "create", commandId: "k1", projectId: "p", harness: "claude", model: "m", runtimeMode: "supervised", initial: { text: "x" } },
        localSessionId: "local-1",
        createdAt: 1,
        expiresAt: clock.t + 1_000_000,
        attempts: 1,
        state: "acked",
        receipt: { commandId: "k1", sessionId: "s-real", revision: 1 },
      });
      await repo.outbox.put({
        commandId: "c2",
        hostEnv: ENV,
        command: send("c2", "local-1"),
        localSessionId: "local-1",
        dependsOn: "k1",
        createdAt: 2,
        expiresAt: clock.t + 1_000_000,
        attempts: 0,
        state: "pending",
      });
      await start();
      expect(host.calls).toMatchObject([{ commandId: "c2", sessionId: "s-real" }]);
    });
  });

  it("forgets a removed host's entries", async () => {
    host.online = false;
    await engine.enqueue(ENV, send("c1"));
    await engine.enqueue("h2", send("c2"));
    expect([...engine.envs()].sort()).toEqual([ENV, "h2"]);
    await engine.forget(ENV);
    expect((await repo.outbox.list()).map((entry) => entry.commandId)).toEqual(["c2"]);
    expect(engine.list(ENV)).toEqual([]);
  });

  it("runs the same state machine on the in-memory store", async () => {
    engine = new OutboxEngine({
      store: new MemoryOutbox(),
      transport: () => host.transport,
      now: clock.now,
      setTimer: clock.set,
      clearTimer: clock.clear,
    });
    await engine.ready;
    await engine.enqueue(ENV, { type: "create", commandId: "k1", projectId: "p", harness: "claude", model: "m", runtimeMode: "supervised", initial: { text: "x" } }, { localSessionId: "local-1" });
    await engine.enqueue(ENV, send("c2", "local-1"), { localSessionId: "local-1", dependsOn: "k1" });
    await settle();
    await host.ack("k1", "s-real");
    expect(host.calls[1]).toMatchObject({ commandId: "c2", sessionId: "s-real" });
  });
});
