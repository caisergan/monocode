import Foundation
import MonoWire
import Testing

@testable import MonoSync

/// apps/mobile/src/sync/__tests__/paging.test.ts, case by case.
@Suite struct PagingTests {
  func item(_ id: String, _ updatedAt: Int, pinned: Bool? = nil, archived: Bool? = nil, title: String? = nil, branch: String? = nil) -> SessionListItem {
    var json: [String: Any] = ["id": id, "title": title ?? "Session \(id)", "harness": "claude", "projectId": "p1", "revision": 1, "status": "idle", "updatedAt": updatedAt]
    if let pinned { json["pinned"] = pinned }
    if let archived { json["archived"] = archived }
    if let branch { json["branch"] = branch }
    return try! JSONDecoder().decode(SessionListItem.self, from: JSONSerialization.data(withJSONObject: json))
  }

  func ids(_ list: SessionList) -> [String] { list.items.map(\.id) }

  @Test func ordersLikeTheHost() {
    let items = [item("b", 5), item("a", 5), item("c", 9), item("p", 1, pinned: true)]
    #expect(items.sorted(by: Paging.order).map(\.id) == ["p", "c", "a", "b"])
  }

  @Test func paintsCachedSummariesButCannotPageFromThem() {
    let items = [item("a", 1), item("b", 3, archived: true), item("c", 2)]
    let live = Paging.cachedList(items, archived: .exclude)
    #expect(ids(live) == ["c", "a"])
    #expect(ids(Paging.cachedList(items, archived: .only)) == ["b"])
    #expect(!Paging.canLoadMore(live))
  }

  @Test func firstPageReplacesACachedList() {
    let cached = Paging.cachedList([item("a", 9), item("gone", 8), item("old-tail", 1)], archived: .exclude)
    let (list, removed) = Paging.mergeFirstPage(cached, SessionPage(items: [item("a", 10), item("b", 7)], cursor: "k1"))
    #expect(ids(list) == ["a", "b"])
    #expect(list.cursor == "k1" && !list.complete && !list.cached)
    #expect(removed.sorted() == ["gone", "old-tail"])
    #expect(Paging.canLoadMore(list))
  }

  @Test func appendsNextPagesDeduplicating() {
    let first = Paging.mergeFirstPage(nil, SessionPage(items: [item("a", 10), item("b", 9)], cursor: "k1")).list
    let second = Paging.mergeNextPage(first, SessionPage(items: [item("b", 9), item("c", 8)], cursor: "k2"))
    #expect(ids(second) == ["a", "b", "c"])
    #expect(second.cursor == "k2")
    let third = Paging.mergeNextPage(second, SessionPage(items: [item("d", 2)]))
    #expect(third.complete && third.cursor == nil)
    #expect(!Paging.canLoadMore(third))
  }

  @Test func refreshedFirstPageKeepsLaterPages() {
    var list = Paging.mergeFirstPage(nil, SessionPage(items: [item("a", 10), item("b", 9)], cursor: "k1")).list
    list = Paging.mergeNextPage(list, SessionPage(items: [item("c", 8), item("d", 7)], cursor: "k2"))
    let (next, removed) = Paging.mergeFirstPage(list, SessionPage(items: [item("d", 20), item("b", 9)], cursor: "k3"))
    #expect(ids(next) == ["d", "b", "c"])
    #expect(next.items[0].updatedAt == 20)
    #expect(next.cursor == "k2")
    #expect(removed == ["a"])
  }

  @Test func keepsOldItemsPastTheRefreshedRange() {
    var list = Paging.mergeFirstPage(nil, SessionPage(items: [item("a", 10), item("b", 9)], cursor: "k1")).list
    list = Paging.mergeNextPage(list, SessionPage(items: [item("c", 8)], cursor: "k2"))
    let (next, removed) = Paging.mergeFirstPage(list, SessionPage(items: [item("new", 30), item("a", 10)], cursor: "k3"))
    #expect(ids(next) == ["new", "a", "b", "c"])
    #expect(removed.isEmpty)
  }

  @Test func completeFirstPageDropsEverythingElse() {
    var list = Paging.mergeFirstPage(nil, SessionPage(items: [item("a", 10)], cursor: "k1")).list
    list = Paging.mergeNextPage(list, SessionPage(items: [item("b", 5)]))
    let (next, removed) = Paging.mergeFirstPage(list, SessionPage(items: [item("a", 11)]))
    #expect(ids(next) == ["a"])
    #expect(next.complete)
    #expect(removed == ["b"])
  }

  @Test func newlyPinnedSessionMovesIntoThePinnedGroup() {
    let list = Paging.mergeFirstPage(nil, SessionPage(items: [item("a", 10), item("b", 9)])).list
    let (next, _) = Paging.mergeFirstPage(list, SessionPage(items: [item("b", 9, pinned: true), item("a", 10)]))
    let visible = Paging.visibleSessions(next, query: "")
    #expect(visible.pinned == [next.items[0]])
    #expect(visible.rest == [next.items[1]])
    #expect(next.items[0].id == "b")
  }

  @Test func removesADeletedSessionAndFiltersBySearch() {
    let list = Paging.mergeFirstPage(nil, SessionPage(items: [item("a", 10, title: "Fix flaky auth test"), item("b", 9, branch: "feat/auth"), item("c", 8)])).list
    #expect(ids(Paging.removeSession(list, "b")) == ["a", "c"])
    #expect(Paging.removeSession(list, "zzz") == list)
    #expect(Paging.visibleSessions(list, query: "AUTH").rest.map(\.id) == ["a", "b"])
    let empty = Paging.visibleSessions(nil, query: "")
    #expect(empty.pinned.isEmpty && empty.rest.isEmpty)
  }

  @Test func mergesAnOlderPage() throws {
    func block(_ id: String, _ role: BlockRole = .user) -> Block { Block(id: id, role: role, text: id) }
    var session = HostSession(
      session: Session(id: "s", harness: "claude", model: "m", runtimeMode: .supervised, title: "t", cwd: "/", blocks: [block("u2"), block("a2", .assistant)]),
      projectId: "p", revision: 3, status: .idle, updatedAt: 1)
    let page = OlderBlocks(blocks: [block("u1"), block("a1", .assistant)], hasOlder: true, olderTurns: 1, revision: 3)
    let merged = try #require(Paging.mergeOlder(session, window: WindowMeta(anchor: "u2", olderTurns: 2, olderBlocks: 4), before: "u2", page: page))
    #expect(merged.value.session.blocks.map(\.id) == ["u1", "a1", "u2", "a2"])
    #expect(merged.window == WindowMeta(anchor: "u1", olderTurns: 1, olderBlocks: 2))
    session.session.blocks.removeFirst()
    #expect(Paging.mergeOlder(session, window: nil, before: "u2", page: page) == nil)
  }
}
