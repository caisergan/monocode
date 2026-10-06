import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// New session (11 §11.19). The composer and `create` are R3; R1 shows the
/// empty-session heading only.
struct NewSessionView: View {
  var env: String?
  var projectId: String?
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette

  var body: some View {
    let project = env.flatMap { env in projectId.flatMap { engine.projects.project(env, $0) } }
    VStack(spacing: 10) {
      Text(project.map { "What should we work on in \($0.name)?" } ?? "What should we work on?")
        .font(.mono(Tokens.TypeScale.emptyHeading, .medium))
        .foregroundStyle(palette.content.color)
        .multilineTextAlignment(.center)
      Text("Starting sessions from the phone arrives with the composer.")
        .font(.mono(Tokens.TypeScale.secondary))
        .foregroundStyle(palette.text.tertiary.color)
        .multilineTextAlignment(.center)
    }
    .padding(.horizontal, 28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background { DotGrid().ignoresSafeArea() }
    .screenBackground()
    .navigationTitle("New session")
    .toolbarTitleDisplayMode(.inline)
  }
}
