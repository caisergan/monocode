import Foundation

// The desktop session model as the host sends it
// (src/features/sessions/model/session.ts and
// src/features/connections/model/protocol.ts, re-exported by @monocode/core).
// Only the fields a host puts on the wire are modelled; desktop-local ones
// (folders, notes, orchestration proposals) are ignored when present.
// Optionals encode as absent, as `JSON.stringify` drops `undefined`.

public struct Block: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var role: BlockRole
  public var text: String
  public var image: GeneratedImage?
  public var attachments: [Attachment]?
  public var streaming: Bool?
  /// Epoch ms when this user turn started.
  public var startedAt: Int?
  /// How long the agent worked on this user turn, in ms.
  public var durationMs: Int?
  public var turnModel: TurnModel?
  public var providerTurnId: String?
  /// A user turn saved to the session but not submitted yet.
  public var draft: Bool?
  public var monocode: Bool?
  /// "plan" or "orchestrate".
  public var intent: String?
  public var appRequestId: String?
  public var turnMetrics: TurnMetrics?
  public var tool: Tool?
  public var approval: Approval?
  public var agentRun: AgentRun?
  public var taskList: TaskList?
  public var plan: Plan?
  public var orchestrationLeadId: String?
  /// A turn the app wrote to keep an orchestration moving; hidden.
  public var `internal`: Bool?
  public var handoff: Handoff?
  public var secondOpinion: SecondOpinion?
  public var ciContext: String?
  public var interjection: Interjection?
  /// "error" or "interrupt".
  public var notice: String?
  /// Set in transit when the block was cut down (06 §6.7).
  public var truncated: Truncated?

  public init(id: String, role: BlockRole, text: String) {
    self.id = id
    self.role = role
    self.text = text
  }

  public var isStreaming: Bool { streaming == true }
  public var isDraft: Bool { draft == true }

  public struct Tool: Codable, Hashable, Sendable {
    public var callId: String?
    public var title: String?
    public var kind: String?
    public var status: String?
    public var detail: String?
    public var preview: ToolPreview?
    /// Left running by the agent when it yielded.
    public var background: Bool?

    public init(kind: String? = nil, status: String? = nil, title: String? = nil, detail: String? = nil, preview: ToolPreview? = nil) {
      self.kind = kind
      self.status = status
      self.title = title
      self.detail = detail
      self.preview = preview
    }
  }

  public struct Approval: Codable, Hashable, Sendable {
    public var requestId: Int
    /// "allow", "deny" or "cancelled".
    public var decided: String?

    public init(requestId: Int, decided: String? = nil) {
      self.requestId = requestId
      self.decided = decided
    }
  }

  public struct Truncated: Codable, Hashable, Sendable {
    /// The full block's serialized length.
    public var chars: Int
  }
}

public struct ToolPreview: Codable, Hashable, Sendable {
  public var kind: ToolPreviewKind
  public var title: String?
  public var path: String?
  public var fileName: String?
  public var startLine: Int?
  public var additions: Int?
  public var deletions: Int?
  public var contentOnly: Bool?
  public var query: String?
  public var lines: [Line]?
  public var output: String?

  public init(kind: ToolPreviewKind, path: String? = nil, query: String? = nil, output: String? = nil) {
    self.kind = kind
    self.path = path
    self.query = query
    self.output = output
  }

  public struct Line: Codable, Hashable, Sendable {
    public var number: Int?
    /// "add", "del" or "context".
    public var kind: String
    public var text: String
  }
}

public struct Attachment: Codable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var mimeType: String
  /// "image", "audio" or "file".
  public var kind: String
  public var size: Int
  public var path: String?
}

public struct GeneratedImage: Codable, Hashable, Sendable {
  public var path: String
  public var name: String
  public var mimeType: String
  public var size: Int
  public var alt: String?
}

public struct TurnModel: Codable, Hashable, Sendable {
  public var harness: String
  public var id: String
  public var name: String

  public init(harness: String, id: String, name: String) {
    self.harness = harness
    self.id = id
    self.name = name
  }
}

public struct TurnMetrics: Codable, Hashable, Sendable {
  public var inputTokens: Int?
  public var outputTokens: Int?
  public var cacheReadTokens: Int?
  public var cacheWriteTokens: Int?
  public var cacheHitPercent: Double?
}

public struct AgentRun: Codable, Hashable, Sendable {
  public var name: String
  public var agentType: String?
  public var model: String?
  public var steps: [AgentStep]
}

public struct AgentStep: Codable, Hashable, Sendable {
  public var id: String
  /// "tool", "message" or "reasoning".
  public var kind: String
  public var text: String
  public var toolKind: String?
  public var status: String?
  public var detail: String?
  public var preview: ToolPreview?
}

public struct TaskList: Codable, Hashable, Sendable {
  public var key: String?
  public var providerSessionId: String?
  public var explanation: String?
  public var items: [Item]

  public struct Item: Codable, Hashable, Sendable {
    public var id: String?
    public var text: String
    /// "pending", "in_progress", "completed" or "cancelled".
    public var status: String
  }
}

public struct Plan: Codable, Hashable, Sendable {
  public var key: String?
  /// "streaming", "ready", "building" or "built".
  public var status: String
  public var originalText: String?
  public var approvedText: String?
  public var edited: Bool?
}

public struct Handoff: Codable, Hashable, Sendable {
  public var from: String
  public var to: String
  public var status: String
  public var pending: Bool?
}

public struct SecondOpinion: Codable, Hashable, Sendable {
  public var from: String
  public var to: String
  public var request: String?
  public var files: Int?
  public var kind: String?
}

public struct Interjection: Codable, Hashable, Sendable {
  public var customType: String
  /// "nit", "concern" or "blocker".
  public var severity: String?
}

public struct QueuedMessage: Codable, Hashable, Sendable {
  public var id: String
  public var text: String
  public var attachments: [Attachment]
  public var intent: String?
}

public struct UsageLimit: Codable, Hashable, Sendable {
  public var resetsAt: Int?
  public var resumeAtReset: Bool?
}

public struct LinkedWorkItem: Codable, Hashable, Sendable {
  /// "issue" or "pr".
  public var kind: String
  public var repo: String
  public var number: Int
  public var url: String
}

public struct UserQuestionPrompt: Codable, Hashable, Sendable {
  public var requestId: Int
  public var title: String?
  public var questions: [Question]
  public var autoResolveAt: Int?

  public struct Question: Codable, Hashable, Sendable {
    public var id: String
    public var header: String?
    public var prompt: String
    public var multiSelect: Bool
    public var allowCustom: Bool
    public var options: [Option]
  }

  public struct Option: Codable, Hashable, Sendable {
    public var id: String
    public var label: String
    public var description: String?
  }
}

public struct ContextUsage: Codable, Hashable, Sendable {
  /// Tokens in the context window as of the last request.
  public var used: Double
  /// The active model's context window, when the harness reports one.
  public var window: Double?

  public init(used: Double, window: Double? = nil) {
    self.used = used
    self.window = window
  }
}

/// `Session`. A delta's `value.session` has no `blocks`; it decodes with
/// none, and `SessionSync` encodes it without them again.
public struct Session: Codable, Hashable, Sendable {
  public var id: String
  public var harness: String
  public var model: String
  public var modelSettings: [String: String]
  public var runtimeMode: RuntimeMode
  public var title: String
  public var cwd: String
  public var blocks: [Block]
  public var queuedMessages: [QueuedMessage]?
  /// "active", "paused" or "resuming".
  public var queueStatus: String?
  public var usageLimit: UsageLimit?
  public var providerSessionId: String?
  public var context: ContextUsage?
  public var branch: String?
  public var worktreeCwd: String?
  public var worktreeRemoved: Bool?
  public var linkedWorkItem: LinkedWorkItem?
  public var surface: String?
  public var pendingQuestion: UserQuestionPrompt?

  public init(id: String, harness: String, model: String, modelSettings: [String: String] = [:], runtimeMode: RuntimeMode, title: String, cwd: String, blocks: [Block]) {
    self.id = id
    self.harness = harness
    self.model = model
    self.modelSettings = modelSettings
    self.runtimeMode = runtimeMode
    self.title = title
    self.cwd = cwd
    self.blocks = blocks
  }

  enum CodingKeys: String, CodingKey {
    case id, harness, model, modelSettings, runtimeMode, title, cwd, blocks, queuedMessages, queueStatus
    case usageLimit, providerSessionId, context, branch, worktreeCwd, worktreeRemoved, linkedWorkItem, surface
    case pendingQuestion
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    harness = try c.decode(String.self, forKey: .harness)
    model = try c.decode(String.self, forKey: .model)
    modelSettings = try c.decodeIfPresent([String: String].self, forKey: .modelSettings) ?? [:]
    runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode)
    title = try c.decode(String.self, forKey: .title)
    cwd = try c.decode(String.self, forKey: .cwd)
    blocks = try c.decodeIfPresent([Block].self, forKey: .blocks) ?? []
    queuedMessages = try c.decodeIfPresent([QueuedMessage].self, forKey: .queuedMessages)
    queueStatus = try c.decodeIfPresent(String.self, forKey: .queueStatus)
    usageLimit = try c.decodeIfPresent(UsageLimit.self, forKey: .usageLimit)
    providerSessionId = try c.decodeIfPresent(String.self, forKey: .providerSessionId)
    context = try c.decodeIfPresent(ContextUsage.self, forKey: .context)
    branch = try c.decodeIfPresent(String.self, forKey: .branch)
    worktreeCwd = try c.decodeIfPresent(String.self, forKey: .worktreeCwd)
    worktreeRemoved = try c.decodeIfPresent(Bool.self, forKey: .worktreeRemoved)
    linkedWorkItem = try c.decodeIfPresent(LinkedWorkItem.self, forKey: .linkedWorkItem)
    surface = try c.decodeIfPresent(String.self, forKey: .surface)
    pendingQuestion = try c.decodeIfPresent(UserQuestionPrompt.self, forKey: .pendingQuestion)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(harness, forKey: .harness)
    try c.encode(model, forKey: .model)
    try c.encode(modelSettings, forKey: .modelSettings)
    try c.encode(runtimeMode, forKey: .runtimeMode)
    try c.encode(title, forKey: .title)
    try c.encode(cwd, forKey: .cwd)
    if encoder.userInfo[.omitSessionBlocks] as? Bool != true { try c.encode(blocks, forKey: .blocks) }
    try c.encodeIfPresent(queuedMessages, forKey: .queuedMessages)
    try c.encodeIfPresent(queueStatus, forKey: .queueStatus)
    try c.encodeIfPresent(usageLimit, forKey: .usageLimit)
    try c.encodeIfPresent(providerSessionId, forKey: .providerSessionId)
    try c.encodeIfPresent(context, forKey: .context)
    try c.encodeIfPresent(branch, forKey: .branch)
    try c.encodeIfPresent(worktreeCwd, forKey: .worktreeCwd)
    try c.encodeIfPresent(worktreeRemoved, forKey: .worktreeRemoved)
    try c.encodeIfPresent(linkedWorkItem, forKey: .linkedWorkItem)
    try c.encodeIfPresent(surface, forKey: .surface)
    try c.encodeIfPresent(pendingQuestion, forKey: .pendingQuestion)
  }
}

extension CodingUserInfoKey {
  /// Set while encoding a delta's `value`, whose session carries no blocks.
  static let omitSessionBlocks = CodingUserInfoKey(rawValue: "monocode.omitSessionBlocks")!
}

public struct HostSession: Codable, Hashable, Sendable {
  public var session: Session
  public var projectId: String
  public var revision: Int
  public var runId: String?
  public var status: SessionStatus
  public var createdAt: Int?
  public var updatedAt: Int
  public var archived: Bool?
  public var pinned: Bool?
  public var autoWorktreeBranch: String?
  /// Host-only: the revision at which each block last changed.
  public var blockRevisions: [String: Int]?
  /// When the last turn settled.
  public var finishedAt: Int?
  public var lastTurnOutcome: TurnOutcome?

  public init(session: Session, projectId: String, revision: Int, status: SessionStatus, updatedAt: Int) {
    self.session = session
    self.projectId = projectId
    self.revision = revision
    self.status = status
    self.updatedAt = updatedAt
  }

  public var isRunning: Bool { status == .running }

  enum CodingKeys: String, CodingKey {
    case session, projectId, revision, runId, status, createdAt, updatedAt, archived, pinned, autoWorktreeBranch
    case blockRevisions, finishedAt, lastTurnOutcome
  }
}

public struct HostProject: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var cwd: String
  public var name: String

  public init(id: String, cwd: String, name: String) {
    self.id = id
    self.cwd = cwd
    self.name = name
  }
}

public struct HostWorktree: Codable, Hashable, Sendable {
  public var path: String
  public var branch: String?
  public var head: String?
  public var isMain: Bool?
  public var missing: Bool?
}

/// `models.list`.
public struct ModelCatalog: Codable, Hashable, Sendable {
  public var models: [String: [AgentModel]]
  public var errors: [String: String]

  public init(models: [String: [AgentModel]] = [:], errors: [String: String] = [:]) {
    self.models = models
    self.errors = errors
  }

  /// The display name for a model id, when a catalog lists it.
  public func name(of id: String) -> String? {
    for list in models.values {
      if let model = list.first(where: { $0.id == id || $0.nativeId == id }) { return model.name }
    }
    return nil
  }
}

public struct AgentModel: Codable, Hashable, Sendable {
  public var id: String
  public var harness: String
  public var name: String
  public var nativeId: String?
  public var provider: Provider?
  public var settings: [Setting]?
  public var contextWindow: Int?
  public var resolvedId: String?

  public struct Provider: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
  }

  public struct Setting: Codable, Hashable, Sendable {
    public var id: String
    public var label: String
    /// "select" or "toggle".
    public var kind: String
    public var value: String
    public var options: [Choice]
    public var description: String?
  }

  public struct Choice: Codable, Hashable, Sendable {
    public var value: String
    public var label: String
  }
}
