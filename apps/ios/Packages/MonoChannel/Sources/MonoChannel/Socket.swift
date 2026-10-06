import Foundation
import Synchronization

/// One binary WebSocket message is one frame (03 §3.4). The direct, relay
/// and demo transports implement this. Its requirements are those of
/// MonoSync's `FrameSocket`, so one type can serve both.
public protocol ChannelSocket: AnyObject, Sendable {
  func send(_ frame: Data) async throws
  /// Ends when the socket closes. Cancelling a reader doesn't close it; `close` does.
  var frames: AsyncThrowingStream<Data, any Error> { get }
  func close(code: Int, reason: String) async
}

/// Two connected sockets in one process, for the demo host and tests.
public final class MemoryChannelSocket: ChannelSocket {
  public let frames: AsyncThrowingStream<Data, any Error>
  private let continuation: AsyncThrowingStream<Data, any Error>.Continuation
  private let peer = Mutex<MemoryChannelSocket?>(nil)
  private let closed = Mutex(false)

  private init() {
    (frames, continuation) = AsyncThrowingStream.makeStream()
  }

  public static func pair() -> (MemoryChannelSocket, MemoryChannelSocket) {
    let a = MemoryChannelSocket()
    let b = MemoryChannelSocket()
    a.peer.withLock { $0 = b }
    b.peer.withLock { $0 = a }
    return (a, b)
  }

  public func send(_ frame: Data) async throws {
    if closed.withLock({ $0 }) { return }
    peer.withLock { $0 }?.continuation.yield(frame)
  }

  /// Closes both ends; the other end sees its frames finish.
  public func close(code: Int, reason: String) async {
    if closed.withLock({ was in defer { was = true }; return was }) { return }
    continuation.finish()
    let other = peer.withLock { peer in defer { peer = nil }; return peer }
    await other?.close(code: code, reason: reason)
  }
}
