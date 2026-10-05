import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

extension MonoColor {
  public var color: Color {
    Color(.sRGB, red: red / 255, green: green / 255, blue: blue / 255, opacity: alpha)
  }

  public var cgColor: CGColor {
    CGColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
  }

  #if canImport(UIKit)
  public var uiColor: UIColor {
    UIColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
  }
  #endif
}

extension CubicBezier {
  /// The curve as a SwiftUI animation (16 §16.6.10).
  public func animation(milliseconds: Double) -> Animation {
    .timingCurve(x1, y1, x2, y2, duration: milliseconds / 1000)
  }

  public var mediaTimingFunction: CAMediaTimingFunction {
    CAMediaTimingFunction(controlPoints: Float(x1), Float(y1), Float(x2), Float(y2))
  }
}
