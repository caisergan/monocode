import Foundation
@testable import MonoTranscript
import MonoWire
import Testing

/// The desktop chat's markdown (AgentMarkdown.tsx and `.agent-markdown`),
/// at the phone's sizes (11 §11.16).
@Suite struct DesktopMarkdownTests {
  func rows(_ text: String) -> [RowSpec] { DesktopMarkdown.rows(text, idPrefix: "a") }
  func text(_ row: RowSpec) -> String { row.runs.map(\.text).joined() }

  @Test func softBreaksReadAsSpaces() {
    let r = rows("First line\nsecond line  \nthird\\\nfourth")
    #expect(r.count == 1)
    #expect(text(r[0]) == "First line second line\nthird\nfourth")
  }

  @Test func blocksAndListsAreSpacedLikeTheDesktop() {
    let r = rows("Intro paragraph.\n\n- one\n- two\n\nAfter the list.\n\n## Heading\n\nBody.")
    #expect(r.map(\.gap) == [12, 12, 8, 20, 24, 16])
    #expect(r.map { $0.marker ?? "" } == ["", "•", "•", "", "", ""])
  }

  @Test func listsNestByIndentAndOrderedListsRenumber() {
    let r = rows("1. first\n1. second\n   - nested\n     - deeper\n   - nested two\n1. third\n\n- [ ] todo\n- [x] done")
    #expect(r.map(\.marker) == ["1.", "2.", "•", "•", "•", "3.", "☐", "☑"])
    #expect(r.map(\.depth) == [0, 0, 1, 2, 1, 0, 0, 0])
    #expect(text(r[7]) == "done")
  }

  @Test func itemsContinueAcrossLinesAndParagraphs() {
    let r = rows("- **Bold label:** the item\n  goes on here.\n\n  A second paragraph of it.\n- next")
    #expect(r.count == 3)
    #expect(text(r[0]) == "Bold label: the item goes on here.")
    #expect(r[0].runs.first?.style == "strong")
    #expect(r[1].marker == "" && r[1].depth == 0)
    #expect(r[2].marker == "•")
  }

  @Test func tablesAreCardsOfCells() {
    let r = rows("| Name | Value |\n| --- | :---: |\n| `a` | 1 |\n| b \\| c |")
    #expect(r.count == 1)
    #expect(r[0].kind == "table")
    #expect(r[0].cells.count == 3)
    #expect(r[0].cells[0].map { $0.map(\.text).joined() } == ["Name", "Value"])
    #expect(r[0].cells[0][0].first?.style == "tableHeader")
    #expect(r[0].cells[1][0].first?.chip == 1)
    #expect(r[0].cells[2].map { $0.map(\.text).joined() } == ["b | c", ""])
  }

  @Test func rulesStrikethroughAndBareURLs() {
    let r = rows("Before\n\n---\n\n~~gone~~ and https://example.com/a, done.")
    #expect(r.map(\.kind) == ["markdown", "rule", "markdown"])
    #expect(r[1].gap == 24)
    #expect(r[2].runs.first == TextRun(text: "gone", style: "del"))
    #expect(r[2].runs.contains(TextRun(text: "https://example.com/a", style: "link", link: "https://example.com/a")))
    #expect(r[2].runs.last?.text == ", done.")
  }

  @Test func codeInsideAListItemIsIndentedWithIt() {
    let r = rows("- run this:\n\n  ```sh\n  npm test\n  ```\n- then this")
    #expect(r.map(\.kind) == ["markdown", "codeBlock", "markdown"])
    #expect(r[1].depth == 1)
    #expect(r[1].lines.first?.first?.text == "npm test")
    #expect(r[2].marker == "•")
  }

  @Test func theAppUsesTheDesktopFlavour() {
    var options = RowOptions()
    #expect(options.markdown == .desktop)
    options.markdown = .expo
    let blocks = [MonoWire.Block(id: "u", role: .user, text: "Hi"), MonoWire.Block(id: "a", role: .assistant, text: "| a | b |\n|---|---|\n| 1 | 2 |")]
    #expect(RowBuilder().rows(blocks, RowOptions()).contains { $0.kind == "table" })
    #expect(!RowBuilder().rows(blocks, options).contains { $0.kind == "table" })
  }
}
