import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// Agents (11 §11.12), the cross-machine home: the desktop's "Working" card
/// for every machine. Welcome until a machine exists.
struct AgentsView: View {
  @Environment(AppModel.self) private var model
  @Environment(SyncEngine.self) private var engine
  @Environment(Router.self) private var router
  @Environment(\.palette) private var palette
  @State private var recentLimit = 50

  struct Section: Identifiable {
    var id: String
    var title: String
    var dot: Bool = false
    var cards: [CardItem]
  }

  /// Need approval, Working, Problems, Done, Recent (apps/mobile index.tsx).
  private var sections: [Section] {
    let cards = engine.inbox.items.map { agent in
      CardItem.inbox(
        agent, machine: engine.hosts.label(agent.env), model: engine.catalogs.modelName(agent.env, agent.item.model),
        unseen: engine.seen.isUnseen(agent.env, agent.item.sessionId, finishedAt: agent.item.finishedAt, updatedAt: agent.item.updatedAt))
    }
    let needs = cards.filter(\.needsInput)
    let working = cards.filter { $0.status == .running && !$0.needsInput }
    let problems = cards.filter { [.error, .interrupted, .usageLimit].contains($0.attention) }
    let done = cards.filter { $0.attention == .finished && $0.status != .running && $0.unseen }
    let used = Set((needs + working + problems + done).map(\.id))
    let recent = cards.filter { !used.contains($0.id) }
    let needsTitle = needs.allSatisfy { $0.attention == .question } ? "Needs input" : "Need approval"
    return [
      Section(id: "needs", title: needsTitle, cards: needs),
      Section(id: "working", title: "Working", dot: true, cards: working),
      Section(id: "problems", title: "Problems", cards: problems),
      Section(id: "done", title: "Done", cards: done),
      Section(id: "recent", title: "Recent", cards: recent),
    ].filter { !$0.cards.isEmpty }
  }

  private var notices: [(env: String, text: String)] {
    engine.hosts.records.compactMap { record in engine.hosts.notice(record.env).map { (record.env, $0) } }
  }

  var body: some View {
    Group {
      if model.hasMachines {
        list
      } else {
        WelcomeView()
      }
    }
    .screenBackground()
    .navigationTitle("Agents")
    .toolbarTitleDisplayMode(.inlineLarge)
    .toolbar {
      if model.hasMachines {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New session", systemImage: "plus") { router.push(.newSession(env: nil, projectId: nil)) }
        }
      }
    }
    .task(id: model.hasMachines) {
      guard model.hasMachines else { return }
      let interest = engine.watchInbox()
      await Task.untilCancelled()
      interest.release()
    }
  }

  @ViewBuilder private var list: some View {
    let sections = sections
    List {
      if engine.inbox.cached {
        NoticeBar(text: "Updating…").plainRow()
      }
      ForEach(notices, id: \.env) { notice in
        NoticeBar(text: notice.text).plainRow()
      }
      if sections.isEmpty {
        Group {
          if !engine.inbox.hosts.isEmpty {
            EmptyState(title: "Nothing needs your attention", action: ("Start a session", { router.push(.newSession(env: nil, projectId: nil)) }))
          } else if notices.isEmpty {
            ProgressView()
          }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 120)
        .plainRow()
      }
      ForEach(sections) { section in
        LabelRow(title: section.title, dot: section.dot ? palette.accent.color : nil)
        let cards = section.id == "recent" ? Array(section.cards.prefix(recentLimit)) : section.cards
        ForEach(cards) { card in
          SessionRow(card: card, seenSwipe: true)
        }
        if section.id == "recent" && section.cards.count > recentLimit {
          Button("Show \(section.cards.count - recentLimit) more") { recentLimit += 50 }
            .font(.mono(Tokens.TypeScale.secondary))
            .foregroundStyle(palette.text.secondary.color)
            .plainRow()
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .contentMargins(.bottom, 24, for: .scrollContent)
  }
}

extension View {
  /// A full-width list row with no background, separator or insets.
  func plainRow() -> some View {
    listRowInsets(EdgeInsets())
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }
}

extension Task where Success == Never, Failure == Never {
  /// Suspends until the surrounding task is cancelled, e.g. when the view
  /// that ran `.task` goes away.
  static func untilCancelled() async {
    while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
  }
}
