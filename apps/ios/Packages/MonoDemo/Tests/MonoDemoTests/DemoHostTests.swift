import Foundation
import MonoSync
import MonoWire
import Testing

@testable import MonoDemo

func fixture(_ name: String) throws -> Any {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try JSONSerialization.jsonObject(with: Data(contentsOf: url), options: [.fragmentsAllowed])
}

/// The first place two JSON trees differ, or nil when they are equal.
func jsonDifference(_ a: Any, _ b: Any, path: String = "$") -> String? {
  switch (a, b) {
  case let (x as [String: Any], y as [String: Any]):
    for key in Set(x.keys).union(y.keys).sorted() {
      guard let left = x[key] else { return "\(path).\(key): missing in the first" }
      guard let right = y[key] else { return "\(path).\(key): missing in the second" }
      if let difference = jsonDifference(left, right, path: "\(path).\(key)") { return difference }
    }
    return nil
  case let (x as [Any], y as [Any]):
    if x.count != y.count { return "\(path): \(x.count) items against \(y.count)" }
    for (i, (left, right)) in zip(x, y).enumerated() {
      if let difference = jsonDifference(left, right, path: "\(path)[\(i)]") { return difference }
    }
    return nil
  case (is NSNull, is NSNull):
    return nil
  case let (x as NSNumber, y as NSNumber):
    return x == y ? nil : "\(path): \(x) against \(y)"
  case let (x as String, y as String):
    return x == y ? nil : "\(path): \(x.debugDescription.prefix(80)) against \(y.debugDescription.prefix(80))"
  default:
    return "\(path): \(a) against \(b)"
  }
}

/// The Swift demo answers the read methods exactly as the TypeScript demo
/// does on the same initial state (16 §16.5).
@Suite struct DemoHostTests {
  @Test func readMethodsMatchTheTypeScriptDemo() async throws {
    let root = try #require(try fixture("demo-responses") as? [String: Any])
    let now = try #require(root["now"] as? Int)
    let calls = try #require(root["calls"] as? [[String: Any]])
    let host = try DemoHost(now: Date(timeIntervalSince1970: Double(now) / 1000), clock: { now })
    #expect(calls.count == 24)
    for call in calls {
      let method = call["method"] as! String
      let params = try JSONSerialization.data(withJSONObject: call["params"]!)
      let answer = try await host.call(method, params)
      let result = try JSONSerialization.jsonObject(with: answer, options: [.fragmentsAllowed])
      let difference = jsonDifference(call["result"]!, result)
      #expect(difference == nil, "\(method) \(String(data: params, encoding: .utf8)!): \(difference ?? "")")
    }
  }

  @Test func unknownMethodsAreRefused() async throws {
    let host = try DemoHost()
    await #expect(throws: DemoError.self) { try await host.call("sessions.update", Data("{}".utf8)) }
  }

  @Test func historyMovesToNow() async throws {
    let host = try DemoHost(now: Date(timeIntervalSince1970: 2_000_000_000))
    let auth = try #require(await host.value("s-auth"))
    // Four minutes before "now", as in the fixture.
    #expect(auth.updatedAt == 2_000_000_000_000 - 4 * 60_000)
  }
}

/// The whole read path on the demo: runtime, watch, syncs and stores.
@MainActor @Suite(.serialized) struct DemoSyncTests {
  func until(_ what: String, timeout: Duration = .seconds(10), _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + timeout
    while !condition() {
      if ContinuousClock.now > deadline {
        Issue.record("timed out waiting for \(what)")
        return
      }
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  @Test func listsAndWindowsFillTheStores() async throws {
    let engine = SyncEngine()
    let host = try DemoHost()
    engine.add(.demo, transport: DemoTransport(host: host))
    let inbox = engine.watchInbox()
    defer { inbox.release() }
    try await until("the inbox") { engine.inbox.items.count == 3 }
    #expect(engine.hosts.states[DemoHost.env]?.isOnline == true)
    #expect(engine.hosts.has(DemoHost.env, "sessions.page"))
    #expect(!engine.hosts.has(DemoHost.env, "sessions.update"))
    try await until("the projects") { engine.projects.hosts[DemoHost.env]?.projects.count == 2 }
    try await until("the models") { engine.catalogs.modelName(DemoHost.env, "claude:opus-4-6") == "Claude Opus 4.6" }

    let sync = try #require(engine.host(DemoHost.env))
    let list = sync.openList("p-app", archived: .exclude)
    defer { list.release() }
    let key = ProjectsStore.ListKey(env: DemoHost.env, projectId: "p-app", archived: .exclude)
    try await until("the first page") { engine.projects.lists[key]?.list?.items.count == 50 }
    await sync.loadMoreSessions(key)
    #expect(engine.projects.lists[key]?.list?.items.count == 58)
    #expect(engine.projects.lists[key]?.list?.complete == true)

    let (store, interest) = sync.openSession("s-perf")
    defer { interest.release() }
    try await until("the window") { store.value != nil }
    #expect(store.freshness == .live)
    #expect(store.window?.olderTurns == 20)
    #expect(store.value?.session.blocks.first?.id == "u20")
    await sync.loadOlder(store)
    #expect(store.value?.session.blocks.first?.id == "u0")
    #expect(store.hasOlder == false)
  }

  @Test func liveTurnsStreamIntoTheWindowAndTheInbox() async throws {
    let engine = SyncEngine()
    let host = try DemoHost(speed: 20)
    engine.add(.demo, transport: DemoTransport(host: host))
    let inbox = engine.watchInbox()
    defer { inbox.release() }
    let sync = try #require(engine.host(DemoHost.env))
    let (store, interest) = sync.openSession("s-perf")
    defer { interest.release() }
    try await until("the window") { store.value != nil }
    await host.startLiveTurns()
    try await until("a running session in the inbox") { engine.inbox.working == 1 }
    try await until("the approval in the inbox") { engine.inbox.needsInput == 1 }
    #expect(engine.inbox.items.first?.item.sessionId == "s-api")
    try await until("the streamed answer", timeout: .seconds(30)) {
      store.value?.session.blocks.last?.id == "run-1-a" && store.value?.session.blocks.last?.isStreaming == false
        && store.value?.status == .idle
    }
    await host.stopLiveTurns()
    // Streaming equals final: the phone's window holds the host's blocks.
    try await Task.sleep(for: .milliseconds(200))
    let final = try #require(await host.value("s-perf"))
    let start = SessionWindow.start(final.session.blocks, SyncWindow(anchor: store.window?.anchor)).start
    #expect(store.value?.session.blocks == Array(final.session.blocks[start...]))
    #expect(store.value?.revision == final.revision)
  }

  @Test func anUnreachableDemoShowsTheOfflineNotice() async throws {
    let engine = SyncEngine()
    engine.add(.demo, transport: DemoTransport(host: try DemoHost(), unreachable: true))
    try await until("offline") {
      if case .offline? = engine.hosts.states[DemoHost.env] { return true }
      return false
    }
    #expect(engine.hosts.notice(DemoHost.env) == "Demo is offline.")
  }
}
