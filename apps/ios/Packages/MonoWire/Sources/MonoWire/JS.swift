import Foundation

// The ported TypeScript counts, slices and matches strings the way JavaScript
// does: in UTF-16 code units, with JavaScript's regular expressions. These
// helpers keep the Swift ports' output identical to the TypeScript goldens.

/// A JavaScript regular expression on ICU (NSRegularExpression). `\w` and
/// `\d` are narrowed to ASCII, as in JavaScript. Flags: `i`, `m`, `g`.
public struct JSRegex: @unchecked Sendable {
  let regex: NSRegularExpression
  let global: Bool

  public init(_ pattern: String, _ flags: String = "") {
    var options: NSRegularExpression.Options = []
    if flags.contains("i") { options.insert(.caseInsensitive) }
    if flags.contains("m") { options.insert(.anchorsMatchLines) }
    let ascii = pattern
      .replacingOccurrences(of: #"\w"#, with: "[A-Za-z0-9_]")
      .replacingOccurrences(of: #"\W"#, with: "[^A-Za-z0-9_]")
      .replacingOccurrences(of: #"\d"#, with: "[0-9]")
    do {
      regex = try NSRegularExpression(pattern: ascii, options: options)
    } catch {
      preconditionFailure("bad pattern \(pattern): \(error)")
    }
    global = flags.contains("g")
  }

  public func test(_ text: String) -> Bool {
    regex.firstMatch(in: text, range: NSRange(location: 0, length: text.utf16.count)) != nil
  }

  /// `text.match(regex)` without the `g` flag: the whole match, then each
  /// group (nil when it did not take part).
  public func match(_ text: String) -> [String?]? {
    let ns = text as NSString
    guard let m = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
    return (0..<m.numberOfRanges).map { i in
      let range = m.range(at: i)
      return range.location == NSNotFound ? nil : ns.substring(with: range)
    }
  }

  /// The UTF-16 offset of the first match.
  public func index(in text: String) -> Int? {
    regex.firstMatch(in: text, range: NSRange(location: 0, length: text.utf16.count))?.range.location
  }

  /// `text.replace(regex, template)`: every match with `g`, else the first.
  /// The template uses `$1`, as in JavaScript.
  public func replace(_ text: String, _ template: String) -> String {
    let range = NSRange(location: 0, length: text.utf16.count)
    if global {
      return regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
    }
    guard let m = regex.firstMatch(in: text, range: range) else { return text }
    let replacement = regex.replacementString(for: m, in: text, offset: 0, template: template)
    return (text as NSString).replacingCharacters(in: m.range, with: replacement)
  }

  /// `text.split(regex)`.
  public func split(_ text: String) -> [String] {
    let ns = text as NSString
    var parts: [String] = []
    var start = 0
    for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      if m.range.length == 0 && m.range.location == start { continue }
      parts.append(ns.substring(with: NSRange(location: start, length: m.range.location - start)))
      start = m.range.location + m.range.length
    }
    parts.append(ns.substring(from: start))
    return parts
  }
}

extension String {
  /// `text.length`.
  @inlinable public var jsLength: Int { utf16.count }

  /// `text.slice(start, end)`, with negative offsets from the end.
  public func jsSlice(_ start: Int, _ end: Int? = nil) -> String {
    let length = utf16.count
    func clamp(_ value: Int) -> Int { value < 0 ? max(0, length + value) : min(value, length) }
    let from = clamp(start)
    let to = clamp(end ?? length)
    guard to > from else { return "" }
    return (self as NSString).substring(with: NSRange(location: from, length: to - from))
  }

  /// `text[i]` as a one-unit string ("" past the end).
  public func jsChar(_ index: Int) -> String {
    guard index >= 0, index < utf16.count else { return "" }
    return (self as NSString).substring(with: NSRange(location: index, length: 1))
  }

  /// `text.charCodeAt(i)`.
  public func jsCode(_ index: Int) -> UInt16 {
    (self as NSString).character(at: index)
  }

  /// `text.trim()`.
  public var jsTrim: String { trimmingCharacters(in: .whitespacesAndNewlines) }

  /// `text.indexOf(search, from)`, or -1.
  public func jsIndexOf(_ search: String, _ from: Int = 0) -> Int {
    let ns = self as NSString
    guard from <= ns.length else { return -1 }
    let range = ns.range(of: search, options: .literal, range: NSRange(location: from, length: ns.length - from))
    return range.location == NSNotFound ? -1 : range.location
  }

  public func jsLastIndexOf(_ search: String) -> Int {
    let range = (self as NSString).range(of: search, options: [.literal, .backwards])
    return range.location == NSNotFound ? -1 : range.location
  }

  public func jsStartsWith(_ prefix: String, _ at: Int) -> Bool {
    jsSlice(at, at + prefix.jsLength) == prefix
  }

  /// `text.split(separator)` for a literal separator.
  public func jsSplit(_ separator: String) -> [String] {
    components(separatedBy: separator)
  }
}
