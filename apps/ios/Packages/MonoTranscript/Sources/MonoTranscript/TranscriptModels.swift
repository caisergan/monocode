import CoreGraphics
import CoreText
import UIKit

/// A resolved text style: the CTFont, colour and fixed line height.
/// Immutable after init, so it crosses queues freely.
final class TextStyle: @unchecked Sendable {
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
/// Immutable after init, so it crosses queues freely.
final class TranscriptTheme: @unchecked Sendable {
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

  static func parse(_ spec: ThemeSpec, revision: Int) -> TranscriptTheme {
    let scale = CGFloat(spec.scale)
    var colors: [String: CGColor] = [:]
    for (name, value) in spec.colors {
      if let color = parseColor(value) { colors[name] = color }
    }
    var styles: [String: TextStyle] = [:]
    for (name, value) in spec.styles {
      styles[name] = TextStyle(
        font: font(size: CGFloat(value.size) * scale, weight: value.weight ?? "400", mono: value.mono ?? false, italic: value.italic ?? false),
        color: parseColor(value.color) ?? UIColor.label.cgColor, lineHeight: CGFloat(value.line) * scale)
    }
    if styles["prose"] == nil { styles["prose"] = fallback.styles["prose"] }
    return TranscriptTheme(revision: revision, background: parseColor(spec.background) ?? UIColor.black.cgColor,
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
