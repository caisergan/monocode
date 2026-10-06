import MonoSync
import SwiftUI

@main
struct MonoCodeApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .environment(model.engine)
        .environment(model.router)
        .preferredColorScheme(ThemeSetting.current.scheme)
        .task {
          await model.launch()
          // `-MCDemo YES` starts on the demo, for screenshots and UI tests.
          if UserDefaults.standard.bool(forKey: "MCDemo") { model.tryDemo() }
        }
        .onChange(of: scenePhase) { _, phase in
          // Background closes channels, foreground verifies or races (05 §5.10).
          switch phase {
          case .active: model.engine.scenePhaseChanged(.active)
          case .background: model.engine.scenePhaseChanged(.background)
          default: model.engine.scenePhaseChanged(.inactive)
          }
        }
    }
  }
}
