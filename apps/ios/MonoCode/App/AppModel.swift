import MonoDemo
import MonoSync
import SwiftUI

/// The app's long-lived objects: the sync engine and its stores, the
/// router, and the demo machine once someone tries it.
@MainActor @Observable
final class AppModel {
  let engine = SyncEngine(app: "MonoCode iOS")
  let router = Router()
  @ObservationIgnored private(set) var demo: DemoHost?

  var hasMachines: Bool { !engine.hosts.records.isEmpty }

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
}
