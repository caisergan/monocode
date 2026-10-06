import Foundation

// The phone's side of a channel (12 §12.4): run the IK handshake over any
// ChannelSocket, then match requests to responses, stream events and send
// through the priority queues. Knows nothing about SwiftUI, storage or which
// transport carries the frames.

/// A failed handshake. `authenticated` is true when the host proved its
/// identity (the error came inside message 2), so it can be trusted.
public struct HandshakeFailure: Error, Hashable, Sendable, LocalizedError {
  public let code: ChannelErrorCode
  public let message: String
  public let authenticated: Bool

  public init(code: ChannelErrorCode, message: String, authenticated: Bool) {
    self.code = code
    self.message = message
    self.authenticated = authenticated
  }

  public var errorDescription: String? { message }
}

public struct ChannelCloseInfo: Hashable, Sendable {
  public let code: Int
  public let reason: String
  /// The host's goodbye, when it sent one.
  public let bye: ByeCode?

  public init(code: Int, reason: String, bye: ByeCode? = nil) {
    self.code = code
    self.reason = reason
    self.bye = bye
  }
}

public enum ChannelEvent: Sendable {
  /// A host event (06 §6.6). `frame` is the whole envelope; decode `d` with
  /// `ChannelEvent.payload(_:from:)`.
  case event(name: String, frame: Data)
  /// The last element: the stream finishes after it.
  case closed(ChannelCloseInfo)

  /// Decodes an event's `d`.
  public static func payload<D: Decodable>(_ type: D.Type, from frame: Data) throws -> D {
    try JSONDecoder().decode(EventEnvelope<D>.self, from: frame).d
  }
}

/// What the host answered the handshake with.
public enum ChannelWelcome: Hashable, Sendable {
  case device(Welcome)
  case pairing(PairingWelcome)
}

public struct ChannelOptions: Sendable {
  public var env: String
  /// The host's static X25519 key (from the offer or the saved host).
  public var hostKey: Data
  public var deviceKey: KeyPair
  public var hello: Hello
  public var timeout: Duration
  /// Settings → Privacy → "Compress traffic" (03 §3.5).
  public var compress: Bool

  public init(
    env: String, hostKey: Data, deviceKey: KeyPair, hello: Hello, timeout: Duration = .seconds(5),
    compress: Bool = true
  ) {
    self.env = env
    self.hostKey = hostKey
    self.deviceKey = deviceKey
    self.hello = hello
    self.timeout = timeout
    self.compress = compress
  }
}

public struct PingResult: Hashable, Sendable {
  public let rtt: Duration
  /// The host clock, Unix ms.
  public let hostNow: Double
}

struct EventEnvelope<D: Decodable>: Decodable {
  let d: D
}

private struct ResultEnvelope<R: Decodable>: Decodable {
  let r: R
}

/// The fields the reader looks at before handing the frame on.
private struct Header: Decodable {
  let t: String
  let id: Int?
  let ok: Bool?
  let e: JSONValue?
  let ts: Double?
  let now: Double?
  let code: ByeCode?
}

private struct RequestFrame<P: Encodable & Sendable>: Encodable, Sendable {
  let t = "req"
  let id: Int
  let m: String
  let p: P?
  let key: String?
}

private struct NoParams: Encodable, Sendable {}

/// Default request timeouts (06 §6.3).
public enum RequestTimeout {
  public static let read: Duration = .seconds(30)
  public static let mutation: Duration = .seconds(60)
  public static let push: Duration = .seconds(120)
}

public actor Channel {
  private enum Phase {
    case handshaking(IKInitiator, CheckedContinuation<ChannelWelcome, any Error>)
    case open
    case closed
  }

  private struct Pending {
    let continuation: CheckedContinuation<Data, any Error>
    let timer: Task<Void, Never>
  }

  public nonisolated let events: AsyncStream<ChannelEvent>
  private let eventSink: AsyncStream<ChannelEvent>.Continuation
  private let socket: any ChannelSocket
  private let compress: Bool
  private var phase: Phase = .closed
  /// Kept apart from `phase` so it mutates in place: a copy would make every
  /// appended fragment copy the whole partial message.
  private var session: SecureSession?
  private var hash = Data()
  private var nextId = 1
  private var pending: [Int: Pending] = [:]
  private var pongs: [Double: CheckedContinuation<Double, any Error>] = [:]
  private var reader: Task<Void, Never>?
  private var pump: Task<Void, Never>?
  private var closer: Task<Void, Never>?
  private var bye: ByeCode?

  private init(socket: any ChannelSocket, compress: Bool) {
    self.socket = socket
    self.compress = compress
    (events, eventSink) = AsyncStream.makeStream(of: ChannelEvent.self, bufferingPolicy: .unbounded)
  }

  /// Runs the handshake on an open socket. Returns a usable channel and the
  /// host's welcome; throws `HandshakeFailure` (code `timeout` when the host
  /// doesn't answer in time). On failure the socket is closed.
  public static func open(
    over socket: any ChannelSocket, options: ChannelOptions
  ) async throws -> (channel: Channel, welcome: ChannelWelcome) {
    let channel = Channel(socket: socket, compress: options.compress)
    let welcome = try await channel.handshake(options)
    return (channel, welcome)
  }

  /// Names this channel: the pairing proof and confirmation code bind to it.
  public var handshakeHash: Data { hash }

  public var isClosed: Bool {
    if case .closed = phase { true } else { false }
  }

  // MARK: Handshake

  private func handshake(_ options: ChannelOptions) async throws -> ChannelWelcome {
    var initiator: IKInitiator
    let message1: Data
    do {
      initiator = try IKInitiator(
        staticKey: options.deviceKey, remoteStatic: options.hostKey, prologue: channelPrologue(options.env)
      )
      message1 = try initiator.writeMessage1(JSONEncoder().encode(options.hello))
    } catch {
      await socket.close(code: 1000, reason: "handshake")
      throw HandshakeFailure(code: .handshakeFailed, message: "The host key or hello is invalid", authenticated: false)
    }
    let timeout = options.timeout
    return try await withCheckedThrowingContinuation { continuation in
      phase = .handshaking(initiator, continuation)
      startReading()
      let socket = socket
      pump = Task {
        do {
          try await socket.send(Data([FrameKind.handshake1.rawValue]) + message1)
        } catch {
          self.failHandshake(.handshakeFailed, "The connection failed")
        }
        try? await Task.sleep(for: timeout)
        if !Task.isCancelled { self.failHandshake(.timeout, "The host did not answer the handshake") }
      }
    }
  }

  private func startReading() {
    let socket = socket
    reader = Task {
      do {
        for try await frame in socket.frames { self.receive(frame) }
        self.socketEnded("Connection closed")
      } catch {
        self.socketEnded("Socket error")
      }
    }
  }

  private func failHandshake(_ code: ChannelErrorCode, _ message: String, authenticated: Bool = false) {
    guard case let .handshaking(_, continuation) = phase else { return }
    phase = .closed
    pump?.cancel()
    pump = nil
    reader?.cancel()
    eventSink.finish()
    let socket = socket
    Task { await socket.close(code: 1000, reason: "handshake") }
    continuation.resume(throwing: HandshakeFailure(code: code, message: message, authenticated: authenticated))
  }

  private func readHandshake(_ frame: Data, _ initiator: IKInitiator, _ continuation: CheckedContinuation<ChannelWelcome, any Error>) {
    if frame.first == FrameKind.reject.rawValue {
      // Unauthenticated, so only a hint (03 §3.4).
      struct Reject: Decodable { let code: ChannelErrorCode? }
      let code = (try? JSONDecoder().decode(Reject.self, from: frame.dropFirst()))?.code ?? .handshakeFailed
      failHandshake(code, "The host rejected the handshake")
      return
    }
    guard frame.first == FrameKind.handshake2.rawValue else {
      failHandshake(.handshakeFailed, "Unexpected handshake frame")
      return
    }
    var initiator = initiator
    let payload: Data
    let transport: NoiseTransport
    do {
      (payload, transport) = try initiator.readMessage2(frame.dropFirst())
    } catch {
      failHandshake(.handshakeFailed, "The host's identity could not be verified")
      return
    }
    // Message 2 opened, so whatever it says comes from the host.
    let reply: HandshakeReply
    do {
      reply = try JSONDecoder().decode(HandshakeReply.self, from: payload)
    } catch {
      failHandshake(.handshakeFailed, "The host's welcome could not be read", authenticated: true)
      return
    }
    let welcome: ChannelWelcome
    var limit = maxMessage
    switch reply {
    case let .error(error):
      failHandshake(error.code, error.message, authenticated: true)
      return
    case let .welcome(value):
      welcome = .device(value)
      limit = value.limits.maxMessage
    case let .pairing(value):
      welcome = .pairing(value)
    }
    pump?.cancel()
    pump = nil
    hash = transport.handshakeHash
    session = SecureSession(transport: transport, compress: compress, maxMessage: limit)
    phase = .open
    continuation.resume(returning: welcome)
  }

  // MARK: Receiving

  private func receive(_ frame: Data) {
    switch phase {
    case let .handshaking(initiator, continuation):
      readHandshake(frame, initiator, continuation)
    case .open:
      let message: Data?
      do {
        message = try session?.receive(frame)
      } catch {
        finish(code: 1002, reason: ByeCode.protocolError.rawValue)
        return
      }
      if let message { handle(message) }
    case .closed:
      return
    }
  }

  private func handle(_ message: Data) {
    guard let header = try? JSONDecoder().decode(Header.self, from: message) else {
      finish(code: 1002, reason: ByeCode.protocolError.rawValue)
      return
    }
    switch header.t {
    case "res":
      guard let id = header.id, let waiter = pending.removeValue(forKey: id) else { return }
      waiter.timer.cancel()
      if header.ok == true {
        waiter.continuation.resume(returning: message)
      } else {
        let error =
          (try? header.e?.decode(ChannelError.self))
          ?? ChannelError(code: .internal, message: "The host sent an unreadable error", retryable: false)
        waiter.continuation.resume(throwing: error)
      }
    case "evt":
      guard let name = header.e?.stringValue else { return }
      eventSink.yield(.event(name: name, frame: message))
    case "pong":
      guard let ts = header.ts, let now = header.now else { return }
      pongs.removeValue(forKey: ts)?.resume(returning: now)
    case "bye":
      bye = header.code
      finish(code: 1000, reason: header.code?.rawValue ?? "")
    default:
      // Unknown kinds come from a newer host (06 §6.12).
      return
    }
  }

  private func socketEnded(_ reason: String) {
    switch phase {
    case .handshaking:
      failHandshake(.handshakeFailed, reason)
    case .open:
      finish(code: 1006, reason: reason)
    case .closed:
      return
    }
  }

  // MARK: Sending

  /// Queues one message. Requests, pings and goodbyes go at `.urgent`.
  public func send(_ message: some Encodable & Sendable, priority: Priority = .normal) throws {
    guard case .open = phase, session != nil else { throw ChannelError.offline }
    try session!.enqueue(message, priority: priority)
    if pump == nil { pump = Task { await self.drain() } }
  }

  /// Seals and writes queued records one at a time, so a higher priority
  /// message queued meanwhile goes next.
  private func drain() async {
    while case .open = phase {
      let frame: Data?
      do {
        frame = try session?.nextFrame()
      } catch {
        finish(code: 1011, reason: "Nonce exhausted")
        break
      }
      guard let frame else { break }
      do {
        try await socket.send(frame)
      } catch {
        finish(code: 1006, reason: "Socket error")
        break
      }
    }
    pump = nil
  }

  /// Waits until everything queued has been handed to the socket.
  public func flush() async {
    while let pump { await pump.value }
  }

  // MARK: Requests

  /// Sends a request and returns the whole `res` envelope's JSON. Throws
  /// `ChannelError`: the host's, or `timeout` and `offline` from here.
  public func requestFrame(
    _ method: String, _ params: (some Encodable & Sendable)?, key: String? = nil,
    timeout: Duration = RequestTimeout.read
  ) async throws -> Data {
    guard case .open = phase else { throw ChannelError.offline }
    let id = nextId
    nextId += 1
    return try await withCheckedThrowingContinuation { continuation in
      let timer = Task {
        try? await Task.sleep(for: timeout)
        if !Task.isCancelled { self.expire(id) }
      }
      pending[id] = Pending(continuation: continuation, timer: timer)
      do {
        try send(RequestFrame(id: id, m: method, p: params, key: key), priority: .urgent)
      } catch {
        pending[id] = nil
        timer.cancel()
        continuation.resume(throwing: error)
      }
    }
  }

  /// A request and its typed result.
  public func request<R: Decodable & Sendable>(
    _ method: String, _ params: some Encodable & Sendable, as type: R.Type = R.self, key: String? = nil,
    timeout: Duration = RequestTimeout.read
  ) async throws -> R {
    let frame = try await requestFrame(method, params, key: key, timeout: timeout)
    return try JSONDecoder().decode(ResultEnvelope<R>.self, from: frame).r
  }

  /// A request without params.
  public func request<R: Decodable & Sendable>(
    _ method: String, as type: R.Type = R.self, key: String? = nil, timeout: Duration = RequestTimeout.read
  ) async throws -> R {
    let frame = try await requestFrame(method, NoParams?.none, key: key, timeout: timeout)
    return try JSONDecoder().decode(ResultEnvelope<R>.self, from: frame).r
  }

  /// Gives up on a request: tells the host (best effort) and throws `timeout`.
  private func expire(_ id: Int) {
    guard let waiter = pending.removeValue(forKey: id) else { return }
    try? send(ClientMessage.cancel(id: id), priority: .urgent)
    waiter.continuation.resume(throwing: ChannelError.timedOut)
  }

  // MARK: Ping

  /// The round trip and the host clock; throws `timeout` when no pong comes.
  public func ping(presence: Presence? = nil, timeout: Duration = .seconds(5)) async throws -> PingResult {
    guard case .open = phase else { throw ChannelError.offline }
    var ts = (Date().timeIntervalSince1970 * 1000).rounded() + Double.random(in: 0..<1)
    while pongs[ts] != nil { ts += 0.5 }
    let started = ContinuousClock.now
    let key = ts
    let timer = Task {
      try? await Task.sleep(for: timeout)
      if !Task.isCancelled { self.pongs.removeValue(forKey: key)?.resume(throwing: ChannelError.timedOut) }
    }
    defer { timer.cancel() }
    let hostNow = try await withCheckedThrowingContinuation { continuation in
      pongs[key] = continuation
      do {
        try send(ClientMessage.ping(ts: key, presence: presence), priority: .urgent)
      } catch {
        pongs[key] = nil
        continuation.resume(throwing: error)
      }
    }
    return PingResult(rtt: started.duration(to: .now), hostNow: hostNow)
  }

  // MARK: Closing

  /// Says goodbye, waits for it to reach the socket, then closes.
  public func sayBye(_ code: ByeCode) async {
    guard (try? send(ClientMessage.bye(code), priority: .urgent)) != nil else { return }
    await flush()
    await close(code: 1000, reason: code.rawValue)
  }

  public func close(code: Int = 1000, reason: String = "") async {
    finish(code: code, reason: reason)
    await closer?.value
  }

  /// Fails what's pending, reports the close and closes the socket.
  private func finish(code: Int, reason: String) {
    guard case .open = phase else { return }
    session = nil
    phase = .closed
    reader?.cancel()
    for waiter in pending.values {
      waiter.timer.cancel()
      waiter.continuation.resume(throwing: ChannelError.connectionLost)
    }
    pending.removeAll()
    for pong in pongs.values { pong.resume(throwing: ChannelError.connectionLost) }
    pongs.removeAll()
    eventSink.yield(.closed(ChannelCloseInfo(code: code, reason: reason, bye: bye)))
    eventSink.finish()
    let socket = socket
    closer = Task { await socket.close(code: code, reason: reason) }
  }
}
