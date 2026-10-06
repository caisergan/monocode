import Foundation
import MonoWire
import Synchronization

@testable import MonoStore

/// A clock the test moves by hand.
final class TestClock: Sendable {
  private let value = Mutex(Date(timeIntervalSince1970: 1_800_000_000))

  var now: Date { value.withLock { $0 } }

  func advance(_ seconds: TimeInterval) {
    value.withLock { $0 = $0.addingTimeInterval(seconds) }
  }
}

/// A cache on a fresh file under the scratch directory.
func makeCache(limits: CacheLimits = CacheLimits(), clock: TestClock = TestClock(),
               migrations: [Schema.Migration] = Schema.migrations) throws -> CacheDatabase {
  try CacheDatabase(url: scratchURL(), limits: limits, now: { clock.now }, migrations: migrations)
}

func scratchURL() -> URL {
  FileManager.default.temporaryDirectory
    .appendingPathComponent("monostore-\(UUID().uuidString)")
    .appendingPathComponent(CacheDatabase.fileName)
}

func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
  try JSONDecoder().decode(type, from: Data(json.utf8))
}

func sessionItem(_ id: String, projectId: String = "p1", updatedAt: Int) throws -> SessionListItem {
  try decode(
    SessionListItem.self,
    """
    {"projectId":"\(projectId)","revision":3,"status":"idle","updatedAt":\(updatedAt),"id":"\(id)",
     "title":"Session \(id)","harness":"claude","lastText":"done"}
    """)
}

func hostSession(_ id: String, text: String = "hello") -> HostSession {
  let session = Session(
    id: id, harness: "claude", model: "opus", runtimeMode: "default", title: "Session \(id)", cwd: "/repo",
    blocks: [Block(id: "b1", role: "user", text: text)])
  return HostSession(session: session, projectId: "p1", revision: 7, status: "idle", updatedAt: 1_800_000_000_000)
}

/// A window whose JSON is about `bytes` long.
func window(_ id: String, bytes: Int) -> CachedWindow {
  CachedWindow(
    revision: 7, value: hostSession(id, text: String(repeating: "x", count: max(0, bytes - 400))),
    window: WindowMeta(anchor: "b1", olderTurns: 0, olderBlocks: 0))
}

func hostRecord(_ env: String) -> HostRecord {
  HostRecord(
    env: env, label: "Studio", color: "blue", hostName: "studio.local", platform: "darwin", fingerprint: "AB:CD",
    hostKey: "aG9zdC1rZXk", deviceId: "dev-1", role: .admin,
    endpoints: [
      HostEndpoint(kind: .lan, addr: "192.168.1.4", port: 3775),
      HostEndpoint(kind: .tailscale, addr: "100.64.0.2", port: 3775, dns: "studio.tail.ts.net"),
    ],
    relay: HostRecord.RelayInfo(url: "wss://relay.example", room: "room-1"), pushEnabled: true,
    pairedAt: Date(timeIntervalSince1970: 1_800_000_000.123), lastOnlineAt: Date(timeIntervalSince1970: 1_800_000_100),
    lastWelcome: HostRecord.WelcomeSummary(
      host: Welcome.Host(name: "studio", platform: "darwin", version: "1.4.0", fingerprint: "AB:CD"),
      capabilities: ["windowedSync"], providers: ["claude"],
      limits: Welcome.Limits(maxMessage: 1_048_576, maxInFlight: 8, maxWatchedSessions: 8)),
    notifications: NotificationPrefs(
      categories: NotificationPrefs.Categories(finished: false), preview: .minimal, mutedProjects: ["p2"],
      mutedSessions: ["s9"]))
}

func outboxRow(_ commandId: String, env: String = "h1", sessionKey: String?) -> OutboxRow {
  OutboxRow(
    commandId: commandId, env: env, sessionKey: sessionKey, json: #"{"kind":"send"}"#, state: "pending",
    createdAt: Date(timeIntervalSince1970: 1_800_000_000), expiresAt: Date(timeIntervalSince1970: 1_800_086_400))
}
