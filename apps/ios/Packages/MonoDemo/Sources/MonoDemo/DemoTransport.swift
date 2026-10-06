import Foundation
import MonoSync
import MonoWire

/// The demo machine's transport (16 §16.5): the same `Transport` protocol as
/// a real host, in process and without Noise, as the Expo app's memory
/// transport was.
public struct DemoTransport: Transport {
  public let host: DemoHost
  /// Refuses to connect, to show the offline notices.
  public var unreachable: Bool

  public init(host: DemoHost, unreachable: Bool = false) {
    self.host = host
    self.unreachable = unreachable
  }

  public var kind: TransportKind { .demo }
  public var key: String { "demo" }

  public func open() async throws -> any FrameSocket {
    if unreachable { throw URLError(.cannotConnectToHost) }
    let socket = DemoSocket(host: host)
    await host.attach(socket)
    return socket
  }
}

/// The phone's end of an in-process connection to the demo host.
final class DemoSocket: FrameSocket, @unchecked Sendable {
  let frames: AsyncThrowingStream<Data, any Error>
  private let continuation: AsyncThrowingStream<Data, any Error>.Continuation
  private let host: DemoHost

  init(host: DemoHost) {
    self.host = host
    (frames, continuation) = AsyncThrowingStream.makeStream(bufferingPolicy: .unbounded)
  }

  func send(_ frame: Data) async throws {
    await host.receive(frame, from: self)
  }

  /// A frame from the host to the phone.
  func deliver(_ frame: Data?) {
    if let frame { continuation.yield(frame) }
  }

  func close(code: Int, reason: String) async {
    await host.detach(self)
    continuation.finish()
  }
}

extension HostRecord {
  /// The demo machine's record (11 §11.11: a `Demo` tag marks it).
  public static let demo = HostRecord.demo(env: DemoHost.env, label: "Demo", colorIndex: 1)
}
