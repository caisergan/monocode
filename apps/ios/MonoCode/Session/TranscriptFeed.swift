import Foundation
import MonoTranscript
import MonoWire
import QuartzCore

/// Feeds one session's window to its transcript (12 §12.9, 15 §15.4): the
/// row builder and the diff run on a serial queue off the main thread, and
/// the resulting ops reach the view at most once per display frame. SwiftUI
/// never re-renders for a streamed token.
nonisolated final class TranscriptFeed: @unchecked Sendable {
  private let queue = DispatchQueue(label: "dev.monocode.transcript.rows", qos: .userInitiated)
  /// Touched only on `queue`.
  private let builder = RowBuilder()
  private var blocks: [Block] = []
  private var options = RowOptions()
  private var rows: [RowSpec] = []
  private var hasWindow = false
  /// Touched only on the main thread.
  private var pending: [TranscriptOp] = []
  private var scheduled = false
  private let deliver: @MainActor @Sendable ([TranscriptOp]) -> Void

  init(deliver: @escaping @MainActor @Sendable ([TranscriptOp]) -> Void) {
    self.deliver = deliver
  }

  /// A new window from the sync pipeline (any thread).
  func update(_ value: HostSession, _ window: WindowMeta?) {
    queue.async {
      self.blocks = value.session.blocks
      self.options.live = value.isRunning
      self.options.cwd = value.session.cwd
      self.options.hasOlder = (window?.olderTurns ?? 0) > 0
      self.hasWindow = true
      self.rebuild()
    }
  }

  /// Opens or closes a fold.
  func toggleFold(_ id: String) {
    queue.async {
      if self.options.open.contains(id) { self.options.open.remove(id) } else { self.options.open.insert(id) }
      self.rebuild()
    }
  }

  func setLoadingOlder(_ loading: Bool) {
    queue.async {
      guard self.options.loadingOlder != loading else { return }
      self.options.loadingOlder = loading
      self.rebuild()
    }
  }

  private func rebuild() {
    guard hasWindow else { return }
    let next = builder.rows(blocks, options)
    let ops = RowDiff.ops(rows, next)
    rows = next
    guard !ops.isEmpty else { return }
    DispatchQueue.main.async { self.enqueue(ops) }
  }

  /// Coalesces the ops of one display frame into one batch.
  @MainActor private func enqueue(_ ops: [TranscriptOp]) {
    pending.append(contentsOf: ops)
    guard !scheduled else { return }
    scheduled = true
    let link = CADisplayLink(target: FrameTarget { [weak self] link in
      link.invalidate()
      guard let self else { return }
      self.scheduled = false
      let batch = self.pending
      self.pending = []
      self.deliver(batch)
    }, selector: #selector(FrameTarget.step(_:)))
    link.add(to: .main, forMode: .common)
  }
}

/// CADisplayLink retains its target; this keeps the feed out of that cycle.
private final class FrameTarget: NSObject {
  let onFrame: (CADisplayLink) -> Void

  init(_ onFrame: @escaping (CADisplayLink) -> Void) {
    self.onFrame = onFrame
  }

  @objc func step(_ link: CADisplayLink) {
    onFrame(link)
  }
}
