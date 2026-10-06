import Foundation
import MonoChannel

public enum TransportKind: String, Sendable {
  case direct, relay, demo
}

/// One way to reach a host (12 §12.4): `DirectTransport` here, the demo
/// transport in MonoDemo, the relay with R5.
public protocol Transport: Sendable {
  var kind: TransportKind { get }
  /// The candidate key, e.g. "lan|192.168.1.20|3775".
  var key: String { get }
  func open() async throws -> any FrameSocket
}

/// A message-framed socket. Cancelling the task that reads `frames` does not
/// close it; `close` does. MonoChannel's `ChannelSocket` has the same
/// requirements, so one type serves both.
public typealias FrameSocket = ChannelSocket

/// The demo's half of the handshake: frames are plain JSON envelopes
/// (06 §6.3), the phone sends this hello and the host answers with its
/// welcome. A real host gets MonoChannel's `Hello` inside the Noise IK
/// handshake (06 §6.2) instead, and every later frame in a record.
public struct PlainHello: Codable, Hashable, Sendable {
  public var t = "hello"
  public var channel = 1
  public var env: String
  public var app: String
  public var providers: [String]

  public init(env: String, app: String, providers: [String]) {
    self.env = env
    self.app = app
    self.providers = providers
  }
}
