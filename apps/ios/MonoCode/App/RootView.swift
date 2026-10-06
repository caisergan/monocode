import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// The app's root (16 §16.6.1): three tabs, each with its own stack, and the
/// bottom accessory.
struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(SyncEngine.self) private var engine
  @Environment(Router.self) private var router

  var body: some View {
    @Bindable var router = router
    @Bindable var model = model
    TabView(selection: $router.tab) {
      Tab("Agents", systemImage: "bubble.left.and.text.bubble.right", value: AppTab.agents) {
        TabStack(path: $router.agents) { AgentsView() }
      }
      .badge(engine.inbox.needsInput)
      Tab("Projects", systemImage: "folder", value: AppTab.projects) {
        TabStack(path: $router.projects) { ProjectsView() }
      }
      Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
        TabStack(path: $router.settings) { SettingsView() }
      }
    }
    .tabBarMinimizeBehavior(.onScrollDown)
    .modifier(BottomAccessory(enabled: model.hasMachines && !router.sessionOnTop))
    .modifier(MonoTheme())
    .onOpenURL { model.open($0) }
    .sheet(item: $model.pairing) { flow in
      PairingSheet(flow: flow)
        .modifier(MonoTheme())
    }
    #if DEBUG
    .task {
      // `simctl launch <device> com.monocode.mobile.dev -MCOpen <url>` opens a
      // link without the system's open-URL prompt.
      if let url = UserDefaults.standard.string(forKey: "MCOpen").flatMap(URL.init(string:)) { model.open(url) }
    }
    #endif
  }
}

/// One tab's `NavigationStack` and its typed destinations (16 §16.6.2).
struct TabStack<Root: View>: View {
  @Binding var path: [Destination]
  @ViewBuilder var root: Root

  var body: some View {
    NavigationStack(path: $path) {
      root.navigationDestination(for: Destination.self) { $0.view }
    }
  }
}

extension Destination {
  @ViewBuilder var view: some View {
    switch self {
    case let .project(env, projectId): ProjectView(env: env, projectId: projectId)
    case let .session(env, sessionId): SessionView(env: env, sessionId: sessionId)
    case let .newSession(env, projectId): NewSessionView(env: env, projectId: projectId)
    case let .file(env, projectId, cwd, path, line): FileView(env: env, projectId: projectId, cwd: cwd, path: path, line: line)
    case .machines: MachinesView()
    case let .machine(env): MachineDetailsView(env: env)
    #if DEBUG
    case let .transcriptLab(run): TranscriptLabView(run: run)
    case .scrollEdgeControl: ScrollEdgeControlView()
    case let .cardFling(run): CardFlingView(autorun: run)
    #endif
    }
  }
}

/// The accessory only once a machine exists; iOS 26.0 cannot hide it.
private struct BottomAccessory: ViewModifier {
  var enabled: Bool

  func body(content: Content) -> some View {
    if #available(iOS 26.1, *) {
      content.tabViewBottomAccessory(isEnabled: enabled) { NewSessionAccessory() }
    } else {
      content.tabViewBottomAccessory { NewSessionAccessory() }
    }
  }
}

/// "＋ New session" and "N working" in one control (16 §16.6.1): the desktop's
/// New session button and its Working card. Minimised, only the count.
struct NewSessionAccessory: View {
  @Environment(\.tabViewBottomAccessoryPlacement) private var placement
  @Environment(\.palette) private var palette
  @Environment(SyncEngine.self) private var engine
  @Environment(Router.self) private var router

  var body: some View {
    let working = engine.inbox.working
    HStack(spacing: 10) {
      if placement != .inline {
        Button {
          router.push(.newSession(env: nil, projectId: nil))
        } label: {
          Label("New session", systemImage: "plus")
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(palette.content.color)
        }
        .buttonStyle(.plain)
        Spacer(minLength: 8)
      }
      Button {
        router.open(.agents, [])
      } label: {
        HStack(spacing: 6) {
          if working > 0 {
            BrailleSpinner(color: palette.accent.color, size: 13)
            Text("\(working) working")
              .font(.system(size: 13))
              .monospacedDigit()
              .foregroundStyle(palette.content.color)
          } else {
            Text("Nothing running")
              .font(.system(size: 13))
              .foregroundStyle(palette.content.color.opacity(0.45))
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(working > 0 ? "\(working) working. Show agents" : "Nothing running")
    }
    .padding(.horizontal, 16)
  }
}
