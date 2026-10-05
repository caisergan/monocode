import Foundation

// Wire shapes added for phones (packages/core/src/wire.ts, 06 §6.5 to §6.7).

/// `InboxItem.attention`: a kind, or `null` on the wire (`nil` here), which
/// re-encodes as `null`.
public struct Attention: Codable, Hashable, Sendable {
  public var kind: AttentionKind?

  public init(_ kind: AttentionKind?) {
    self.kind = kind
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    kind = container.decodeNil() ? nil : try container.decode(AttentionKind.self)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    if let kind { try container.encode(kind) } else { try container.encodeNil() }
  }

  public var needsInput: Bool { kind == .approval || kind == .question }
}

public struct InboxItem: Codable, Hashable, Sendable, Identifiable {
  public var sessionId: String
  public var projectId: String
  public var projectName: String
  public var title: String
  public var harness: String
  public var model: String?
  public var runtimeMode: RuntimeMode?
  public var status: SessionStatus
  public var runId: String?
  public var attention: Attention
  public var needsInput: Bool
  public var approval: ApprovalSummary?
  public var question: QuestionSummary?
  public var lastText: String?
  public var updatedAt: Int
  public var finishedAt: Int?
  public var branch: String?
  public var worktreeCwd: String?
  public var pinned: Bool?
  public var archived: Bool?
  public var revision: Int
  public var queueLength: Int?

  public var id: String { sessionId }

  public struct ApprovalSummary: Codable, Hashable, Sendable {
    public var requestId: Int
    public var title: String
    public var kind: String?
    public var preview: ToolPreview?
  }

  public struct QuestionSummary: Codable, Hashable, Sendable {
    public var requestId: Int
    public var title: String?
    public var count: Int
    public var autoResolveAt: Int?
  }
}

/// `inbox.list`.
public struct InboxList: Codable, Hashable, Sendable {
  public var boot: String
  public var revision: Int
  public var items: [InboxItem]
  public var truncated: Bool

  public init(boot: String, revision: Int, items: [InboxItem], truncated: Bool = false) {
    self.boot = boot
    self.revision = revision
    self.items = items
    self.truncated = truncated
  }
}

/// A `sessions.page` item: `HostSessionSummary` plus the phone's fields.
public struct SessionListItem: Codable, Hashable, Sendable, Identifiable {
  public var projectId: String
  public var revision: Int
  public var runId: String?
  public var status: SessionStatus
  public var createdAt: Int?
  public var updatedAt: Int
  public var archived: Bool?
  public var pinned: Bool?
  public var autoWorktreeBranch: String?
  public var id: String
  public var title: String
  public var harness: String
  public var cwd: String?
  public var model: String?
  public var runtimeMode: RuntimeMode?
  public var providerSessionId: String?
  public var linkedWorkItem: LinkedWorkItem?
  public var needsInput: Bool?
  public var branch: String?
  public var worktreeCwd: String?
  public var repo: String?
  public var draft: Bool?
  public var lastText: String?
  public var finishedAt: Int?
  public var queueLength: Int?
  public var lastTurnOutcome: TurnOutcome?
}

/// `sessions.page` params and result.
public struct SessionPage: Codable, Hashable, Sendable {
  public var items: [SessionListItem]
  public var cursor: String?

  public init(items: [SessionListItem], cursor: String? = nil) {
    self.items = items
    self.cursor = cursor
  }
}

public enum ArchivedFilter: String, Codable, Sendable {
  case exclude, only, include
}

public struct SessionPageParams: Codable, Hashable, Sendable {
  public var projectId: String
  public var archived: ArchivedFilter?
  public var limit: Int?
  public var cursor: String?

  public init(projectId: String, archived: ArchivedFilter? = nil, limit: Int? = nil, cursor: String? = nil) {
    self.projectId = projectId
    self.archived = archived
    self.limit = limit
    self.cursor = cursor
  }
}

/// The blocks from an anchor block to the end.
public struct SyncWindow: Codable, Hashable, Sendable {
  public var anchor: String?
  public var tailTurns: Int?

  public init(anchor: String? = nil, tailTurns: Int? = nil) {
    self.anchor = anchor
    self.tailTurns = tailTurns
  }
}

public struct WindowMeta: Codable, Hashable, Sendable {
  /// The window's first block; `null` on the wire for an empty session.
  public var anchor: String?
  public var olderTurns: Int
  public var olderBlocks: Int

  public init(anchor: String?, olderTurns: Int, olderBlocks: Int) {
    self.anchor = anchor
    self.olderTurns = olderTurns
    self.olderBlocks = olderBlocks
  }

  enum CodingKeys: String, CodingKey { case anchor, olderTurns, olderBlocks }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    if let anchor { try c.encode(anchor, forKey: .anchor) } else { try c.encodeNil(forKey: .anchor) }
    try c.encode(olderTurns, forKey: .olderTurns)
    try c.encode(olderBlocks, forKey: .olderBlocks)
  }
}

/// `sessions.sync` with a window (06 §6.7), and `evt session.sync`'s `sync`.
public enum SessionSync: Codable, Hashable, Sendable {
  case unchanged(revision: Int, window: WindowMeta?)
  case snapshot(HostSession, window: WindowMeta?)
  /// `value.session.blocks` is empty: `blockIds` is the window's list, and
  /// `blocks` holds the ones that changed.
  case delta(base: Int, value: HostSession, blockIds: [String], blocks: [Block], window: WindowMeta?)
  /// A sync too large for one response, read with `sessions.syncChunk`.
  case chunked(transfer: String, length: Int)

  enum CodingKeys: String, CodingKey { case kind, revision, window, value, base, blockIds, blocks, transfer, length }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let window = try c.decodeIfPresent(WindowMeta.self, forKey: .window)
    switch try c.decode(String.self, forKey: .kind) {
    case "unchanged":
      self = .unchanged(revision: try c.decode(Int.self, forKey: .revision), window: window)
    case "snapshot":
      self = .snapshot(try c.decode(HostSession.self, forKey: .value), window: window)
    case "delta":
      self = .delta(
        base: try c.decode(Int.self, forKey: .base), value: try c.decode(HostSession.self, forKey: .value),
        blockIds: try c.decode([String].self, forKey: .blockIds), blocks: try c.decode([Block].self, forKey: .blocks),
        window: window)
    case "chunked":
      self = .chunked(transfer: try c.decode(String.self, forKey: .transfer), length: try c.decode(Int.self, forKey: .length))
    case let kind:
      throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown sync kind \(kind)")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .unchanged(revision, window):
      try c.encode("unchanged", forKey: .kind)
      try c.encode(revision, forKey: .revision)
      try c.encodeIfPresent(window, forKey: .window)
    case let .snapshot(value, window):
      try c.encode("snapshot", forKey: .kind)
      try c.encode(value, forKey: .value)
      try c.encodeIfPresent(window, forKey: .window)
    case let .delta(base, value, blockIds, blocks, window):
      try c.encode("delta", forKey: .kind)
      try c.encode(base, forKey: .base)
      try c.encode(DeltaValue(value: value), forKey: .value)
      try c.encode(blockIds, forKey: .blockIds)
      try c.encode(blocks, forKey: .blocks)
      try c.encodeIfPresent(window, forKey: .window)
    case let .chunked(transfer, length):
      try c.encode("chunked", forKey: .kind)
      try c.encode(transfer, forKey: .transfer)
      try c.encode(length, forKey: .length)
    }
  }

  public var window: WindowMeta? {
    switch self {
    case let .unchanged(_, window), let .snapshot(_, window), let .delta(_, _, _, _, window): window
    case .chunked: nil
    }
  }
}

/// A delta's `value`: the session without `blocks` or `blockRevisions`.
private struct DeltaValue: Encodable {
  var value: HostSession

  func encode(to encoder: any Encoder) throws {
    var head = value
    head.blockRevisions = nil
    var c = encoder.container(keyedBy: HostSession.CodingKeys.self)
    try c.encode(BlocklessSession(session: head.session), forKey: .session)
    try c.encode(head.projectId, forKey: .projectId)
    try c.encode(head.revision, forKey: .revision)
    try c.encodeIfPresent(head.runId, forKey: .runId)
    try c.encode(head.status, forKey: .status)
    try c.encodeIfPresent(head.createdAt, forKey: .createdAt)
    try c.encode(head.updatedAt, forKey: .updatedAt)
    try c.encodeIfPresent(head.archived, forKey: .archived)
    try c.encodeIfPresent(head.pinned, forKey: .pinned)
    try c.encodeIfPresent(head.autoWorktreeBranch, forKey: .autoWorktreeBranch)
    try c.encodeIfPresent(head.finishedAt, forKey: .finishedAt)
    try c.encodeIfPresent(head.lastTurnOutcome, forKey: .lastTurnOutcome)
  }
}

private struct BlocklessSession: Encodable {
  var session: Session

  func encode(to encoder: any Encoder) throws {
    try session.encode(to: BlocklessEncoder(base: encoder))
  }
}

/// Passes `omitSessionBlocks` down to `Session.encode`.
private struct BlocklessEncoder: Encoder {
  let base: any Encoder
  var codingPath: [any CodingKey] { base.codingPath }
  var userInfo: [CodingUserInfoKey: Any] { base.userInfo.merging([.omitSessionBlocks: true]) { $1 } }
  func container<Key: CodingKey>(keyedBy type: Key.Type) -> KeyedEncodingContainer<Key> { base.container(keyedBy: type) }
  func unkeyedContainer() -> any UnkeyedEncodingContainer { base.unkeyedContainer() }
  func singleValueContainer() -> any SingleValueEncodingContainer { base.singleValueContainer() }
}

/// `sessions.sync` params.
public struct SessionSyncParams: Codable, Hashable, Sendable {
  public var sessionId: String
  public var revision: Int?
  public var window: SyncWindow?
  public var maxBlockChars: Int?

  public init(sessionId: String, revision: Int? = nil, window: SyncWindow? = nil, maxBlockChars: Int? = nil) {
    self.sessionId = sessionId
    self.revision = revision
    self.window = window
    self.maxBlockChars = maxBlockChars
  }
}

/// `sessions.blocks` params and result: older history (06 §6.7).
public struct OlderBlocksParams: Codable, Hashable, Sendable {
  public var sessionId: String
  public var before: String
  public var turns: Int
  public var maxBlockChars: Int?

  public init(sessionId: String, before: String, turns: Int, maxBlockChars: Int? = nil) {
    self.sessionId = sessionId
    self.before = before
    self.turns = turns
    self.maxBlockChars = maxBlockChars
  }
}

public struct OlderBlocks: Codable, Hashable, Sendable {
  public var blocks: [Block]
  public var hasOlder: Bool
  public var olderTurns: Int
  public var revision: Int

  public init(blocks: [Block], hasOlder: Bool, olderTurns: Int, revision: Int) {
    self.blocks = blocks
    self.hasOlder = hasOlder
    self.olderTurns = olderTurns
    self.revision = revision
  }
}

/// `watch.set` (06 §6.6): replaces the channel's watch state.
public struct WatchSet: Codable, Hashable, Sendable {
  public var inbox: Bool?
  public var projects: [String]?
  public var sessions: [Entry]?

  public init(inbox: Bool? = nil, projects: [String]? = nil, sessions: [Entry]? = nil) {
    self.inbox = inbox
    self.projects = projects
    self.sessions = sessions
  }

  public struct Entry: Codable, Hashable, Sendable {
    public var id: String
    public var revision: Int?
    public var window: SyncWindow?
    public var maxBlockChars: Int?

    public init(id: String, revision: Int? = nil, window: SyncWindow? = nil, maxBlockChars: Int? = nil) {
      self.id = id
      self.revision = revision
      self.window = window
      self.maxBlockChars = maxBlockChars
    }
  }
}

/// The host's half of the handshake (06 §6.2).
public struct Welcome: Codable, Hashable, Sendable {
  public var ok: Bool
  public var channel: Int
  public var env: String
  public var boot: String
  public var time: Int
  public var host: Host
  public var device: Device
  public var capabilities: [String]
  public var providers: [String]
  public var limits: Limits?

  public init(env: String, boot: String, time: Int, host: Host, device: Device, capabilities: [String], providers: [String], limits: Limits? = nil) {
    ok = true
    channel = 1
    self.env = env
    self.boot = boot
    self.time = time
    self.host = host
    self.device = device
    self.capabilities = capabilities
    self.providers = providers
    self.limits = limits
  }

  public struct Host: Codable, Hashable, Sendable {
    public var name: String
    public var platform: String
    public var version: String
    public var fingerprint: String

    public init(name: String, platform: String, version: String, fingerprint: String) {
      self.name = name
      self.platform = platform
      self.version = version
      self.fingerprint = fingerprint
    }
  }

  public struct Device: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var role: String

    public init(id: String, name: String, role: String) {
      self.id = id
      self.name = name
      self.role = role
    }
  }

  public struct Limits: Codable, Hashable, Sendable {
    public var maxMessage: Int
    public var maxInFlight: Int
    public var maxWatchedSessions: Int

    public init(maxMessage: Int, maxInFlight: Int, maxWatchedSessions: Int) {
      self.maxMessage = maxMessage
      self.maxInFlight = maxInFlight
      self.maxWatchedSessions = maxWatchedSessions
    }
  }
}

/// Event payloads (06 §6.6).
public struct SessionSyncEvent: Codable, Hashable, Sendable {
  public var sessionId: String
  public var sync: SessionSync

  public init(sessionId: String, sync: SessionSync) {
    self.sessionId = sessionId
    self.sync = sync
  }
}

public struct InboxChangedEvent: Codable, Hashable, Sendable {
  public var boot: String
  public var revision: Int

  public init(boot: String, revision: Int) {
    self.boot = boot
    self.revision = revision
  }
}

public struct ProjectSessionsEvent: Codable, Hashable, Sendable {
  public var projectId: String

  public init(projectId: String) {
    self.projectId = projectId
  }
}

/// A host error (06 §6.3, §6.11).
public struct ChannelError: Codable, Hashable, Sendable, Error {
  public var code: String
  public var message: String
  public var retryable: Bool

  public init(code: String, message: String, retryable: Bool = false) {
    self.code = code
    self.message = message
    self.retryable = retryable
  }
}
