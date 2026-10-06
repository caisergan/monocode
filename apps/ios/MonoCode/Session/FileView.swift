import MonoDesign
import MonoSync
import MonoTranscript
import MonoWire
import SwiftUI

/// The file viewer (11 §11.20), opened from a file chip in the transcript:
/// `files.read` text with line numbers in mono 13 / 19, scrolled to the
/// chip's line. Highlighting, wrap, find and Markdown preview are R4's
/// document mode.
struct FileView: View {
  var env: String
  var projectId: String
  var cwd: String?
  var path: String
  var line: Int?
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette
  @State private var state: Loaded = .loading
  @State private var attempt = 0

  enum Loaded: Equatable {
    case loading
    case text([String])
    case failed(String, retry: Bool)
  }

  /// The host's `files.read` cap (06 §6.5), enforced again here.
  static let maxBytes = 1024 * 1024

  private var name: String { Paths.leafName(path).isEmpty ? path : Paths.leafName(path) }

  private var folder: String {
    let parent = (path as NSString).deletingLastPathComponent
    let project = engine.projects.project(env, projectId)?.name ?? ""
    return [project, parent].filter { !$0.isEmpty }.joined(separator: "/")
  }

  var body: some View {
    content
      .screenBackground()
      .navigationTitle(name)
      .toolbarTitleDisplayMode(.inline)
      .toolbarVisibility(.hidden, for: .tabBar)
      .toolbar {
        ToolbarItem(placement: .principal) {
          VStack(spacing: 1) {
            HStack(spacing: 6) {
              Image(FileIcons.name(for: name), bundle: FileIcons.bundle)
                .resizable()
                .frame(width: 16, height: 16)
                .accessibilityHidden(true)
              Text(name)
                .font(.mono(Tokens.TypeScale.screenTitle, .semibold))
                .foregroundStyle(palette.content.color)
                .lineLimit(1)
            }
            if !folder.isEmpty {
              Text(folder)
                .font(.mono(Tokens.TypeScale.meta))
                .foregroundStyle(palette.text.tertiary.color)
                .lineLimit(1)
                .truncationMode(.head)
            }
          }
        }
      }
      .task(id: attempt) { await load() }
  }

  @ViewBuilder private var content: some View {
    switch state {
    case .loading:
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    case let .failed(message, retry):
      EmptyState(title: message, action: retry ? ("Retry", { attempt += 1 }) : nil)
        .frame(maxHeight: .infinity)
    case let .text(lines):
      CodeLines(lines: lines, target: line)
    }
  }

  private func load() async {
    guard let sync = engine.host(env) else {
      state = .failed("\(engine.hosts.label(env)) isn’t connected.", retry: true)
      return
    }
    state = .loading
    do {
      let text = try await sync.readFile(projectId: projectId, cwd: cwd, path: path)
      if text.utf8.count > Self.maxBytes || text.contains("\0") {
        state = .failed("This file can't be shown on the phone.", retry: false)
      } else {
        state = .text(text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n"))
      }
    } catch let error as ChannelError {
      state = .failed(Self.message(error.message, machine: engine.hosts.label(env)), retry: Self.retryable(error.message))
    } catch {
      state = .failed("Couldn’t load the file. \(error.localizedDescription)", retry: true)
    }
  }

  /// The host's refusals in the phone's words (11 §11.23).
  static func message(_ host: String, machine: String) -> String {
    if host.hasPrefix("File is too large to preview") || host.hasPrefix("Binary file cannot be previewed") {
      return "This file can't be shown on the phone."
    }
    if host.hasPrefix("ENOENT") { return "This file isn’t in the project on \(machine)." }
    if host.hasPrefix("Path is outside the workspace") { return "This file is outside the project’s folder, so the phone can’t open it." }
    if host.hasPrefix("Path is not a file") { return "This is a folder, not a file." }
    return "Couldn’t load the file. \(host)"
  }

  static func retryable(_ host: String) -> Bool {
    !["File is too large", "Binary file", "ENOENT", "Path is outside", "Path is not a file"].contains { host.hasPrefix($0) }
  }
}

/// The file's lines with their numbers, scrolled to `target` and marking it.
private struct CodeLines: View {
  var lines: [String]
  var target: Int?
  @Environment(\.palette) private var palette

  var body: some View {
    let gutter = CGFloat(String(lines.count).count) * 7.5 + 12
    ScrollViewReader { proxy in
      ScrollView([.vertical, .horizontal]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, text in
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Text("\(index + 1)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(palette.text.faintest.color)
                .frame(width: gutter, alignment: .trailing)
              Text(text.isEmpty ? " " : text.replacingOccurrences(of: "\t", with: "  "))
                .font(.mono(Tokens.TypeScale.code, design: .monospaced))
                .foregroundStyle(palette.contentAlpha(0.85).color)
                .fixedSize()
                .textSelection(.enabled)
            }
            .frame(minHeight: Tokens.TypeScale.code.line, alignment: .leading)
            .padding(.trailing, 16)
            .background(index + 1 == target ? palette.selection.strong.color : .clear)
            .id(index + 1)
          }
        }
        .padding(.vertical, 12)
      }
      .onAppear {
        if let target { proxy.scrollTo(target, anchor: .center) }
      }
    }
  }
}
