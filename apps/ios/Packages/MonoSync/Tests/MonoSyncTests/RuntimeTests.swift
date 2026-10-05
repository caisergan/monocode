import Foundation
import MonoWire
import Testing

@testable import MonoSync

/// A socket whose host side is a closure: it gets each frame the phone sends
/// and answers through `reply`.
final class ScriptedSocket: FrameSocket, @unchecked Sendable {
  let frames: AsyncThrowingStream<Data, any Error>
  private let continuation: AsyncThrowingStream<Data, any Error>.Continuation
  private let lock = NSLock()
  private var sent: [[String: Any]] = []
  var onFrame: (@Sendable ([String: Any], ScriptedSocket) -> Void)?

  init() {
    (frames, continuation) = AsyncThrowingStream.makeStream()
  }

  func send(_ frame: Data) async throws {
    let object = try JSONSerialization.jsonObject(with: frame) as! [String: Any]
    lock.withLock { sent.append(object) }
    onFrame?(object, self)
  }

  func reply(_ object: [String: Any]) {
    continuation.yield(try! JSONSerialization.data(withJSONObject: object))
  }

  func close(code: Int, reason: String) async {
    continuation.finish()
  }

  var requests: [[String: Any]] { lock.withLock { sent.filter { $0["t"] as? String == "req" } } }
}

struct ScriptedTransport: Transport {
  let socket: ScriptedSocket
  var kind: TransportKind { .demo }
  var key: String { "scripted" }
  func open() async throws -> any FrameSocket { socket }
}

nonisolated(unsafe) let welcomeJSON: [String: Any] = [
  "ok": true, "channel": 1, "env": "e", "boot": "b", "time": 0,
  "host": ["name": "Test", "platform": "darwin", "version": "1", "fingerprint": "f"],
  "device": ["id": "d", "name": "Phone", "role": "member"],
  "capabilities": ["inbox"], "providers": ["claude"], "endpoints": [], "relay": NSNull(), "push": ["enabled": false],
  "limits": ["maxMessage": 1, "maxInFlight": 1, "maxWatchedSessions": 8],
]

@Suite struct RuntimeTests {
  func online() async throws -> (HostRuntime, ScriptedSocket) {
    let socket = ScriptedSocket()
    socket.onFrame = { frame, socket in
      if frame["t"] as? String == "hello" { socket.reply(welcomeJSON); return }
      let id = frame["id"] as! Int
      switch frame["m"] as? String {
      case "projects.list":
        socket.reply(["t": "res", "id": id, "ok": true, "r": [["id": "p", "cwd": "/p", "name": "p"]]])
      case "sessions.block":
        socket.reply(["t": "res", "id": id, "ok": false, "e": ["code": "not_found", "message": "Session not found", "retryable": false]])
      default:
        break  // never answered
      }
    }
    let runtime = HostRuntime(env: "e", label: "Test", transport: ScriptedTransport(socket: socket), hello: Hello(env: "e", app: "t", providers: []))
    await runtime.connect()
    for await event in runtime.events {
      if case let .state(state) = event, state.isOnline { break }
    }
    return (runtime, socket)
  }

  @Test func handshakesAndMatchesResponses() async throws {
    let (runtime, _) = try await online()
    #expect(await runtime.has("inbox"))
    #expect(await !runtime.has("sessions.update"))
    let projects: [HostProject] = try await runtime.request("projects.list", [String: String]())
    #expect(projects == [HostProject(id: "p", cwd: "/p", name: "p")])
  }

  @Test func hostErrorsThrowChannelErrors() async throws {
    let (runtime, _) = try await online()
    await #expect(throws: ChannelError(code: "not_found", message: "Session not found")) {
      let _: Ignored = try await runtime.request("sessions.block", ["sessionId": "x"])
    }
  }

  @Test func requestsTimeOut() async throws {
    let (runtime, _) = try await online()
    await #expect(throws: RuntimeError.timeout("never")) {
      let _: Ignored = try await runtime.request("never", [String: String](), timeout: .milliseconds(100))
    }
  }

  @Test func eventsArriveInOrder() async throws {
    let (runtime, socket) = try await online()
    socket.reply(["t": "evt", "e": "inbox.changed", "d": ["boot": "b", "revision": 2]])
    socket.reply(["t": "evt", "e": "project.sessions", "d": ["projectId": "p"]])
    var names: [String] = []
    for await event in runtime.events {
      if case let .event(name, frame) = event {
        names.append(name)
        if name == "inbox.changed" { #expect(try RuntimeEvent.payload(InboxChangedEvent.self, from: frame).revision == 2) }
        if names.count == 2 { break }
      }
    }
    #expect(names == ["inbox.changed", "project.sessions"])
  }

  @Test func watchSetsCoalesce() async throws {
    let (runtime, socket) = try await online()
    await runtime.setWatch(WatchSet(inbox: true))
    await runtime.setWatch(WatchSet(inbox: true, projects: ["p"]))
    try await Task.sleep(for: .milliseconds(200))
    let watches = socket.requests.filter { $0["m"] as? String == "watch.set" }
    #expect(watches.count == 1)
    #expect((watches.first?["p"] as? [String: Any])?["projects"] as? [String] == ["p"])
  }
}

@MainActor @Suite struct WatchManagerTests {
  @Test func countsInterestAndKeepsTheNewestEightSessions() {
    var sent: [WatchSet] = []
    let manager = WatchManager { set, _ in sent.append(set) }
    let inbox = manager.watchInbox()
    let again = manager.watchInbox()
    inbox.release()
    #expect(sent.last?.inbox == true)
    again.release()
    #expect(sent.last?.inbox == false)
    let project = manager.watchProject("p")
    #expect(sent.last?.projects == ["p"])
    project.release()
    project.release()
    #expect(sent.last?.projects == [])
    let interests = (0..<10).map { (i: Int) in manager.watchSession("s\(i)") { (i, SyncWindow(tailTurns: 20)) } }
    let watched = sent.last?.sessions ?? []
    #expect(watched.count == 8)
    #expect(!watched.contains { $0.id == "s0" || $0.id == "s1" })
    #expect(watched.first { $0.id == "s9" }?.revision == 9, "\(watched.map { ($0.id, $0.revision) })")
    #expect(watched.allSatisfy { $0.maxBlockChars == 20_000 })
    _ = interests
  }

  @Test func readableModelNames() {
    #expect(CatalogStore.readable("claude:opus-4-6") == "Opus 4 6")
  }
}
