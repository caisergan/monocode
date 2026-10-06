import Foundation
import GRDB
import MonoWire

/// Size budgets (12 §12.6).
public struct CacheLimits: Hashable, Sendable {
  /// All session windows together: 64 MiB.
  public var windowBudget: Int
  /// A bigger window is kept in memory only: 4 MiB.
  public var windowMax: Int
  /// Read-state entries kept, newest first.
  public var seenLimit: Int

  public init(windowBudget: Int = 64 * 1024 * 1024, windowMax: Int = 4 * 1024 * 1024, seenLimit: Int = 500) {
    self.windowBudget = windowBudget
    self.windowMax = windowMax
    self.seenLimit = seenLimit
  }
}

/// An open session's window, as `SessionStore` holds it.
public struct CachedWindow: Codable, Hashable, Sendable {
  public var revision: Int
  public var value: HostSession
  public var window: WindowMeta?

  public init(revision: Int, value: HostSession, window: WindowMeta? = nil) {
    self.revision = revision
    self.value = value
    self.window = window
  }
}

public struct WindowKey: Hashable, Sendable {
  public var env: String
  public var id: String

  public init(env: String, id: String) {
    self.env = env
    self.id = id
  }
}

public struct WindowSaveResult: Hashable, Sendable {
  /// False when the window is over `windowMax` and stays in memory only.
  public var stored: Bool
  /// Windows dropped to fit the budget.
  public var evicted: [WindowKey]
}

extension CacheDatabase {
  /// Stores an open session's window, then evicts to the budget. A window over
  /// `windowMax` is kept in memory only: any stored copy is dropped so a stale
  /// one never paints.
  @concurrent
  public func saveWindow(env: String, id: String, _ entry: CachedWindow) async throws -> WindowSaveResult {
    let json = try JSONColumn.encode(entry)
    let bytes = json.utf8.count
    let limits = limits
    if bytes > limits.windowMax {
      try await deleteWindow(env: env, id: id)
      return WindowSaveResult(stored: false, evicted: [])
    }
    let at = now().millis
    return try await pool.write { db in
      try db.execute(
        sql: """
          INSERT OR REPLACE INTO session_windows (env, id, revision, anchor, json, bytes, opened_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          """,
        arguments: [env, id, entry.revision, entry.window?.anchor, json, bytes, at])
      let evicted = try Self.evict(db, budget: limits.windowBudget, keep: WindowKey(env: env, id: id))
      return WindowSaveResult(stored: true, evicted: evicted)
    }
  }

  /// The cached window, marked as opened now.
  @concurrent
  public func loadWindow(env: String, id: String) async throws -> CachedWindow? {
    let at = now().millis
    let json = try await pool.write { db -> String? in
      guard
        let json = try String.fetchOne(
          db, sql: "SELECT json FROM session_windows WHERE env = ? AND id = ?", arguments: [env, id])
      else { return nil }
      try db.execute(sql: "UPDATE session_windows SET opened_at = ? WHERE env = ? AND id = ?", arguments: [at, env, id])
      return json
    }
    return try json.map { try JSONColumn.decode(CachedWindow.self, from: $0) }
  }

  public func deleteWindow(env: String, id: String) async throws {
    try await pool.write { db in
      try db.execute(sql: "DELETE FROM session_windows WHERE env = ? AND id = ?", arguments: [env, id])
    }
  }

  /// The stored windows' total size.
  public func windowBytes() async throws -> Int {
    try await pool.read { try Int.fetchOne($0, sql: "SELECT COALESCE(SUM(bytes), 0) FROM session_windows") ?? 0 }
  }

  /// Evicts the least recently opened windows until the total fits the budget.
  public func evictWindows() async throws -> [WindowKey] {
    let budget = limits.windowBudget
    return try await pool.write { try Self.evict($0, budget: budget, keep: nil) }
  }

  /// Oldest `opened_at` first. Never evicts a window with outbox entries, nor
  /// `keep`, the one just written.
  static func evict(_ db: Database, budget: Int, keep: WindowKey?) throws -> [WindowKey] {
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT w.env, w.id, w.bytes,
               EXISTS (SELECT 1 FROM outbox o WHERE o.env = w.env AND o.session_key = w.id) AS pinned
          FROM session_windows w
         ORDER BY w.opened_at ASC, w.rowid ASC
        """)
    var total = rows.reduce(0) { $0 + ($1["bytes"] as Int) }
    var evicted: [WindowKey] = []
    for row in rows {
      if total <= budget { break }
      let key = WindowKey(env: row["env"], id: row["id"])
      if row["pinned"] as Bool || key == keep { continue }
      try db.execute(sql: "DELETE FROM session_windows WHERE env = ? AND id = ?", arguments: [key.env, key.id])
      total -= row["bytes"] as Int
      evicted.append(key)
    }
    return evicted
  }
}
