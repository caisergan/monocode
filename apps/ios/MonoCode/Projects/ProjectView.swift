import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// A project (11 §11.14): the desktop sidebar's Sessions, Explorer and
/// Changes. R1 wires Sessions; Explorer and Changes are placeholders.
struct ProjectView: View {
  var env: String
  var projectId: String
  @Environment(SyncEngine.self) private var engine
  @Environment(Router.self) private var router
  @Environment(\.palette) private var palette
  @State private var segment: Segment = .sessions
  /// +1 when the new segment is to the right of the old one, -1 to the left.
  @State private var direction: CGFloat = 1
  @State private var archived: ArchivedFilter = .exclude
  @State private var query = ""

  enum Segment: Int, Hashable { case sessions, explorer, changes }

  private var key: ProjectsStore.ListKey { .init(env: env, projectId: projectId, archived: archived) }
  private var project: HostProject? { engine.projects.project(env, projectId) }

  var body: some View {
    VStack(spacing: 0) {
      if let notice = engine.hosts.notice(env) { NoticeBar(text: notice) }
      Segmented(options: [(.sessions, "Sessions"), (.explorer, "Explorer"), (.changes, "Changes")], selection: selection)
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 4)
      ZStack {
        switch segment {
        case .sessions:
          SessionsPane(env: env, projectId: projectId, key: key, query: query)
            // Attached to the pane, so the search field comes and goes with
            // it without rebuilding the screen.
            .searchable(text: $query, prompt: "Search conversations...")
            .searchToolbarBehavior(.minimize)
            .transition(paneTransition)
        case .explorer:
          placeholder("Explorer arrives with the workspace screens.").transition(paneTransition)
        case .changes:
          placeholder("Changes arrive with the workspace screens.").transition(paneTransition)
        }
      }
      .frame(maxHeight: .infinity)
      .clipped()
    }
    .screenBackground()
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) { WorkingCopyTitle(name: project?.name ?? "Project", machine: engine.hosts.label(env)) }
      if segment == .sessions {
        ToolbarItem(placement: .topBarTrailing) { filterMenu }
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button("New session", systemImage: "plus") { router.push(.newSession(env: env, projectId: projectId)) }
      }
    }
    .task(id: key) {
      guard let sync = engine.host(env) else { return }
      let interest = sync.openList(projectId, archived: archived)
      await Task.untilCancelled()
      interest.release()
    }
  }

  /// The desktop filter menu (11 §11.14). Only Archived is wired in R1.
  private var filterMenu: some View {
    Menu("Filter", systemImage: archived == .only ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle") {
      Toggle("Archived", isOn: Binding(get: { archived == .only }, set: { archived = $0 ? .only : .exclude }))
      Section("Status") {
        Toggle("Working", isOn: .constant(false)).disabled(true)
        Toggle("Needs approval", isOn: .constant(false)).disabled(true)
        Toggle("Done", isOn: .constant(false)).disabled(true)
      }
      Section("Time") {
        Toggle("All time", isOn: .constant(true)).disabled(true)
        Toggle("Today", isOn: .constant(false)).disabled(true)
        Toggle("Last 7 days", isOn: .constant(false)).disabled(true)
        Toggle("Last 30 days", isOn: .constant(false)).disabled(true)
      }
      Section("Provider") {
        Toggle("Claude Code", isOn: .constant(false)).disabled(true)
      }
      Button("Clear filters") { archived = .exclude }
    }
  }

  /// Records the direction, then switches with the panel slide (11 §11.6:
  /// 260 ms, ease.out).
  private var selection: Binding<Segment> {
    Binding(
      get: { segment },
      set: { next in
        direction = next.rawValue >= segment.rawValue ? 1 : -1
        withAnimation(Self.slide) { segment = next }
      })
  }

  static let slide = Tokens.Motion.easeOut.animation(milliseconds: 260)

  /// The new pane fades in from 24 pt on the side it came from; the old one
  /// fades out where it is.
  private var paneTransition: AnyTransition {
    .asymmetric(insertion: .opacity.combined(with: .offset(x: 24 * direction)), removal: .opacity)
  }

  private func placeholder(_ text: String) -> some View {
    EmptyState(title: text).frame(maxHeight: .infinity)
  }
}

/// The working-copy switcher's place in the bar (11 §11.14): the project,
/// and "Workspace" with ChevronsUpDown. The sheet needs `git.worktrees`,
/// which no machine has in R1, so it is not interactive yet.
private struct WorkingCopyTitle: View {
  var name: String
  var machine: String
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(spacing: 1) {
      Text(name)
        .font(.mono(Tokens.TypeScale.screenTitle, .semibold))
        .foregroundStyle(palette.content.color)
        .lineLimit(1)
      HStack(spacing: 3) {
        Text("Workspace · \(machine)")
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold))
      }
      .font(.mono(Tokens.TypeScale.meta))
      .foregroundStyle(palette.text.tertiary.color)
    }
    .accessibilityElement(children: .combine)
  }
}

/// The session list: pinned first, then newest, paged 50 at a time.
private struct SessionsPane: View {
  var env: String
  var projectId: String
  var key: ProjectsStore.ListKey
  var query: String
  @Environment(SyncEngine.self) private var engine
  @Environment(Router.self) private var router

  var body: some View {
    let state = engine.projects.lists[key]
    let visible = Paging.visibleSessions(state?.list, query: query)
    let card = { (item: SessionListItem) in
      CardItem.session(
        env, item, inbox: engine.inbox.item(env, item.id), model: engine.catalogs.modelName(env, item.model),
        unseen: engine.seen.isUnseen(env, item.id, finishedAt: item.finishedAt, updatedAt: item.updatedAt))
    }
    List {
      if let error = state?.error, state?.list != nil {
        NoticeBar(text: error, action: ("Retry", { engine.host(env)?.refreshSessions(key) })).plainRow()
      }
      if !visible.pinned.isEmpty {
        LabelRow(title: "Pinned")
        ForEach(visible.pinned) { SessionRow(card: card($0)) }
        if !visible.rest.isEmpty { LabelRow(title: "Sessions") }
      }
      ForEach(visible.rest) { item in
        SessionRow(card: card(item))
          .onAppear {
            if item.id == visible.rest.last?.id { Task { await engine.host(env)?.loadMoreSessions(key) } }
          }
      }
      if state?.loadingMore == true {
        ProgressView().frame(maxWidth: .infinity).padding(12).plainRow()
      }
      if visible.pinned.isEmpty && visible.rest.isEmpty {
        empty(state).padding(.top, 56).plainRow()
      }
    }
    .listStyle(.plain)
    .environment(\.defaultMinListRowHeight, 0)
    .scrollContentBackground(.hidden)
    .refreshable { engine.host(env)?.refreshSessions(key) }
  }

  @ViewBuilder private func empty(_ state: ProjectsStore.ListState?) -> some View {
    if state?.list == nil {
      if let error = state?.error {
        EmptyState(title: "Couldn’t load sessions", detail: error, action: ("Retry", { engine.host(env)?.refreshSessions(key) }))
      } else {
        ProgressView().frame(maxWidth: .infinity)
      }
    } else if !query.trimmingCharacters(in: .whitespaces).isEmpty {
      EmptyState(title: "No matching sessions")
    } else if key.archived == .only {
      EmptyState(title: "No sessions match these filters")
    } else {
      EmptyState(title: "Sessions you start will show up here", action: ("New session", { router.push(.newSession(env: env, projectId: projectId)) }))
    }
  }
}
