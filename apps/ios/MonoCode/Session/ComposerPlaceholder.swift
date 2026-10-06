import MonoDesign
import SwiftUI

/// The composer's place on the session screen (16 §16.6.4): the glass box,
/// its top bar, prompt and chips at their real sizes, so the transcript's
/// layout is right. It does nothing; the composer itself is R3.
struct ComposerPlaceholder: View {
  var branch: String?
  var worktree: Bool
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: worktree ? "folder.badge.gearshape" : "folder").font(.system(size: 12))
        Text(worktree ? "Worktree" : "Current checkout")
        if let branch {
          Image(systemName: "arrow.triangle.branch").font(.system(size: 11))
          Text(branch).font(.mono(Tokens.TypeScale.meta, design: .monospaced)).lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      .font(.mono(Tokens.TypeScale.meta))
      .foregroundStyle(palette.text.secondary.color)
      Text("Ask, build, / for commands...")
        .font(.mono(Tokens.TypeScale.composer))
        .foregroundStyle(palette.text.faint.color)
        .frame(maxWidth: .infinity, minHeight: Tokens.TypeScale.composer.line, alignment: .leading)
      HStack(spacing: 6) {
        chip { Image(systemName: "plus").font(.system(size: 12, weight: .semibold)) }
        chip {
          HStack(spacing: 4) {
            Image(systemName: "diamond.fill").font(.system(size: 8))
            Text("Opus 4.6 · High")
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
          }
        }
        chip {
          HStack(spacing: 4) {
            Image(systemName: "lock").font(.system(size: 10))
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
          }
        }
        Spacer()
        Image(systemName: "arrow.up")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(palette.primaryText.color)
          .frame(width: 30, height: 30)
          .background(palette.primary.color.opacity(0.4), in: .circle)
      }
    }
    .padding(12)
    .glassEffect(.regular, in: .rect(cornerRadius: Tokens.Radius.md))
    .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.md).strokeBorder(palette.border.default.color))
    .padding(.horizontal, 12)
    .padding(.bottom, 4)
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Composer. Sending messages from the phone arrives with the write path.")
  }

  private func chip(@ViewBuilder _ label: () -> some View) -> some View {
    label()
      .font(.mono(Tokens.TypeScale.meta, .medium))
      .foregroundStyle(palette.text.secondary.color)
      .padding(.horizontal, 9)
      .frame(height: 26)
      .background(palette.fill.chip.color, in: .capsule)
  }
}
