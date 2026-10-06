import Foundation
import Security

/// Keychain Services: generic passwords, service `mc`,
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
public struct SystemKeychain: KeychainBackend {
  public static let service = "mc"

  public init() {}

  private func query(account: String, accessGroup: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: account,
    ]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    #if os(macOS)
      // The iOS-style keychain, so the accessibility class applies.
      query[kSecUseDataProtectionKeychain as String] = true
    #endif
    return query
  }

  public func read(account: String, accessGroup: String?) throws -> Data? {
    var query = query(account: account, accessGroup: accessGroup)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError(status: status, operation: "read") }
    return result as? Data
  }

  public func write(_ value: Data, account: String, accessGroup: String?) throws {
    let query = query(account: account, accessGroup: accessGroup)
    let attributes: [String: Any] = [
      kSecValueData as String: value,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      let added = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
      guard added == errSecSuccess else { throw KeychainError(status: added, operation: "add") }
    } else if status != errSecSuccess {
      throw KeychainError(status: status, operation: "update")
    }
  }

  public func delete(account: String, accessGroup: String?) throws {
    let status = SecItemDelete(query(account: account, accessGroup: accessGroup) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError(status: status, operation: "delete")
    }
  }
}
