import CoreGraphics
import Foundation
import QuartzCore

/// What the main thread paints: every row's layout and exact prefix-sum
/// offsets. Immutable; a new one is published after each batch of ops.
final class Snapshot: Sendable {
  let ids: [String]
  let layouts: [RowLayout]
  /// offsets[i] is the top of row i; offsets[count] is the total height.
  let offsets: [CGFloat]
  let index: [String: Int]
  let width: CGFloat

  init(ids: [String], layouts: [RowLayout], index: [String: Int], width: CGFloat) {
    self.ids = ids
    self.layouts = layouts
    self.index = index
    self.width = width
    var offsets = [CGFloat](repeating: 0, count: layouts.count + 1)
    var y: CGFloat = 0
    for (i, layout) in layouts.enumerated() {
      offsets[i] = y
      y += layout.height
    }
    offsets[layouts.count] = y
    self.offsets = offsets
  }

  var total: CGFloat { offsets.last ?? 0 }
  var count: Int { layouts.count }

  static let empty = Snapshot(ids: [], layouts: [], index: [:], width: 0)

  /// The row containing y (binary search over offsets).
  func row(at y: CGFloat) -> Int? {
    guard count > 0 else { return nil }
    var low = 0
    var high = count - 1
    while low < high {
      let mid = (low + high + 1) / 2
      if offsets[mid] <= y { low = mid } else { high = mid - 1 }
    }
    return low
  }
}

struct EngineStats: Sendable {
  var coldFirstMs: Double = 0
  var coldTotalMs: Double = 0
  var coldRows = 0
  var tailUpdateMs: [Double] = []
  var measureMs: [Double] = []

  mutating func record(update ms: Double) {
    tailUpdateMs.append(ms)
    if tailUpdateMs.count > 2000 { tailUpdateMs.removeFirst(tailUpdateMs.count - 2000) }
  }
}

/// Owns the row model on a serial layout queue. The owner sends ops; the
/// engine measures only new or changed rows and publishes snapshots to main.
/// Every mutable property is touched only on `queue`, except `publish`, which
/// is set once on the main thread before any op.
final class TranscriptEngine: @unchecked Sendable {
  private let queue = DispatchQueue(label: "dev.monocode.transcript.layout", qos: .userInitiated)
  private var specs: [RowSpec] = []
  private var layouts: [RowLayout?] = []
  private var index: [String: Int] = [:]
  private var width: CGFloat = 0
  private var theme = TranscriptTheme.fallback
  private var themeRevision = 0
  private(set) var stats = EngineStats()
  /// Called on the main queue with every new snapshot.
  var publish: (@MainActor @Sendable (Snapshot) -> Void)?

  /// The theme's colours, styles and scale; fonts are resolved on the queue.
  func setTheme(_ spec: ThemeSpec) {
    queue.async {
      self.themeRevision += 1
      self.theme = TranscriptTheme.parse(spec, revision: self.themeRevision)
      self.relayoutAll()
    }
  }

  func setWidth(_ newWidth: CGFloat) {
    queue.async {
      guard abs(newWidth - self.width) > 0.5 else { return }
      self.width = newWidth
      self.relayoutAll()
    }
  }

  func currentTheme(_ done: @escaping @MainActor @Sendable (TranscriptTheme) -> Void) {
    queue.async {
      let theme = self.theme
      DispatchQueue.main.async { done(theme) }
    }
  }

  func statsSnapshot(_ done: @escaping @MainActor @Sendable (EngineStats) -> Void) {
    queue.async {
      let stats = self.stats
      DispatchQueue.main.async { done(stats) }
    }
  }

  /// One frame's batch of ops: reset, insert, append, update, remove.
  func apply(_ ops: [TranscriptOp]) {
    queue.async {
      var structural = false
      var reset = false
      for op in ops {
        switch op {
        case let .reset(rows):
          // Ops after a reset in the same batch still apply; the whole
          // transcript is laid out once at the end.
          self.specs = rows
          self.layouts = Array(repeating: nil, count: rows.count)
          self.rebuildIndex()
          reset = true
        case let .insert(after, rows):
          var at = 0
          if let after { at = self.index[after].map { $0 + 1 } ?? self.specs.count }
          self.specs.insert(contentsOf: rows, at: at)
          self.layouts.insert(contentsOf: Array(repeating: nil, count: rows.count), at: at)
          structural = true
          self.rebuildIndex()
        case let .append(rows):
          self.specs.append(contentsOf: rows)
          self.layouts.append(contentsOf: Array(repeating: nil, count: rows.count))
          structural = true
          self.rebuildIndex()
        case let .update(rows):
          for row in rows {
            guard let i = self.index[row.id] else { continue }
            self.specs[i] = row
            self.layouts[i] = nil
          }
        case let .remove(ids):
          let gone = Set(ids)
          guard !gone.isEmpty else { continue }
          var keptSpecs: [RowSpec] = []
          var keptLayouts: [RowLayout?] = []
          for (i, spec) in self.specs.enumerated() where !gone.contains(spec.id) {
            keptSpecs.append(spec)
            keptLayouts.append(self.layouts[i])
          }
          self.specs = keptSpecs
          self.layouts = keptLayouts
          structural = true
          self.rebuildIndex()
        }
      }
      if reset {
        self.coldLayout()
        return
      }
      guard self.width > 0 else { return }
      let started = CACurrentMediaTime()
      var measured = 0
      for i in self.layouts.indices where self.layouts[i] == nil {
        self.layouts[i] = RowLayouter.make(self.specs[i], width: self.width, theme: self.theme)
        measured += 1
      }
      if !structural && measured > 0 && measured <= 2 {
        self.stats.record(update: (CACurrentMediaTime() - started) * 1000)
      }
      self.emit()
    }
  }

  private func rebuildIndex() {
    var map: [String: Int] = [:]
    map.reserveCapacity(specs.count)
    for (i, spec) in specs.enumerated() { map[spec.id] = i }
    index = map
  }

  private func emit() {
    let ready = layouts.compactMap { $0 }
    guard ready.count == layouts.count else { return }
    let snapshot = Snapshot(ids: specs.map(\.id), layouts: ready, index: index, width: width)
    DispatchQueue.main.async { self.publish?(snapshot) }
  }

  private func relayoutAll() {
    guard width > 0, !specs.isEmpty else { return }
    layouts = Array(repeating: nil, count: specs.count)
    coldLayout()
  }

  /// Measures the tail first and publishes it at once (the reader opens at
  /// the bottom), then measures everything above in parallel and publishes
  /// the full transcript. The main thread keeps the visible row anchored, so
  /// the rows arriving above never move what is on screen.
  private func coldLayout() {
    guard width > 0 else { return }
    let started = CACurrentMediaTime()
    let count = specs.count
    let specs = self.specs
    let width = self.width
    let theme = self.theme
    // Roughly two screens of rows from the end.
    var tailStart = count
    var tailHeight: CGFloat = 0
    while tailStart > 0 && tailHeight < 2400 {
      tailStart -= 1
      let layout = RowLayouter.make(specs[tailStart], width: width, theme: theme)
      layouts[tailStart] = layout
      tailHeight += layout.height
    }
    if tailStart > 0 {
      let tail = Snapshot(ids: specs[tailStart...].map(\.id), layouts: layouts[tailStart...].compactMap { $0 },
                          index: Dictionary(uniqueKeysWithValues: specs[tailStart...].enumerated().map { ($1.id, $0) }),
                          width: width)
      stats.coldFirstMs = (CACurrentMediaTime() - started) * 1000
      DispatchQueue.main.async { self.publish?(tail) }
      let headCount = tailStart
      var head = [RowLayout?](repeating: nil, count: headCount)
      head.withUnsafeMutableBufferPointer { buffer in
        // Each iteration writes its own disjoint slice.
        nonisolated(unsafe) let base = buffer.baseAddress!
        let chunk = 64
        let chunks = (headCount + chunk - 1) / chunk
        DispatchQueue.concurrentPerform(iterations: chunks) { c in
          let lower = c * chunk
          let upper = min(headCount, lower + chunk)
          for i in lower..<upper {
            (base + i).pointee = RowLayouter.make(specs[i], width: width, theme: theme)
          }
        }
      }
      for i in 0..<tailStart { layouts[i] = head[i] }
    } else {
      stats.coldFirstMs = (CACurrentMediaTime() - started) * 1000
    }
    stats.coldTotalMs = (CACurrentMediaTime() - started) * 1000
    stats.coldRows = count
    stats.measureMs = layouts.compactMap { $0?.measureMs }
    emit()
  }
}
