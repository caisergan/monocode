import Foundation
import MonoChannel
import MonoKeychain
import MonoStore
import MonoWire
import Testing

@testable import MonoSync

/// The Swift client against a real TypeScript host (16 §16.5 check 3):
/// `node build/host/monocode-host.mjs` in a fresh temporary data directory,
/// paired with `pair --mobile --yes --json`, then a handshake, `projects.list`,
/// a watch, a host restart with reconnect, and a revoke. Run it with
/// `swift test --filter Interop` after `npm run host:build`; it skips when the
/// host bundle is absent. It never touches `~/.monocode-host`.
@Suite(.serialized) @MainActor
struct InteropTests {
  @Test(.timeLimit(.minutes(3))) func pairsListsWatchesSurvivesRestartAndRevoke() async throws {
    guard let host = try TestHost.make() else { return }
    defer { host.stop() }
    try host.start()

    // Pairing: the CLI shows the offer, then approves the claim (--yes).
    let pairing = try host.spawnPair()
    defer { pairing.terminate() }
    let link = try await host.readOfferLink(from: pairing)
    let offer = try parseOfferLink(link)
    let keychain = Keychain(backend: InMemoryKeychain())
    let codes = Codes()
    let (record, _) = try await Pairer.pair(
      offer, phoneName: "Interop", info: ClientInfo(version: "0.1.0", build: "1", os: "26.0", model: "test"),
      keychain: keychain, path: .unknown
    ) { code, _ in await codes.add(code) }
    #expect(record.env == offer.env)
    #expect(record.fingerprint == hostFingerprint(offer.hostKey))
    #expect(!record.endpoints.isEmpty)
    #expect(try keychain.deviceKey(env: offer.env) != nil)
    #expect(try keychain.data(.pendingPairing) == nil)
    let claimed = try await host.output(of: pairing, containing: "\"status\":\"claimed\"")
    #expect(claimed.contains(await codes.first ?? "none"), "the CLI saw another confirmation code")

    // The runtime opens its own channel with the device key: the handshake.
    let database = try CacheDatabase(url: host.directory.appending(path: "phone/monocode.sqlite"))
    let engine = SyncEngine(
      app: "Interop", info: ClientInfo(version: "0.1.0", build: "1", os: "26.0", model: "test"),
      persistence: Persistence(database: database, keychain: keychain))
    engine.addPaired(record)
    let env = record.env
    try await until("online") { engine.hosts.states[env]?.isOnline == true }
    let firstBoot = try #require(engine.hosts.welcomes[env]?.boot)
    #expect(engine.hosts.welcomes[env]?.device.id == record.deviceId)
    #expect(try await database.loadHost(env: env)?.deviceId == record.deviceId)
    let sync = try #require(engine.host(env))

    // projects.list, after opening a folder as a project.
    let folder = host.directory.appending(path: "my-project")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    struct Open: Encodable, Sendable { var cwd: String }
    let opened: HostProject = try await sync.runtime.request("projects.open", Open(cwd: folder.path), key: UUID().uuidString)
    #expect(opened.name == "my-project")
    engine.loadProjects()
    try await until("projects.list") { engine.projects.hosts[env]?.projects.contains { $0.id == opened.id } == true }
    try await until("projects cached") { (try? await database.loadProjects(env: env))?.isEmpty == false }

    // A watch: the inbox and the project's session list.
    let inbox = engine.watchInbox()
    defer { inbox.release() }
    try await until("inbox.list") { engine.inbox.hosts[env] != nil }
    let list = sync.openList(opened.id, archived: .exclude)
    defer { list.release() }
    let key = ProjectsStore.ListKey(env: env, projectId: opened.id, archived: .exclude)
    try await until("sessions.page") { engine.projects.lists[key]?.list?.cached == false }

    // A host restart: the channel drops, the runtime reconnects by itself.
    try host.stopHost()
    try await until("dropped") { engine.hosts.states[env]?.isOnline == false }
    try host.start()
    try await until("reconnected", timeout: .seconds(60)) {
      engine.hosts.states[env]?.isOnline == true && engine.hosts.welcomes[env]?.boot != firstBoot
    }
    let projects: [HostProject] = try await sync.runtime.request("projects.list", [String: String]())
    #expect(projects.contains { $0.id == opened.id })
    #expect(await sync.runtime.verify())

    // A revoke closes the channel with device_revoked: blocked, no retries.
    try host.cli("revoke", record.deviceId)
    try await until("revoked") { engine.hosts.states[env] == .blocked(.deviceRevoked) }
    try await Task.sleep(for: .seconds(2))
    #expect(engine.hosts.states[env] == .blocked(.deviceRevoked))
    #expect(engine.hosts.notice(env) == "This phone was removed from \(record.label).")
  }

  @Test(.timeLimit(.minutes(1))) func aWrongHostKeyNeverPairs() async throws {
    guard let host = try TestHost.make() else { return }
    defer { host.stop() }
    try host.start()
    let pairing = try host.spawnPair()
    defer { pairing.terminate() }
    var offer = try parseOfferLink(try await host.readOfferLink(from: pairing))
    offer.key = KeyPair.generate().publicKey.base64URL
    await #expect(throws: PairingError.self) {
      _ = try await Pairer.pair(
        offer, phoneName: "Interop", info: ClientInfo(version: "0.1.0", build: "1", os: "26.0", model: "test"),
        keychain: Keychain(backend: InMemoryKeychain()), path: .unknown) { _, _ in }
    }
  }

  private func until(
    _ what: String, timeout: Duration = .seconds(30), _ condition: @MainActor () async -> Bool
  ) async throws {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    Issue.record("timed out waiting for \(what)")
    throw CancellationError()
  }
}

private actor Codes {
  private(set) var all: [String] = []
  var first: String? { all.first }
  func add(_ code: String) { all.append(code) }
}

/// A host in a temporary data directory, on free ports.
private final class TestHost: @unchecked Sendable {
  let directory: URL
  let node: String
  let bundle: URL
  let port: Int
  let directPort: Int

  /// Nil (and the test skipped, with the reason printed) without a host build.
  static func make() throws -> TestHost? {
    let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../..").standardized
    let bundle = repo.appending(path: "build/host/monocode-host.mjs")
    guard FileManager.default.fileExists(atPath: bundle.path) else {
      print("Interop skipped: \(bundle.path) is absent. Run `npm run host:build` at the repo root first.")
      return nil
    }
    let directory = FileManager.default.temporaryDirectory.appending(path: "monocode-interop-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let host = TestHost(directory: directory, bundle: bundle, port: try freePort(), directPort: try freePort())
    // Direct connections on every interface (so loopback works), with
    // 127.0.0.1 advertised next to the LAN and Tailscale addresses.
    let config = """
      {"v":1,"direct":{"mode":"all","port":\(host.directPort),"advertise":[{"addr":"127.0.0.1","port":\(host.directPort)}]},
       "push":{"enabled":false}}
      """
    try config.write(to: directory.appending(path: "config.json"), atomically: true, encoding: .utf8)
    return host
  }

  private init(directory: URL, bundle: URL, port: Int, directPort: Int) {
    self.directory = directory
    self.bundle = bundle
    self.port = port
    self.directPort = directPort
    node = ProcessInfo.processInfo.environment["MC_NODE"] ?? "node"
  }

  private func process(_ arguments: [String]) -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [node, bundle.path] + arguments + ["--data-dir", directory.path, "--port", String(port)]
    var environment = ProcessInfo.processInfo.environment
    environment["NODE_NO_WARNINGS"] = "1"
    process.environment = environment
    return process
  }

  /// Runs a CLI command to completion; throws on a non-zero exit.
  @discardableResult
  func cli(_ arguments: String...) throws -> String {
    let process = process(arguments)
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self)
    guard process.terminationStatus == 0 else {
      throw InteropError("`\(arguments.joined(separator: " "))` exited \(process.terminationStatus): \(text)")
    }
    return text
  }

  func start() throws {
    try cli("start")
  }

  func stopHost() throws {
    try cli("stop")
    // `stop` returns once the host is asked to; wait for its pid to go.
    let deadline = Date().addingTimeInterval(10)
    while FileManager.default.fileExists(atPath: directory.appending(path: "running.json").path), Date() < deadline {
      Thread.sleep(forTimeInterval: 0.1)
    }
  }

  /// Stops the host even if a test failed, then deletes the directory.
  func stop() {
    _ = try? cli("stop")
    if let data = try? Data(contentsOf: directory.appending(path: "running.json")),
      let running = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let pid = running["pid"] as? Int32
    {
      kill(pid, SIGTERM)
    }
    try? FileManager.default.removeItem(at: directory)
  }

  private var outputs: [ObjectIdentifier: Pipe] = [:]
  private var buffers: [ObjectIdentifier: String] = [:]
  private let lock = NSLock()

  func spawnPair() throws -> Process {
    let process = process(["pair", "--mobile", "--yes", "--json"])
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    let id = ObjectIdentifier(process)
    lock.withLock { buffers[id] = "" }
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let text = String(decoding: handle.availableData, as: UTF8.self)
      self?.lock.withLock { self?.buffers[id, default: ""] += text }
    }
    try process.run()
    outputs[id] = pipe
    return process
  }

  /// Waits for a line of `process`'s output containing `text`.
  func output(of process: Process, containing text: String, timeout: TimeInterval = 15) async throws -> String {
    let id = ObjectIdentifier(process)
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      let buffer = lock.withLock { buffers[id] ?? "" }
      if let line = buffer.split(separator: "\n").first(where: { $0.contains(text) }) { return String(line) }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw InteropError("no output containing \(text): \(lock.withLock { buffers[id] ?? "" })")
  }

  func readOfferLink(from process: Process) async throws -> String {
    let line = try await output(of: process, containing: "\"url\"")
    let object = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    guard let url = object?["url"] as? String else { throw InteropError("no url in \(line)") }
    return url
  }
}

private struct InteropError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// A port nothing listens on now: bind to port 0 and read it back.
private func freePort() throws -> Int {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  defer { close(fd) }
  var address = sockaddr_in()
  address.sin_family = sa_family_t(AF_INET)
  address.sin_addr.s_addr = inet_addr("127.0.0.1")
  address.sin_port = 0
  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  let bound = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) }
  }
  guard bound == 0 else { throw InteropError("bind failed") }
  _ = withUnsafeMutablePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
  }
  return Int(UInt16(bigEndian: address.sin_port))
}
