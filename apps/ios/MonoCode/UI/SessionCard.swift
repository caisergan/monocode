import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// What a session card shows, from an inbox row or a `sessions.page` item
/// (apps/mobile/src/ui/SessionCard.tsx).
struct CardItem: Hashable, Identifiable {
  var env: String
  var sessionId: String
  var title: String
  var harness: String
  var model: String
  var status: SessionStatus
  var attention: AttentionKind?
  var pinned: Bool
  var draft: Bool
  var unseen: Bool
  var updatedAt: Int
  /// The third line: where the session runs.
  var project: String?
  var machine: String?
  var branch: String?
  var lastLine: String?
  /// An extra line (Agents): the approval, or the last reply.
  var detail: (text: String, attention: Bool)?
  var workItem: String?
  var providerSessionId: String?

  var id: String { "\(env)/\(sessionId)" }

  static func == (a: CardItem, b: CardItem) -> Bool {
    a.id == b.id && a.title == b.title && a.model == b.model && a.status == b.status && a.attention == b.attention
      && a.pinned == b.pinned && a.draft == b.draft && a.unseen == b.unseen && a.updatedAt == b.updatedAt
      && a.project == b.project && a.branch == b.branch && a.lastLine == b.lastLine && a.detail?.text == b.detail?.text
      && a.workItem == b.workItem
  }

  func hash(into hasher: inout Hasher) {
    hasher.combine(id)
  }

  var needsInput: Bool { attention == .approval || attention == .question }

  /// `cardFromInbox`: Agents rows add the project and machine, and the
  /// approval or the last reply.
  static func inbox(_ agent: AgentItem, machine: String, model: String, unseen: Bool) -> CardItem {
    let item = agent.item
    let needs = item.attention.needsInput
    let detail: (String, Bool)? =
      needs && item.approval != nil
      ? ("Approve: \(item.approval!.title)", true)
      : item.lastText.flatMap { item.status == .running || item.attention.kind == .finished ? ($0, false) : nil }
    return CardItem(
      env: agent.env, sessionId: item.sessionId, title: item.title, harness: item.harness, model: model,
      status: item.status, attention: item.attention.kind, pinned: item.pinned == true, draft: false, unseen: unseen,
      updatedAt: item.updatedAt, project: item.projectName, machine: machine, branch: item.branch,
      lastLine: item.lastText, detail: detail, workItem: nil, providerSessionId: nil)
  }

  /// `cardFromSession`: the inbox row, when the session has a current one,
  /// knows the attention reason the summary lacks. Sessions outside the
  /// inbox's week show their time, never a stale "Done".
  static func session(_ env: String, _ item: SessionListItem, inbox: InboxItem?, model: String, unseen: Bool) -> CardItem {
    let live = inbox.map { $0.revision >= item.revision } ?? false
    let attention: AttentionKind? = live ? inbox?.attention.kind : item.needsInput == true ? .approval : nil
    return CardItem(
      env: env, sessionId: item.id, title: item.title, harness: item.harness, model: model,
      status: live ? inbox!.status : item.status, attention: attention, pinned: item.pinned == true,
      draft: item.draft == true, unseen: unseen, updatedAt: max(item.updatedAt, inbox?.updatedAt ?? 0), project: nil,
      machine: nil, branch: item.branch, lastLine: item.lastText, detail: nil,
      workItem: item.linkedWorkItem.map { "#\($0.number)" }, providerSessionId: item.providerSessionId)
  }
}

/// "now", "5m", "2h 10m", "3d", "Oct 3" (11 §11.14).
func relativeTime(_ at: Int, now: Date = Date()) -> String {
  let minutes = Int((now.timeIntervalSince1970 * 1000 - Double(at)) / 60_000)
  if minutes < 1 { return "now" }
  if minutes < 60 { return "\(minutes)m" }
  let hours = minutes / 60
  if hours < 24 { return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h \(minutes % 60)m" }
  let days = hours / 24
  if days < 7 { return "\(days)d" }
  return Date(timeIntervalSince1970: Double(at) / 1000).formatted(.dateTime.month(.abbreviated).day())
}

/// The desktop session card at mobile sizes (11 §11.14). Its height is fixed
/// from the type scale, never from layout (15 §15.3).
struct SessionCard: View {
  var card: CardItem
  @Environment(\.palette) private var palette

  static let padY: CGFloat = 10
  static let gap: CGFloat = 3

  static func height(detail: Bool) -> CGFloat {
    let lines = [Tokens.TypeScale.meta.line, Tokens.TypeScale.row.line, Tokens.TypeScale.meta.line]
      + (detail ? [Tokens.TypeScale.secondary.line] : [])
    return 2 + padY * 2 + lines.reduce(0, +) + gap * CGFloat(lines.count - 1)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Self.gap) {
      HStack(spacing: 6) {
        HarnessMark(harness: card.harness, size: 14)
        Text(card.model)
          .font(.mono(Tokens.TypeScale.meta))
          .foregroundStyle(palette.text.secondary.color)
          .lineLimit(1)
        Spacer(minLength: 8)
        StatusSlot(card: card)
      }
      .frame(height: Tokens.TypeScale.meta.line)
      HStack(spacing: 5) {
        if card.pinned {
          Image(systemName: "pin.fill")
            .font(.system(size: 11))
            .foregroundStyle(palette.text.tertiary.color)
            .accessibilityLabel("Pinned")
        }
        Text(card.title)
          .font(.mono(Tokens.TypeScale.row, .semibold))
          .foregroundStyle(palette.contentAlpha(0.9).color)
          .lineLimit(1)
      }
      .frame(height: Tokens.TypeScale.row.line)
      if let detail = card.detail {
        Text(detail.text)
          .font(.mono(Tokens.TypeScale.secondary))
          .foregroundStyle(detail.attention ? palette.status.attention.color : palette.text.tertiary.color)
          .lineLimit(1)
          .frame(height: Tokens.TypeScale.secondary.line)
      }
      HStack(spacing: 4) {
        WhereLine(card: card)
        Spacer(minLength: 8)
        if let workItem = card.workItem {
          Text(workItem)
            .font(.mono(Tokens.TypeScale.meta))
            .monospacedDigit()
            .foregroundStyle(palette.accent.color)
        }
      }
      .frame(height: Tokens.TypeScale.meta.line)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, Self.padY)
    .frame(height: Self.height(detail: card.detail != nil), alignment: .top)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(card.needsInput ? palette.contentAlpha(0.04).color : .clear, in: .rect(cornerRadius: Tokens.Radius.sm))
    .overlay {
      if card.needsInput || card.draft {
        RoundedRectangle(cornerRadius: Tokens.Radius.sm)
          .strokeBorder(
            card.needsInput ? palette.border.dashed.color : palette.contentAlpha(0.25).color,
            style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
      }
    }
    .contentShape(.rect(cornerRadius: Tokens.Radius.sm))
    .accessibilityElement(children: .combine)
  }
}

/// The third line: "my-app · Demo · ⑂ fix/auth", or the last reply.
private struct WhereLine: View {
  var card: CardItem
  @Environment(\.palette) private var palette

  var body: some View {
    let color = palette.text.tertiary.color
    let lead = [card.project, card.machine].compactMap { $0 }.joined(separator: " · ")
    HStack(spacing: 4) {
      if !lead.isEmpty {
        Text(card.branch == nil ? lead : lead + " ·")
      }
      if let branch = card.branch {
        Image(systemName: "arrow.triangle.branch").font(.system(size: 10))
        Text(branch)
      } else if lead.isEmpty, let last = card.lastLine {
        Text(last)
      }
    }
    .font(.mono(Tokens.TypeScale.meta))
    .foregroundStyle(color)
    .lineLimit(1)
  }
}

/// The status slot, with the desktop's priority and wording (11 §11.14).
struct StatusSlot: View {
  var card: CardItem
  @Environment(\.palette) private var palette

  var body: some View {
    HStack(spacing: 4) {
      if card.needsInput {
        Image(systemName: "exclamationmark.circle").font(.system(size: 12, weight: .medium))
        Text(card.attention == .question ? "Needs input" : "Need approval")
      } else if card.status == .running {
        BrailleSpinner(color: palette.accent.color, size: 12)
        Text("Working...")
      } else if card.attention == .error || card.attention == .interrupted {
        Image(systemName: "xmark.circle").font(.system(size: 12, weight: .medium))
        Text(card.attention == .error ? "Failed" : "Interrupted")
      } else if card.attention == .usageLimit {
        Image(systemName: "gauge.with.dots.needle.100percent").font(.system(size: 12))
        Text("Usage limit")
      } else if card.attention == .finished && card.unseen {
        Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
        Text("Done")
      } else if card.draft {
        Image(systemName: "circle.dashed").font(.system(size: 12))
        Text("Draft")
      } else {
        Text(relativeTime(card.updatedAt))
      }
    }
    .font(.mono(Tokens.TypeScale.meta))
    .monospacedDigit()
    .foregroundStyle(color)
    .lineLimit(1)
    .fixedSize()
  }

  private var color: Color {
    if card.needsInput { return palette.status.attention.color }
    if card.status == .running { return palette.accent.color }
    if card.attention == .error || card.attention == .interrupted { return palette.status.danger.color }
    if card.attention == .usageLimit { return palette.status.attention.color }
    if card.attention == .finished && card.unseen { return palette.status.done.color }
    return palette.text.faint.color
  }

  var label: String {
    if card.needsInput { return card.attention == .question ? "Needs input" : "Need approval" }
    if card.status == .running { return "Working..." }
    if card.attention == .finished && card.unseen { return "Done" }
    return relativeTime(card.updatedAt)
  }
}

/// A harness mark from the asset catalog (11 §11.7).
struct HarnessMark: View {
  var harness: String
  var size: CGFloat

  var body: some View {
    Group {
      if UIImage(named: "harness-\(harness)") != nil {
        Image("harness-\(harness)").resizable().scaledToFit()
      } else {
        // A harness the catalog has no mark for yet.
        Image(systemName: "cpu").resizable().scaledToFit().fontWeight(.light)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// The context-menu preview (16 §16.6.3): a light 320 × 200 card with the
/// title, the last assistant line and the status, not a live transcript.
struct SessionPreview: View {
  var card: CardItem
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        HarnessMark(harness: card.harness, size: 16)
        Text(card.model).font(.mono(Tokens.TypeScale.meta)).foregroundStyle(palette.text.secondary.color)
        Spacer()
        StatusSlot(card: card)
      }
      Text(card.title)
        .font(.mono(Tokens.TypeScale.row, .semibold))
        .foregroundStyle(palette.content.color)
        .lineLimit(2)
      Text(card.detail?.text ?? card.lastLine ?? "No reply yet")
        .font(.mono(Tokens.TypeScale.prose))
        .foregroundStyle(palette.text.prose.color)
        .lineLimit(4)
      Spacer(minLength: 0)
    }
    .padding(16)
    .frame(width: 320, height: 200, alignment: .topLeading)
    .background(palette.base.color)
  }
}
