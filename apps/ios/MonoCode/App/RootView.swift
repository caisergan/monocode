import SwiftUI

/// The app's root. R0 has no tabs yet; the TabView arrives with R2 (16 §16.6.1).
struct RootView: View {
  var body: some View {
    NavigationStack {
      Color.clear
        .navigationTitle("MonoCode")
    }
  }
}

#Preview {
  RootView()
}
