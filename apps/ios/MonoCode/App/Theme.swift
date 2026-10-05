import MonoDesign
import SwiftUI

/// The palette for the current colour scheme (11 §11.2), resolved at the
/// default tint. Views read `@Environment(\.palette)`.
extension EnvironmentValues {
  @Entry var palette: Palette = Tokens.dark
}

/// The theme setting (11 §11.2: System, Dark or Light; Dark by default).
/// R1 has no Appearance page yet; `-MCTheme light|dark|system` picks it.
enum ThemeSetting: String {
  case system, dark, light

  static var current: ThemeSetting {
    UserDefaults.standard.string(forKey: "MCTheme").flatMap(ThemeSetting.init(rawValue:)) ?? .dark
  }

  var scheme: ColorScheme? {
    switch self {
    case .system: nil
    case .dark: .dark
    case .light: .light
    }
  }
}

/// Puts the palette for the effective colour scheme into the environment
/// and tints the chrome with `accent`.
struct MonoTheme: ViewModifier {
  @Environment(\.colorScheme) private var scheme

  func body(content: Content) -> some View {
    let palette = Tokens.palette(dark: scheme == .dark)
    content
      .environment(\.palette, palette)
      .tint(palette.accent.color)
  }
}

extension Font {
  /// A type role from the mobile scale (11 §11.3).
  static func mono(_ role: TypeRole, _ weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
    .system(size: role.size, weight: weight, design: design)
  }
}

extension View {
  /// Text in a type role, with its fixed line height (11 §11.3).
  func type(_ role: TypeRole, _ weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
    font(.mono(role, weight, design: design))
      .lineSpacing(max(0, role.line - role.size * 1.2))
  }

  /// The screen background (`bg.base`).
  func screenBackground() -> some View {
    modifier(ScreenBackground())
  }
}

private struct ScreenBackground: ViewModifier {
  @Environment(\.palette) private var palette

  func body(content: Content) -> some View {
    content.background(palette.base.color.ignoresSafeArea())
  }
}
