import Foundation
import Synchronization

/// A Keychain in memory, for tests and previews. Items are keyed by access
/// group and account, as in the real Keychain.
public final class InMemoryKeychain: KeychainBackend {
  public struct Key: Hashable, Sendable {
    public var account: String
    public var accessGroup: String?

    public init(account: String, accessGroup: String?) {
      self.account = account
      self.accessGroup = accessGroup
    }
  }

  private let items = Mutex<[Key: Data]>([:])

  public init() {}

  public func read(account: String, accessGroup: String?) throws -> Data? {
    items.withLock { $0[Key(account: account, accessGroup: accessGroup)] }
  }

  public func write(_ value: Data, account: String, accessGroup: String?) throws {
    items.withLock { $0[Key(account: account, accessGroup: accessGroup)] = value }
  }

  public func delete(account: String, accessGroup: String?) throws {
    _ = items.withLock { $0.removeValue(forKey: Key(account: account, accessGroup: accessGroup)) }
  }

  /// Every stored item, for assertions.
  public var keys: Set<Key> {
    items.withLock { Set($0.keys) }
  }
}
