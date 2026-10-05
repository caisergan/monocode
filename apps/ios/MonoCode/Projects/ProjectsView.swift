import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// Projects (11 §11.13): every machine's projects.
struct ProjectsView: View {
  @Environment(AppModel.self) private var model
  @Environment(SyncEngine.self) private var engine

  var body: some View {
    Group {
      if model.hasMachines {
        List {
          ForEach(engine.hosts.records) { record in
            ForEach(engine.projects.hosts[record.env]?.projects ?? []) { project in
              NavigationLink(project.name, value: Destination.project(env: record.env, projectId: project.id))
            }
          }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
      } else {
        EmptyState(title: "No projects yet", detail: "Pair a computer to see its projects.")
          .frame(maxHeight: .infinity)
      }
    }
    .screenBackground()
    .navigationTitle("Projects")
    .toolbarTitleDisplayMode(.large)
  }
}

/// A project: Sessions, Explorer and Changes (11 §11.14).
struct ProjectView: View {
  var env: String
  var projectId: String
  @Environment(SyncEngine.self) private var engine

  var body: some View {
    Text(engine.projects.project(env, projectId)?.name ?? "Project")
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .screenBackground()
      .navigationTitle(engine.projects.project(env, projectId)?.name ?? "Project")
      .toolbarTitleDisplayMode(.inline)
  }
}
