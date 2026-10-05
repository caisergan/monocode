import Foundation

// Phone-facing summary fields computed on the host (packages/core/src/summary.ts,
// 06 §6.5, §6.10). The demo host computes them; the phone reads them.

public enum Summary {
  private static let fencedCode = JSRegex("```[^\\n]*\\n([\\s\\S]*?)```", "g")
  private static let inlineCode = JSRegex("`([^`]*)`", "g")
  private static let image = JSRegex("!\\[([^\\]]*)\\]\\([^)]*\\)", "g")
  private static let link = JSRegex("\\[([^\\]]*)\\]\\([^)]*\\)", "g")
  private static let heading = JSRegex("^\\s{0,3}#{1,6}\\s+", "gm")
  private static let quote = JSRegex("^\\s{0,3}>\\s?", "gm")
  private static let bullet = JSRegex("^\\s*[-*+]\\s+", "gm")
  private static let ordered = JSRegex("^\\s*\\d+[.)]\\s+", "gm")
  private static let strong = JSRegex("(\\*\\*|__)(.*?)\\1", "g")
  private static let em = JSRegex("(\\*|_)(.*?)\\1", "g")
  private static let strike = JSRegex("~~(.*?)~~", "g")
  private static let pipe = JSRegex("\\|", "g")
  private static let space = JSRegex("\\s+", "g")

  /// Markdown to one line of plain text, for list rows and notifications.
  public static func plainTextPreview(_ markdown: String, max: Int = 280) -> String {
    var text = fencedCode.replace(markdown, " $1 ")
    text = inlineCode.replace(text, "$1")
    text = image.replace(text, "$1")
    text = link.replace(text, "$1")
    text = heading.replace(text, "")
    text = quote.replace(text, "")
    text = bullet.replace(text, "")
    text = ordered.replace(text, "")
    text = strong.replace(text, "$2")
    text = em.replace(text, "$2")
    text = strike.replace(text, "$1")
    text = pipe.replace(text, " ")
    text = space.replace(text, " ").jsTrim
    guard text.jsLength > max else { return text }
    let cut = text.jsSlice(0, max - 1)
    return cut.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) + "…"
  }

  public static func lastAssistantText(_ blocks: [Block]) -> String? {
    for block in blocks.reversed() {
      if block.role == .assistant && !block.text.jsTrim.isEmpty { return plainTextPreview(block.text) }
      if block.role == .user && !block.isDraft { return nil }
    }
    return nil
  }

  /// The last turn's blocks: from the last submitted user block to the end.
  static func lastTurn(_ blocks: [Block]) -> ArraySlice<Block> {
    if let i = blocks.lastIndex(where: { $0.role == .user && !$0.isDraft }) { return blocks[i...] }
    return blocks[...]
  }

  public static func attention(_ value: HostSession) -> AttentionKind? {
    let session = value.session
    if session.blocks.contains(where: { $0.approval != nil && $0.approval?.decided == nil }) { return .approval }
    if session.pendingQuestion != nil { return .question }
    if value.status == .running { return nil }
    let turn = lastTurn(session.blocks)
    if !turn.contains(where: { $0.role == .user && !$0.isDraft }) { return nil }
    if turn.contains(where: { $0.notice == "error" }) || value.lastTurnOutcome == .failed { return .error }
    if value.status == .interrupted { return .interrupted }
    if session.usageLimit != nil { return .usageLimit }
    return .finished
  }

  private static func attentionOrder(_ attention: Attention) -> Int {
    switch attention.kind {
    case .approval?: 0
    case .question?: 1
    case .error?: 2
    case .interrupted?: 3
    case .usageLimit?: 4
    case .finished?: 5
    case nil: 6
    // An unknown kind sorts like JavaScript's `undefined - n`: NaN, so the
    // order falls through to the time.
    default: -1
    }
  }

  /// `compareInboxItems`: attention first, then newest. A sort comparator
  /// (`a` before `b`).
  public static func inboxOrder(_ a: InboxItem, _ b: InboxItem) -> Bool {
    let x = attentionOrder(a.attention)
    let y = attentionOrder(b.attention)
    if x >= 0, y >= 0, x != y { return x < y }
    return a.updatedAt > b.updatedAt
  }

  public static func pendingApproval(_ value: HostSession) -> InboxItem.ApprovalSummary? {
    guard let block = value.session.blocks.first(where: { $0.approval != nil && $0.approval?.decided == nil }),
      let approval = block.approval
    else { return nil }
    let title = [block.tool?.title, block.text].compactMap { $0 }.first { !$0.isEmpty } ?? "Approval needed"
    return InboxItem.ApprovalSummary(
      requestId: approval.requestId, title: title, kind: block.tool?.kind.flatMap { $0.isEmpty ? nil : $0 },
      preview: block.tool?.preview)
  }

  public static func pendingQuestion(_ value: HostSession) -> InboxItem.QuestionSummary? {
    guard let prompt = value.session.pendingQuestion else { return nil }
    return InboxItem.QuestionSummary(
      requestId: prompt.requestId, title: prompt.title.flatMap { $0.isEmpty ? nil : $0 }, count: prompt.questions.count,
      autoResolveAt: prompt.autoResolveAt.flatMap { $0 == 0 ? nil : $0 })
  }
}
