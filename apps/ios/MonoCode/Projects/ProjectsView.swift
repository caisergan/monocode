import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// Projects (11 §11.13): the phone's project rail, every machine's projects.
struct ProjectsView: View {
  @Environment(AppModel.self) private var model
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette
  @State private var query = ""

  struct Row: Identifiable {
    var env: String
    var project: HostProject
    var working: Int
    var pinned: Bool
    var id: String { "\(env)/\(project.id)" }
  }

  private var rows: [Row] {
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    var working: [String: Int] = [:]
    for agent in engine.inbox.items where agent.item.status == .running {
      working["\(agent.env)/\(agent.item.projectId)", default: 0] += 1
    }
    return engine.hosts.records.flatMap { record in
      (engine.projects.hosts[record.env]?.projects ?? [])
        .filter { needle.isEmpty || $0.name.lowercased().contains(needle) || $0.cwd.lowercased().contains(needle) }
        .map { Row(env: record.env, project: $0, working: working["\(record.env)/\($0.id)"] ?? 0, pinned: engine.pins.isPinned(record.env, $0.id)) }
    }
  }

  var body: some View {
    Group {
      if !model.hasMachines {
        EmptyState(title: "No projects yet", detail: "Pair a computer to see its projects.")
          .frame(maxHeight: .infinity)
      } else {
        list
      }
    }
    .screenBackground()
    .navigationTitle("Projects")
    .toolbarTitleDisplayMode(.inlineLarge)
    .modifier(ProjectSearch(enabled: model.hasMachines, query: $query))
    .task(id: engine.hosts.records.count) { engine.loadProjects() }
  }

  @ViewBuilder private var list: some View {
    let rows = rows
    let pinned = rows.filter(\.pinned)
    let rest = rows.filter { !$0.pinned }
    let anyProjects = engine.hosts.records.contains { !(engine.projects.hosts[$0.env]?.projects.isEmpty ?? true) }
    let loading = engine.hosts.records.contains { engine.projects.hosts[$0.env]?.loading ?? true }
    List {
      ForEach(engine.hosts.records) { record in
        if let notice = engine.hosts.notice(record.env) {
          NoticeBar(text: notice).plainRow()
        } else if let error = engine.projects.hosts[record.env]?.error, engine.projects.hosts[record.env]?.projects.isEmpty ?? true {
          NoticeBar(text: "Couldn’t load projects from \(record.label). \(error)").plainRow()
        }
      }
      if !pinned.isEmpty {
        LabelRow(title: "Pinned")
        ForEach(pinned) { ProjectRow(row: $0) }
      }
      if engine.hosts.records.count > 1 {
        ForEach(engine.hosts.records) { record in
          let group = rest.filter { $0.env == record.env }
          if !group.isEmpty || query.isEmpty {
            // The header opens Machine details (11 §11.13).
            NavigationLink(value: Destination.machine(env: record.env)) { MachineRow(record: record) }
              .buttonStyle(.plain)
              .plainRow()
            ForEach(group) { ProjectRow(row: $0) }
          }
        }
      } else if !rest.isEmpty {
        // The large title already says Projects; the label only separates
        // the rest from a Pinned section above it.
        if !pinned.isEmpty { LabelRow(title: "Projects") }
        ForEach(rest) { ProjectRow(row: $0) }
      }
      if rows.isEmpty {
        Group {
          if !query.isEmpty {
            EmptyState(title: "No matching projects")
          } else if !anyProjects && !loading {
            EmptyState(title: "No projects yet")
          }
        }
        .padding(.top, 48)
        .plainRow()
      }
    }
    .listStyle(.plain)
    .environment(\.defaultMinListRowHeight, 0)
    .scrollContentBackground(.hidden)
  }
}

/// `.searchable` once a machine exists, minimised into the toolbar.
private struct ProjectSearch: ViewModifier {
  var enabled: Bool
  @Binding var query: String

  func body(content: Content) -> some View {
    if enabled {
      content
        .searchable(text: $query, prompt: "Search projects...")
        .searchToolbarBehavior(.minimize)
    } else {
      content
    }
  }
}

/// A machine group header (11 §11.13), shown with two or more machines.
struct MachineRow: View {
  var record: HostRecord
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette

  var body: some View {
    let state = engine.hosts.states[record.env]
    HStack(spacing: 8) {
      Circle()
        .fill(dotColor(state?.dot ?? .offline))
        .frame(width: 7, height: 7)
      Text(record.label)
        .font(.mono(Tokens.TypeScale.secondary, .medium))
        .foregroundStyle(palette.text.secondary.color)
      if record.isDemo { DemoTag() }
      Spacer()
    }
    .padding(.horizontal, 16)
    .frame(height: 44)
    .contentShape(.rect)
  }

  private func dotColor(_ dot: HostConnState.Dot) -> Color {
    switch dot {
    case .online: palette.status.done.color
    case .connecting: palette.status.attention.color
    case .offline: palette.contentAlpha(0.35).color
    }
  }
}

/// A project row (11 §11.13): 60 pt, the 20 pt mascot in the project colour,
/// hopping while a session runs, and the name, shimmering while busy.
struct ProjectRow: View {
  var row: ProjectsView.Row
  /// 17 / 22, a step above the row role (owner, 2026-10-06).
  static let name = TypeRole(size: 17, line: 22)
  @Environment(Router.self) private var router
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette

  var body: some View {
    let busy = row.working > 0
    Button {
      router.push(.project(env: row.env, projectId: row.project.id))
    } label: {
      HStack(spacing: 12) {
        MascotView(projectId: row.project.id, busy: busy, size: 20)
        if busy {
          ShimmerText(text: row.project.name, font: .mono(Self.name, .medium), color: palette.content.color)
        } else {
          Text(row.project.name)
            .font(.mono(Self.name, .medium))
            .foregroundStyle(palette.content.color)
            .lineLimit(1)
        }
        Spacer()
      }
      .padding(.horizontal, 16)
      .frame(height: 60)
      .contentShape(.rect)
    }
    .buttonStyle(ProjectPressStyle(busy: busy))
    .accessibilityLabel("\(row.project.name)\(busy ? ", \(row.working) working" : "")")
    .plainRow()
    .contextMenu {
      Button(row.pinned ? "Unpin" : "Pin", systemImage: row.pinned ? "pin.slash" : "pin") {
        engine.pins.toggle(row.env, row.project.id)
      }
      Button("New session", systemImage: "plus") {
        router.push(.newSession(env: row.env, projectId: row.project.id))
      }
      Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = row.project.cwd }
    }
  }
}

/// Rows rest at α .65 and come to full opacity when pressed or busy, as on
/// the desktop rail.
private struct ProjectPressStyle: ButtonStyle {
  var busy: Bool
  @Environment(\.palette) private var palette

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .opacity(configuration.isPressed || busy ? 1 : 0.65)
      .background(configuration.isPressed ? palette.fill.hover.color : .clear)
  }
}
