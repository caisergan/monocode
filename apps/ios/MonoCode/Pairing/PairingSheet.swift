import MonoDesign
import MonoSync
import SwiftUI
import VisionKit

/// The pairing sheet (16 §16.6.9, 11 §11.11): the stage machine in its own
/// stack at the large detent, each stage with its own title and a Cancel
/// button on the left.
struct PairingSheet: View {
  let flow: PairingFlow
  @Environment(AppModel.self) private var model
  @Environment(\.palette) private var palette
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        switch flow.stage {
        case .start, .failed(nil, _): PairStart(flow: flow)
        case .scan: PairScanner(flow: flow)
        case let .review(offer): PairReview(flow: flow, offer: offer)
        case let .connecting(offer): PairConnecting(host: offer.host)
        case let .confirm(offer, code, deadline): PairConfirm(host: offer.host, code: code, deadline: deadline)
        case let .paired(offer, env): PairDone(host: offer.host) { finish(env) }
        case let .failed(offer?, message): PairFailed(flow: flow, offer: offer, message: message)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background {
        if case .scan = flow.stage { Color.black.ignoresSafeArea() } else { palette.base.color.ignoresSafeArea() }
      }
      .navigationTitle(flow.stage.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          if case .paired = flow.stage {
            EmptyView()
          } else {
            Button("Cancel") {
              flow.cancel()
              dismiss()
            }
          }
        }
      }
      .toolbarBackground(scanning ? .hidden : .automatic, for: .navigationBar)
      .animation(Tokens.Motion.easeOut.animation(milliseconds: 200), value: flow.stage)
    }
    .presentationDetents([.large])
    .interactiveDismissDisabled(busy)
    .sensoryFeedback(trigger: flow.stage) { _, stage in
      switch stage {
      case .paired: .success
      case .failed: .warning
      default: nil
      }
    }
    .onDisappear { flow.cancel() }
  }

  private var scanning: Bool {
    if case .scan = flow.stage { true } else { false }
  }

  private var busy: Bool {
    switch flow.stage {
    case .connecting, .confirm: true
    default: false
    }
  }

  /// Done (04 §4.7 step 9): the first machine opens Agents, a later one its
  /// projects.
  private func finish(_ env: String) {
    let first = model.engine.hosts.records.filter { !$0.isDemo }.count <= 1
    model.pairing = nil
    if first {
      model.router.open(.agents, [])
    } else {
      model.router.open(.projects, [])
    }
  }
}

// MARK: Stages

/// How to pair (11 §11.11): the desktop and CLI routes, then Scan code and
/// Paste link. Paste is an explicit `PasteButton`: no clipboard snooping.
private struct PairStart: View {
  let flow: PairingFlow
  @Environment(\.palette) private var palette
  @State private var copied = false

  static let command = "monocode-host pair --mobile"

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("On your computer, open MonoCode → Settings → Mobile → Pair a phone. On a server, run:")
          .font(.mono(Tokens.TypeScale.row))
          .foregroundStyle(palette.text.secondary.color)
        HStack(spacing: 8) {
          Text(Self.command)
            .font(.mono(Tokens.TypeScale.code, design: .monospaced))
            .foregroundStyle(palette.content.color)
            .textSelection(.enabled)
          Spacer(minLength: 0)
          Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
            UIPasteboard.general.string = Self.command
            copied = true
          }
          .labelStyle(.iconOnly)
          .font(.system(size: 14))
          .foregroundStyle(palette.text.secondary.color)
          .accessibilityLabel(copied ? "Copied" : "Copy command")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(palette.fill.code.color, in: .rect(cornerRadius: Tokens.Radius.md))
        if let message = flow.linkError {
          Text(message)
            .font(.mono(Tokens.TypeScale.secondary))
            .foregroundStyle(palette.status.danger.color)
            .accessibilityIdentifier("pairing.error")
        }
      }
      .padding(20)
    }
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: 10) {
        if DataScannerViewController.isSupported {
          Button("Scan code") { flow.showScanner() }
            .buttonStyle(MonoButtonStyle(variant: .primary))
        } else {
          Text("This device can’t scan codes. Copy the link on your computer, then paste it here.")
            .font(.mono(Tokens.TypeScale.meta))
            .foregroundStyle(palette.text.faint.color)
            .multilineTextAlignment(.center)
        }
        PasteButton(payloadType: String.self) { strings in
          guard let text = strings.first else { return }
          Task { @MainActor in flow.read(text) }
        }
        .buttonBorderShape(.roundedRectangle(radius: Tokens.Radius.md))
        .controlSize(.large)
        .tint(palette.fill.bubble.color)
        .foregroundStyle(palette.content.color)
        .labelStyle(.titleAndIcon)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("pairing.paste")
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 12)
    }
  }
}

/// The scanner stage: `DataScannerViewController`, QR codes only, edge to
/// edge under a transparent bar, with the 240 pt frame (11 §11.11).
private struct PairScanner: View {
  let flow: PairingFlow
  @State private var torch = false

  var body: some View {
    ZStack {
      QRScanner { text in flow.read(text) }
        .ignoresSafeArea()
      RoundedRectangle(cornerRadius: Tokens.Radius.lg)
        .stroke(Color.white.opacity(0.7), lineWidth: 2)
        .frame(width: 240, height: 240)
        .accessibilityHidden(true)
    }
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button(torch ? "Torch off" : "Torch on", systemImage: torch ? "flashlight.on.fill" : "flashlight.off.fill") {
          torch.toggle()
          Torch.set(torch)
        }
      }
    }
    .onDisappear { Torch.set(false) }
  }
}

/// "Connect to {host}?" (11 §11.11): fingerprint, reach, the phone's name,
/// the access warning, then Connect. A LAN offer first explains the local
/// network prompt the connection triggers (04 §4.7 step 3).
private struct PairReview: View {
  @Bindable var flow: PairingFlow
  let offer: PairingOffer
  @Environment(\.palette) private var palette
  @AppStorage("mc.pairing.localNetworkExplained") private var explained = false
  @State private var explaining = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        if explaining {
          Text("To connect directly when you’re on the same Wi-Fi as \(offer.host), MonoCode needs access to your local network.")
            .font(.mono(Tokens.TypeScale.row))
            .foregroundStyle(palette.text.secondary.color)
            .accessibilityIdentifier("pairing.localNetwork")
        } else {
          SettingsGroup {
            SettingsRow(label: "Fingerprint") {
              Text(offer.fingerprint)
                .font(.mono(Tokens.TypeScale.secondary, design: .monospaced))
                .foregroundStyle(palette.content.color)
                .multilineTextAlignment(.trailing)
            }
            SettingsDivider()
            SettingsRow(label: "Reachable through") {
              Text(offer.reachable)
                .font(.mono(Tokens.TypeScale.secondary))
                .foregroundStyle(palette.text.secondary.color)
            }
            SettingsDivider()
            SettingsRow(label: "Phone name") {
              TextField("iPhone", text: $flow.phoneName)
                .font(.mono(Tokens.TypeScale.secondary))
                .multilineTextAlignment(.trailing)
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
            }
          }
          Text("This phone will be able to run agents and read files on \(offer.host) with the same access as its user account.")
            .font(.mono(Tokens.TypeScale.secondary))
            .foregroundStyle(palette.text.tertiary.color)
          if offer.expired {
            Text("This code may have expired. If pairing fails, generate a new one on \(offer.host).")
              .font(.mono(Tokens.TypeScale.secondary))
              .foregroundStyle(palette.status.attention.color)
          }
        }
      }
      .padding(20)
    }
    .safeAreaInset(edge: .bottom) {
      Button(explaining ? "Continue" : "Connect") {
        if !explaining && !explained && offer.reachable.contains("Local network") {
          explaining = true
          return
        }
        explained = true
        flow.connect()
      }
      .buttonStyle(MonoButtonStyle(variant: .primary))
      .sensoryFeedback(.impact(weight: .medium), trigger: flow.stage)
      .padding(.horizontal, 20)
      .padding(.bottom, 12)
    }
  }
}

private struct PairConnecting: View {
  let host: String
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(spacing: 16) {
      ProgressView()
        .controlSize(.large)
      Text("Connecting to \(host)…")
        .font(.mono(Tokens.TypeScale.row))
        .foregroundStyle(palette.text.secondary.color)
        .multilineTextAlignment(.center)
    }
    .padding(28)
  }
}

/// The code large, grouped "482 913", and a 2:00 countdown (11 §11.11).
private struct PairConfirm: View {
  let host: String
  let code: String
  let deadline: Date
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(spacing: 18) {
      Text("\(code.prefix(3)) \(code.dropFirst(3))")
        .font(.system(size: 34, weight: .medium, design: .monospaced))
        .tracking(34 * 0.08)
        .foregroundStyle(palette.content.color)
        .accessibilityLabel(code.map(String.init).joined(separator: " "))
        .accessibilityIdentifier("pairing.code")
      Text("Check that \(host) shows the same code, then allow the connection there.")
        .font(.mono(Tokens.TypeScale.row))
        .foregroundStyle(palette.text.secondary.color)
        .multilineTextAlignment(.center)
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let left = max(0, Int(deadline.timeIntervalSince(context.date).rounded()))
        Text(String(format: "%d:%02d", left / 60, left % 60))
          .font(.mono(Tokens.TypeScale.caption))
          .monospacedDigit()
          .foregroundStyle(palette.text.faint.color)
      }
    }
    .padding(28)
  }
}

/// A check that bounces in `status.done`, with the success haptic.
private struct PairDone: View {
  let host: String
  let done: () -> Void
  @Environment(\.palette) private var palette
  @State private var bounce = false

  var body: some View {
    VStack(spacing: 16) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 56))
        .foregroundStyle(palette.status.done.color)
        .symbolEffect(.bounce, value: bounce)
        .accessibilityHidden(true)
      Text("\(host) is ready.")
        .font(.mono(Tokens.TypeScale.emptyHeading, .medium))
        .foregroundStyle(palette.content.color)
        .multilineTextAlignment(.center)
    }
    .padding(28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onAppear { bounce = true }
    .safeAreaInset(edge: .bottom) {
      Button("Continue", action: done)
        .buttonStyle(MonoButtonStyle(variant: .primary))
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }
  }
}

private struct PairFailed: View {
  let flow: PairingFlow
  let offer: PairingOffer
  let message: String
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 36))
        .foregroundStyle(palette.status.danger.color)
        .accessibilityHidden(true)
      Text(message)
        .font(.mono(Tokens.TypeScale.row))
        .foregroundStyle(palette.text.secondary.color)
        .multilineTextAlignment(.center)
        .accessibilityIdentifier("pairing.error")
    }
    .padding(28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: 8) {
        Button("Try again") { flow.retry() }
          .buttonStyle(MonoButtonStyle(variant: .primary))
        Button("Use a new code") { flow.backToStart() }
          .buttonStyle(MonoButtonStyle(variant: .ghost))
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 12)
    }
  }
}
