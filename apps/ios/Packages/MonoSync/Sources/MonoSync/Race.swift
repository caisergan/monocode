import Foundation
import MonoChannel
import MonoStore

// Transport racing (05 §5.5): the eligible direct candidates in order, one
// started every 200 ms in a task group, each opening its socket (2.5 s) and
// running the handshake (5 s). The first valid answer wins and the rest are
// cancelled; one that finishes its handshake after the winner gets
// `bye{replaced}`. 20 s overall. An authenticated handshake error stops the
// race at once. The relay joins at t = 1,200 ms with R5.

/// Who the phone says it is in the hello (06 §6.2).
public struct ClientInfo: Hashable, Sendable {
  public var name: String
  public var version: String
  public var build: String
  public var os: String
  public var model: String?

  public init(name: String = "MonoCode", version: String, build: String, os: String, model: String?) {
    self.name = name
    self.version = version
    self.build = build
    self.os = os
    self.model = model
  }

  /// From the main bundle and the system.
  public static var current: ClientInfo {
    let info = Bundle.main.infoDictionary
    let os = ProcessInfo.processInfo.operatingSystemVersion
    var system = utsname()
    uname(&system)
    let machine = withUnsafeBytes(of: system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    return ClientInfo(
      version: info?["CFBundleShortVersionString"] as? String ?? "0.1.0",
      build: info?["CFBundleVersion"] as? String ?? "1",
      os: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
      model: ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? (machine.isEmpty ? nil : machine))
  }

  var app: Hello.App {
    Hello.App(name: name, version: version, build: build, platform: "ios", os: os, model: model)
  }
}

/// Every provider this app can show (`REMOTE_PROVIDERS`).
let remoteProviders = ["claude", "codex", "cursor", "grok", "opencode", "pi", "omp", "fx", "hermes", "antigravity"]

func hello(env: String, n: Int, info: ClientInfo, pairOffer: String? = nil, visible: Bool = true) -> Hello {
  Hello(
    env: env, n: n, app: info.app, caps: [.deflate, .windowedSync, .truncatedBlocks], providers: remoteProviders,
    presence: Presence(visible: visible), pair: pairOffer.map(Hello.Pair.init(offer:)))
}

/// Why a connect failed, as the runtime acts on it.
enum ConnectFailure: Error, Equatable {
  case blocked(HostConnState.BlockReason)
  /// `device_pending`: the pairing is still waiting on the computer.
  case pending
  /// The socket opened but the host could not verify this phone (an
  /// unauthenticated `handshake_failed`): its identity may have changed.
  case rejected
  case unreachable
  case noNetwork
}

enum Candidates {
  /// The eligible candidates in race order (05 §5.5): the one that succeeded
  /// most recently within 24 h, then LAN (IPv4 first), Tailscale by IP, then
  /// by MagicDNS name (iOS may not resolve it without the VPN), then manual.
  /// Within a kind: fewest consecutive failures, then lowest RTT.
  static func order(_ endpoints: [Endpoint], path: NetworkPath, stats: [String: CandidateStats] = [:], now: Date = Date())
    -> [Candidate]
  {
    guard path.satisfied else { return [] }
    var out: [Candidate] = []
    for endpoint in endpoints {
      let kind: Candidate.Kind
      switch endpoint.kind {
      case .lan: kind = .lan
      case .tailscale: kind = .tailscale
      case .manual: kind = .manual
      default: continue  // a kind this build doesn't know
      }
      // A cellular-only phone skips LAN unless a VPN carries it.
      if kind == .lan && path.onCellularOnly && !path.vpn { continue }
      let candidate = Candidate(kind: kind, host: endpoint.addr, port: endpoint.port)
      if !out.contains(candidate) { out.append(candidate) }
      if kind == .tailscale, let dns = endpoint.dns {
        let named = Candidate(kind: .tailscale, host: dns, port: endpoint.port)
        if !out.contains(named) { out.append(named) }
      }
    }
    let recent = out.filter { stats[$0.key]?.lastSuccessAt.map { now.timeIntervalSince($0) < 86_400 } ?? false }
      .max { (stats[$0.key]?.lastSuccessAt ?? .distantPast) < (stats[$1.key]?.lastSuccessAt ?? .distantPast) }
    func rank(_ candidate: Candidate) -> Int {
      if candidate == recent { return -1 }
      switch candidate.kind {
      case .lan: return candidate.host.contains(":") ? 1 : 0
      case .tailscale: return candidate.isName ? 3 : 2
      case .manual: return 4
      }
    }
    return out.enumerated().sorted { a, b in
      let (ra, rb) = (rank(a.element), rank(b.element))
      if ra != rb { return ra < rb }
      let (sa, sb) = (stats[a.element.key], stats[b.element.key])
      let (fa, fb) = (sa?.consecutiveFailures ?? 0, sb?.consecutiveFailures ?? 0)
      if fa != fb { return fa < fb }
      let (ta, tb) = (sa?.rttMs ?? .infinity, sb?.rttMs ?? .infinity)
      if ta != tb { return ta < tb }
      return a.offset < b.offset
    }.map(\.element)
  }
}

struct RaceTimings: Sendable {
  var stagger: Duration = .milliseconds(200)
  var open: Duration = .milliseconds(2500)
  var handshake: Duration = .seconds(5)
  var overall: Duration = .seconds(20)
}

/// One finished handshake.
struct RaceWinner: Sendable {
  let channel: Channel
  let welcome: ChannelWelcome
  let candidate: Candidate
  /// Socket open to welcome.
  let rtt: Duration
}

/// What one attempt came to, for the candidates table and diagnostics.
enum AttemptResult: Sendable {
  case won(Duration)
  case failed
}

enum Race {
  private struct Deadline: Error {}

  /// Runs the race. `hello` is called once per attempt, after its socket
  /// opens, so each attempt gets its own handshake counter (03 §3.4).
  static func run(
    _ candidates: [Candidate], env: String, hostKey: Data, deviceKey: KeyPair, timings: RaceTimings = RaceTimings(),
    compress: Bool = true, hello: @escaping @Sendable () throws -> Hello,
    report: @escaping @Sendable (Candidate, AttemptResult) async -> Void = { _, _ in }
  ) async throws -> RaceWinner {
    guard !candidates.isEmpty else { throw ConnectFailure.unreachable }
    return try await withThrowingTaskGroup(of: RaceWinner.self) { group in
      group.addTask {
        try await Task.sleep(for: timings.overall)
        throw Deadline()
      }
      for (index, candidate) in candidates.enumerated() {
        group.addTask {
          try await Task.sleep(for: timings.stagger * index)
          do {
            let winner = try await attempt(
              candidate, env: env, hostKey: hostKey, deviceKey: deviceKey, timings: timings, compress: compress, hello: hello)
            await report(candidate, .won(winner.rtt))
            return winner
          } catch {
            if !(error is CancellationError) { await report(candidate, .failed) }
            throw error
          }
        }
      }
      var remaining = candidates.count
      var best: any Error = ConnectFailure.unreachable
      var winner: RaceWinner?
      while let result = await group.nextResult() {
        switch result {
        case let .success(value):
          if winner == nil {
            winner = value
            group.cancelAll()
          } else {
            // Finished its handshake after the winner (05 §5.5 step 5).
            await value.channel.sayBye(.replaced)
          }
        case let .failure(error):
          if winner != nil || error is CancellationError { continue }
          if error is Deadline {
            group.cancelAll()
            throw best
          }
          remaining -= 1
          if let failure = error as? HandshakeFailure {
            if failure.authenticated {
              group.cancelAll()
              throw failure
            }
            best = failure
          }
          if remaining == 0 {
            group.cancelAll()
            throw best
          }
        }
      }
      guard let winner else { throw best }
      return winner
    }
  }

  private static func attempt(
    _ candidate: Candidate, env: String, hostKey: Data, deviceKey: KeyPair, timings: RaceTimings, compress: Bool,
    hello: @Sendable () throws -> Hello
  ) async throws -> RaceWinner {
    let started = ContinuousClock.now
    let socket = try await DirectTransport(candidate, openTimeout: timings.open).open()
    let options: ChannelOptions
    do {
      try Task.checkCancellation()
      options = ChannelOptions(
        env: env, hostKey: hostKey, deviceKey: deviceKey, hello: try hello(), timeout: timings.handshake, compress: compress)
    } catch {
      await socket.close(code: 1000, reason: "replaced")
      throw error
    }
    let (channel, welcome) = try await withTaskCancellationHandler {
      try await Channel.open(over: socket, options: options)
    } onCancel: {
      Task { await socket.close(code: 1000, reason: "replaced") }
    }
    if Task.isCancelled {
      await channel.sayBye(.replaced)
      throw CancellationError()
    }
    return RaceWinner(channel: channel, welcome: welcome, candidate: candidate, rtt: started.duration(to: .now))
  }
}

extension HandshakeFailure {
  /// What a failed handshake means for a paired host (04 §4.9, 05 §5.5).
  var connectFailure: ConnectFailure {
    guard authenticated else { return code == .handshakeFailed ? .rejected : .unreachable }
    switch code {
    case .deviceRevoked: return .blocked(.deviceRevoked)
    case .unknownDevice: return .blocked(.unknownDevice)
    case .protocolIncompatible: return .blocked(.protocolIncompatible)
    case .hostIdentityChanged: return .blocked(.hostIdentityChanged)
    case .devicePending: return .pending
    default: return .unreachable
    }
  }
}

/// A connected channel, as the runtime takes it over.
struct Connection: Sendable {
  let link: any HostLink
  let welcome: WireWelcome
  /// A real host's whole welcome: endpoints, relay, push.
  let full: Welcome?
  let kind: TransportKind
  let key: String
  let rtt: Duration
}

protocol HostConnector: Sendable {
  func connect(path: NetworkPath) async throws -> Connection
}

/// The demo: one transport, plain JSON, no Noise (16 §16.5).
struct PlainConnector: HostConnector {
  let transport: any Transport
  let hello: PlainHello

  func connect(path: NetworkPath) async throws -> Connection {
    let started = ContinuousClock.now
    let socket: any FrameSocket
    do {
      socket = try await transport.open()
    } catch {
      throw ConnectFailure.unreachable
    }
    let (link, frame) = try await PlainLink.open(over: socket, hello: hello, timeout: .seconds(5))
    guard let welcome = try? JSONDecoder().decode(WireWelcome.self, from: frame), welcome.ok else {
      await link.close()
      throw ConnectFailure.unreachable
    }
    return Connection(
      link: link, welcome: welcome, full: nil, kind: transport.kind, key: transport.key, rtt: started.duration(to: .now))
  }
}

/// A paired host's direct candidates, raced (05 §5.5) over the Noise channel.
struct DirectConnector: HostConnector {
  let env: String
  let hostKey: Data
  let deviceKey: KeyPair
  let info: ClientInfo
  /// The host's current endpoints (the registry's, refreshed by welcomes).
  let endpoints: @Sendable () async -> [Endpoint]
  let stats: @Sendable () async -> [String: CandidateStats]
  let report: @Sendable (Candidate, AttemptResult) async -> Void
  /// The next handshake counter, stored before it is used.
  let counter: @Sendable () throws -> Int
  var timings = RaceTimings()

  func connect(path: NetworkPath) async throws -> Connection {
    guard path.satisfied else { throw ConnectFailure.noNetwork }
    let candidates = Candidates.order(await endpoints(), path: path, stats: await stats())
    let (env, info, counter) = (env, info, counter)
    let winner: RaceWinner
    do {
      winner = try await Race.run(
        candidates, env: env, hostKey: hostKey, deviceKey: deviceKey, timings: timings,
        hello: { MonoSync.hello(env: env, n: try counter(), info: info) }, report: report)
    } catch let failure as HandshakeFailure {
      throw failure.connectFailure
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw ConnectFailure.unreachable
    }
    guard case let .device(welcome) = winner.welcome else {
      await winner.channel.close()
      throw ConnectFailure.unreachable
    }
    return Connection(
      link: NoiseLink(winner.channel), welcome: welcome.wire, full: welcome, kind: .direct, key: winner.candidate.key,
      rtt: winner.rtt)
  }
}

extension Welcome {
  /// The part of the welcome the stores keep.
  var wire: WireWelcome {
    WireWelcome(
      env: env, boot: boot, time: Int(time), host: .init(name: host.name, platform: host.platform, version: host.version, fingerprint: host.fingerprint),
      device: .init(id: device.id, name: device.name, role: device.role.rawValue), capabilities: capabilities,
      providers: providers,
      limits: .init(maxMessage: limits.maxMessage, maxInFlight: limits.maxInFlight, maxWatchedSessions: limits.maxWatchedSessions))
  }
}
