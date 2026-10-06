import Foundation

/// The transcript fixtures `scripts/gen-fixtures.mjs` writes from the Expo
/// app's TypeScript, for the Lab and the tests (15 §15.6).
public enum TranscriptFixture: String, CaseIterable, Sendable {
  /// 120 settled turns (`big`).
  case rows120 = "rows-120"
  /// 1,000 settled turns (`huge`).
  case rows1000 = "rows-1000"
  /// The dark and light themes `transcriptTheme()` made, for parity tests.
  case themeDark = "theme-dark"
  case themeLight = "theme-light"
  /// A live turn streamed on top of `rows1000`.
  case stream

  public var url: URL {
    guard let url = Bundle.module.url(forResource: rawValue, withExtension: "json", subdirectory: "Fixtures") else {
      fatalError("missing fixture \(rawValue).json; run scripts/gen-fixtures.mjs")
    }
    return url
  }

  /// The rows of a rows fixture.
  public func rows() throws -> [RowSpec] {
    try JSONDecoder().decode([RowSpec].self, from: Data(contentsOf: url))
  }

  /// The theme of a theme fixture.
  public func theme() throws -> ThemeSpec {
    try JSONDecoder().decode(ThemeSpec.self, from: Data(contentsOf: url))
  }
}

/// The recorded stream: one batch of ops per 60 Hz frame, replayed by time so
/// it runs at 90 chars/s whatever the display rate.
public struct StreamRecording: Sendable, Decodable {
  public struct Frame: Sendable, Decodable {
    /// Milliseconds since the stream started.
    public let t: Double
    /// Characters of the reply streamed so far.
    public let chars: Int
    /// The frame's ops.
    public let ops: [TranscriptOp]
  }

  public let frames: [Frame]
  public let charsPerSecond: Double
  /// The rows after the last frame that are not in the base.
  public let finalRows: [RowSpec]
  let baseRowsTouched: [String]

  /// The base row the recording inserts after.
  public var anchor: String? { baseRowsTouched.first }
  public var duration: Double { frames.last?.t ?? 0 }

  public static func load() throws -> StreamRecording {
    try JSONDecoder().decode(StreamRecording.self, from: Data(contentsOf: TranscriptFixture.stream.url))
  }
}
