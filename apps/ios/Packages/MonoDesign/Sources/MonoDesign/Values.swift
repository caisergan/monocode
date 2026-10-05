import Foundation

/// An sRGB colour with straight alpha. Components are 0...255, alpha 0...1,
/// as @monocode/design writes them.
public struct MonoColor: Sendable, Hashable {
  public let red: Double
  public let green: Double
  public let blue: Double
  public let alpha: Double

  public init(_ red: Double, _ green: Double, _ blue: Double, _ alpha: Double = 1) {
    self.red = red
    self.green = green
    self.blue = blue
    self.alpha = alpha
  }

  /// The same colour at another alpha (the palette's `contentAlpha`).
  public func opacity(_ alpha: Double) -> MonoColor {
    MonoColor(red, green, blue, alpha)
  }

  /// "#rrggbb", or "#rrggbbaa" when not opaque.
  public var hex: String {
    let channels = [red, green, blue].map { String(format: "%02x", Int($0.rounded())) }.joined()
    return alpha >= 1 ? "#\(channels)" : "#\(channels)\(String(format: "%02x", Int((alpha * 255).rounded())))"
  }
}

/// A font size and its fixed line height, in points.
public struct TypeRole: Sendable, Hashable {
  public let size: Double
  public let line: Double

  public init(size: Double, line: Double) {
    self.size = size
    self.line = line
  }
}

/// A CSS `cubic-bezier()` timing curve.
public struct CubicBezier: Sendable, Hashable {
  public let x1: Double
  public let y1: Double
  public let x2: Double
  public let y2: Double

  public init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
    self.x1 = x1
    self.y1 = y1
    self.x2 = x2
    self.y2 = y2
  }
}

/// A user-adjustable tint value with its range and default.
public struct TintRange: Sendable, Hashable {
  public let min: Double
  public let max: Double
  public let `default`: Double

  public init(min: Double, max: Double, default value: Double) {
    self.min = min
    self.max = max
    self.default = value
  }
}

extension Palette {
  /// Content at an alpha: every other colour in the palette is one of these.
  public func contentAlpha(_ alpha: Double) -> MonoColor {
    content.opacity(alpha)
  }
}

extension Tokens {
  public static func palette(dark: Bool) -> Palette {
    dark ? Tokens.dark : Tokens.light
  }
}
