import MonoDesign
import MonoSync
import MonoWire
import SwiftUI
import UniformTypeIdentifiers

/// A session card as a list row: tap opens the session, long press opens the
/// context menu with a preview (M15), swipes per screen (16 §16.6.3). Menu
/// items whose host methods the machine lacks stay hidden.
struct SessionRow: View {
  var card: CardItem
  /// Agents: Mark as seen or unseen on the leading swipe.
  var seenSwipe = false
  @Environment(Router.self) private var router
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette

  var body: some View {
    Button {
      engine.seen.markSeen(card.env, card.sessionId)
      router.push(.session(env: card.env, sessionId: card.sessionId))
    } label: {
      SessionCard(card: card)
    }
    .buttonStyle(CardPressStyle())
    .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
    .contextMenu {
      // Pin, Rename, Mute, Archive and Delete need `sessions.update` and the
      // write path; no machine in R1 has them, so they are not listed.
      Menu("Copy session ID", systemImage: "doc.on.doc") {
        if let harness = card.providerSessionId {
          Button("Harness session ID") { copy(harness) }
        }
        Button("MonoCode session ID") { copy(card.sessionId) }
      }
    } preview: {
      SessionPreview(card: card).environment(\.palette, palette)
    }
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      if seenSwipe {
        if card.unseen && card.attention == .finished {
          Button("Mark as seen", systemImage: "checkmark.circle") { engine.seen.markSeen(card.env, card.sessionId) }
            .tint(palette.selection.emphasis.color)
        } else {
          Button("Mark as unseen", systemImage: "circle.badge") { engine.seen.markUnseen(card.env, card.sessionId) }
            .tint(palette.selection.emphasis.color)
        }
      }
    }
  }

  private func copy(_ text: String) {
    UIPasteboard.general.string = text
  }
}

/// Pressed cards fill with `fill.hover` and scale 0.97 (11 §11.4).
struct CardPressStyle: ButtonStyle {
  @Environment(\.palette) private var palette

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(configuration.isPressed ? palette.fill.hover.color : .clear, in: .rect(cornerRadius: Tokens.Radius.sm))
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(Tokens.Motion.easeOut.animation(milliseconds: Tokens.Motion.feedbackMs), value: configuration.isPressed)
  }
}

/// A section label as a plain row, so it scrolls away (the desktop rail's
/// labels are not sticky).
struct LabelRow: View {
  var title: String
  var dot: Color?

  var body: some View {
    SectionLabel(title: title, dot: dot)
      .listRowInsets(EdgeInsets())
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }
}
