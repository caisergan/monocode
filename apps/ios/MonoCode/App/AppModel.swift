import MonoDemo
import MonoSync
import SwiftUI

/// The app's long-lived objects: the sync engine and its stores, the
/// router, the pairing sheet's model, and the demo machine once someone
/// tries it.
@MainActor @Observable
final class AppModel {
  let engine: SyncEngine
  let router = Router()
  /// The presented pairing sheet (16 §16.6.9), nil when none is.
  var pairing: PairingFlow?
  @ObservationIgnored private(set) var demo: DemoHost?

  init() {
    #if DEBUG
    // `-MCReset YES` starts from a fresh install: no cache, pins or keys.
    if UserDefaults.standard.bool(forKey: "MCReset") { Self.resetLocalState() }
    #endif
    engine = SyncEngine(app: "MonoCode iOS", persistence: .onDevice(), defaults: .standard)
  }

  var hasMachines: Bool { !engine.hosts.records.isEmpty }

  /// Paired machines from the cache, the network monitor, and a pairing
  /// left waiting when the app went away.
  func launch() async {
    engine.startMonitoringNetwork()
    await engine.restore()
    await engine.resumePendingPairing()
  }

  /// Try the demo (11 §11.11): an in-app demo machine, marked `Demo`.
  /// Launch arguments for unattended runs: `-MCDemoOffline YES` makes it
  /// unreachable, `-MCDemoStill YES` keeps its live turns from starting.
  func tryDemo() {
    guard demo == nil else { return }
    do {
      let host = try DemoHost()
      demo = host
      let defaults = UserDefaults.standard
      engine.add(.demo, transport: DemoTransport(host: host, unreachable: defaults.bool(forKey: "MCDemoOffline")))
      if !defaults.bool(forKey: "MCDemoStill") { Task { await host.startLiveTurns() } }
    } catch {
      assertionFailure("the demo state did not load: \(error)")
    }
  }

  /// Opens the pairing sheet, at the review when a link came with it.
  func presentPairing(link: String? = nil) {
    pairing?.cancel()
    let flow = PairingFlow(engine: engine, phoneName: UIDevice.current.name)
    if let link { flow.read(link) }
    pairing = flow
  }

  /// A link the system opened: pairing links open the sheet (16 §16.6.2),
  /// the rest go to the router.
  func open(_ url: URL) {
    if Router.isPairingLink(url) {
      presentPairing(link: url.absoluteString)
    } else {
      router.open(url)
    }
  }

  /// Removes a machine; Welcome returns when it was the last.
  func remove(_ env: String) async {
    await engine.remove(env)
    if engine.hosts.record(env) == nil, demo != nil, env == DemoHost.env { demo = nil }
  }

  #if DEBUG
  private static func resetLocalState() {
    Persistence.eraseOnDevice()
    // Pins and the pairing sheet's preferences; launch arguments stay.
    if let domain = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: domain) }
  }
  #endif
}
