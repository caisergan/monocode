import CoreGraphics
import Foundation
import QuartzCore

/// What the main thread paints: every row's layout and exact prefix-sum
/// offsets. Immutable; a new one is published after each batch of ops.
final class Snapshot {
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

struct EngineStats {
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

/// Owns the row model on a serial layout queue. JavaScript sends ops; the
/// engine measures only new or changed rows and publishes snapshots to main.
final class TranscriptEngine {
  private let queue = DispatchQueue(label: "dev.monocode.transcript.layout", qos: .userInitiated)
  private var specs: [RowSpec] = []
  private var layouts: [RowLayout?] = []
  private var index: [String: Int] = [:]
  private var width: CGFloat = 0
  private var theme = TranscriptTheme.fallback
  private var themeRevision = 0
  private(set) var stats = EngineStats()
  /// Called on the main queue with every new snapshot.
  var publish: ((Snapshot) -> Void)?

  func setTheme(_ json: [String: Any]) {
    queue.async {
      self.themeRevision += 1
      self.theme = TranscriptTheme.parse(json, revision: self.themeRevision)
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

  func currentTheme(_ done: @escaping (TranscriptTheme) -> Void) {
    queue.async {
      let theme = self.theme
      DispatchQueue.main.async { done(theme) }
    }
  }

  func statsSnapshot(_ done: @escaping (EngineStats) -> Void) {
    queue.async {
      let stats = self.stats
      DispatchQueue.main.async { done(stats) }
    }
  }

  /// `json` is an array of ops: reset, insert, append, update, remove.
  func apply(_ json: String) {
    queue.async {
      guard let data = json.data(using: .utf8),
            let ops = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
      else { return }
      var structural = false
      var changed: [Int] = []
      for op in ops {
        switch op["op"] as? String {
        case "reset":
          self.specs = (op["rows"] as? [Any])?.compactMap(RowSpec.init) ?? []
          self.layouts = Array(repeating: nil, count: self.specs.count)
          self.rebuildIndex()
          self.coldLayout()
          return
        case "insert", "append":
          let rows = (op["rows"] as? [Any])?.compactMap(RowSpec.init) ?? []
          var at = self.specs.count
          if op["op"] as? String == "insert" {
            if let after = op["after"] as? String, let i = self.index[after] { at = i + 1 } else if op["after"] is NSNull || op["after"] == nil { at = 0 }
          }
          self.specs.insert(contentsOf: rows, at: at)
          self.layouts.insert(contentsOf: Array(repeating: nil, count: rows.count), at: at)
          structural = true
          self.rebuildIndex()
        case "update":
          for row in (op["rows"] as? [Any])?.compactMap(RowSpec.init) ?? [] {
            guard let i = self.index[row.id] else { continue }
            self.specs[i] = row
            self.layouts[i] = nil
            changed.append(i)
          }
        case "remove":
          let ids = Set((op["ids"] as? [String]) ?? [])
          guard !ids.isEmpty else { continue }
          var keptSpecs: [RowSpec] = []
          var keptLayouts: [RowLayout?] = []
          for (i, spec) in self.specs.enumerated() where !ids.contains(spec.id) {
            keptSpecs.append(spec)
            keptLayouts.append(self.layouts[i])
          }
          self.specs = keptSpecs
          self.layouts = keptLayouts
          structural = true
          self.rebuildIndex()
        default:
          continue
        }
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
      _ = changed
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
      var head = [RowLayout?](repeating: nil, count: tailStart)
      head.withUnsafeMutableBufferPointer { buffer in
        let base = buffer.baseAddress!
        let chunk = 64
        let chunks = (tailStart + chunk - 1) / chunk
        DispatchQueue.concurrentPerform(iterations: chunks) { c in
          let lower = c * chunk
          let upper = min(tailStart, lower + chunk)
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
