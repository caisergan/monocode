import Foundation
import MonoWire

// Markdown to transcript rows (apps/mobile/src/transcript/markdown.ts). One
// top-level block is one row (a list item is one row; a code block is cut
// into chunks), so streaming re-parses only the trailing block. Raw HTML
// stays literal text; javascript:, data: and file: links are inert. Strings
// are walked in UTF-16 units and matched with JavaScript-compatible regular
// expressions, so the rows equal the TypeScript's.

enum Markdown {
  static let codeChunkLines = 40
  private static let fence = JSRegex("^\\s{0,3}(`{3,}|~{3,})\\s*([^\\s`]*)?.*$")
  private static let heading = JSRegex("^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$")
  private static let rule = JSRegex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
  private static let list = JSRegex("^(\\s*)([-*+]|\\d{1,9}[.)])\\s+(.*)$")
  private static let quote = JSRegex("^\\s{0,3}>\\s?(.*)$")
  private static let tableSeparator = JSRegex("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$")
  private static let extensionless = JSRegex("(^|/)(Makefile|Dockerfile|LICENSE|README|Gemfile|Procfile|Rakefile|Justfile|Brewfile)$")
  private static let location = JSRegex("(:\\d+(:\\d+)?|#L\\d+(-L?\\d+)?)$")
  private static let fileExtension = JSRegex("\\.[A-Za-z0-9]{1,12}$")
  private static let whitespace = JSRegex("\\s")
  private static let lineBreaks = JSRegex("\\r\\n?", "g")
  private static let continuation = JSRegex("^\\s{2,}\\S")
  private static let digit = JSRegex("\\d")
  private static let tabs = JSRegex("\\t", "g")

  enum Block {
    case paragraph(String)
    case heading(level: Int, text: String)
    case item(marker: String, depth: Int, text: String)
    case code(lang: String, lines: [String], closed: Bool)
    case quote(String)
    case rule
    case table([String])
  }

  /// The desktop's `inlineFileName` rule: inline code that names a file.
  static func isFileName(_ text: String) -> Bool {
    if text.isEmpty || text.jsLength > 240 || whitespace.test(text) { return false }
    let path = location.replace(text, "")
    return fileExtension.test(path) || extensionless.test(path)
  }

  static func split(_ source: String) -> [Block] {
    let lines = lineBreaks.replace(source, "\n").jsSplit("\n")
    var blocks: [Block] = []
    var paragraph: [String] = []
    func flush() {
      if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
      paragraph = []
    }
    var i = 0
    while i < lines.count {
      let line = lines[i]
      if let m = fence.match(line), let marker = m[1] {
        flush()
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
          code.append(lines[i])
          i += 1
        }
        blocks.append(.code(lang: m[2] ?? "", lines: code, closed: closed))
        i += 1
        continue
      }
      if line.jsTrim.isEmpty {
        flush()
        i += 1
        continue
      }
      if let m = heading.match(line), let hashes = m[1] {
        flush()
        blocks.append(.heading(level: hashes.jsLength, text: m[2] ?? ""))
        i += 1
        continue
      }
      if rule.test(line) {
        flush()
        blocks.append(.rule)
        i += 1
        continue
      }
      if let m = list.match(line), let indent = m[1], let bullet = m[2] {
        flush()
        let depth = min(4, tabs.replace(indent, "  ").jsLength / 2)
        let marker = digit.test(bullet) ? bullet.replacingOccurrences(of: ")", with: ".") : "•"
        var text = [m[3] ?? ""]
        while i + 1 < lines.count && continuation.test(lines[i + 1]) && !list.test(lines[i + 1]) {
          i += 1
          text.append(lines[i].jsTrim)
        }
        blocks.append(.item(marker: marker, depth: depth, text: text.joined(separator: "\n")))
        i += 1
        continue
      }
      if let m = quote.match(line) {
        flush()
        var text = [m[1] ?? ""]
        while i + 1 < lines.count, let next = quote.match(lines[i + 1]) {
          i += 1
          text.append(next[1] ?? "")
        }
        blocks.append(.quote(text.joined(separator: "\n")))
        i += 1
        continue
      }
      if line.contains("|") && i + 1 < lines.count && tableSeparator.test(lines[i + 1]) && lines[i + 1].contains("-") {
        flush()
        var rows = [line]
        i += 2
        while i < lines.count && lines[i].contains("|") && !lines[i].jsTrim.isEmpty {
          rows.append(lines[i])
          i += 1
        }
        blocks.append(.table(rows))
        continue
      }
      paragraph.append(line)
      i += 1
    }
    flush()
    return blocks
  }

  private static let safeLink = JSRegex("^(https?:|mailto:|#|/|\\.{0,2}/)", "i")
  private static let escapable = JSRegex("[\\\\`*_\\[\\]()#+\\-.!|>]")
  private static let ticks = JSRegex("^`+")
  private static let nonSpace = JSRegex("\\S")
  private static let word = JSRegex("\\w")
  private static let linkPattern = JSRegex("^\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)")
  private static let imagePattern = JSRegex("^!\\[([^\\]]*)\\]\\(([^)]+)\\)")

  /// Inline markdown: `code`, **strong**, *em*, [links](url).
  static func inlineRuns(_ text: String, base: String = "prose") -> [TextRun] {
    var runs: [TextRun] = []
    // UTF-16 units, so a surrogate pair collected one unit at a time decodes
    // whole.
    var plain: [UInt16] = []
    var strong = false
    var em = false
    func style() -> String { strong ? "strong" : em ? "em" : base }
    func push() {
      if !plain.isEmpty { runs.append(TextRun(text: String(decoding: plain, as: UTF16.self), style: style())) }
      plain = []
    }
    let units = Array(text.utf16)
    let length = units.count
    var i = 0
    while i < length {
      let char = text.jsChar(i)
      let next = text.jsChar(i + 1)
      if char == "\\" && i + 1 < length && escapable.test(next) {
        plain.append(units[i + 1])
        i += 2
        continue
      }
      if char == "`" {
        let run = ticks.match(text.jsSlice(i))?[0] ?? "`"
        let end = text.jsIndexOf(run, i + run.jsLength)
        if end > i {
          push()
          let code = text.jsSlice(i + run.jsLength, end).jsTrim
          runs.append(TextRun(text: code, style: "inlineCode", chip: isFileName(code) ? 2 : 1))
          i = end + run.jsLength
          continue
        }
      }
      if (char == "*" || char == "_") && next == char {
        push()
        strong.toggle()
        i += 2
        continue
      }
      if (char == "*" || char == "_") && (em || nonSpace.test(next)) {
        // Underscores inside words (snake_case) are text.
        if char == "_" && word.test(text.jsChar(i - 1)) && word.test(next) {
          plain.append(units[i])
          i += 1
          continue
        }
        push()
        em.toggle()
        i += 1
        continue
      }
      if char == "[", let link = linkPattern.match(text.jsSlice(i)), let whole = link[0], let label = link[1], let href = link[2] {
        push()
        runs.append(safeLink.test(href) ? TextRun(text: label, style: "link", link: href) : TextRun(text: label, style: style()))
        i += whole.jsLength
        continue
      }
      if char == "!" && next == "[", let image = imagePattern.match(text.jsSlice(i)), let whole = image[0] {
        // Remote images are not loaded (as on the desktop); show the alt text.
        push()
        if let alt = image[1], !alt.isEmpty { runs.append(TextRun(text: alt, style: "meta")) }
        i += whole.jsLength
        continue
      }
      plain.append(units[i])
      i += 1
    }
    push()
    return runs.isEmpty ? [TextRun(text: "", style: base)] : runs
  }

  /// The TypeScript's fast stable hash for row versions: djb2 over UTF-16
  /// units in 32-bit arithmetic, returned unsigned.
  static func hash(_ text: String, seed: Int = 5381) -> Int {
    var h = Int32(truncatingIfNeeded: seed)
    for unit in text.utf16 { h = (h &<< 5) &+ h &+ Int32(unit) }
    return Int(UInt32(bitPattern: h))
  }

  private static let headingStyles = ["h1", "h2", "h3", "h4", "h4", "h4"]

  private static func rows(_ block: Block, id: String, base: String, gap: Double) -> [RowSpec] {
    switch block {
    case let .paragraph(text):
      var row = RowSpec(id: id, version: hash(text, seed: hash(base)), kind: "markdown")
      row.runs = inlineRuns(text, base: base)
      row.gap = gap
      return [row]
    case let .heading(level, text):
      var row = RowSpec(id: id, version: hash(text, seed: level), kind: "markdown")
      row.runs = inlineRuns(text, base: headingStyles[level - 1])
      row.gap = gap + 4
      return [row]
    case let .item(marker, depth, text):
      var row = RowSpec(id: id, version: hash(text + marker, seed: depth), kind: "markdown")
      row.marker = marker
      row.depth = depth
      row.runs = inlineRuns(text, base: base)
      row.gap = min(gap, 4)
      return [row]
    case let .quote(text):
      var row = RowSpec(id: id, version: hash(text, seed: 7), kind: "markdown")
      row.quote = true
      row.runs = inlineRuns(text, base: "em")
      row.gap = gap
      return [row]
    case .rule:
      var row = RowSpec(id: id, version: 1, kind: "spacer")
      row.height = 24 + gap
      return [row]
    case let .table(rows):
      return codeRows(id, label: "table", lines: rows.enumerated().filter { $0.offset != 1 }.map(\.element), gap: gap, closed: true)
    case let .code(lang, lines, closed):
      return codeRows(id, label: lang.isEmpty ? "text" : lang, lines: lines, gap: gap, closed: closed)
    }
  }

  static func codeRows(_ id: String, label: String, lines: [String], gap: Double, closed: Bool) -> [RowSpec] {
    var rows: [RowSpec] = []
    let chunks = max(1, (lines.count + codeChunkLines - 1) / codeChunkLines)
    for c in 0..<chunks {
      let slice = Array(lines[min(lines.count, c * codeChunkLines)..<min(lines.count, (c + 1) * codeChunkLines)])
      let last = c == chunks - 1
      var row = RowSpec(
        id: "\(id).c\(c)",
        version: hash(slice.joined(separator: "\n"), seed: hash(label, seed: (c == 0 ? 1 : 0) + (last && closed ? 2 : 0) + (last ? 4 : 0))),
        kind: "codeBlock")
      row.label = label
      row.first = c == 0
      row.last = last
      row.lines = slice.map { [TextRun(text: tabs.replace($0, "  "), style: "code")] }
      row.gap = c == 0 ? gap : 0
      rows.append(row)
    }
    return rows
  }

  /// Rows for one markdown body.
  static func rows(_ source: String, idPrefix: String, base: String = "prose", firstGap: Double = 12) -> [RowSpec] {
    var out: [RowSpec] = []
    for (index, block) in split(source).enumerated() {
      let gap: Double
      if index == 0 {
        gap = firstGap
      } else if case .item = block {
        gap = 4
      } else {
        gap = 14
      }
      out.append(contentsOf: rows(block, id: "\(idPrefix)#\(index)", base: base, gap: gap))
    }
    return out
  }
}
