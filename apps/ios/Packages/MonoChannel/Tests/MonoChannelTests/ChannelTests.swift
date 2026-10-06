import Foundation
import MonoChannel
import Synchronization
import Testing

let testEnv = "6f0b1f8e-3c2a-4a59-9a77-5d1c2b0f4e11"

let testHello = Hello(
  env: testEnv, n: 1, app: .init(name: "MonoCode", version: "0", build: "0", platform: "ios", os: "26.0"),
  caps: [.deflate], providers: []
)

let testWelcome: JSONValue = [
  "ok": true, "channel": 1, "env": .string(testEnv), "boot": "b", "time": 0,
  "host": ["name": "Test", "platform": "darwin", "version": "1", "fingerprint": "f"],
  "device": ["id": "d", "name": "Phone", "role": "member"],
  "capabilities": ["inbox"], "providers": [], "endpoints": [], "relay": nil, "push": ["enabled": false],
  "limits": ["maxMessage": 16_777_216, "maxInFlight": 64, "maxWatchedSessions": 8],
]

/// A minimal host: answers the handshake, then requests. Everything the phone
/// sends after the handshake is recorded.
final class FakeHost: Sendable {
  enum Handshake: Sendable {
    case reply(JSONValue)
    case reject(String)
    case silent
    case garbage
  }

  let key = KeyPair.generate()
  let received = Mutex<[JSONValue]>([])
  private let socket: MemoryChannelSocket

  init(_ socket: MemoryChannelSocket, handshake: Handshake = .reply(testWelcome)) {
    self.socket = socket
    let key = key
    Task { [self] in
      var responder = IKResponder(staticKey: key, prologue: channelPrologue(testEnv))
      var session: SecureSession?
      do {
        for try await frame in socket.frames {
          guard var open = session else {
            switch handshake {
            case .silent: continue
            case let .reject(code):
              try await socket.send(Data([FrameKind.reject.rawValue]) + JSONEncoder().encode(["code": code]))
              continue
            case .garbage:
              try await socket.send(Data([FrameKind.handshake2.rawValue]) + Data(count: 64))
              continue
            case let .reply(reply):
              _ = try responder.readMessage1(frame.dropFirst())
              let (message, transport) = try responder.writeMessage2(JSONEncoder().encode(reply))
              try await socket.send(Data([FrameKind.handshake2.rawValue]) + message)
              session = SecureSession(transport: transport)
              continue
            }
          }
          guard let data = try open.receive(frame) else {
            session = open
            continue
          }
          let message = try JSONDecoder().decode(JSONValue.self, from: data)
          received.withLock { $0.append(message) }
          for (reply, priority) in answer(message) { try open.enqueue(reply, priority: priority) }
          session = open
          while let out = try session?.nextFrame() { try await socket.send(out) }
          if message["m"] == "hangUp" { await socket.close(code: 1000, reason: "bye") }
          // A transport frame the phone's cipher can't open.
          if message["m"] == "corrupt" { try await socket.send(Data([FrameKind.transport.rawValue]) + Data(count: 40)) }
        }
      } catch {}
    }
  }

  private func answer(_ message: JSONValue) -> [(JSONValue, Priority)] {
    let id = message["id"] ?? nil
    switch (message["t"]?.stringValue, message["m"]?.stringValue) {
    case ("req", "echo"):
      return [
        (["t": "evt", "e": "echoed", "d": message["p"] ?? nil], .normal),
        (["t": "res", "id": id, "ok": true, "r": message["p"] ?? nil], .urgent),
      ]
    case ("req", "big"):
      return [(["t": "res", "id": id, "ok": true, "r": .string(String(repeating: "x", count: 200_000))], .bulk)]
    case ("req", "fail"):
      return [(["t": "res", "id": id, "ok": false, "e": ["code": "not_found", "message": "nope", "retryable": false]], .urgent)]
    case ("req", "leave"):
      return [(["t": "bye", "code": "device_revoked"], .urgent)]
    case ("req", "garble"):
      return []
    case ("ping", _):
      return [(["t": "pong", "ts": message["ts"] ?? nil, "now": 42], .urgent)]
    default:
      return []
    }
  }

  func options(timeout: Duration = .seconds(5)) -> ChannelOptions {
    ChannelOptions(env: testEnv, hostKey: key.publicKey, deviceKey: .generate(), hello: testHello, timeout: timeout)
  }

  var messages: [JSONValue] { received.withLock { $0 } }
}

func connect(_ handshake: FakeHost.Handshake = .reply(testWelcome), timeout: Duration = .seconds(5)) async throws
  -> (Channel, ChannelWelcome, FakeHost, MemoryChannelSocket)
{
  let (phone, host) = MemoryChannelSocket.pair()
  let fake = FakeHost(host, handshake: handshake)
  let (channel, welcome) = try await Channel.open(over: phone, options: fake.options(timeout: timeout))
  return (channel, welcome, fake, phone)
}

func handshakeFailure(_ handshake: FakeHost.Handshake, timeout: Duration = .seconds(5)) async -> HandshakeFailure? {
  do {
    _ = try await connect(handshake, timeout: timeout)
    return nil
  } catch {
    return error as? HandshakeFailure
  }
}

struct Echo: Codable, Hashable, Sendable {
  let a: Int
}

@Suite struct ChannelTests {
  @Test func handshakesRequestsEventsAndPings() async throws {
    let (channel, welcome, host, _) = try await connect()
    guard case let .device(device) = welcome else {
      Issue.record("expected a device welcome")
      return
    }
    #expect(device.limits.maxInFlight == 64)
    #expect(await channel.handshakeHash.count == 32)
    var events = channel.events.makeAsyncIterator()

    let echoed: Echo = try await channel.request("echo", Echo(a: 1))
    #expect(echoed == Echo(a: 1))
    guard case let .event(name, frame) = await events.next() else {
      Issue.record("expected an event")
      return
    }
    #expect(name == "echoed")
    #expect(try ChannelEvent.payload(Echo.self, from: frame) == Echo(a: 1))

    let big: String = try await channel.request("big")
    #expect(big.count == 200_000)
    await #expect(throws: ChannelError(code: .notFound, message: "nope", retryable: false)) {
      let _: JSONValue = try await channel.request("fail")
    }
    let ping = try await channel.ping(presence: Presence(visible: true))
    #expect(ping.hostNow == 42)

    // Requests carry ids from 1, without params when there are none.
    let requests = host.messages.filter { $0["t"] == "req" }
    #expect(requests.map { $0["id"] } == [1, 2, 3])
    #expect(requests[1]["p"] == nil)
    #expect(host.messages.last?["presence"] == ["visible": true])
  }

  @Test func reportsCloseAndRefusesLaterRequests() async throws {
    let (channel, _, _, _) = try await connect()
    await #expect(throws: ChannelError.self) {
      let _: JSONValue = try await channel.request("hangUp")
    }
    var closed: ChannelCloseInfo?
    for await event in channel.events {
      if case let .closed(info) = event { closed = info }
    }
    #expect(closed != nil)
    #expect(await channel.isClosed)
    do {
      let _: JSONValue = try await channel.request("echo", Echo(a: 1))
      Issue.record("expected offline")
    } catch let error as ChannelError {
      #expect(error.code == .offline)
    }
  }

  @Test func hostGoodbyeClosesWithItsCode() async throws {
    let (channel, _, _, _) = try await connect()
    await #expect(throws: ChannelError.self) {
      let _: JSONValue = try await channel.request("leave")
    }
    var closed: ChannelCloseInfo?
    for await event in channel.events {
      if case let .closed(info) = event { closed = info }
    }
    #expect(closed?.bye == .deviceRevoked)
    #expect(closed?.code == 1000)
  }

  @Test func sayByeReachesTheHost() async throws {
    let (channel, _, host, _) = try await connect()
    await channel.sayBye(.background)
    #expect(await channel.isClosed)
    try await Task.sleep(for: .milliseconds(50))
    #expect(host.messages.last == ["t": "bye", "code": "background"])
  }

  @Test func requestsTimeOutAndCancel() async throws {
    let (channel, _, host, _) = try await connect()
    do {
      let _: JSONValue = try await channel.request("garble", timeout: .milliseconds(50))
      Issue.record("expected a timeout")
    } catch let error as ChannelError {
      #expect(error.code == .timeout)
      #expect(error.retryable)
    }
    try await Task.sleep(for: .milliseconds(50))
    #expect(host.messages.last == ["t": "cancel", "id": 1])
  }

  @Test func authenticatedErrorsFromMessage2() async throws {
    let failure = await handshakeFailure(.reply(["ok": false, "code": "unknown_device", "message": "Unknown"]))
    #expect(failure == HandshakeFailure(code: .unknownDevice, message: "Unknown", authenticated: true))
  }

  @Test func pairingWelcome() async throws {
    let reply = try JSONValue(
      PairingWelcome(
        env: testEnv, boot: "b", time: 1, host: HostInfo(name: "Test", platform: "darwin", version: "1", fingerprint: "f"),
        pairing: .init(offer: "o", expiresAt: 2)
      )
    )
    let (_, welcome, _, _) = try await connect(.reply(reply))
    guard case let .pairing(pairing) = welcome else {
      Issue.record("expected a pairing welcome")
      return
    }
    #expect(pairing.pairing.offer == "o")
  }

  @Test func unauthenticatedRejectsAndBadReplies() async throws {
    #expect(await handshakeFailure(.reject("device_revoked")) == HandshakeFailure(code: .deviceRevoked, message: "The host rejected the handshake", authenticated: false))
    let garbage = await handshakeFailure(.garbage)
    #expect(garbage?.code == .handshakeFailed)
    #expect(garbage?.authenticated == false)
    let unreadable = await handshakeFailure(.reply(["ok": true]))
    #expect(unreadable?.code == .handshakeFailed)
    #expect(unreadable?.authenticated == true)
  }

  @Test func handshakeTimesOut() async throws {
    let failure = await handshakeFailure(.silent, timeout: .milliseconds(50))
    #expect(failure?.code == .timeout)
  }

  @Test func handshakeFailsWhenTheSocketCloses() async throws {
    let (phone, host) = MemoryChannelSocket.pair()
    let fake = FakeHost(host, handshake: .silent)
    Task {
      try? await Task.sleep(for: .milliseconds(20))
      await host.close(code: 1000, reason: "gone")
    }
    do {
      _ = try await Channel.open(over: phone, options: fake.options())
      Issue.record("expected a failure")
    } catch let failure as HandshakeFailure {
      #expect(failure.code == .handshakeFailed)
    }
  }

  @Test func undecryptableFramesCloseWithAProtocolError() async throws {
    let (channel, _, _, _) = try await connect()
    do {
      let _: JSONValue = try await channel.request("corrupt")
      Issue.record("expected the channel to close")
    } catch let error as ChannelError {
      #expect(error.code == .offline)
      #expect(error.message == "Connection lost")
    }
    var closed: ChannelCloseInfo?
    for await event in channel.events {
      if case let .closed(info) = event { closed = info }
    }
    #expect(closed == ChannelCloseInfo(code: 1002, reason: "protocol_error", bye: nil))
  }
}
