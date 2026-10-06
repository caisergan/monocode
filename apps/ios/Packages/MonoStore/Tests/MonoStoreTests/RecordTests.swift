import Foundation
import GRDB
import MonoWire
import Testing

@testable import MonoStore

@Suite struct RecordTests {
  @Test func hostsRoundTripInPairingOrder() async throws {
    let cache = try makeCache()
    let record = hostRecord("h2")
    try await cache.saveHost(record)
    try await cache.saveHost(hostRecord("h1"))
    #expect(try await cache.loadHost(env: "h2") == record)
    #expect(try await cache.loadHost(env: "nope") == nil)

    var renamed = record
    renamed.label = "Renamed"
    try await cache.saveHost(renamed)
    #expect(try await cache.loadHosts().map(\.label) == ["Renamed", "Studio"])
  }

  @Test func hostRecordStoresMillisecondDates() async throws {
    let cache = try makeCache()
    try await cache.saveHost(hostRecord("h1"))
    let json = try await cache.pool.read { try String.fetchOne($0, sql: "SELECT record FROM hosts") }
    #expect(json?.contains(#""pairedAt":1800000000123"#) == true)
    #expect(json?.contains(#""role":"admin""#) == true)
  }

  @Test func projectsReplaceAndKeepOrder() async throws {
    let cache = try makeCache()
    let projects = [HostProject(id: "b", cwd: "/b", name: "B"), HostProject(id: "a", cwd: "/a", name: "A")]
    try await cache.saveProjects(env: "h1", projects)
    try await cache.saveProjects(env: "h2", [HostProject(id: "z", cwd: "/z", name: "Z")])
    #expect(try await cache.loadProjects(env: "h1") == projects)

    try await cache.saveProjects(env: "h1", [projects[1]])
    #expect(try await cache.loadProjects(env: "h1") == [projects[1]])
    #expect(try await cache.loadProjects(env: "h2").map(\.id) == ["z"])
  }

  @Test func sessionItemsRoundTripNewestFirst() async throws {
    let cache = try makeCache()
    let old = try sessionItem("s1", updatedAt: 100)
    let new = try sessionItem("s2", updatedAt: 200)
    let other = try sessionItem("s3", projectId: "p2", updatedAt: 300)
    try await cache.saveSessionItems(env: "h1", projectId: "p1", [old, new])
    try await cache.saveSessionItems(env: "h1", projectId: "p2", [other])
    #expect(try await cache.loadSessionItems(env: "h1", projectId: "p1") == [new, old])

    var updated = old
    updated.updatedAt = 400
    updated.title = "Renamed"
    try await cache.saveSessionItems(env: "h1", projectId: "p1", [updated])
    #expect(try await cache.loadSessionItems(env: "h1", projectId: "p1") == [updated, new])

    try await cache.deleteSessionItems(env: "h1", ids: ["s1", "s3"])
    #expect(try await cache.loadSessionItems(env: "h1", projectId: "p1") == [new])
    #expect(try await cache.loadSessionItems(env: "h1", projectId: "p2").isEmpty)
  }

  @Test func inboxRoundTrip() async throws {
    let clock = TestClock()
    let cache = try makeCache(clock: clock)
    let inbox = try decode(
      InboxList.self,
      """
      {"boot":"boot-1","revision":12,"truncated":false,"items":[
        {"sessionId":"s1","projectId":"p1","projectName":"repo","title":"Fix","harness":"claude","status":"running",
         "attention":"approval","needsInput":true,"updatedAt":1800000000000,"revision":4,
         "approval":{"requestId":3,"title":"Run tests"}}]}
      """)
    try await cache.saveInbox(env: "h1", inbox)
    let cached = try #require(try await cache.loadInbox(env: "h1"))
    #expect(cached.inbox == inbox)
    #expect(cached.fetchedAt == clock.now)
    #expect(try await cache.loadInbox(env: "h2") == nil)
  }

  @Test func seenRoundTripAndTrim() async throws {
    let clock = TestClock()
    let cache = try makeCache(limits: CacheLimits(seenLimit: 3), clock: clock)
    for id in ["s1", "s2", "s3", "s4"] {
      try await cache.markSeen(env: "h1", sessionId: id)
      clock.advance(1)
    }
    try await cache.markSeen(env: "h2", sessionId: "s1", at: Date(timeIntervalSince1970: 1))
    let seen = try await cache.loadSeen(env: "h1")
    #expect(Set(seen.keys) == ["s2", "s3", "s4"])
    #expect(seen["s4"] == Date(timeIntervalSince1970: 1_800_000_003))
    // The oldest entry overall went, wherever it was.
    #expect(try await cache.loadSeen(env: "h2").isEmpty)
  }

  @Test func catalogsRoundTrip() async throws {
    let clock = TestClock()
    let cache = try makeCache(clock: clock)
    let catalog = try decode(
      ModelCatalog.self,
      #"{"models":{"claude":[{"id":"opus","harness":"claude","name":"Opus"}]},"errors":{"codex":"not installed"}}"#)
    try await cache.saveCatalog(env: "h1", projectId: "p1", catalog)
    let cached = try #require(try await cache.loadCatalog(env: "h1", projectId: "p1"))
    #expect(cached.catalog == catalog)
    #expect(cached.fetchedAt == clock.now)
    #expect(try await cache.loadCatalog(env: "h1", projectId: "p2") == nil)
  }

  @Test func candidatesRoundTrip() async throws {
    let cache = try makeCache()
    let endpoint = HostEndpoint(kind: .tailscale, addr: "100.64.0.2", port: 3775, dns: "studio.ts.net")
    #expect(endpoint.candidateKey == "tailscale|100.64.0.2|3775")
    let stats = CandidateStats(
      lastSuccessAt: Date(timeIntervalSince1970: 1_800_000_000.5), lastFailureAt: nil, consecutiveFailures: 0, rttMs: 42.5)
    let failing = CandidateStats(lastFailureAt: Date(timeIntervalSince1970: 1_800_000_001), consecutiveFailures: 3)
    try await cache.saveCandidate(env: "h1", key: endpoint.candidateKey, stats)
    try await cache.saveCandidate(env: "h1", key: "lan|192.168.1.4|3775", failing)
    #expect(try await cache.loadCandidates(env: "h1") == [endpoint.candidateKey: stats, "lan|192.168.1.4|3775": failing])

    try await cache.deleteCandidates(env: "h1", keys: ["lan|192.168.1.4|3775"])
    #expect(try await cache.loadCandidates(env: "h1").keys.sorted() == [endpoint.candidateKey])
  }

  @Test func draftsRoundTrip() async throws {
    struct Draft: Codable, Equatable, Sendable {
      var text: String
      var attachments: [String]
    }
    let cache = try makeCache()
    let draft = Draft(text: "Refactor the parser", attachments: ["a.png"])
    try await cache.saveDraft(draft, env: "h1", key: "s1")
    try await cache.saveDraft(Draft(text: "New one", attachments: []), env: "h1", key: "new:p1")
    #expect(try await cache.loadDraft(Draft.self, env: "h1", key: "s1") == draft)
    #expect(try await cache.loadDraft(Draft.self, env: "h1", key: "new:p1")?.text == "New one")

    try await cache.deleteDraft(env: "h1", key: "s1")
    #expect(try await cache.loadDraft(Draft.self, env: "h1", key: "s1") == nil)
  }

  @Test func outboxRowsRoundTripInCreationOrder() async throws {
    let cache = try makeCache()
    var later = outboxRow("c2", sessionKey: nil)
    later.createdAt = later.createdAt.addingTimeInterval(5)
    let first = outboxRow("c1", sessionKey: "s1")
    try await cache.saveOutboxRow(later)
    try await cache.saveOutboxRow(first)
    try await cache.saveOutboxRow(outboxRow("c3", env: "h2", sessionKey: "s9"))
    #expect(try await cache.loadOutboxRows(env: "h1") == [first, later])
    #expect(try await cache.loadOutboxRows().count == 3)

    try await cache.deleteOutboxRow(commandId: "c1")
    #expect(try await cache.loadOutboxRows(env: "h1") == [later])
  }

  @Test func purgeHostForgetsEveryTable() async throws {
    let cache = try makeCache()
    try await fillEveryTable(cache)
    try await cache.saveHost(hostRecord("h2"))
    try await cache.purgeHost(env: "h1")
    for table in Schema.tables {
      let count = try await cache.pool.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM \(table) WHERE env = 'h1'") }
      #expect(count == 0, "\(table)")
    }
    #expect(try await cache.loadHosts().map(\.env) == ["h2"])

    try await cache.purgeHosts(except: [])
    #expect(try await cache.loadHosts().isEmpty)
  }
}
