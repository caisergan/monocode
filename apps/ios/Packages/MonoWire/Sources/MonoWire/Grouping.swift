import Foundation

// Turn and step grouping shared with the desktop
// (src/features/sessions/model/transcriptActivity.ts, 11 §11.16): the phone
// draws the same turns, folds and trail rows from the same rules.

public enum ToolCallState: String, Sendable {
  case pending, accepted, rejected
}

public enum TurnItem: Equatable, Sendable {
  case block(Block)
  case activity([Block])
  /// Delegated runs spawned together, kept out of the folding work trail.
  case subagents([Block])

  public var blocks: [Block] {
    switch self {
    case let .block(block): [block]
    case let .activity(blocks), let .subagents(blocks): blocks
    }
  }
}

/// The span of a turn's items that folds away once the agent has answered.
public struct WorkFold: Equatable, Sendable {
  public var start: Int
  public var end: Int
}

public struct ToolCallDisplay: Equatable, Sendable {
  public var action: String?
  public var target: String?
  public var fileName: String
  public var filePath: String?
  public var isFile: Bool
  public var previewMatchesFile: Bool
}

public enum Transcript {
  public static let interruptMessage = "Turn interrupted when MonoCode quit."

  public static func needsApproval(_ block: Block) -> Bool {
    block.approval != nil && block.approval?.decided == nil
  }

  public static func isFailedStatus(_ status: String?) -> Bool {
    let value = status?.lowercased() ?? ""
    return value == "failed" || value == "error" || value == "cancelled" || value == "canceled"
  }

  public static func toolCallState(_ block: Block) -> ToolCallState {
    let status = block.tool?.status?.lowercased() ?? ""
    let decided = block.approval?.decided
    if decided == "deny" { return .rejected }
    if isFailedStatus(status) { return .rejected }
    if needsApproval(block) { return .pending }
    if status == "completed" || status == "success" { return .accepted }
    if block.isStreaming || status == "in_progress" || status == "pending" || status == "running" { return .pending }
    if decided == "allow" || decided == "cancelled" || status.isEmpty { return .accepted }
    return .pending
  }

  /// The tool's title text: the block text, else the tool's title.
  static func titleText(_ block: Block) -> String? {
    block.text.isEmpty ? block.tool?.title : block.text
  }

  public static func toolCallLabel(_ block: Block, cwd: String? = nil) -> String {
    let preview = block.tool?.preview
    let path = preview?.path.flatMap(nonEmpty).map { Paths.displayPath($0, cwd: cwd) } ?? preview?.fileName
    let title = ToolKinds.composeTitle(
      kind: block.tool?.kind, title: titleText(block), path: path, query: preview?.query, previewKind: preview?.kind,
      cwd: cwd)
    return title.isEmpty ? "Working" : title
  }

  static func isIncompleteTool(_ block: Block, label: String, state: ToolCallState) -> Bool {
    if state != .pending { return false }
    if let kind = block.tool?.kind?.lowercased(), !kind.isEmpty, kind != "other" { return false }
    let preview = block.tool?.preview
    if nonEmpty(preview?.path) != nil || nonEmpty(preview?.query) != nil || !(preview?.lines?.isEmpty ?? true) {
      return false
    }
    return label.isEmpty || ToolKinds.isWeakTitle(label)
  }

  public static func isHiddenTool(_ block: Block) -> Bool {
    if block.role != .tool && block.role != .approval { return false }
    if block.tool?.kind?.lowercased() == "tasks" { return true }
    if ToolKinds.isEdit(block.tool?.kind, titleText(block), block.tool?.preview) { return false }
    return isIncompleteTool(block, label: toolCallLabel(block), state: toolCallState(block))
  }

  /// An error, or the note that a quit cut the turn short.
  public static func isNoticeBlock(_ block: Block) -> Bool {
    block.role == .system && (nonEmpty(block.notice) != nil || block.text == interruptMessage)
  }

  static func isStatusStep(_ block: Block) -> Bool {
    block.role == .system && block.interjection == nil
  }

  public static func isActivityBlock(_ block: Block) -> Bool {
    if isThinkingBlock(block) { return true }
    if block.role == .system { return block.interjection == nil && !isNoticeBlock(block) }
    if block.role != .tool && block.role != .approval { return false }
    if ToolKinds.isEdit(block.tool?.kind, titleText(block), block.tool?.preview) && needsApproval(block) { return false }
    return !isHiddenTool(block)
  }

  public static func isThinkingBlock(_ block: Block) -> Bool {
    block.role == .reasoning && !block.text.jsTrim.isEmpty
  }

  public static func isToolBlock(_ block: Block) -> Bool {
    block.role == .tool || block.role == .approval
  }

  public static func isProseBlock(_ block: Block) -> Bool {
    block.role == .assistant && !block.text.jsTrim.isEmpty
  }

  private static let fence = JSRegex("```[\\s\\S]*?(?:```|$)", "g")
  private static let paragraphBreak = JSRegex("\\n\\s*\\n")
  private static let lineMarker = JSRegex("^\\s{0,3}(?:#{1,6}|>|[-*+]|\\d+\\.)\\s+", "gm")
  private static let code = JSRegex("`([^`]*)`", "g")
  private static let link = JSRegex("!?\\[([^\\]]*)\\]\\([^)]*\\)", "g")
  private static let strong = JSRegex("(\\*\\*|__)(.+?)\\1", "g")
  private static let em = JSRegex("(\\*|_)(.+?)\\1", "g")
  private static let spaces = JSRegex("\\s+", "g")

  /// The first paragraph of a folded prose block, as one plain line.
  public static func proseSummary(_ text: String) -> String {
    let body = fence.replace(text, " ")
    let paragraph = paragraphBreak.split(body).map(\.jsTrim).first { !$0.isEmpty } ?? ""
    var out = lineMarker.replace(paragraph, "")
    out = code.replace(out, "$1")
    out = link.replace(out, "$1")
    out = strong.replace(out, "$2")
    out = em.replace(out, "$2")
    return spaces.replace(out, " ").jsTrim
  }

  public static func editVerb(_ label: String) -> String {
    let word = label.jsTrim.components(separatedBy: .whitespacesAndNewlines).first?.lowercased() ?? ""
    switch word {
    case "delete", "deleted", "remove", "removed": return "Delete"
    case "move", "moved", "rename", "renamed": return "Move"
    case "create", "created", "add", "added", "new": return "Create"
    case "write", "wrote", "writing": return "Write"
    default: return "Edit"
    }
  }

  private static let labelParts = JSRegex("^(Read|Find|Skill|List|Edit|Write)\\s+(.+)$")
  private static let trailingSeparators = JSRegex("[/\\\\]+$")
  private static let separators = JSRegex("[/\\\\]")

  /// Parses a tool row's label into the action and target shown, and the file
  /// a tap opens (always derived from the target the row shows).
  public static func resolveToolCallDisplay(_ label: String, preview: ToolPreview?, cwd: String?) -> ToolCallDisplay {
    let parts = labelParts.match(label)
    let labelVerb = parts?[1] ?? nil
    let labelTarget = parts?[2] ?? nil
    let writeTarget: String? =
      preview?.kind == .write ? (nonEmpty(preview?.path).map { Paths.displayPath($0, cwd: cwd) } ?? preview?.fileName) : nil
    func isFileVerb(_ verb: String?) -> Bool { ["Read", "List", "Edit", "Write"].contains(verb ?? "") }
    let trustedLabelTarget =
      labelTarget.flatMap { target in
        !isFileVerb(labelVerb) || Paths.resolveWorkspacePath(target, cwd: cwd) != nil ? target : nil
      }
    let trimmedLabel = label.jsTrim.lowercased()
    let previewFile = nonEmpty(preview?.path) ?? nonEmpty(preview?.fileName)
    let action: String? =
      labelVerb ?? (nonEmpty(writeTarget) != nil ? editVerb(label) : nil)
      ?? (trimmedLabel == "read" && previewFile != nil
        ? "Read"
        : trimmedLabel == "find" && nonEmpty(preview?.query) != nil
          ? "Find"
          : trimmedLabel == "list" && previewFile != nil ? "List" : trimmedLabel == "skill" ? "Skill" : nil)
    let fileTarget = nonEmpty(preview?.path).map { Paths.displayPath($0, cwd: cwd) } ?? preview?.fileName
    let target: String? =
      nonEmpty(trustedLabelTarget) ?? nonEmpty(writeTarget)
      ?? (isFileVerb(action) ? fileTarget : action == "Find" ? preview?.query : nil)
    guard let action, let target, !target.isEmpty else {
      return ToolCallDisplay(fileName: "file", isFile: false, previewMatchesFile: true)
    }
    let isFile = action != "Find" && action != "Skill"
    let fileName =
      nonEmpty(preview?.fileName) ?? separators.split(trailingSeparators.replace(target, "")).last { !$0.isEmpty } ?? "file"
    let filePath = Paths.resolveWorkspacePath(target, cwd: cwd)
    let writePath = preview?.kind == .write ? nonEmpty(preview?.path) : nil
    let previewPath = writePath.flatMap { Paths.resolveWorkspacePath(Paths.displayPath($0, cwd: cwd), cwd: cwd) }
    let matches: Bool
    if writePath == nil {
      matches = true
    } else if let previewPath, let filePath {
      matches = Paths.pathKey(previewPath) == Paths.pathKey(filePath)
    } else {
      matches = false
    }
    return ToolCallDisplay(
      action: action, target: target, fileName: fileName, filePath: filePath, isFile: isFile, previewMatchesFile: matches)
  }

  /// User turns, with handoff dividers on their own row. `managed` keeps the
  /// app-written turns of a worker's own transcript.
  public static func groupTurns(_ blocks: [Block], managed: Bool = false) -> [[Block]] {
    var turns: [[Block]] = []
    var current: [Block] = []
    for block in blocks {
      if block.internal == true && !managed { continue }
      if block.role == .handoff {
        if !current.isEmpty { turns.append(current) }
        turns.append([block])
        current = []
        continue
      }
      if block.role == .user && !current.isEmpty {
        turns.append(current)
        current = []
      }
      current.append(block)
    }
    if !current.isEmpty { turns.append(current) }
    return turns
  }

  /// Contiguous tool calls and reasoning folded into activity groups; prose
  /// always stands on its own. A settled turn puts interjections and
  /// finished subagents into the trail too.
  public static func groupTurnItems(_ blocks: [Block], settled: Bool = false) -> [TurnItem] {
    let visible = withoutSupersededInitialThinking(blocks.filter { !isIgnoredTurnBlock($0) && !isHiddenTool($0) })
    var items: [TurnItem] = []
    var activity: [Block] = []
    func flush() {
      if !activity.isEmpty { items.append(.activity(activity)) }
      activity = []
    }
    for block in visible {
      if isSubagentBlock(block) && (!settled || toolCallState(block) == .rejected) {
        flush()
        if case let .subagents(group)? = items.last {
          items[items.count - 1] = .subagents(group + [block])
        } else {
          items.append(.subagents([block]))
        }
        continue
      }
      if isActivityBlock(block) || (settled && block.interjection != nil) {
        activity.append(block)
        continue
      }
      flush()
      items.append(.block(block))
    }
    flush()
    return items
  }

  /// Reasoning before the first answer is dropped once the answer arrives,
  /// unless a tool started first.
  static func withoutSupersededInitialThinking(_ blocks: [Block]) -> [Block] {
    var start = 0
    while start < blocks.count && (blocks[start].role == .user || blocks[start].role == .system) { start += 1 }
    var end = start
    while end < blocks.count && isThinkingBlock(blocks[end]) { end += 1 }
    if end == start { return blocks }
    let following = blocks[end...]
    guard let prose = following.firstIndex(where: isProseBlock) else { return blocks }
    if let tool = following.firstIndex(where: isToolBlock), tool < prose { return blocks }
    return Array(blocks[..<start]) + Array(blocks[end...])
  }

  /// The leading reasoning-only activity shown before the first response.
  public static func initialThinkingIndex(_ items: [TurnItem]) -> Int {
    for (index, item) in items.enumerated() {
      if case let .block(block) = item, block.role == .user || block.role == .system { continue }
      if case let .activity(blocks) = item, !blocks.isEmpty, blocks.allSatisfy(isThinkingBlock) { return index }
      return -1
    }
    return -1
  }

  static func isIgnoredTurnBlock(_ block: Block) -> Bool {
    if block.role == .reasoning { return block.text.jsTrim.isEmpty }
    return block.role == .assistant && block.text.jsTrim.isEmpty
  }

  private static let lineEndings = JSRegex("\\r\\n?", "g")

  /// What the user reads: assistant prose, tasks and plans.
  public static func turnCopyText(_ blocks: [Block]) -> String {
    blocks.filter { $0.role == .assistant || $0.role == .tasks || $0.role == .plan }
      .map { lineEndings.replace($0.text, "\n").jsTrim }
      .filter { !$0.isEmpty }
      .joined(separator: "\n\n")
  }

  public static func isSubagentBlock(_ block: Block) -> Bool {
    isToolBlock(block) && !needsApproval(block) && ToolKinds.isAgent(block.tool?.kind, titleText(block))
  }

  private static let agentLead = JSRegex("^(?:agent|task|subagent)\\b[\\s:·-]*", "i")
  private static let firstSentence = JSRegex("^[^.!?]*[.!?]?")
  private static let trailingPunctuation = JSRegex("[\\s,;:]+$")
  static let maxSubagentName = 56

  public static func subagentBrief(_ block: Block) -> String {
    let name = nonEmpty(block.agentRun?.name.jsTrim) ?? (titleText(block) ?? "").jsTrim
    let stripped = agentLead.replace(name, "").jsTrim
    return stripped.isEmpty ? "Subagent" : stripped
  }

  public static func subagentName(_ block: Block) -> String {
    let brief = subagentBrief(block)
    let sentence = (firstSentence.match(brief)?[0] ?? brief).jsTrim
    let name = sentence.isEmpty ? brief : sentence
    if name.jsLength <= maxSubagentName { return name }
    let cut = name.jsSlice(0, maxSubagentName)
    let space = cut.jsLastIndexOf(" ")
    let trimmed = space > maxSubagentName / 2 ? cut.jsSlice(0, space) : cut
    return trailingPunctuation.replace(trimmed, "") + "\u{2026}"
  }

  /// A failed delegated call must stay visible even when the trail folds.
  public static func subagentFailureSummary(_ blocks: [Block]) -> String? {
    let failed = blocks.filter {
      isToolBlock($0) && ToolKinds.isAgent($0.tool?.kind, titleText($0)) && toolCallState($0) == .rejected
    }.count
    if failed == 0 { return nil }
    return failed == 1 ? "Subagent failed" : "\(failed) subagents failed"
  }

  public enum WorkKind: String, Sendable, CaseIterable {
    case edit, run, agent, research, other
  }

  private static let editLabel = JSRegex("^(?:Edit|Write)\\s+\\S", "i")
  private static let researchLabel = JSRegex("^(?:Read|List|Find)\\b", "i")

  public static func toolCategory(_ block: Block) -> WorkKind {
    let kind = block.tool?.kind
    let title = titleText(block)
    let preview = block.tool?.preview
    let label = toolCallLabel(block)
    if ToolKinds.isAgent(kind, title) { return .agent }
    if ToolKinds.isEdit(kind, title, preview) { return .edit }
    if ToolKinds.isSearch(kind, title, preview) { return .research }
    if ToolKinds.isRead(kind, title, preview) { return .research }
    if editLabel.test(label) { return .edit }
    if researchLabel.test(label) { return .research }
    if ToolKinds.isExecute(kind, title) { return .run }
    return .other
  }

  private struct Tally {
    var order: [WorkKind] = []
    var reads: [String] = []
    var edits: [String] = []
    var searches = 0
    var runs = 0
    var background = 0
    var backgroundLive = 0
    var agents = 0
    var others = 0
    var notes = 0

    mutating func add(_ value: String, to set: WritableKeyPath<Tally, [String]>) {
      if !self[keyPath: set].contains(value) { self[keyPath: set].append(value) }
    }
  }

  private static let labelledTarget = JSRegex("^(?:Read|List|Edit|Write)\\s+(.+)$", "i")
  private static let findLabel = JSRegex("^Find\\b", "i")

  private static func tally(_ steps: [Block]) -> Tally {
    var tally = Tally()
    for block in steps {
      if block.interjection != nil {
        tally.notes += 1
        continue
      }
      if !isToolBlock(block) { continue }
      let preview = block.tool?.preview
      let label = toolCallLabel(block)
      let target = preview?.path ?? preview?.fileName ?? (labelledTarget.match(label)?[1] ?? nil) ?? block.id
      let category = toolCategory(block)
      if !tally.order.contains(category) { tally.order.append(category) }
      switch category {
      case .edit: tally.add(target, to: \.edits)
      case .agent: tally.agents += 1
      case .run:
        if block.tool?.background == true {
          tally.background += 1
          if toolCallState(block) == .pending { tally.backgroundLive += 1 }
        } else {
          tally.runs += 1
        }
      case .research:
        if findLabel.test(label) || ToolKinds.isSearch(block.tool?.kind, titleText(block), preview) {
          tally.searches += 1
        } else {
          tally.add(target, to: \.reads)
        }
      case .other: tally.others += 1
      }
    }
    return tally
  }

  private static func fileLabel(_ paths: [String]) -> String {
    if paths.count == 1, let first = paths.first, !first.isEmpty {
      return nonEmpty(Paths.leafName(first)) ?? first
    }
    return "\(paths.count) files"
  }

  private static func workSummary(_ kind: WorkKind, _ tally: Tally, live: Bool) -> String {
    switch kind {
    case .edit:
      return "\(live ? "Editing" : "Edited") \(fileLabel(tally.edits))"
    case .research:
      if !tally.reads.isEmpty && tally.searches == 0 { return "\(live ? "Reading" : "Read") \(fileLabel(tally.reads))" }
      if tally.reads.isEmpty { return live ? "Searching the project" : "Searched the project" }
      return live ? "Exploring the project" : "Explored the project"
    case .run:
      if tally.backgroundLive > 0 { return "Running in background" }
      if tally.runs == 0 && tally.background > 0 { return "Finished in background" }
      return tally.runs == 1 ? (live ? "Running a command" : "Ran a command") : "\(live ? "Running" : "Ran") \(tally.runs) commands"
    case .agent:
      return tally.agents == 1 ? (live ? "Running a subagent" : "Ran a subagent") : "\(live ? "Running" : "Ran") \(tally.agents) subagents"
    case .other:
      return tally.others == 1 ? (live ? "Running a tool" : "Ran a tool") : "\(live ? "Running" : "Ran") \(tally.others) tools"
    }
  }

  private static func currentWorkKind(_ steps: [Block]) -> WorkKind? {
    steps.last(where: isToolBlock).map(toolCategory)
  }

  /// "Read 3 files · Edited 2 files · Ran a command": one clause per kind; the
  /// clause for the call in flight is present tense while live.
  public static func workSummaryLine(_ steps: [Block], live: Bool = false) -> String {
    if let app = MonoCodeCalls.workSummary(steps, live: live) { return app }
    let tally = tally(steps)
    let notes = tally.notes == 1 ? "1 note" : tally.notes > 1 ? "\(tally.notes) notes" : ""
    if tally.order.isEmpty {
      if !notes.isEmpty { return notes }
      if !steps.isEmpty && steps.allSatisfy(isStatusStep) { return "Status update" }
      return live ? "Thinking" : "Thought"
    }
    let running = live ? currentWorkKind(steps) : nil
    let clauses = tally.order.map { workSummary($0, tally, live: $0 == running) } + (notes.isEmpty ? [] : [notes])
    return clauses.joined(separator: " · ")
  }

  /// The work a turn can put away: from the first thing the agent did to the
  /// last group it has narrated past.
  public static func foldableWork(_ items: [TurnItem]) -> WorkFold? {
    var end = -1
    var answered = false
    var index = yieldedAt(items) - 1
    while index >= 0 {
      let item = items[index]
      if case .activity = item {
        if answered && isFoldableItem(item) {
          end = index
          break
        }
      } else if case let .block(block) = item, isProseBlock(block) {
        answered = true
      }
      index -= 1
    }
    if end < 0 { return nil }
    var start = end
    while start > 0 && isFoldableItem(items[start - 1]) { start -= 1 }
    return WorkFold(start: start, end: end)
  }

  /// Where the fold has to stop: the first group of background rows right
  /// under the message the agent yielded with.
  static func yieldedAt(_ items: [TurnItem]) -> Int {
    for (at, item) in items.enumerated() {
      guard case let .activity(blocks) = item, blocks.contains(where: { $0.tool?.background == true }), at > 0,
        case let .block(before) = items[at - 1], isProseBlock(before)
      else { continue }
      return at
    }
    return items.count
  }

  static func isFoldableItem(_ item: TurnItem) -> Bool {
    switch item {
    case .subagents: true
    case let .activity(blocks): !blocks.contains(where: needsApproval)
    case let .block(block): isProseBlock(block)
    }
  }

  public static func firstFoldableIndex(_ items: [TurnItem]) -> Int {
    items.firstIndex(where: isFoldableItem) ?? -1
  }

  /// Every block inside a fold; delegated runs keep their own rows.
  public static func foldedBlocks(_ items: [TurnItem], _ fold: WorkFold) -> [Block] {
    items[fold.start...fold.end].flatMap { item -> [Block] in
      switch item {
      case let .block(block): [block]
      case .subagents: []
      case let .activity(blocks): blocks
      }
    }
  }
}

/// MonoCode's own CLI calls (src/features/sessions/model/monocodeToolCall.ts):
/// a group of only these is named for the app, not the shell.
public enum MonoCodeCalls {
  static let actions: [String: String] = [
    "models.list": "List models", "sessions.list": "List sessions", "sessions.read": "Read a session",
    "sessions.send": "Continue a session", "sessions.draft": "Save a draft", "sessions.start": "Start a session",
    "folders.list": "List folders", "folders.move": "Move a session", "notes.list": "List notes",
    "notes.read": "Read a note", "notes.write": "Write a note",
  ]

  private static let runPrefix = JSRegex("^Run(?:ning)?\\s+command:\\s*", "i")
  private static let monocodeBin = JSRegex("(?:^|[/\\\\])monocode(?:\\.exe)?$", "i")
  private static let quotedEscapable = JSRegex("[\\\\\"$`]")
  private static let bareEscapable = JSRegex("[\\s'\"\\\\;&|<>()\\[\\]{}$`#]")
  private static let bareStop = JSRegex("[\\r\\n;&|<>()\\[\\]{}#]")
  private static let whitespace = JSRegex("\\s")

  static func shellWords(_ command: String) -> [String]? {
    var words: [String] = []
    var word = ""
    var started = false
    var quote: Character?
    let chars = Array(command.utf16)
    var index = 0
    func ch(_ i: Int) -> String { i < chars.count ? String(decoding: [chars[i]], as: UTF16.self) : "" }
    while index < chars.count {
      let char = ch(index)
      if quote == "'" {
        if char == "'" { quote = nil } else { word += char }
        index += 1
        continue
      }
      if char == "'" && quote == nil {
        quote = "'"
        started = true
        index += 1
        continue
      }
      if char == "\"" {
        quote = quote == "\"" ? nil : "\""
        started = true
        index += 1
        continue
      }
      if char == "\\" {
        let next = ch(index + 1)
        if next.isEmpty { return nil }
        if (quote == "\"" && !quotedEscapable.test(next)) || (quote == nil && !bareEscapable.test(next)) {
          word += char
        } else {
          word += next
          index += 1
        }
        started = true
        index += 1
        continue
      }
      if char == "$" || char == "`" { return nil }
      if quote == nil && bareStop.test(char) { return nil }
      if quote == nil && whitespace.test(char) {
        if started { words.append(word) }
        word = ""
        started = false
        index += 1
        continue
      }
      word += char
      started = true
      index += 1
    }
    if quote != nil { return nil }
    if started { words.append(word) }
    return words
  }

  /// The app CLI command a block runs, if it is one.
  public static func call(_ block: Block) -> (action: String, label: String)? {
    if block.role != .tool && block.role != .approval { return nil }
    let candidate =
      (block.tool?.preview?.kind == .shell ? block.tool?.preview?.title : nil) ?? block.tool?.title ?? block.text
    let command = runPrefix.replace(candidate.jsTrim, "")
    if command.isEmpty { return nil }
    guard let words = shellWords(command), let first = words.first, monocodeBin.test(first) else { return nil }
    guard words.count > 1, words[1] == "app" else { return nil }
    let action = words.count > 2 ? words[2] : "--help"
    if action == "--help" || action == "help" || action == "-h" {
      return words.count > 3 ? nil : ("--help", "View CLI commands")
    }
    guard let label = actions[action] else { return nil }
    var index = 3
    while index < words.count {
      if !["--json", "--input", "--request-id"].contains(words[index]) || index + 1 >= words.count || words[index + 1].isEmpty {
        return nil
      }
      index += 2
    }
    return (action, label)
  }

  public static func workSummary(_ steps: [Block], live: Bool) -> String? {
    if steps.contains(where: { $0.interjection != nil || $0.role == .system }) { return nil }
    let calls = steps.filter { $0.role == .tool || $0.role == .approval }
    if calls.isEmpty || calls.contains(where: { call($0) == nil }) { return nil }
    return live ? "Using MonoCode" : "Used MonoCode"
  }
}
