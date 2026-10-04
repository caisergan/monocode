import { beforeEach, describe, expect, it } from "vitest";
import type { HostSession } from "@monocode/core/session";
import type { InboxList, SessionListItem } from "@monocode/core/wire";
import { CacheRepo, utf8Length, type CachedWindow, type OutboxEntry } from "../repo";
import { CACHE_TABLES, KEPT_TABLES, MIGRATIONS, SCHEMA_VERSION, migrate, schemaVersion, type Migration } from "../schema";
import type { Sql } from "../sql";
import { memorySql } from "./memorySql";

async function tables(sql: Sql): Promise<string[]> {
  const rows = await sql.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  return rows.map((row) => row.name);
}

function session(id: string, text = "hello", revision = 1): HostSession {
  return {
    projectId: "p1",
    revision,
    status: "idle",
    updatedAt: 1,
    session: {
      id,
      harness: "claude",
      model: "claude:opus",
      modelSettings: {},
      runtimeMode: "supervised",
      title: id,
      cwd: "/repo",
      blocks: [{ id: `${id}-u`, role: "user", text }],
    },
  } as HostSession;
}

const windowOf = (id: string, text = "hello"): CachedWindow => ({
  revision: 1,
  value: session(id, text),
  window: { anchor: `${id}-u`, olderTurns: 0, olderBlocks: 0 },
});

const item = (id: string, updatedAt: number, extra: Partial<SessionListItem> = {}): SessionListItem =>
  ({ id, title: id, harness: "claude", projectId: "p1", revision: 1, status: "idle", updatedAt, ...extra }) as SessionListItem;

function entry(commandId: string, extra: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    commandId,
    hostEnv: "h1",
    command: { type: "send", commandId, sessionId: "s1", text: "hi" },
    createdAt: 100,
    expiresAt: 1_000,
    attempts: 0,
    state: "pending",
    ...extra,
  };
}

describe("migrations", () => {
  it("creates the full table list on a fresh database", async () => {
    const { sql } = memorySql();
    expect(await migrate(sql)).toEqual({ from: 0, to: SCHEMA_VERSION, reset: false });
    expect(await tables(sql)).toEqual(["schema", ...CACHE_TABLES, ...KEPT_TABLES].sort());
    expect(await schemaVersion(sql)).toBe(SCHEMA_VERSION);
    const index = await sql.first<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_items_project'");
    expect(index?.name).toBe("session_items_project");
  });

  it("is a no-op at the latest version", async () => {
    const { sql } = memorySql();
    await migrate(sql);
    expect(await migrate(sql)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, reset: false });
  });

  it("runs only the steps after the stored version, in order", async () => {
    const { sql } = memorySql();
    await migrate(sql);
    const seen: number[] = [];
    const steps: Migration[] = [
      ...MIGRATIONS,
      async (tx) => {
        seen.push(SCHEMA_VERSION + 1);
        await tx.exec("ALTER TABLE projects ADD COLUMN pinned INTEGER");
      },
      async () => {
        seen.push(SCHEMA_VERSION + 2);
      },
    ];
    expect(await migrate(sql, steps)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION + 2, reset: false });
    expect(seen).toEqual([SCHEMA_VERSION + 1, SCHEMA_VERSION + 2]);
    expect(await schemaVersion(sql)).toBe(SCHEMA_VERSION + 2);
  });

  it("a failed step rolls back, then drops the cache tables but keeps outbox and hosts", async () => {
    const { sql } = memorySql();
    await migrate(sql);
    const repo = new CacheRepo(sql);
    await repo.outbox.put(entry("c1"));
    await sql.run("INSERT INTO hosts (env, record) VALUES ('h1', '{}')");
    await repo.saveProjects("h1", [{ id: "p1", cwd: "/repo", name: "repo" }]);
    await repo.saveWindow("h1", "s1", windowOf("s1"));

    const failing: Migration = async (tx) => {
      await tx.exec("CREATE TABLE half_done (x INTEGER)");
      throw new Error("boom");
    };
    const result = await migrate(sql, [...MIGRATIONS, failing]);
    expect(result).toMatchObject({ from: SCHEMA_VERSION, to: SCHEMA_VERSION + 1, reset: true, error: "boom" });
    expect(await tables(sql)).not.toContain("half_done");
    expect(await tables(sql)).toEqual(expect.arrayContaining([...CACHE_TABLES]));
    expect(await schemaVersion(sql)).toBe(SCHEMA_VERSION + 1);
    expect((await repo.outbox.get("c1"))?.commandId).toBe("c1");
    expect(await sql.all("SELECT env FROM hosts")).toEqual([{ env: "h1" }]);
    expect(await repo.loadProjects("h1")).toEqual([]);
    expect(await repo.loadWindow("h1", "s1")).toBeUndefined();
  });

  it("treats a database from a newer app as a failed migration", async () => {
    const { sql } = memorySql();
    await migrate(sql);
    await new CacheRepo(sql).outbox.put(entry("c1"));
    await sql.run("UPDATE schema SET version = 9");
    const result = await migrate(sql);
    expect(result).toMatchObject({ from: 9, to: SCHEMA_VERSION, reset: true });
    expect(await schemaVersion(sql)).toBe(SCHEMA_VERSION);
    expect(await new CacheRepo(sql).outbox.list()).toHaveLength(1);
  });
});

describe("cache repository", () => {
  let sql: Sql;
  let repo: CacheRepo;
  let now: number;

  beforeEach(async () => {
    sql = memorySql().sql;
    await migrate(sql);
    now = 1_000;
    repo = new CacheRepo(sql, () => now);
  });

  it("replaces a host's projects and keeps the host's order", async () => {
    await repo.saveProjects("h1", [
      { id: "b", cwd: "/b", name: "b" },
      { id: "a", cwd: "/a", name: "a" },
    ]);
    await repo.saveProjects("h2", [{ id: "c", cwd: "/c", name: "c" }]);
    expect((await repo.loadProjects("h1")).map((p) => p.id)).toEqual(["b", "a"]);
    await repo.saveProjects("h1", [{ id: "a", cwd: "/a", name: "a2" }]);
    expect(await repo.loadProjects("h1")).toEqual([{ id: "a", cwd: "/a", name: "a2" }]);
    expect(await repo.loadProjects("h2")).toHaveLength(1);
  });

  it("stores session summaries per project, newest first", async () => {
    await repo.putSessionItems("h1", "p1", [item("s1", 10), item("s2", 30)]);
    await repo.putSessionItems("h1", "p2", [item("s3", 20)]);
    await repo.putSessionItems("h1", "p1", [item("s1", 40, { title: "renamed" })]);
    expect((await repo.loadSessionItems("h1", "p1")).map((s) => [s.id, s.title])).toEqual([
      ["s1", "renamed"],
      ["s2", "s2"],
    ]);
    await repo.deleteSessionItems("h1", ["s1"]);
    expect((await repo.loadSessionItems("h1", "p1")).map((s) => s.id)).toEqual(["s2"]);
    expect((await repo.loadSessionItems("h1", "p2")).map((s) => s.id)).toEqual(["s3"]);
  });

  it("round-trips the inbox", async () => {
    const inbox: InboxList = { boot: "b1", revision: 4, items: [], truncated: false };
    await repo.saveInbox("h1", inbox);
    expect(await repo.loadInbox("h1")).toEqual({ inbox, fetchedAt: 1_000 });
    expect(await repo.loadInbox("h2")).toBeUndefined();
  });

  it("round-trips a session window and its byte size", async () => {
    const value = windowOf("s1", "héllo ✓ 😀");
    expect(await repo.saveWindow("h1", "s1", value)).toEqual({ stored: true, evicted: [] });
    expect(await repo.loadWindow("h1", "s1")).toEqual(value);
    expect(await repo.windowBytes()).toBe(utf8Length(JSON.stringify(value)));
    expect(utf8Length("é✓😀")).toBe(2 + 3 + 4);
  });

  it("keeps a window over the per-window cap in memory only", async () => {
    repo = new CacheRepo(sql, () => now, { windowBudget: 10_000, windowMax: 600 });
    await repo.saveWindow("h1", "s1", windowOf("s1"));
    const big = windowOf("s1", "x".repeat(800));
    expect(await repo.saveWindow("h1", "s1", big)).toEqual({ stored: false, evicted: [] });
    expect(await repo.loadWindow("h1", "s1")).toBeUndefined();
  });

  describe("eviction", () => {
    const size = utf8Length(JSON.stringify(windowOf("s1", "x".repeat(200))));

    beforeEach(() => {
      // Room for two windows.
      repo = new CacheRepo(sql, () => now, { windowBudget: size * 2 + 10, windowMax: 10_000 });
    });

    const save = async (id: string, at: number) => {
      now = at;
      return repo.saveWindow("h1", id, windowOf(id, "x".repeat(200)));
    };

    it("evicts the least recently opened window first", async () => {
      await save("s1", 1);
      await save("s2", 2);
      expect((await save("s3", 3)).evicted).toEqual([{ env: "h1", id: "s1" }]);
      expect(await repo.windowBytes()).toBeLessThanOrEqual(size * 2 + 10);
    });

    it("counts opening a window as recent use", async () => {
      await save("s1", 1);
      await save("s2", 2);
      now = 3;
      await repo.loadWindow("h1", "s1");
      expect((await save("s3", 4)).evicted).toEqual([{ env: "h1", id: "s2" }]);
    });

    it("never evicts a window with outbox entries", async () => {
      await save("s1", 1);
      await save("s2", 2);
      await repo.outbox.put(entry("c1", { command: { type: "send", commandId: "c1", sessionId: "s1", text: "hi" } }));
      expect((await save("s3", 3)).evicted).toEqual([{ env: "h1", id: "s2" }]);
      // Still pinned when nothing else can go: the budget is exceeded instead.
      await repo.outbox.put(entry("c3", { command: { type: "send", commandId: "c3", sessionId: "s3", text: "hi" } }));
      expect((await save("s4", 4)).evicted).toEqual([]);
      expect(await repo.loadWindow("h1", "s1")).toBeDefined();
      expect(await repo.loadWindow("h1", "s3")).toBeDefined();
    });

    it("protects windows keyed by a local session id too", async () => {
      await repo.outbox.put(
        entry("c1", { localSessionId: "local-1", command: { type: "send", commandId: "c1", sessionId: "local-1", text: "hi" } }),
      );
      await save("local-1", 1);
      await save("s2", 2);
      expect((await save("s3", 3)).evicted).toEqual([{ env: "h1", id: "s2" }]);
      expect(await repo.loadWindow("h1", "local-1")).toBeDefined();
    });

    it("evicts again when the budget shrinks", async () => {
      await save("s1", 1);
      await save("s2", 2);
      repo = new CacheRepo(sql, () => now, { windowBudget: size + 5, windowMax: 10_000 });
      expect(await repo.evictWindows()).toEqual([{ env: "h1", id: "s1" }]);
    });
  });

  describe("outbox", () => {
    it("lists entries in created_at order with filters", async () => {
      await repo.outbox.put(entry("c2", { createdAt: 200 }));
      await repo.outbox.put(entry("c1", { createdAt: 100, state: "sending" }));
      await repo.outbox.put(entry("c3", { createdAt: 300, hostEnv: "h2" }));
      expect((await repo.outbox.list()).map((e) => e.commandId)).toEqual(["c1", "c2", "c3"]);
      expect((await repo.outbox.list({ env: "h1" })).map((e) => e.commandId)).toEqual(["c1", "c2"]);
      expect((await repo.outbox.list({ states: ["pending"] })).map((e) => e.commandId)).toEqual(["c2", "c3"]);
      expect((await repo.outbox.list({ sessionKey: "s1", env: "h2" })).map((e) => e.commandId)).toEqual(["c3"]);
      expect(await repo.outbox.list({ states: [] })).toEqual([]);
    });

    it("updates an entry and keeps the state column in step", async () => {
      await repo.outbox.put(entry("c1"));
      const receipt = { commandId: "c1", sessionId: "s1", revision: 3 };
      expect(await repo.outbox.update("c1", { state: "acked", attempts: 1, receipt })).toMatchObject({ state: "acked", attempts: 1, receipt });
      expect(await sql.all("SELECT state FROM outbox WHERE command_id = 'c1'")).toEqual([{ state: "acked" }]);
      expect(await repo.outbox.update("missing", { state: "failed" })).toBeUndefined();
    });

    it("rewrites a local session id after the create's receipt", async () => {
      await repo.outbox.put(entry("create", { command: { type: "create", commandId: "create", projectId: "p1", harness: "claude", model: "m", runtimeMode: "supervised" } }));
      await repo.outbox.put(
        entry("send", { localSessionId: "local-1", dependsOn: "create", command: { type: "send", commandId: "send", sessionId: "local-1", text: "hi" } }),
      );
      expect(await repo.outbox.rewriteSession("h1", "local-1", "s-real")).toBe(1);
      const send = await repo.outbox.get("send");
      expect(send?.command).toMatchObject({ sessionId: "s-real" });
      expect(send?.localSessionId).toBeUndefined();
      expect((await repo.outbox.list({ sessionKey: "s-real" })).map((e) => e.commandId)).toEqual(["send"]);
    });

    it("finds unsent entries past their expiry and deletes entries", async () => {
      await repo.outbox.put(entry("old", { expiresAt: 500 }));
      await repo.outbox.put(entry("acked", { expiresAt: 500, state: "acked" }));
      await repo.outbox.put(entry("new", { expiresAt: 5_000 }));
      expect((await repo.outbox.expired(1_000)).map((e) => e.commandId)).toEqual(["old"]);
      expect(await repo.outbox.delete("old")).toBe(true);
      expect(await repo.outbox.delete("old")).toBe(false);
    });

    it("keys an acked create by the session its receipt names", async () => {
      await repo.outbox.put(
        entry("create", {
          command: { type: "create", commandId: "create", projectId: "p1", harness: "claude", model: "m", runtimeMode: "supervised" },
          state: "acked",
          receipt: { commandId: "create", sessionId: "s-new", revision: 1 },
        }),
      );
      expect((await repo.outbox.list({ sessionKey: "s-new" })).map((e) => e.commandId)).toEqual(["create"]);
    });
  });

  it("keeps composer drafts per host and session, and purges them with the host", async () => {
    await repo.drafts.put("h1", "s1", { text: "half a thought", mode: "plan" });
    await repo.drafts.put("h2", "s1", { text: "other machine", mode: "default" });
    expect(await repo.drafts.get("h1", "s1")).toEqual({ text: "half a thought", mode: "plan" });
    await repo.drafts.put("h1", "s1", { text: "a whole thought", mode: "default" });
    expect(await repo.drafts.get("h1", "s1")).toEqual({ text: "a whole thought", mode: "default" });
    await repo.drafts.delete("h1", "s1");
    expect(await repo.drafts.get("h1", "s1")).toBeUndefined();
    await repo.purgeHost("h2");
    expect(await repo.drafts.get("h2", "s1")).toBeUndefined();
  });

  it("upgrades a version-1 cache to drafts without losing the outbox", async () => {
    const { sql } = memorySql();
    await migrate(sql, MIGRATIONS.slice(0, 1));
    await new CacheRepo(sql).outbox.put(entry("c1"));
    expect(await migrate(sql)).toEqual({ from: 1, to: SCHEMA_VERSION, reset: false });
    const upgraded = new CacheRepo(sql);
    await upgraded.drafts.put("h1", "s1", { text: "x" });
    expect(await upgraded.drafts.get("h1", "s1")).toEqual({ text: "x" });
    expect(await upgraded.outbox.list()).toHaveLength(1);
  });

  it("purges one host, or every host that is no longer paired", async () => {
    for (const env of ["h1", "h2", "h3"]) {
      await repo.saveProjects(env, [{ id: "p", cwd: "/", name: "p" }]);
      await repo.saveWindow(env, "s", windowOf("s"));
      await repo.outbox.put(entry(`c-${env}`, { hostEnv: env }));
    }
    await repo.purgeHost("h1");
    expect(await repo.loadProjects("h1")).toEqual([]);
    expect(await repo.outbox.list({ env: "h1" })).toEqual([]);
    await repo.purgeHostsExcept(["h3"]);
    expect(await repo.loadProjects("h2")).toEqual([]);
    expect(await repo.loadProjects("h3")).toHaveLength(1);
    expect((await repo.outbox.list()).map((e) => e.hostEnv)).toEqual(["h3"]);
    await repo.purgeHostsExcept([]);
    expect(await repo.windowBytes()).toBe(0);
  });
});
