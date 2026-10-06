import Foundation
import MonoChannel

/// A host's direct address over `URLSessionWebSocketTask` (12 §12.4):
/// `ws://<addr>:<port>/v1/channel`, binary messages, IPv6 literals bracketed.
/// It sends no `Origin` header: the host refuses any upgrade that carries one
/// (05 §5.3), and URLSession adds none of its own.
public struct DirectTransport: Transport {
  public let endpoint: Candidate
  /// WebSocket open deadline (05 §5.5).
  public var openTimeout: Duration

  public init(_ endpoint: Candidate, openTimeout: Duration = .milliseconds(2500)) {
    self.endpoint = endpoint
    self.openTimeout = openTimeout
  }

  public var kind: TransportKind { .direct }
  public var key: String { endpoint.key }

  public func open() async throws -> any FrameSocket {
    let socket = WebSocket(url: endpoint.url)
    try await socket.connect(timeout: openTimeout)
    return socket
  }
}

/// One direct candidate (05 §5.2): an endpoint, or a Tailscale endpoint's
/// MagicDNS name.
public struct Candidate: Hashable, Sendable {
  public enum Kind: String, Sendable {
    case lan, tailscale, manual
  }

  public var kind: Kind
  /// The address or name dialled.
  public var host: String
  public var port: Int

  public init(kind: Kind, host: String, port: Int) {
    self.kind = kind
    self.host = host
    self.port = port
  }

  /// `kind|addr|port`, as the candidates table keys it.
  public var key: String { "\(kind.rawValue)|\(host)|\(port)" }

  public var isName: Bool { host.contains(where: \.isLetter) && !host.contains(":") }

  public var url: URL {
    let literal = host.contains(":") ? "[\(host)]" : host
    return URL(string: "ws://\(literal):\(port)/v1/channel")!
  }

  /// What the Machines list says it is (11 §11.21).
  public var label: String {
    switch kind {
    case .lan: "Wi-Fi"
    case .tailscale: "Tailscale"
    case .manual: host
    }
  }
}

/// `URLSessionWebSocketTask` as a `ChannelSocket`: one binary message per
/// frame. Text messages are a protocol error and close it.
final class WebSocket: NSObject, ChannelSocket, URLSessionWebSocketDelegate, @unchecked Sendable {
  let frames: AsyncThrowingStream<Data, any Error>
  private let continuation: AsyncThrowingStream<Data, any Error>.Continuation
  private let url: URL
  private let lock = NSLock()
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var opened: CheckedContinuation<Void, any Error>?
  private var closed = false

  init(url: URL) {
    self.url = url
    (frames, continuation) = AsyncThrowingStream.makeStream(bufferingPolicy: .unbounded)
    super.init()
  }

  /// Opens the socket, or throws on refusal, a non-101 answer or the deadline.
  func connect(timeout: Duration) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = Double(timeout.components.seconds) + 1
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    // The delegate queue is serial, so callbacks arrive in order.
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    var request = URLRequest(url: url)
    request.timeoutInterval = Double(timeout.components.seconds) + 1
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = 1 << 20
    lock.withLock {
      self.session = session
      self.task = task
    }
    let deadline = Task { [weak self] in
      try? await Task.sleep(for: timeout)
      if !Task.isCancelled { self?.failOpen(URLError(.timedOut)) }
    }
    defer { deadline.cancel() }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let cancelled = lock.withLock {
          if closed { return true }
          opened = continuation
          return false
        }
        if cancelled {
          continuation.resume(throwing: CancellationError())
          return
        }
        task.resume()
      }
    } onCancel: {
      self.failOpen(CancellationError())
    }
  }

  private func failOpen(_ error: any Error) {
    let waiter = lock.withLock { () -> CheckedContinuation<Void, any Error>? in
      defer { opened = nil }
      return opened
    }
    guard let waiter else { return }
    waiter.resume(throwing: error)
    shutdown(code: .abnormalClosure)
  }

  private func receive() {
    guard let task = lock.withLock({ task }) else { return }
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case let .success(.data(data)):
        continuation.yield(data)
        receive()
      case .success:
        continuation.finish(throwing: URLError(.cannotParseResponse))
        shutdown(code: .unsupportedData)
      case let .failure(error):
        continuation.finish(throwing: error)
        shutdown(code: .abnormalClosure)
      }
    }
  }

  func send(_ frame: Data) async throws {
    guard let task = lock.withLock({ closed ? nil : task }) else { throw URLError(.networkConnectionLost) }
    try await task.send(.data(frame))
  }

  func close(code: Int, reason: String) async {
    shutdown(code: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: reason)
  }

  private func shutdown(code: URLSessionWebSocketTask.CloseCode, reason: String = "") {
    let (task, session) = lock.withLock { () -> (URLSessionWebSocketTask?, URLSession?) in
      if closed { return (nil, nil) }
      closed = true
      return (self.task, self.session)
    }
    task?.cancel(with: code, reason: Data(reason.utf8))
    session?.finishTasksAndInvalidate()
    continuation.finish()
  }

  // MARK: URLSessionWebSocketDelegate

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    let waiter = lock.withLock { () -> CheckedContinuation<Void, any Error>? in
      defer { opened = nil }
      return opened
    }
    waiter?.resume()
    receive()
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    continuation.finish()
    shutdown(code: closeCode)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    // A refused upgrade (403, 404, 429) ends here with the HTTP response.
    let status = (task.response as? HTTPURLResponse)?.statusCode
    let failure = error.map { $0 as NSError } ?? NSError(domain: NSURLErrorDomain, code: URLError.badServerResponse.rawValue)
    let reported: any Error =
      if let status, status != 101 { DirectTransportError.refused(status: status) } else { failure }
    failOpen(reported)
    continuation.finish(throwing: reported)
    shutdown(code: .abnormalClosure)
  }
}

public enum DirectTransportError: Error, Equatable, Sendable, LocalizedError {
  /// The host answered the upgrade with this HTTP status (403 means an
  /// `Origin` header was sent, 429 too many attempts).
  case refused(status: Int)

  public var errorDescription: String? {
    switch self {
    case let .refused(status): "The host refused the connection (HTTP \(status))"
    }
  }
}
