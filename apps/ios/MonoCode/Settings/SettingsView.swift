import MonoDesign
import MonoSync
import SwiftUI

/// Settings (11 §11.21, 16 §16.6.8): a large title, then MonoCode `Group`
/// cards that push pages within the Settings stack. R2 has Machines; the
/// other pages arrive with the milestones that need them. Debug builds list
/// the debug screens.
struct SettingsView: View {
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        SettingsGroup(title: "App") {
          NavigationLink(value: Destination.machines) {
            SettingsRow(label: "Machines", detail: machinesDetail) { Chevron() }
          }
          .buttonStyle(.plain)
        }
        #if DEBUG
        SettingsGroup(title: "Debug") {
          NavigationLink(value: Destination.transcriptLab(nil)) { SettingsRow(label: "Transcript Lab") { Chevron() } }
          SettingsDivider()
          NavigationLink(value: Destination.scrollEdgeControl) { SettingsRow(label: "Scroll edge control") { Chevron() } }
          SettingsDivider()
          NavigationLink(value: Destination.cardFling(run: false)) { SettingsRow(label: "Card fling (S19)") { Chevron() } }
        }
        .buttonStyle(.plain)
        #endif
        Text(version)
          .font(.mono(Tokens.TypeScale.meta))
          .foregroundStyle(palette.text.faint.color)
          .frame(maxWidth: .infinity)
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 24)
    }
    .screenBackground()
    .navigationTitle("Settings")
    .toolbarTitleDisplayMode(.large)
  }

  private var machinesDetail: String {
    let count = engine.hosts.records.count
    return count == 0 ? "None paired" : count == 1 ? "1 machine" : "\(count) machines"
  }

  private var version: String {
    let info = Bundle.main.infoDictionary
    let name = info?["CFBundleDisplayName"] as? String ?? "MonoCode"
    return "\(name) \(info?["CFBundleShortVersionString"] as? String ?? "")"
  }
}

struct Chevron: View {
  @Environment(\.palette) private var palette

  var body: some View {
    Image(systemName: "chevron.right")
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(palette.text.faint.color)
      .accessibilityHidden(true)
  }
}
