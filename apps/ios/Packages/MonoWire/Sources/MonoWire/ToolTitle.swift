import Foundation

// Tool kinds and row titles (src/integrations/harness/core/preview.ts): the
// predicates and `composeToolTitle`, which the transcript's grouping uses.

public enum ToolKinds {
  private static let editTitle = JSRegex("^(edit|write|delete|update)\\b", "i")
  private static let readTitle = JSRegex("^read\\b", "i")
  private static let searchTitle = JSRegex("^(find|search|grep|glob)\\b", "i")
  private static let executeTitle = JSRegex("^(bash|shell|run(?:ning)?(?:\\s+command)?)\\b", "i")
  private static let skillTitle = JSRegex("^skill\\b", "i")
  private static let agentTitle = JSRegex("^(agent|task|subagent)\\b", "i")

  private static func key(_ kind: String?) -> String { kind?.jsTrim.lowercased() ?? "" }
  private static func trimmed(_ title: String?) -> String { title?.jsTrim ?? "" }

  public static func isEdit(_ kind: String?, _ title: String?, _ preview: ToolPreview?) -> Bool {
    if preview?.kind == .write { return true }
    let k = key(kind)
    if ["edit", "write", "delete", "move"].contains(k) { return true }
    if !k.isEmpty && k != "other" { return false }
    return editTitle.test(trimmed(title))
  }

  public static func isRead(_ kind: String?, _ title: String?, _ preview: ToolPreview?) -> Bool {
    if preview?.kind == .read { return true }
    let k = key(kind)
    if k == "read" { return true }
    if !k.isEmpty && k != "other" { return false }
    return readTitle.test(trimmed(title))
  }

  public static func isSearch(_ kind: String?, _ title: String?, _ preview: ToolPreview?) -> Bool {
    if preview?.kind == .search { return true }
    let k = key(kind)
    if k == "search" { return true }
    if !k.isEmpty && k != "other" { return false }
    return searchTitle.test(trimmed(title))
  }

  public static func isExecute(_ kind: String?, _ title: String?) -> Bool {
    let k = key(kind)
    if k == "execute" || k == "shell" || k == "bash" { return true }
    if !k.isEmpty && k != "other" { return false }
    return executeTitle.test(trimmed(title))
  }

  public static func isSkill(_ kind: String?, _ title: String?) -> Bool {
    let k = key(kind)
    if k == "skill" || k == "skills" { return true }
    if !k.isEmpty && k != "other" { return false }
    return skillTitle.test(trimmed(title))
  }

  public static func isAgent(_ kind: String?, _ title: String?) -> Bool {
    let k = key(kind)
    if k == "agent" || k == "task" || k == "subagent" { return true }
    if !k.isEmpty && k != "other" { return false }
    return agentTitle.test(trimmed(title))
  }

  private static let weak = JSRegex(
    "^(tool|shell|bash|execute|command|skill|read|edit|search|find|grep|glob|fetch|other|write|delete|move|think|run|list|working|reading|editing|searching|writing|running|listing|fetching|thinking|deleting|moving|mcp:\\s*tool|read file|edit file|write file|run command|ran command|unnamed)$",
    "i")

  public static func isWeakTitle(_ value: String) -> Bool {
    weak.test(value.jsTrim)
  }

  private static let agentPrefix = JSRegex("^(agent|task|subagent)\\b\\s*", "i")
  private static let skillPrefix = JSRegex("^skill\\b\\s*", "i")
  private static let otherAction = JSRegex("^(list|write|edit|run|delete|move|fetch)\\s+\\S", "i")
  private static let readPrefix = JSRegex("^read(?:ing)?(?:\\s+file)?\\b\\s*", "i")
  private static let searchPrefix = JSRegex("^(?:find|search|grep|glob)(?:ing)?\\b\\s*", "i")
  private static let executePrefix = JSRegex("^(?:bash|shell|execute)\\s*[:\\-]\\s+", "i")

  private static func formatSkillName(_ value: String?) -> String {
    let text = JSRegex("^/+").replace(value?.jsTrim ?? "", "")
    return text.isEmpty ? "" : "/\(text)"
  }

  private static func firstLine(_ value: String?) -> String {
    let text = value?.jsTrim ?? ""
    if text.isEmpty { return "" }
    return JSRegex("\\r?\\n").split(text).first?.jsTrim ?? ""
  }

  /// `composeToolTitle`: the row's label from the tool's kind, title and preview.
  public static func composeTitle(
    kind: String?, title: String?, path: String?, query: String?, command: String? = nil, skill: String? = nil,
    previewKind: ToolPreviewKind?, cwd: String?
  ) -> String {
    let kind = key(kind)
    let title = trimmed(title)
    let path = nonEmpty(path?.jsTrim)
    let query = nonEmpty(query?.jsTrim)
    let command = nonEmpty(command?.jsTrim)
    let skill = formatSkillName(skill)

    if isAgent(kind, title) {
      let rest = agentPrefix.replace(title, "").jsTrim
      if !rest.isEmpty && !isWeakTitle(rest) { return rest }
      return "Subagent"
    }

    if isSkill(kind, title)
      || (!skill.isEmpty && !isExecute(kind, title) && !isRead(kind, title, nil) && !isSearch(kind, title, nil)
        && !isEdit(kind, title, nil))
    {
      if !skill.isEmpty { return "Skill \(skill)" }
      let rest = skillPrefix.replace(title, "").jsTrim
      if !rest.isEmpty && !isWeakTitle(rest) { return "Skill \(nonEmpty(formatSkillName(rest)) ?? rest)" }
      return "Skill"
    }

    if previewKind == .shell || isExecute(kind, title) {
      if let rewritten = Shell.rewriteReadableTitle(title, path: path, query: query) { return rewritten }
      let script = Shell.unwrap(command ?? executePrefix.replace(title, "").jsTrim)
      if let inferred = Shell.inferIntent(script) {
        let inferredPath = path ?? inferred.path.map { Paths.displayPath($0, cwd: cwd) }
        if let readable = Shell.format(inferred, path: inferredPath, query: query) { return readable }
      }
      if command != nil { return firstLine(script) }
      let rest = firstLine(script)
      if !rest.isEmpty && !isWeakTitle(rest) { return rest }
      if !title.isEmpty && !isWeakTitle(title) { return title }
      return "Shell"
    }

    if path == nil && otherAction.test(title) { return title }

    if previewKind == .read || isRead(kind, title, nil) {
      if let path { return "Read \(path)" }
      let rest = readPrefix.replace(title, "").jsTrim
      if !rest.isEmpty && !isWeakTitle(rest) { return "Read \(rest)" }
      return "Read"
    }

    if previewKind == .search || isSearch(kind, title, nil) {
      let q = query ?? searchPrefix.replace(title, "").jsTrim
      if !q.isEmpty && !isWeakTitle(q) { return "Find \(q)" }
      return "Find"
    }

    return title
  }
}
