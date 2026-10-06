import Foundation
@testable import MonoTranscript
import Testing

@Suite @MainActor struct FixtureTests {
  @Test func rowFixturesLayOut() async throws {
    let harness = EngineHarness()
    harness.engine.setTheme(try TranscriptFixture.themeDark.theme())
    harness.send([.reset(try TranscriptFixture.rows120.rows())])
    let snapshot = try #require(await harness.settle())
    #expect(snapshot.count == 855)
    #expect(snapshot.layouts.allSatisfy { $0.height > 0 || $0.kind == "spacer" })
  }

  @Test func streamRecordingRunsAt90CharsPerSecond() throws {
    let stream = try StreamRecording.load()
    #expect(stream.charsPerSecond == 90)
    #expect(stream.duration > 20_000)
    let last = try #require(stream.frames.last)
    #expect(abs(Double(last.chars) - last.t / 1000 * 90) <= 1)
    #expect(stream.anchor == "u999:footer")
  }

  /// Streaming equals final on the recorded run: replaying every frame on the
  /// 1,000-turn base ends at the layout of the final rows laid out at once.
  @Test func replayedStreamEqualsFinal() async throws {
    let theme = try TranscriptFixture.themeDark.theme()
    let stream = try StreamRecording.load()
    let streamed = EngineHarness()
    streamed.engine.setTheme(theme)
    let base = try TranscriptFixture.rows1000.rows()
    streamed.send([.reset(base)])
    for frame in stream.frames { streamed.send(frame.ops) }
    let replayed = try #require(await streamed.settle())

    let settled = EngineHarness()
    settled.engine.setTheme(theme)
    settled.send([.reset(base), .insert(after: stream.anchor, stream.finalRows)])
    let final = try #require(await settled.settle())

    #expect(replayed.ids == final.ids)
    #expect(replayed.layouts.map(\.height) == final.layouts.map(\.height))
    #expect(replayed.count > 7087)
  }
}
