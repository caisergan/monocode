import Foundation
import MonoWire
import Testing

/// Turn and step grouping against the desktop's own functions, run by
/// gen-fixtures.mjs over the demo sessions, a 60-turn fixture and edge cases.
@Suite struct GroupingTests {
  struct Case: @unchecked Sendable {
    let name: String
    let cwd: String?
    let blocks: [Block]
    let raw: [String: Any]
  }

  static let cases: [Case] = {
    guard let root = try? fixture("grouping") as? [String: Any], let list = root["cases"] as? [[String: Any]] else { return [] }
    return list.compactMap { raw in
      guard let name = raw["name"] as? String, let blocks = try? decode([Block].self, from: raw["blocks"]!) else { return nil }
      return Case(name: name, cwd: raw["cwd"] as? String, blocks: blocks, raw: raw)
    }
  }()

  @Test func everyCaseDecodes() {
    #expect(Self.cases.count == 19)
  }

  @Test(arguments: cases.map(\.name))
  func groupingMatchesTypeScript(_ name: String) throws {
    let item = try #require(Self.cases.first { $0.name == name })
    let raw = item.raw
    let turns = Transcript.groupTurns(item.blocks)
    #expect(turns.map { $0.map(\.id) } == raw["turns"].flatMap { ($0 as? [[String: Any]])?.map { $0["ids"] as! [String] } })
    #expect(Transcript.groupTurns(item.blocks, managed: true).map { $0.map(\.id) } == raw["managedTurns"] as? [[String]])

    let expectedTurns = try #require(raw["turns"] as? [[String: Any]])
    for (turn, expected) in zip(turns, expectedTurns) {
      let where_ = "\(name), turn \(turn.first?.id ?? "?")"
      #expect(Transcript.turnCopyText(turn) == expected["copyText"] as? String, "\(where_)")
      let rest = turn.first?.role == .user ? Array(turn.dropFirst()) : turn
      for settled in [true, false] {
        let facts = try #require(expected[settled ? "settled" : "live"] as? [String: Any])
        let items = Transcript.groupTurnItems(rest, settled: settled)
        let shapes = items.map { item -> [String: Any] in
          let type: String
          switch item {
          case .block: type = "block"
          case .activity: type = "activity"
          case .subagents: type = "subagents"
          }
          return ["type": type, "ids": item.blocks.map(\.id)]
        }
        let label = "\(where_), \(settled ? "settled" : "live")"
        #expect(jsonDifference(facts["items"]!, shapes) == nil, "\(label): \(jsonDifference(facts["items"]!, shapes) ?? "")")
        let fold = Transcript.foldableWork(items)
        let expectedFold = facts["fold"] as? [String: Int]
        #expect(fold.map { ["start": $0.start, "end": $0.end] } == expectedFold, "\(label)")
        #expect(fold.map { Transcript.workSummaryLine(Transcript.foldedBlocks(items, $0)) } == facts["foldSummary"] as? String, "\(label)")
        #expect(Transcript.firstFoldableIndex(items) == facts["firstFoldable"] as? Int, "\(label)")
        #expect(Transcript.initialThinkingIndex(items) == facts["initialThinking"] as? Int, "\(label)")
        let summaries = try #require(facts["summaries"] as? [Any])
        for (item, summary) in zip(items, summaries) {
          guard case let .activity(blocks) = item, let summary = summary as? [String: String] else { continue }
          #expect(Transcript.workSummaryLine(blocks) == summary["settled"], "\(label)")
          #expect(Transcript.workSummaryLine(blocks, live: true) == summary["live"], "\(label)")
        }
      }
    }

    let facts = try #require(raw["blockFacts"] as? [String: [String: Any]])
    for block in item.blocks {
      let expected = try #require(facts[block.id])
      let label = Transcript.toolCallLabel(block, cwd: item.cwd)
      let where_ = "\(name), \(block.id)"
      #expect(label == expected["label"] as? String, "\(where_)")
      #expect(Transcript.toolCallState(block).rawValue == expected["state"] as? String, "\(where_)")
      #expect(Transcript.needsApproval(block) == expected["needsApproval"] as? Bool, "\(where_)")
      #expect(Transcript.isNoticeBlock(block) == expected["notice"] as? Bool, "\(where_)")
      #expect(Transcript.isThinkingBlock(block) == expected["thinking"] as? Bool, "\(where_)")
      #expect(Transcript.isSubagentBlock(block) == expected["subagent"] as? Bool, "\(where_)")
      if let name = expected["subagentName"] as? String { #expect(Transcript.subagentName(block) == name, "\(where_)") }
      #expect(Transcript.proseSummary(block.text) == expected["proseSummary"] as? String, "\(where_)")
      let display = Transcript.resolveToolCallDisplay(label, preview: block.tool?.preview, cwd: item.cwd)
      var shape: [String: Any] = ["fileName": display.fileName, "isFile": display.isFile, "previewMatchesFile": display.previewMatchesFile]
      if let action = display.action { shape["action"] = action }
      if let target = display.target { shape["target"] = target }
      if let filePath = display.filePath { shape["filePath"] = filePath }
      let difference = jsonDifference(expected["display"]!, shape)
      #expect(difference == nil, "\(where_): \(difference ?? "")")
    }
  }

  @Test func summariesMatchTheHost() {
    #expect(Summary.plainTextPreview("## Title\n\nSome **bold** and `code` with [a link](http://x).") == "Title Some bold and code with a link.")
    #expect(Summary.plainTextPreview(String(repeating: "word ", count: 100), max: 12) == "word word w…")
  }
}
