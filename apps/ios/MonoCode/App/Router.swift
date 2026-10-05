import SwiftUI

enum AppTab: Hashable {
  case agents, projects, settings
}

/// Where a push goes (11 §11.10). `env` is the host's environment id.
enum Destination: Hashable {
  case project(env: String, projectId: String)
  case session(env: String, sessionId: String)
  case newSession(env: String?, projectId: String?)
  #if DEBUG
  case transcriptLab(LabRun?)
  case scrollEdgeControl
  case cardFling(run: Bool)
  #endif
}

/// Navigation state (16 §16.3): the selected tab and one path per tab. Deep
/// links and notification taps resolve into it.
@MainActor @Observable
final class Router {
  var tab: AppTab = .agents
  var agents: [Destination] = []
  var projects: [Destination] = []
  var settings: [Destination] = []

  /// Pushes onto the stack of the selected tab.
  func push(_ destination: Destination) {
    switch tab {
    case .agents: agents.append(destination)
    case .projects: projects.append(destination)
    case .settings: settings.append(destination)
    }
  }

  /// Selects a tab and replaces its path.
  func open(_ tab: AppTab, _ path: [Destination]) {
    self.tab = tab
    switch tab {
    case .agents: agents = path
    case .projects: projects = path
    case .settings: settings = path
    }
  }

  /// The debug links: `<scheme>://lab?run=…`, `<scheme>://scroll-edge`,
  /// `<scheme>://fling-cards`.
  func open(_ url: URL) {
    #if DEBUG
    switch url.host() {
    case "lab":
      let run = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "run" }?.value
      open(.settings, [.transcriptLab(run.flatMap(LabRun.init(rawValue:)))])
    case "scroll-edge":
      open(.settings, [.scrollEdgeControl])
    case "fling-cards":
      open(.settings, [.cardFling(run: url.query()?.contains("run=1") == true)])
    default:
      break
    }
    #endif
  }
}
