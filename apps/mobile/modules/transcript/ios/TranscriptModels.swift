import CoreGraphics
import CoreText
import UIKit

// Row specifications sent from JavaScript (src/spec.ts). Parsed with
// JSONSerialization on the layout queue; Codable is several times slower for
// a 1,000-turn reset.

struct TextRun {
  let text: String
  let style: String
  let link: String?
  /// 1 = inline code chip, 2 = file chip.
  let chip: Int

  init(text: String, style: String, link: String? = nil, chip: Int = 0) {
    self.text = text
    self.style = style
    self.link = link
    self.chip = chip
  }

  init?(_ value: Any) {
    guard let dict = value as? [String: Any], let text = dict["t"] as? String else { return nil }
    self.text = text
    self.style = dict["s"] as? String ?? "prose"
    self.link = dict["link"] as? String
    self.chip = dict["chip"] as? Int ?? 0
  }

  static func list(_ value: Any?) -> [TextRun] {
    (value as? [Any])?.compactMap(TextRun.init) ?? []
  }
}

struct ActionSpec {
  let id: String
  let label: String
  let variant: String
}

struct RowSpec {
  let id: String
  let version: Int
  let kind: String
  let runs: [TextRun]
  let sub: [TextRun]
  let lines: [[TextRun]]
  let label: String?
  let first: Bool
  let last: Bool
  let marker: String?
  let depth: Int
  let quote: Bool
  let status: String?
  let open: Bool
  let actions: [ActionSpec]
  let pulse: Bool
  let gap: CGFloat
  let height: CGFloat
  let a11y: String?

  init?(_ value: Any) {
    guard let d = value as? [String: Any], let id = d["id"] as? String, let kind = d["k"] as? String
    else { return nil }
    self.id = id
    version = d["v"] as? Int ?? 0
    self.kind = kind
    runs = TextRun.list(d["runs"])
    sub = TextRun.list(d["sub"])
    lines = (d["lines"] as? [Any])?.map { TextRun.list($0) } ?? []
    label = d["label"] as? String
    first = d["first"] as? Bool ?? true
    last = d["last"] as? Bool ?? true
    marker = d["marker"] as? String
    depth = d["depth"] as? Int ?? 0
    quote = d["quote"] as? Bool ?? false
    status = d["status"] as? String
    open = d["open"] as? Bool ?? false
    actions = (d["actions"] as? [[String: Any]])?.compactMap { action in
      guard let id = action["id"] as? String, let label = action["label"] as? String else { return nil }
      return ActionSpec(id: id, label: label, variant: action["variant"] as? String ?? "secondary")
    } ?? []
    pulse = (d["anim"] as? [String: Any])?["pulse"] as? Bool ?? false
    gap = CGFloat((d["gap"] as? NSNumber)?.doubleValue ?? 0)
    height = CGFloat((d["h"] as? NSNumber)?.doubleValue ?? 0)
    a11y = d["a11y"] as? String
  }
}

/// A resolved text style: the CTFont, colour and fixed line height.
final class TextStyle {
  let font: CTFont
  let color: CGColor
  let lineHeight: CGFloat

  init(font: CTFont, color: CGColor, lineHeight: CGFloat) {
    self.font = font
    self.color = color
    self.lineHeight = lineHeight
  }
}

/// Colours and text styles from @monocode/design, sent once with setTheme.
final class TranscriptTheme {
  let revision: Int
  let background: CGColor
  let colors: [String: CGColor]
  let styles: [String: TextStyle]
  let scale: CGFloat

  init(revision: Int, background: CGColor, colors: [String: CGColor], styles: [String: TextStyle], scale: CGFloat) {
    self.revision = revision
    self.background = background
    self.colors = colors
    self.styles = styles
    self.scale = scale
  }

  func color(_ name: String) -> CGColor {
    colors[name] ?? UIColor.gray.cgColor
  }

  func style(_ name: String) -> TextStyle {
    styles[name] ?? styles["prose"] ?? TranscriptTheme.fallback.styles["prose"]!
  }

  static func parseColor(_ value: Any?) -> CGColor? {
    guard let text = value as? String else { return nil }
    // "#rrggbb", "#rrggbbaa" or "rgba(r,g,b,a)"
    if text.hasPrefix("#") {
      let hex = String(text.dropFirst())
      guard let int = UInt64(hex, radix: 16) else { return nil }
      if hex.count == 6 {
        return CGColor(srgbRed: CGFloat((int >> 16) & 0xff) / 255, green: CGFloat((int >> 8) & 0xff) / 255,
                       blue: CGFloat(int & 0xff) / 255, alpha: 1)
      }
      if hex.count == 8 {
        return CGColor(srgbRed: CGFloat((int >> 24) & 0xff) / 255, green: CGFloat((int >> 16) & 0xff) / 255,
                       blue: CGFloat((int >> 8) & 0xff) / 255, alpha: CGFloat(int & 0xff) / 255)
      }
      return nil
    }
    if text.hasPrefix("rgba(") || text.hasPrefix("rgb(") {
      let inner = text.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }
      let parts = inner.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
      guard parts.count >= 3 else { return nil }
      return CGColor(srgbRed: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255,
                     alpha: parts.count > 3 ? parts[3] : 1)
    }
    return nil
  }

  static func font(size: CGFloat, weight: String, mono: Bool, italic: Bool) -> CTFont {
    let uiWeight: UIFont.Weight = weight == "600" ? .semibold : weight == "500" ? .medium : weight == "700" ? .bold : .regular
    var font = mono ? UIFont.monospacedSystemFont(ofSize: size, weight: uiWeight) : UIFont.systemFont(ofSize: size, weight: uiWeight)
    if italic, let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
      font = UIFont(descriptor: descriptor, size: size)
    }
    return font as CTFont
  }

  static func parse(_ json: [String: Any], revision: Int) -> TranscriptTheme {
    let scale = CGFloat((json["scale"] as? NSNumber)?.doubleValue ?? 1)
    var colors: [String: CGColor] = [:]
    for (name, value) in json["colors"] as? [String: Any] ?? [:] {
      if let color = parseColor(value) { colors[name] = color }
    }
    var styles: [String: TextStyle] = [:]
    for (name, value) in json["styles"] as? [String: [String: Any]] ?? [:] {
      let size = CGFloat((value["size"] as? NSNumber)?.doubleValue ?? 16) * scale
      let line = CGFloat((value["line"] as? NSNumber)?.doubleValue ?? 25) * scale
      let weight = value["weight"] as? String ?? "400"
      let mono = value["mono"] as? Bool ?? false
      let italic = value["italic"] as? Bool ?? false
      let color = parseColor(value["color"]) ?? UIColor.label.cgColor
      styles[name] = TextStyle(font: font(size: size, weight: weight, mono: mono, italic: italic), color: color, lineHeight: line)
    }
    if styles["prose"] == nil { styles["prose"] = fallback.styles["prose"] }
    return TranscriptTheme(revision: revision, background: parseColor(json["background"]) ?? UIColor.black.cgColor,
                           colors: colors, styles: styles, scale: scale)
  }

  static let fallback: TranscriptTheme = {
    let content = CGColor(srgbRed: 0.92, green: 0.92, blue: 0.92, alpha: 0.78)
    return TranscriptTheme(
      revision: 0,
      background: CGColor(srgbRed: 0.09, green: 0.09, blue: 0.09, alpha: 1),
      colors: [:],
      styles: ["prose": TextStyle(font: font(size: 16, weight: "400", mono: false, italic: false), color: content, lineHeight: 25)],
      scale: 1)
  }()
}
