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
  @State private var sheet: ComposerSheet?

  enum ComposerSheet: String, Identifiable {
    case add, model, access
    var id: String { rawValue }
  }

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

  /// The chip row, from the composer's draft over the session.
  private var chips: ComposerChips {
    let draft = model.draft
    let session = value?.session
    let modelId = draft.model(for: session)
    let agent = engine.catalogs.catalogs[env]?.model(modelId)
    let values = draft.settings(for: session)
    let effort = agent.flatMap { ($0.settings ?? []).first(where: ModelSettings.isEffort) }
      .map { ModelSettings.valueLabel($0, values) }
      ?? values["effort"].map { $0.prefix(1).uppercased() + $0.dropFirst() }
    return ComposerChips(
      harness: agent?.harness ?? session?.harness ?? engine.inbox.item(env, sessionId)?.harness ?? "claude",
      model: engine.catalogs.modelName(env, modelId.isEmpty ? engine.inbox.item(env, sessionId)?.model : modelId),
      effort: effort,
      access: AccessMode(draft.runtimeMode(for: session)),
      mode: draft.mode,
      add: { sheet = .add },
      pickModel: { sheet = .model },
      pickAccess: { sheet = .access },
      clearMode: { draft.mode = nil })
  }

  @ViewBuilder private func composerSheet(_ sheet: ComposerSheet) -> some View {
    let draft = model.draft
    let running = value?.status == .running
    switch sheet {
    case .add:
      AddSheet(mode: draft.mode) { draft.mode = $0 }
    case .model:
      ModelSheet(env: env, session: value?.session, running: running, draft: draft)
    case .access:
      AccessSheet(running: running, current: AccessMode(draft.runtimeMode(for: value?.session))) {
        draft.runtimeMode = $0.runtimeMode
      }
    }
  }

  var body: some View {
    @Bindable var model = model
    // An approval below keeps the composer open: the jump's pill says so.
    let collapsed = model.composerCollapsed && !model.waitingForApproval
    ZStack(alignment: .bottom) {
      TranscriptHost(transcript: model.transcript, bottomBars: composerHeight)
        .ignoresSafeArea()
      JumpToLatest.Floating(visible: !model.atBottom && !collapsed, waiting: model.waitingForApproval) { model.jumpToLatest() }
        .padding(.bottom, 12)
    }
    .safeAreaBar(edge: .bottom) {
      SessionBottomBar(
        branch: value?.session.branch,
        worktree: value?.session.worktreeCwd != nil,
        chips: chips,
        collapsed: collapsed,
        jumpVisible: !model.atBottom,
        jump: { model.jumpToLatest() },
        expand: { model.expandComposer() },
        onComposerHeight: { composerHeight = $0 })
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
      ToolbarItem(placement: .topBarTrailing) {
        SessionMenu(sessionId: sessionId, harnessId: value?.session.providerSessionId, showInfo: $showInfo)
          .equatable()
      }
    }
    .sheet(item: $model.toolBlock) { item in
      ToolSheet(env: env, sessionId: sessionId, item: item)
        .environment(\.palette, palette)
    }
    .sheet(item: $sheet) { sheet in
      composerSheet(sheet).environment(\.palette, palette)
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
}

/// The ⋯ menu in 11 §11.15's order. Explorer, Changes, Rename, Pin,
/// Archive, Mute, Compact context and Delete need host methods or the write
/// path that R1 has not built, so they are not listed.
///
/// Equatable on its ids alone: the session screen re-renders on every
/// streamed delta, and a menu rebuilt under the finger drops its taps.
private struct SessionMenu: View, Equatable {
  var sessionId: String
  var harnessId: String?
  @Binding var showInfo: Bool
  @State private var copied = 0

  static func == (a: Self, b: Self) -> Bool {
    a.sessionId == b.sessionId && a.harnessId == b.harnessId
  }

  var body: some View {
    Menu("Session menu", systemImage: "ellipsis") {
      Button("Session info", systemImage: "info.circle") { showInfo = true }
      if let harnessId {
        Menu("Copy session ID", systemImage: "doc.on.doc") {
          Button("Harness session ID") { copy(harnessId) }
          Button("MonoCode session ID") { copy(sessionId) }
        }
      } else {
        // No harness id yet: one choice needs no submenu.
        Button("Copy session ID", systemImage: "doc.on.doc") { copy(sessionId) }
      }
    }
    .sensoryFeedback(.success, trigger: copied)
  }

  private func copy(_ id: String) {
    UIPasteboard.general.string = id
    copied += 1
  }
}

/// Jump to latest (16 §16.6.4): a glass circle with `chevron.down`, 32 pt
/// over the open composer and 44 pt beside the folded one, or the
/// amber-dotted "Waiting for approval" pill when an approval is below (M6).
struct JumpToLatest: View {
  var waiting: Bool
  var size: CGFloat
  var action: () -> Void
  @Environment(\.palette) private var palette

  /// `ease.pop` (11 §11.6), 170 ms. MonoDesign has no token for it yet.
  static let pop = CubicBezier(0.16, 1, 0.3, 1).animation(milliseconds: 170)

  var body: some View {
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
        .glassEffect(.regular.tint(palette.base.color).interactive(), in: .capsule)
      } else {
        Image(systemName: "chevron.down")
          .font(.system(size: size > 32 ? 15 : 13, weight: .semibold))
          .foregroundStyle(palette.content.color)
          .frame(width: size, height: size)
          .glassEffect(.regular.tint(palette.base.color).interactive(), in: .circle)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(waiting ? "Waiting for approval. Jump to latest" : "Jump to latest")
  }

  /// The 32 pt jump 12 pt above the open composer, entering and leaving
  /// with `ease.pop`.
  struct Floating: View {
    var visible: Bool
    var waiting: Bool
    var action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
      Group {
        if visible {
          JumpToLatest(waiting: waiting, size: 32, action: action)
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94)).combined(with: .offset(y: 8)))
        }
      }
      .animation(JumpToLatest.pop, value: visible)
      .animation(JumpToLatest.pop, value: waiting)
    }
  }
}
