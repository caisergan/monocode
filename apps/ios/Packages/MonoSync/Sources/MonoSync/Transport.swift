import Foundation
import MonoWire

public enum TransportKind: String, Sendable {
  case direct, relay, demo
}

/// One way to reach a host (12 §12.4). Direct and relay transports arrive
/// with MonoChannel in R2; the demo transport is MonoDemo's.
public protocol Transport: Sendable {
  var kind: TransportKind { get }
  /// The candidate key, e.g. "lan|192.168.1.20|3775".
  var key: String { get }
  func open() async throws -> any FrameSocket
}

/// A message-framed socket. Cancelling the task that reads `frames` does not
/// close it; `close` does.
public protocol FrameSocket: AnyObject, Sendable {
  func send(_ frame: Data) async throws
  var frames: AsyncThrowingStream<Data, any Error> { get }
  func close(code: Int, reason: String) async
}

/// The phone's half of the handshake. In R1 frames are plain JSON envelopes
/// (06 §6.3): the phone sends a hello and the host answers with its welcome.
/// R2 wraps both in the Noise IK handshake (06 §6.2), and every later frame
/// in a record.
public struct Hello: Codable, Hashable, Sendable {
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
