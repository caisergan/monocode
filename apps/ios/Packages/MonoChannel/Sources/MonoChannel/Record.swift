import Compression
import Foundation

// Record layer (03 §3.5). Every TRANSPORT frame decrypts to one record:
//
//   offset  size  field
//   0       1     type    0x01 = JSON, 0x02 = JSON, deflate-raw compressed
//   1       1     flags   bit 0 = FIN (last fragment); bits 1-7 MUST be 0
//   2       4     msgId   big-endian u32, per sender, +1 per message, wraps
//   6       ≤65,513 fragment

public enum RecordType: UInt8, Sendable {
  case json = 0x01
  case deflate = 0x02
}

public let recordHeaderLength = 6
public let maxFragment = maxNoiseMessage - tagLength - recordHeaderLength
/// The largest assembled message unless the welcome's `limits.maxMessage` says otherwise.
public let maxMessage = 16 * 1024 * 1024
let maxPartials = 32
let maxBuffered = 48 * 1024 * 1024
/// Smaller messages are never worth compressing.
public let compressMin = 1024

/// A framing violation. The channel closes with `bye{code:"protocol_error"}`.
public enum RecordError: Error, Equatable, Sendable {
  case tooShort
  case unknownType
  case reservedFlags
  case typeChanged
  case tooManyPartials
  case messageTooLarge
  case tooMuchBuffered
  case decompressedTooLarge
  case corruptCompression
  case unexpectedFrame
}

/// Cuts one serialised message into records. Empty messages still produce one.
public func encodeRecords(msgId: UInt32, type: RecordType, payload: Data) -> [Data] {
  let payload = Data(payload)
  var records: [Data] = []
  var offset = 0
  repeat {
    let end = min(payload.count, offset + maxFragment)
    var record = Data(capacity: recordHeaderLength + end - offset)
    record.append(type.rawValue)
    record.append(end == payload.count ? 1 : 0)
    withUnsafeBytes(of: msgId.bigEndian) { record.append(contentsOf: $0) }
    record.append(payload[offset..<end])
    records.append(record)
    offset = end
  } while offset < payload.count
  return records
}

/// Compresses when it helps; returns the record type to use.
public func maybeCompress(_ payload: Data) -> (type: RecordType, payload: Data) {
  if payload.count < compressMin { return (.json, payload) }
  guard let compressed = try? deflateRaw(payload), compressed.count < payload.count else { return (.json, payload) }
  return (.deflate, compressed)
}

/// Raw deflate (RFC 1951) with Apple's encoder.
public func deflateRaw(_ payload: Data) throws -> Data {
  try runStream(COMPRESSION_STREAM_ENCODE, payload, max: .max)
}

/// Streams the inflate, so a compression bomb stops at `max` bytes.
public func inflateBounded(_ payload: Data, max: Int = maxMessage) throws -> Data {
  try runStream(COMPRESSION_STREAM_DECODE, payload, max: max)
}

private func runStream(_ operation: compression_stream_operation, _ input: Data, max: Int) throws -> Data {
  let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
  defer { stream.deallocate() }
  guard compression_stream_init(stream, operation, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
    throw RecordError.corruptCompression
  }
  defer { compression_stream_destroy(stream) }
  let chunk = 64 * 1024
  let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
  defer { buffer.deallocate() }
  var output = Data()
  let input = Data(input)
  return try input.withUnsafeBytes { (source: UnsafeRawBufferPointer) in
    stream.pointee.src_ptr = source.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(buffer)
    stream.pointee.src_size = source.count
    while true {
      stream.pointee.dst_ptr = buffer
      stream.pointee.dst_size = chunk
      let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
      let produced = chunk - stream.pointee.dst_size
      if produced > 0 {
        if output.count + produced > max { throw RecordError.decompressedTooLarge }
        output.append(buffer, count: produced)
      }
      switch status {
      case COMPRESSION_STATUS_END:
        return output
      case COMPRESSION_STATUS_OK:
        // The input ran out before the final block: a truncated stream.
        if produced == 0 && stream.pointee.src_size == 0 { throw RecordError.corruptCompression }
      default:
        throw RecordError.corruptCompression
      }
    }
  }
}

/// Reassembles fragments. Messages may interleave; fragments of one message
/// arrive in order. Violations throw `RecordError`, and the channel closes.
public struct Reassembler: Sendable {
  private struct Partial {
    var type: RecordType
    var payload: Data
  }

  private var partials: [UInt32: Partial] = [:]
  private var buffered = 0
  private let maxMessage: Int

  public init(maxMessage: Int = MonoChannel.maxMessage) {
    self.maxMessage = maxMessage
  }

  /// A complete message, or nil while fragments are pending.
  public mutating func push(_ record: Data) throws -> (type: RecordType, payload: Data)? {
    let record = Data(record)
    if record.count < recordHeaderLength { throw RecordError.tooShort }
    guard let type = RecordType(rawValue: record[0]) else { throw RecordError.unknownType }
    let flags = record[1]
    if flags & 0xFE != 0 { throw RecordError.reservedFlags }
    let msgId = record[2..<6].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
    let fragment = record.dropFirst(recordHeaderLength)
    let fin = flags & 1 == 1
    // Taken out of the map while it grows, so appending doesn't copy.
    var partial: Partial
    if let existing = partials.removeValue(forKey: msgId) {
      if existing.type != type { throw RecordError.typeChanged }
      partial = existing
    } else {
      if fin { return (type, Data(fragment)) }
      if partials.count >= maxPartials { throw RecordError.tooManyPartials }
      partial = Partial(type: type, payload: Data())
    }
    partial.payload.append(fragment)
    buffered += fragment.count
    if partial.payload.count > maxMessage { throw RecordError.messageTooLarge }
    if buffered > maxBuffered { throw RecordError.tooMuchBuffered }
    if !fin {
      partials[msgId] = partial
      return nil
    }
    buffered -= partial.payload.count
    return (partial.type, partial.payload)
  }
}
