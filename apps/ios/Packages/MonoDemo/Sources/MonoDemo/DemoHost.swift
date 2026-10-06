import Foundation
import MonoSync
import MonoWire

/// The demo machine's state, as gen-fixtures.mjs exports it from the Expo
/// app's demoHost.ts.
struct DemoState: Decodable {
  var fixtureNow: Int
  var env: String
  var boot: String
  var projects: [HostProject]
  var sessions: [HostSession]
  var models: ModelCatalog
  var replies: [String]
  /// demoRepo.ts's working trees by working-copy path.
  var repos: [String: [String: RepoFile]]

  static func bundled() throws -> DemoState {
    guard let url = Bundle.module.url(forResource: "demo-state", withExtension: "json") else {
      throw CocoaError(.fileNoSuchFile)
    }
    return try JSONDecoder().decode(DemoState.self, from: Data(contentsOf: url))
  }
}

/// A file in a demo repository: its text, or a binary or oversized blob.
enum RepoFile: Decodable {
  case text(String)
  case binary
  case tooLarge

  init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let text = try? container.decode(String.self) {
      self = .text(text)
      return
    }
    struct Blob: Decodable {
      var binary: Bool?
      var tooLarge: Bool?
    }
    self = try container.decode(Blob.self).tooLarge == true ? .tooLarge : .binary
  }
}

/// `{t: "evt", e, d}` (06 §6.3).
struct DemoEvent<D: Encodable>: Encodable {
  var t = "evt"
  let e: String
  let d: D
}

/// A host error with the host's code (06 §6.11).
struct DemoError: Error {
  var code: String
  var message: String
}

/// The demo machine (12 §12.13): an in-process host that answers the read
/// path the way `host/` does, from the Expo demo's initial state.
///
/// - Methods: `inbox.list`, `projects.list`, `sessions.page`, `sessions.sync`,
///   `sessions.blocks`, `sessions.block`, `files.read`, `watch.set`,
///   `models.list`. Anything else is
///   `method_not_found`, so the app hides it.
/// - Events, coalesced as the host does (06 §6.6): `session.sync` at most
///   every 100 ms per session, `inbox.changed` and `project.sessions` at most
///   every 500 ms.
/// - Live turns (R1 deviation): `startLiveTurns()` streams answers into
///   "Profile the transcript scroll" in a loop and stops "Add pagination to
///   /sessions" at an approval, so Working, Need approval, spinners and
///   shimmer are live without the write path.
public actor DemoHost {
  public static let env = "00000000-0000-4000-8000-00000000d3e0"
  public static let capabilities = ["sessions", "models.list", "channel.watch", "sessions.window", "sessions.page", "inbox", "files.read"]
  static let day = 86_400_000
  static let turnModel = TurnModel(harness: "claude", id: "claude:opus-4-6", name: "Claude Opus 4.6")

  struct Entry {
    var value: HostSession
    /// The revision at which each block last changed (the host's stamps).
    var blockRevisions: [String: Int]
  }

  let boot: String
  private var projects: [HostProject]
  /// In the TypeScript demo's insertion order.
  private var order: [String]
  private var sessions: [String: Entry]
  private let models: ModelCatalog
  private let replies: [String]
  private let repos: [String: [String: RepoFile]]
  private let clock: @Sendable () -> Int
  /// Simulated time runs this much faster (tests).
  private let speed: Double
  private var inboxRevision = 1
  private var watch = WatchSet()
  private var sent: [String: Int] = [:]
  private var socket: DemoSocket?
  private var pushTimers: [String: Task<Void, Never>] = [:]
  private var lastPush: [String: Int] = [:]
  private var inboxTimer: Task<Void, Never>?
  private var projectTimers: [String: Task<Void, Never>] = [:]
  private var live: [Task<Void, Never>] = []
  private var runs = 0
  private var requests = 100

  /// `now` places the demo's history: the fixture's clock maps to it, so
  /// "4m ago" stays 4 minutes ago. Tests pass the fixture's own clock.
  public init(now: Date = Date(), speed: Double = 1, clock: (@Sendable () -> Int)? = nil) throws {
    let state = try DemoState.bundled()
    let nowMs = Int(now.timeIntervalSince1970 * 1000)
    let offset = nowMs - state.fixtureNow
    boot = state.boot
    projects = state.projects
    models = state.models
    replies = state.replies
    repos = state.repos
    self.speed = speed
    let started = Date().timeIntervalSince1970 * 1000
    self.clock = clock ?? { Int((Date().timeIntervalSince1970 * 1000 - started) * speed) + nowMs }
    order = state.sessions.map(\.session.id)
    sessions = Dictionary(
      uniqueKeysWithValues: state.sessions.map { value in
        let shifted = Self.shift(value, by: offset)
        return (value.session.id, Entry(value: shifted, blockRevisions: Dictionary(shifted.session.blocks.map { ($0.id, shifted.revision) }, uniquingKeysWith: { $1 })))
      })
  }

  static func shift(_ value: HostSession, by offset: Int) -> HostSession {
    guard offset != 0 else { return value }
    var next = value
    next.createdAt = value.createdAt.map { $0 + offset }
    next.updatedAt += offset
    next.finishedAt = value.finishedAt.map { $0 + offset }
    next.session.usageLimit?.resetsAt = value.session.usageLimit?.resetsAt.map { $0 + offset }
    next.session.pendingQuestion?.autoResolveAt = value.session.pendingQuestion?.autoResolveAt.map { $0 + offset }
    next.session.blocks = value.session.blocks.map { block in
      var shifted = block
      shifted.startedAt = block.startedAt.map { $0 + offset }
      return shifted
    }
    return next
  }

  var now: Int { clock() }

  // ── Connection ────────────────────────────────────────────────────────────

  public var welcome: Welcome {
    Welcome(
      env: Self.env, boot: boot, time: now, host: .init(name: "Demo", platform: "darwin", version: "demo", fingerprint: "demo"),
      device: .init(id: "demo-device", name: "This phone", role: "member"), capabilities: Self.capabilities,
      providers: ["claude"], limits: .init(maxMessage: 16 * 1024 * 1024, maxInFlight: 64, maxWatchedSessions: 8))
  }

  func attach(_ socket: DemoSocket) {
    self.socket = socket
    sent.removeAll()
    watch = WatchSet()
  }

  func detach(_ socket: DemoSocket) {
    if self.socket === socket { self.socket = nil }
  }

  /// A frame from the phone: the hello, then requests.
  func receive(_ frame: Data, from socket: DemoSocket) async {
    guard let object = try? JSONSerialization.jsonObject(with: frame) as? [String: Any] else { return }
    switch object["t"] as? String {
    case "hello":
      socket.deliver(try? JSONEncoder().encode(welcome))
    case "req":
      guard let id = object["id"] as? Int, let method = object["m"] as? String else { return }
      let params = (try? JSONSerialization.data(withJSONObject: object["p"] ?? [:], options: [.fragmentsAllowed])) ?? Data("{}".utf8)
      var reply: [String: Any] = ["t": "res", "id": id]
      do {
        let result = try call(method, params)
        reply["ok"] = true
        reply["r"] = try JSONSerialization.jsonObject(with: result, options: [.fragmentsAllowed])
      } catch let error as DemoError {
        reply["ok"] = false
        reply["e"] = ["code": error.code, "message": error.message, "retryable": false]
      } catch {
        reply["ok"] = false
        reply["e"] = ["code": "invalid_params", "message": "Invalid parameters", "retryable": false]
      }
      socket.deliver(try? JSONSerialization.data(withJSONObject: reply, options: [.fragmentsAllowed]))
    default:
      break
    }
  }

  private func send<D: Encodable>(_ event: String, _ data: D) {
    socket?.deliver(try? JSONEncoder().encode(DemoEvent(e: event, d: data)))
  }

  // ── Methods ───────────────────────────────────────────────────────────────

  /// Answers one request: JSON params in, JSON result out.
  public func call(_ method: String, _ params: Data) throws -> Data {
    let decoder = JSONDecoder()
    let encoder = JSONEncoder()
    switch method {
    case "inbox.list":
      return try encoder.encode(InboxList(boot: boot, revision: inboxRevision, items: inboxItems()))
    case "projects.list":
      return try encoder.encode(projects)
    case "models.list":
      return try encoder.encode(models)
    case "sessions.page":
      return try encoder.encode(page(try decoder.decode(PageParams.self, from: params)))
    case "sessions.sync":
      let p = try decoder.decode(SessionSyncParams.self, from: params)
      guard let entry = sessions[p.sessionId] else { throw DemoError(code: "not_found", message: "Session not found on this machine") }
      return try encoder.encode(sync(entry, from: p.revision, window: p.window, maxBlockChars: p.maxBlockChars ?? 0))
    case "sessions.blocks":
      let p = try decoder.decode(OlderParams.self, from: params)
      guard let entry = sessions[p.sessionId] else { throw DemoError(code: "not_found", message: "Session not found on this machine") }
      let older = SessionWindow.older(entry.value.session.blocks, before: p.before ?? "", turns: p.turns ?? 20)
      let max = p.maxBlockChars ?? 0
      return try encoder.encode(
        OlderBlocks(
          blocks: older.blocks.map { SessionWindow.truncate($0, max: max) }, hasOlder: older.olderTurns > 0,
          olderTurns: older.olderTurns, revision: entry.value.revision))
    case "sessions.block":
      struct BlockParams: Decodable {
        var sessionId: String
        var blockId: String
      }
      struct BlockResult: Encodable {
        var block: Block
        var revision: Int
      }
      let p = try decoder.decode(BlockParams.self, from: params)
      guard let entry = sessions[p.sessionId], let block = entry.value.session.blocks.first(where: { $0.id == p.blockId }) else {
        throw DemoError(code: "not_found", message: "Session not found on this machine")
      }
      return try encoder.encode(BlockResult(block: block, revision: entry.value.revision))
    case "files.read":
      return try encoder.encode(readFile(try decoder.decode(FileParams.self, from: params)))
    case "watch.set":
      setWatch(try decoder.decode(WatchSet.self, from: params))
      return Data("{}".utf8)
    default:
      throw DemoError(code: "method_not_found", message: "Unsupported host method")
    }
  }

  struct FileParams: Decodable {
    var projectId: String?
    var cwd: String?
    var path: String?
  }

  /// `files.read`, with demoRepo.ts's refusals and messages.
  private func readFile(_ params: FileParams) throws -> String {
    guard let project = projects.first(where: { $0.id == params.projectId }) else {
      throw DemoError(code: "not_found", message: "Project is not registered on this machine")
    }
    let cwd = params.cwd.flatMap { $0.isEmpty ? nil : $0 } ?? project.cwd
    guard let files = repos[cwd] else {
      throw DemoError(code: "invalid_params", message: "Choose an available worktree of this project")
    }
    guard let input = params.path, input.utf16.count <= 4096, !input.contains("\0") else {
      throw DemoError(code: "invalid_params", message: "Invalid workspace path")
    }
    let path = input.replacingOccurrences(of: "^\\.?/+", with: "", options: .regularExpression)
      .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    if path.isEmpty || path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0.lowercased() == ".git" }) {
      throw DemoError(code: "internal", message: "Path is outside the workspace")
    }
    switch files[path] {
    case let .text(text)?:
      return text
    case .binary?:
      throw DemoError(code: "internal", message: "Binary file cannot be previewed")
    case .tooLarge?:
      throw DemoError(code: "internal", message: "File is too large to preview")
    case nil:
      if files.keys.contains(where: { $0.hasPrefix(path + "/") }) {
        throw DemoError(code: "internal", message: "Path is not a file")
      }
      throw DemoError(code: "internal", message: "ENOENT: no such file or directory, realpath '\(path)'")
    }
  }

  /// `sessions.page` params, loose like the host's (`Number(limit) || 50`).
  struct PageParams: Decodable {
    var projectId: String?
    var archived: String?
    var limit: Int?
    var cursor: String?
  }

  struct OlderParams: Decodable {
    var sessionId: String
    var before: String?
    var turns: Int?
    var maxBlockChars: Int?
  }

  // ── Summaries ─────────────────────────────────────────────────────────────

  private func branch(_ value: HostSession) -> String {
    value.session.branch ?? (value.session.id == "s-auth" ? "fix/auth" : "main")
  }

  /// When the last turn settled, as the host's `phoneSummary` reports it.
  private func finishedAt(_ value: HostSession) -> Int? {
    if value.status == .running { return nil }
    let turn = value.session.blocks.last { $0.role == .user && !$0.isDraft }
    if let finished = value.finishedAt { return finished }
    if let started = turn?.startedAt, started != 0, let duration = turn?.durationMs { return started + duration }
    return nil
  }

  /// Like the host's inbox: running, needing input, or changed this week.
  func inboxItems() -> [InboxItem] {
    let now = self.now
    var items: [InboxItem] = []
    for id in order {
      guard let value = sessions[id]?.value, let project = projects.first(where: { $0.id == value.projectId }) else { continue }
      let approval = Summary.pendingApproval(value)
      let question = Summary.pendingQuestion(value)
      if value.status != .running && approval == nil && question == nil
        && (value.archived == true || now - value.updatedAt > 7 * Self.day)
      {
        continue
      }
      var item = try! JSONDecoder().decode(
        InboxItem.self,
        from: JSONSerialization.data(withJSONObject: [
          "sessionId": id, "projectId": project.id, "projectName": project.name, "title": value.session.title,
          "harness": "claude", "status": value.status.rawValue, "attention": NSNull(), "needsInput": false,
          "updatedAt": value.updatedAt, "revision": value.revision,
        ]))
      item.model = value.session.model
      item.runtimeMode = value.session.runtimeMode
      item.runId = value.runId
      item.attention = Attention(Summary.attention(value))
      item.needsInput = approval != nil || question != nil
      item.approval = approval
      item.question = question
      item.lastText = Summary.lastAssistantText(value.session.blocks)
      item.finishedAt = finishedAt(value)
      item.branch = branch(value)
      item.queueLength = (value.session.queuedMessages?.count ?? 0) > 0 ? value.session.queuedMessages?.count : nil
      item.pinned = value.pinned == true ? true : nil
      items.append(item)
    }
    // JavaScript's sort is stable: ties keep insertion order.
    return items.enumerated().sorted { a, b in
      if Summary.inboxOrder(a.element, b.element) { return true }
      if Summary.inboxOrder(b.element, a.element) { return false }
      return a.offset < b.offset
    }.map(\.element)
  }

  private func summary(_ value: HostSession) throws -> SessionListItem {
    let project = projects.first { $0.id == value.projectId }
    let json: [String: Any] = [
      "projectId": value.projectId, "revision": value.revision, "status": value.status.rawValue, "updatedAt": value.updatedAt,
      "id": value.session.id, "title": value.session.title, "harness": "claude", "model": value.session.model,
      "runtimeMode": value.session.runtimeMode.rawValue, "cwd": value.session.cwd, "repo": project?.name ?? "",
      "branch": branch(value),
      "needsInput": Summary.pendingApproval(value) != nil || value.session.pendingQuestion != nil,
    ]
    var item = try JSONDecoder().decode(SessionListItem.self, from: JSONSerialization.data(withJSONObject: json))
    item.runId = value.runId
    item.createdAt = value.createdAt
    item.archived = value.archived
    item.pinned = value.pinned
    item.autoWorktreeBranch = value.autoWorktreeBranch
    item.lastText = Summary.lastAssistantText(value.session.blocks)
    item.queueLength = (value.session.queuedMessages?.count ?? 0) > 0 ? value.session.queuedMessages?.count : nil
    item.finishedAt = finishedAt(value)
    return item
  }

  private typealias PageKey = (pinned: Int, updatedAt: Int, id: String)

  private static func key(_ value: HostSession) -> PageKey {
    (value.pinned == true ? 1 : 0, value.updatedAt, value.session.id)
  }

  private static func before(_ a: PageKey, _ b: PageKey) -> Bool {
    if a.pinned != b.pinned { return a.pinned > b.pinned }
    if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
    return a.id < b.id
  }

  /// `sessions.page`, in the host's order and with its key cursors.
  private func page(_ params: PageParams) throws -> SessionPage {
    let projectId = params.projectId ?? ""
    guard projects.contains(where: { $0.id == projectId }) else {
      throw DemoError(code: "not_found", message: "Project is not registered on this machine")
    }
    let archived = params.archived == "only" || params.archived == "include" ? params.archived! : "exclude"
    let limit = max(1, min(200, params.limit ?? 50))
    let ordered = order.compactMap { sessions[$0]?.value }
      .filter { $0.projectId == projectId }
      .filter { archived == "include" ? true : archived == "only" ? $0.archived == true : $0.archived != true }
      .sorted { Self.before(Self.key($0), Self.key($1)) }
    var start = 0
    if let cursor = params.cursor {
      guard let parts = try JSONSerialization.jsonObject(with: Data(cursor.utf8)) as? [Any], parts.count == 3,
        let p = parts[0] as? Int, let u = parts[1] as? Int, let i = parts[2] as? String
      else { throw DemoError(code: "invalid_params", message: "Invalid cursor") }
      let after: PageKey = (p, u, i)
      start = ordered.firstIndex { Self.before(after, Self.key($0)) } ?? -1
    }
    let slice = start < 0 ? [] : Array(ordered.dropFirst(start).prefix(limit))
    let more = start >= 0 && start + limit < ordered.count
    var cursor: String?
    if more, let last = slice.last {
      let key = Self.key(last)
      let id = String(data: try JSONEncoder().encode(key.id), encoding: .utf8)!
      cursor = "[\(key.pinned),\(key.updatedAt),\(id)]"
    }
    return SessionPage(items: try slice.map(summary), cursor: cursor)
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /// `sessions.sync` for a window (06 §6.7, the host algorithm).
  func sync(_ entry: Entry, from revision: Int?, window: SyncWindow?, maxBlockChars: Int) -> SessionSync {
    let value = entry.value
    let blocks = value.session.blocks
    var start = 0
    var reset = false
    if let window { (start, reset) = SessionWindow.start(blocks, window) }
    let meta = window == nil ? nil : SessionWindow.meta(blocks, start: start)
    if revision == value.revision && !reset { return .unchanged(revision: value.revision, window: meta) }
    let windowed = blocks[start...].map { SessionWindow.truncate($0, max: maxBlockChars) }
    guard let revision, revision <= value.revision, !reset else {
      var snapshot = value
      snapshot.session.blocks = Array(windowed)
      return .snapshot(snapshot, window: meta)
    }
    let changed = windowed.filter { (entry.blockRevisions[$0.id] ?? Int.max) > revision }
    return .delta(base: revision, value: value, blockIds: windowed.map(\.id), blocks: changed, window: meta)
  }

  private func setWatch(_ next: WatchSet) {
    watch = next
    sent.removeAll()
    for item in next.sessions ?? [] where sessions[item.id] != nil {
      sent[item.id] = item.revision
      push(item.id, force: true)
    }
  }

  /// Sends a watching phone the change since what it last got.
  private func push(_ id: String, force: Bool = false) {
    guard let item = watch.sessions?.first(where: { $0.id == id }), let entry = sessions[id] else { return }
    let from = sent[id]
    if !force, from == entry.value.revision { return }
    let sync = sync(entry, from: from, window: item.window ?? SyncWindow(tailTurns: SessionWindow.defaultTailTurns), maxBlockChars: item.maxBlockChars ?? 0)
    sent[id] = entry.value.revision
    lastPush[id] = now
    send("session.sync", SessionSyncEvent(sessionId: id, sync: sync))
  }

  /// At most one `session.sync` per session every 100 ms (06 §6.6).
  private func schedulePush(_ id: String) {
    guard watch.sessions?.contains(where: { $0.id == id }) == true, pushTimers[id] == nil else { return }
    let wait = max(0, 100 - (now - (lastPush[id] ?? 0)))
    pushTimers[id] = Task {
      try? await self.sleep(ms: wait)
      self.pushTimers[id] = nil
      self.push(id)
    }
  }

  private func announce(_ projectId: String) {
    inboxRevision += 1
    if watch.inbox == true, inboxTimer == nil {
      inboxTimer = Task {
        try? await self.sleep(ms: 500)
        self.inboxTimer = nil
        self.send("inbox.changed", InboxChangedEvent(boot: self.boot, revision: self.inboxRevision))
      }
    }
    if watch.projects?.contains(projectId) == true, projectTimers[projectId] == nil {
      projectTimers[projectId] = Task {
        try? await self.sleep(ms: 500)
        self.projectTimers[projectId] = nil
        self.send("project.sessions", ProjectSessionsEvent(projectId: projectId))
      }
    }
  }

  /// Changes a session: a new revision, stamps for the blocks that changed,
  /// and the events a watching phone gets.
  @discardableResult
  private func save(_ id: String, _ change: (inout HostSession) -> Void) -> HostSession? {
    guard var entry = sessions[id] else { return nil }
    let before = Dictionary(entry.value.session.blocks.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
    var next = entry.value
    change(&next)
    next.revision = entry.value.revision + 1
    next.updatedAt = now
    for block in next.session.blocks where before[block.id] != block { entry.blockRevisions[block.id] = next.revision }
    entry.value = next
    sessions[id] = entry
    schedulePush(id)
    announce(next.projectId)
    return next
  }

  private func sleep(ms: Int) async throws {
    try await Task.sleep(for: .milliseconds(Double(ms) / speed))
  }

  // ── Live turns (R1) ───────────────────────────────────────────────────────

  /// Starts the demo's live turns: a streaming answer on "Profile the
  /// transcript scroll", repeated, and a turn on "Add pagination to
  /// /sessions" that stops at an approval.
  public func startLiveTurns() {
    guard live.isEmpty else { return }
    live.append(Task { await self.streamLoop("s-perf") })
    live.append(Task { await self.approvalTurn("s-api") })
  }

  public func stopLiveTurns() {
    live.forEach { $0.cancel() }
    live.removeAll()
  }

  /// The value a phone should hold for `id` once every sync has arrived.
  public func value(_ id: String) -> HostSession? {
    sessions[id]?.value
  }

  private static let prompts = [
    "Profile the scroll again with the new layout cache",
    "Why does the tail re-layout take 2 ms?",
    "Check the fling at 120 Hz",
  ]

  /// Starts a turn as the TypeScript demo's `beginTurn` does: think, read a
  /// file, then the answer or an approval.
  private func begin(_ id: String, text: String) async throws -> String {
    runs += 1
    let runId = "run-\(runs)"
    let started = now
    save(id) { value in
      value.status = .running
      value.runId = runId
      value.session.usageLimit = nil
      var user = Block(id: "\(runId)-u", role: .user, text: text)
      user.startedAt = started
      user.turnModel = Self.turnModel
      value.session.blocks.append(user)
    }
    try await sleep(ms: 600)
    save(id) { value in
      var reasoning = Block(id: "\(runId)-r", role: .reasoning, text: "Looking at the failing test and the session store.")
      reasoning.streaming = true
      value.session.blocks.append(reasoning)
    }
    try await sleep(ms: 800)
    save(id) { value in
      // Each turn reports the context it used, as Claude does on its result:
      // the level climbs with the turns and wraps, as after a compaction.
      value.session.context = ContextUsage(used: Double(48_000 + (runs * 23_000) % 150_000), window: 200_000)
      if let i = value.session.blocks.firstIndex(where: { $0.id == "\(runId)-r" }) { value.session.blocks[i].streaming = false }
      var read = Block(id: "\(runId)-t1", role: .tool, text: "Read src/auth/session.ts")
      read.tool = .init(kind: "read", status: "completed", preview: ToolPreview(kind: .read, path: "src/auth/session.ts"))
      value.session.blocks.append(read)
    }
    try await sleep(ms: 800)
    return runId
  }

  private func streamLoop(_ id: String) async {
    var turn = 0
    while !Task.isCancelled {
      do {
        let runId = try await begin(id, text: Self.prompts[turn % Self.prompts.count])
        let reply = replies[turn % replies.count]
        var offset = 0
        let units = Array(reply.utf16)
        try await sleep(ms: 400)
        while offset < units.count {
          offset = min(units.count, offset + 3)
          let text = String(decoding: units[..<offset], as: UTF16.self)
          let streaming = offset < units.count
          save(id) { value in
            var answer = Block(id: "\(runId)-a", role: .assistant, text: text)
            answer.streaming = streaming ? true : nil
            if let i = value.session.blocks.firstIndex(where: { $0.id == answer.id }) {
              value.session.blocks[i] = answer
            } else {
              value.session.blocks.append(answer)
            }
          }
          try await sleep(ms: 33)
        }
        try await sleep(ms: 200)
        save(id) { value in settle(&value) }
        turn += 1
        try await sleep(ms: 8_000)
      } catch {
        return
      }
    }
  }

  private func approvalTurn(_ id: String) async {
    do {
      _ = try await begin(id, text: "Run the auth tests before we merge")
      requests += 1
      let requestId = requests
      save(id) { value in
        let runId = value.runId ?? "run"
        var command = Block(id: "\(runId)-t2", role: .tool, text: "npm test -- auth")
        command.tool = .init(kind: "execute", status: "pending", detail: "npm test -- auth")
        command.approval = .init(requestId: requestId)
        value.session.blocks.append(command)
      }
    } catch {}
  }

  /// The turn's end: idle, with its duration and outcome.
  private func settle(_ value: inout HostSession) {
    let now = self.now
    value.status = .idle
    value.runId = nil
    value.finishedAt = now
    value.lastTurnOutcome = .finished
    if let i = value.session.blocks.lastIndex(where: { $0.role == .user }) {
      value.session.blocks[i].durationMs = now - (value.session.blocks[i].startedAt ?? now)
    }
  }
}
