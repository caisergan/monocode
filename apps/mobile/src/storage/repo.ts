// Typed access to the cache tables (12 §12.6). The host stays the source of
// truth: everything here except the outbox is a copy that paints screens
// before the first sync and is refreshed after it.

import type { ChannelError } from "@monocode/channel";
import type { CommandReceipt, HostCommand, HostProject, HostSession } from "@monocode/core/session";
import type { InboxList, SessionListItem, WindowMeta } from "@monocode/core/wire";
import type { Sql, SqlValue } from "./sql";

/** All session windows together (12 §12.6). */
export const WINDOW_BUDGET_BYTES = 64 * 1024 * 1024;
/** A bigger window is kept in memory only. */
export const WINDOW_MAX_BYTES = 4 * 1024 * 1024;

const ENV_TABLES = ["projects", "session_items", "session_windows", "inbox", "seen", "catalogs", "candidates", "outbox", "drafts", "hosts"] as const;

/** UTF-8 length without allocating an encoded copy. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

export type CachedWindow = { revision: number; value: HostSession; window?: WindowMeta };
export type CachedInbox = { inbox: InboxList; fetchedAt: number };
export type WindowKey = { env: string; id: string };

// ── Outbox (06 §6.8) ─────────────────────────────────────────────────────────

export type OutboxState = "pending" | "sending" | "acked" | "failed";

export type OutboxEntry = {
  /** Also the entry id. */
  commandId: string;
  hostEnv: string;
  /** Fully formed, except a placeholder sessionId after a local create. */
  command: HostCommand;
  /** For commands that follow a create, until its receipt arrives. */
  localSessionId?: string;
  /** The create that must be acked first. */
  dependsOn?: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  state: OutboxState;
  receipt?: CommandReceipt;
  /** When the receipt arrived; an optimistic entry lingers 10 min at most. */
  ackedAt?: number;
  error?: ChannelError;
};

export type OutboxPatch = Partial<Omit<OutboxEntry, "commandId" | "hostEnv" | "createdAt">>;

type OutboxRow = { json: string };

/** The session an entry belongs to: its window is never evicted. An acked
 * create belongs to the session its receipt names. */
export function outboxSessionKey(entry: OutboxEntry): string | null {
  if (entry.localSessionId) return entry.localSessionId;
  const command = entry.command as { sessionId?: string };
  return command.sessionId ?? entry.receipt?.sessionId ?? null;
}

/** The persisted command queue. The outbox engine (12 §12.8) owns the
 * policy; this is storage only. Entries come back in `created_at` order. */
export class OutboxTable {
  constructor(private readonly db: Sql) {}

  private async write(tx: Sql, entry: OutboxEntry): Promise<void> {
    await tx.run(
      `INSERT OR REPLACE INTO outbox (command_id, env, session_key, json, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.commandId, entry.hostEnv, outboxSessionKey(entry), JSON.stringify(entry), entry.state, entry.createdAt, entry.expiresAt],
    );
  }

  /** Inserts, or replaces the entry with the same command id. */
  put(entry: OutboxEntry): Promise<void> {
    return this.db.transaction((tx) => this.write(tx, entry));
  }

  async get(commandId: string): Promise<OutboxEntry | undefined> {
    const row = await this.db.first<OutboxRow>("SELECT json FROM outbox WHERE command_id = ?", [commandId]);
    return row ? (JSON.parse(row.json) as OutboxEntry) : undefined;
  }

  async list(filter: { env?: string; sessionKey?: string; states?: readonly OutboxState[] } = {}): Promise<OutboxEntry[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.env !== undefined) {
      where.push("env = ?");
      params.push(filter.env);
    }
    if (filter.sessionKey !== undefined) {
      where.push("session_key = ?");
      params.push(filter.sessionKey);
    }
    if (filter.states) {
      if (!filter.states.length) return [];
      where.push(`state IN (${placeholders(filter.states.length)})`);
      params.push(...filter.states);
    }
    const rows = await this.db.all<OutboxRow>(
      `SELECT json FROM outbox ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`,
      params,
    );
    return rows.map((row) => JSON.parse(row.json) as OutboxEntry);
  }

  /** Read-modify-write in one transaction. Undefined when the entry is gone. */
  update(commandId: string, patch: OutboxPatch): Promise<OutboxEntry | undefined> {
    return this.db.transaction(async (tx) => {
      const row = await tx.first<OutboxRow>("SELECT json FROM outbox WHERE command_id = ?", [commandId]);
      if (!row) return undefined;
      const next = { ...(JSON.parse(row.json) as OutboxEntry), ...patch };
      await this.write(tx, next);
      return next;
    });
  }

  /** After a create's receipt: every entry waiting on the local session id
   * gets the host's id, in its command and its session key. */
  rewriteSession(env: string, localSessionId: string, sessionId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.all<OutboxRow>("SELECT json FROM outbox WHERE env = ? AND session_key = ?", [env, localSessionId]);
      for (const row of rows) {
        const entry = JSON.parse(row.json) as OutboxEntry;
        const command = entry.command as HostCommand & { sessionId?: string };
        const next: OutboxEntry = {
          ...entry,
          localSessionId: undefined,
          command: command.sessionId === localSessionId ? ({ ...command, sessionId } as HostCommand) : command,
        };
        await this.write(tx, next);
      }
      return rows.length;
    });
  }

  async delete(commandId: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM outbox WHERE command_id = ?", [commandId])).changes > 0;
  }

  /** Unsent entries past their expiry; the engine decides what to do. */
  expired(now: number): Promise<OutboxEntry[]> {
    return this.db
      .all<OutboxRow>("SELECT json FROM outbox WHERE expires_at <= ? AND state IN ('pending', 'sending') ORDER BY created_at, rowid", [now])
      .then((rows) => rows.map((row) => JSON.parse(row.json) as OutboxEntry));
  }
}

// ── Composer drafts (12 §12.5) ───────────────────────────────────────────────

/** What a composer holds between visits. `key` is a session id, or
 * `new:<projectId>` for the New session screen. */
export class DraftTable {
  constructor(
    private readonly db: Sql,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(env: string, key: string): Promise<T | undefined> {
    const row = await this.db.first<{ json: string }>("SELECT json FROM drafts WHERE env = ? AND session_id = ?", [env, key]);
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  async put(env: string, key: string, draft: unknown): Promise<void> {
    await this.db.run("INSERT OR REPLACE INTO drafts (env, session_id, json, updated_at) VALUES (?, ?, ?, ?)", [
      env,
      key,
      JSON.stringify(draft),
      this.now(),
    ]);
  }

  async delete(env: string, key: string): Promise<void> {
    await this.db.run("DELETE FROM drafts WHERE env = ? AND session_id = ?", [env, key]);
  }
}

// ── The cache ────────────────────────────────────────────────────────────────

export class CacheRepo {
  readonly outbox: OutboxTable;
  readonly drafts: DraftTable;

  constructor(
    private readonly db: Sql,
    private readonly now: () => number = Date.now,
    readonly limits = { windowBudget: WINDOW_BUDGET_BYTES, windowMax: WINDOW_MAX_BYTES },
  ) {
    this.outbox = new OutboxTable(db);
    this.drafts = new DraftTable(db, now);
  }

  // Projects ──────────────────────────────────────────────────────────────

  /** Replaces a host's project list, keeping the host's order. */
  saveProjects(env: string, projects: readonly HostProject[]): Promise<void> {
    return this.db.transaction(async (tx) => {
      await tx.run("DELETE FROM projects WHERE env = ?", [env]);
      const at = this.now();
      for (const project of projects)
        await tx.run("INSERT INTO projects (env, id, json, updated_at) VALUES (?, ?, ?, ?)", [env, project.id, JSON.stringify(project), at]);
    });
  }

  async loadProjects(env: string): Promise<HostProject[]> {
    const rows = await this.db.all<{ json: string }>("SELECT json FROM projects WHERE env = ? ORDER BY rowid", [env]);
    return rows.map((row) => JSON.parse(row.json) as HostProject);
  }

  // Session lists ───────────────────────────────────────────────────────────

  putSessionItems(env: string, projectId: string, items: readonly SessionListItem[]): Promise<void> {
    if (!items.length) return Promise.resolve();
    return this.db.transaction(async (tx) => {
      for (const item of items)
        await tx.run(
          "INSERT OR REPLACE INTO session_items (env, id, project_id, json, updated_at) VALUES (?, ?, ?, ?, ?)",
          [env, item.id, projectId, JSON.stringify(item), item.updatedAt],
        );
    });
  }

  async deleteSessionItems(env: string, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.run(`DELETE FROM session_items WHERE env = ? AND id IN (${placeholders(ids.length)})`, [env, ...ids]);
  }

  /** Every cached summary of a project, archived or not, newest first. */
  async loadSessionItems(env: string, projectId: string): Promise<SessionListItem[]> {
    const rows = await this.db.all<{ json: string }>(
      "SELECT json FROM session_items WHERE env = ? AND project_id = ? ORDER BY updated_at DESC",
      [env, projectId],
    );
    return rows.map((row) => JSON.parse(row.json) as SessionListItem);
  }

  // Session windows ─────────────────────────────────────────────────────────

  /** Stores an open session's window, then evicts to the budget. A window
   * over the per-window cap is kept in memory only: any stored copy is
   * dropped so a stale one never paints. */
  async saveWindow(env: string, id: string, entry: CachedWindow): Promise<{ stored: boolean; evicted: WindowKey[] }> {
    const json = JSON.stringify(entry);
    const bytes = utf8Length(json);
    if (bytes > this.limits.windowMax) {
      await this.db.run("DELETE FROM session_windows WHERE env = ? AND id = ?", [env, id]);
      return { stored: false, evicted: [] };
    }
    return this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT OR REPLACE INTO session_windows (env, id, revision, anchor, json, bytes, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [env, id, entry.revision, entry.window?.anchor ?? null, json, bytes, this.now()],
      );
      return { stored: true, evicted: await this.evict(tx, { env, id }) };
    });
  }

  /** The cached window, marked as opened now. */
  async loadWindow(env: string, id: string): Promise<CachedWindow | undefined> {
    const row = await this.db.first<{ json: string }>("SELECT json FROM session_windows WHERE env = ? AND id = ?", [env, id]);
    if (!row) return undefined;
    await this.db.run("UPDATE session_windows SET opened_at = ? WHERE env = ? AND id = ?", [this.now(), env, id]);
    return JSON.parse(row.json) as CachedWindow;
  }

  async deleteWindow(env: string, id: string): Promise<void> {
    await this.db.run("DELETE FROM session_windows WHERE env = ? AND id = ?", [env, id]);
  }

  async windowBytes(): Promise<number> {
    return (await this.db.first<{ total: number | null }>("SELECT SUM(bytes) AS total FROM session_windows"))?.total ?? 0;
  }

  /** Evicts the least recently opened windows until the total fits the
   * budget. Windows with outbox entries are never evicted, nor is `keep`. */
  evictWindows(): Promise<WindowKey[]> {
    return this.db.transaction((tx) => this.evict(tx));
  }

  private async evict(tx: Sql, keep?: WindowKey): Promise<WindowKey[]> {
    const rows = await tx.all<{ env: string; id: string; bytes: number; pinned: number }>(
      `SELECT w.env, w.id, w.bytes,
              EXISTS (SELECT 1 FROM outbox o WHERE o.env = w.env AND o.session_key = w.id) AS pinned
         FROM session_windows w
        ORDER BY w.opened_at ASC, w.rowid ASC`,
    );
    let total = rows.reduce((sum, row) => sum + row.bytes, 0);
    const evicted: WindowKey[] = [];
    for (const row of rows) {
      if (total <= this.limits.windowBudget) break;
      if (row.pinned || (keep && row.env === keep.env && row.id === keep.id)) continue;
      await tx.run("DELETE FROM session_windows WHERE env = ? AND id = ?", [row.env, row.id]);
      total -= row.bytes;
      evicted.push({ env: row.env, id: row.id });
    }
    return evicted;
  }

  // Inbox ───────────────────────────────────────────────────────────────────

  async saveInbox(env: string, inbox: InboxList): Promise<void> {
    await this.db.run(
      "INSERT OR REPLACE INTO inbox (env, boot, revision, json, fetched_at) VALUES (?, ?, ?, ?, ?)",
      [env, inbox.boot, inbox.revision, JSON.stringify(inbox), this.now()],
    );
  }

  async loadInbox(env: string): Promise<CachedInbox | undefined> {
    const row = await this.db.first<{ json: string; fetched_at: number }>("SELECT json, fetched_at FROM inbox WHERE env = ?", [env]);
    return row ? { inbox: JSON.parse(row.json) as InboxList, fetchedAt: row.fetched_at } : undefined;
  }

  // Hosts ───────────────────────────────────────────────────────────────────

  /** Forgets everything about a host, its queued commands included. */
  purgeHost(env: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      for (const table of ENV_TABLES) await tx.run(`DELETE FROM ${table} WHERE env = ?`, [env]);
    });
  }

  /** Drops rows of hosts that are no longer paired (removed while the app
   * was closed, or the demo machine from an earlier launch). */
  purgeHostsExcept(envs: readonly string[]): Promise<void> {
    return this.db.transaction(async (tx) => {
      for (const table of ENV_TABLES)
        await tx.run(envs.length ? `DELETE FROM ${table} WHERE env NOT IN (${placeholders(envs.length)})` : `DELETE FROM ${table}`, [...envs]);
    });
  }
}
