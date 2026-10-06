import Foundation
import MonoKeychain
import Testing

@Suite struct KeychainTests {
  @Test func accountNamesFollowTheSpec() {
    #expect(KeychainAccount.deviceKey(env: "h1").name == "mc.host.h1.deviceKey")
    #expect(KeychainAccount.counter(env: "h1").name == "mc.host.h1.counter")
    #expect(KeychainAccount.deviceKey(env: "a b/c").name == "mc.host.a_b_c.deviceKey")
    #expect(KeychainAccount.pushKey.name == "mc.push.key")
    #expect(KeychainAccount.pushKeyPrevious.name == "mc.push.key.prev")
    #expect(KeychainAccount.cacheDBKey.name == "mc.cache.dbKey")
    #expect(KeychainAccount.pendingPairing.name == "mc.pending.pairing")
    #expect(KeychainAccount.appLock.name == "mc.applock")
    #expect(SystemKeychain.service == "mc")
  }

  @Test func setGetOverwriteDelete() throws {
    let keychain = Keychain(backend: InMemoryKeychain())
    #expect(try keychain.deviceKey(env: "h1") == nil)
    try keychain.setDeviceKey(Data([1, 2, 3]), env: "h1")
    try keychain.setDeviceKey(Data([4, 5, 6]), env: "h1")
    #expect(try keychain.deviceKey(env: "h1") == Data([4, 5, 6]))
    #expect(try keychain.deviceKey(env: "h2") == nil)
    try keychain.delete(.deviceKey(env: "h1"))
    #expect(try keychain.deviceKey(env: "h1") == nil)
    // Deleting what isn't there is fine.
    try keychain.delete(.deviceKey(env: "h1"))
  }

  @Test func pushKeysGoToTheSharedGroup() throws {
    let backend = InMemoryKeychain()
    let keychain = Keychain(backend: backend, appGroup: "TEAM.app", sharedGroup: "TEAM.shared")
    try keychain.set(Data([1]), for: .pushKey)
    try keychain.set(Data([2]), for: .pushKeyPrevious)
    try keychain.set(Data([3]), for: .deviceKey(env: "h1"))
    try keychain.set(Data([4]), for: .appLock)
    #expect(
      backend.keys == [
        .init(account: "mc.push.key", accessGroup: "TEAM.shared"),
        .init(account: "mc.push.key.prev", accessGroup: "TEAM.shared"),
        .init(account: "mc.host.h1.deviceKey", accessGroup: "TEAM.app"),
        .init(account: "mc.applock", accessGroup: "TEAM.app"),
      ])
    // The extension, configured with only the shared group, reads the push key.
    let extensionKeychain = Keychain(backend: backend, sharedGroup: "TEAM.shared")
    #expect(try extensionKeychain.data(.pushKey) == Data([1]))
    #expect(try extensionKeychain.data(.appLock) == nil)
  }

  @Test func counterIsStoredBeforeItIsUsed() throws {
    let backend = InMemoryKeychain()
    let keychain = Keychain(backend: backend)
    #expect(try keychain.nextCounter(env: "h1") == 1)
    #expect(try keychain.nextCounter(env: "h1") == 2)
    #expect(try keychain.nextCounter(env: "h2") == 1)
    // A fresh wrapper (a relaunch) carries on from the stored value.
    #expect(try Keychain(backend: backend).nextCounter(env: "h1") == 3)
  }

  @Test func deletingAHostDeletesItsKeyAndCounter() throws {
    let backend = InMemoryKeychain()
    let keychain = Keychain(backend: backend)
    try keychain.setDeviceKey(Data([9]), env: "h1")
    _ = try keychain.nextCounter(env: "h1")
    try keychain.setDeviceKey(Data([8]), env: "h2")
    try keychain.deleteHost(env: "h1")
    #expect(backend.keys == [.init(account: "mc.host.h2.deviceKey", accessGroup: nil)])
  }

  @Test func jsonValues() throws {
    struct AppLock: Codable, Equatable {
      var enabled: Bool
      var graceSeconds: Int
    }
    let keychain = Keychain(backend: InMemoryKeychain())
    #expect(try keychain.value(AppLock.self, for: .appLock) == nil)
    try keychain.setValue(AppLock(enabled: true, graceSeconds: 60), for: .appLock)
    #expect(try keychain.value(AppLock.self, for: .appLock) == AppLock(enabled: true, graceSeconds: 60))
  }
}
