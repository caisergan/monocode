import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// Machine details (11 §11.21): the label, its status, connection, this
/// phone and the advanced values, and Remove with the native alert. A
/// removed phone or a changed host shows its red state first (04 §4.9).
struct MachineDetailsView: View {
  let env: String
  @Environment(AppModel.self) private var model
  @Environment(SyncEngine.self) private var engine
  @Environment(Router.self) private var router
  @Environment(\.palette) private var palette
  @State private var confirmRemove = false
  @State private var renaming = false
  @State private var label = ""

  var body: some View {
    Group {
      if let record = engine.hosts.record(env) {
        content(record)
      } else {
        EmptyState(title: "This machine was removed.")
      }
    }
    .screenBackground()
    .navigationTitle(engine.hosts.record(env)?.label ?? "Machine")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func content(_ record: HostRecord) -> some View {
    let state = engine.hosts.states[env]
    let welcome = engine.hosts.welcomes[env]
    return ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        HStack(spacing: 10) {
          Circle()
            .fill(Tokens.projectColors[record.colorIndex % Tokens.projectColors.count].color)
            .frame(width: 12, height: 12)
            .accessibilityHidden(true)
          Text(record.label)
            .font(.mono(Tokens.TypeScale.pageHeading, .semibold))
            .foregroundStyle(palette.content.color)
          if record.isDemo { DemoTag() }
          Spacer()
          if !record.isDemo {
            Button("Rename") {
              label = record.label
              renaming = true
            }
            .font(.mono(Tokens.TypeScale.secondary, .medium))
          }
        }
        if MachineStatus.isBlocked(state), let notice = engine.hosts.notice(env) {
          blocked(notice, state: state)
        }
        SettingsGroup(title: "Connection") {
          SettingsRow(label: "Status") {
            RowValue(text: MachineStatus.status(state, providers: welcome?.providers))
          }
          if let transport = MachineStatus.transport(state) {
            SettingsDivider()
            SettingsRow(label: "Transport") { RowValue(text: transport) }
          }
          if let version = welcome?.host.version ?? record.lastWelcome?.host.version {
            SettingsDivider()
            SettingsRow(label: "Version") { RowValue(text: version) }
          }
          SettingsDivider()
          SettingsRow(label: "Last seen") { RowValue(text: lastSeen(record, state: state)) }
        }
        if !record.isDemo {
          SettingsGroup(title: "This phone") {
            SettingsRow(label: "Paired") { RowValue(text: record.pairedAt.formatted(date: .abbreviated, time: .shortened)) }
            SettingsDivider()
            SettingsRow(label: "Role") { RowValue(text: record.role == .admin ? "Admin" : "Member") }
          }
          SettingsGroup(title: "Advanced") {
            SettingsRow(label: "Fingerprint") { RowValue(text: record.fingerprint, mono: true) }
            SettingsDivider()
            SettingsRow(label: "Environment") { RowValue(text: record.env, mono: true) }
            SettingsDivider()
            SettingsRow(label: "Endpoints") {
              RowValue(
                text: record.endpoints.isEmpty
                  ? "None" : record.endpoints.map { "\($0.addr):\($0.port)" }.joined(separator: "\n"), mono: true)
            }
          }
        }
        Button("Remove", role: .destructive) { confirmRemove = true }
          .buttonStyle(MonoButtonStyle(variant: .secondary))
          .foregroundStyle(palette.status.danger.color)
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 24)
    }
    .alert("Remove \(record.label) from this phone?", isPresented: $confirmRemove) {
      Button("Cancel", role: .cancel) {}
      Button("Remove from this phone", role: .destructive) {
        router.open(.settings, [.machines])
        Task { await model.remove(env) }
      }
    } message: {
      Text("This phone loses access. The host keeps running and your sessions stay on it.")
    }
    .alert("Rename machine", isPresented: $renaming) {
      TextField("Name", text: $label)
      Button("Cancel", role: .cancel) {}
      Button("Save") { engine.rename(env, label: label) }
    }
  }

  /// "This phone was removed from {machine}." with Pair again and Remove.
  private func blocked(_ notice: String, state: HostConnState?) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(notice)
        .font(.mono(Tokens.TypeScale.secondary, .medium))
        .foregroundStyle(palette.status.danger.color)
        .accessibilityIdentifier("machine.blocked")
      if case .blocked(.protocolIncompatible)? = state {
        EmptyView()
      } else {
        HStack(spacing: 8) {
          Button("Pair again") { model.presentPairing() }
            .buttonStyle(MonoButtonStyle(variant: .primary))
          Button("Remove") { confirmRemove = true }
            .buttonStyle(MonoButtonStyle(variant: .secondary))
        }
      }
    }
    .padding(14)
    .background(palette.status.danger.color.opacity(0.08), in: .rect(cornerRadius: Tokens.Radius.lg))
    .overlay {
      RoundedRectangle(cornerRadius: Tokens.Radius.lg).strokeBorder(palette.status.danger.color.opacity(0.35), lineWidth: 1)
          .allowsHitTesting(false)
    }
  }

  private func lastSeen(_ record: HostRecord, state: HostConnState?) -> String {
    if state?.isOnline == true { return "Now" }
    guard let at = engine.hosts.lastOnline[env] ?? record.lastOnlineAt else { return "Never" }
    return HostStatus.lastSeen(at)
  }
}
