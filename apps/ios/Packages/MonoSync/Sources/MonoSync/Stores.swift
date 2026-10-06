import Foundation
import MonoStore
import MonoWire
import Observation

// The UI-facing stores (12 §12.5): @Observable and main-actor bound, written
// by the host syncs and painted first from the cache. Views read only the
// properties they show. The outbox and UI state arrive with R3.

@MainActor @Observable
public final class HostsStore {
  public internal(set) var records: [HostRecord] = []
  public internal(set) var states: [String: HostConnState] = [:]
  public internal(set) var welcomes: [String: Welcome] = [:]
  public internal(set) var lastOnline: [String: Date] = [:]

  public init() {}

  public func record(_ env: String) -> HostRecord? {
    records.first { $0.env == env }
  }

  public func label(_ env: String) -> String {
    record(env)?.label ?? ""
  }

  /// A capability from the host's last welcome (06 §6.4).
  public func has(_ env: String, _ capability: String) -> Bool {
    welcomes[env]?.capabilities.contains(capability) ?? false
  }

  /// The notice for a machine that can't serve requests (11 §11.12).
  public func notice(_ env: String) -> String? {
    guard let record = record(env) else { return nil }
    return HostStatus.notice(label: record.label, state: states[env], lastOnlineAt: lastOnline[env])
  }
}

/// An inbox row with the machine it came from.
public struct AgentItem: Hashable, Sendable, Identifiable {
  public var env: String
  public var item: InboxItem

  public var id: String { "\(env)/\(item.sessionId)" }
}

@MainActor @Observable
public final class InboxStore {
  public struct HostInbox: Sendable {
    public var boot: String
    public var revision: Int
    public var items: [InboxItem]
    public var fetchedAt: Date
  }

  public internal(set) var hosts: [String: HostInbox] = [:]
  /// Hosts whose rows were painted from the cache and not fetched since.
  public internal(set) var cachedHosts: Set<String> = []

  /// Some rows come from the cache, not yet refreshed.
  public var cached: Bool { !cachedHosts.isEmpty }

  public init() {}

  /// Every machine's rows, merged in the host's order.
  public var items: [AgentItem] {
    hosts.flatMap { env, inbox in inbox.items.map { AgentItem(env: env, item: $0) } }
      .sorted { Summary.inboxOrder($0.item, $1.item) }
  }

  /// The Agents tab badge: sessions that need input.
  public var needsInput: Int {
    hosts.values.reduce(0) { $0 + $1.items.filter(\.needsInput).count }
  }

  /// Running sessions, for the bottom accessory's count.
  public var working: Int {
    hosts.values.reduce(0) { $0 + $1.items.filter { $0.status == .running }.count }
  }

  public func item(_ env: String, _ sessionId: String) -> InboxItem? {
    hosts[env]?.items.first { $0.sessionId == sessionId }
  }
}

public enum Freshness: Sendable {
  /// Painted from the cache (or not yet synced) since the watch was sent.
  case cached
  case live
}

@MainActor @Observable
public final class ProjectsStore {
  public struct HostProjects: Sendable {
    public var projects: [HostProject] = []
    public var freshness: Freshness = .cached
    public var loading = false
    public var error: String?
  }

  public struct ListKey: Hashable, Sendable {
    public var env: String
    public var projectId: String
    public var archived: ArchivedFilter

    public init(env: String, projectId: String, archived: ArchivedFilter) {
      self.env = env
      self.projectId = projectId
      self.archived = archived
    }
  }

  public struct ListState: Sendable {
    public var list: SessionList?
    public var loading = false
    public var loadingMore = false
    public var error: String?
  }

  public internal(set) var hosts: [String: HostProjects] = [:]
  public internal(set) var lists: [ListKey: ListState] = [:]

  public init() {}

  public func project(_ env: String, _ id: String) -> HostProject? {
    hosts[env]?.projects.first { $0.id == id }
  }

  func patchHost(_ env: String, _ change: (inout HostProjects) -> Void) {
    var value = hosts[env] ?? HostProjects()
    change(&value)
    hosts[env] = value
  }

  func patchList(_ key: ListKey, _ change: (inout ListState) -> Void) {
    var value = lists[key] ?? ListState()
    change(&value)
    lists[key] = value
  }
}

/// Model catalogs per machine (`models.list`), for model names.
@MainActor @Observable
public final class CatalogStore {
  public internal(set) var catalogs: [String: ModelCatalog] = [:]

  public init() {}

  /// "Claude Opus 4.6" for "claude:opus-4-6"; the id made readable when no
  /// catalog lists it, as the Expo app's `modelLabel` did.
  public func modelName(_ env: String, _ id: String?) -> String {
    guard let id, !id.isEmpty else { return "" }
    if let name = catalogs[env]?.name(of: id) { return name }
    return Self.readable(id)
  }

  public static func readable(_ id: String) -> String {
    let bare = id.replacingOccurrences(of: "^[^:]+:", with: "", options: .regularExpression)
      .replacingOccurrences(of: "[-_]", with: " ", options: .regularExpression)
    return bare.split(separator: " ", omittingEmptySubsequences: false)
      .map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
  }
}

/// What this phone has seen (06 §6.10): "Done" shows until the session is
/// opened here. The newest 500 entries, kept in the cache's `seen` table.
@MainActor @Observable
public final class SeenStore {
  public internal(set) var seen: [String: Date] = [:]
  /// Writes one change through to the cache.
  @ObservationIgnored var persist: (@MainActor (_ env: String, _ sessionId: String, _ at: Date) -> Void)?

  public init() {}

  public static func key(_ env: String, _ sessionId: String) -> String { "\(env)/\(sessionId)" }

  public func markSeen(_ env: String, _ sessionId: String, at date: Date = Date()) {
    seen[Self.key(env, sessionId)] = date
    if seen.count > 500 {
      for (key, _) in seen.sorted(by: { $0.value > $1.value }).dropFirst(500) { seen[key] = nil }
    }
    persist?(env, sessionId, date)
  }

  public func markUnseen(_ env: String, _ sessionId: String) {
    seen[Self.key(env, sessionId)] = .distantPast
    persist?(env, sessionId, .distantPast)
  }

  /// One host's rows from the cache; newer marks made meanwhile win.
  func restore(_ env: String, _ rows: [String: Date]) {
    for (sessionId, at) in rows {
      let key = Self.key(env, sessionId)
      if let mine = seen[key], mine >= at { continue }
      seen[key] = at
    }
  }

  /// Finished after this phone last opened it.
  public func isUnseen(_ env: String, _ sessionId: String, finishedAt: Int?, updatedAt: Int) -> Bool {
    let at = Date(timeIntervalSince1970: Double(finishedAt ?? updatedAt) / 1000)
    return at > (seen[Self.key(env, sessionId)] ?? .distantPast)
  }
}

/// Projects pinned on this phone (11 §11.13). A small preference, so it
/// lives in the defaults under the Expo app's key, `mc.projects.pinned`.
@MainActor @Observable
public final class PinsStore {
  public static let defaultsKey = "mc.projects.pinned"

  public internal(set) var pins: [String] = [] {
    didSet { defaults?.set(pins, forKey: Self.defaultsKey) }
  }

  @ObservationIgnored private let defaults: UserDefaults?

  /// `defaults` nil keeps the pins in memory.
  public init(defaults: UserDefaults? = nil) {
    self.defaults = defaults
    pins = defaults?.stringArray(forKey: Self.defaultsKey) ?? []
  }

  public static func key(_ env: String, _ projectId: String) -> String { "\(env)/\(projectId)" }

  public func isPinned(_ env: String, _ projectId: String) -> Bool {
    pins.contains(Self.key(env, projectId))
  }

  public func toggle(_ env: String, _ projectId: String) {
    let key = Self.key(env, projectId)
    if let index = pins.firstIndex(of: key) { pins.remove(at: index) } else { pins.append(key) }
  }
}

/// One open session's window (12 §12.5, 06 §6.7), kept current by
/// `session.sync`. The apply pipeline runs off the main actor; this store
/// only publishes its results.
@MainActor @Observable
public final class SessionStore {
  public nonisolated let env: String
  public nonisolated let sessionId: String
  public internal(set) var value: HostSession?
  public internal(set) var window: WindowMeta?
  public internal(set) var freshness: Freshness = .cached
  public internal(set) var loadingOlder = false
  public internal(set) var error: String?

  @ObservationIgnored let pipeline: SessionPipeline
  /// Called off the main actor with every new window, before it is
  /// published here: the transcript's row builder hangs off it (step 4).
  @ObservationIgnored public var onWindow: (@Sendable (HostSession, WindowMeta?) -> Void)? {
    didSet { pipeline.setSink(onWindow) }
  }

  init(env: String, sessionId: String) {
    self.env = env
    self.sessionId = sessionId
    pipeline = SessionPipeline()
  }

  public var hasOlder: Bool { (window?.olderTurns ?? 0) > 0 }

  /// A block of the window as last synced (possibly truncated in transit).
  public func block(_ id: String) -> Block? {
    value?.session.blocks.first { $0.id == id }
  }

  /// A window from the cache: shown, but `cached` until the host answers.
  func paint(_ value: HostSession, _ window: WindowMeta?) {
    self.value = value
    self.window = window
    freshness = .cached
  }

  func publish(_ value: HostSession, _ window: WindowMeta?) {
    self.value = value
    self.window = window
    freshness = .live
    error = nil
  }
}

/// The ordered apply pipeline for one session: decode, `applySessionSync`,
/// publish. A serial queue of its own, so a large snapshot never applies on
/// the main thread.
final class SessionPipeline: @unchecked Sendable {
  private let queue = DispatchQueue(label: "dev.monocode.session-apply", qos: .userInitiated)
  private var value: HostSession?
  private var window: WindowMeta?
  private var sink: (@Sendable (HostSession, WindowMeta?) -> Void)?

  func setSink(_ sink: (@Sendable (HostSession, WindowMeta?) -> Void)?) {
    queue.async { self.sink = sink }
  }

  enum Outcome: Sendable {
    case applied(HostSession, WindowMeta?)
    case mismatch(anchor: String?)
    case ignored
  }

  /// Applies a sync in arrival order, off the main thread.
  func apply(_ sync: SessionSync) async -> Outcome {
    await withCheckedContinuation { done in
      queue.async {
        do {
          let next = try applySessionSync(self.value, sync)
          self.value = next
          if let window = sync.window { self.window = window }
          self.sink?(next, self.window)
          done.resume(returning: .applied(next, self.window))
        } catch SessionSyncError.chunked {
          done.resume(returning: .ignored)
        } catch {
          done.resume(returning: .mismatch(anchor: self.window?.anchor))
        }
      }
    }
  }

  /// Replaces the window, after an older page or a fresh snapshot.
  func replace(_ value: HostSession, _ window: WindowMeta?) async {
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      queue.async {
        self.value = value
        self.window = window
        self.sink?(value, window)
        done.resume()
      }
    }
  }

  func current() async -> (HostSession?, WindowMeta?) {
    await withCheckedContinuation { done in
      queue.async { done.resume(returning: (self.value, self.window)) }
    }
  }
}
