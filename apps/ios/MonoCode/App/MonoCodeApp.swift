import SwiftUI

@main
struct MonoCodeApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .environment(model.engine)
        .environment(model.router)
        .preferredColorScheme(ThemeSetting.current.scheme)
        .task {
          // `-MCDemo YES` starts on the demo, for screenshots and UI tests.
          if UserDefaults.standard.bool(forKey: "MCDemo") { model.tryDemo() }
        }
    }
  }
}
