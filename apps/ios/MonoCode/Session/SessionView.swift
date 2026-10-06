import MonoDesign
import MonoSync
import MonoTranscript
import MonoWire
import SwiftUI

/// One session (11 §11.15, 16 §16.6.4): the native transcript under the glass
/// navigation bar, the ⋯ menu, the jump to latest, the tool sheet, and the
/// composer's place (the composer itself is R3). The tab bar is hidden (M16).
struct SessionView: View {
  var env: String
  var sessionId: String
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette
  @Environment(\.openURL) private var openURL
  @Environment(Router.self) private var router
  @State private var model: SessionModel
  @State private var composerHeight: CGFloat = 0
  @State private var showInfo = false

  init(env: String, sessionId: String) {
    self.env = env
    self.sessionId = sessionId
    _model = State(initialValue: SessionModel(env: env, sessionId: sessionId))
  }

  private var value: HostSession? { model.store?.value }

  private var title: String {
    value?.session.title ?? engine.inbox.item(env, sessionId)?.title ?? "Session"
  }

  /// "Claude Opus 4.6 · Demo", and "· Updating…" until the first sync.
  private var subtitle: String {
    let model = engine.catalogs.modelName(env, value?.session.model ?? engine.inbox.item(env, sessionId)?.model)
    var parts = [model, engine.hosts.label(env)].filter { !$0.isEmpty }
    if self.model.store?.freshness != .live { parts.append("Updating…") }
    return parts.joined(separator: " · ")
  }

  var body: some View {
    @Bindable var model = model
    ZStack(alignment: .bottom) {
      TranscriptHost(transcript: model.transcript, bottomBars: composerHeight)
        .ignoresSafeArea()
      JumpToLatest(visible: !model.atBottom, waiting: model.waitingForApproval) { model.jumpToLatest() }
        .padding(.bottom, 12)
    }
    .safeAreaBar(edge: .bottom) {
      ComposerPlaceholder(branch: value?.session.branch, worktree: value?.session.worktreeCwd != nil)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { composerHeight = $0 }
    }
    .overlay(alignment: .top) {
      if let notice = engine.hosts.notice(env) {
        NoticeBar(text: notice).background(palette.base.color)
      }
    }
    .navigationTitle(title)
    .navigationSubtitle(subtitle)
    .toolbarTitleDisplayMode(.inline)
    .toolbarVisibility(.hidden, for: .tabBar)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) { menu }
    }
    .sheet(item: $model.toolBlock) { item in
      ToolSheet(env: env, sessionId: sessionId, item: item)
        .environment(\.palette, palette)
    }
    .sheet(isPresented: $showInfo) {
      SessionInfoSheet(env: env, value: value)
        .environment(\.palette, palette)
    }
    .onAppear {
      model.openURL = { openURL($0) }
      // Checked at tap time: a session opened from a link appears before
      // the machine's welcome arrives.
      model.openFile = { [router, engine, env] projectId, cwd, path, line in
        guard engine.hosts.has(env, "files.read") else { return }
        router.push(.file(env: env, projectId: projectId, cwd: cwd, path: path, line: line))
      }
      model.setTheme(palette)
      engine.seen.markSeen(env, sessionId)
    }
    // Opened from a link before the machine connected: attach once it exists.
    .task(id: engine.hosts.records.count) {
      if let sync = engine.host(env) { model.open(sync) }
    }
    .onDisappear {
      model.close()
      engine.seen.markSeen(env, sessionId)
    }
    .onChange(of: palette) { _, next in model.setTheme(next) }
    #if DEBUG
    .onChange(of: value?.revision) {
      if let id = router.debugTool, let block = model.store?.block(id) {
        router.debugTool = nil
        model.toolBlock = ToolSheetItem(block: block, cwd: value?.session.cwd)
      }
    }
    #endif
  }

  /// The ⋯ menu in 11 §11.15's order. Explorer, Changes, Rename, Pin,
  /// Archive, Mute, Compact context and Delete need host methods or the write
  /// path that R1 has not built, so they are not listed.
  private var menu: some View {
    Menu("Session menu", systemImage: "ellipsis") {
      Button("Session info", systemImage: "info.circle") { showInfo = true }
      Menu("Copy session ID", systemImage: "doc.on.doc") {
        if let harness = value?.session.providerSessionId {
          Button("Harness session ID") { UIPasteboard.general.string = harness }
        }
        Button("MonoCode session ID") { UIPasteboard.general.string = sessionId }
      }
    }
  }
}

/// Jump to latest (16 §16.6.4): a 32 pt glass circle with `chevron.down`, or
/// the amber-dotted "Waiting for approval" pill when an approval is below
/// (M6). It enters and leaves with `ease.pop`, 170 ms.
private struct JumpToLatest: View {
  var visible: Bool
  var waiting: Bool
  var action: () -> Void
  @Environment(\.palette) private var palette
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// `ease.pop` (11 §11.6), 170 ms. MonoDesign has no token for it yet.
  static let pop = CubicBezier(0.16, 1, 0.3, 1).animation(milliseconds: 170)

  var body: some View {
    Group {
      if visible {
        Button(action: action) {
          if waiting {
            HStack(spacing: 6) {
              Circle().fill(palette.status.attention.color).frame(width: 6, height: 6)
              Text("Waiting for approval")
                .font(.mono(Tokens.TypeScale.secondary, .medium))
                .foregroundStyle(palette.content.color)
              Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
                .foregroundStyle(palette.text.secondary.color)
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .glassEffect(.regular.interactive(), in: .capsule)
          } else {
            Image(systemName: "chevron.down")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(palette.content.color)
              .frame(width: 32, height: 32)
              .glassEffect(.regular.interactive(), in: .circle)
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(waiting ? "Waiting for approval. Jump to latest" : "Jump to latest")
        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94)).combined(with: .offset(y: 8)))
      }
    }
    .animation(Self.pop, value: visible)
    .animation(Self.pop, value: waiting)
  }
}
