import MonoDesign
import MonoSync
import SwiftUI

/// The desktop's settings `Group` card (11 §11.21): `r.lg`, a α .10 border,
/// `fill.composer`. SwiftUI's `Form` is not used (16 §16.6.8).
struct SettingsGroup<Content: View>: View {
  var title: String?
  @ViewBuilder var content: Content
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let title {
        Text(title)
          .font(.mono(Tokens.TypeScale.secondary, .medium))
          .foregroundStyle(palette.text.secondary.color)
          .padding(.horizontal, 4)
          .accessibilityAddTraits(.isHeader)
      }
      VStack(spacing: 0) { content }
        .background(palette.fill.composer.color, in: .rect(cornerRadius: Tokens.Radius.lg))
        .overlay {
          RoundedRectangle(cornerRadius: Tokens.Radius.lg).strokeBorder(palette.border.default.color, lineWidth: 1)
          .allowsHitTesting(false)
        }
    }
  }
}

/// A `Row`: a 15 / 500 label, an optional 13 pt α .45 description, and the
/// control or value at the trailing edge.
struct SettingsRow<Trailing: View>: View {
  var label: String
  var detail: String?
  @ViewBuilder var trailing: Trailing
  @Environment(\.palette) private var palette

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(label)
          .font(.mono(Tokens.TypeScale.row, .medium))
          .foregroundStyle(palette.content.color)
        if let detail {
          Text(detail)
            .font(.mono(Tokens.TypeScale.secondary))
            .foregroundStyle(palette.text.tertiary.color)
        }
      }
      Spacer(minLength: 8)
      trailing
    }
    .padding(.horizontal, 14)
    .frame(minHeight: 48)
    .padding(.vertical, 4)
    // The whole row takes the tap, spacer included.
    .contentShape(.rect)
  }
}

extension SettingsRow where Trailing == EmptyView {
  init(label: String, detail: String? = nil) {
    self.init(label: label, detail: detail) { EmptyView() }
  }
}

/// A value on a row's trailing edge.
struct RowValue: View {
  var text: String
  var mono = false
  @Environment(\.palette) private var palette

  var body: some View {
    Text(text)
      .font(.mono(Tokens.TypeScale.secondary, design: mono ? .monospaced : .default))
      .foregroundStyle(palette.text.secondary.color)
      .multilineTextAlignment(.trailing)
      .lineLimit(3)
      .textSelection(.enabled)
  }
}

struct SettingsDivider: View {
  @Environment(\.palette) private var palette

  var body: some View {
    Rectangle().fill(palette.stroke.color).frame(height: 1).padding(.leading, 14)
  }
}

/// A page heading (22 / 600) and its description (13 pt α .45).
struct PageHeading: View {
  var title: String
  var detail: String?
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.mono(Tokens.TypeScale.pageHeading, .semibold))
        .foregroundStyle(palette.content.color)
        .accessibilityAddTraits(.isHeader)
      if let detail {
        Text(detail)
          .font(.mono(Tokens.TypeScale.secondary))
          .foregroundStyle(palette.text.tertiary.color)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A machine's status and transport in the desktop's words (11 §11.21).
enum MachineStatus {
  static func status(_ state: HostConnState?, providers: [String]?) -> String {
    switch state {
    case .online?:
      providers?.isEmpty == true ? "Connected · install a supported provider on the host" : "Connected"
    case .offline?: "Offline"
    case let .blocked(reason)?:
      switch reason {
      case .deviceRevoked, .unknownDevice: "This phone was removed"
      case .hostIdentityChanged: "Can’t verify this machine"
      case .protocolIncompatible, .appTooOld: "Update the host to use this app"
      }
    case .connecting?, .reconnecting?, .idle?, nil: "Checking connection…"
    }
  }

  /// "Direct · Wi-Fi · 24 ms" while online.
  static func transport(_ state: HostConnState?) -> String? {
    guard case let .online(kind, endpoint, rtt, _)? = state else { return nil }
    switch kind {
    case .demo: return "In this app"
    case .relay: return "Relay · \(rtt) ms"
    case .direct:
      let parts = endpoint.split(separator: "|").map(String.init)
      let via: String =
        switch parts.first {
        case "lan"?: "Wi-Fi"
        case "tailscale"?: "Tailscale"
        default: parts.count > 1 ? parts[1] : "Direct"
        }
      return "Direct · \(via) · \(rtt) ms"
    }
  }

  static func isBlocked(_ state: HostConnState?) -> Bool {
    if case .blocked? = state { true } else { false }
  }
}
