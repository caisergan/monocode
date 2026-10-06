import MonoDesign
import SwiftUI

/// A section label in the desktop rail's style (11 §11.12): 13 pt at α .50,
/// with an optional pulsing dot.
struct SectionLabel: View {
  var title: String
  var dot: Color?
  @Environment(\.palette) private var palette

  var body: some View {
    HStack(spacing: 7) {
      if let dot { PulsingDot(color: dot) }
      Text(title)
        .font(.mono(Tokens.TypeScale.secondary, .medium))
        .foregroundStyle(palette.text.secondary.color)
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 2)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityAddTraits(.isHeader)
  }
}

/// The desktop's pulsing accent dot with its glow (`0 0 8 accent`).
struct PulsingDot: View {
  var color: Color
  @State private var dim = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 6, height: 6)
      .shadow(color: color, radius: 4)
      .opacity(dim ? 0.45 : 1)
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
      }
  }
}

/// The desktop's remote notice bar (`RemoteSession.tsx`): 12 pt at α .65 over
/// a `stroke` bottom border, with one action.
struct NoticeBar: View {
  var text: String
  var action: (label: String, run: () -> Void)?
  @Environment(\.palette) private var palette

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(text)
        .font(.mono(Tokens.TypeScale.meta))
        .foregroundStyle(palette.contentAlpha(0.65).color)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let action {
        Button(action.label, action: action.run)
          .font(.mono(Tokens.TypeScale.meta, .medium))
          .foregroundStyle(palette.contentAlpha(0.8).color)
          .buttonStyle(.plain)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 9)
    .overlay(alignment: .bottom) { Rectangle().fill(palette.stroke.color).frame(height: 1) }
  }
}

/// MonoCode's buttons (11 §11.4): primary (`#fff` on black in dark, content
/// with base text in light), secondary (`fill.bubble`) and ghost. Pressed
/// is scale 0.97; disabled is α .40.
struct MonoButtonStyle: ButtonStyle {
  enum Variant { case primary, secondary, ghost }
  var variant: Variant
  @Environment(\.palette) private var palette
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.mono(Tokens.TypeScale.row, .medium))
      .foregroundStyle(foreground)
      .frame(maxWidth: .infinity, minHeight: 44)
      .background(background(pressed: configuration.isPressed), in: .rect(cornerRadius: Tokens.Radius.md))
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .opacity(enabled ? 1 : 0.4)
      .animation(Tokens.Motion.easeOut.animation(milliseconds: Tokens.Motion.feedbackMs), value: configuration.isPressed)
  }

  private var foreground: Color {
    switch variant {
    case .primary: palette.primaryText.color
    case .secondary, .ghost: palette.content.color
    }
  }

  private func background(pressed: Bool) -> Color {
    switch variant {
    case .primary: palette.primary.color
    case .secondary: palette.fill.bubble.color
    case .ghost: pressed ? palette.selection.hover.color : .clear
    }
  }
}

/// A centred empty state with the desktop's copy (11 §11.14).
struct EmptyState: View {
  var title: String
  var detail: String?
  var action: (label: String, run: () -> Void)?
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(spacing: 10) {
      Text(title)
        .font(.mono(Tokens.TypeScale.row))
        .foregroundStyle(palette.text.secondary.color)
        .multilineTextAlignment(.center)
      if let detail {
        Text(detail)
          .font(.mono(Tokens.TypeScale.secondary))
          .foregroundStyle(palette.text.faint.color)
          .multilineTextAlignment(.center)
      }
      if let action {
        Button(action.label, action: action.run)
          .buttonStyle(MonoButtonStyle(variant: .ghost))
          .fixedSize()
      }
    }
    .padding(.horizontal, 28)
    .frame(maxWidth: .infinity)
  }
}

/// The desktop's empty-session backdrop: a faint dot grid.
struct DotGrid: View {
  @Environment(\.palette) private var palette

  var body: some View {
    Canvas { context, size in
      let step: CGFloat = 16
      var path = Path()
      var y: CGFloat = step / 2
      while y < size.height {
        var x: CGFloat = step / 2
        while x < size.width {
          path.addEllipse(in: CGRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5))
          x += step
        }
        y += step
      }
      context.fill(path, with: .color(palette.contentAlpha(0.09).color))
    }
    .accessibilityHidden(true)
  }
}

/// The `Demo` tag (11 §11.11): caption on `fill.chip`.
struct DemoTag: View {
  @Environment(\.palette) private var palette

  var body: some View {
    Text("Demo")
      .font(.mono(Tokens.TypeScale.caption, .medium))
      .foregroundStyle(palette.text.secondary.color)
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .background(palette.fill.chip.color, in: .rect(cornerRadius: Tokens.Radius.xs))
  }
}
