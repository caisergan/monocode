import Foundation
import MonoWire

/// What a runtime reports, in order (12 §12.4).
public enum RuntimeEvent: Sendable {
  case state(HostConnState)
  case welcome(Welcome)
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

private struct ErrorEnvelope: Decodable {
  let e: ChannelError
}

/// The fields every host message has: `t`, and `id`/`ok` on responses.
private struct Header: Decodable {
  let t: String
  let id: Int?
  let ok: Bool?
}

private struct EventName: Decodable {
  let e: String
}

private struct Request<P: Encodable>: Encodable {
  let t = "req"
  let id: Int
  let m: String
  let p: P
}

/// One connection to one paired host (12 §12.4). It owns the transport, the
/// request matching, the watch set and the reconnect timers; it knows
/// nothing about SwiftUI or storage. Stores read it through `events`.
public actor HostRuntime {
  public nonisolated let env: String
  public nonisolated let label: String
  public nonisolated let events: AsyncStream<RuntimeEvent>
  public private(set) var state: HostConnState = .idle
  public private(set) var welcome: Welcome?
  /// hostNow − localNow, from the welcome's clock.
  public private(set) var clockOffset: Duration = .zero

  private let transport: any Transport
  private let hello: Hello
  private let continuation: AsyncStream<RuntimeEvent>.Continuation
  private var socket: (any FrameSocket)?
  private var reader: Task<Void, Never>?
  private var nextId = 1
  private var pending: [Int: CheckedContinuation<Data, any Error>] = [:]
  private var waiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
  private var watch = WatchSet()
  private var watchTask: Task<Void, Never>?
  private var retryTask: Task<Void, Never>?
  private var attempt = 0
  private var connecting = false
  private var lastOnlineAt: Date?

  static let backoff: [Double] = [1, 2, 4, 8, 16, 30]
  static let requestWait: Duration = .seconds(15)

  public init(env: String, label: String, transport: any Transport, hello: Hello) {
    self.env = env
    self.label = label
    self.transport = transport
    self.hello = hello
    (events, continuation) = AsyncStream.makeStream(of: RuntimeEvent.self, bufferingPolicy: .unbounded)
  }

  public func has(_ capability: String) -> Bool {
    welcome?.capabilities.contains(capability) ?? false
  }

  private func setState(_ next: HostConnState) {
    state = next
    continuation.yield(.state(next))
    if next.isOnline {
      for waiter in waiters.values { waiter.resume() }
      waiters.removeAll()
    }
  }

  /// No-op when online or already connecting; skips any backoff wait.
  public func connect() {
    if connecting || state.isOnline { return }
    if case .blocked = state { return }
    retryTask?.cancel()
    connecting = true
    switch state {
    case .idle, .offline: setState(.connecting)
    default: break
    }
    Task { await self.open() }
  }

  private func open() async {
    let started = ContinuousClock.now
    let socket: any FrameSocket
    do {
      socket = try await transport.open()
      try await socket.send(JSONEncoder().encode(hello))
    } catch {
      failConnect()
      return
    }
    reader?.cancel()
    reader = Task { await self.read(socket, started: started) }
    // The welcome has 5 s to arrive (05 §5.5).
    Task {
      try? await Task.sleep(for: .seconds(5))
      if self.connecting, self.socket == nil { await socket.close(code: 4000, reason: "handshake timeout") }
    }
  }

  /// The socket's frames, in order: the welcome, then envelopes.
  private func read(_ socket: any FrameSocket, started: ContinuousClock.Instant) async {
    var welcomed = false
    do {
      for try await frame in socket.frames {
        if welcomed {
          receive(frame)
          continue
        }
        guard let welcome = try? JSONDecoder().decode(Welcome.self, from: frame), welcome.ok else { break }
        welcomed = true
        attach(socket, welcome: welcome, rtt: started.duration(to: .now))
      }
    } catch {}
    if welcomed {
      closed(socket)
    } else {
      await socket.close(code: 4000, reason: "handshake failed")
      failConnect()
    }
  }

  private func failConnect() {
    connecting = false
    let delay = Self.backoff[min(attempt, Self.backoff.count - 1)] * Double.random(in: 0.8...1.2)
    attempt += 1
    setState(.offline(reason: .hostUnreachable, retryAt: Date().addingTimeInterval(delay), lastOnlineAt: lastOnlineAt))
    retryTask = Task {
      try? await Task.sleep(for: .seconds(delay))
      if !Task.isCancelled { self.connect() }
    }
  }

  private func attach(_ socket: any FrameSocket, welcome: Welcome, rtt: Duration) {
    connecting = false
    attempt = 0
    self.socket = socket
    self.welcome = welcome
    let now = Date()
    lastOnlineAt = now
    clockOffset = .milliseconds(welcome.time - Int(now.timeIntervalSince1970 * 1000))
    continuation.yield(.welcome(welcome))
    let ms = Int(rtt.components.seconds * 1000) + Int(rtt.components.attoseconds / 1_000_000_000_000_000)
    // The owner re-sends the watch with the revisions it holds now (06 §6.6).
    setState(.online(transport: transport.kind, endpoint: transport.key, rttMs: ms, since: now))
  }

  private func closed(_ closing: any FrameSocket) {
    guard let socket, socket === closing else { return }
    self.socket = nil
    for request in pending.values { request.resume(throwing: RuntimeError.closed) }
    pending.removeAll()
    setState(.reconnecting(since: Date()))
    connect()
  }

  private func receive(_ frame: Data) {
    guard let header = try? JSONDecoder().decode(Header.self, from: frame) else { return }
    switch header.t {
    case "res":
      guard let id = header.id, let request = pending.removeValue(forKey: id) else { return }
      if header.ok == true {
        request.resume(returning: frame)
      } else {
        let error = (try? JSONDecoder().decode(ErrorEnvelope.self, from: frame).e)
          ?? ChannelError(code: "internal", message: "The host sent an unreadable error")
        request.resume(throwing: error)
      }
    case "evt":
      guard let name = try? JSONDecoder().decode(EventName.self, from: frame).e else { return }
      continuation.yield(.event(name: name, frame: frame))
    default:
      // pong, bye: the keepalive and close codes arrive with MonoChannel.
      break
    }
  }

  /// Waits up to 15 s for a channel, then throws `offline` (12 §12.4).
  private func waitOnline() async throws {
    if state.isOnline, socket != nil { return }
    connect()
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
  public func request<R: Decodable & Sendable>(
    _ method: String, _ params: some Encodable & Sendable, timeout: Duration = .seconds(30)
  ) async throws -> R {
    try await waitOnline()
    guard let socket else { throw RuntimeError.offline(label) }
    let id = nextId
    nextId += 1
    let frame = try JSONEncoder().encode(Request(id: id, m: method, p: params))
    let expiry = Task {
      try? await Task.sleep(for: timeout)
      self.expire(id, method)
    }
    defer { expiry.cancel() }
    let response: Data = try await withCheckedThrowingContinuation { request in
      pending[id] = request
      Task {
        do {
          try await socket.send(frame)
        } catch {
          self.fail(id, error)
        }
      }
    }
    return try JSONDecoder().decode(ResultEnvelope<R>.self, from: response).r
  }

  private func expire(_ id: Int, _ method: String) {
    pending.removeValue(forKey: id)?.resume(throwing: RuntimeError.timeout(method))
  }

  private func fail(_ id: Int, _ error: any Error) {
    pending.removeValue(forKey: id)?.resume(throwing: error)
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
    guard socket != nil else { return }
    let watch = watch
    Task { _ = try? await self.request("watch.set", watch) as Ignored }
  }

  /// Closes the connection for good.
  public func shutdown() async {
    retryTask?.cancel()
    reader?.cancel()
    await socket?.close(code: 1000, reason: "bye")
    socket = nil
    for request in pending.values { request.resume(throwing: RuntimeError.closed) }
    pending.removeAll()
    setState(.idle)
    continuation.finish()
  }
}
