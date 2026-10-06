import Foundation
import MonoWire

/// The read-path sync for one host (12 §12.7): it consumes the runtime's
/// events, fetches the inbox, projects, session pages and windows, and writes
/// the stores. Session syncs decode and apply off the main actor.
@MainActor
public final class HostSync {
  public static let pageSize = 50
  public static let tailTurns = 20
  public static let olderTurns = 20

  public let record: HostRecord
  public let runtime: HostRuntime
  public let watch: WatchManager
  private unowned let engine: SyncEngine
  private var events: Task<Void, Never>?
  private var inboxLoading = false
  private var inboxAgain = false
  private var projectsLoading = false
  private var refreshing: Set<ProjectsStore.ListKey> = []
  private var refreshAgain: Set<ProjectsStore.ListKey> = []
  private var openLists: [ProjectsStore.ListKey: Int] = [:]
  private var windows: [String: (store: SessionStore, count: Int)] = [:]

  init(record: HostRecord, transport: any Transport, hello: Hello, engine: SyncEngine) {
    self.record = record
    self.engine = engine
    let runtime = HostRuntime(env: record.env, label: record.label, transport: transport, hello: hello)
    self.runtime = runtime
    watch = WatchManager { set, immediately in
      Task { await runtime.setWatch(set, immediately: immediately) }
    }
    events = Task.detached { [weak self, runtime] in
      for await event in runtime.events {
        await self?.handle(event)
      }
    }
  }

  var env: String { record.env }

  func start() {
    Task { await runtime.connect() }
  }

  func stop() {
    events?.cancel()
    Task { await runtime.shutdown() }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /// Runs on the consuming task, in order. Session syncs stay off main until
  /// they are applied.
  private nonisolated func handle(_ event: RuntimeEvent) async {
    if case let .event("session.sync", frame) = event {
      guard let payload = try? RuntimeEvent.payload(SessionSyncEvent.self, from: frame) else { return }
      guard let store = await window(payload.sessionId) else { return }
      switch await store.pipeline.apply(payload.sync) {
      case let .applied(value, window):
        await store.publish(value, window)
      case let .mismatch(anchor):
        await resync(store, anchor: anchor)
      case .ignored:
        break
      }
      return
    }
    await handleOnMain(event)
  }

  private func window(_ sessionId: String) -> SessionStore? {
    windows[sessionId]?.store
  }

  private func handleOnMain(_ event: RuntimeEvent) {
    switch event {
    case let .state(state):
      engine.hosts.states[env] = state
      if state.isOnline {
        engine.hosts.lastOnline[env] = Date()
        watch.refresh()
        if watch.watchesInbox { refreshInbox() }
        loadProjects()
        loadModels()
        for key in openLists.keys { refreshSessions(key) }
      } else {
        for (_, entry) in windows { entry.store.freshness = .cached }
      }
    case let .welcome(welcome):
      engine.hosts.welcomes[env] = welcome
    case let .event(name, frame):
      switch name {
      case "inbox.changed":
        refreshInbox()
      case "projects.changed":
        loadProjects()
      case "project.sessions":
        guard let event = try? RuntimeEvent.payload(ProjectSessionsEvent.self, from: frame) else { return }
        for key in openLists.keys where key.projectId == event.projectId { refreshSessions(key) }
      default:
        break
      }
    }
  }

  // ── Inbox ─────────────────────────────────────────────────────────────────

  /// `inbox.list`; overlapping calls coalesce into one more run.
  public func refreshInbox() {
    if inboxLoading {
      inboxAgain = true
      return
    }
    inboxLoading = true
    Task {
      repeat {
        inboxAgain = false
        if let inbox: InboxList = try? await runtime.request("inbox.list", ["limit": 200]) {
          engine.inbox.hosts[env] = InboxStore.HostInbox(boot: inbox.boot, revision: inbox.revision, items: inbox.items, fetchedAt: Date())
        }
      } while inboxAgain
      inboxLoading = false
    }
  }

  public func watchInbox() -> Interest {
    let interest = watch.watchInbox()
    refreshInbox()
    Task { await runtime.connect() }
    return interest
  }

  // ── Projects and session lists ────────────────────────────────────────────

  public func loadProjects() {
    guard !projectsLoading else { return }
    projectsLoading = true
    engine.projects.patchHost(env) { $0.loading = true }
    Task {
      defer { projectsLoading = false }
      do {
        let projects: [HostProject] = try await runtime.request("projects.list", [String: String]())
        engine.projects.patchHost(env) {
          $0.projects = projects
          $0.freshness = .live
          $0.loading = false
          $0.error = nil
        }
      } catch {
        engine.projects.patchHost(env) {
          $0.loading = false
          $0.error = error.localizedDescription
        }
      }
    }
  }

  func loadModels() {
    Task {
      if let catalog: ModelCatalog = try? await runtime.request("models.list", [String: String]()) {
        engine.catalogs.catalogs[env] = catalog
      }
    }
  }

  /// Opens a project's session list: the first page now, live while open.
  public func openList(_ projectId: String, archived: ArchivedFilter) -> Interest {
    let key = ProjectsStore.ListKey(env: env, projectId: projectId, archived: archived)
    openLists[key, default: 0] += 1
    let watching = watch.watchProject(projectId)
    refreshSessions(key)
    return Interest { [weak self] in
      watching.release()
      guard let self else { return }
      self.openLists[key, default: 1] -= 1
      if self.openLists[key] ?? 0 <= 0 { self.openLists[key] = nil }
    }
  }

  /// Refetches the first page. Overlapping calls coalesce into one more run.
  public func refreshSessions(_ key: ProjectsStore.ListKey) {
    if refreshing.contains(key) {
      refreshAgain.insert(key)
      return
    }
    refreshing.insert(key)
    Task {
      repeat {
        refreshAgain.remove(key)
        engine.projects.patchList(key) { $0.loading = true }
        do {
          let page: SessionPage = try await runtime.request(
            "sessions.page", SessionPageParams(projectId: key.projectId, archived: key.archived, limit: Self.pageSize))
          let merged = Paging.mergeFirstPage(engine.projects.lists[key]?.list, page)
          engine.projects.patchList(key) {
            $0.list = merged.list
            $0.loading = false
            $0.error = nil
          }
        } catch {
          engine.projects.patchList(key) {
            $0.loading = false
            $0.error = error.localizedDescription
          }
        }
      } while refreshAgain.contains(key)
      refreshing.remove(key)
    }
  }

  /// The next page after the list's cursor (11 §11.14: 50 at a time).
  public func loadMoreSessions(_ key: ProjectsStore.ListKey) async {
    guard let state = engine.projects.lists[key], let list = state.list, !state.loadingMore, Paging.canLoadMore(list) else {
      return
    }
    engine.projects.patchList(key) { $0.loadingMore = true }
    do {
      let page: SessionPage = try await runtime.request(
        "sessions.page",
        SessionPageParams(projectId: key.projectId, archived: key.archived, limit: Self.pageSize, cursor: list.cursor))
      let current = engine.projects.lists[key]?.list ?? list
      engine.projects.patchList(key) {
        $0.list = Paging.mergeNextPage(current, page)
        $0.loadingMore = false
      }
    } catch {
      engine.projects.patchList(key) {
        $0.loadingMore = false
        $0.error = error.localizedDescription
      }
    }
  }

  // ── Session windows ───────────────────────────────────────────────────────

  /// Opens a session's window (06 §6.7 phone algorithm): watched with the
  /// revision and anchor it holds, so the host answers with a snapshot,
  /// delta or `unchanged`.
  public func openSession(_ sessionId: String) -> (store: SessionStore, interest: Interest) {
    let store: SessionStore
    if let entry = windows[sessionId] {
      store = entry.store
      windows[sessionId]?.count += 1
    } else {
      store = SessionStore(env: env, sessionId: sessionId)
      windows[sessionId] = (store, 1)
    }
    let watching = watch.watchSession(sessionId) { [weak store] in
      (store?.value?.revision, Self.syncWindow(store?.window))
    }
    Task { await runtime.connect() }
    let interest = Interest { [weak self] in
      watching.release()
      guard let self, let entry = self.windows[sessionId] else { return }
      // The store outlives its screen for the watch's 30 s linger, so a
      // quick return reuses the window.
      self.windows[sessionId]?.count = entry.count - 1
      guard entry.count - 1 <= 0 else { return }
      Task { [weak self] in
        try? await Task.sleep(for: WatchManager.linger)
        if let self, self.windows[sessionId]?.count ?? 1 <= 0 { self.windows[sessionId] = nil }
      }
    }
    return (store, interest)
  }

  static func syncWindow(_ meta: WindowMeta?) -> SyncWindow {
    if let anchor = meta?.anchor { return SyncWindow(anchor: anchor) }
    return SyncWindow(tailTurns: tailTurns)
  }

  /// Base mismatch: ask for a fresh snapshot of the same window.
  private func resync(_ store: SessionStore, anchor: String?) async {
    let params = SessionSyncParams(
      sessionId: store.sessionId, window: anchor.map { SyncWindow(anchor: $0) } ?? SyncWindow(tailTurns: Self.tailTurns),
      maxBlockChars: WatchManager.maxBlockChars)
    guard let fresh: SessionSync = try? await runtime.request("sessions.sync", params),
      case let .snapshot(value, window) = fresh
    else { return }
    await store.pipeline.replace(value, window)
    store.publish(value, window)
  }

  /// One block in full (`sessions.block`), for the tool sheet: the
  /// window's copy may be truncated in transit (06 §6.7).
  public func block(_ sessionId: String, _ blockId: String) async throws -> Block {
    struct Params: Encodable, Sendable {
      var sessionId: String
      var blockId: String
    }
    struct Result: Decodable, Sendable {
      var block: Block
    }
    let result: Result = try await runtime.request("sessions.block", Params(sessionId: sessionId, blockId: blockId), timeout: .seconds(60))
    return result.block
  }

  /// Prepends the turns before the window; the first returned block becomes
  /// the anchor the next watch carries.
  public func loadOlder(_ store: SessionStore) async {
    guard let first = store.value?.session.blocks.first, !store.loadingOlder, store.hasOlder else { return }
    store.loadingOlder = true
    do {
      let page: OlderBlocks = try await runtime.request(
        "sessions.blocks",
        OlderBlocksParams(sessionId: store.sessionId, before: first.id, turns: Self.olderTurns, maxBlockChars: WatchManager.maxBlockChars))
      let (value, window) = await store.pipeline.current()
      if let value, let merged = Paging.mergeOlder(value, window: window, before: first.id, page: page) {
        await store.pipeline.replace(merged.value, merged.window)
        store.publish(merged.value, merged.window)
        watch.refresh()
      }
      store.loadingOlder = false
    } catch {
      store.loadingOlder = false
      store.error = error.localizedDescription
    }
  }
}
