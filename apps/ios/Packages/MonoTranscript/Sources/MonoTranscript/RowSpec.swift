import Foundation

// The row contract between the row builder and the transcript (15 §15.4):
// Swift values passed in process, no serialisation. Rows carry style ids,
// never colours; colours come with the theme. The JSON shape stays the Expo
// app's spec.ts, so the golden fixtures from its TypeScript decode into the
// same values; absent fields decode to the defaults the view assumes.

/// A styled run of text.
public struct TextRun: Hashable, Sendable, Codable {
  public var text: String
  /// A style id from the theme: prose, strong, inlineCode, trailVerb, …
  public var style: String
  public var link: String?
  /// 1 = inline code chip, 2 = file chip, 0 = none.
  public var chip: Int

  public init(text: String, style: String, link: String? = nil, chip: Int = 0) {
    self.text = text
    self.style = style
    self.link = link
    self.chip = chip
  }

  enum CodingKeys: String, CodingKey { case t, s, link, chip }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    text = try c.decode(String.self, forKey: .t)
    style = try c.decodeIfPresent(String.self, forKey: .s) ?? "prose"
    link = try c.decodeIfPresent(String.self, forKey: .link)
    chip = try c.decodeIfPresent(Int.self, forKey: .chip) ?? 0
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(text, forKey: .t)
    try c.encode(style, forKey: .s)
    try c.encodeIfPresent(link, forKey: .link)
    if chip != 0 { try c.encode(chip, forKey: .chip) }
  }
}

/// A button in a row: Allow, Deny, Build, or a whole-row action.
public struct ActionSpec: Hashable, Sendable, Codable {
  public var id: String
  public var label: String
  /// "primary", "secondary" or "danger".
  public var variant: String

  public init(id: String, label: String, variant: String = "secondary") {
    self.id = id
    self.label = label
    self.variant = variant
  }

  enum CodingKeys: String, CodingKey { case id, label, variant }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    label = try c.decode(String.self, forKey: .label)
    variant = try c.decodeIfPresent(String.self, forKey: .variant) ?? "secondary"
  }
}

/// One transcript row (15 §15.4).
public struct RowSpec: Hashable, Sendable, Codable, Identifiable {
  /// Stable: the block id, `blockId#n` for markdown blocks, synthetic ids
  /// for folds, footers and the like.
  public var id: String
  /// Bumps on any change; the view re-measures only changed rows.
  public var version: Int
  /// markdown, userBubble, codeBlock, trailRow, thinkingRow, foldLine,
  /// approvalControls, notice, turnFooter, loadOlder, spacer.
  public var kind: String
  public var runs: [TextRun] = []
  public var sub: [TextRun] = []
  /// Code or preview lines, one run list per line.
  public var lines: [[TextRun]] = []
  public var label: String?
  /// Code blocks are cut into chunks; only the first has the header.
  public var first = true
  public var last = true
  public var marker: String?
  public var depth = 0
  public var quote = false
  public var status: String?
  public var open = false
  public var actions: [ActionSpec] = []
  public var pulse = false
  /// Space above the row, in points.
  public var gap: Double = 0
  /// Spacer height.
  public var height: Double = 0
  public var a11y: String?

  public init(id: String, version: Int, kind: String) {
    self.id = id
    self.version = version
    self.kind = kind
  }

  enum CodingKeys: String, CodingKey {
    case id, v, k, runs, sub, lines, label, first, last, marker, depth, quote, status, open, actions, anim, gap, h, a11y
  }

  struct Anim: Codable {
    var pulse: Bool?
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    version = try c.decodeIfPresent(Int.self, forKey: .v) ?? 0
    kind = try c.decode(String.self, forKey: .k)
    runs = try c.decodeIfPresent([TextRun].self, forKey: .runs) ?? []
    sub = try c.decodeIfPresent([TextRun].self, forKey: .sub) ?? []
    lines = try c.decodeIfPresent([[TextRun]].self, forKey: .lines) ?? []
    label = try c.decodeIfPresent(String.self, forKey: .label)
    first = try c.decodeIfPresent(Bool.self, forKey: .first) ?? true
    last = try c.decodeIfPresent(Bool.self, forKey: .last) ?? true
    marker = try c.decodeIfPresent(String.self, forKey: .marker)
    depth = try c.decodeIfPresent(Int.self, forKey: .depth) ?? 0
    quote = try c.decodeIfPresent(Bool.self, forKey: .quote) ?? false
    status = try c.decodeIfPresent(String.self, forKey: .status)
    open = try c.decodeIfPresent(Bool.self, forKey: .open) ?? false
    actions = try c.decodeIfPresent([ActionSpec].self, forKey: .actions) ?? []
    pulse = try c.decodeIfPresent(Anim.self, forKey: .anim)?.pulse ?? false
    gap = try c.decodeIfPresent(Double.self, forKey: .gap) ?? 0
    height = try c.decodeIfPresent(Double.self, forKey: .h) ?? 0
    a11y = try c.decodeIfPresent(String.self, forKey: .a11y)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(version, forKey: .v)
    try c.encode(kind, forKey: .k)
    if !runs.isEmpty { try c.encode(runs, forKey: .runs) }
    if !sub.isEmpty { try c.encode(sub, forKey: .sub) }
    if !lines.isEmpty { try c.encode(lines, forKey: .lines) }
    try c.encodeIfPresent(label, forKey: .label)
    if !first { try c.encode(first, forKey: .first) }
    if !last { try c.encode(last, forKey: .last) }
    try c.encodeIfPresent(marker, forKey: .marker)
    if depth != 0 { try c.encode(depth, forKey: .depth) }
    if quote { try c.encode(quote, forKey: .quote) }
    try c.encodeIfPresent(status, forKey: .status)
    if open { try c.encode(open, forKey: .open) }
    if !actions.isEmpty { try c.encode(actions, forKey: .actions) }
    if pulse { try c.encode(Anim(pulse: true), forKey: .anim) }
    if gap != 0 { try c.encode(gap, forKey: .gap) }
    if height != 0 { try c.encode(height, forKey: .h) }
    try c.encodeIfPresent(a11y, forKey: .a11y)
  }
}

/// A change to the transcript's rows, applied in a batch per display frame.
public enum TranscriptOp: Hashable, Sendable, Codable {
  case reset([RowSpec])
  /// `after` nil inserts at the top.
  case insert(after: String?, [RowSpec])
  case append([RowSpec])
  case update([RowSpec])
  case remove([String])

  enum CodingKeys: String, CodingKey { case op, rows, after, ids }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decode(String.self, forKey: .op) {
    case "reset": self = .reset(try c.decode([RowSpec].self, forKey: .rows))
    case "insert": self = .insert(after: try c.decodeIfPresent(String.self, forKey: .after), try c.decode([RowSpec].self, forKey: .rows))
    case "append": self = .append(try c.decode([RowSpec].self, forKey: .rows))
    case "update": self = .update(try c.decode([RowSpec].self, forKey: .rows))
    case "remove": self = .remove(try c.decode([String].self, forKey: .ids))
    case let op: throw DecodingError.dataCorruptedError(forKey: .op, in: c, debugDescription: "Unknown op \(op)")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .reset(rows):
      try c.encode("reset", forKey: .op)
      try c.encode(rows, forKey: .rows)
    case let .insert(after, rows):
      try c.encode("insert", forKey: .op)
      if let after { try c.encode(after, forKey: .after) } else { try c.encodeNil(forKey: .after) }
      try c.encode(rows, forKey: .rows)
    case let .append(rows):
      try c.encode("append", forKey: .op)
      try c.encode(rows, forKey: .rows)
    case let .update(rows):
      try c.encode("update", forKey: .op)
      try c.encode(rows, forKey: .rows)
    case let .remove(ids):
      try c.encode("remove", forKey: .op)
      try c.encode(ids, forKey: .ids)
    }
  }
}

/// A text style in the theme: size and line height in points, weight, mono,
/// italic and a CSS colour ("#rrggbb", "#rrggbbaa" or "rgba(…)").
public struct TextStyleSpec: Hashable, Sendable, Codable {
  public var size: Double
  public var line: Double
  public var weight: String?
  public var mono: Bool?
  public var italic: Bool?
  public var color: String

  public init(size: Double, line: Double, color: String, weight: String? = nil, mono: Bool? = nil, italic: Bool? = nil) {
    self.size = size
    self.line = line
    self.color = color
    self.weight = weight
    self.mono = mono
    self.italic = italic
  }
}

/// Colours and text styles for the transcript, sent once with `setTheme`.
public struct ThemeSpec: Hashable, Sendable, Codable {
  public var background: String
  public var scale: Double
  public var colors: [String: String]
  public var styles: [String: TextStyleSpec]

  public init(background: String, scale: Double = 1, colors: [String: String], styles: [String: TextStyleSpec]) {
    self.background = background
    self.scale = scale
    self.colors = colors
    self.styles = styles
  }
}
