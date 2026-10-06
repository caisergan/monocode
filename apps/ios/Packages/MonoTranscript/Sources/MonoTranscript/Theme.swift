import MonoDesign

extension ThemeSpec {
  /// The transcript theme for a palette: the Expo app's `transcriptTheme()`
  /// (src/ui/theme.ts), colour for colour and style for style.
  public static func make(_ t: Palette, scale: Double = 1) -> ThemeSpec {
    typealias T = Tokens.TypeScale
    func text(_ role: TypeRole, _ color: MonoColor, weight: String? = nil, mono: Bool? = nil, italic: Bool? = nil) -> TextStyleSpec {
      TextStyleSpec(size: role.size, line: role.line, color: color.css, weight: weight, mono: mono, italic: italic)
    }
    return ThemeSpec(
      background: t.base.css,
      scale: scale,
      colors: [
        "bubble": t.fill.bubble.css,
        "code": t.fill.code.css,
        "chip": t.fill.chip.css,
        "fileChip": t.fill.code.css,
        "border": t.border.default.css,
        "borderDashed": t.border.dashed.css,
        "rail": t.contentAlpha(0.14).css,
        "rule": t.border.default.css,
        "tableDivider": t.border.subtle.css,
        "chevron": t.contentAlpha(0.45).css,
        "quoteBar": t.contentAlpha(0.2).css,
        "primary": t.primary.css,
        "danger": t.status.danger.css,
        "attention": t.status.attention.css,
      ],
      styles: [
        "prose": text(T.prose, t.text.prose),
        "strong": text(T.prose, t.content, weight: "600"),
        "em": text(T.prose, t.content, italic: true),
        "code": text(T.code, t.contentAlpha(0.85), mono: true),
        "inlineCode": TextStyleSpec(size: 13.5, line: T.prose.line, color: t.contentAlpha(0.9).css, mono: true),
        "link": text(T.prose, t.link),
        "h1": text(T.h1, t.content, weight: "600"),
        "h2": text(T.h2, t.content, weight: "600"),
        "h3": text(T.h3, t.content, weight: "600"),
        "h4": text(T.h4, t.content, weight: "600"),
        "marker": text(T.prose, t.text.secondary),
        "user": text(T.prose, t.contentAlpha(0.9)),
        "reasoning": text(T.prose, t.text.reasoning),
        "fold": text(T.prose, t.text.secondary),
        "trailVerb": text(T.prose, t.text.secondary),
        "trailTarget": text(T.toolChip, t.contentAlpha(0.7), mono: true),
        "trailFailed": text(T.prose, t.status.danger),
        "notice": text(T.toolChip, t.text.secondary, mono: true),
        "meta": text(T.secondary, t.text.faint),
        "codeLabel": text(T.secondary, t.contentAlpha(0.65), weight: "500", mono: true),
        "approvalTitle": text(T.row, t.contentAlpha(0.9), weight: "500"),
        "buttonLabel": text(T.row, t.contentAlpha(0.85), weight: "500"),
        "primaryLabel": text(T.row, t.primaryText, weight: "500"),
        "dangerLabel": text(T.row, MonoColor(252, 165, 165), weight: "500"),
        // The desktop's own markdown styles (index.css `.agent-markdown`),
        // beyond the Expo app's theme: struck text, quotes at prose colour,
        // and table cells at 13 / 18 (cells 12 px on the desktop).
        "del": text(T.prose, t.text.prose),
        // List markers take the item's colour, as `::marker` does.
        "listMarker": text(T.prose, t.text.prose),
        "quote": text(T.prose, t.text.prose, italic: true),
        "tableCell": text(T.secondary, t.contentAlpha(0.85)),
        "tableHeader": text(T.secondary, t.content, weight: "600"),
      ])
  }
}

extension MonoColor {
  /// "rgba(r,g,b,a)", the form `parseColor` reads.
  var css: String {
    "rgba(\(Int(red.rounded())),\(Int(green.rounded())),\(Int(blue.rounded())),\(alpha))"
  }
}
