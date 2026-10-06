import Foundation
import MonoStore
import MonoWire

/// The read-path sync for one host (12 §12.7): it consumes the runtime's
/// events, fetches the inbox, projects, session pages and windows, and writes
/// the stores. Session syncs decode and apply off the main actor. The cache
/// paints first (12 §12.6): projects, the inbox, session lists and windows
/// come from SQLite before the host answers, and every answer is written
/// back.
@MainActor
public final class HostSync {
  public static let pageSize = 50
  public static let tailTurns = 20
  public static let olderTurns = 20

  public let env: String
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
  private var windowSaves: [String: Task<Void, Never>] = [:]
  /// Window saves wait this long after the last sync, coalescing a stream.
  static let windowSaveDelay: Duration = .seconds(1)

  init(env: String, runtime: HostRuntime, engine: SyncEngine) {
    self.env = env
    self.engine = engine
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

  public var record: HostRecord? { engine.hosts.record(env) }

  private var database: CacheDatabase? {
    record?.isDemo == false ? engine.database : nil
  }

  func start() {
    Task {
      await paintFromCache()
      await runtime.connect(.launch)
    }
  }

  func stop() {
    events?.cancel()
    for task in windowSaves.values { task.cancel() }
    Task { await runtime.shutdown() }
  }

  /// Projects, the inbox and seen marks from the cache, before any answer.
  private func paintFromCache() async {
    guard let database else { return }
    if let projects = try? await database.loadProjects(env: env), !projects.isEmpty,
      engine.projects.hosts[env]?.projects.isEmpty ?? true
    {
      engine.projects.patchHost(env) {
        $0.projects = projects
        $0.freshness = .cached
      }
    }
    if let cached = try? await database.loadInbox(env: env), engine.inbox.hosts[env] == nil {
      engine.inbox.hosts[env] = InboxStore.HostInbox(
        boot: cached.inbox.boot, revision: cached.inbox.revision, items: cached.inbox.items, fetchedAt: cached.fetchedAt)
      engine.inbox.cachedHosts.insert(env)
    }
    if let seen = try? await database.loadSeen(env: env) { engine.seen.restore(env, seen) }
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
        await saveWindow(store)
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
        let now = Date()
        engine.hosts.lastOnline[env] = now
        engine.update(env) { $0.lastOnlineAt = now }
        watch.refresh()
        if watch.watchesInbox { refreshInbox() }
        loadProjects()
        loadModels()
        for key in openLists.keys { refreshSessions(key) }
      } else {
        for (_, entry) in windows { entry.store.freshness = .cached }
        // A blocked host's cached rows will not refresh: no "Updating…".
        if case .blocked = state { engine.inbox.cachedHosts.remove(env) }
      }
    case let .welcome(welcome):
      engine.hosts.welcomes[env] = welcome
      engine.update(env) { $0.lastWelcome = HostRecord.WelcomeSummary(welcome) }
    case let .endpoints(endpoints):
      // The host's addresses move with DHCP and Tailscale (05 §5.2).
      if !endpoints.isEmpty { engine.update(env) { $0.endpoints = endpoints } }
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
          engine.inbox.cachedHosts.remove(env)
          if let database { Task { try? await database.saveInbox(env: env, inbox) } }
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
        if let database { Task { [env] in try? await database.saveProjects(env: env, projects) } }
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
    if engine.projects.lists[key]?.list == nil, let database {
      Task { [env] in
        guard let items = try? await database.loadSessionItems(env: env, projectId: projectId), !items.isEmpty,
          self.engine.projects.lists[key]?.list == nil
        else { return }
        self.engine.projects.patchList(key) { $0.list = Paging.cachedList(items, archived: archived) }
      }
    }
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
          if let database {
            Task { [env] in
              try? await database.saveSessionItems(env: env, projectId: key.projectId, page.items)
              try? await database.deleteSessionItems(env: env, ids: merged.removed)
            }
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
      if let database { paintWindow(store, from: database) }
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

  /// The cached window paints before the watch's answer; the watch then
  /// carries its revision, so the host sends a delta or `unchanged`.
  private func paintWindow(_ store: SessionStore, from database: CacheDatabase) {
    Task { [env] in
      guard let cached = try? await database.loadWindow(env: env, id: store.sessionId), store.value == nil else { return }
      await store.pipeline.replace(cached.value, cached.window)
      guard store.value == nil else { return }
      store.paint(cached.value, cached.window)
    }
  }

  /// Saves a window 1 s after its last change (12 §12.7 step 4).
  private func saveWindow(_ store: SessionStore) {
    guard let database else { return }
    let id = store.sessionId
    windowSaves[id]?.cancel()
    windowSaves[id] = Task { [env] in
      try? await Task.sleep(for: Self.windowSaveDelay)
      guard !Task.isCancelled else { return }
      let (value, window) = await store.pipeline.current()
      guard let value else { return }
      _ = try? await database.saveWindow(env: env, id: id, CachedWindow(revision: value.revision, value: value, window: window))
    }
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
    saveWindow(store)
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

  /// A file's text (`files.read`, 06 §6.5): `path` is relative to the
  /// project folder, or to `cwd` for a session's worktree.
  public func readFile(projectId: String, cwd: String?, path: String) async throws -> String {
    struct Params: Encodable, Sendable {
      var projectId: String
      var cwd: String?
      var path: String
    }
    return try await runtime.request("files.read", Params(projectId: projectId, cwd: cwd, path: path))
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
