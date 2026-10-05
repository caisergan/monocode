import UIKit
@testable import MonoTranscript
import Testing

@MainActor
private final class Recorder: TranscriptViewDelegate {
  var ready: CheckedContinuation<Int, Never>?

  func transcript(_ view: MonoTranscriptView, didBecomeReadyWith rows: Int) {
    ready?.resume(returning: rows)
    ready = nil
  }
}

@Suite @MainActor struct ViewTests {
  @Test func paintsRowsAndFollowsTheTail() async {
    let view = MonoTranscriptView(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
    let recorder = Recorder()
    view.delegate = recorder
    view.setTheme(##"{"background":"#171717","scale":1,"colors":{},"styles":{"prose":{"size":16,"line":25,"color":"rgba(235,235,235,0.78)"}}}"##)
    view.layoutIfNeeded()
    let rows = (0..<200).map { #"{"id":"r\#($0)","v":1,"k":"markdown","runs":[{"t":"Row \#($0) of the transcript.","s":"prose"}]}"# }
    let rowCount = await withCheckedContinuation { continuation in
      recorder.ready = continuation
      view.apply(#"[{"op":"reset","rows":[\#(rows.joined(separator: ","))]}]"#)
    }
    #expect(rowCount > 0)
    let scroll = view.contentScrollView
    #expect(scroll.contentSize.height > scroll.bounds.height)
    // Following the tail: the last row sits at the bottom edge.
    #expect(abs(scroll.contentOffset.y - (scroll.contentSize.height - scroll.bounds.height)) < 1)
  }
}
