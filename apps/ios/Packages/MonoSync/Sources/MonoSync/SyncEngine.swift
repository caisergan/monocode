import Foundation
import MonoChannel
import MonoKeychain
import MonoStore
import Observation
import Security

/// Where the engine keeps what outlives a launch (12 §12.6): the SQLite
/// cache (hosts, projects, lists, windows, seen, candidates) and the
/// Keychain (device keys, handshake counters, the pending pairing). Without
/// a database everything but the Keychain lives in memory.
public struct Persistence: Sendable {
  public let database: CacheDatabase?
  public let keychain: Keychain

  public init(database: CacheDatabase?, keychain: Keychain) {
    self.database = database
    self.keychain = keychain
  }

  /// Memory only: tests and previews.
  public static func inMemory() -> Persistence {
    Persistence(database: nil, keychain: Keychain(backend: InMemoryKeychain()))
  }

  /// `Application Support/monocode.sqlite` and the system Keychain. A cache
  /// that can't open is left out rather than failing the launch: the host is
  /// the source of truth.
  public static func onDevice(appGroup: String? = nil) -> Persistence {
    let database = try? CacheDatabase(url: CacheDatabase.defaultURL())
    return Persistence(database: database, keychain: Keychain(backend: SystemKeychain(), appGroup: appGroup))
  }

  /// A fresh install, for debug runs: deletes the cache file and every
  /// Keychain item under the app's service (device keys, counters, the
  /// pending pairing).
  public static func eraseOnDevice() {
    if let url = try? CacheDatabase.defaultURL() {
      for file in CacheDatabase.files(of: url) { try? FileManager.default.removeItem(at: file) }
    }
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SystemKeychain.service]
    #if os(macOS)
      query[kSecUseDataProtectionKeychain as String] = true
    #endif
    SecItemDelete(query as CFDictionary)
  }
}

/// The app's sync layer: the stores the screens read, the host registry, and
/// one `HostSync` per machine writing them (12 §12.5, §12.7).
@MainActor @Observable
public final class SyncEngine {
  public let hosts = HostsStore()
  public let inbox = InboxStore()
  public let projects = ProjectsStore()
  public let catalogs = CatalogStore()
  public let seen = SeenStore()
  public let pins: PinsStore
  /// A pairing that finished badly while the app was away (04 §4.7).
  public var pairingNotice: String?

  @ObservationIgnored let persistence: Persistence
  @ObservationIgnored let info: ClientInfo
  @ObservationIgnored private var syncs: [String: HostSync] = [:]
  @ObservationIgnored private let app: String
  @ObservationIgnored var pathSnapshot = NetworkPath.unknown
  @ObservationIgnored private var monitor: PathMonitor?
  @ObservationIgnored var timings = RaceTimings()
  /// The last record write: each waits for the one before, so a rename never
  /// lands under an older save, and a remove purges after every save.
  @ObservationIgnored private var saving: Task<Void, Never>?

  /// `defaults` keeps the project pins; nil keeps them in memory.
  public init(
    app: String = "MonoCode", info: ClientInfo = .current, persistence: Persistence = .inMemory(),
    defaults: UserDefaults? = nil
  ) {
    self.app = app
    self.info = info
    self.persistence = persistence
    pins = PinsStore(defaults: defaults)
    let database = persistence.database
    seen.persist = { env, sessionId, at in
      Task { try? await database?.markSeen(env: env, sessionId: sessionId, at: at) }
    }
  }

  var database: CacheDatabase? { persistence.database }

  public func host(_ env: String) -> HostSync? {
    syncs[env]
  }

  // MARK: Registry

  /// Paired machines from the cache, connected (cache first: their projects
  /// and inbox paint before the first answer).
  public func restore() async {
    guard let database, let records = try? await database.loadHosts() else { return }
    for record in records where syncs[record.env] == nil && !record.isDemo {
      addPaired(record, persist: false)
    }
  }

  /// Adds a machine reached through one plain transport (the demo) and
  /// connects to it. It is never persisted.
  public func add(_ record: HostRecord, transport: any Transport) {
    guard syncs[record.env] == nil else { return }
    let hello = PlainHello(env: record.env, app: app, providers: remoteProviders)
    start(record, runtime: HostRuntime(env: record.env, label: record.label, transport: transport, hello: hello))
  }

  /// Adds a paired machine: its device key is in the Keychain. Saved to the
  /// cache's `hosts` table unless it came from there.
  func addPaired(_ record: HostRecord, persist: Bool = true) {
    if let old = syncs[record.env] {
      // Paired again (after a revoke): the new device replaces the old.
      syncs[record.env] = nil
      old.stop()
      hosts.records.removeAll { $0.env == record.env }
    }
    if persist { save(record) }
    start(record, runtime: HostRuntime(env: record.env, label: record.label, connector: connector(for: record)))
  }

  private func start(_ record: HostRecord, runtime: HostRuntime) {
    hosts.records.append(record)
    hosts.states[record.env] = .idle
    let sync = HostSync(env: record.env, runtime: runtime, engine: self)
    syncs[record.env] = sync
    let path = pathSnapshot
    Task { await runtime.pathChanged(path) }
    sync.start()
  }

  /// The race over the record's endpoints, with its Keychain key and counter.
  private func connector(for record: HostRecord) -> any HostConnector {
    let env = record.env
    let keychain = persistence.keychain
    let database = database
    guard let secret = try? keychain.deviceKey(env: env), let deviceKey = try? KeyPair(secretKey: secret),
      let hostKey = try? Data(base64URL: record.hostKey)
    else { return MissingKeyConnector() }
    var connector = DirectConnector(
      env: env, hostKey: hostKey, deviceKey: deviceKey, info: info,
      endpoints: { [weak self] in await MainActor.run { self?.hosts.record(env)?.endpoints.map(\.wire) ?? [] } },
      stats: { (try? await database?.loadCandidates(env: env)) ?? [:] },
      report: { candidate, result in
        guard let database else { return }
        var stats = (try? await database.loadCandidates(env: env))?[candidate.key] ?? CandidateStats()
        stats.record(result)
        try? await database.saveCandidate(env: env, key: candidate.key, stats)
      },
      counter: { Int(try keychain.nextCounter(env: env)) })
    connector.timings = timings
    return connector
  }

  /// Writes a record through to the cache. The demo is never saved.
  func save(_ record: HostRecord) {
    guard !record.isDemo, let database else { return }
    let previous = saving
    saving = Task {
      await previous?.value
      try? await database.saveHost(record)
    }
  }

  /// Applies a change to a record and saves it.
  func update(_ env: String, _ change: (inout HostRecord) -> Void) {
    guard let index = hosts.records.firstIndex(where: { $0.env == env }) else { return }
    var record = hosts.records[index]
    change(&record)
    guard record != hosts.records[index] else { return }
    hosts.records[index] = record
    save(record)
  }

  /// Renames a machine on this phone (11 §11.21).
  public func rename(_ env: String, label: String) {
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    update(env) { $0.label = String(trimmed.prefix(64)) }
  }

  /// Removes a machine (04 §4.8): online, `devices.revokeSelf` first; then,
  /// either way, its device key, cached data and runtime.
  public func remove(_ env: String) async {
    guard let sync = syncs.removeValue(forKey: env) else { return }
    let isDemo = hosts.record(env)?.isDemo ?? false
    if !isDemo, hosts.states[env]?.isOnline == true {
      _ = try? await sync.runtime.request("devices.revokeSelf", [String: String](), timeout: .seconds(5)) as Ignored
    }
    sync.stop()
    hosts.records.removeAll { $0.env == env }
    hosts.states[env] = nil
    hosts.welcomes[env] = nil
    hosts.lastOnline[env] = nil
    inbox.hosts[env] = nil
    inbox.cachedHosts.remove(env)
    projects.hosts[env] = nil
    projects.lists = projects.lists.filter { $0.key.env != env }
    catalogs.catalogs[env] = nil
    pins.removeHost(env)
    guard !isDemo else { return }
    try? persistence.keychain.deleteHost(env: env)
    await saving?.value
    try? await database?.purgeHost(env: env)
  }

  // MARK: Interest

  /// Every machine's inbox, for the Agents tab and the root while active.
  public func watchInbox() -> Interest {
    let interests = syncs.values.map { $0.watchInbox() }
    return Interest { interests.forEach { $0.release() } }
  }

  /// Every machine's projects, for the Projects tab.
  public func loadProjects() {
    syncs.values.forEach { $0.loadProjects() }
  }

  /// Retries every machine now, skipping backoff (pull to refresh, Retry).
  public func reconnect() {
    for sync in syncs.values { Task { await sync.runtime.connect(.user) } }
  }

  // MARK: Lifecycle (05 §5.10)

  public func scenePhaseChanged(_ phase: AppPhase) {
    for sync in syncs.values { Task { await sync.runtime.scenePhaseChanged(phase) } }
  }

  /// Starts `NWPathMonitor`; every runtime hears each change.
  public func startMonitoringNetwork() {
    guard monitor == nil else { return }
    let monitor = PathMonitor()
    self.monitor = monitor
    monitor.start { [weak self] path in self?.pathChanged(path) }
  }

  public func pathChanged(_ next: NetworkPath) {
    pathSnapshot = next
    for sync in syncs.values { Task { await sync.runtime.pathChanged(next) } }
  }
}

/// A record whose device key is gone (the Keychain was reset): it can never
/// connect again, so it shows as removed from the host.
private struct MissingKeyConnector: HostConnector {
  func connect(path: NetworkPath) async throws -> Connection {
    throw ConnectFailure.blocked(.unknownDevice)
  }
}

extension CandidateStats {
  /// One attempt's outcome (05 §5.2): RTT as a moving average.
  mutating func record(_ result: AttemptResult, now: Date = Date()) {
    switch result {
    case let .won(rtt):
      let ms = Double(HostRuntime.ms(rtt))
      rttMs = rttMs.map { $0 * 0.7 + ms * 0.3 } ?? ms
      lastSuccessAt = now
      consecutiveFailures = 0
    case .failed:
      lastFailureAt = now
      consecutiveFailures += 1
    }
  }
}

extension PinsStore {
  func removeHost(_ env: String) {
    pins.removeAll { $0.hasPrefix("\(env)/") }
  }
}

extension HostRecord {
  /// The demo machine's fingerprint, which no real host has.
  public static let demoFingerprint = "demo"

  /// The in-app demo machine (11 §11.11), marked `Demo` and never saved.
  public var isDemo: Bool { fingerprint == Self.demoFingerprint }

  /// Its label colour, an index into the project colours (11 §11.2).
  public var colorIndex: Int { Int(color) ?? Self.colorIndex(for: env) }

  /// `projectColor`'s hash (`@monocode/design`): 1 to 8.
  public static func colorIndex(for id: String) -> Int {
    var hash: UInt32 = 0
    for unit in id.utf16 { hash = hash &* 31 &+ UInt32(unit) }
    return Int(hash % 8) + 1
  }

  /// The demo machine's record.
  public static func demo(env: String, label: String, colorIndex: Int) -> HostRecord {
    HostRecord(
      env: env, label: label, color: String(colorIndex), hostName: label, platform: "darwin", fingerprint: demoFingerprint,
      hostKey: "", deviceId: "demo-device", role: .member, endpoints: [], pairedAt: Date())
  }
}
