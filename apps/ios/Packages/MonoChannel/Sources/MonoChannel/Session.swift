import Foundation

// Turns a completed Noise handshake into a message channel: JSON messages,
// optional compression, fragmentation and three priority queues, so a small
// approval event never waits behind a large snapshot (03 §3.5).

/// The record and cipher state of one open channel. A value type with no
/// I/O: `Channel` owns one and moves its frames.
public struct SecureSession: Sendable {
  private var transport: NoiseTransport
  private var queues: [[Data]] = [[], [], []]
  private var heads = [0, 0, 0]
  private var msgId: UInt32 = 0
  private var reassembler: Reassembler
  private var closed = false
  public let compress: Bool
  public let maxMessage: Int

  public init(transport: NoiseTransport, compress: Bool = true, maxMessage: Int = MonoChannel.maxMessage) {
    self.transport = transport
    self.compress = compress
    self.maxMessage = maxMessage
    reassembler = Reassembler(maxMessage: maxMessage)
  }

  public var handshakeHash: Data { transport.handshakeHash }

  /// Bytes queued here, not yet sealed.
  public var queuedBytes: Int {
    (0..<3).reduce(0) { total, priority in
      total + queues[priority][heads[priority]...].reduce(0) { $0 + $1.count }
    }
  }

  public var hasQueued: Bool {
    (0..<3).contains { heads[$0] < queues[$0].count }
  }

  /// Compresses (when it helps), fragments and queues one JSON message.
  public mutating func enqueue(json: Data, priority: Priority = .normal) throws {
    if closed { return }
    if json.count > maxMessage { throw RecordError.messageTooLarge }
    let (type, payload) = compress ? maybeCompress(json) : (.json, json)
    let id = msgId
    msgId &+= 1
    queues[priority.rawValue] += encodeRecords(msgId: id, type: type, payload: payload)
  }

  public mutating func enqueue(_ message: some Encodable, priority: Priority = .normal) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    try enqueue(json: encoder.encode(message), priority: priority)
  }

  /// Seals the next record, highest priority first, as a TRANSPORT frame.
  /// Sealing at dequeue keeps nonces in the order frames hit the wire.
  public mutating func nextFrame() throws -> Data? {
    if closed { return nil }
    guard let priority = (0..<3).first(where: { heads[$0] < queues[$0].count }) else { return nil }
    let record = queues[priority][heads[priority]]
    heads[priority] += 1
    if heads[priority] == queues[priority].count {
      queues[priority].removeAll(keepingCapacity: true)
      heads[priority] = 0
    }
    return Data([FrameKind.transport.rawValue]) + (try transport.send.encrypt(record))
  }

  /// A complete message's JSON bytes, or nil while fragments are pending.
  /// Throws on any authentication or framing error; close the channel then.
  public mutating func receive(_ frame: Data) throws -> Data? {
    guard frame.first == FrameKind.transport.rawValue else { throw RecordError.unexpectedFrame }
    let record = try transport.receive.decrypt(frame.dropFirst())
    guard let message = try reassembler.push(record) else { return nil }
    return message.type == .deflate ? try inflateBounded(message.payload, max: maxMessage) : message.payload
  }

  public mutating func close() {
    closed = true
    queues = [[], [], []]
    heads = [0, 0, 0]
  }
}
