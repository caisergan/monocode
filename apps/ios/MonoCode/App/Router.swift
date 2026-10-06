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
  #if DEBUG
  /// A block whose tool sheet the next session screen opens (debug links).
  var debugTool: String?
  #endif

  /// The session screen hides the tab bar (M16), and the accessory with it.
  var sessionOnTop: Bool {
    let path: [Destination] = switch tab {
    case .agents: agents
    case .projects: projects
    case .settings: settings
    }
    if case .session? = path.last { return true }
    return false
  }

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
  /// `<scheme>://fling-cards`, `<scheme>://session?id=…&tool=…`.
  func open(_ url: URL) {
    #if DEBUG
    switch url.host() {
    case "lab":
      let run = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "run" }?.value
      open(.settings, [.transcriptLab(run.flatMap(LabRun.init(rawValue:)))])
    case "scroll-edge":
      open(.settings, [.scrollEdgeControl])
    case "session":
      // `<scheme>://session?env=…&id=…`; the demo machine when env is absent.
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      guard let id = items.first(where: { $0.name == "id" })?.value else { return }
      let env = items.first(where: { $0.name == "env" })?.value ?? "00000000-0000-4000-8000-00000000d3e0"
      debugTool = items.first(where: { $0.name == "tool" })?.value
      open(.agents, [.session(env: env, sessionId: id)])
    case "fling-cards":
      open(.settings, [.cardFling(run: url.query()?.contains("run=1") == true)])
    default:
      break
    }
    #endif
  }
}
