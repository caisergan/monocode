import Foundation

// Visual-only: turn a shell command into Read / Find / List / Edit / Write when
// the intent is obvious (src/integrations/harness/core/shellIntent.ts).

public struct ShellIntent: Equatable, Sendable {
  public var verb: String
  public var path: String?
  public var query: String?
  public var startLine: Int?
}

/// UTF-16 code units, so indices match the TypeScript's.
private struct U16 {
  let units: [UInt16]
  init(_ text: String) { units = Array(text.utf16) }
  var count: Int { units.count }
  subscript(i: Int) -> UInt16 { i >= 0 && i < units.count ? units[i] : 0 }
  func slice(_ from: Int, _ to: Int? = nil) -> String {
    let end = min(to ?? units.count, units.count)
    guard end > from else { return "" }
    return String(decoding: units[max(0, from)..<end], as: UTF16.self)
  }
  func startsWith(_ text: String, at: Int) -> Bool {
    let p = Array(text.utf16)
    guard at + p.count <= units.count else { return false }
    return Array(units[at..<(at + p.count)]) == p
  }
}

private let quote1 = UInt16(UInt8(ascii: "'"))
private let quote2 = UInt16(UInt8(ascii: "\""))
private let backslash = UInt16(UInt8(ascii: "\\"))
private let backtick = UInt16(UInt8(ascii: "`"))
private let dollar = UInt16(UInt8(ascii: "$"))
private let gt = UInt16(UInt8(ascii: ">"))
private let space = UInt16(UInt8(ascii: " "))
private let tab = UInt16(UInt8(ascii: "\t"))
private let amp = UInt16(UInt8(ascii: "&"))
private let pipe = UInt16(UInt8(ascii: "|"))
private let newline = UInt16(UInt8(ascii: "\n"))
private let cr = UInt16(UInt8(ascii: "\r"))
private let semicolon = UInt16(UInt8(ascii: ";"))
private let hash = UInt16(UInt8(ascii: "#"))
private let openParen = UInt16(UInt8(ascii: "("))
private let openBrace = UInt16(UInt8(ascii: "{"))

private func isSeparator(_ c: UInt16) -> Bool {
  // /[ \t|&;<>()]/
  [space, tab, pipe, amp, semicolon, UInt16(UInt8(ascii: "<")), gt, openParen, UInt16(UInt8(ascii: ")"))].contains(c)
}

public enum Shell {
  static let maxCommandChars = 2000
  private static let readableBin = JSRegex(
    "\\b(?:cat|bat|batcat|nl|less|more|tac|head|tail|sed|grep|egrep|fgrep|rgrep|rg|ag|ack|find|ls|tree|tee)\\b")
  private static let alreadyLabelled = JSRegex("^(Read|Find|List|Edit|Write)\\s+\\S")

  /// The label for a shell command, or nil when it should stay as typed.
  public static func inferIntent(_ command: String) -> ShellIntent? {
    let text = unwrap(command)
    if text.isEmpty || text.jsLength > maxCommandChars { return nil }
    if alreadyLabelled.test(text) { return nil }
    if looksUnsafe(text) { return nil }
    let write = extractWriteRedirect(text)
    if !readableBin.test(text) && write == nil { return nil }

    var intents: [ShellIntent] = []
    for chain in splitTopLevel(text, chainSeparator) {
      var pipeIntent: ShellIntent?
      for stage in splitTopLevel(chain, pipeSeparator) {
        guard let tokens = tokenize(stage), !tokens.isEmpty else { return nil }
        switch classify(tokens.map(\.value)) {
        case .opaque: return nil
        case .noise: continue
        case let .intent(intent): pipeIntent = intent
        }
      }
      if let pipeIntent { intents.append(pipeIntent) }
    }
    if let write {
      return ShellIntent(verb: write.append ? "Edit" : "Write", path: write.path)
    }
    if intents.isEmpty { return nil }
    let ranked = Array(intents.reversed())
    return ranked.first { $0.verb == "Edit" || $0.verb == "Write" } ?? ranked.first { $0.verb == "Read" || $0.verb == "Find" }
      ?? ranked[0]
  }

  private struct Wrapper {
    let executables: Set<String>
    let commandFlag: JSRegex
    let optionBoundary: JSRegex?
    let consumeRemainder: Bool
  }

  private static let wrappers = [
    Wrapper(executables: ["sh", "bash", "zsh", "dash", "ksh"], commandFlag: JSRegex("^(?:--command|-[a-z]*c[a-z]*)$", "i"), optionBoundary: nil, consumeRemainder: false),
    Wrapper(executables: ["powershell", "powershell.exe", "pwsh", "pwsh.exe"], commandFlag: JSRegex("^-(?:command|c)$", "i"), optionBoundary: JSRegex("^-(?:file|f)$", "i"), consumeRemainder: true),
    Wrapper(executables: ["cmd", "cmd.exe"], commandFlag: JSRegex("^/c$", "i"), optionBoundary: nil, consumeRemainder: true),
  ]

  /// The script a shell launcher was given (`/bin/zsh -lc "cat package.json"`).
  public static func unwrap(_ command: String) -> String {
    var current = command.jsTrim
    for _ in 0..<2 {
      guard let tokens = tokenize(current), tokens.count >= 3 else { break }
      let u = U16(current)
      let first = tokens[0]
      let raw = u.slice(first.start, first.end)
      let q = u[first.start]
      let rawU = U16(raw)
      let executable = (q == quote2 || q == quote1) && rawU[0] == rawU[rawU.count - 1] ? rawU.slice(1, rawU.count - 1) : raw
      guard let wrapper = wrappers.first(where: { $0.executables.contains(binName(executable)) }) else { break }
      var flagIndex = -1
      for index in 1..<tokens.count {
        if let boundary = wrapper.optionBoundary, boundary.test(tokens[index].value) { break }
        if wrapper.commandFlag.test(tokens[index].value) {
          flagIndex = index
          break
        }
      }
      guard flagIndex >= 0, flagIndex + 1 < tokens.count else { break }
      let commandToken = tokens[flagIndex + 1]
      let remainder = u.slice(commandToken.start).jsTrim
      let cq = u[commandToken.start]
      let sole = (cq == quote2 || cq == quote1) && u[commandToken.end - 1] == cq && tokens.count == flagIndex + 2
      let script = wrapper.consumeRemainder && !sole ? remainder : commandToken.value.jsTrim
      if script.isEmpty || script == current { break }
      current = script
    }
    return current
  }

  public static func format(_ intent: ShellIntent, path: String?, query: String?) -> String? {
    if intent.verb == "Find" {
      guard let q = nonEmpty(query) ?? intent.query else { return nil }
      return "Find \(q)"
    }
    guard let target = nonEmpty(path) ?? intent.path else { return nil }
    return "\(intent.verb) \(target)"
  }

  private static let readableTitle = JSRegex("^(Read|Find|List|Edit|Write)\\s+(.+)$", "i")

  /// Re-apply a stored Read/Find/List/Edit title.
  public static func rewriteReadableTitle(_ title: String, path: String?, query: String?) -> String? {
    guard let m = readableTitle.match(title), let word = m[1], let rest = m[2] else { return nil }
    let verb = word.jsSlice(0, 1).uppercased() + word.jsSlice(1).lowercased()
    if verb == "Find" { return "Find \(nonEmpty(query) ?? rest)" }
    return "\(verb) \(nonEmpty(path) ?? rest)"
  }

  private enum Classified {
    case intent(ShellIntent)
    case noise
    case opaque
  }

  private static let noiseBins: Set<String> = ["cd", "echo", "printf", "pwd", "true", "false", "clear", ":", "wc", "sleep", "export", "unset", "alias", "wait"]
  private static let readBins: Set<String> = ["cat", "bat", "batcat", "nl", "less", "more", "tac"]
  private static let searchBins: Set<String> = ["grep", "egrep", "fgrep", "rgrep", "rg", "ag", "ack"]
  private static let grepValueFlags: Set<String> = [
    "-e", "--regexp", "-f", "--file", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-m",
    "--max-count", "-d", "--directories", "-D", "--devices", "--include", "--exclude", "--exclude-dir", "-g", "--glob",
    "-t", "--type", "-j", "--threads", "--max-filesize", "--max-depth", "--max-columns",
  ]
  private static let findValueFlags: Set<String> = [
    "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-type", "-mtime", "-mmin",
    "-ctime", "-cmin", "-atime", "-amin", "-size", "-maxdepth", "-mindepth", "-user", "-group", "-perm", "-exec",
    "-execdir", "-ok", "-printf",
  ]

  private static func classify(_ argv: [String]) -> Classified {
    let bin = binName(argv[0])
    if noiseBins.contains(bin) { return .noise }
    if readBins.contains(bin) { return readIntent(argv) }
    if bin == "head" || bin == "tail" { return headTailIntent(argv) }
    if bin == "sed" { return sedIntent(argv) }
    if bin == "tee" { return teeIntent(argv) }
    if bin == "rg" && argv.contains("--files") { return .intent(ShellIntent(verb: "Find", query: "files")) }
    if searchBins.contains(bin) { return grepIntent(argv) }
    if bin == "find" { return findIntent(argv) }
    if bin == "ls" || bin == "tree" { return listIntent(argv) }
    return .opaque
  }

  private static func readIntent(_ argv: [String]) -> Classified {
    guard let path = lastFile(positionalArgs(argv, [])) else { return .noise }
    return .intent(ShellIntent(verb: "Read", path: path))
  }

  private static let dashNumber = JSRegex("^-\\d+$")

  private static func headTailIntent(_ argv: [String]) -> Classified {
    var files: [String] = []
    var i = 1
    while i < argv.count {
      let arg = argv[i]
      if arg == "--" {
        files.append(contentsOf: argv[(i + 1)...])
        break
      }
      if dashNumber.test(arg) || arg == "-n" || arg == "-c" || arg == "-q" || arg == "-v" {
        if arg == "-n" || arg == "-c" { i += 1 }
        i += 1
        continue
      }
      if arg.hasPrefix("-n") || arg == "--lines" || arg == "--bytes" {
        if arg == "--lines" || arg == "--bytes" { i += 1 }
        i += 1
        continue
      }
      if arg.hasPrefix("-") && arg != "-" {
        i += 1
        continue
      }
      files.append(arg)
      i += 1
    }
    guard let path = lastFile(files) else { return .noise }
    return .intent(ShellIntent(verb: "Read", path: path))
  }

  private static func sedIntent(_ argv: [String]) -> Classified {
    if argv.contains(where: isSedInPlace) {
      guard let path = lastSourceFile(Array(argv.dropFirst())) else { return .opaque }
      return .intent(ShellIntent(verb: "Edit", path: path))
    }
    var script: String?
    var files: [String] = []
    var i = 1
    while i < argv.count {
      let arg = argv[i]
      if arg == "--" {
        files.append(contentsOf: argv[(i + 1)...])
        break
      }
      if arg == "-e" || arg == "--expression" {
        script = i + 1 < argv.count ? argv[i + 1] : nil
        i += 2
        continue
      }
      if arg == "-f" || arg == "--file" { return .opaque }
      if ["-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-l", "--line-length"].contains(arg) {
        i += 1
        continue
      }
      if arg.hasPrefix("-") && arg != "-" {
        i += 1
        continue
      }
      if (script ?? "").isEmpty { script = arg } else { files.append(arg) }
      i += 1
    }
    guard let path = lastFile(files) else { return .noise }
    return .intent(ShellIntent(verb: "Read", path: path, startLine: sedStartLine(script)))
  }

  private static func teeIntent(_ argv: [String]) -> Classified {
    let append = argv.contains("-a") || argv.contains("--append")
    guard let path = lastFile(positionalArgs(argv, [])) else { return .opaque }
    return .intent(ShellIntent(verb: append ? "Edit" : "Write", path: path))
  }

  private static func grepIntent(_ argv: [String]) -> Classified {
    var query: String?
    var files: [String] = []
    var i = 1
    while i < argv.count {
      let arg = argv[i]
      if arg == "--" {
        let rest = Array(argv[(i + 1)...])
        if (query ?? "").isEmpty, let first = rest.first, !first.isEmpty {
          query = first
          files.append(contentsOf: rest.dropFirst())
        } else {
          files.append(contentsOf: rest)
        }
        break
      }
      if arg == "-e" || arg == "--regexp" {
        query = i + 1 < argv.count ? argv[i + 1] : nil
        i += 2
        continue
      }
      if grepValueFlags.contains(arg) {
        i += 2
        continue
      }
      if arg.hasPrefix("-") && arg != "-" {
        if arg.hasPrefix("-e") && arg.jsLength > 2 { query = arg.jsSlice(2) }
        i += 1
        continue
      }
      if (query ?? "").isEmpty { query = arg } else { files.append(arg) }
      i += 1
    }
    guard let query, !query.isEmpty else { return .opaque }
    return .intent(ShellIntent(verb: "Find", path: lastFile(files), query: query))
  }

  private static func findIntent(_ argv: [String]) -> Classified {
    var query: String?
    var path: String?
    var i = 1
    while i < argv.count {
      let arg = argv[i]
      if ["-name", "-iname", "-path", "-ipath"].contains(arg) {
        query = i + 1 < argv.count ? argv[i + 1] : nil
        i += 2
        continue
      }
      if arg.hasPrefix("-") {
        if findValueFlags.contains(arg) { i += 1 }
        i += 1
        continue
      }
      if path == nil { path = tidyPath(arg) }
      i += 1
    }
    guard let query, !query.isEmpty else { return .opaque }
    return .intent(ShellIntent(verb: "Find", path: path, query: query))
  }

  private static func listIntent(_ argv: [String]) -> Classified {
    guard let path = lastFile(positionalArgs(argv, ["--ignore", "-I", "--hide"])) else { return .noise }
    return .intent(ShellIntent(verb: "List", path: path))
  }

  private static func positionalArgs(_ argv: [String], _ valueFlags: Set<String>) -> [String] {
    var out: [String] = []
    var i = 1
    while i < argv.count {
      let arg = argv[i]
      if arg == "--" {
        out.append(contentsOf: argv[(i + 1)...])
        break
      }
      if arg.hasPrefix("-") && arg != "-" {
        if valueFlags.contains(arg) { i += 1 }
        i += 1
        continue
      }
      out.append(arg)
      i += 1
    }
    return out
  }

  private static func lastFile(_ files: [String]) -> String? {
    for file in files.reversed() {
      if let path = tidyPath(file) { return path }
    }
    return nil
  }

  private static func lastSourceFile(_ args: [String]) -> String? {
    for arg in args.reversed() {
      if arg.isEmpty || arg == "-" || (arg.hasPrefix("-") && arg != "-") { continue }
      if isSedScript(arg) { continue }
      if let path = tidyPath(arg) { return path }
    }
    return nil
  }

  private static let sedAddress = JSRegex("^\\d+(,\\d+)?[spd]$")
  private static let sedSubstitute = JSRegex("^s([^A-Za-z0-9]).+\\1")

  private static func isSedScript(_ value: String) -> Bool {
    sedAddress.test(value) || sedSubstitute.test(value)
  }

  private static let digits = JSRegex("^\\d+$")

  private static func tidyPath(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value != "-", value != "/dev/stdin", value != "/dev/stdout" else { return nil }
    if value.contains(">") || value.contains("<") { return nil }
    let trimmed = JSRegex("/+$").replace(value.replacingOccurrences(of: "\\", with: "/"), "")
    if trimmed.isEmpty || trimmed == "." || trimmed == "./" || trimmed == "/dev/null" { return nil }
    if digits.test(trimmed) { return nil }
    return trimmed
  }

  static func binName(_ token: String) -> String {
    let base = token.replacingOccurrences(of: "\\", with: "/").jsSplit("/").last ?? token
    return base.lowercased()
  }

  private static func isSedInPlace(_ arg: String) -> Bool {
    arg == "--in-place" || arg == "-i" || arg.hasPrefix("-i") || arg.hasPrefix("--in-place=")
  }

  private static let sedPrint = JSRegex("^(\\d+)(?:,\\d+)?p$")

  private static func sedStartLine(_ script: String?) -> Int? {
    guard let script, let m = sedPrint.match(script), let digits = m[1], let line = Int(digits) else { return nil }
    return line > 0 ? line : nil
  }

  /// Walks `text` outside quotes and escapes, as the TypeScript's loops do;
  /// `visit` sees each unquoted unit and may skip ahead by returning an index.
  private static func scanUnquoted(_ u: U16, _ visit: (Int) -> Int?) -> UInt16? {
    var q: UInt16?
    var i = 0
    while i < u.count {
      let c = u[i]
      if let open = q {
        if open == quote2 && c == backslash && i + 1 < u.count {
          i += 2
          continue
        }
        if c == open { q = nil }
        i += 1
        continue
      }
      if c == quote1 || c == quote2 {
        q = c
        i += 1
        continue
      }
      if c == backslash && i + 1 < u.count {
        i += 2
        continue
      }
      if let next = visit(i) {
        i = next
        continue
      }
      i += 1
    }
    return q
  }

  private static func looksUnsafe(_ command: String) -> Bool {
    let u = U16(command)
    var unsafe = false
    let open = scanUnquoted(u) { i in
      let c = u[i]
      if c == backtick || (c == dollar && (u[i + 1] == openParen || u[i + 1] == openBrace)) {
        unsafe = true
        return u.count
      }
      return nil
    }
    return unsafe || open != nil
  }

  private static func extractWriteRedirect(_ command: String) -> (path: String, append: Bool)? {
    let u = U16(command)
    var found: (path: String, append: Bool)?
    _ = scanUnquoted(u) { i in
      guard u[i] == gt else { return nil }
      var append = false
      var j = i + 1
      if u[j] == gt {
        append = true
        j += 1
      }
      while u[j] == space || u[j] == tab { j += 1 }
      if u[j] == amp { return nil }
      let target = readUnquotedToken(u, j)
      if target == "/dev/null" || target == "-" { return nil }
      if let path = tidyPath(target) { found = (path, append) }
      return max(i, j + max(target.jsLength, 1) - 1) + 1
    }
    return found
  }

  private static func readUnquotedToken(_ u: U16, _ start: Int) -> String {
    var i = start
    // /[\s|&;<>]/
    while i < u.count {
      let c = u[i]
      if c == space || c == tab || c == newline || c == cr || c == 0x0B || c == 0x0C || c == pipe || c == amp
        || c == semicolon || c == UInt16(UInt8(ascii: "<")) || c == gt
      {
        break
      }
      i += 1
    }
    return u.slice(start, i)
  }

  private static func chainSeparator(_ u: U16, _ i: Int) -> Int {
    if u.startsWith("&&", at: i) || u.startsWith("||", at: i) { return 2 }
    if u.startsWith("\r\n", at: i) { return 2 }
    if u[i] == newline || u[i] == cr { return 1 }
    if u[i] == semicolon { return 1 }
    return 0
  }

  private static func pipeSeparator(_ u: U16, _ i: Int) -> Int {
    u[i] == pipe && u[i + 1] != pipe ? 1 : 0
  }

  private static func splitTopLevel(_ command: String, _ separator: (U16, Int) -> Int) -> [String] {
    let u = U16(command)
    var parts: [String] = []
    var start = 0
    _ = scanUnquoted(u) { i in
      let length = separator(u, i)
      guard length > 0 else { return nil }
      let part = u.slice(start, i).jsTrim
      if !part.isEmpty { parts.append(part) }
      start = i + length
      return start
    }
    let tail = u.slice(start).jsTrim
    if !tail.isEmpty { parts.append(tail) }
    return parts
  }

  struct Token {
    var value: String
    var start: Int
    var end: Int
  }

  static func tokenize(_ stage: String) -> [Token]? {
    let u = U16(stage)
    var tokens: [Token] = []
    var i = 0
    while i < u.count {
      while i < u.count && isSeparator(u[i]) { i += 1 }
      if i >= u.count { break }
      if u[i] == hash { break }
      let start = i
      var token: [UInt16] = []
      while i < u.count && !isSeparator(u[i]) {
        let c = u[i]
        if c == quote1 {
          var end = i + 1
          while end < u.count && u[end] != quote1 { end += 1 }
          if end >= u.count { return nil }
          token.append(contentsOf: u.units[(i + 1)..<end])
          i = end + 1
          continue
        }
        if c == quote2 {
          i += 1
          while i < u.count && u[i] != quote2 {
            if u[i] == backslash && i + 1 < u.count {
              token.append(u[i + 1])
              i += 2
              continue
            }
            token.append(u[i])
            i += 1
          }
          if i >= u.count { return nil }
          i += 1
          continue
        }
        if c == backslash && i + 1 < u.count {
          token.append(u[i + 1])
          i += 2
          continue
        }
        token.append(c)
        i += 1
      }
      if !token.isEmpty { tokens.append(Token(value: String(decoding: token, as: UTF16.self), start: start, end: i)) }
      if i <= start { i += 1 }
    }
    return tokens
  }
}

func nonEmpty(_ value: String?) -> String? {
  guard let value, !value.isEmpty else { return nil }
  return value
}
