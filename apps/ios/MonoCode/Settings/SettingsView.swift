import MonoDesign
import SwiftUI

/// Settings (11 §11.21). A placeholder in R1: its pages arrive with the
/// milestones that need them. Debug builds list the debug screens.
struct SettingsView: View {
  @Environment(\.palette) private var palette

  var body: some View {
    List {
      Section {
        Text("Machines, appearance, notifications and chat settings arrive with the milestones that need them.")
          .font(.mono(Tokens.TypeScale.secondary))
          .foregroundStyle(palette.text.secondary.color)
          .listRowBackground(palette.fill.code.color)
      }
      #if DEBUG
      Section("Debug") {
        NavigationLink("Transcript Lab", value: Destination.transcriptLab(nil))
        NavigationLink("Scroll edge control", value: Destination.scrollEdgeControl)
        NavigationLink("Card fling (S19)", value: Destination.cardFling(run: false))
      }
      .listRowBackground(palette.fill.code.color)
      #endif
      Section {
        Text(version)
          .font(.mono(Tokens.TypeScale.meta))
          .foregroundStyle(palette.text.faint.color)
          .frame(maxWidth: .infinity)
          .listRowBackground(Color.clear)
      }
    }
    .scrollContentBackground(.hidden)
    .screenBackground()
    .navigationTitle("Settings")
    .toolbarTitleDisplayMode(.large)
  }

  private var version: String {
    let info = Bundle.main.infoDictionary
    let name = info?["CFBundleDisplayName"] as? String ?? "MonoCode"
    return "\(name) \(info?["CFBundleShortVersionString"] as? String ?? "")"
  }
}
