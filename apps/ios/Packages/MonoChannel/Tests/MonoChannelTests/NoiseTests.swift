import Foundation
import MonoChannel
import Testing

/// One handshake from the published cacophony and snow vectors.
struct Vector: Decodable {
  let protocol_name: String
  let init_prologue: String
  let init_static: String
  let init_ephemeral: String
  let init_remote_static: String
  let resp_prologue: String
  let resp_static: String
  let resp_ephemeral: String
  let handshake_hash: String?
  let messages: [Message]

  struct Message: Decodable {
    let payload: String
    let ciphertext: String
  }
}

/// Runs both roles of a vector and checks every byte.
func runVector(_ vector: Vector) throws {
  #expect(vector.protocol_name == noiseProtocolName)
  let initiatorStatic = try KeyPair(secretKey: hex(vector.init_static))
  var initiator = try IKInitiator(
    staticKey: initiatorStatic, remoteStatic: hex(vector.init_remote_static), prologue: hex(vector.init_prologue),
    ephemeral: KeyPair(secretKey: hex(vector.init_ephemeral))
  )
  var responder = try IKResponder(
    staticKey: KeyPair(secretKey: hex(vector.resp_static)), prologue: hex(vector.resp_prologue),
    ephemeral: KeyPair(secretKey: hex(vector.resp_ephemeral))
  )
  let first = vector.messages[0]
  let second = vector.messages[1]

  let message1 = try initiator.writeMessage1(hex(first.payload))
  #expect(message1.hex == first.ciphertext)
  let read1 = try responder.readMessage1(message1)
  #expect(read1.payload.hex == first.payload)
  #expect(read1.remoteStatic == initiatorStatic.publicKey)

  let written2 = try responder.writeMessage2(hex(second.payload))
  #expect(written2.message.hex == second.ciphertext)
  let read2 = try initiator.readMessage2(written2.message)
  #expect(read2.payload.hex == second.payload)
  #expect(read2.transport.handshakeHash == written2.transport.handshakeHash)
  if let hash = vector.handshake_hash { #expect(read2.transport.handshakeHash.hex == hash) }

  // Transport messages alternate, starting with the initiator.
  var phone = read2.transport
  var host = written2.transport
  for (index, message) in vector.messages.dropFirst(2).enumerated() {
    if index % 2 == 0 {
      let ciphertext = try phone.send.encrypt(hex(message.payload))
      #expect(ciphertext.hex == message.ciphertext)
      #expect(try host.receive.decrypt(ciphertext).hex == message.payload)
    } else {
      let ciphertext = try host.send.encrypt(hex(message.payload))
      #expect(ciphertext.hex == message.ciphertext)
      #expect(try phone.receive.decrypt(ciphertext).hex == message.payload)
    }
  }
}

/// A completed handshake over fresh keys.
func handshake(prologue: Data = channelPrologue("env")) throws -> (phone: NoiseTransport, host: NoiseTransport) {
  let host = KeyPair.generate()
  var initiator = try IKInitiator(staticKey: .generate(), remoteStatic: host.publicKey, prologue: prologue)
  var responder = IKResponder(staticKey: host, prologue: prologue)
  _ = try responder.readMessage1(initiator.writeMessage1(Data("hello".utf8)))
  let (message, hostSide) = try responder.writeMessage2(Data("welcome".utf8))
  let (payload, phoneSide) = try initiator.readMessage2(message)
  #expect(payload == Data("welcome".utf8))
  return (phoneSide, hostSide)
}

@Suite struct NoiseTests {
  @Test func cacophonyVector() throws {
    let vectors = try fixture("cacophony-ik", as: [Vector].self)
    #expect(vectors.count == 1)
    try runVector(vectors[0])
  }

  @Test func snowVector() throws {
    let vectors = try fixture("snow-ik", as: [Vector].self)
    #expect(vectors.count == 1)
    try runVector(vectors[0])
  }

  @Test func freshKeysCarryPayloadsBothWays() throws {
    var (phone, host) = try handshake()
    #expect(phone.handshakeHash == host.handshakeHash)
    let sealed = try phone.send.encrypt(Data("ping".utf8))
    #expect(sealed.count == 4 + tagLength)
    #expect(try host.receive.decrypt(sealed) == Data("ping".utf8))
    let back = try host.send.encrypt(Data("pong".utf8))
    #expect(try phone.receive.decrypt(back) == Data("pong".utf8))
  }

  @Test func rejectsMessage1ForAnotherHostKey() throws {
    let host = KeyPair.generate()
    var initiator = try IKInitiator(staticKey: .generate(), remoteStatic: KeyPair.generate().publicKey, prologue: Data("a".utf8))
    let message = try initiator.writeMessage1(Data("{}".utf8))
    var responder = IKResponder(staticKey: host, prologue: Data("a".utf8))
    #expect(throws: NoiseError.decryptFailed) { try responder.readMessage1(message) }
  }

  @Test func rejectsTheWrongPrologue() throws {
    let host = KeyPair.generate()
    var initiator = try IKInitiator(staticKey: .generate(), remoteStatic: host.publicKey, prologue: channelPrologue("a"))
    let message = try initiator.writeMessage1(Data("{}".utf8))
    var responder = IKResponder(staticKey: host, prologue: channelPrologue("b"))
    #expect(throws: NoiseError.decryptFailed) { try responder.readMessage1(message) }
    // And message 2 from a host with another prologue.
    var other = IKResponder(staticKey: host, prologue: channelPrologue("a"))
    _ = try other.readMessage1(message)
    var initiator2 = try IKInitiator(staticKey: .generate(), remoteStatic: host.publicKey, prologue: channelPrologue("b"))
    var responder2 = IKResponder(staticKey: host, prologue: channelPrologue("b"))
    _ = try responder2.readMessage1(initiator2.writeMessage1(Data()))
    let reply = try other.writeMessage2(Data())
    #expect(throws: NoiseError.decryptFailed) { try initiator2.readMessage2(reply.message) }
  }

  @Test(arguments: [0, 31, 32, 47, 48, 60, 95])
  func rejectsATamperedMessage1(at offset: Int) throws {
    let host = KeyPair.generate()
    var initiator = try IKInitiator(staticKey: .generate(), remoteStatic: host.publicKey, prologue: channelPrologue("e"))
    var message = try initiator.writeMessage1(Data("hello".utf8))
    message[offset] ^= 0x01
    var responder = IKResponder(staticKey: host, prologue: channelPrologue("e"))
    #expect(throws: NoiseError.self) { try responder.readMessage1(message) }
  }

  @Test(arguments: [0, 31, 32, 40, 52])
  func rejectsATamperedMessage2(at offset: Int) throws {
    let host = KeyPair.generate()
    var initiator = try IKInitiator(staticKey: .generate(), remoteStatic: host.publicKey, prologue: channelPrologue("e"))
    var responder = IKResponder(staticKey: host, prologue: channelPrologue("e"))
    _ = try responder.readMessage1(initiator.writeMessage1(Data("hello".utf8)))
    var message = try responder.writeMessage2(Data("welcome".utf8)).message
    message[offset] ^= 0x80
    #expect(throws: NoiseError.self) { try initiator.readMessage2(message) }
  }

  @Test func rejectsShortMessagesAndSteps() throws {
    let host = KeyPair.generate()
    var responder = IKResponder(staticKey: host, prologue: Data())
    #expect(throws: NoiseError.messageTooShort) { try responder.readMessage1(Data(count: 95)) }
    #expect(throws: NoiseError.unexpectedMessage) { try responder.writeMessage2(Data()) }
    var initiator = try IKInitiator(staticKey: .generate(), remoteStatic: host.publicKey, prologue: Data())
    #expect(throws: NoiseError.unexpectedMessage) { try initiator.readMessage2(Data(count: 48)) }
    _ = try initiator.writeMessage1(Data())
    #expect(throws: NoiseError.unexpectedMessage) { try initiator.writeMessage1(Data()) }
    #expect(throws: NoiseError.messageTooShort) { try initiator.readMessage2(Data(count: 47)) }
    #expect(throws: NoiseError.invalidKey) { try IKInitiator(staticKey: .generate(), remoteStatic: Data(count: 31), prologue: Data()) }
    #expect(throws: NoiseError.messageTooLarge) {
      var big = try IKInitiator(staticKey: .generate(), remoteStatic: host.publicKey, prologue: Data())
      return try big.writeMessage1(Data(count: maxNoiseMessage))
    }
  }

  /// Nonces are implicit counters: a replayed or reordered message fails
  /// authentication, and a failure doesn't advance the counter.
  @Test func rejectsReplayedAndReorderedMessages() throws {
    var (phone, host) = try handshake()
    let a = try phone.send.encrypt(Data("a".utf8))
    let b = try phone.send.encrypt(Data("b".utf8))
    #expect(throws: NoiseError.decryptFailed) { try host.receive.decrypt(b) }
    #expect(host.receive.count == 0)
    #expect(try host.receive.decrypt(a) == Data("a".utf8))
    #expect(throws: NoiseError.decryptFailed) { try host.receive.decrypt(a) }
    #expect(try host.receive.decrypt(b) == Data("b".utf8))
  }

  /// A sender that seals a second message under an already used nonce is
  /// caught: the receiver has moved past it.
  @Test func rejectsAReusedNonce() throws {
    var (phone, host) = try handshake()
    var rewound = phone.send
    #expect(try host.receive.decrypt(phone.send.encrypt(Data("first".utf8))) == Data("first".utf8))
    let reused = try rewound.encrypt(Data("other".utf8))
    #expect(throws: NoiseError.decryptFailed) { try host.receive.decrypt(reused) }
    #expect(try host.receive.decrypt(phone.send.encrypt(Data("next".utf8))) == Data("next".utf8))
  }

  @Test func keyPairsMatchCryptoKit() throws {
    let pair = KeyPair.generate()
    #expect(try KeyPair(secretKey: pair.secretKey) == pair)
    #expect(throws: NoiseError.invalidKey) { try KeyPair(secretKey: Data(count: 31)) }
  }
}
