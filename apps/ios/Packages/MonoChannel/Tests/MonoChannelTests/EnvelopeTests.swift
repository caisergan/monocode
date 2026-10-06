import Foundation
import MonoChannel
import Testing

struct EnvelopeFixtures: Decodable {
  let channelVersion: Int
  let prologue: String
  let frames: [String: UInt8]
  let hellos: [JSONValue]
  let replies: [Reply]
  let client: [JSONValue]
  let host: [JSONValue]
  let errors: [JSONValue]

  struct Reply: Decodable {
    let reply: JSONValue
    let pairing: Bool
  }
}

/// Drops the fields a newer host may add, which decoding ignores.
func withoutUnknown(_ value: JSONValue, _ keys: Set<String>) -> JSONValue {
  guard case let .object(object) = value else { return value }
  return .object(object.filter { !keys.contains($0.key) })
}

@Suite struct EnvelopeTests {
  let fixtures: EnvelopeFixtures

  init() throws {
    fixtures = try fixture("envelopes")
  }

  @Test func prologueAndFrameKinds() throws {
    #expect(fixtures.channelVersion == channelVersion)
    #expect(channelPrologue("6f0b1f8e-3c2a-4a59-9a77-5d1c2b0f4e11").hex == fixtures.prologue)
    #expect(fixtures.frames["handshake1"] == FrameKind.handshake1.rawValue)
    #expect(fixtures.frames["handshake2"] == FrameKind.handshake2.rawValue)
    #expect(fixtures.frames["transport"] == FrameKind.transport.rawValue)
    #expect(fixtures.frames["reject"] == FrameKind.reject.rawValue)
  }

  @Test func hellos() throws {
    for hello in fixtures.hellos { try expectRoundTrip(Hello.self, hello) }
    let pairing = try fixtures.hellos[1].decode(Hello.self)
    #expect(pairing.pair?.offer != nil)
    #expect(pairing.caps.contains("someFutureCap"))
  }

  @Test func handshakeReplies() throws {
    for case_ in fixtures.replies {
      let reply = try expectRoundTrip(HandshakeReply.self, withoutUnknown(case_.reply, ["future"]))
      if case .pairing = reply { #expect(case_.pairing) } else { #expect(!case_.pairing) }
    }
    guard case let .welcome(welcome) = try fixtures.replies[0].reply.decode(HandshakeReply.self) else {
      Issue.record("expected a welcome")
      return
    }
    #expect(welcome.limits.maxMessage == maxMessage)
    #expect(welcome.relay == nil)
    #expect(welcome.endpoints[1].dns == "mac-mini.tail1234.ts.net")
    guard case let .error(error) = try fixtures.replies[4].reply.decode(HandshakeReply.self) else {
      Issue.record("expected an error")
      return
    }
    #expect(error.code == .unknownDevice)
    if case let .welcome(observer) = try fixtures.replies[2].reply.decode(HandshakeReply.self) {
      #expect(observer.device.role.rawValue == "observer")
    } else {
      Issue.record("expected a welcome")
    }
  }

  @Test func clientMessages() throws {
    let messages = try fixtures.client.map { try expectRoundTrip(ClientMessage.self, $0) }
    #expect(messages[2] == .request(id: 3, method: "environment.describe", params: nil, key: nil))
    #expect(messages[4] == .ping(ts: 1_760_000_000_000.25, presence: Presence(visible: false)))
    #expect(messages.last == .bye(.pairingClosed))
  }

  @Test func hostMessages() throws {
    let messages = try fixtures.host.map { try expectRoundTrip(HostMessage.self, $0) }
    #expect(messages[3] == .error(id: 4, ChannelError(code: .notFound, message: "No such session", retryable: false)))
    #expect(messages[4] == .error(id: 5, ChannelError(code: .rateLimited, message: "Slow down", retryable: true, data: ["retryAfterMs": 1000])))
    #expect(messages[7] == .event(name: "inbox.changed", data: nil))
    #expect(messages[8] == .pong(ts: 1_760_000_000_000.25, now: 1_760_000_000_050))
    #expect(messages.last == .bye("a_future_bye", message: nil))
    #expect(try JSONValue(["t": "future"] as JSONValue).decode(HostMessage.self) == .unknown("future"))
  }

  @Test func errors() throws {
    for error in fixtures.errors { try expectRoundTrip(ChannelError.self, error) }
  }
}
