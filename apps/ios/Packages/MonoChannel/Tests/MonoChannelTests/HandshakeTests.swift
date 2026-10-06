import Foundation
import MonoChannel
import Testing

struct HandshakeFixture: Decodable {
  let env: String
  let prologue: String
  let phone: Keys
  let host: Keys
  let hello: String
  let welcome: String
  let message1: String
  let message2: String
  let handshakeHash: String
  let confirmationCode: String
  let pairingSecret: String
  let pairingProof: String
  let phoneSteps: [Step]
  let hostFrames: [String]
  let hostMessages: [JSONValue]

  struct Keys: Decodable {
    let `static`: String
    let ephemeral: String
    let `public`: String
  }

  struct Step: Decodable {
    let send: Send?
    let frames: [String]?
  }

  struct Send: Decodable {
    let json: String
    let priority: Int
  }
}

/// A full handshake and both directions of transport, byte for byte with
/// the TypeScript.
@Suite struct HandshakeTests {
  let fixture: HandshakeFixture
  let phoneSide: NoiseTransport
  let hostSide: NoiseTransport

  init() throws {
    fixture = try MonoChannelTests.fixture("handshake")
    let phoneStatic = try KeyPair(secretKey: hex(fixture.phone.static))
    let hostStatic = try KeyPair(secretKey: hex(fixture.host.static))
    var initiator = try IKInitiator(
      staticKey: phoneStatic, remoteStatic: hostStatic.publicKey, prologue: hex(fixture.prologue),
      ephemeral: KeyPair(secretKey: hex(fixture.phone.ephemeral))
    )
    var responder = IKResponder(
      staticKey: hostStatic, prologue: try hex(fixture.prologue), ephemeral: try KeyPair(secretKey: hex(fixture.host.ephemeral))
    )
    let message1 = try initiator.writeMessage1(Data(fixture.hello.utf8))
    #expect(message1.hex == fixture.message1)
    let read1 = try responder.readMessage1(message1)
    #expect(read1.payload == Data(fixture.hello.utf8))
    #expect(read1.remoteStatic.hex == fixture.phone.public)
    let written2 = try responder.writeMessage2(Data(fixture.welcome.utf8))
    #expect(written2.message.hex == fixture.message2)
    let read2 = try initiator.readMessage2(written2.message)
    #expect(read2.payload == Data(fixture.welcome.utf8))
    phoneSide = read2.transport
    hostSide = written2.transport
  }

  @Test func keysAndPrologue() throws {
    #expect(try KeyPair(secretKey: hex(fixture.phone.static)).publicKey.hex == fixture.phone.public)
    #expect(try KeyPair(secretKey: hex(fixture.host.static)).publicKey.hex == fixture.host.public)
    #expect(channelPrologue(fixture.env).hex == fixture.prologue)
  }

  @Test func handshakeHashCodeAndProof() throws {
    #expect(phoneSide.handshakeHash.hex == fixture.handshakeHash)
    #expect(hostSide.handshakeHash == phoneSide.handshakeHash)
    #expect(phoneSide.remoteStatic.hex == fixture.host.public)
    #expect(confirmationCode(handshakeHash: phoneSide.handshakeHash) == fixture.confirmationCode)
    #expect(pairingProof(secret: try hex(fixture.pairingSecret), handshakeHash: phoneSide.handshakeHash).hex == fixture.pairingProof)
  }

  @Test func helloAndWelcomeDecode() throws {
    let hello = try JSONDecoder().decode(Hello.self, from: Data(fixture.hello.utf8))
    #expect(hello.env == fixture.env)
    let reply = try JSONDecoder().decode(HandshakeReply.self, from: Data(fixture.welcome.utf8))
    guard case .welcome = reply else {
      Issue.record("expected a welcome")
      return
    }
  }

  /// The phone's queues seal the same records in the same order, so the
  /// frames match byte for byte; the host opens them.
  @Test func phoneFramesFollowThePriorityQueues() throws {
    var phone = SecureSession(transport: phoneSide, compress: false)
    var host = SecureSession(transport: hostSide)
    var sent: [String] = []
    var received: [String] = []
    var released = 0
    for step in fixture.phoneSteps {
      if let send = step.send {
        try phone.enqueue(json: Data(send.json.utf8), priority: #require(Priority(rawValue: send.priority)))
        sent.append(send.json)
      }
      for expected in step.frames ?? [] {
        let frame = try #require(try phone.nextFrame())
        #expect(frame.base64URL == expected, "frame \(released)")
        released += 1
        if let message = try host.receive(frame) { received.append(String(decoding: message, as: UTF8.self)) }
      }
    }
    #expect(released == 5)
    #expect(!phone.hasQueued)
    #expect(try phone.nextFrame() == nil)
    // The urgent request and ping overtook the bulk message's last fragment.
    #expect(received == [sent[1], sent[2], sent[3], sent[0]])
  }

  /// The host's frames, compressed and fragmented, open into its messages.
  @Test func hostFramesOpen() throws {
    var phone = SecureSession(transport: phoneSide)
    var messages: [JSONValue] = []
    for frame in fixture.hostFrames {
      if let message = try phone.receive(b64(frame)) {
        messages.append(try JSONDecoder().decode(JSONValue.self, from: message))
      }
    }
    #expect(messages.count == fixture.hostMessages.count)
    for (message, expected) in zip(messages, fixture.hostMessages) {
      #expect(jsonDifference(message, expected) == nil)
    }
  }

  /// Swift's own host side, compressing with Apple's encoder, round-trips.
  @Test func swiftSessionsRoundTrip() throws {
    var phone = SecureSession(transport: phoneSide)
    var host = SecureSession(transport: hostSide)
    for (index, message) in fixture.hostMessages.enumerated() {
      try host.enqueue(message, priority: index == 2 ? .bulk : .normal)
    }
    var messages: [JSONValue] = []
    while let frame = try host.nextFrame() {
      if let message = try phone.receive(frame) { messages.append(try JSONDecoder().decode(JSONValue.self, from: message)) }
    }
    // The bulk message goes out after the ones queued behind it.
    let expected = fixture.hostMessages
    #expect(messages == [expected[0], expected[1], expected[3], expected[2]])
  }

  /// A tampered or replayed transport frame fails, which closes the channel.
  @Test func rejectsTamperedAndReplayedFrames() throws {
    var phone = SecureSession(transport: phoneSide)
    var first = try b64(fixture.hostFrames[0])
    first[first.count - 1] ^= 1
    #expect(throws: NoiseError.decryptFailed) { try phone.receive(first) }
    let original = try b64(fixture.hostFrames[0])
    _ = try phone.receive(original)
    #expect(throws: NoiseError.decryptFailed) { try phone.receive(original) }
    var wrongKind = try b64(fixture.hostFrames[1])
    wrongKind[0] = FrameKind.handshake2.rawValue
    #expect(throws: RecordError.unexpectedFrame) { try phone.receive(wrongKind) }
  }
}
