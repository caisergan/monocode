/// A string enumeration from the wire that stays open (16 §16.5): a value this
/// app doesn't know decodes, compares unequal to every known case, re-encodes
/// unchanged, and reports `isKnown == false`. Switch over it with `case .user:`
/// and a `default:`, which is where an unknown value lands.
public struct Open<Tag: OpenTag>: RawRepresentable, Hashable, Sendable, Codable, ExpressibleByStringLiteral,
  CustomStringConvertible
{
  public let rawValue: String

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public init(stringLiteral value: String) {
    rawValue = value
  }

  public init(from decoder: any Decoder) throws {
    rawValue = try decoder.singleValueContainer().decode(String.self)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  /// False for a value a newer host sent that this app has no case for.
  public var isKnown: Bool { Tag.known.contains(rawValue) }

  public var description: String { rawValue }
}

public protocol OpenTag: Sendable {
  static var known: Set<String> { get }
}

public enum BlockRoleTag: OpenTag {
  public static let known: Set<String> = [
    "user", "assistant", "image", "reasoning", "tool", "approval", "tasks", "plan", "system", "handoff",
  ]
}

public typealias BlockRole = Open<BlockRoleTag>

extension Open where Tag == BlockRoleTag {
  public static var user: Self { "user" }
  public static var assistant: Self { "assistant" }
  public static var image: Self { "image" }
  public static var reasoning: Self { "reasoning" }
  public static var tool: Self { "tool" }
  public static var approval: Self { "approval" }
  public static var tasks: Self { "tasks" }
  public static var plan: Self { "plan" }
  public static var system: Self { "system" }
  public static var handoff: Self { "handoff" }
}

public enum SessionStatusTag: OpenTag {
  public static let known: Set<String> = ["idle", "running", "interrupted"]
}

/// `HostSession.status`.
public typealias SessionStatus = Open<SessionStatusTag>

extension Open where Tag == SessionStatusTag {
  public static var idle: Self { "idle" }
  public static var running: Self { "running" }
  public static var interrupted: Self { "interrupted" }
}

public enum RuntimeModeTag: OpenTag {
  public static let known: Set<String> = ["supervised", "auto-accept-edits", "auto", "full-access"]
}

public typealias RuntimeMode = Open<RuntimeModeTag>

extension Open where Tag == RuntimeModeTag {
  public static var supervised: Self { "supervised" }
  public static var autoAcceptEdits: Self { "auto-accept-edits" }
  public static var auto: Self { "auto" }
  public static var fullAccess: Self { "full-access" }
}

public enum TurnOutcomeTag: OpenTag {
  public static let known: Set<String> = ["finished", "failed", "interrupted", "cancelled"]
}

public typealias TurnOutcome = Open<TurnOutcomeTag>

extension Open where Tag == TurnOutcomeTag {
  public static var finished: Self { "finished" }
  public static var failed: Self { "failed" }
  public static var interrupted: Self { "interrupted" }
  public static var cancelled: Self { "cancelled" }
}

public enum AttentionTag: OpenTag {
  public static let known: Set<String> = ["approval", "question", "error", "interrupted", "usage_limit", "finished"]
}

/// `InboxItem.attention` without its `null` (which is `nil`).
public typealias AttentionKind = Open<AttentionTag>

extension Open where Tag == AttentionTag {
  public static var approval: Self { "approval" }
  public static var question: Self { "question" }
  public static var error: Self { "error" }
  public static var interrupted: Self { "interrupted" }
  public static var usageLimit: Self { "usage_limit" }
  public static var finished: Self { "finished" }
}

public enum PreviewKindTag: OpenTag {
  public static let known: Set<String> = ["read", "write", "shell", "search"]
}

public typealias ToolPreviewKind = Open<PreviewKindTag>

extension Open where Tag == PreviewKindTag {
  public static var read: Self { "read" }
  public static var write: Self { "write" }
  public static var shell: Self { "shell" }
  public static var search: Self { "search" }
}
