import Foundation

/// The transcript fixtures `scripts/gen-fixtures.mjs` writes from the Expo
/// app's TypeScript, for the Lab and the tests (15 §15.6).
public enum TranscriptFixture: String, CaseIterable, Sendable {
  /// 120 settled turns (`big`).
  case rows120 = "rows-120"
  /// 1,000 settled turns (`huge`).
  case rows1000 = "rows-1000"
  /// The dark theme object for `setTheme(_:)`.
  case themeDark = "theme-dark"
  /// A live turn streamed on top of `rows1000`.
  case stream

  public var url: URL {
    guard let url = Bundle.module.url(forResource: rawValue, withExtension: "json", subdirectory: "Fixtures") else {
      fatalError("missing fixture \(rawValue).json; run scripts/gen-fixtures.mjs")
    }
    return url
  }

  public func text() throws -> String {
    try String(contentsOf: url, encoding: .utf8)
  }

  /// A `reset` op for a rows fixture, ready for `apply(_:)`.
  public func resetOps() throws -> String {
    #"[{"op":"reset","rows":"# + (try text()) + "}]"
  }
}

/// The recorded stream: one batch of ops per 60 Hz frame, replayed by time so
/// it runs at 90 chars/s whatever the display rate.
public struct StreamRecording: Sendable {
  public struct Frame: Sendable {
    /// Milliseconds since the stream started.
    public let t: Double
    /// Characters of the reply streamed so far.
    public let chars: Int
    /// The frame's ops, as JSON for `apply(_:)`.
    public let ops: String
  }

  public let frames: [Frame]
  public let charsPerSecond: Double
  /// The rows after the last frame that are not in the base, as JSON.
  public let finalRows: String
  /// The base row the recording inserts after.
  public let anchor: String?

  public var duration: Double { frames.last?.t ?? 0 }

  public static func load() throws -> StreamRecording {
    let data = try Data(contentsOf: TranscriptFixture.stream.url)
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let frames = root["frames"] as? [[String: Any]] else {
      throw CocoaError(.fileReadCorruptFile)
    }
    let json = { (value: Any) throws -> String in
      String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }
    return StreamRecording(
      frames: try frames.map { frame in
        Frame(t: (frame["t"] as? NSNumber)?.doubleValue ?? 0,
              chars: (frame["chars"] as? NSNumber)?.intValue ?? 0,
              ops: try json(frame["ops"] ?? []))
      },
      charsPerSecond: (root["charsPerSecond"] as? NSNumber)?.doubleValue ?? 90,
      finalRows: try json(root["finalRows"] ?? []),
      anchor: (root["baseRowsTouched"] as? [String])?.first)
  }
}
