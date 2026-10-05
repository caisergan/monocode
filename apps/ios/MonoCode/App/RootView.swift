import MonoDesign
import SwiftUI

/// The app's root. R0 has no tabs yet; the TabView arrives with R2 (16 §16.6.1).
struct RootView: View {
  @State private var path: [DebugRoute] = []

  var body: some View {
    NavigationStack(path: $path) {
      List {
        #if DEBUG
        Section("Debug") {
          NavigationLink("Transcript Lab", value: DebugRoute.transcriptLab(nil))
          NavigationLink("Scroll edge control", value: DebugRoute.scrollEdgeControl)
        }
        #endif
      }
      .navigationTitle("MonoCode")
      #if DEBUG
      .navigationDestination(for: DebugRoute.self) { route in
        route.destination
      }
      #endif
    }
    .tint(Tokens.dark.accent.color)
    .preferredColorScheme(.dark)
    .onOpenURL { url in
      if let route = DebugRoute(url: url) { path = [route] }
    }
    #if DEBUG
    .task {
      // `simctl launch <device> com.monocode.mobile.dev -MCOpen <url>` opens a
      // debug link without the system's open-URL prompt.
      if let route = UserDefaults.standard.string(forKey: "MCOpen").flatMap(URL.init(string:)).flatMap(DebugRoute.init(url:)) {
        path = [route]
      }
    }
    #endif
  }
}

/// Debug screens. `<scheme>://lab?run=huge-stream` opens the Lab and runs a
/// scenario unattended, as the Expo app's `lab` route did.
/// `<scheme>://scroll-edge` opens the scroll-edge control.
enum DebugRoute: Hashable {
  #if DEBUG
  case transcriptLab(LabRun?)
  case scrollEdgeControl
  #endif

  init?(url: URL) {
    #if DEBUG
    switch url.host() {
    case "lab":
      let run = URLComponents(url: url, resolvingAgainstBaseURL: false)?
        .queryItems?.first { $0.name == "run" }?.value
      self = .transcriptLab(run.flatMap(LabRun.init(rawValue:)))
    case "scroll-edge":
      self = .scrollEdgeControl
    default:
      return nil
    }
    #else
    return nil
    #endif
  }

  @ViewBuilder var destination: some View {
    #if DEBUG
    switch self {
    case let .transcriptLab(run): TranscriptLabView(run: run)
    case .scrollEdgeControl: ScrollEdgeControlView()
    }
    #endif
  }
}

#Preview {
  RootView()
}
