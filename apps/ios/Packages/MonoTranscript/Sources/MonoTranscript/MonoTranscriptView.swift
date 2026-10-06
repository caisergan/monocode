import QuartzCore
import UIKit

/// One recycled row: a plain layer whose contents is the row's raster.
private final class RowLayer: CALayer {
  var layout: RowLayout?

  override func action(forKey event: String) -> CAAction? { nil }
}

/// Rasters keyed by layout identity, bounded by bytes, least recently used out.
private final class RasterCache {
  private var entries: [ObjectIdentifier: (layout: RowLayout, image: CGImage, bytes: Int, used: UInt64)] = [:]
  private var bytes = 0
  private var tick: UInt64 = 0
  private let budget = 64 * 1024 * 1024

  func image(for layout: RowLayout) -> CGImage? {
    let key = ObjectIdentifier(layout)
    guard var entry = entries[key] else { return nil }
    tick += 1
    entry.used = tick
    entries[key] = entry
    return entry.image
  }

  func store(_ image: CGImage, for layout: RowLayout) {
    let key = ObjectIdentifier(layout)
    let size = image.bytesPerRow * image.height
    if let old = entries[key] { bytes -= old.bytes }
    tick += 1
    entries[key] = (layout, image, size, tick)
    bytes += size
    guard bytes > budget else { return }
    for (key, entry) in entries.sorted(by: { $0.value.used < $1.value.used }) {
      entries.removeValue(forKey: key)
      bytes -= entry.bytes
      if bytes <= budget * 3 / 4 { break }
    }
  }

  func removeAll() {
    entries.removeAll()
    bytes = 0
  }
}

/// What the view reports to its owner (15 §15.4). Every method is optional.
@MainActor
public protocol TranscriptViewDelegate: AnyObject {
  /// A button, fold line or trail row was tapped.
  func transcript(_ view: MonoTranscriptView, didTapAction actionId: String, rowId: String)
  /// A link or file chip was tapped.
  func transcript(_ view: MonoTranscriptView, didTapLink href: String, rowId: String)
  /// A file chip: `reference` is the path as the chip reads it, possibly
  /// with `:line`; trail rows show only the file name.
  func transcript(_ view: MonoTranscriptView, didTapFile reference: String, rowId: String)
  /// Drives the jump-to-latest button.
  func transcript(_ view: MonoTranscriptView, atBottomChanged atBottom: Bool)
  /// The reader reached the top; the owner loads an older page.
  func transcriptNeedsOlder(_ view: MonoTranscriptView)
  /// The first non-empty snapshot is on screen.
  func transcript(_ view: MonoTranscriptView, didBecomeReadyWith rows: Int)
  /// A fling benchmark finished; the result is also in Documents/benchmarks.
  func transcript(_ view: MonoTranscriptView, didFinishBenchmark result: BenchmarkResult)
}

extension TranscriptViewDelegate {
  public func transcript(_ view: MonoTranscriptView, didTapAction actionId: String, rowId: String) {}
  public func transcript(_ view: MonoTranscriptView, didTapLink href: String, rowId: String) {}
  public func transcript(_ view: MonoTranscriptView, didTapFile reference: String, rowId: String) {}
  public func transcript(_ view: MonoTranscriptView, atBottomChanged atBottom: Bool) {}
  public func transcriptNeedsOlder(_ view: MonoTranscriptView) {}
  public func transcript(_ view: MonoTranscriptView, didBecomeReadyWith rows: Int) {}
  public func transcript(_ view: MonoTranscriptView, didFinishBenchmark result: BenchmarkResult) {}
}

/// One fling benchmark run (15 §15.6), written to
/// Documents/benchmarks/latest.json. Times are in milliseconds.
public struct BenchmarkResult: Codable, Sendable {
  public var frames: Int
  public var seconds: Double
  public var expectedFrameMs: Double
  public var hitches: Int
  public var hitchMs: Double
  /// Hitch milliseconds per second of scrolling.
  public var hitchRatio: Double
  public var frameP50: Double
  public var frameP95: Double
  public var frameP99: Double
  public var frameMax: Double
  public var rows: Int
  public var contentHeight: Double
  public var rasterCount: Int
  public var rasterP50: Double
  public var rasterP95: Double
  public var syncDraws: Int
  public var coldFirstMs: Double
  public var coldTotalMs: Double
  public var coldRows: Int
  public var measureP50: Double
  public var measureP95: Double
  public var tailUpdates: Int
  public var tailUpdateP50: Double
  public var tailUpdateP95: Double
  public var device: String
  public var os: String
  public var at: Double
}

private struct BenchmarkRun {
  var started: CFTimeInterval
  var duration: CFTimeInterval
  var speed: CGFloat
  var direction: CGFloat = 1
  var last: CFTimeInterval?
  var intervals: [Double] = []
  var hitchMs: Double = 0
  var hitches = 0
  var expected: Double = 1 / 60
}

public final class MonoTranscriptView: UIView, UIScrollViewDelegate {
  public weak var delegate: TranscriptViewDelegate?

  private let scrollView = UIScrollView()
  private let canvas = UIView()
  private let engine = TranscriptEngine()
  private var snapshot = Snapshot.empty
  private var theme = TranscriptTheme.fallback
  private var visible: [String: RowLayer] = [:]
  private var pool: [RowLayer] = []
  private let cache = RasterCache()
  private let rasterQueue = DispatchQueue(label: "dev.monocode.transcript.raster", qos: .userInitiated)
  private var rasterPending = Set<ObjectIdentifier>()
  private var following = true
  private var atBottom = true
  private var dragging = false
  private var lastOffset: CGFloat = 0
  private var olderRequested = false
  private var benchmark: BenchmarkRun?
  private var displayLink: CADisplayLink?
  private var rasterTimes: [Double] = []
  private var syncDraws = 0
  private var announcedReady = false
  private var screenScale: CGFloat = 3

  /// Space under the last row, such as the composer and the home indicator.
  public var bottomInset: CGFloat = 0 {
    didSet { updateInsets() }
  }
  /// Space above the first row, such as the navigation bar.
  public var topInset: CGFloat = 0 {
    didSet { updateInsets() }
  }

  /// The scroll view, for a hosting controller to register as its content
  /// scroll view (`setContentScrollView(_:for:)`) so bars see its edges.
  public var contentScrollView: UIScrollView { scrollView }

  public override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    scrollView.delegate = self
    scrollView.alwaysBounceVertical = true
    scrollView.contentInsetAdjustmentBehavior = .never
    scrollView.keyboardDismissMode = .interactive
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.addSubview(canvas)
    addSubview(scrollView)
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    tap.cancelsTouchesInView = false
    scrollView.addGestureRecognizer(tap)
    engine.publish = { [weak self] snapshot in self?.commit(snapshot) }
    registerForTraitChanges([UITraitDisplayScale.self]) { (view: MonoTranscriptView, _) in
      view.updateScale()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  // MARK: API

  /// Applies one frame's batch of ops (15 §15.4): reset, insert, append,
  /// update, remove. Rows are measured on the layout queue.
  public func apply(_ ops: [TranscriptOp]) {
    guard !ops.isEmpty else { return }
    engine.apply(ops)
  }

  /// Replaces every row, for example when a session opens.
  public func reset(rows: [RowSpec]) {
    engine.apply([.reset(rows)])
  }

  /// Sets colours and text styles (`ThemeSpec.make(palette:)`).
  public func setTheme(_ spec: ThemeSpec) {
    let parsed = TranscriptTheme.parse(spec, revision: theme.revision + 1)
    theme = parsed
    backgroundColor = UIColor(cgColor: parsed.background)
    scrollView.backgroundColor = backgroundColor
    cache.removeAll()
    for (_, layer) in visible { layer.backgroundColor = parsed.background; layer.layout = nil }
    engine.setTheme(spec)
  }

  public func scrollToBottom(animated: Bool) {
    following = true
    let target = maxOffset()
    scrollView.setContentOffset(CGPoint(x: 0, y: target), animated: animated)
    setAtBottom(true)
  }

  public func setFollowTail(_ on: Bool) {
    following = on
    if on { scrollToBottom(animated: false) }
  }

  // MARK: Layout

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    updateScale()
  }

  private func updateScale() {
    let scale = traitCollection.displayScale
    guard scale > 0, scale != screenScale else { return }
    screenScale = scale
    cache.removeAll()
    for (_, layer) in visible { layer.contentsScale = scale; layer.layout = nil }
    realize()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    let wasAtBottom = following
    scrollView.frame = bounds
    engine.setWidth(bounds.width)
    updateInsets()
    if wasAtBottom { scrollView.contentOffset.y = maxOffset() }
    realize()
  }

  private func updateInsets() {
    scrollView.contentInset = UIEdgeInsets(top: topInset, left: 0, bottom: bottomInset, right: 0)
    scrollView.verticalScrollIndicatorInsets = scrollView.contentInset
    if following { scrollView.contentOffset.y = maxOffset() }
  }

  private func maxOffset() -> CGFloat {
    max(-scrollView.contentInset.top, snapshot.total + scrollView.contentInset.bottom - scrollView.bounds.height)
  }

  /// Swaps in a new snapshot. Off the tail, the first visible row keeps its
  /// screen position, so rows inserted or resized above it never move it.
  private func commit(_ next: Snapshot) {
    guard abs(next.width - bounds.width) < 0.5 else { return }
    var anchor: (String, CGFloat)?
    let y = scrollView.contentOffset.y
    if !following, let first = snapshot.row(at: max(0, y)) {
      anchor = (snapshot.ids[first], snapshot.offsets[first] - y)
    }
    snapshot = next
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    canvas.frame = CGRect(x: 0, y: 0, width: bounds.width, height: next.total)
    scrollView.contentSize = CGSize(width: bounds.width, height: next.total)
    if following {
      scrollView.contentOffset.y = maxOffset()
    } else if let (id, delta) = anchor, let i = next.index[id] {
      scrollView.contentOffset.y = next.offsets[i] - delta
    }
    realize()
    CATransaction.commit()
    if !announcedReady && next.count > 0 {
      announcedReady = true
      delegate?.transcript(self, didBecomeReadyWith: next.count)
    }
    if next.count > 0 && scrollView.contentOffset.y > 600 { olderRequested = false }
  }

  /// Binds layers to the rows within one screen above and below the viewport.
  private func realize() {
    let height = max(scrollView.bounds.height, 1)
    let top = scrollView.contentOffset.y
    let viewport = CGRect(x: 0, y: top, width: bounds.width, height: height)
    let range = viewport.insetBy(dx: 0, dy: -height)
    guard snapshot.count > 0, let first = snapshot.row(at: max(0, range.minY)) else {
      for (_, layer) in visible { recycle(layer) }
      visible.removeAll()
      return
    }
    var keep = Set<String>()
    var i = first
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    while i < snapshot.count && snapshot.offsets[i] < range.maxY {
      let layout = snapshot.layouts[i]
      let id = snapshot.ids[i]
      keep.insert(id)
      let frame = CGRect(x: 0, y: snapshot.offsets[i], width: layout.width, height: layout.height)
      let layer = visible[id] ?? dequeue()
      visible[id] = layer
      if layer.frame != frame { layer.frame = frame }
      if layer.layout !== layout {
        layer.layout = layout
        let onScreen = frame.intersects(viewport)
        if let image = cache.image(for: layout) {
          layer.contents = image
        } else if onScreen && layer.contents == nil {
          // Never show a blank row: draw it now.
          layer.contents = rasterNow(layout)
        } else {
          rasterLater(layout)
        }
        updatePulse(layer, layout)
      }
      i += 1
    }
    for (id, layer) in visible where !keep.contains(id) {
      recycle(layer)
      visible.removeValue(forKey: id)
    }
    CATransaction.commit()
  }

  private func dequeue() -> RowLayer {
    let layer = pool.popLast() ?? RowLayer()
    layer.contentsScale = screenScale
    layer.contentsGravity = .top
    layer.isOpaque = true
    layer.masksToBounds = true
    layer.backgroundColor = theme.background
    canvas.layer.addSublayer(layer)
    return layer
  }

  private func recycle(_ layer: RowLayer) {
    layer.removeAllAnimations()
    layer.removeFromSuperlayer()
    layer.contents = nil
    layer.layout = nil
    if pool.count < 64 { pool.append(layer) }
  }

  private func updatePulse(_ layer: RowLayer, _ layout: RowLayout) {
    if layout.pulse && !UIAccessibility.isReduceMotionEnabled {
      guard layer.animation(forKey: "pulse") == nil else { return }
      let pulse = CABasicAnimation(keyPath: "opacity")
      pulse.fromValue = 1
      pulse.toValue = 0.45
      pulse.duration = 0.9
      pulse.autoreverses = true
      pulse.repeatCount = .infinity
      pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      layer.add(pulse, forKey: "pulse")
    } else {
      layer.removeAnimation(forKey: "pulse")
    }
  }

  nonisolated private static func render(_ layout: RowLayout, theme: TranscriptTheme, scale: CGFloat) -> CGImage? {
    guard layout.height >= 1, layout.width >= 1 else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = scale
    format.opaque = true
    format.preferredRange = .standard
    let size = CGSize(width: layout.width, height: layout.height)
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      let ctx = context.cgContext
      ctx.setFillColor(theme.background)
      ctx.fill(CGRect(origin: .zero, size: size))
      layout.draw(in: ctx, chipColor: theme.color("chip"), fileChipColor: theme.color("fileChip"))
    }
    return image.cgImage
  }

  private func rasterNow(_ layout: RowLayout) -> CGImage? {
    let started = CACurrentMediaTime()
    let image = Self.render(layout, theme: theme, scale: screenScale)
    syncDraws += 1
    recordRaster((CACurrentMediaTime() - started) * 1000)
    if let image { cache.store(image, for: layout) }
    return image
  }

  private func rasterLater(_ layout: RowLayout) {
    let key = ObjectIdentifier(layout)
    guard !rasterPending.contains(key) else { return }
    rasterPending.insert(key)
    let theme = self.theme
    let scale = screenScale
    rasterQueue.async { [weak self] in
      let started = CACurrentMediaTime()
      let image = Self.render(layout, theme: theme, scale: scale)
      let ms = (CACurrentMediaTime() - started) * 1000
      DispatchQueue.main.async {
        guard let self else { return }
        self.rasterPending.remove(key)
        self.recordRaster(ms)
        guard let image, theme === self.theme else { return }
        self.cache.store(image, for: layout)
        if let layer = self.visible[layout.id], layer.layout === layout {
          CATransaction.begin()
          CATransaction.setDisableActions(true)
          layer.contents = image
          CATransaction.commit()
        }
      }
    }
  }

  private func recordRaster(_ ms: Double) {
    rasterTimes.append(ms)
    if rasterTimes.count > 4000 { rasterTimes.removeFirst(rasterTimes.count - 4000) }
  }

  // MARK: Scrolling

  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    dragging = true
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { dragging = false }
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    dragging = false
  }

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let y = scrollView.contentOffset.y
    // Any upward scroll by the person un-pins; within 16 pt of the end pins.
    let nearBottom = y >= maxOffset() - 16
    if dragging && y < lastOffset - 0.5 { following = false }
    if nearBottom && benchmark == nil { following = true }
    setAtBottom(nearBottom)
    lastOffset = y
    realize()
    if y < 400 && !olderRequested && snapshot.count > 0 && benchmark == nil {
      olderRequested = true
      delegate?.transcriptNeedsOlder(self)
    }
  }

  private func setAtBottom(_ value: Bool) {
    guard value != atBottom else { return }
    atBottom = value
    delegate?.transcript(self, atBottomChanged: value)
  }

  // MARK: Touch

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    let point = gesture.location(in: canvas)
    guard let i = snapshot.row(at: point.y) else { return }
    let layout = snapshot.layouts[i]
    let local = CGPoint(x: point.x, y: point.y - snapshot.offsets[i])
    for hit in layout.hits where hit.rect.contains(local) {
      if let link = hit.link {
        delegate?.transcript(self, didTapLink: link, rowId: layout.id)
      } else if let file = hit.file {
        delegate?.transcript(self, didTapFile: file, rowId: layout.id)
      } else if let action = hit.action {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        delegate?.transcript(self, didTapAction: action, rowId: layout.id)
      }
      return
    }
  }

  // MARK: Benchmark

  /// Flings top to bottom and back at `speed` pt/s for `durationMs`, timing
  /// every display-link frame. A frame later than 1.5× its budget counts as
  /// a hitch; the hitch ratio is hitch milliseconds per second of scrolling.
  public func runBenchmark(durationMs: Double, speed: Double) {
    displayLink?.invalidate()
    following = false
    benchmark = BenchmarkRun(started: CACurrentMediaTime(), duration: durationMs / 1000, speed: CGFloat(speed))
    rasterTimes.removeAll()
    syncDraws = 0
    let link = CADisplayLink(target: self, selector: #selector(benchmarkTick(_:)))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
    link.add(to: .main, forMode: .common)
    displayLink = link
  }

  @objc private func benchmarkTick(_ link: CADisplayLink) {
    guard var run = benchmark else { return }
    let now = link.timestamp
    run.expected = link.targetTimestamp - link.timestamp
    if let last = run.last {
      let interval = now - last
      run.intervals.append(interval * 1000)
      if interval > run.expected * 1.5 {
        run.hitches += 1
        run.hitchMs += (interval - run.expected) * 1000
      }
      var y = scrollView.contentOffset.y + run.direction * run.speed * CGFloat(interval)
      let top = -scrollView.contentInset.top
      if y >= maxOffset() { y = maxOffset(); run.direction = -1 }
      if y <= top { y = top; run.direction = 1 }
      scrollView.contentOffset.y = y
    }
    run.last = now
    benchmark = run
    if now - run.started >= run.duration { finishBenchmark(run) }
  }

  private func finishBenchmark(_ run: BenchmarkRun) {
    displayLink?.invalidate()
    displayLink = nil
    benchmark = nil
    let sorted = run.intervals.sorted()
    let pick = { (p: Double) -> Double in sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
    let seconds = max(0.001, run.intervals.reduce(0, +) / 1000)
    let rasters = rasterTimes.sorted()
    let rasterPick = { (p: Double) -> Double in rasters.isEmpty ? 0 : rasters[min(rasters.count - 1, Int(Double(rasters.count) * p))] }
    engine.statsSnapshot { [weak self] stats in
      guard let self else { return }
      let updates = stats.tailUpdateMs.sorted()
      let measures = stats.measureMs.sorted()
      let percentile = { (values: [Double], p: Double) -> Double in values.isEmpty ? 0 : values[min(values.count - 1, Int(Double(values.count) * p))] }
      let result = BenchmarkResult(
        frames: run.intervals.count,
        seconds: seconds,
        expectedFrameMs: run.expected * 1000,
        hitches: run.hitches,
        hitchMs: run.hitchMs,
        hitchRatio: run.hitchMs / seconds,
        frameP50: pick(0.5),
        frameP95: pick(0.95),
        frameP99: pick(0.99),
        frameMax: sorted.last ?? 0,
        rows: self.snapshot.count,
        contentHeight: self.snapshot.total,
        rasterCount: rasters.count,
        rasterP50: rasterPick(0.5),
        rasterP95: rasterPick(0.95),
        syncDraws: self.syncDraws,
        coldFirstMs: stats.coldFirstMs,
        coldTotalMs: stats.coldTotalMs,
        coldRows: stats.coldRows,
        measureP50: percentile(measures, 0.5),
        measureP95: percentile(measures, 0.95),
        tailUpdates: updates.count,
        tailUpdateP50: percentile(updates, 0.5),
        tailUpdateP95: percentile(updates, 0.95),
        device: Self.deviceName(),
        os: UIDevice.current.systemVersion,
        at: Date().timeIntervalSince1970)
      Self.save(result)
      self.delegate?.transcript(self, didFinishBenchmark: result)
    }
  }

  /// Results also land in Documents/benchmarks, so a run on a device can be
  /// collected with `xcrun devicectl device copy from`.
  private static func save(_ result: BenchmarkResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(result),
          let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
    let folder = documents.appendingPathComponent("benchmarks", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let name = "bench-\(Int(Date().timeIntervalSince1970)).json"
    try? data.write(to: folder.appendingPathComponent(name))
    try? data.write(to: folder.appendingPathComponent("latest.json"))
    NSLog("[MonoBench] %@", String(data: data, encoding: .utf8) ?? "")
  }

  /// The hardware model ("iPhone14,5"), or the simulated one on a simulator.
  private static func deviceName() -> String {
    if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
      return "\(simulated) (simulator)"
    }
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { bytes in
      String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
    }
  }
}
