// The cache schema (12 §12.6) and its forward-only migrations. A migration
// that fails drops the cache tables, never `outbox` or `hosts`, and the app
// refetches what it lost.

import type { Sql } from "./sql";

/** Tables that only mirror host data; safe to drop and refetch. */
export const CACHE_TABLES = ["projects", "session_items", "session_windows", "inbox", "seen", "catalogs", "candidates"] as const;
/** Tables the phone owns: queued commands, paired hosts and composer drafts. */
export const KEPT_TABLES = ["hosts", "outbox", "drafts"] as const;

// Migration 1 is frozen: later shapes go in new migrations.
const V1 = `
CREATE TABLE IF NOT EXISTS hosts (env TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (env TEXT, id TEXT, json TEXT NOT NULL, updated_at INTEGER,
                                     PRIMARY KEY (env, id));
CREATE TABLE IF NOT EXISTS session_items (env TEXT, id TEXT, project_id TEXT, json TEXT NOT NULL,
                                          updated_at INTEGER, PRIMARY KEY (env, id));
CREATE INDEX IF NOT EXISTS session_items_project ON session_items (env, project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS session_windows (env TEXT, id TEXT, revision INTEGER NOT NULL, anchor TEXT,
                                            json TEXT NOT NULL, bytes INTEGER NOT NULL, opened_at INTEGER NOT NULL,
                                            PRIMARY KEY (env, id));
CREATE TABLE IF NOT EXISTS inbox (env TEXT PRIMARY KEY, boot TEXT, revision INTEGER, json TEXT NOT NULL,
                                  fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (command_id TEXT PRIMARY KEY, env TEXT NOT NULL, session_key TEXT,
                                   json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
                                   expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS seen (env TEXT, session_id TEXT, seen_at INTEGER NOT NULL, PRIMARY KEY (env, session_id));
CREATE TABLE IF NOT EXISTS catalogs (env TEXT, project_id TEXT, json TEXT NOT NULL, fetched_at INTEGER,
                                     PRIMARY KEY (env, project_id));
CREATE TABLE IF NOT EXISTS candidates (env TEXT, key TEXT, stats TEXT NOT NULL, PRIMARY KEY (env, key));
`;

// Migration 2: composer drafts, per session (11 §11.17).
const V2 = `
CREATE TABLE IF NOT EXISTS drafts (env TEXT, session_id TEXT, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
                                   PRIMARY KEY (env, session_id));
`;

/** Every table at the latest version, all `IF NOT EXISTS`. Rebuilds the cache
 * tables after a failed migration. Update it with any migration that changes
 * a table's shape. */
const LATEST = V1 + V2;

export type Migration = (tx: Sql) => Promise<void>;

/** Index i migrates version i to i + 1. Append only. */
export const MIGRATIONS: readonly Migration[] = [(tx) => tx.exec(V1), (tx) => tx.exec(V2)];

export const SCHEMA_VERSION = MIGRATIONS.length;

async function setVersion(tx: Sql, version: number): Promise<void> {
  await tx.run("DELETE FROM schema");
  await tx.run("INSERT INTO schema (version) VALUES (?)", [version]);
}

export async function schemaVersion(db: Sql): Promise<number> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL)");
  return (await db.first<{ version: number }>("SELECT version FROM schema LIMIT 1"))?.version ?? 0;
}

/** Drops the cache tables (never outbox or hosts) and rebuilds the schema at
 * `version`. */
export async function resetCache(db: Sql, version = SCHEMA_VERSION): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of CACHE_TABLES) await tx.exec(`DROP TABLE IF EXISTS ${table}`);
    await tx.exec(LATEST);
    await setVersion(tx, version);
  });
}

export type MigrationResult = { from: number; to: number; reset: boolean; error?: string };

/** Brings the database to the latest version, one transaction per step. */
export async function migrate(db: Sql, migrations: readonly Migration[] = MIGRATIONS): Promise<MigrationResult> {
  const from = await schemaVersion(db);
  const to = migrations.length;
  if (from === to) return { from, to, reset: false };
  try {
    if (from > to) throw new Error(`The cache is from a newer app (schema ${from}, this app knows ${to}).`);
    for (let version = from + 1; version <= to; version++)
      await db.transaction(async (tx) => {
        await migrations[version - 1](tx);
        await setVersion(tx, version);
      });
    return { from, to, reset: false };
  } catch (error) {
    await resetCache(db, to);
    return { from, to, reset: true, error: error instanceof Error ? error.message : String(error) };
  }
}
