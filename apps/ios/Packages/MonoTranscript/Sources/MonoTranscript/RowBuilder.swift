import Foundation
import MonoWire

/// What the rows depend on besides the blocks.
public struct RowOptions: Sendable, Equatable {
  /// The session is running: its last turn is live.
  public var live = false
  public var cwd: String?
  /// Fold rows the person opened.
  public var open: Set<String> = []
  /// Approvals being sent: their buttons read "Sending…".
  public var sending: Set<Int> = []
  /// Show the "Load earlier messages" row.
  public var hasOlder = false
  /// An older page is on its way.
  public var loadingOlder = false
  /// Settled plans offer Build (the host has `sessions.plan`, the session is idle).
  public var canBuild = false
  /// The zone footers print completion times in.
  public var timeZone: TimeZone = .current

  public init() {}
}

/// Session blocks to transcript rows (apps/mobile/src/transcript/rows.ts),
/// with the desktop's grouping from MonoWire: turns, activity trails and the
/// work fold. Rows of unchanged turns are reused, so a streamed delta
/// rebuilds only its turn. Not thread-safe: one builder per session, used
/// from one queue.
public final class RowBuilder {
  /// Row actions that open sheets above the transcript.
  public static let toolAction = "tool"
  public static let attachmentAction = "attachment:"
  public static let buildAction = "build:"
  public static let draftAction = "draft:"

  private var turnCache: [String: (blocks: [Block], key: String, rows: [RowSpec])] = [:]
  private var markdownCache: [String: (text: String, base: String, rows: [RowSpec])] = [:]

  public init() {}

  public static func formatDuration(_ ms: Int) -> String {
    let seconds = max(0, Int((Double(ms) / 1000).rounded(.toNearestOrAwayFromZero)))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
    return "\(minutes / 60)h \(minutes % 60)m"
  }

  static func clock(_ at: Int, _ zone: TimeZone) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let date = Date(timeIntervalSince1970: Double(at) / 1000)
    let hours = calendar.component(.hour, from: date)
    let minutes = calendar.component(.minute, from: date)
    return "\(hours % 12 == 0 ? 12 : hours % 12):\(minutes < 10 ? "0" : "")\(minutes) \(hours < 12 ? "AM" : "PM")"
  }

  private func markdown(_ block: Block, text: String, base: String = "prose") -> [RowSpec] {
    if let cached = markdownCache[block.id], cached.text == text, cached.base == base { return cached.rows }
    let rows = Markdown.rows(text, idPrefix: block.id, base: base)
    markdownCache[block.id] = (text, base, rows)
    return rows
  }

  private func userRows(_ block: Block) -> [RowSpec] {
    let images = block.attachments?.filter { $0.kind == "image" } ?? []
    let files = (block.attachments?.count ?? 0) - images.count
    let attachments = files > 0 ? "\(files) attachment\(files > 1 ? "s" : "")\n" : ""
    var bubble = RowSpec(id: block.id, version: Markdown.hash(block.text + attachments, seed: block.isDraft ? 1 : 0), kind: "userBubble")
    bubble.runs = [TextRun(text: attachments + block.text, style: "user")]
    if block.isDraft { bubble.status = "draft" }
    bubble.gap = 20
    bubble.a11y = "You said: \(block.text)"
    var rows = [bubble]
    // The host's draft (11 §11.16): its footer's Send and Remove.
    if block.isDraft {
      var draft = RowSpec(id: "\(block.id):draft", version: 1, kind: "thinkingRow")
      draft.runs = [TextRun(text: "Draft ", style: "trailVerb"), TextRun(text: "Send · Remove", style: "trailTarget", chip: 1)]
      draft.actions = [ActionSpec(id: "\(Self.draftAction)\(block.id)", label: "")]
      draft.a11y = "Draft. Send or remove"
      rows.append(draft)
    }
    // Images open in a sheet; the native view has no image rows yet.
    for (index, image) in images.enumerated() {
      var row = RowSpec(id: "\(block.id):image:\(image.id)", version: Markdown.hash(image.name, seed: index), kind: "thinkingRow")
      row.runs = [TextRun(text: "Image ", style: "trailVerb"), TextRun(text: image.name, style: "trailTarget", chip: 2)]
      row.actions = [ActionSpec(id: "\(Self.attachmentAction)\(image.id)", label: "")]
      row.gap = index > 0 ? 0 : 4
      row.a11y = "Image attachment \(image.name)"
      rows.append(row)
    }
    return rows
  }

  private func trailRow(_ block: Block, cwd: String?, last: Bool) -> RowSpec {
    if block.role == .reasoning {
      let summary = nonEmpty(Transcript.proseSummary(block.text)) ?? "Thinking"
      var row = RowSpec(id: block.id, version: Markdown.hash(summary, seed: block.isStreaming ? 1 : 0), kind: "thinkingRow")
      row.runs = [TextRun(text: summary, style: "reasoning")]
      row.pulse = block.isStreaming
      row.actions = [ActionSpec(id: Self.toolAction, label: "")]
      return row
    }
    if block.role == .system {
      var row = RowSpec(id: block.id, version: Markdown.hash(block.text, seed: 3), kind: "trailRow")
      row.last = last
      row.runs = [TextRun(text: block.text, style: "trailVerb")]
      return row
    }
    let label = Transcript.toolCallLabel(block, cwd: cwd)
    let state = Transcript.toolCallState(block)
    let display = Transcript.resolveToolCallDisplay(label, preview: block.tool?.preview, cwd: cwd)
    let failed = state == .rejected
    let runs: [TextRun]
    if let action = nonEmpty(display.action), let target = nonEmpty(display.target) {
      runs = [
        TextRun(text: "\(action) ", style: failed ? "trailFailed" : "trailVerb"),
        TextRun(text: display.isFile ? display.fileName : target, style: "trailTarget", chip: display.isFile ? 2 : 1),
      ]
    } else {
      runs = [TextRun(text: label, style: failed ? "trailFailed" : "trailTarget")]
    }
    var row = RowSpec(id: block.id, version: Markdown.hash(JSON.runs(runs), seed: (failed ? 1 : 0) + (last ? 2 : 0)), kind: "trailRow")
    row.runs = runs
    row.last = last
    row.status = state.rawValue
    row.actions = [ActionSpec(id: Self.toolAction, label: "")]
    row.a11y = label
    return row
  }

  private func approvalRow(_ block: Block, cwd: String?, sending: Bool) -> RowSpec {
    let requestId = block.approval?.requestId ?? 0
    let preview = block.tool?.preview
    var lines: [[TextRun]] = (preview?.lines?.prefix(6) ?? []).map { line in
      [TextRun(text: "\(line.kind == "add" ? "+" : line.kind == "del" ? "−" : " ") \(line.text)", style: "code")]
    }
    if lines.isEmpty, let output = nonEmpty(preview?.output) {
      lines = output.jsSplit("\n").suffix(6).map { [TextRun(text: $0, style: "code")] }
    }
    if lines.isEmpty, let detail = nonEmpty(block.tool?.detail) {
      lines = detail.jsSplit("\n").prefix(6).map { [TextRun(text: $0, style: "code")] }
    }
    let title = Transcript.toolCallLabel(block, cwd: cwd)
    var row = RowSpec(id: "\(block.id):approval", version: Markdown.hash(title + JSON.lines(lines), seed: sending ? 1 : 0), kind: "approvalControls")
    row.runs = [TextRun(text: title, style: "approvalTitle")]
    row.lines = lines
    row.gap = 8
    row.actions =
      sending
      ? [ActionSpec(id: "noop:\(requestId)", label: "Sending…")]
      : [ActionSpec(id: "deny:\(requestId)", label: "Deny"), ActionSpec(id: "allow:\(requestId)", label: "Allow", variant: "primary")]
    row.a11y = "Approval needed: \(title)"
    return row
  }

  private func itemRows(_ item: TurnItem, _ options: RowOptions) -> [RowSpec] {
    if case let .block(block) = item {
      let status = block.plan?.status
      let buildable = !block.isStreaming && !block.text.jsTrim.isEmpty && status != "building" && status != "built"
      if block.role == .plan && options.canBuild && buildable {
        var build = RowSpec(id: "\(block.id):build", version: 1, kind: "thinkingRow")
        build.runs = [TextRun(text: "Build ", style: "trailVerb"), TextRun(text: "this plan", style: "trailTarget", chip: 1)]
        build.actions = [ActionSpec(id: "\(Self.buildAction)\(block.id)", label: "", variant: "primary")]
        build.gap = 6
        build.a11y = "Build this plan"
        return markdown(block, text: block.text) + [build]
      }
      if block.role == .assistant || block.role == .plan || block.role == .tasks {
        return markdown(block, text: block.text)
      }
      if block.role == .system && Transcript.isNoticeBlock(block) {
        var row = RowSpec(id: block.id, version: Markdown.hash(block.text, seed: 9), kind: "notice")
        row.status = block.notice == "interrupt" ? "interrupt" : "error"
        row.runs = [TextRun(text: block.text, style: "notice")]
        row.gap = 8
        return [row]
      }
      if block.role == .reasoning { return [trailRow(block, cwd: options.cwd, last: true)] }
      return markdown(block, text: block.text.isEmpty ? block.role.rawValue : block.text, base: "meta")
    }
    var rows: [RowSpec] = []
    let blocks = item.blocks
    for (index, block) in blocks.enumerated() {
      rows.append(trailRow(block, cwd: options.cwd, last: index == blocks.count - 1))
      if Transcript.needsApproval(block) {
        rows.append(approvalRow(block, cwd: options.cwd, sending: options.sending.contains(block.approval?.requestId ?? -1)))
      }
    }
    if !rows.isEmpty { rows[0].gap += 6 }
    return rows
  }

  private func turnRows(_ turn: [Block], live: Bool, _ options: RowOptions) -> [RowSpec] {
    var rows: [RowSpec] = []
    let user = turn.first?.role == .user ? turn.first : nil
    if let user { rows.append(contentsOf: userRows(user)) }
    let rest = user == nil ? turn : Array(turn.dropFirst())
    let items = Transcript.groupTurnItems(rest, settled: !live)
    let fold = live ? nil : Transcript.foldableWork(items)
    let turnId = user?.id ?? turn.first?.id ?? "turn"
    if live && !rest.contains(where: { !$0.text.jsTrim.isEmpty || $0.role == .tool }) {
      var thinking = RowSpec(id: "\(turnId):thinking", version: 1, kind: "thinkingRow")
      thinking.runs = [TextRun(text: "Thinking…", style: "reasoning")]
      thinking.pulse = true
      thinking.gap = 10
      rows.append(thinking)
    }
    let foldId = "\(turnId):fold"
    let open = options.open.contains(foldId)
    for (index, item) in items.enumerated() {
      if let fold, index == fold.start {
        let label: String
        if let duration = user?.durationMs, let model = user?.turnModel?.name, !model.isEmpty {
          label = "\(model) worked for \(Self.formatDuration(duration))"
        } else {
          label = Transcript.workSummaryLine(Transcript.foldedBlocks(items, fold))
        }
        var row = RowSpec(id: foldId, version: Markdown.hash(label, seed: open ? 1 : 0), kind: "foldLine")
        row.open = open
        row.runs = [TextRun(text: label, style: "fold")]
        row.gap = 8
        rows.append(row)
        if !open { continue }
      } else if let fold, index > fold.start, index <= fold.end, !open {
        continue
      }
      rows.append(contentsOf: itemRows(item, options))
    }
    if !live, let user, let duration = user.durationMs, let started = user.startedAt, started != 0 {
      let text = "worked for \(Self.formatDuration(duration)) · \(Self.clock(started + duration, options.timeZone))"
      var footer = RowSpec(id: "\(turnId):footer", version: Markdown.hash(text), kind: "turnFooter")
      footer.runs = [TextRun(text: text, style: "meta")]
      footer.gap = 2
      rows.append(footer)
    }
    return rows
  }

  /// All rows for a session window. Each turn's rows are cached against its
  /// blocks, so only the live turn is rebuilt while it streams.
  public func rows(_ blocks: [Block], _ options: RowOptions) -> [RowSpec] {
    let turns = Transcript.groupTurns(blocks)
    var rows: [RowSpec] = []
    if options.hasOlder {
      var older = RowSpec(id: "older", version: options.loadingOlder ? 2 : 1, kind: "loadOlder")
      older.label = options.loadingOlder ? "Loading earlier messages…" : "Load earlier messages"
      rows.append(older)
    }
    var seen = Set<String>()
    for (index, turn) in turns.enumerated() {
      let live = options.live && index == turns.count - 1
      guard let head = turn.first else { continue }
      seen.insert(head.id)
      let key = "\(live)|\(options.open.contains("\(head.id):fold"))|\(options.sending.sorted())|\(options.canBuild)|\(options.cwd ?? "")"
      if let cached = turnCache[head.id], cached.key == key, cached.blocks == turn {
        rows.append(contentsOf: cached.rows)
        continue
      }
      let built = turnRows(turn, live: live, options)
      turnCache[head.id] = (turn, key, built)
      rows.append(contentsOf: built)
    }
    // Forget turns that left the window.
    if turnCache.count > seen.count * 2 + 16 { turnCache = turnCache.filter { seen.contains($0.key) } }
    var end = RowSpec(id: "end", version: 1, kind: "spacer")
    end.height = 24
    rows.append(end)
    return rows
  }
}

/// `JSON.stringify` for the run lists the TypeScript hashes into versions.
enum JSON {
  static func string(_ text: String) -> String {
    let units = Array(text.utf16)
    var out = "\""
    var i = 0
    while i < units.count {
      let unit = units[i]
      switch unit {
      case 0x22: out += "\\\""
      case 0x5C: out += "\\\\"
      case 0x08: out += "\\b"
      case 0x0C: out += "\\f"
      case 0x0A: out += "\\n"
      case 0x0D: out += "\\r"
      case 0x09: out += "\\t"
      case 0..<0x20: out += String(format: "\\u%04x", unit)
      case 0xD800..<0xDC00 where i + 1 < units.count && (0xDC00..<0xE000).contains(units[i + 1]):
        // A surrogate pair stays raw, as JSON.stringify leaves it.
        out += String(decoding: units[i...(i + 1)], as: UTF16.self)
        i += 1
      case 0xD800..<0xE000: out += String(format: "\\u%04x", unit)
      default: out += String(decoding: [unit], as: UTF16.self)
      }
      i += 1
    }
    return out + "\""
  }

  static func run(_ run: TextRun) -> String {
    var fields = ["\"t\":\(string(run.text))", "\"s\":\(string(run.style))"]
    if let link = run.link { fields.append("\"link\":\(string(link))") }
    if run.chip != 0 { fields.append("\"chip\":\(run.chip)") }
    return "{\(fields.joined(separator: ","))}"
  }

  static func runs(_ runs: [TextRun]) -> String {
    "[\(runs.map(run).joined(separator: ","))]"
  }

  static func lines(_ lines: [[TextRun]]) -> String {
    "[\(lines.map(runs).joined(separator: ","))]"
  }
}

private func nonEmpty(_ value: String?) -> String? {
  guard let value, !value.isEmpty else { return nil }
  return value
}
