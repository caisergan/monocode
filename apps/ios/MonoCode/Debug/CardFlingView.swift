#if DEBUG
import MonoDesign
import MonoWire
import SwiftUI
import UIKit

/// S19 (16 §16.8): a SwiftUI `List` of 500 session cards with swipe actions
/// and context menus, flung at 6,000 pt/s for 10 s, as the R0 transcript
/// benchmark flings the transcript. Frames longer than 1.5 × the display's
/// frame time are hitches. The result goes to
/// `Documents/benchmarks/s19-cold.json` and `s19-warm.json`.
/// `<scheme>://fling-cards?run=1` runs a cold pass, then a warm one.
struct CardFlingView: View {
  var autorun = false
  @State private var bench = CardFlingBench()
  @Environment(\.palette) private var palette

  static let cards: [CardItem] = (0..<500).map { i in
    let statuses: [(SessionStatus, AttentionKind?)] = [(.idle, .finished), (.running, nil), (.idle, .approval), (.idle, nil), (.idle, .error)]
    let (status, attention) = statuses[i % statuses.count]
    return CardItem(
      env: "bench", sessionId: "s\(i)", title: "Session \(i): \(["Fix flaky auth test", "Profile the transcript scroll", "Add pagination to /sessions", "Bump dependencies"][i % 4])",
      harness: "claude", model: "Claude Opus 4.6", status: status, attention: attention, pinned: i % 17 == 0, draft: i % 23 == 0,
      unseen: i % 2 == 0, updatedAt: Int(Date().timeIntervalSince1970 * 1000) - i * 3_600_000, project: "my-app", machine: "Demo",
      branch: i % 3 == 0 ? "fix/auth" : "main", lastLine: "The failure comes from a race in the session store.",
      detail: i % 5 == 2 ? ("Approve: npm test -- auth", true) : i % 3 == 0 ? ("The failure comes from a race in the session store.", false) : nil,
      workItem: i % 11 == 0 ? "#\(100 + i)" : nil, providerSessionId: nil)
  }

  var body: some View {
    List {
      ForEach(Self.cards) { card in
        SessionRow(card: card, seenSwipe: true)
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background { ScrollViewProbe { bench.scrollView = $0 } }
    .screenBackground()
    .navigationTitle("Card fling (S19)")
    .toolbarTitleDisplayMode(.inline)
    .safeAreaBar(edge: .bottom) {
      HStack {
        Text(bench.summary)
          .font(.caption2.monospaced())
          .foregroundStyle(palette.text.secondary.color)
          .frame(maxWidth: .infinity, alignment: .leading)
        Button("Fling 10 s") { bench.start() }
          .disabled(bench.running)
          .buttonStyle(.glass)
      }
      .padding(10)
      .glassEffect(.regular, in: .rect(cornerRadius: 12))
      .padding(.horizontal, 12)
    }
    .task {
      guard autorun else { return }
      try? await Task.sleep(for: .seconds(2))
      bench.start()
      // A second, warm pass: every cell has been realised once.
      try? await Task.sleep(for: .seconds(12))
      bench.start()
    }
  }
}

/// Finds the collection view behind a SwiftUI `List`: the probe sits in the
/// list's background, inside the same hosting hierarchy.
private struct ScrollViewProbe: UIViewRepresentable {
  var found: (UIScrollView) -> Void

  func makeUIView(context: Context) -> Probe { Probe(found: found) }
  func updateUIView(_ view: Probe, context: Context) {}

  final class Probe: UIView {
    let found: (UIScrollView) -> Void

    init(found: @escaping (UIScrollView) -> Void) {
      self.found = found
      super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      DispatchQueue.main.async { [weak self] in
        guard let self, let root = self.window else { return }
        if let scroll = Self.largestScrollView(in: root) { self.found(scroll) }
      }
    }

    static func largestScrollView(in view: UIView) -> UIScrollView? {
      var best: UIScrollView?
      var stack = [view]
      while let next = stack.popLast() {
        if let scroll = next as? UICollectionView, scroll.contentSize.height > (best?.contentSize.height ?? 0) { best = scroll }
        stack.append(contentsOf: next.subviews)
      }
      return best
    }
  }
}

struct CardFlingResult: Codable {
  var cards: Int
  var frames: Int
  var seconds: Double
  var expectedFrameMs: Double
  var hitches: Int
  var hitchMs: Double
  var hitchRatio: Double
  var frameP50: Double
  var frameP95: Double
  var frameP99: Double
  var frameMax: Double
  var device: String
  var os: String
  var at: Double
}

@MainActor @Observable
final class CardFlingBench {
  @ObservationIgnored weak var scrollView: UIScrollView?
  private(set) var running = false
  @ObservationIgnored private var runs = 0
  private(set) var summary = "500 cards. Fling at 6,000 pt/s for 10 s."
  @ObservationIgnored private var link: CADisplayLink?
  @ObservationIgnored private var started: CFTimeInterval = 0
  @ObservationIgnored private var last: CFTimeInterval?
  @ObservationIgnored private var direction: CGFloat = 1
  @ObservationIgnored private var intervals: [Double] = []
  @ObservationIgnored private var expected: Double = 1 / 60
  @ObservationIgnored private var hitches = 0
  @ObservationIgnored private var hitchMs: Double = 0
  static let speed: CGFloat = 6_000
  static let duration: CFTimeInterval = 10

  func start() {
    guard !running, scrollView != nil else {
      summary = "No list to fling."
      return
    }
    running = true
    intervals = []
    hitches = 0
    hitchMs = 0
    last = nil
    started = CACurrentMediaTime()
    summary = "Flinging…"
    let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  @objc private func tick(_ link: CADisplayLink) {
    guard let scroll = scrollView else { return finish() }
    expected = link.targetTimestamp - link.timestamp
    if let last {
      let interval = link.timestamp - last
      intervals.append(interval)
      if interval > expected * 1.5 {
        hitches += 1
        hitchMs += (interval - expected) * 1000
      }
    }
    let dt = last.map { link.timestamp - $0 } ?? expected
    last = link.timestamp
    let top = -scroll.adjustedContentInset.top
    let bottom = max(top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
    var y = scroll.contentOffset.y + direction * Self.speed * dt
    if y >= bottom { y = bottom; direction = -1 }
    if y <= top { y = top; direction = 1 }
    scroll.contentOffset.y = y
    if link.timestamp - started >= Self.duration { finish() }
  }

  private func finish() {
    link?.invalidate()
    link = nil
    running = false
    let sorted = intervals.sorted().map { $0 * 1000 }
    let pick = { (p: Double) -> Double in sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
    let seconds = intervals.reduce(0, +)
    var system = utsname()
    uname(&system)
    let device = withUnsafeBytes(of: &system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    let result = CardFlingResult(
      cards: CardFlingView.cards.count, frames: intervals.count, seconds: seconds, expectedFrameMs: expected * 1000,
      hitches: hitches, hitchMs: hitchMs, hitchRatio: seconds > 0 ? hitchMs / seconds : 0, frameP50: pick(0.5),
      frameP95: pick(0.95), frameP99: pick(0.99), frameMax: sorted.last ?? 0,
      device: ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? device,
      os: UIDevice.current.systemVersion, at: Date().timeIntervalSince1970)
    summary = String(format: "%d hitch%@ in %d frames · p99 %.1f ms · max %.1f ms", hitches, hitches == 1 ? "" : "es", intervals.count, result.frameP99, result.frameMax)
    let folder = URL.documentsDirectory.appending(path: "benchmarks")
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    runs += 1
    try? encoder.encode(result).write(to: folder.appending(path: runs == 1 ? "s19-cold.json" : "s19-warm.json"))
  }
}
#endif
