import Foundation
import MonoChannel

// An open channel to a host, as the runtime uses it: requests matched to
// responses, an event stream, pings and goodbyes. A real host's link is
// MonoChannel's Noise `Channel`; the demo's is plain JSON envelopes, since
// the demo transport skips Noise (16 §16.5).

/// What a link reports besides responses, in order.
enum LinkEvent: Sendable {
  /// A host event (06 §6.6); `frame` is the whole envelope.
  case event(name: String, frame: Data)
  /// The last element. `bye` is the host's goodbye, when it sent one.
  case closed(code: Int, bye: ByeCode?)
}

/// A ping's answer: the round trip and the host clock (Unix ms).
struct Pong: Sendable {
  var rtt: Duration
  var hostNow: Double
}

protocol HostLink: AnyObject, Sendable {
  var events: AsyncStream<LinkEvent> { get }
  /// The whole `res` envelope's JSON. Throws the host's error as MonoWire's
  /// `ChannelError`, or `RuntimeError` for timeouts and a lost connection.
  func requestFrame<P: Encodable & Sendable>(_ method: String, _ params: P, key: String?, timeout: Duration) async throws -> Data
  func ping(presence: Presence?, timeout: Duration) async throws -> Pong
  /// Says goodbye, then closes; no `closed` reconnect follows on our side.
  func sayBye(_ code: ByeCode) async
  func close() async
}

/// MonoChannel's channel as a link.
final class NoiseLink: HostLink {
  let channel: Channel
  let events: AsyncStream<LinkEvent>
  private let forward: Task<Void, Never>

  init(_ channel: Channel) {
    self.channel = channel
    let (events, sink) = AsyncStream.makeStream(of: LinkEvent.self, bufferingPolicy: .unbounded)
    self.events = events
    forward = Task {
      for await event in channel.events {
        switch event {
        case let .event(name, frame): sink.yield(.event(name: name, frame: frame))
        case let .closed(info): sink.yield(.closed(code: info.code, bye: info.bye))
        }
      }
      sink.finish()
    }
  }

  deinit { forward.cancel() }

  func requestFrame<P: Encodable & Sendable>(_ method: String, _ params: P, key: String?, timeout: Duration) async throws -> Data {
    do {
      return try await channel.requestFrame(method, params, key: key, timeout: timeout)
    } catch let error as MonoChannel.ChannelError {
      throw error.runtime(method)
    }
  }

  func ping(presence: Presence?, timeout: Duration) async throws -> Pong {
    do {
      let result = try await channel.ping(presence: presence, timeout: timeout)
      return Pong(rtt: result.rtt, hostNow: result.hostNow)
    } catch let error as MonoChannel.ChannelError {
      throw error.runtime("ping")
    }
  }

  func sayBye(_ code: ByeCode) async {
    await channel.sayBye(code)
    await channel.close(code: 1000, reason: code.rawValue)
  }

  func close() async {
    await channel.close()
  }
}

extension MonoChannel.ChannelError {
  /// The phone's own codes become runtime errors; the host's stay errors the
  /// screens read (MonoWire's `ChannelError`).
  func runtime(_ method: String) -> any Error {
    switch code {
    case .timeout where message == "The host did not answer": RuntimeError.timeout(method)
    case .offline: RuntimeError.closed
    default: WireError(code: code.rawValue, message: message, retryable: retryable)
    }
  }
}

/// The demo's link: plain JSON envelopes, the R1 protocol. The phone sends a
/// `PlainHello` and the host answers with its welcome; pings are answered
/// here, since the demo has no clock of its own to report.
final actor PlainLink: HostLink {
  nonisolated let events: AsyncStream<LinkEvent>
  private let sink: AsyncStream<LinkEvent>.Continuation
  private let socket: any FrameSocket
  private var reader: Task<Void, Never>?
  private var nextId = 1
  private var pending: [Int: CheckedContinuation<Data, any Error>] = [:]
  private var finished = false

  private struct Header: Decodable {
    let t: String
    let id: Int?
    let ok: Bool?
  }

  private struct EventName: Decodable {
    let e: String
  }

  private struct ErrorEnvelope: Decodable {
    let e: WireError
  }

  private struct Request<P: Encodable>: Encodable {
    let t = "req"
    let id: Int
    let m: String
    let p: P
    let key: String?
  }

  /// Sends the hello and waits up to `timeout` for the welcome's frame.
  static func open(over socket: any FrameSocket, hello: PlainHello, timeout: Duration) async throws -> (PlainLink, Data) {
    try await socket.send(JSONEncoder().encode(hello))
    let link = PlainLink(socket: socket)
    let deadline = Task {
      try? await Task.sleep(for: timeout)
      if !Task.isCancelled { await socket.close(code: 4000, reason: "handshake timeout") }
    }
    defer { deadline.cancel() }
    let welcome = try await link.start()
    return (link, welcome)
  }

  private init(socket: any FrameSocket) {
    self.socket = socket
    (events, sink) = AsyncStream.makeStream(of: LinkEvent.self, bufferingPolicy: .unbounded)
  }

  /// Reads frames: the first is the welcome, returned; the rest are envelopes.
  private func start() async throws -> Data {
    try await withCheckedThrowingContinuation { (first: CheckedContinuation<Data, any Error>) in
      let socket = socket
      reader = Task {
        var welcome: CheckedContinuation<Data, any Error>? = first
        do {
          for try await frame in socket.frames {
            if let waiter = welcome {
              welcome = nil
              waiter.resume(returning: frame)
            } else {
              self.receive(frame)
            }
          }
        } catch {}
        welcome?.resume(throwing: RuntimeError.handshake("The connection closed during the handshake"))
        self.ended(code: 1006)
      }
    }
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
          ?? WireError(code: "internal", message: "The host sent an unreadable error")
        request.resume(throwing: error)
      }
    case "evt":
      guard let name = try? JSONDecoder().decode(EventName.self, from: frame).e else { return }
      sink.yield(.event(name: name, frame: frame))
    default:
      break
    }
  }

  private func ended(code: Int) {
    guard !finished else { return }
    finished = true
    for request in pending.values { request.resume(throwing: RuntimeError.closed) }
    pending.removeAll()
    sink.yield(.closed(code: code, bye: nil))
    sink.finish()
  }

  func requestFrame<P: Encodable & Sendable>(_ method: String, _ params: P, key: String?, timeout: Duration) async throws -> Data {
    guard !finished else { throw RuntimeError.closed }
    let id = nextId
    nextId += 1
    let frame = try JSONEncoder().encode(Request(id: id, m: method, p: params, key: key))
    let expiry = Task {
      try? await Task.sleep(for: timeout)
      if !Task.isCancelled { self.fail(id, RuntimeError.timeout(method)) }
    }
    defer { expiry.cancel() }
    let socket = socket
    return try await withCheckedThrowingContinuation { request in
      pending[id] = request
      Task {
        do {
          try await socket.send(frame)
        } catch {
          self.fail(id, error)
        }
      }
    }
  }

  private func fail(_ id: Int, _ error: any Error) {
    pending.removeValue(forKey: id)?.resume(throwing: error)
  }

  func ping(presence: Presence?, timeout: Duration) async throws -> Pong {
    guard !finished else { throw RuntimeError.closed }
    return Pong(rtt: .zero, hostNow: Date().timeIntervalSince1970 * 1000)
  }

  func sayBye(_ code: ByeCode) async {
    await close()
  }

  func close() async {
    reader?.cancel()
    await socket.close(code: 1000, reason: "bye")
    ended(code: 1000)
  }
}
