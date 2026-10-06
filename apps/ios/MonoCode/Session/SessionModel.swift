import MonoDesign
import MonoSync
import MonoTranscript
import MonoWire
import SwiftUI

/// One open session (11 §11.15): its window, the transcript it feeds, and
/// what the screen shows over it. The transcript is fed off the main thread;
/// this object holds only what SwiftUI draws.
@MainActor @Observable
final class SessionModel: TranscriptViewDelegate {
  let env: String
  let sessionId: String
  @ObservationIgnored let transcript = MonoTranscriptView()
  @ObservationIgnored private var feed: TranscriptFeed?
  @ObservationIgnored private var interest: Interest?
  @ObservationIgnored private weak var sync: HostSync?
  private(set) var store: SessionStore?
  /// The transcript is at its end; the jump button hides.
  private(set) var atBottom = true
  /// The block a tapped tool, thinking or trail row shows in the tool sheet.
  var toolBlock: ToolSheetItem?
  @ObservationIgnored var openURL: ((URL) -> Void)?

  init(env: String, sessionId: String) {
    self.env = env
    self.sessionId = sessionId
    transcript.delegate = self
    feed = TranscriptFeed { [weak transcript] ops in transcript?.apply(ops) }
  }

  /// Watches the session while the screen shows it.
  func open(_ sync: HostSync) {
    guard interest == nil else { return }
    self.sync = sync
    let (store, interest) = sync.openSession(sessionId)
    self.store = store
    self.interest = interest
    let feed = feed
    store.onWindow = { value, window in feed?.update(value, window) }
    // A window that lingered from a recent visit paints at once.
    if let value = store.value { feed?.update(value, store.window) }
  }

  func close() {
    store?.onWindow = nil
    interest?.release()
    interest = nil
  }

  func setTheme(_ palette: Palette) {
    transcript.setTheme(ThemeSpec.make(palette))
  }

  func jumpToLatest() {
    transcript.scrollToBottom(animated: true)
  }

  /// An undecided approval in the window (M6: the jump button says so).
  var waitingForApproval: Bool {
    store?.value?.session.blocks.contains(where: Transcript.needsApproval) ?? false
  }

  private func loadOlder() {
    guard let sync, let store, store.hasOlder, !store.loadingOlder else { return }
    feed?.setLoadingOlder(true)
    Task {
      await sync.loadOlder(store)
      feed?.setLoadingOlder(false)
    }
  }

  // MARK: TranscriptViewDelegate

  func transcript(_ view: MonoTranscriptView, didTapAction actionId: String, rowId: String) {
    switch actionId {
    case "fold":
      feed?.toggleFold(rowId)
    case "older":
      loadOlder()
    case RowBuilder.toolAction, "open":
      guard let block = store?.block(rowId) else { return }
      toolBlock = ToolSheetItem(block: block, cwd: store?.value?.session.cwd)
    default:
      // Allow, Deny, Build, drafts and attachments are the write path (R3)
      // and the attachment sheet (R2).
      break
    }
  }

  func transcript(_ view: MonoTranscriptView, didTapLink href: String, rowId: String) {
    if let url = URL(string: href), url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" { openURL?(url) }
  }

  func transcript(_ view: MonoTranscriptView, atBottomChanged atBottom: Bool) {
    self.atBottom = atBottom
  }

  func transcriptNeedsOlder(_ view: MonoTranscriptView) {
    loadOlder()
  }
}

/// A block for the tool sheet.
struct ToolSheetItem: Identifiable {
  var block: Block
  var cwd: String?
  var id: String { block.id }
}
