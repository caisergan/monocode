import CoreGraphics
import Foundation
import MonoDesign
@testable import MonoTranscript
import MonoWire
import Testing

private func fixture(_ name: String) throws -> Data {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try Data(contentsOf: url)
}

/// The Swift row builder against the Expo app's `buildRows`, run by
/// gen-fixtures.mjs over edge cases, demo sessions and markdown (16 §16.5).
@Suite struct BuilderTests {
  struct Case: Decodable, Sendable {
    struct Options: Decodable, Sendable {
      var live: Bool
      var cwd: String?
      var open: [String]
      var sending: [Int]
      var hasOlder: Bool
      var loadingOlder: Bool
      var canBuild: Bool
    }
    var name: String
    var blocks: [Block]
    var options: Options
    var rows: [RowSpec]
  }

  static let cases: [Case] = {
    struct Root: Decodable { var cases: [Case] }
    return (try? JSONDecoder().decode(Root.self, from: fixture("builder")).cases) ?? []
  }()

  @Test func everyCaseDecodes() {
    #expect(Self.cases.count == 48)
  }

  @Test(arguments: cases.map(\.name))
  func rowsMatchTypeScript(_ name: String) throws {
    let item = try #require(Self.cases.first { $0.name == name })
    var options = RowOptions()
    options.live = item.options.live
    options.cwd = item.options.cwd
    options.open = Set(item.options.open)
    options.sending = Set(item.options.sending)
    options.hasOlder = item.options.hasOlder
    options.loadingOlder = item.options.loadingOlder
    options.canBuild = item.options.canBuild
    options.timeZone = TimeZone(identifier: "UTC")!
    let builder = RowBuilder()
    let rows = builder.rows(item.blocks, options)
    #expect(rows.map(\.id) == item.rows.map(\.id))
    for (swift, typescript) in zip(rows, item.rows) where swift != typescript {
      Issue.record("\(name), \(swift.id): \(swift) against \(typescript)")
      break
    }
    // A second build from the caches gives the same rows.
    #expect(builder.rows(item.blocks, options) == rows)
  }

  @Test func versionsHashLikeTheTypeScript() {
    #expect(Markdown.hash("") == 5381)
    #expect(Markdown.hash("abc") == 193_485_963)
    #expect(Markdown.hash("Ünïcödé 🚀", seed: 7) == Markdown.hash("Ünïcödé 🚀", seed: 7))
    #expect(JSON.string("a\"b\\\n😀\u{1}") == #""a\"b\\\n😀\u0001""#)
  }
}

@Suite struct DiffTests {
  struct Case: Decodable, Sendable {
    var name: String
    var before: [RowSpec]
    var after: [RowSpec]
    var ops: [TranscriptOp]
  }

  @Test func opsMatchTypeScript() throws {
    struct Root: Decodable { var cases: [Case] }
    let cases = try JSONDecoder().decode(Root.self, from: fixture("diff")).cases
    #expect(cases.count == 15)
    for item in cases {
      #expect(RowDiff.ops(item.before, item.after) == item.ops, "\(item.name)")
    }
  }
}

@Suite struct ThemeTests {
  /// The Swift theme resolves to the same colours and styles as the
  /// TypeScript `transcriptTheme()` it ports.
  @Test(arguments: [(true, TranscriptFixture.themeDark), (false, TranscriptFixture.themeLight)])
  func themeMatchesTypeScript(_ dark: Bool, _ fixture: TranscriptFixture) throws {
    let expected = try fixture.theme()
    let made = ThemeSpec.make(Tokens.palette(dark: dark))
    func rgba(_ css: String) -> [Int] {
      guard let color = TranscriptTheme.parseColor(css), let c = color.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components else { return [] }
      return c.map { Int(($0 * 255).rounded()) }
    }
    #expect(rgba(made.background) == rgba(expected.background))
    #expect(Set(made.colors.keys) == Set(expected.colors.keys))
    for (name, css) in expected.colors { #expect(rgba(made.colors[name] ?? "") == rgba(css), "\(name)") }
    #expect(Set(made.styles.keys) == Set(expected.styles.keys))
    for (name, style) in expected.styles {
      let mine = try #require(made.styles[name])
      #expect(mine.size == style.size && mine.line == style.line, "\(name)")
      #expect((mine.weight ?? "400") == (style.weight ?? "400") && (mine.mono ?? false) == (style.mono ?? false) && (mine.italic ?? false) == (style.italic ?? false), "\(name)")
      #expect(rgba(mine.color) == rgba(style.color), "\(name)")
    }
  }
}
