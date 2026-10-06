import Foundation
import MonoChannel
import Testing

struct RecordFixtures: Decodable {
  let constants: Constants
  let boundaries: [Boundary]
  let compressed: [Compressed]
  let incompressible: Incompressible
  let bomb: Bomb

  struct Constants: Decodable {
    let maxNoiseMessage, tagLength, recordHeader, maxFragment, maxMessage, compressMin: Int
  }

  struct Boundary: Decodable {
    let size: Int
    let msgId: UInt32
    let salt: Int
    let records: [String]
  }

  struct Compressed: Decodable {
    let name: String
    let msgId: UInt32
    let json: String
    let type: UInt8
    let records: [String]
  }

  struct Incompressible: Decodable {
    let bytes: String
    let type: UInt8
  }

  struct Bomb: Decodable {
    let size: Int
    let deflate: String
  }
}

/// The script's byte pattern: (i * 31 + salt) & 0xff.
func pattern(_ length: Int, salt: Int) -> Data {
  Data((0..<length).map { UInt8(truncatingIfNeeded: $0 * 31 + salt) })
}

/// Pushes every record; returns the one complete message at the end.
func reassemble(_ records: [Data], maxMessage: Int = MonoChannel.maxMessage) throws -> (type: RecordType, payload: Data)? {
  var reassembler = Reassembler(maxMessage: maxMessage)
  var result: (type: RecordType, payload: Data)?
  for (index, record) in records.enumerated() {
    result = try reassembler.push(record)
    #expect((result == nil) == (index < records.count - 1))
  }
  return result
}

@Suite struct RecordTests {
  let fixtures: RecordFixtures

  init() throws {
    fixtures = try fixture("records")
  }

  @Test func constantsMatchTheTypeScript() {
    let c = fixtures.constants
    #expect(c.maxNoiseMessage == maxNoiseMessage)
    #expect(c.tagLength == tagLength)
    #expect(c.recordHeader == recordHeaderLength)
    #expect(c.maxFragment == maxFragment)
    #expect(maxFragment == 65_513)
    #expect(c.maxMessage == maxMessage)
    #expect(c.compressMin == compressMin)
  }

  @Test func boundarySizes() throws {
    #expect(fixtures.boundaries.map(\.size) == [0, 1, 65_513, 65_514])
    for boundary in fixtures.boundaries {
      let payload = pattern(boundary.size, salt: boundary.salt)
      let expected = try boundary.records.map(b64)
      let encoded = encodeRecords(msgId: boundary.msgId, type: .json, payload: payload)
      #expect(encoded == expected, "size \(boundary.size)")
      #expect(expected.allSatisfy { $0.count <= maxFragment + recordHeaderLength })
      let message = try #require(try reassemble(expected))
      #expect(message.type == .json)
      #expect(message.payload == payload)
    }
  }

  @Test func compressedRecords() throws {
    for case_ in fixtures.compressed {
      let records = try case_.records.map(b64)
      let message = try #require(try reassemble(records), "\(case_.name)")
      #expect(message.type.rawValue == case_.type, "\(case_.name)")
      // Re-encoding the same payload gives the same records.
      #expect(encodeRecords(msgId: case_.msgId, type: message.type, payload: message.payload) == records)
      let json = Data(case_.json.utf8)
      let plain = message.type == .deflate ? try inflateBounded(message.payload) : message.payload
      #expect(plain == json, "\(case_.name)")
      // Apple's encoder makes different bytes from fflate's, but the same
      // decision, and its output inflates back.
      let mine = maybeCompress(json)
      #expect(mine.type.rawValue == case_.type, "\(case_.name)")
      if mine.type == .deflate { #expect(try inflateBounded(mine.payload) == json) }
    }
    #expect(fixtures.compressed.contains { $0.records.count > 1 && $0.type == RecordType.deflate.rawValue })
  }

  @Test func incompressiblePayloadsStayJSON() throws {
    let bytes = try b64(fixtures.incompressible.bytes)
    #expect(maybeCompress(bytes).type.rawValue == fixtures.incompressible.type)
    #expect(maybeCompress(bytes).payload == bytes)
  }

  /// The bomb inflates to exactly its size; one byte less stops it.
  @Test func deflateBombIsCutAtTheLimit() throws {
    let bomb = try b64(fixtures.bomb.deflate)
    #expect(bomb.count < 10_000)
    #expect(try inflateBounded(bomb, max: fixtures.bomb.size) == Data(count: fixtures.bomb.size))
    #expect(throws: RecordError.decompressedTooLarge) { try inflateBounded(bomb, max: fixtures.bomb.size - 1) }
    #expect(throws: RecordError.decompressedTooLarge) { try inflateBounded(bomb, max: 1024 * 1024) }
    #expect(throws: RecordError.decompressedTooLarge) { try inflateBounded(bomb, max: 0) }
  }

  @Test func corruptAndTruncatedDeflateThrow() throws {
    let compressed = try deflateRaw(Data(repeating: 7, count: 100_000))
    #expect(throws: RecordError.corruptCompression) { try inflateBounded(compressed.prefix(compressed.count / 2)) }
    #expect(throws: RecordError.corruptCompression) { try inflateBounded(Data([0xFF, 0xFF, 0xFF, 0xFF])) }
    #expect(try inflateBounded(deflateRaw(Data())) == Data())
  }

  @Test func reassemblesInterleavedMessages() throws {
    let big = pattern(maxFragment * 2 + 10, salt: 3)
    let small = Data(#"{"t":"pong"}"#.utf8)
    let bigRecords = encodeRecords(msgId: 7, type: .json, payload: big)
    #expect(bigRecords.count == 3)
    var reassembler = Reassembler()
    #expect(try reassembler.push(bigRecords[0]) == nil)
    let interleaved = try #require(try reassembler.push(encodeRecords(msgId: 8, type: .json, payload: small)[0]))
    #expect(interleaved.payload == small)
    #expect(try reassembler.push(bigRecords[1]) == nil)
    #expect(try reassembler.push(bigRecords[2])?.payload == big)
  }

  @Test func rejectsBadRecords() throws {
    var record = encodeRecords(msgId: 1, type: .json, payload: Data("{}".utf8))[0]
    record[1] |= 2
    var reassembler = Reassembler()
    #expect(throws: RecordError.reservedFlags) { try reassembler.push(record) }
    #expect(throws: RecordError.tooShort) { try reassembler.push(Data([1, 1, 0, 0, 0])) }
    #expect(throws: RecordError.unknownType) { try reassembler.push(Data([3, 1, 0, 0, 0, 0])) }
    let parts = encodeRecords(msgId: 2, type: .json, payload: Data(count: maxFragment + 1))
    _ = try reassembler.push(parts[0])
    var changed = parts[1]
    changed[0] = RecordType.deflate.rawValue
    #expect(throws: RecordError.typeChanged) { try reassembler.push(changed) }
  }

  @Test func rejectsOversizeMessages() throws {
    var limited = Reassembler(maxMessage: maxFragment + 5)
    let parts = encodeRecords(msgId: 2, type: .json, payload: Data(count: maxFragment * 2))
    #expect(try limited.push(parts[0]) == nil)
    #expect(throws: RecordError.messageTooLarge) { try limited.push(parts[1]) }
    // A single-record message is limited by the Noise frame instead.
    #expect(throws: RecordError.messageTooLarge) {
      var session = SecureSession(transport: try handshake().phone, maxMessage: 10)
      try session.enqueue(json: Data(count: 11))
    }
  }

  @Test func rejectsTooManyPartials() throws {
    var crowded = Reassembler()
    let fragment = Data(count: maxFragment + 1)
    for id in 0..<32 { _ = try crowded.push(encodeRecords(msgId: UInt32(id), type: .json, payload: fragment)[0]) }
    #expect(throws: RecordError.tooManyPartials) {
      try crowded.push(encodeRecords(msgId: 99, type: .json, payload: fragment)[0])
    }
  }

  @Test func rejectsTooMuchBufferedData() throws {
    var reassembler = Reassembler()
    let first = encodeRecords(msgId: 0, type: .json, payload: Data(count: maxFragment + 1))[0]
    let fragment = first.dropFirst(recordHeaderLength)
    // 48 MiB across four partials, each under the 16 MiB message limit.
    var pushed = 0
    #expect(throws: RecordError.tooMuchBuffered) {
      while true {
        let id = UInt32(pushed / 240)
        var record = Data([RecordType.json.rawValue, 0])
        withUnsafeBytes(of: id.bigEndian) { record.append(contentsOf: $0) }
        record.append(fragment)
        _ = try reassembler.push(record)
        pushed += 1
      }
    }
    #expect(pushed == 48 * 1024 * 1024 / maxFragment)
  }

  @Test func emptyMessagesStillMakeARecord() throws {
    let records = encodeRecords(msgId: .max, type: .json, payload: Data())
    #expect(records == [Data([1, 1, 0xFF, 0xFF, 0xFF, 0xFF])])
    #expect(try reassemble(records)?.payload == Data())
  }
}
