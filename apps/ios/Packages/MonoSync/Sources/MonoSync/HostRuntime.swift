import Foundation
import MonoChannel
import MonoStore
import MonoWire

/// What a runtime reports, in order (12 §12.4).
public enum RuntimeEvent: Sendable {
  case state(HostConnState)
  case welcome(WireWelcome)
  /// A real host's endpoints from its welcome or `host.endpoints`, for the
  /// registry.
  case endpoints([HostEndpoint])
  /// A host event (06 §6.6). `frame` is the whole envelope; decode `d` with
  /// `RuntimeEvent.payload(_:from:)`.
  case event(name: String, frame: Data)

  /// Decodes an event's `d`.
  public static func payload<D: Decodable>(_ type: D.Type, from frame: Data) throws -> D {
    try JSONDecoder().decode(EventEnvelope<D>.self, from: frame).d
  }
}

public enum RuntimeError: Error, Equatable, Sendable, LocalizedError {
  case offline(String)
  case timeout(String)
  case closed
  case handshake(String)

  public var errorDescription: String? {
    switch self {
    case let .offline(label): "\(label) is offline"
    case let .timeout(method): "\(method) timed out"
    case .closed: "The connection closed"
    case let .handshake(message): message
    }
  }
}

/// Why the runtime is asked to connect: the user and the OS skip backoff.
public enum ConnectReason: Sendable {
  case launch, user, foreground, network, retry
}

/// The scene phases the runtime acts on (05 §5.10), without SwiftUI.
public enum AppPhase: Sendable {
  case active, inactive, background
}

/// Accepts any JSON, for results nobody reads (`watch.set` answers `{}`).
public struct Ignored: Decodable, Sendable {
  public init(from decoder: any Decoder) throws {}
}

struct EventEnvelope<D: Decodable>: Decodable {
  let d: D
}

private struct ResultEnvelope<R: Decodable>: Decodable {
  let r: R
}

/// One connection to one paired host (12 §12.4). It owns the connector (the
/// race over direct candidates, or the demo's transport), the link, the watch
/// set, the keepalive and the reconnect timers; it knows nothing about
/// SwiftUI or storage. Stores read it through `events`.
public actor HostRuntime {
  public nonisolated let env: String
  public nonisolated let label: String
  public nonisolated let events: AsyncStream<RuntimeEvent>
  public private(set) var state: HostConnState = .idle
  public private(set) var welcome: WireWelcome?
  /// hostNow − localNow, from the welcome's clock and each pong.
  public private(set) var clockOffset: Duration = .zero

  private let connector: any HostConnector
  private let continuation: AsyncStream<RuntimeEvent>.Continuation
  private var link: (any HostLink)?
  private var linkEvents: Task<Void, Never>?
  private var attemptTask: Task<Void, Never>?
  private var keepalive: Task<Void, Never>?
  private var waiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
  private var watch = WatchSet()
  private var watchTask: Task<Void, Never>?
  private var retryTask: Task<Void, Never>?
  private var attempt = 0
  private var rejections = 0
  private var connecting = false
  private var lastOnlineAt: Date?
  private var path = NetworkPath.unknown
  private var foreground = true
  private var current: (kind: TransportKind, key: String, since: Date)?

  static let backoff: [Double] = [1, 2, 4, 8, 16, 30]
  static let requestWait: Duration = .seconds(15)
  /// Ping cadence while online (12 §12.4).
  static let pingEvery: Duration = .seconds(15)
  static let pingTimeout: Duration = .seconds(5)
  /// The verify ping on foreground and on a network change (05 §5.10).
  public static let verifyTimeout: Duration = .seconds(2)
  /// Handshakes the host refused while its socket opened, before the host
  /// counts as changed (04 §4.9).
  static let rejectionsBeforeBlocked = 3

  init(env: String, label: String, connector: any HostConnector) {
    self.env = env
    self.label = label
    self.connector = connector
    (events, continuation) = AsyncStream.makeStream(of: RuntimeEvent.self, bufferingPolicy: .unbounded)
  }

  /// A runtime over one plain transport: the demo machine and tests.
  public init(env: String, label: String, transport: any Transport, hello: PlainHello) {
    self.init(env: env, label: label, connector: PlainConnector(transport: transport, hello: hello))
  }

  public func has(_ capability: String) -> Bool {
    welcome?.capabilities.contains(capability) ?? false
  }

  private func setState(_ next: HostConnState) {
    guard next != state else { return }
    state = next
    continuation.yield(.state(next))
    if next.isOnline {
      for waiter in waiters.values { waiter.resume() }
      waiters.removeAll()
    }
  }

  // MARK: Connecting

  /// No-op when online or already connecting. Every reason but `.retry`
  /// skips a pending backoff wait. A blocked host stays blocked.
  public func connect(_ reason: ConnectReason = .user) {
    if connecting || link != nil { return }
    if case .blocked = state { return }
    guard foreground else { return }
    retryTask?.cancel()
    retryTask = nil
    guard path.satisfied else {
      setState(.offline(reason: .noNetwork, retryAt: .distantFuture, lastOnlineAt: lastOnlineAt))
      return
    }
    connecting = true
    switch state {
    case .idle, .offline: setState(.connecting)
    default: break
    }
    let connector = connector
    let path = path
    attemptTask = Task {
      do {
        let connection = try await connector.connect(path: path)
        self.attach(connection)
      } catch {
        self.failConnect(error)
      }
    }
  }

  private func failConnect(_ error: any Error) {
    connecting = false
    attemptTask = nil
    if error is CancellationError {
      // Backgrounded or shut down mid-race.
      if case .connecting = state { setState(.idle) }
      return
    }
    let failure = error as? ConnectFailure ?? .unreachable
    switch failure {
    case let .blocked(reason):
      setState(.blocked(reason))
      return
    case .noNetwork:
      setState(.offline(reason: .noNetwork, retryAt: .distantFuture, lastOnlineAt: lastOnlineAt))
      return
    case .rejected:
      rejections += 1
      if rejections >= Self.rejectionsBeforeBlocked {
        setState(.blocked(.hostIdentityChanged))
        return
      }
    case .pending, .unreachable:
      break
    }
    let delay = Self.backoff[min(attempt, Self.backoff.count - 1)] * Double.random(in: 0.8...1.2)
    attempt += 1
    setState(.offline(reason: .hostUnreachable, retryAt: Date().addingTimeInterval(delay), lastOnlineAt: lastOnlineAt))
    retryTask = Task {
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      self.retryTask = nil
      self.connect(.retry)
    }
  }

  private func attach(_ connection: Connection) {
    connecting = false
    attemptTask = nil
    guard foreground else {
      // Backgrounded while connecting (05 §5.10): no socket stays open.
      Task { await connection.link.sayBye(.background) }
      return
    }
    attempt = 0
    rejections = 0
    link = connection.link
    welcome = connection.welcome
    let now = Date()
    lastOnlineAt = now
    clockOffset = .milliseconds(connection.welcome.time - Int(now.timeIntervalSince1970 * 1000))
    current = (connection.kind, connection.key, now)
    continuation.yield(.welcome(connection.welcome))
    if let full = connection.full { continuation.yield(.endpoints(full.endpoints.compactMap(HostEndpoint.init))) }
    let link = connection.link
    linkEvents?.cancel()
    linkEvents = Task {
      for await event in link.events { self.receive(event, from: link) }
    }
    // The owner re-sends the watch with the revisions it holds now (06 §6.6).
    setState(.online(transport: connection.kind, endpoint: connection.key, rttMs: Self.ms(connection.rtt), since: now))
    startKeepalive(link)
  }

  private func receive(_ event: LinkEvent, from source: any HostLink) {
    guard link === source else { return }
    switch event {
    case let .event(name, frame):
      if name == "host.endpoints", let update = try? RuntimeEvent.payload(EndpointsEvent.self, from: frame) {
        continuation.yield(.endpoints(update.endpoints.compactMap(HostEndpoint.init)))
      }
      continuation.yield(.event(name: name, frame: frame))
    case let .closed(_, bye):
      dropLink()
      switch bye {
      case .deviceRevoked?:
        setState(.blocked(.deviceRevoked))
      case .rekey?, .replaced?:
        setState(.reconnecting(since: Date()))
        connect(.network)
      default:
        // host_stopping, idle_timeout, a dropped socket: the host restarts
        // or the network moved. Reconnect at once, then back off.
        setState(.reconnecting(since: Date()))
        connect(.network)
      }
    }
  }

  private func dropLink() {
    link = nil
    current = nil
    keepalive?.cancel()
    keepalive = nil
    linkEvents?.cancel()
    linkEvents = nil
  }

  // MARK: Keepalive and verify

  private var presence: Presence { Presence(visible: foreground) }

  private func startKeepalive(_ link: any HostLink) {
    keepalive?.cancel()
    keepalive = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.pingEvery)
        guard !Task.isCancelled else { return }
        _ = await self.ping(link, timeout: Self.pingTimeout)
      }
    }
  }

  /// Pings `link`; a missing pong closes it and reconnects.
  private func ping(_ link: any HostLink, timeout: Duration) async -> Bool {
    do {
      let pong = try await link.ping(presence: presence, timeout: timeout)
      guard self.link === link else { return false }
      let now = Date()
      clockOffset = .milliseconds(Int(pong.hostNow - now.timeIntervalSince1970 * 1000))
      if case let .online(kind, endpoint, _, since) = state {
        setState(.online(transport: kind, endpoint: endpoint, rttMs: Self.ms(pong.rtt), since: since))
      }
      return true
    } catch {
      guard self.link === link else { return false }
      dropLink()
      await link.close()
      setState(.reconnecting(since: Date()))
      connect(.network)
      return false
    }
  }

  /// A ping within `timeout` (05 §5.10). False, and a reconnect started,
  /// when the channel is gone or silent.
  public func verify(timeout: Duration = HostRuntime.verifyTimeout) async -> Bool {
    guard let link else {
      connect(.network)
      return false
    }
    return await ping(link, timeout: timeout)
  }

  // MARK: App lifecycle and network (05 §5.10)

  public func scenePhaseChanged(_ phase: AppPhase) async {
    switch phase {
    case .background:
      guard foreground else { return }
      foreground = false
      retryTask?.cancel()
      retryTask = nil
      attemptTask?.cancel()
      guard let link else { return }
      // presence{visible:false}, then goodbye: the outbox flush joins in R3.
      _ = try? await link.ping(presence: Presence(visible: false), timeout: .seconds(2))
      guard self.link === link else { return }
      dropLink()
      await link.sayBye(.background)
      setState(.idle)
    case .active:
      guard !foreground else { return }
      foreground = true
      if link != nil {
        _ = await verify()
      } else {
        attempt = 0
        connect(.foreground)
      }
    case .inactive:
      break
    }
  }

  public func pathChanged(_ next: NetworkPath) async {
    let before = path
    path = next
    guard foreground else { return }
    if !next.satisfied {
      if link == nil && !connecting {
        retryTask?.cancel()
        retryTask = nil
        setState(.offline(reason: .noNetwork, retryAt: .distantFuture, lastOnlineAt: lastOnlineAt))
      } else if link != nil {
        _ = await verify()
      }
      return
    }
    if link != nil {
      if before != next { _ = await verify() }
    } else if !connecting {
      attempt = 0
      connect(.network)
    }
  }

  // MARK: Requests

  /// Waits up to 15 s for a channel, then throws `offline` (12 §12.4).
  private func waitOnline() async throws {
    if state.isOnline, link != nil { return }
    if case .blocked = state { throw RuntimeError.offline(label) }
    connect(.user)
    let id = UUID()
    let timeout = Task {
      try? await Task.sleep(for: Self.requestWait)
      self.expireWaiter(id)
    }
    defer { timeout.cancel() }
    try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, any Error>) in
      waiters[id] = waiter
    }
  }

  private func expireWaiter(_ id: UUID) {
    waiters.removeValue(forKey: id)?.resume(throwing: RuntimeError.offline(label))
  }

  /// A request and its typed result (06 §6.3). Reads time out after 30 s.
  /// Host errors throw MonoWire's `ChannelError`.
  public func request<R: Decodable & Sendable>(
    _ method: String, _ params: some Encodable & Sendable, key: String? = nil, timeout: Duration = .seconds(30)
  ) async throws -> R {
    try await waitOnline()
    guard let link else { throw RuntimeError.offline(label) }
    let response = try await link.requestFrame(method, params, key: key, timeout: timeout)
    return try JSONDecoder().decode(ResultEnvelope<R>.self, from: response).r
  }

  /// Replaces the watch set (06 §6.6). Sent 50 ms later, coalescing bursts;
  /// `immediately` skips the wait. After a (re)connect the owner sends it
  /// again, with the revisions it holds then.
  public func setWatch(_ next: WatchSet, immediately: Bool = false) {
    guard next != watch || immediately else { return }
    watch = next
    watchTask?.cancel()
    watchTask = Task {
      if !immediately { try? await Task.sleep(for: .milliseconds(50)) }
      if !Task.isCancelled { self.sendWatch() }
    }
  }

  private func sendWatch() {
    guard link != nil else { return }
    let watch = watch
    Task { _ = try? await self.request("watch.set", watch) as Ignored }
  }

  /// Closes the connection for good. `bye` says goodbye first.
  public func shutdown(bye: ByeCode? = nil) async {
    retryTask?.cancel()
    attemptTask?.cancel()
    let link = link
    dropLink()
    if let link {
      if let bye { await link.sayBye(bye) } else { await link.close() }
    }
    for waiter in waiters.values { waiter.resume(throwing: RuntimeError.closed) }
    waiters.removeAll()
    setState(.idle)
    continuation.finish()
  }

  static func ms(_ duration: Duration) -> Int {
    Int(duration.components.seconds * 1000) + Int(duration.components.attoseconds / 1_000_000_000_000_000)
  }
}

private struct EndpointsEvent: Decodable {
  let endpoints: [Endpoint]
}

extension HostEndpoint {
  /// A wire endpoint of a kind this build knows.
  init?(_ endpoint: Endpoint) {
    guard let kind = Kind(rawValue: endpoint.kind.rawValue) else { return nil }
    self.init(kind: kind, addr: endpoint.addr, port: endpoint.port, dns: endpoint.dns)
  }

  var wire: Endpoint {
    Endpoint(kind: EndpointKind(rawValue: kind.rawValue), addr: addr, port: port, dns: dns)
  }
}
