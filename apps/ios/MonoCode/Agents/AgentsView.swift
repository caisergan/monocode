import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// Agents (11 §11.12), the cross-machine home. Welcome until a machine exists.
struct AgentsView: View {
  @Environment(AppModel.self) private var model
  @Environment(SyncEngine.self) private var engine

  var body: some View {
    Group {
      if model.hasMachines {
        List(engine.inbox.items) { agent in
          NavigationLink(agent.item.title, value: Destination.session(env: agent.env, sessionId: agent.item.sessionId))
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
      } else {
        WelcomeView()
      }
    }
    .screenBackground()
    .navigationTitle("Agents")
    .toolbarTitleDisplayMode(.large)
    .task(id: model.hasMachines) {
      guard model.hasMachines else { return }
      let interest = engine.watchInbox()
      await Task.untilCancelled()
      interest.release()
    }
  }
}

extension Task where Success == Never, Failure == Never {
  /// Suspends until the surrounding task is cancelled, e.g. when the view
  /// that ran `.task` goes away.
  static func untilCancelled() async {
    while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
  }
}
