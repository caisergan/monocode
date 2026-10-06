import MonoDesign
import MonoWire
import SwiftUI

/// The bottom of the session screen (16 §16.6.4). Reading back folds the
/// composer to a capsule with the jump to latest beside it, in one glass
/// container so the two sit as a pair; turning back, reaching the end, a
/// waiting approval or a tap opens it. Open, the jump floats over the
/// transcript instead (SessionView): a bar takes no touches outside itself.
struct SessionBottomBar: View {
  var branch: String?
  var worktree: Bool
  var chips: ComposerChips
  var collapsed: Bool
  var jumpVisible: Bool
  var jump: () -> Void
  var expand: () -> Void
  /// The composer's own height, for the transcript's bottom inset.
  var onComposerHeight: (CGFloat) -> Void
  @Environment(\.palette) private var palette
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GlassEffectContainer(spacing: 10) {
      HStack(alignment: .bottom, spacing: 10) {
        ComposerPlaceholder(branch: branch, worktree: worktree, chips: chips, collapsed: collapsed, expand: expand)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onComposerHeight($0 + 4) }
        if collapsed && jumpVisible {
          JumpToLatest(waiting: false, size: 44, action: jump)
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.6)))
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 4)
    // Rows don't show under the box: the base fades in over the bar's top
    // half and fills the rest down to the screen's edge.
    .background {
      VStack(spacing: 0) {
        LinearGradient(colors: [palette.base.color.opacity(0), palette.base.color], startPoint: .top, endPoint: .bottom)
        palette.base.color
      }
      .ignoresSafeArea(edges: .bottom)
      .allowsHitTesting(false)
    }
    .animation(reduceMotion ? .easeInOut(duration: 0.15) : ComposerMotion.spring, value: collapsed)
    .animation(JumpToLatest.pop, value: jumpVisible)
  }
}

/// What the chip row shows and does (11 §11.17): `+`, the model chip, the
/// access chip and Plan or Draft, as the desktop composer draws them.
struct ComposerChips {
  var harness: String
  var model: String
  var effort: String?
  var access: AccessMode
  var mode: ComposerDraft.Mode?
  /// The context window's fill, when the harness reports both halves.
  var context: ContextUsage?
  var add: () -> Void
  var pickModel: () -> Void
  var pickAccess: () -> Void
  var clearMode: () -> Void
  var showContext: () -> Void
}

/// The composer on the session screen (16 §16.6.4): the glass box, its top
/// bar, the prompt and the desktop's chip row. The chips open their sheets;
/// typing and sending are the write path (R3, S20), so the prompt is still a
/// placeholder and Send stays disabled. Folded, it is a 44 pt capsule with
/// the prompt and the send button, and a tap opens it.
struct ComposerPlaceholder: View {
  var branch: String?
  var worktree: Bool
  var chips: ComposerChips
  var collapsed = false
  var expand: () -> Void = {}
  @Environment(\.palette) private var palette
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Namespace private var parts

  private var radius: CGFloat { collapsed ? 22 : Tokens.Radius.md }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !collapsed { topBar.transition(fold) }
      HStack(spacing: 8) {
        Text("Ask, build, / for commands...")
          .font(.mono(Tokens.TypeScale.composer))
          .foregroundStyle(palette.text.faint.color)
          .lineLimit(1)
          .frame(maxWidth: .infinity, minHeight: Tokens.TypeScale.composer.line, alignment: .leading)
          .accessibilityLabel("Message")
          .accessibilityHint("Typing from the phone arrives with the write path.")
        if collapsed { send }
      }
      if !collapsed { chipRow.transition(fold) }
    }
    // Folded, the send button sits 7 pt from the capsule's edge, concentric
    // with its 22 pt corners.
    .padding(.leading, collapsed ? 16 : 12)
    .padding(.trailing, collapsed ? 7 : 12)
    .padding(.vertical, collapsed ? 7 : 12)
    .clipShape(.rect(cornerRadius: radius))
    // The desktop's box: `fill.composer` over the opaque base, not the grey
    // that plain glass turns over the transcript. The glass keeps its edge
    // and the morph into the jump button.
    .background(palette.fill.composer.color, in: .rect(cornerRadius: radius))
    .glassEffect(.regular.tint(palette.base.color), in: .rect(cornerRadius: radius))
    .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(palette.border.default.color))
    // Every tap on the box stays in it: none reaches the rows beneath.
    .contentShape(.rect(cornerRadius: radius))
    .onTapGesture { if collapsed { expand() } }
    .accessibilityElement(children: collapsed ? .ignore : .contain)
    .accessibilityLabel(collapsed ? "Composer" : "")
    .accessibilityAddTraits(collapsed ? .isButton : [])
    .accessibilityHint(collapsed ? "Opens the composer" : "")
  }

  /// The rows that leave fade out quickly, before the box finishes
  /// shrinking; on the way back they fade in once there is room.
  private var fold: AnyTransition {
    reduceMotion
      ? .opacity
      : .asymmetric(
        insertion: .opacity.animation(.easeOut(duration: 0.18).delay(0.1)),
        removal: .opacity.animation(.easeOut(duration: 0.12)))
  }

  /// The desktop's identity row: the working copy, its branch, and the
  /// context ring at the right (11 §11.17 "Top bar").
  private var topBar: some View {
    HStack(spacing: 6) {
      Image(systemName: worktree ? "folder.badge.gearshape" : "folder").font(.system(size: 12))
      Text(worktree ? "Worktree" : "Current checkout").lineLimit(1)
      if let branch {
        HStack(spacing: 4) {
          Image(systemName: "arrow.triangle.branch").font(.system(size: 11))
          Text(branch).lineLimit(1).truncationMode(.middle)
        }
        .padding(.leading, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Branch \(branch)")
      }
      Spacer(minLength: 8)
      if let context = chips.context, let ratio = ContextMeter.ratio(context) {
        Button(action: chips.showContext) {
          ContextMeter(ratio: ratio, size: 16)
            .frame(width: 20, height: 16)
            .contentShape(.interaction, Rectangle().inset(by: -12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ContextMeter.headline(context))
        .accessibilityValue(ContextMeter.detail(context))
        .accessibilityHint("Shows context usage")
      }
    }
    .font(.mono(Tokens.TypeScale.meta))
    .foregroundStyle(palette.text.secondary.color)
  }

  /// The desktop's row: `+`, the model chip (harness mark, name, effort at
  /// α .50), the access chip (mode icon, label), then Send.
  private var chipRow: some View {
    ViewThatFits(in: .horizontal) {
      chipRow(accessLabel: true)
      chipRow(accessLabel: false)
    }
  }

  private func chipRow(accessLabel: Bool) -> some View {
    HStack(spacing: 6) {
      chip(action: chips.add, label: "Add to message") {
        Image(systemName: "plus").font(.system(size: 13, weight: .regular))
          .frame(width: 16)
      }
      chip(action: chips.pickModel, label: "Model, \(chips.model)\(chips.effort.map { ", effort \($0)" } ?? "")") {
        HStack(spacing: 5) {
          HarnessMark(harness: chips.harness, size: 15)
          Text(shortName).foregroundStyle(palette.content.color).lineLimit(1)
            .fixedSize(horizontal: accessLabel, vertical: false)
          if let effort = chips.effort {
            Text(effort).foregroundStyle(palette.text.secondary.color).lineLimit(1).fixedSize()
          }
          chevron
        }
      }
      chip(action: chips.pickAccess, label: "Access, \(chips.access.label)") {
        HStack(spacing: 5) {
          AccessIcon(mode: chips.access, size: 14)
          if chips.mode == nil && accessLabel {
            Text(chips.access.label).foregroundStyle(palette.content.color).lineLimit(1)
          }
          chevron
        }
        .fixedSize()
      }
      .layoutPriority(1)
      if let mode = chips.mode {
        chip(action: chips.clearMode, label: "\(mode == .plan ? "Plan" : "Draft") mode. Remove") {
          HStack(spacing: 4) {
            Image(systemName: mode == .plan ? "lightbulb" : "circle.dashed").font(.system(size: 11))
            Text(mode == .plan ? "Plan" : "Draft")
            Image(systemName: "xmark").font(.system(size: 8, weight: .semibold))
          }
          .foregroundStyle(mode == .plan ? palette.status.attention.color : palette.text.secondary.color)
        }
      }
      Spacer(minLength: 0)
      if !collapsed { send }
    }
  }

  /// "Opus 4.6" for "Claude Opus 4.6": the mark beside it names the
  /// harness, as on the desktop's chip.
  private var shortName: String {
    let prefix = chips.harness.prefix(1).uppercased() + chips.harness.dropFirst() + " "
    return chips.model.hasPrefix(prefix) && chips.model.count > prefix.count ? String(chips.model.dropFirst(prefix.count)) : chips.model
  }

  private var chevron: some View {
    Image(systemName: "chevron.down")
      .font(.system(size: 9, weight: .semibold))
      .foregroundStyle(palette.text.secondary.color)
  }

  /// One send button that travels between the chip row and the capsule:
  /// the desktop's 32 pt square, disabled until there is something to send.
  private var send: some View {
    Image(systemName: "arrow.up")
      .font(.system(size: 14, weight: .bold))
      .foregroundStyle(palette.base.color)
      .frame(width: 30, height: 30)
      .background(palette.content.color.opacity(0.4), in: .rect(cornerRadius: Tokens.Radius.sm))
      .matchedGeometryEffect(id: "send", in: parts)
      .accessibilityElement()
      .accessibilityLabel("Send")
      .accessibilityAddTraits([.isButton])
      .accessibilityValue("Unavailable")
  }

  /// A 28 pt chip in a 44 pt hit area: `r.sm`, the selection fill.
  private func chip(action: @escaping () -> Void, label: String, @ViewBuilder _ content: () -> some View) -> some View {
    Button(action: action) {
      content()
        .font(.mono(Tokens.TypeScale.secondary))
        .padding(.horizontal, 8)
        .frame(minWidth: 28, minHeight: 28)
        .background(palette.selection.normal.color, in: .rect(cornerRadius: Tokens.Radius.sm))
        .contentShape(.interaction, Rectangle().inset(by: -8))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

/// An access mode's icon; Full access is the amber shield (α .90).
struct AccessIcon: View {
  var mode: AccessMode
  var size: CGFloat
  @Environment(\.palette) private var palette

  var body: some View {
    Image(systemName: mode.symbol)
      .font(.system(size: size))
      .foregroundStyle(mode == .fullAccess ? palette.status.attention.color.opacity(0.9) : palette.text.secondary.color)
      .accessibilityHidden(true)
  }
}

/// The composer folding to a capsule and back: one interruptible spring,
/// shared by the SwiftUI bar and the UIKit transcript inset under it.
enum ComposerMotion {
  static let duration: TimeInterval = 0.35
  static let bounce: Double = 0.12
  static let spring = Animation.spring(duration: duration, bounce: bounce)
}
