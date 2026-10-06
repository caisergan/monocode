import Foundation
import GRDB

// The cache schema (12 §12.6) and its forward-only migrations. These are the
// prototype's tables at its version 2, started here as version 1 since the
// Swift app is a new install. A failed migration drops the cache tables, never
// `hosts`, `outbox` or `drafts`, and the app refetches what it lost.

enum Schema {
  /// Tables that only mirror host data; safe to drop and refetch.
  static let cacheTables = ["projects", "session_items", "session_windows", "inbox", "seen", "catalogs", "candidates"]
  /// Tables the phone owns: paired hosts, queued commands and composer drafts.
  static let keptTables = ["hosts", "outbox", "drafts"]
  /// Every table but `schema`.
  static let tables = keptTables + cacheTables

  /// One forward-only step.
  struct Migration: Sendable {
    var identifier: String
    var apply: @Sendable (Database) throws -> Void
  }

  // Migration v1 is frozen: later shapes go in new migrations, and in `latest`.
  static let v1 = """
    CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL);
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
    CREATE TABLE IF NOT EXISTS drafts (env TEXT, session_id TEXT, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
                                       PRIMARY KEY (env, session_id));
    """

  /// Every table at the latest version, all `IF NOT EXISTS`: rebuilds the
  /// cache tables after a reset. Update it with any migration that changes a
  /// table's shape.
  static let latest = v1

  /// In order. Append only.
  static let migrations: [Migration] = [
    Migration(identifier: "v1") { db in try db.execute(sql: v1) }
  ]

  static func migrator(_ migrations: [Migration]) -> DatabaseMigrator {
    var migrator = DatabaseMigrator()
    for (index, migration) in migrations.enumerated() {
      migrator.registerMigration(migration.identifier) { db in
        try migration.apply(db)
        try setVersion(db, index + 1)
      }
    }
    return migrator
  }

  /// The `schema` table's version; 0 for an empty file.
  static func version(_ db: Database) throws -> Int {
    guard try db.tableExists("schema") else { return 0 }
    return try Int.fetchOne(db, sql: "SELECT version FROM schema LIMIT 1") ?? 0
  }

  static func setVersion(_ db: Database, _ version: Int) throws {
    try db.execute(sql: "DELETE FROM schema")
    try db.execute(sql: "INSERT INTO schema (version) VALUES (?)", arguments: [version])
  }

  /// Drops the cache tables, never `hosts`, `outbox` or `drafts`, and rebuilds
  /// the schema at the last of `migrations`.
  static func reset(_ db: Database, migrations: [Migration] = migrations) throws {
    for table in cacheTables { try db.execute(sql: "DROP TABLE IF EXISTS \(table)") }
    try db.execute(sql: latest)
    // Marks every known migration applied, and forgets unknown ones, in GRDB's
    // own bookkeeping table.
    try db.execute(sql: "CREATE TABLE IF NOT EXISTS grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY)")
    try db.execute(sql: "DELETE FROM grdb_migrations")
    for migration in migrations {
      try db.execute(sql: "INSERT INTO grdb_migrations (identifier) VALUES (?)", arguments: [migration.identifier])
    }
    try setVersion(db, migrations.count)
  }

  /// Brings the file to the latest version, one transaction per step. A failed
  /// step, or a file from a newer app, resets the cache tables.
  static func migrate(_ writer: some DatabaseWriter, migrations: [Migration] = migrations) throws -> MigrationResult {
    let migrator = migrator(migrations)
    let from = try writer.read { try version($0) }
    let to = migrations.count
    do {
      if try writer.read({ try migrator.hasBeenSuperseded($0) }) || from > to {
        throw CacheError.newerSchema(found: from, known: to)
      }
      try migrator.migrate(writer)
      return MigrationResult(from: from, to: to, reset: false, error: nil)
    } catch {
      try writer.write { try reset($0, migrations: migrations) }
      return MigrationResult(from: from, to: to, reset: true, error: String(describing: error))
    }
  }
}

/// What opening the cache did to its schema.
public struct MigrationResult: Equatable, Sendable {
  public var from: Int
  public var to: Int
  /// The cache tables were dropped and rebuilt.
  public var reset: Bool
  public var error: String?
}

public enum CacheError: Error, Equatable, Sendable {
  case newerSchema(found: Int, known: Int)
}
