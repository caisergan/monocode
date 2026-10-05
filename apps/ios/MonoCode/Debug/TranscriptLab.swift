#if DEBUG
import MonoTranscript
import Observation
import QuartzCore
import UIKit

/// A scenario the Lab runs unattended (`monocode-dev://lab?run=huge-stream`),
/// as the Expo Lab did: load, stream from 2 s, fling from 3.5 s for 10 s.
enum LabRun: String, Hashable {
  case big
  case huge
  case hugeStream = "huge-stream"
}

/// The transcript Lab (15 §15.6): the fixtures, the recorded stream replayed
/// at 90 chars/s, and the fling benchmark.
@Observable
final class TranscriptLab: TranscriptViewDelegate {
  @ObservationIgnored let transcript = MonoTranscriptView()
  private(set) var scenario = "Load a fixture."
  private(set) var streamStatus = ""
  private(set) var streaming = false
  private(set) var benchmarking = false
  private(set) var result: BenchmarkResult?

  @ObservationIgnored private var base: TranscriptFixture?
  @ObservationIgnored private var recording: StreamRecording?
  @ObservationIgnored private var link: CADisplayLink?
  @ObservationIgnored private var streamStart: CFTimeInterval = 0
  @ObservationIgnored private var cursor = 0
  @ObservationIgnored private var applyMs: [Double] = []

  init() {
    transcript.delegate = self
    if let theme = try? TranscriptFixture.themeDark.text() {
      transcript.setTheme(theme)
    }
  }

  func load(_ fixture: TranscriptFixture) async {
    stopStream()
    let started = CACurrentMediaTime()
    guard let ops = await Task.detached(operation: { try? fixture.resetOps() }).value else {
      scenario = "Couldn't read \(fixture.rawValue).json"
      return
    }
    transcript.apply(ops)
    base = fixture
    result = nil
    streamStatus = ""
    let turns = fixture == .rows120 ? "120" : "1,000"
    scenario = "\(turns) turns · read \(Self.format((CACurrentMediaTime() - started) * 1000, 0)) ms"
  }

  /// Replays the recorded stream on the 1,000-turn fixture it was recorded on.
  func startStream() async {
    if base != .rows1000 { await load(.rows1000) }
    if recording == nil {
      recording = await Task.detached(operation: { try? StreamRecording.load() }).value
    }
    guard recording != nil else {
      streamStatus = "Couldn't read stream.json"
      return
    }
    // Played once per base: the recording inserts its rows after the base.
    base = nil
    cursor = 0
    applyMs = []
    streaming = true
    streamStart = CACurrentMediaTime()
    let link = CADisplayLink(target: DisplayLinkTarget { [weak self] link in self?.tick(link) },
                             selector: #selector(DisplayLinkTarget.step(_:)))
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  func stopStream() {
    link?.invalidate()
    link = nil
    streaming = false
  }

  func fling() {
    benchmarking = true
    transcript.runBenchmark(durationMs: 10_000, speed: 6_000)
  }

  func run(_ run: LabRun) async {
    await load(run == .big ? .rows120 : .rows1000)
    try? await Task.sleep(for: .seconds(2))
    if run == .hugeStream { await startStream() }
    try? await Task.sleep(for: .seconds(1.5))
    fling()
    try? await Task.sleep(for: .seconds(10.5))
    stopStream()
  }

  /// Applies every recorded frame that is due, as one batch per display frame.
  private func tick(_ link: CADisplayLink) {
    guard let recording else { return }
    let elapsed = (link.timestamp - streamStart) * 1000
    var batch: [Substring] = []
    var chars = 0
    while cursor < recording.frames.count, recording.frames[cursor].t <= elapsed {
      let frame = recording.frames[cursor]
      let ops = frame.ops.dropFirst().dropLast()
      if !ops.isEmpty { batch.append(ops) }
      chars = frame.chars
      cursor += 1
    }
    if !batch.isEmpty {
      let started = CACurrentMediaTime()
      transcript.apply("[" + batch.joined(separator: ",") + "]")
      applyMs.append((CACurrentMediaTime() - started) * 1000)
      if applyMs.count % 30 == 1 {
        streamStatus = "Streaming \(chars) chars · main per frame p95 \(Self.format(Self.percentile(applyMs, 0.95), 3)) ms"
      }
    }
    if cursor >= recording.frames.count {
      stopStream()
      streamStatus = "Stream finished · main per frame p95 \(Self.format(Self.percentile(applyMs, 0.95), 3)) ms"
    }
  }

  var summary: String {
    var lines = [scenario]
    if !streamStatus.isEmpty { lines.append(streamStatus) }
    if benchmarking { lines.append("Flinging for 10 s…") }
    if let r = result {
      let f = { (value: Double, digits: Int) in Self.format(value, digits) }
      lines.append("hitch \(f(r.hitchRatio, 2)) ms/s (\(r.hitches) in \(r.frames) frames @\(f(r.expectedFrameMs, 1)) ms)")
      lines.append("frame p50 \(f(r.frameP50, 1)) p95 \(f(r.frameP95, 1)) p99 \(f(r.frameP99, 1)) max \(f(r.frameMax, 1)) ms")
      lines.append("rows \(r.rows) · cold first \(f(r.coldFirstMs, 0)) all \(f(r.coldTotalMs, 0)) ms · sync draws \(r.syncDraws)")
      lines.append("tail relayout p95 \(f(r.tailUpdateP95, 3)) ms (\(r.tailUpdates)) · raster p95 \(f(r.rasterP95, 2)) ms")
    }
    return lines.joined(separator: "\n")
  }

  // MARK: TranscriptViewDelegate

  func transcript(_ view: MonoTranscriptView, didFinishBenchmark result: BenchmarkResult) {
    benchmarking = false
    self.result = result
  }

  private static func percentile(_ values: [Double], _ p: Double) -> Double {
    let sorted = values.sorted()
    return sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))]
  }

  private static func format(_ value: Double, _ digits: Int) -> String {
    value.formatted(.number.precision(.fractionLength(digits)))
  }
}

/// CADisplayLink retains its target; this breaks the cycle with the Lab.
private final class DisplayLinkTarget: NSObject {
  let onFrame: (CADisplayLink) -> Void

  init(_ onFrame: @escaping (CADisplayLink) -> Void) {
    self.onFrame = onFrame
  }

  @objc func step(_ link: CADisplayLink) {
    onFrame(link)
  }
}
#endif
