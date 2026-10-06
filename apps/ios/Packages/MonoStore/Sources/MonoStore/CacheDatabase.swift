import Foundation
import GRDB

/// The phone's SQLite cache (12 §12.6): `monocode.sqlite` in Application
/// Support, a GRDB `DatabasePool` in WAL mode, so reads run concurrently off the
/// main thread. Per spike S18 the file is plain SQLite under the Data
/// Protection class `completeUntilFirstUserAuthentication`, excluded from
/// backups. The host stays the source of truth: everything here except the
/// outbox and drafts is a copy that paints screens before the first sync.
public final class CacheDatabase: Sendable {
  public static let fileName = "monocode.sqlite"

  public let url: URL
  /// What opening did to the schema; log a reset.
  public let migration: MigrationResult
  public let limits: CacheLimits
  let pool: DatabasePool
  let now: @Sendable () -> Date

  /// Opens (or creates) the cache at `url` and migrates it.
  public convenience init(url: URL, limits: CacheLimits = CacheLimits()) throws {
    try self.init(url: url, limits: limits, now: { Date() })
  }

  init(url: URL, limits: CacheLimits = CacheLimits(), now: @escaping @Sendable () -> Date,
       migrations: [Schema.Migration] = Schema.migrations) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    var config = Configuration()
    config.label = "MonoStore"
    pool = try DatabasePool(path: url.path, configuration: config)
    migration = try Schema.migrate(pool, migrations: migrations)
    self.url = url
    self.limits = limits
    self.now = now
    try Self.protect(url)
  }

  /// `Application Support/monocode.sqlite`.
  public static func defaultURL() throws -> URL {
    try FileManager.default
      .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent(fileName)
  }

  /// The database file and its WAL and shared-memory files. SQLite recreates
  /// the last two, so they are protected again at every open.
  public static func files(of url: URL) -> [URL] {
    [url, URL(fileURLWithPath: url.path + "-wal"), URL(fileURLWithPath: url.path + "-shm")]
  }

  static func protect(_ url: URL) throws {
    for var file in files(of: url) where FileManager.default.fileExists(atPath: file.path) {
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try file.setResourceValues(values)
      #if os(iOS)
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
      #endif
    }
  }

  /// Drops the cache tables and rebuilds them empty. Keeps `hosts`, `outbox`
  /// and `drafts`.
  public func resetCache() async throws {
    try await pool.write { try Schema.reset($0) }
  }

  /// The schema version in the `schema` table.
  public func schemaVersion() async throws -> Int {
    try await pool.read { try Schema.version($0) }
  }

  /// Closes the pool; later calls throw.
  public func close() throws {
    try pool.close()
  }
}

// JSON columns ────────────────────────────────────────────────────────────

/// Dates as milliseconds since 1970, as the host and the Expo app write them.
enum JSONColumn {
  static func encode<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .millisecondsSince1970
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  static func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .millisecondsSince1970
    return try decoder.decode(type, from: Data(json.utf8))
  }
}

extension Date {
  /// Milliseconds since 1970, the unit of every time column.
  var millis: Int64 { Int64((timeIntervalSince1970 * 1000).rounded()) }

  init(millis: Int64) {
    self.init(timeIntervalSince1970: Double(millis) / 1000)
  }
}
