import Foundation

// Keychain storage (03 §3.3, §3.9; 12 §12.6). Generic passwords under the
// service `mc`, after first unlock, this device only: out of iCloud and
// backups, and readable while the phone is locked. The backend is a protocol
// so tests run against memory.

/// Where an item lives: the app's own access group, or the one shared with the
/// Notification Service Extension.
public enum KeychainGroup: Sendable, Hashable {
  case app
  case shared
}

/// The accounts the app stores (12 §12.6).
public enum KeychainAccount: Sendable, Hashable {
  /// The X25519 private key for one host.
  case deviceKey(env: String)
  /// The handshake counter for one host, written before every attempt.
  case counter(env: String)
  /// The push private key, and the previous one during rotation.
  case pushKey
  case pushKeyPrevious
  /// The cache key, if spike S18 keeps SQLCipher.
  case cacheDBKey
  /// The pending pairing record (04 §4.7).
  case pendingPairing
  /// App lock settings.
  case appLock

  public var name: String {
    switch self {
    case .deviceKey(let env): "mc.host.\(Self.safe(env)).deviceKey"
    case .counter(let env): "mc.host.\(Self.safe(env)).counter"
    case .pushKey: "mc.push.key"
    case .pushKeyPrevious: "mc.push.key.prev"
    case .cacheDBKey: "mc.cache.dbKey"
    case .pendingPairing: "mc.pending.pairing"
    case .appLock: "mc.applock"
    }
  }

  /// Only the push keys are shared with the extension.
  public var group: KeychainGroup {
    switch self {
    case .pushKey, .pushKeyPrevious: .shared
    default: .app
    }
  }

  /// An env as an account segment, as the Expo app wrote it.
  static func safe(_ env: String) -> String {
    String(String.UnicodeScalarView(env.unicodeScalars.map { scalar in
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9", ".", "_", "-": scalar
      default: "_"
      }
    }))
  }
}

/// Raw item storage. `accessGroup` nil means the default group.
public protocol KeychainBackend: Sendable {
  func read(account: String, accessGroup: String?) throws -> Data?
  /// Adds the item, or replaces its value.
  func write(_ value: Data, account: String, accessGroup: String?) throws
  func delete(account: String, accessGroup: String?) throws
}

public struct KeychainError: Error, Equatable, Sendable {
  public var status: Int32
  public var operation: String

  public init(status: Int32, operation: String) {
    self.status = status
    self.operation = operation
  }
}

/// The typed accounts over a backend. Access groups come from the publisher
/// config (16 §16.3), so no Swift file names one; nil uses the default group.
public struct Keychain: Sendable {
  public let backend: any KeychainBackend
  public let appGroup: String?
  public let sharedGroup: String?

  public init(backend: any KeychainBackend, appGroup: String? = nil, sharedGroup: String? = nil) {
    self.backend = backend
    self.appGroup = appGroup
    self.sharedGroup = sharedGroup
  }

  public func accessGroup(for account: KeychainAccount) -> String? {
    account.group == .shared ? sharedGroup : appGroup
  }

  public func data(_ account: KeychainAccount) throws -> Data? {
    try backend.read(account: account.name, accessGroup: accessGroup(for: account))
  }

  public func set(_ value: Data, for account: KeychainAccount) throws {
    try backend.write(value, account: account.name, accessGroup: accessGroup(for: account))
  }

  public func delete(_ account: KeychainAccount) throws {
    try backend.delete(account: account.name, accessGroup: accessGroup(for: account))
  }

  /// A JSON value, for the pending pairing and app lock records.
  public func value<T: Decodable>(_ type: T.Type, for account: KeychainAccount) throws -> T? {
    guard let data = try data(account) else { return nil }
    return try JSONDecoder().decode(type, from: data)
  }

  public func setValue<T: Encodable>(_ value: T, for account: KeychainAccount) throws {
    try set(try JSONEncoder().encode(value), for: account)
  }

  // Hosts ─────────────────────────────────────────────────────────────────

  public func deviceKey(env: String) throws -> Data? {
    try data(.deviceKey(env: env))
  }

  public func setDeviceKey(_ key: Data, env: String) throws {
    try set(key, for: .deviceKey(env: env))
  }

  /// The next handshake counter, stored before it is returned so a crash
  /// mid-handshake never reuses one (03 §3.4).
  public func nextCounter(env: String) throws -> UInt64 {
    let current = try data(.counter(env: env)).flatMap { UInt64(String(decoding: $0, as: UTF8.self)) } ?? 0
    let next = current + 1
    try set(Data(String(next).utf8), for: .counter(env: env))
    return next
  }

  /// Deleting a host deletes its device key and counter (03 §3.3).
  public func deleteHost(env: String) throws {
    try delete(.deviceKey(env: env))
    try delete(.counter(env: env))
  }
}
