import Foundation
import MonoWire

/// Which markdown rules the row builder follows.
public enum MarkdownFlavor: Sendable, Equatable {
  /// The desktop chat's (`AgentMarkdown.tsx`: Streamdown with GFM, and
  /// index.css's `.agent-markdown` spacing), at the phone's type sizes
  /// (11 §11.16). What the app shows.
  case desktop
  /// The Expo app's `markdown.ts`, kept so the builder's other rows can be
  /// checked against its TypeScript goldens.
  case expo
}

/// Markdown as the desktop renders an agent's reply (11 §11.16):
/// - blocks 16 pt apart, a list 8 pt below what introduces it, items 8 pt
///   apart (`li` `py-1`), headings 24 pt above (`mt-6`);
/// - soft line breaks inside a paragraph read as spaces; two trailing spaces
///   or a backslash break the line;
/// - lists nest by indentation and ordered lists renumber from their first
///   number; a blank line and an indented paragraph continue an item;
/// - GFM: tables as a card of cells, `~~strikethrough~~`, task list items,
///   bare URLs as links; a rule is a 1 pt line with 24 pt around it.
enum DesktopMarkdown {
  private static let fence = JSRegex("^(\\s*)(`{3,}|~{3,})\\s*([^\\s`]*)?.*$")
  private static let heading = JSRegex("^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$")
  private static let rule = JSRegex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
  private static let list = JSRegex("^(\\s*)([-*+]|\\d{1,9}[.)])\\s+(.*)$")
  private static let quote = JSRegex("^\\s{0,3}>\\s?(.*)$")
  private static let tableSeparator = JSRegex("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$")
  private static let task = JSRegex("^\\[([ xX])\\]\\s+(.*)$", "s")
  private static let lineBreaks = JSRegex("\\r\\n?", "g")
  private static let digits = JSRegex("^\\d+")

  enum Block {
    case paragraph(String)
    case heading(level: Int, text: String)
    /// `marker` "" is a later paragraph of the item above.
    case item(marker: String, depth: Int, text: String)
    case code(lang: String, lines: [String], closed: Bool, depth: Int)
    case quote(String)
    case rule
    case table([[String]])
  }

  private static func indentWidth(_ text: String) -> Int {
    var width = 0
    for char in text {
      if char == " " { width += 1 } else if char == "\t" { width += 4 } else { break }
    }
    return width
  }

  /// Paragraph lines joined as CommonMark does: a soft break is a space,
  /// a hard break (two trailing spaces, or a backslash) a newline.
  static func join(_ lines: [String]) -> String {
    var out = ""
    for (index, raw) in lines.enumerated() {
      var line = index == 0 ? raw : String(raw.drop { $0 == " " || $0 == "\t" })
      var hard = false
      if line.hasSuffix("\\") && index < lines.count - 1 {
        line.removeLast()
        hard = true
      } else if line.hasSuffix("  ") {
        hard = index < lines.count - 1
      }
      while line.hasSuffix(" ") { line.removeLast() }
      out += line
      if index < lines.count - 1 { out += hard ? "\n" : " " }
    }
    return out
  }

  private static func cells(_ row: String) -> [String] {
    var text = row.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("|") { text.removeFirst() }
    if text.hasSuffix("|") && !text.hasSuffix("\\|") { text.removeLast() }
    var cells: [String] = []
    var cell = ""
    var escaped = false
    var code = false
    for char in text {
      if escaped {
        cell.append(char)
        escaped = false
      } else if char == "\\" {
        escaped = true
        cell.append(char)
      } else if char == "`" {
        code.toggle()
        cell.append(char)
      } else if char == "|" && !code {
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        cell = ""
      } else {
        cell.append(char)
      }
    }
    cells.append(cell.trimmingCharacters(in: .whitespaces))
    return cells.map { $0.replacingOccurrences(of: "\\|", with: "|") }
  }

  static func split(_ source: String) -> [Block] {
    let lines = lineBreaks.replace(source, "\n").jsSplit("\n")
    var blocks: [Block] = []
    var paragraph: [String] = []
    /// Open lists: each level's marker indent, content indent, and the
    /// number its next ordered item shows (nil for bullets).
    var levels: [(indent: Int, content: Int, next: Int?)] = []
    /// The open item's lines, and whether a blank line followed it.
    var item: (marker: String, depth: Int, lines: [String])?
    var blankAfterItem = false

    func flushParagraph() {
      if !paragraph.isEmpty { blocks.append(.paragraph(join(paragraph))) }
      paragraph = []
    }
    func flushItem() {
      if let open = item { blocks.append(.item(marker: open.marker, depth: open.depth, text: join(open.lines))) }
      item = nil
    }
    func closeLists() {
      flushItem()
      levels = []
      blankAfterItem = false
    }

    var i = 0
    while i < lines.count {
      let line = lines[i]
      let indent = indentWidth(line)
      let inList = !levels.isEmpty
      let contentIndent = levels.last?.content ?? 0

      if line.jsTrim.isEmpty {
        flushParagraph()
        if item != nil || inList { blankAfterItem = true }
        flushItem()
        i += 1
        continue
      }

      // Fences: up to three spaces of indent, or inside an item its content indent.
      if let m = fence.match(line), let marker = m[2], let lead = m[1], indentWidth(lead) <= 3 || inList {
        flushParagraph()
        // Indented under an open item, the code belongs to it.
        let nested = inList && indentWidth(lead) >= min(contentIndent, 2)
        if nested { flushItem() } else { closeLists() }
        let strip = indentWidth(lead)
        let close = String(repeating: marker.jsSlice(0, 1), count: marker.jsLength)
        var code: [String] = []
        var closed = false
        i += 1
        while i < lines.count {
          let trimmed = lines[i].jsTrim
          if trimmed.hasPrefix(close) && trimmed.jsSlice(marker.jsLength).jsTrim.isEmpty {
            closed = true
            break
          }
          var body = lines[i]
          var removed = 0
          while removed < strip, let first = body.first, first == " " {
            body.removeFirst()
            removed += 1
          }
          code.append(body)
          i += 1
        }
        blocks.append(.code(lang: m[3] ?? "", lines: code, closed: closed, depth: nested ? max(0, levels.count) : 0))
        blankAfterItem = false
        i += 1
        continue
      }

      if let m = list.match(line), let bullet = m[2] {
        flushParagraph()
        flushItem()
        let ordered = digits.test(bullet)
        // Pop levels deeper than this item; nest under a shallower one.
        while let last = levels.last, last.indent > indent { levels.removeLast() }
        if let last = levels.last, last.indent == indent {
          if (last.next != nil) != ordered {
            levels[levels.count - 1] = (indent, indent + bullet.jsLength + 1, ordered ? Int(digits.match(bullet)?[0] ?? "1") ?? 1 : nil)
          }
        } else if let last = levels.last, indent < last.content, indent > last.indent {
          // An item between two levels belongs to the shallower one.
          levels[levels.count - 1].indent = indent
        } else {
          levels.append((indent, indent + bullet.jsLength + 1, ordered ? Int(digits.match(bullet)?[0] ?? "1") ?? 1 : nil))
        }
        var marker = "•"
        if let number = levels[levels.count - 1].next {
          marker = "\(number)."
          levels[levels.count - 1].next = number + 1
        }
        var text = m[3] ?? ""
        if let t = task.match(text), let state = t[1] {
          marker = state == " " ? "☐" : "☑"
          text = t[2] ?? ""
        }
        item = (marker, levels.count - 1, [text])
        blankAfterItem = false
        i += 1
        continue
      }

      if inList {
        if indent >= 2 && indent >= min(contentIndent, 2) && !blankAfterItem, item != nil {
          // A lazy or indented continuation of the open item.
          item?.lines.append(line)
          i += 1
          continue
        }
        if blankAfterItem && indent >= min(contentIndent, 2) && indent > 0 {
          // A later paragraph of the item above.
          flushItem()
          var text = [line]
          while i + 1 < lines.count && !lines[i + 1].jsTrim.isEmpty && !list.test(lines[i + 1]) && fence.match(lines[i + 1]) == nil {
            i += 1
            text.append(lines[i])
          }
          item = ("", max(0, levels.count - 1), text)
          flushItem()
          blankAfterItem = false
          i += 1
          continue
        }
        if !blankAfterItem, item != nil, heading.match(line) == nil, quote.match(line) == nil, !rule.test(line) {
          // Lazy continuation: an unindented line straight after an item.
          item?.lines.append(line)
          i += 1
          continue
        }
        closeLists()
      }

      if let m = heading.match(line), let hashes = m[1] {
        flushParagraph()
        blocks.append(.heading(level: hashes.jsLength, text: m[2] ?? ""))
        i += 1
        continue
      }
      if rule.test(line) {
        flushParagraph()
        blocks.append(.rule)
        i += 1
        continue
      }
      if let m = quote.match(line) {
        flushParagraph()
        var text = [m[1] ?? ""]
        while i + 1 < lines.count, let next = quote.match(lines[i + 1]) {
          i += 1
          text.append(next[1] ?? "")
        }
        blocks.append(.quote(join(text)))
        i += 1
        continue
      }
      if line.contains("|") && i + 1 < lines.count && tableSeparator.test(lines[i + 1]) && lines[i + 1].contains("-") {
        flushParagraph()
        var rows = [cells(line)]
        i += 2
        while i < lines.count && lines[i].contains("|") && !lines[i].jsTrim.isEmpty {
          rows.append(cells(lines[i]))
          i += 1
        }
        let width = rows[0].count
        blocks.append(.table(rows.map { row in Array((row + Array(repeating: "", count: max(0, width - row.count))).prefix(width)) }))
        continue
      }
      paragraph.append(line)
      i += 1
    }
    flushParagraph()
    flushItem()
    return blocks
  }

  private static let headingStyles = ["h1", "h2", "h3", "h4", "h4", "h4"]

  /// Rows for one markdown body, with the desktop's spacing.
  static func rows(_ source: String, idPrefix: String, base: String = "prose", firstGap: Double = 12) -> [RowSpec] {
    var out: [RowSpec] = []
    var previous: Block?
    for (index, block) in split(source).enumerated() {
      let id = "\(idPrefix)#\(index)"
      let afterItem: Bool
      if case .item? = previous { afterItem = true } else { afterItem = false }
      func gap(_ normal: Double) -> Double { index == 0 ? firstGap : afterItem ? normal + 4 : normal }
      switch block {
      case let .paragraph(text):
        var row = RowSpec(id: id, version: Markdown.hash(text, seed: Markdown.hash(base + "d")), kind: "markdown")
        row.runs = Markdown.inlineRuns(text, base: base, gfm: true)
        row.gap = gap(16)
        out.append(row)
      case let .heading(level, text):
        var row = RowSpec(id: id, version: Markdown.hash(text, seed: level + 100), kind: "markdown")
        row.runs = Markdown.inlineRuns(text, base: headingStyles[level - 1], gfm: true)
        row.gap = index == 0 ? firstGap : afterItem ? 28 : 24
        out.append(row)
      case let .item(marker, depth, text):
        var row = RowSpec(id: id, version: Markdown.hash(text + marker, seed: depth + 100), kind: "markdown")
        row.marker = marker
        row.depth = depth
        row.runs = Markdown.inlineRuns(text, base: base, gfm: true)
        row.gap = index == 0 ? firstGap : afterItem ? 8 : 12
        out.append(row)
      case let .quote(text):
        var row = RowSpec(id: id, version: Markdown.hash(text, seed: 107), kind: "markdown")
        row.quote = true
        row.runs = Markdown.inlineRuns(text, base: "quote", gfm: true)
        row.gap = gap(16)
        out.append(row)
      case .rule:
        var row = RowSpec(id: id, version: 2, kind: "rule")
        row.gap = index == 0 ? firstGap : afterItem ? 28 : 24
        out.append(row)
      case let .table(rows):
        var row = RowSpec(id: id, version: Markdown.hash(rows.map { $0.joined(separator: "\u{1}") }.joined(separator: "\u{2}"), seed: 11), kind: "table")
        row.cells = rows.enumerated().map { r, cells in
          cells.map { Markdown.inlineRuns($0, base: r == 0 ? "tableHeader" : "tableCell", gfm: true) }
        }
        row.gap = gap(16)
        out.append(row)
      case let .code(lang, lines, closed, depth):
        var chunks = Markdown.codeRows(id, label: lang.isEmpty ? "text" : lang, lines: lines, gap: gap(16), closed: closed)
        for c in chunks.indices { chunks[c].depth = depth }
        out.append(contentsOf: chunks)
      }
      previous = block
    }
    return out
  }
}
