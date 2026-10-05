@testable import MonoDesign
import Testing

// The generated values against the ones 11 §11.2–11.6 and the desktop name.
@Suite struct TokensTests {
  @Test func darkPaletteAtTheDefaultTint() {
    let dark = Tokens.dark
    #expect(dark.base.hex == "#171717")
    #expect(dark.content.hex == "#ebebeb")
    #expect(dark.text.prose == dark.contentAlpha(0.78))
    #expect(dark.border.default == dark.contentAlpha(0.1))
    #expect(dark.fill.bubble == dark.contentAlpha(0.1))
    #expect(dark.primary.hex == "#ffffff")
    #expect(dark.status.attention.hex == "#fbbf24")
  }

  @Test func lightPaletteAtTheDefaultTint() {
    let light = Tokens.light
    #expect(light.base.hex == "#f7f7f7")
    #expect(light.primaryText == light.base)
    #expect(light.status.danger.hex == "#ef4444")
  }

  @Test func accentIsTheDesktopsHSL() {
    #expect(Tokens.accentHSL == (211, 92, 62))
    #expect(Tokens.dark.accent.hex == "#459bf7")
    #expect(Tokens.dark.status.working == Tokens.dark.accent)
  }

  @Test func typeRadiiAndMotion() {
    #expect(Tokens.TypeScale.prose == TypeRole(size: 16, line: 25))
    #expect(Tokens.TypeScale.code == TypeRole(size: 13, line: 19))
    #expect(Tokens.Radius.md == 8)
    #expect(Tokens.Radius.block == 10)
    #expect(Tokens.Motion.easeOut == CubicBezier(0.22, 1, 0.36, 1))
    #expect(Tokens.Motion.foldMs == 340)
  }

  @Test func projectColorsStartNeutral() {
    #expect(Tokens.projectColors.count == 9)
    #expect(Tokens.projectColors[1] == Tokens.dark.accent)
  }
}

@Test func mascotsAndProjectColoursHashLikeTheDesktop() {
  #expect(Mascots.all.count == 10)
  #expect(Mascots.all.allSatisfy { $0.rest.count == 8 && $0.talk.count == 8 && $0.rest.allSatisfy { $0.count == 8 } })
  for sample in Mascots.samples {
    #expect(Mascots.forProject(sample.id).name == sample.mascot, "\(sample.id)")
    #expect(Tokens.projectColorIndex(sample.id) == sample.colorIndex, "\(sample.id)")
  }
}
