import Foundation
import GRDB
import MonoWire

// Typed access to the tables (12 §12.6). Values are stored as JSON; times as
// milliseconds since 1970.

public struct CachedInbox: Hashable, Sendable {
  public var inbox: InboxList
  public var fetchedAt: Date
}

public struct CachedCatalog: Hashable, Sendable {
  public var catalog: ModelCatalog
  public var fetchedAt: Date?
}

/// A row of the outbox. Storage only: the outbox engine (12 §12.8) owns the
/// entry's shape and policy. `sessionKey` is the session the entry belongs
/// to; its window is never evicted.
public struct OutboxRow: Hashable, Sendable {
  public var commandId: String
  public var env: String
  public var sessionKey: String?
  public var json: String
  public var state: String
  public var createdAt: Date
  public var expiresAt: Date

  public init(commandId: String, env: String, sessionKey: String?, json: String, state: String, createdAt: Date, expiresAt: Date) {
    self.commandId = commandId
    self.env = env
    self.sessionKey = sessionKey
    self.json = json
    self.state = state
    self.createdAt = createdAt
    self.expiresAt = expiresAt
  }

  init(row: Row) {
    commandId = row["command_id"]
    env = row["env"]
    sessionKey = row["session_key"]
    json = row["json"]
    state = row["state"]
    createdAt = Date(millis: row["created_at"])
    expiresAt = Date(millis: row["expires_at"])
  }
}

private func placeholders(_ count: Int) -> String {
  Array(repeating: "?", count: count).joined(separator: ", ")
}

extension CacheDatabase {
  // Hosts ─────────────────────────────────────────────────────────────────

  /// Inserts or replaces a host, keeping its place in pairing order.
  public func saveHost(_ record: HostRecord) async throws {
    let json = try JSONColumn.encode(record)
    try await pool.write { db in
      try db.execute(
        sql: "INSERT INTO hosts (env, record) VALUES (?, ?) ON CONFLICT (env) DO UPDATE SET record = excluded.record",
        arguments: [record.env, json])
    }
  }

  public func loadHost(env: String) async throws -> HostRecord? {
    let json = try await pool.read { try String.fetchOne($0, sql: "SELECT record FROM hosts WHERE env = ?", arguments: [env]) }
    return try json.map { try JSONColumn.decode(HostRecord.self, from: $0) }
  }

  /// Every paired host, in pairing order.
  public func loadHosts() async throws -> [HostRecord] {
    let rows = try await pool.read { try String.fetchAll($0, sql: "SELECT record FROM hosts ORDER BY rowid") }
    return try rows.map { try JSONColumn.decode(HostRecord.self, from: $0) }
  }

  /// Forgets everything about a host, its queued commands and drafts included.
  public func purgeHost(env: String) async throws {
    try await pool.write { db in
      for table in Schema.tables { try db.execute(sql: "DELETE FROM \(table) WHERE env = ?", arguments: [env]) }
    }
  }

  /// Drops rows of hosts that are no longer paired.
  public func purgeHosts(except envs: [String]) async throws {
    try await pool.write { db in
      for table in Schema.tables {
        if envs.isEmpty {
          try db.execute(sql: "DELETE FROM \(table)")
        } else {
          try db.execute(
            sql: "DELETE FROM \(table) WHERE env NOT IN (\(placeholders(envs.count)))", arguments: StatementArguments(envs))
        }
      }
    }
  }

  // Projects ──────────────────────────────────────────────────────────────

  /// Replaces a host's project list, keeping the host's order.
  public func saveProjects(env: String, _ projects: [HostProject]) async throws {
    let rows = try projects.map { ($0.id, try JSONColumn.encode($0)) }
    let at = now().millis
    try await pool.write { db in
      try db.execute(sql: "DELETE FROM projects WHERE env = ?", arguments: [env])
      for (id, json) in rows {
        try db.execute(
          sql: "INSERT INTO projects (env, id, json, updated_at) VALUES (?, ?, ?, ?)", arguments: [env, id, json, at])
      }
    }
  }

  public func loadProjects(env: String) async throws -> [HostProject] {
    let rows = try await pool.read {
      try String.fetchAll($0, sql: "SELECT json FROM projects WHERE env = ? ORDER BY rowid", arguments: [env])
    }
    return try rows.map { try JSONColumn.decode(HostProject.self, from: $0) }
  }

  // Session lists ─────────────────────────────────────────────────────────

  public func saveSessionItems(env: String, projectId: String, _ items: [SessionListItem]) async throws {
    guard !items.isEmpty else { return }
    let rows = try items.map { ($0.id, try JSONColumn.encode($0), $0.updatedAt) }
    try await pool.write { db in
      for (id, json, updatedAt) in rows {
        try db.execute(
          sql: "INSERT OR REPLACE INTO session_items (env, id, project_id, json, updated_at) VALUES (?, ?, ?, ?, ?)",
          arguments: [env, id, projectId, json, updatedAt])
      }
    }
  }

  public func deleteSessionItems(env: String, ids: [String]) async throws {
    guard !ids.isEmpty else { return }
    try await pool.write { db in
      try db.execute(
        sql: "DELETE FROM session_items WHERE env = ? AND id IN (\(placeholders(ids.count)))",
        arguments: StatementArguments([env] + ids))
    }
  }

  /// Every cached summary of a project, archived or not, newest first.
  public func loadSessionItems(env: String, projectId: String) async throws -> [SessionListItem] {
    let rows = try await pool.read {
      try String.fetchAll(
        $0, sql: "SELECT json FROM session_items WHERE env = ? AND project_id = ? ORDER BY updated_at DESC",
        arguments: [env, projectId])
    }
    return try rows.map { try JSONColumn.decode(SessionListItem.self, from: $0) }
  }

  // Inbox ─────────────────────────────────────────────────────────────────

  public func saveInbox(env: String, _ inbox: InboxList) async throws {
    let json = try JSONColumn.encode(inbox)
    let at = now().millis
    try await pool.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO inbox (env, boot, revision, json, fetched_at) VALUES (?, ?, ?, ?, ?)",
        arguments: [env, inbox.boot, inbox.revision, json, at])
    }
  }

  public func loadInbox(env: String) async throws -> CachedInbox? {
    let row = try await pool.read { db -> (json: String, fetchedAt: Int64)? in
      try Row.fetchOne(db, sql: "SELECT json, fetched_at FROM inbox WHERE env = ?", arguments: [env])
        .map { ($0["json"], $0["fetched_at"]) }
    }
    guard let row else { return nil }
    return CachedInbox(inbox: try JSONColumn.decode(InboxList.self, from: row.json), fetchedAt: Date(millis: row.fetchedAt))
  }

  // Seen ──────────────────────────────────────────────────────────────────

  /// The phone's own read state (06 §6.10): "Done" shows until the session is
  /// opened here. Keeps the newest `seenLimit` entries.
  public func markSeen(env: String, sessionId: String, at date: Date? = nil) async throws {
    let at = (date ?? now()).millis
    let limit = limits.seenLimit
    try await pool.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO seen (env, session_id, seen_at) VALUES (?, ?, ?)", arguments: [env, sessionId, at])
      try db.execute(
        sql: "DELETE FROM seen WHERE rowid NOT IN (SELECT rowid FROM seen ORDER BY seen_at DESC, rowid DESC LIMIT ?)",
        arguments: [limit])
    }
  }

  /// When each session of a host was last opened here.
  public func loadSeen(env: String) async throws -> [String: Date] {
    try await pool.read { db in
      let rows = try Row.fetchAll(db, sql: "SELECT session_id, seen_at FROM seen WHERE env = ?", arguments: [env])
      return Dictionary(rows.map { ($0["session_id"], Date(millis: $0["seen_at"])) }) { $1 }
    }
  }

  // Catalogs ──────────────────────────────────────────────────────────────

  public func saveCatalog(env: String, projectId: String, _ catalog: ModelCatalog) async throws {
    let json = try JSONColumn.encode(catalog)
    let at = now().millis
    try await pool.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO catalogs (env, project_id, json, fetched_at) VALUES (?, ?, ?, ?)",
        arguments: [env, projectId, json, at])
    }
  }

  public func loadCatalog(env: String, projectId: String) async throws -> CachedCatalog? {
    let row = try await pool.read { db -> (json: String, fetchedAt: Int64?)? in
      try Row.fetchOne(
        db, sql: "SELECT json, fetched_at FROM catalogs WHERE env = ? AND project_id = ?", arguments: [env, projectId]
      ).map { ($0["json"], $0["fetched_at"]) }
    }
    guard let row else { return nil }
    return CachedCatalog(
      catalog: try JSONColumn.decode(ModelCatalog.self, from: row.json), fetchedAt: row.fetchedAt.map(Date.init(millis:)))
  }

  // Candidates ────────────────────────────────────────────────────────────

  /// Stats for one endpoint candidate; `key` is `HostEndpoint.candidateKey`.
  public func saveCandidate(env: String, key: String, _ stats: CandidateStats) async throws {
    let json = try JSONColumn.encode(stats)
    try await pool.write { db in
      try db.execute(sql: "INSERT OR REPLACE INTO candidates (env, key, stats) VALUES (?, ?, ?)", arguments: [env, key, json])
    }
  }

  public func loadCandidates(env: String) async throws -> [String: CandidateStats] {
    let rows = try await pool.read { db in
      try Row.fetchAll(db, sql: "SELECT key, stats FROM candidates WHERE env = ?", arguments: [env])
        .map { (key: $0["key"] as String, stats: $0["stats"] as String) }
    }
    var result: [String: CandidateStats] = [:]
    for row in rows { result[row.key] = try JSONColumn.decode(CandidateStats.self, from: row.stats) }
    return result
  }

  public func deleteCandidates(env: String, keys: [String]) async throws {
    guard !keys.isEmpty else { return }
    try await pool.write { db in
      try db.execute(
        sql: "DELETE FROM candidates WHERE env = ? AND key IN (\(placeholders(keys.count)))",
        arguments: StatementArguments([env] + keys))
    }
  }

  // Drafts (12 §12.5) ─────────────────────────────────────────────────────

  /// What a composer holds between visits. `key` is a session id, or
  /// `new:<projectId>` for the New session screen.
  public func loadDraft<T: Decodable & Sendable>(_ type: T.Type, env: String, key: String) async throws -> T? {
    let json = try await pool.read {
      try String.fetchOne($0, sql: "SELECT json FROM drafts WHERE env = ? AND session_id = ?", arguments: [env, key])
    }
    return try json.map { try JSONColumn.decode(type, from: $0) }
  }

  public func saveDraft<T: Encodable & Sendable>(_ draft: T, env: String, key: String) async throws {
    let json = try JSONColumn.encode(draft)
    let at = now().millis
    try await pool.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO drafts (env, session_id, json, updated_at) VALUES (?, ?, ?, ?)",
        arguments: [env, key, json, at])
    }
  }

  public func deleteDraft(env: String, key: String) async throws {
    try await pool.write { db in
      try db.execute(sql: "DELETE FROM drafts WHERE env = ? AND session_id = ?", arguments: [env, key])
    }
  }

  // Outbox rows ───────────────────────────────────────────────────────────

  /// Inserts, or replaces the row with the same command id.
  public func saveOutboxRow(_ row: OutboxRow) async throws {
    try await pool.write { db in
      try db.execute(
        sql: """
          INSERT OR REPLACE INTO outbox (command_id, env, session_key, json, state, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          """,
        arguments: [row.commandId, row.env, row.sessionKey, row.json, row.state, row.createdAt.millis, row.expiresAt.millis])
    }
  }

  /// A host's rows, or every row, in `created_at` order.
  public func loadOutboxRows(env: String? = nil) async throws -> [OutboxRow] {
    try await pool.read { db in
      let rows =
        if let env {
          try Row.fetchAll(db, sql: "SELECT * FROM outbox WHERE env = ? ORDER BY created_at, rowid", arguments: [env])
        } else {
          try Row.fetchAll(db, sql: "SELECT * FROM outbox ORDER BY created_at, rowid")
        }
      return rows.map(OutboxRow.init(row:))
    }
  }

  public func deleteOutboxRow(commandId: String) async throws {
    try await pool.write { db in
      try db.execute(sql: "DELETE FROM outbox WHERE command_id = ?", arguments: [commandId])
    }
  }
}
