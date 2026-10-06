import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// Settings → Machines (11 §11.21): the phone's version of the desktop's
/// Settings → Connections.
struct MachinesView: View {
  @Environment(AppModel.self) private var model
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        PageHeading(
          title: "Your machines",
          detail: "Agents run on your computers. MonoCode keeps working on them when your phone is away.")
        if engine.hosts.records.isEmpty {
          Text("Pair a computer to get started.")
            .font(.mono(Tokens.TypeScale.secondary))
            .foregroundStyle(palette.text.tertiary.color)
            .frame(maxWidth: .infinity, minHeight: 88)
            .overlay {
              RoundedRectangle(cornerRadius: Tokens.Radius.lg)
                .strokeBorder(palette.border.dashed.color, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
          .allowsHitTesting(false)
            }
        } else {
          SettingsGroup {
            ForEach(Array(engine.hosts.records.enumerated()), id: \.element.env) { index, record in
              if index > 0 { SettingsDivider() }
              NavigationLink(value: Destination.machine(env: record.env)) {
                MachineSettingsRow(record: record)
              }
              .buttonStyle(.plain)
            }
          }
        }
        Button("Pair a machine") { model.presentPairing() }
          .buttonStyle(MonoButtonStyle(variant: .secondary))
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 24)
    }
    .screenBackground()
    .navigationTitle("Machines")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// A `MachineRow` in Settings: the globe, the name, the transport line and
/// the status.
struct MachineSettingsRow: View {
  var record: HostRecord
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette

  var body: some View {
    let state = engine.hosts.states[record.env]
    HStack(spacing: 12) {
      Image(systemName: record.isDemo ? "play.rectangle" : "globe")
        .font(.system(size: 17))
        .foregroundStyle(palette.text.secondary.color)
        .frame(width: 24)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(record.label)
            .font(.mono(Tokens.TypeScale.row, .medium))
            .foregroundStyle(palette.content.color)
            .lineLimit(1)
          if record.isDemo { DemoTag() }
        }
        if let transport = MachineStatus.transport(state) {
          Text(transport)
            .font(.mono(Tokens.TypeScale.secondary))
            .foregroundStyle(palette.text.tertiary.color)
        }
        Text(MachineStatus.status(state, providers: engine.hosts.welcomes[record.env]?.providers))
          .font(.mono(Tokens.TypeScale.secondary))
          .foregroundStyle(
            MachineStatus.isBlocked(state) ? palette.status.danger.color : palette.text.secondary.color)
      }
      Spacer(minLength: 8)
      Chevron()
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("machine.row")
  }
}
