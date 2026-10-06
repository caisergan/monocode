import Foundation
import GRDB
import Testing

@testable import MonoStore

@Suite struct DatabaseTests {
  @Test func migratesFromEmpty() async throws {
    let cache = try makeCache()
    #expect(cache.migration == MigrationResult(from: 0, to: 1, reset: false, error: nil))
    #expect(try await cache.schemaVersion() == 1)

    let tables = try await cache.pool.read { db in
      try String.fetchAll(db, sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'grdb_%'")
    }
    #expect(Set(tables) == Set(Schema.tables + ["schema"]))
    let index = try await cache.pool.read { try $0.indexes(on: "session_items").map(\.name) }
    #expect(index.contains("session_items_project"))
    let applied = try await cache.pool.read { try Schema.migrator(Schema.migrations).appliedIdentifiers($0) }
    #expect(applied == ["v1"])
  }

  @Test func opensInWALMode() async throws {
    let cache = try makeCache()
    let mode = try await cache.pool.read { try String.fetchOne($0, sql: "PRAGMA journal_mode") }
    #expect(mode == "wal")
  }

  @Test func reopeningIsANoOp() async throws {
    let url = scratchURL()
    let first = try CacheDatabase(url: url)
    try await first.saveHost(hostRecord("h1"))
    try first.close()
    let second = try CacheDatabase(url: url)
    #expect(second.migration == MigrationResult(from: 1, to: 1, reset: false, error: nil))
    #expect(try await second.loadHosts().map(\.env) == ["h1"])
  }

  @Test func excludesTheFilesFromBackup() throws {
    let cache = try makeCache()
    for file in CacheDatabase.files(of: cache.url) where FileManager.default.fileExists(atPath: file.path) {
      let values = try file.resourceValues(forKeys: [.isExcludedFromBackupKey])
      #expect(values.isExcludedFromBackup == true, "\(file.lastPathComponent)")
    }
  }

  @Test func resetKeepsHostsOutboxAndDrafts() async throws {
    let cache = try makeCache()
    try await fillEveryTable(cache)

    try await cache.resetCache()

    #expect(try await cache.loadHosts().map(\.env) == ["h1"])
    #expect(try await cache.loadOutboxRows().map(\.commandId) == ["c1"])
    #expect(try await cache.loadDraft(String.self, env: "h1", key: "s1") == "half a thought")
    for table in Schema.cacheTables {
      let count = try await cache.pool.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM \(table)") }
      #expect(count == 0, "\(table)")
    }
    #expect(try await cache.schemaVersion() == 1)
    // The rebuilt tables take writes again.
    try await cache.saveProjects(env: "h1", [.init(id: "p1", cwd: "/repo", name: "repo")])
    #expect(try await cache.loadProjects(env: "h1").count == 1)
  }

  @Test func aFailedMigrationResetsTheCacheTables() async throws {
    let url = scratchURL()
    let first = try CacheDatabase(url: url, now: { Date() })
    try await fillEveryTable(first)
    try first.close()

    struct Boom: Error {}
    let failing = Schema.migrations + [Schema.Migration(identifier: "v2") { _ in throw Boom() }]
    let second = try CacheDatabase(url: url, now: { Date() }, migrations: failing)
    #expect(second.migration.reset)
    #expect(second.migration.from == 1 && second.migration.to == 2)
    #expect(try await second.schemaVersion() == 2)
    #expect(try await second.loadHosts().map(\.env) == ["h1"])
    #expect(try await second.loadOutboxRows().count == 1)
    #expect(try await second.loadProjects(env: "h1").isEmpty)
    try second.close()

    // The reset recorded v2 as applied, so the next open is clean.
    let third = try CacheDatabase(url: url, now: { Date() }, migrations: failing)
    #expect(!third.migration.reset)
  }

  @Test func aFileFromANewerAppResets() async throws {
    let url = scratchURL()
    let newer = Schema.migrations + [Schema.Migration(identifier: "v2") { _ in }]
    let first = try CacheDatabase(url: url, now: { Date() }, migrations: newer)
    try await fillEveryTable(first)
    try first.close()

    let older = try CacheDatabase(url: url, now: { Date() })
    #expect(older.migration.reset)
    #expect(try await older.schemaVersion() == 1)
    #expect(try await older.loadHosts().count == 1)
    #expect(try await older.loadInbox(env: "h1") == nil)
  }
}

/// One row in every table, for host `h1`.
func fillEveryTable(_ cache: CacheDatabase) async throws {
  try await cache.saveHost(hostRecord("h1"))
  try await cache.saveOutboxRow(outboxRow("c1", sessionKey: "s1"))
  try await cache.saveDraft("half a thought", env: "h1", key: "s1")
  try await cache.saveProjects(env: "h1", [.init(id: "p1", cwd: "/repo", name: "repo")])
  try await cache.saveSessionItems(env: "h1", projectId: "p1", [try sessionItem("s1", updatedAt: 1)])
  _ = try await cache.saveWindow(env: "h1", id: "s1", window("s1", bytes: 1_000))
  try await cache.saveInbox(env: "h1", .init(boot: "b", revision: 1, items: []))
  try await cache.markSeen(env: "h1", sessionId: "s1")
  try await cache.saveCatalog(env: "h1", projectId: "p1", .init())
  try await cache.saveCandidate(env: "h1", key: "lan|1.2.3.4|3775", CandidateStats(consecutiveFailures: 1))
}
