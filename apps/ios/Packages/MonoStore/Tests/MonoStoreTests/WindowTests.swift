import Foundation
import GRDB
import Testing

@testable import MonoStore

@Suite struct WindowTests {
  @Test func windowRoundTrip() async throws {
    let cache = try makeCache()
    let entry = window("s1", bytes: 1_000)
    let result = try await cache.saveWindow(env: "h1", id: "s1", entry)
    #expect(result == WindowSaveResult(stored: true, evicted: []))
    #expect(try await cache.loadWindow(env: "h1", id: "s1") == entry)
    #expect(try await cache.loadWindow(env: "h1", id: "s2") == nil)

    let stored = try await cache.pool.read { db -> (revision: Int, anchor: String?, bytes: Int)? in
      try Row.fetchOne(db, sql: "SELECT revision, anchor, bytes FROM session_windows")
        .map { ($0["revision"], $0["anchor"], $0["bytes"]) }
    }
    #expect(stored?.revision == 7)
    #expect(stored?.anchor == "b1")
    #expect(try await cache.windowBytes() == stored?.bytes)

    try await cache.deleteWindow(env: "h1", id: "s1")
    #expect(try await cache.windowBytes() == 0)
  }

  @Test func evictsOldestOpenedFirst() async throws {
    let clock = TestClock()
    let cache = try makeCache(limits: CacheLimits(windowBudget: 3_500, windowMax: 2_000), clock: clock)
    for id in ["s1", "s2", "s3"] {
      _ = try await cache.saveWindow(env: "h1", id: id, window(id, bytes: 1_000))
      clock.advance(1)
    }
    // Opening s1 makes s2 the oldest.
    _ = try await cache.loadWindow(env: "h1", id: "s1")
    clock.advance(1)

    let result = try await cache.saveWindow(env: "h1", id: "s4", window("s4", bytes: 1_000))
    #expect(result.stored)
    #expect(result.evicted == [WindowKey(env: "h1", id: "s2")])
    #expect(try await cache.windowBytes() <= 3_500)
    #expect(try await cache.loadWindow(env: "h1", id: "s1") != nil)
    #expect(try await cache.loadWindow(env: "h1", id: "s2") == nil)
  }

  @Test func neverEvictsAWindowWithOutboxEntries() async throws {
    let clock = TestClock()
    let cache = try makeCache(limits: CacheLimits(windowBudget: 2_500, windowMax: 2_000), clock: clock)
    for id in ["s1", "s2"] {
      _ = try await cache.saveWindow(env: "h1", id: id, window(id, bytes: 1_000))
      clock.advance(1)
    }
    // s1 is the oldest but has a command queued; the same session id on
    // another host doesn't count.
    try await cache.saveOutboxRow(outboxRow("c1", sessionKey: "s1"))
    try await cache.saveOutboxRow(outboxRow("c2", env: "h2", sessionKey: "s2"))

    let result = try await cache.saveWindow(env: "h1", id: "s3", window("s3", bytes: 1_000))
    #expect(result.evicted == [WindowKey(env: "h1", id: "s2")])
    #expect(try await cache.loadWindow(env: "h1", id: "s1") != nil)
  }

  @Test func keepsTheWindowJustWrittenEvenOverBudget() async throws {
    let clock = TestClock()
    let cache = try makeCache(limits: CacheLimits(windowBudget: 1_500, windowMax: 2_000), clock: clock)
    _ = try await cache.saveWindow(env: "h1", id: "s1", window("s1", bytes: 1_000))
    try await cache.saveOutboxRow(outboxRow("c1", sessionKey: "s1"))
    clock.advance(1)

    // Everything else is pinned, so the total stays over budget.
    let result = try await cache.saveWindow(env: "h1", id: "s2", window("s2", bytes: 1_000))
    #expect(result == WindowSaveResult(stored: true, evicted: []))
    #expect(try await cache.windowBytes() > 1_500)

    // Once the command is gone, a later pass evicts the oldest.
    try await cache.deleteOutboxRow(commandId: "c1")
    #expect(try await cache.evictWindows() == [WindowKey(env: "h1", id: "s1")])
  }

  @Test func aWindowOverTheCapIsNotStored() async throws {
    let cache = try makeCache(limits: CacheLimits(windowBudget: 10_000, windowMax: 2_000))
    _ = try await cache.saveWindow(env: "h1", id: "s1", window("s1", bytes: 1_000))

    // It grew past the cap: the stale stored copy goes too.
    let result = try await cache.saveWindow(env: "h1", id: "s1", window("s1", bytes: 3_000))
    #expect(result == WindowSaveResult(stored: false, evicted: []))
    #expect(try await cache.loadWindow(env: "h1", id: "s1") == nil)
    #expect(try await cache.windowBytes() == 0)
  }

  @Test func theDefaultCapsAre64And4MiB() async throws {
    let limits = CacheLimits()
    #expect(limits.windowBudget == 64 * 1024 * 1024)
    #expect(limits.windowMax == 4 * 1024 * 1024)

    let cache = try makeCache()
    let over = try await cache.saveWindow(env: "h1", id: "big", window("big", bytes: 4 * 1024 * 1024 + 1_000))
    #expect(!over.stored)
    let under = try await cache.saveWindow(env: "h1", id: "ok", window("ok", bytes: 4 * 1024 * 1024 - 1_000))
    #expect(under.stored)
  }
}
