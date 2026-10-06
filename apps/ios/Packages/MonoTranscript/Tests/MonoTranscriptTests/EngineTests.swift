import CoreGraphics
import Foundation
@testable import MonoTranscript
import Testing

/// Feeds ops to an engine and waits for the snapshots it publishes.
@MainActor
final class EngineHarness {
  let engine = TranscriptEngine()
  private var latest: Snapshot?
  private var waiting: [(Int, CheckedContinuation<Snapshot, Never>)] = []

  init(width: CGFloat = 390) {
    engine.publish = { [weak self] snapshot in self?.received(snapshot) }
    engine.setWidth(width)
  }

  private func received(_ snapshot: Snapshot) {
    latest = snapshot
    waiting.removeAll { rows, continuation in
      guard snapshot.count == rows else { return false }
      continuation.resume(returning: snapshot)
      return true
    }
  }

  /// Sends ops without waiting.
  func send(_ ops: [TranscriptOp]) {
    engine.apply(ops)
  }

  /// The snapshot after every op sent so far: the stats callback is queued
  /// behind the last publish.
  func settle() async -> Snapshot? {
    await withCheckedContinuation { continuation in
      engine.statsSnapshot { _ in continuation.resume() }
    }
    return latest
  }

  /// Applies `ops` and returns the next snapshot with `rows` rows.
  /// `ops` in the JSON shape, decoded as the fixtures are.
  func apply(_ ops: [[String: Any]], expecting rows: Int) async -> Snapshot {
    let data = try! JSONSerialization.data(withJSONObject: ops)
    let typed = try! JSONDecoder().decode([TranscriptOp].self, from: data)
    return await withCheckedContinuation { continuation in
      waiting.append((rows, continuation))
      engine.apply(typed)
    }
  }
}

private func markdown(_ id: String, _ text: String, version: Int = 1) -> [String: Any] {
  ["id": id, "v": version, "k": "markdown", "runs": [["t": text, "s": "prose"]]]
}

private let paragraph = "The session host keeps the channel open while the phone measures each row with CoreText at the viewport width, then paints the same objects it measured with."

@Suite @MainActor struct EngineTests {
  @Test func decodesTheSpecShape() throws {
    let json = #"{"id":"a1","v":3,"k":"codeBlock","label":"ts","first":true,"last":false,"lines":[[{"t":"const a = 1","s":"code"}]],"actions":[{"id":"copy","label":"Copy"}],"anim":{"pulse":true},"gap":12}"#
    let spec = try JSONDecoder().decode(RowSpec.self, from: Data(json.utf8))
    #expect(spec.id == "a1")
    #expect(spec.version == 3)
    #expect(spec.kind == "codeBlock")
    #expect(spec.first && !spec.last)
    #expect(spec.lines.first?.first?.text == "const a = 1")
    #expect(spec.actions.first?.variant == "secondary")
    #expect(spec.pulse)
    #expect(spec.gap == 12)
    #expect(try JSONDecoder().decode(RowSpec.self, from: JSONEncoder().encode(spec)) == spec)
    #expect(throws: (any Error).self) { try JSONDecoder().decode(RowSpec.self, from: Data(#"{"k":"markdown"}"#.utf8)) }
  }

  @Test func laysOutRowsWithExactPrefixSums() async {
    let harness = EngineHarness()
    let rows: [[String: Any]] = [
      ["id": "u0", "v": 1, "k": "userBubble", "runs": [["t": "Fix the tests", "s": "user"]]],
      markdown("a0", paragraph),
      ["id": "f0", "v": 1, "k": "foldLine", "runs": [["t": "Worked for 2m", "s": "fold"]]],
      ["id": "s0", "v": 1, "k": "spacer", "h": 40],
    ]
    let snapshot = await harness.apply([["op": "reset", "rows": rows]], expecting: 4)
    #expect(snapshot.ids == ["u0", "a0", "f0", "s0"])
    #expect(snapshot.layouts.allSatisfy { $0.height > 0 })
    #expect(snapshot.layouts[3].height == 40)
    #expect(snapshot.layouts[2].height == 34)
    for i in 0..<snapshot.count {
      #expect(snapshot.offsets[i + 1] == snapshot.offsets[i] + snapshot.layouts[i].height)
    }
    #expect(snapshot.row(at: snapshot.offsets[2] + 1) == 2)
  }

  @Test func anUpdateRemeasuresOnlyItsRow() async {
    let harness = EngineHarness()
    let before = await harness.apply([["op": "reset", "rows": [markdown("a", "One"), markdown("b", "Two")]]], expecting: 2)
    let after = await harness.apply([["op": "update", "rows": [markdown("b", paragraph, version: 2)]]], expecting: 2)
    #expect(after.layouts[0] === before.layouts[0])
    #expect(after.layouts[1] !== before.layouts[1])
    #expect(after.layouts[1].height > before.layouts[1].height)
  }

  @Test func insertsAppendsAndRemoves() async {
    let harness = EngineHarness()
    _ = await harness.apply([["op": "reset", "rows": [markdown("a", "A"), markdown("d", "D")]]], expecting: 2)
    _ = await harness.apply([["op": "insert", "after": "a", "rows": [markdown("b", "B"), markdown("c", "C")]]], expecting: 4)
    _ = await harness.apply([["op": "insert", "after": NSNull(), "rows": [markdown("top", "Top")]]], expecting: 5)
    _ = await harness.apply([["op": "append", "rows": [markdown("e", "E")]]], expecting: 6)
    let snapshot = await harness.apply([["op": "remove", "ids": ["c", "top"]]], expecting: 4)
    #expect(snapshot.ids == ["a", "b", "d", "e"])
    #expect(snapshot.index["d"] == 2)
  }

  /// 15 §15.4: streaming a reply token by token ends at the same layout as
  /// laying out the finished text at once.
  @Test func streamingEqualsFinal() async {
    let text = Array(repeating: paragraph, count: 4).joined(separator: " ")
    let streamed = EngineHarness()
    _ = await streamed.apply([["op": "reset", "rows": [markdown("u", "Question")]]], expecting: 1)
    _ = await streamed.apply([["op": "append", "rows": [markdown("a", "", version: 0)]]], expecting: 2)
    var version = 0
    var end = text.startIndex
    var last: Snapshot?
    while end < text.endIndex {
      end = text.index(end, offsetBy: 7, limitedBy: text.endIndex) ?? text.endIndex
      version += 1
      last = await streamed.apply([["op": "update", "rows": [markdown("a", String(text[..<end]), version: version)]]], expecting: 2)
    }
    let settled = EngineHarness()
    let final = await settled.apply([["op": "reset", "rows": [markdown("u", "Question"), markdown("a", text, version: version)]]], expecting: 2)
    #expect(last?.layouts.map(\.height) == final.layouts.map(\.height))
    #expect(last?.total == final.total)
  }
}

/// R0's known bug: inline code chips wrapped across lines.
@Suite @MainActor struct ChipTests {
  @Test func aChipNeverSplitsAcrossLines() async {
    let harness = EngineHarness(width: 260)
    var row = RowSpec(id: "a", version: 1, kind: "markdown")
    row.runs = [
      TextRun(text: "The failure comes from the session store in ", style: "prose"),
      TextRun(text: "packages/channel/src/noise.ts", style: "inlineCode", chip: 2),
      TextRun(text: " and the token write.", style: "prose"),
    ]
    let snapshot = await harness.apply([["op": "reset", "rows": [try! JSONSerialization.jsonObject(with: JSONEncoder().encode(row))]]], expecting: 1)
    let chips = snapshot.layouts[0].elements.compactMap { element -> [CGRect]? in
      if case let .text(block, _) = element { return block.chips.map(\.0) }
      return nil
    }.flatMap { $0 }
    #expect(chips.count == 1, "the chip split into \(chips.count) pieces")
    #expect(RowLayouter.unbreakable("a b") == "\u{202F}a\u{2060}\u{00A0}\u{2060}b\u{202F}")
  }
}
