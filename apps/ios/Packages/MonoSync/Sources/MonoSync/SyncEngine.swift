import Foundation
import MonoWire
import Observation

/// The app's sync layer: the stores the screens read, and one `HostSync`
/// per machine writing them (12 §12.5, §12.7).
@MainActor @Observable
public final class SyncEngine {
  public let hosts = HostsStore()
  public let inbox = InboxStore()
  public let projects = ProjectsStore()
  public let catalogs = CatalogStore()
  public let seen = SeenStore()
  public let pins = PinsStore()

  @ObservationIgnored private var syncs: [String: HostSync] = [:]
  @ObservationIgnored private let app: String

  public init(app: String = "MonoCode") {
    self.app = app
  }

  public func host(_ env: String) -> HostSync? {
    syncs[env]
  }

  /// Adds a machine and connects to it.
  public func add(_ record: HostRecord, transport: any Transport) {
    guard syncs[record.env] == nil else { return }
    hosts.records.append(record)
    hosts.states[record.env] = .idle
    let hello = Hello(env: record.env, app: app, providers: ["claude", "codex", "cursor", "grok", "opencode", "pi", "omp", "fx", "hermes", "antigravity"])
    let sync = HostSync(record: record, transport: transport, hello: hello, engine: self)
    syncs[record.env] = sync
    sync.start()
  }

  public func remove(_ env: String) {
    syncs.removeValue(forKey: env)?.stop()
    hosts.records.removeAll { $0.env == env }
    hosts.states[env] = nil
    hosts.welcomes[env] = nil
    inbox.hosts[env] = nil
    projects.hosts[env] = nil
    catalogs.catalogs[env] = nil
  }

  /// Every machine's inbox, for the Agents tab and the root while active.
  public func watchInbox() -> Interest {
    let interests = syncs.values.map { $0.watchInbox() }
    return Interest { interests.forEach { $0.release() } }
  }

  /// Every machine's projects, for the Projects tab.
  public func loadProjects() {
    syncs.values.forEach { $0.loadProjects() }
  }
}
