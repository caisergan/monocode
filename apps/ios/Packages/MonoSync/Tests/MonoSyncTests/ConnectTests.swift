import Foundation
import MonoChannel
import MonoKeychain
import MonoStore
import Testing

@testable import MonoSync

@Suite struct CandidateTests {
  let endpoints = [
    Endpoint(kind: .manual, addr: "203.0.113.5", port: 3775),
    Endpoint(kind: .tailscale, addr: "100.64.0.2", port: 3775, dns: "mac.tail1.ts.net"),
    Endpoint(kind: .lan, addr: "fd00::2", port: 3775),
    Endpoint(kind: .lan, addr: "192.168.1.20", port: 3775),
    Endpoint(kind: "wormhole", addr: "x", port: 1),
  ]

  @Test func ordersByKindThenStats() {
    let order = Candidates.order(endpoints, path: .unknown).map(\.key)
    #expect(order == [
      "lan|192.168.1.20|3775", "lan|fd00::2|3775", "tailscale|100.64.0.2|3775", "tailscale|mac.tail1.ts.net|3775",
      "manual|203.0.113.5|3775",
    ])
  }

  @Test func theRecentWinnerGoesFirst() {
    let now = Date()
    let stats = [
      "manual|203.0.113.5|3775": CandidateStats(lastSuccessAt: now.addingTimeInterval(-60)),
      "tailscale|100.64.0.2|3775": CandidateStats(lastSuccessAt: now.addingTimeInterval(-90_000)),
    ]
    #expect(Candidates.order(endpoints, path: .unknown, stats: stats, now: now).first?.key == "manual|203.0.113.5|3775")
  }

  @Test func failuresAndRttBreakTies() {
    let two = [Endpoint(kind: .lan, addr: "10.0.0.1", port: 1), Endpoint(kind: .lan, addr: "10.0.0.2", port: 1)]
    let stats = ["lan|10.0.0.1|1": CandidateStats(consecutiveFailures: 2)]
    #expect(Candidates.order(two, path: .unknown, stats: stats).first?.host == "10.0.0.2")
    let rtt = ["lan|10.0.0.1|1": CandidateStats(rttMs: 40), "lan|10.0.0.2|1": CandidateStats(rttMs: 8)]
    #expect(Candidates.order(two, path: .unknown, stats: rtt).first?.host == "10.0.0.2")
  }

  @Test func cellularSkipsLanUnlessAVpnCarriesIt() {
    let cellular = NetworkPath(satisfied: true, interfaces: [.cellular])
    #expect(!Candidates.order(endpoints, path: cellular).contains { $0.kind == .lan })
    let vpn = NetworkPath(satisfied: true, interfaces: [.cellular, .other], vpn: true)
    #expect(Candidates.order(endpoints, path: vpn).contains { $0.kind == .lan })
    #expect(Candidates.order(endpoints, path: .none).isEmpty)
  }

  @Test func urlsBracketIPv6() {
    #expect(Candidate(kind: .lan, host: "fd00::2", port: 3775).url.absoluteString == "ws://[fd00::2]:3775/v1/channel")
    #expect(Candidate(kind: .lan, host: "192.168.1.20", port: 3775).url.absoluteString == "ws://192.168.1.20:3775/v1/channel")
  }

  @Test func statsKeepAMovingAverage() {
    var stats = CandidateStats(consecutiveFailures: 3)
    stats.record(.won(.milliseconds(100)))
    #expect(stats.consecutiveFailures == 0 && stats.rttMs == 100)
    stats.record(.won(.milliseconds(0)))
    #expect(stats.rttMs == 70)
    stats.record(.failed)
    #expect(stats.consecutiveFailures == 1 && stats.lastFailureAt != nil)
  }

  @Test func handshakeFailuresMapToStates() {
    #expect(HandshakeFailure(code: .deviceRevoked, message: "", authenticated: true).connectFailure == .blocked(.deviceRevoked))
    #expect(HandshakeFailure(code: .unknownDevice, message: "", authenticated: true).connectFailure == .blocked(.unknownDevice))
    #expect(HandshakeFailure(code: .devicePending, message: "", authenticated: true).connectFailure == .pending)
    // Unauthenticated, a revoke is only a hint: it counts towards nothing.
    #expect(HandshakeFailure(code: .deviceRevoked, message: "", authenticated: false).connectFailure == .unreachable)
    #expect(HandshakeFailure(code: .handshakeFailed, message: "", authenticated: false).connectFailure == .rejected)
  }

  @Test func anEmptyRaceFailsAtOnce() async {
    await #expect(throws: ConnectFailure.unreachable) {
      _ = try await Race.run([], env: "e", hostKey: Data(count: 32), deviceKey: .generate(), hello: { fatalError() })
    }
  }

  @Test func aRefusedCandidateFailsFast() async throws {
    // Nothing listens on port 9 of loopback: refused, not a 20 s wait.
    let started = ContinuousClock.now
    await #expect(throws: (any Error).self) {
      _ = try await Race.run(
        [Candidate(kind: .manual, host: "127.0.0.1", port: 9)], env: "e", hostKey: Data(count: 32), deviceKey: .generate(),
        hello: { fatalError() })
    }
    #expect(started.duration(to: .now) < .seconds(5))
  }
}

/// A connector that answers from a script, for the runtime's states.
private final class ScriptedConnector: HostConnector, @unchecked Sendable {
  private let lock = NSLock()
  private var failures: [ConnectFailure]
  private(set) var calls = 0

  init(_ failures: [ConnectFailure]) {
    self.failures = failures
  }

  func connect(path: NetworkPath) async throws -> Connection {
    let failure = lock.withLock {
      calls += 1
      return failures.isEmpty ? ConnectFailure.unreachable : failures.removeFirst()
    }
    throw failure
  }
}

@Suite struct RuntimeStateTests {
  private func waitFor(_ runtime: HostRuntime, _ match: @escaping (HostConnState) -> Bool) async -> HostConnState? {
    let deadline = ContinuousClock.now + .seconds(10)
    while ContinuousClock.now < deadline {
      let state = await runtime.state
      if match(state) { return state }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return nil
  }

  @Test func aRevokedDeviceIsBlockedAndStopsRetrying() async throws {
    let connector = ScriptedConnector([.blocked(.deviceRevoked)])
    let runtime = HostRuntime(env: "e", label: "Mac", connector: connector)
    await runtime.connect()
    #expect(await waitFor(runtime) { $0 == .blocked(.deviceRevoked) } != nil)
    await runtime.connect(.user)
    try await Task.sleep(for: .milliseconds(200))
    #expect(connector.calls == 1)
    await #expect(throws: RuntimeError.offline("Mac")) { let _: Ignored = try await runtime.request("projects.list", [String: String]()) }
  }

  @Test func threeRejectionsMeanTheHostChanged() async throws {
    let connector = ScriptedConnector([.rejected, .rejected, .rejected])
    let runtime = HostRuntime(env: "e", label: "Mac", connector: connector)
    await runtime.connect()
    // Backoff waits 1 s then 2 s between them.
    #expect(await waitFor(runtime) { $0 == .blocked(.hostIdentityChanged) } != nil)
    #expect(connector.calls == 3)
  }

  @Test func noNetworkIsOfflineWithoutTrying() async throws {
    let connector = ScriptedConnector([])
    let runtime = HostRuntime(env: "e", label: "Mac", connector: connector)
    await runtime.pathChanged(.none)
    await runtime.connect()
    let state = await runtime.state
    guard case .offline(.noNetwork, _, _) = state else {
      Issue.record("expected offline(noNetwork), got \(state)")
      return
    }
    #expect(connector.calls == 0)
    // The network returning races at once.
    await runtime.pathChanged(.unknown)
    #expect(await waitFor(runtime) { if case .offline(.hostUnreachable, _, _) = $0 { true } else { false } } != nil)
    #expect(connector.calls >= 1)
  }

  @Test func backgroundStopsRetries() async throws {
    let connector = ScriptedConnector([])
    let runtime = HostRuntime(env: "e", label: "Mac", connector: connector)
    await runtime.connect()
    _ = await waitFor(runtime) { if case .offline = $0 { true } else { false } }
    await runtime.scenePhaseChanged(.background)
    let calls = connector.calls
    try await Task.sleep(for: .milliseconds(1500))
    #expect(connector.calls == calls)
    await runtime.scenePhaseChanged(.active)
    try await Task.sleep(for: .milliseconds(200))
    #expect(connector.calls == calls + 1)
  }
}

@Suite @MainActor struct PersistenceTests {
  @Test func pairedHostsSeenAndPinsSurviveARelaunch() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "monosync-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let keychain = Keychain(backend: InMemoryKeychain())
    let defaults = UserDefaults(suiteName: "monosync-\(UUID().uuidString)")!
    let key = KeyPair.generate()
    try keychain.setDeviceKey(key.secretKey, env: "e1")
    let record = HostRecord(
      env: "e1", label: "Mac", color: "3", hostName: "mac", platform: "darwin", fingerprint: "F", hostKey: KeyPair.generate().publicKey.base64URL,
      deviceId: "d1", role: .member, endpoints: [HostEndpoint(kind: .lan, addr: "127.0.0.1", port: 9)], pairedAt: Date())

    do {
      let engine = SyncEngine(
        persistence: Persistence(database: try CacheDatabase(url: directory.appending(path: "c.sqlite")), keychain: keychain),
        defaults: defaults)
      engine.addPaired(record)
      engine.pins.toggle("e1", "p1")
      engine.seen.markSeen("e1", "s1", at: Date(timeIntervalSince1970: 1_000))
      engine.rename("e1", label: "Studio")
      try await Task.sleep(for: .milliseconds(300))
      await engine.remove("demo-never-added")
    }

    let engine = SyncEngine(
      persistence: Persistence(database: try CacheDatabase(url: directory.appending(path: "c.sqlite")), keychain: keychain),
      defaults: defaults)
    await engine.restore()
    #expect(engine.hosts.records.map(\.label) == ["Studio"])
    #expect(engine.pins.isPinned("e1", "p1"))
    try await Task.sleep(for: .milliseconds(300))
    #expect(engine.seen.seen[SeenStore.key("e1", "s1")] == Date(timeIntervalSince1970: 1_000))

    await engine.remove("e1")
    #expect(engine.hosts.records.isEmpty)
    #expect(try keychain.deviceKey(env: "e1") == nil)
    #expect(!engine.pins.isPinned("e1", "p1"))
    let reopened = try CacheDatabase(url: directory.appending(path: "c.sqlite"))
    #expect(try await reopened.loadHosts().isEmpty)
  }

  @Test func theDemoIsNeverSaved() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "monosync-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let database = try CacheDatabase(url: directory.appending(path: "c.sqlite"))
    let engine = SyncEngine(persistence: Persistence(database: database, keychain: Keychain(backend: InMemoryKeychain())))
    let demo = HostRecord.demo(env: "d", label: "Demo", colorIndex: 1)
    #expect(demo.isDemo)
    engine.add(demo, transport: NeverTransport())
    engine.update("d") { $0.label = "Renamed" }
    try await Task.sleep(for: .milliseconds(200))
    #expect(try await database.loadHosts().isEmpty)
  }

  @Test func pairingStagesAreTitled() {
    let offer = try! parseOfferLink(
      encodeOfferLink(
        Offer(
          env: "6f0b1f8e-3c2a-4a59-9a77-5d1c2b0f4e11", name: "mac-mini", key: Data(count: 32).base64URL,
          offer: Data(count: 16).base64URL, secret: Data(count: 32).base64URL, exp: 4_000_000_000,
          direct: [Endpoint(kind: .lan, addr: "192.168.1.2", port: 3775)]),
        linkBase: "monocode-dev://pair"))
    let shown = PairingOffer(offer)
    #expect(shown.reachable == "Local network")
    #expect(PairingStage.review(shown).title == "Connect to mac-mini?")
    #expect(PairingStage.confirm(shown, code: "482913", deadline: Date()).title == "Confirm")
    #expect(PairingStage.start.title == "Pair a computer")
  }

  @Test func aPastedLinkOpensTheReviewAndJunkDoesNot() {
    let engine = SyncEngine()
    let flow = PairingFlow(engine: engine, phoneName: "iPhone")
    #expect(!flow.read("https://example.com"))
    #expect(flow.linkError == "This isn’t a MonoCode pairing code." || flow.linkError == "This isn't a MonoCode pairing code.")
    let link = try! encodeOfferLink(
      Offer(
        env: "6f0b1f8e-3c2a-4a59-9a77-5d1c2b0f4e11", name: "mac-mini", key: Data(count: 32).base64URL,
        offer: Data(count: 16).base64URL, secret: Data(count: 32).base64URL, exp: 4_000_000_000,
        direct: [Endpoint(kind: .lan, addr: "192.168.1.2", port: 3775)]),
      linkBase: "monocode-dev://pair")
    #expect(flow.read(link))
    #expect(flow.stage.title == "Connect to mac-mini?")
  }
}

private struct NeverTransport: Transport {
  var kind: TransportKind { .demo }
  var key: String { "never" }
  func open() async throws -> any FrameSocket { throw URLError(.cannotConnectToHost) }
}
