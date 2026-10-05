import Foundation
import MonoWire

// Session lists paged with `sessions.page` (06 §6.5, 11 §11.14), from
// apps/mobile/src/sync/paging.ts and older.ts. Pure, so the merge rules are
// unit-tested.

public struct SessionList: Equatable, Sendable {
  /// In the host's page order.
  public var items: [SessionListItem]
  /// Where the next page starts; nil when complete or unknown.
  public var cursor: String?
  public var complete: Bool
  /// Painted from the cache; no page fetched since the list opened.
  public var cached: Bool

  public init(items: [SessionListItem], cursor: String? = nil, complete: Bool, cached: Bool) {
    self.items = items
    self.cursor = cursor
    self.complete = complete
    self.cached = cached
  }
}

public enum Paging {
  /// The host's page order: pinned first, then newest, then id.
  public static func order(_ a: SessionListItem, _ b: SessionListItem) -> Bool {
    let ap = a.pinned == true ? 1 : 0
    let bp = b.pinned == true ? 1 : 0
    if ap != bp { return ap > bp }
    if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
    return a.id < b.id
  }

  public static func matches(_ item: SessionListItem, archived: ArchivedFilter) -> Bool {
    switch archived {
    case .only: item.archived == true
    case .exclude: item.archived != true
    case .include: true
    }
  }

  static func ordered(_ items: some Sequence<SessionListItem>) -> [SessionListItem] {
    items.sorted(by: order)
  }

  /// A list painted from cached summaries. It can't page until the first page is fetched.
  public static func cachedList(_ items: [SessionListItem], archived: ArchivedFilter) -> SessionList {
    SessionList(items: ordered(items.filter { matches($0, archived: archived) }), complete: false, cached: true)
  }

  /// Applies a refetched first page. The page is the truth for the range it
  /// covers; pages loaded beyond it, and their cursor, are kept (cursors are
  /// sort keys, not offsets). `removed` lists ids to drop from the cache.
  public static func mergeFirstPage(_ list: SessionList?, _ page: SessionPage) -> (list: SessionList, removed: [String]) {
    var fresh: [String: SessionListItem] = [:]
    for item in page.items { fresh[item.id] = item }
    let items = ordered(fresh.values)
    let old = list?.items ?? []
    var tail: [SessionListItem] = []
    if let list, !list.cached, page.cursor != nil, let last = items.last {
      tail = old.filter { fresh[$0.id] == nil && order(last, $0) }
    }
    let kept = Set(tail.map(\.id))
    let removed = old.filter { fresh[$0.id] == nil && !kept.contains($0.id) }.map(\.id)
    if !tail.isEmpty, let list {
      return (SessionList(items: items + tail, cursor: list.cursor, complete: list.complete, cached: false), removed)
    }
    return (SessionList(items: items, cursor: page.cursor, complete: page.cursor == nil, cached: false), removed)
  }

  /// Appends the page after `list.cursor`. Fresh copies replace old ones.
  public static func mergeNextPage(_ list: SessionList, _ page: SessionPage) -> SessionList {
    var byId: [String: SessionListItem] = [:]
    for item in list.items { byId[item.id] = item }
    for item in page.items { byId[item.id] = item }
    return SessionList(items: ordered(byId.values), cursor: page.cursor, complete: page.cursor == nil, cached: false)
  }

  public static func canLoadMore(_ list: SessionList?) -> Bool {
    guard let list else { return false }
    return !list.cached && !list.complete && list.cursor != nil
  }

  public static func removeSession(_ list: SessionList, _ id: String) -> SessionList {
    guard list.items.contains(where: { $0.id == id }) else { return list }
    var next = list
    next.items.removeAll { $0.id == id }
    return next
  }

  /// What the list shows: the search applied, pinned sessions first.
  public static func visibleSessions(_ list: SessionList?, query: String) -> (pinned: [SessionListItem], rest: [SessionListItem]) {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let items = (list?.items ?? []).filter { item in
      needle.isEmpty || item.title.lowercased().contains(needle) || (item.branch?.lowercased().contains(needle) ?? false)
        || (item.lastText?.lowercased().contains(needle) ?? false)
    }
    return (items.filter { $0.pinned == true }, items.filter { $0.pinned != true })
  }

  /// Prepends an older page (06 §6.7). `before` is the block the request was
  /// made against; if the window no longer starts there the page is stale
  /// and the result is nil.
  public static func mergeOlder(_ value: HostSession, window: WindowMeta?, before: String, page: OlderBlocks) -> (
    value: HostSession, window: WindowMeta
  )? {
    let blocks = value.session.blocks
    guard blocks.first?.id == before else { return nil }
    let known = Set(blocks.map(\.id))
    let older = page.blocks.filter { !known.contains($0.id) }
    let merged = older.isEmpty ? blocks : older + blocks
    let olderTurns = max(0, page.olderTurns)
    let meta = WindowMeta(
      anchor: merged.first?.id, olderTurns: olderTurns,
      olderBlocks: olderTurns == 0 ? 0 : max(0, (window?.olderBlocks ?? older.count) - older.count))
    var next = value
    if !older.isEmpty { next.session.blocks = merged }
    return (next, meta)
  }
}
