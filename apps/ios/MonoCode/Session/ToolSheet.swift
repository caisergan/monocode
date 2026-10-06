import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// A tool, thinking or trail row in full (11 §11.15, 16 §16.6.4): the
/// window's copy at once, then the whole block from `sessions.block`. Medium
/// and large detents; the transcript still scrolls behind it at half height.
struct ToolSheet: View {
  var env: String
  var sessionId: String
  var item: ToolSheetItem
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette
  @Environment(\.dismiss) private var dismiss
  @State private var full: Block?
  @State private var error: String?
  @State private var showAll = false

  /// Output beyond this shows only its tail until asked (11 §11.23).
  static let outputTail = 10_000

  private var block: Block { full ?? item.block }

  private var title: String {
    switch block.role {
    case .tool, .approval: Transcript.toolCallLabel(block, cwd: item.cwd)
    case .reasoning: "Thinking"
    default: block.text.components(separatedBy: "\n").first.flatMap { $0.isEmpty ? nil : $0 } ?? block.role.rawValue
    }
  }

  private var state: (text: String, failed: Bool)? {
    guard block.role == .tool || block.role == .approval else { return nil }
    switch Transcript.toolCallState(block) {
    case .pending: return ("Running", false)
    case .accepted: return ("Completed", false)
    case .rejected: return ("Failed", true)
    }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if let state {
            Text(state.text)
              .font(.mono(Tokens.TypeScale.meta))
              .foregroundStyle(state.failed ? palette.status.danger.color : palette.text.tertiary.color)
          }
          if item.block.truncated != nil && full == nil && error == nil {
            Text("Loading the full output…")
              .font(.mono(Tokens.TypeScale.meta))
              .foregroundStyle(palette.text.faint.color)
          }
          if let error {
            Text("Couldn’t load the full block. \(error)")
              .font(.mono(Tokens.TypeScale.meta))
              .foregroundStyle(palette.contentAlpha(0.65).color)
          }
          if let detail = block.tool?.detail, !detail.isEmpty {
            section("Input") { code(Text(detail)) }
          }
          if let lines = block.tool?.preview?.lines, !lines.isEmpty {
            section(block.tool?.preview?.path ?? "Changes") { code(diff(lines)) }
          }
          if let output = block.tool?.preview?.output, !output.isEmpty {
            let cut = output.count > Self.outputTail && !showAll
            section("Output") {
              if cut {
                HStack {
                  Text("Showing the last 10,000 characters.")
                    .font(.mono(Tokens.TypeScale.meta))
                    .foregroundStyle(palette.text.faint.color)
                  Spacer()
                  Button("Load full output") { showAll = true }
                    .font(.mono(Tokens.TypeScale.meta, .medium))
                    .foregroundStyle(palette.contentAlpha(0.75).color)
                }
              }
              code(Text(cut ? String(output.suffix(Self.outputTail)) : output))
            }
          }
          if block.role != .tool && block.role != .approval && !block.text.isEmpty {
            Text(block.text)
              .font(.mono(Tokens.TypeScale.prose))
              .foregroundStyle(block.role == .reasoning ? palette.text.reasoning.color : palette.text.prose.color)
              .textSelection(.enabled)
          }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .navigationTitle(title)
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close", systemImage: "xmark") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationBackgroundInteraction(.enabled(upThrough: .medium))
    .presentationDragIndicator(.visible)
    .task {
      guard let sync = engine.host(env) else { return }
      do {
        full = try await sync.block(sessionId, item.block.id)
      } catch {
        if item.block.truncated != nil { self.error = error.localizedDescription }
      }
    }
  }

  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.mono(Tokens.TypeScale.secondary, .medium))
        .foregroundStyle(palette.text.secondary.color)
      content()
    }
  }

  private func code(_ text: Text) -> some View {
    text
      .font(.mono(Tokens.TypeScale.code, design: .monospaced))
      .foregroundStyle(palette.contentAlpha(0.85).color)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(palette.fill.code.color, in: .rect(cornerRadius: Tokens.Radius.block))
      .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.block).strokeBorder(palette.border.default.color))
  }

  private func diff(_ lines: [ToolPreview.Line]) -> Text {
    var text = AttributedString()
    for (index, line) in lines.enumerated() {
      let prefix = line.kind == "add" ? "+ " : line.kind == "del" ? "− " : "  "
      var part = AttributedString((index > 0 ? "\n" : "") + prefix + line.text)
      part.foregroundColor = line.kind == "add" ? palette.status.done.color : line.kind == "del" ? palette.status.danger.color : palette.contentAlpha(0.7).color
      text += part
    }
    return Text(text)
  }
}

/// Session info (11 §11.15), from what the window holds.
struct SessionInfoSheet: View {
  var env: String
  var value: HostSession?
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        if let value {
          let session = value.session
          row("Working copy", session.worktreeCwd ?? session.cwd, mono: true)
          if let branch = session.branch { row("Branch", branch, mono: true) }
          row("Model", engine.catalogs.modelName(env, session.model))
          if !session.modelSettings.isEmpty {
            row("Settings", session.modelSettings.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: " · "))
          }
          row("Permission mode", session.runtimeMode.rawValue)
          if let created = value.createdAt { row("Created", date(created)) }
          row("Updated", date(value.updatedAt))
          if let provider = session.providerSessionId { row("Provider session", provider, mono: true) }
          row("Machine", engine.hosts.label(env))
        }
      }
      .scrollContentBackground(.hidden)
      .background(palette.base.color)
      .navigationTitle("Session info")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close", systemImage: "xmark") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  private func row(_ label: String, _ value: String, mono: Bool = false) -> some View {
    LabeledContent(label) {
      Text(value)
        .font(.mono(Tokens.TypeScale.secondary, design: mono ? .monospaced : .default))
        .foregroundStyle(palette.text.secondary.color)
        .multilineTextAlignment(.trailing)
    }
    .font(.mono(Tokens.TypeScale.row))
    .listRowBackground(palette.fill.code.color)
  }

  private func date(_ ms: Int) -> String {
    Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
  }
}
