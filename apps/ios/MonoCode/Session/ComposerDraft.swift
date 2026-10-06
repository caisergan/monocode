import MonoWire
import SwiftUI

/// What the composer will send with the next message (11 §11.17): the model,
/// its settings, the access mode and Plan or Draft. It holds only what the
/// person changed; everything else follows the session, so a running
/// session's own changes still show until they pick something. Sending is
/// the write path (R3), so picks stay on the phone until then.
@MainActor @Observable
final class ComposerDraft {
  var model: String?
  var settings: [String: String] = [:]
  var runtimeMode: RuntimeMode?
  var mode: Mode?

  enum Mode: String { case plan, draft }

  func model(for session: Session?) -> String { model ?? session?.model ?? "" }

  /// The session's settings with this draft's picks over them.
  func settings(for session: Session?) -> [String: String] {
    (model == nil ? session?.modelSettings ?? [:] : [:]).merging(settings) { _, picked in picked }
  }

  func runtimeMode(for session: Session?) -> RuntimeMode { runtimeMode ?? session?.runtimeMode ?? .supervised }

  /// A new model keeps the picked values its own settings still offer.
  func pick(_ next: AgentModel, from session: Session?) {
    let current = settings(for: session)
    model = next.id
    settings = [:]
    for setting in next.settings ?? [] {
      if let value = current[setting.id], setting.options.contains(where: { $0.value == value }) {
        settings[setting.id] = value
      }
    }
  }
}

/// Model settings as the desktop's picker orders and names them
/// (`ModelPicker.tsx`).
enum ModelSettings {
  /// The desktop menu's order.
  static let order = ["fast", "effort", "reasoning", "reasoningEffort", "serviceTier", "thinking", "variant", "agent", "context"]

  static func isEffort(_ setting: AgentModel.Setting) -> Bool {
    setting.kind == "select" && ["effort", "reasoning", "reasoningEffort"].contains(setting.id)
  }

  /// Settings in menu order, without OpenCode's agent row.
  static func visible(_ model: AgentModel) -> [AgentModel.Setting] {
    (model.settings ?? [])
      .filter { !(model.harness == "opencode" && $0.id == "agent") }
      .sorted { rank($0.id) < rank($1.id) }
  }

  static func label(_ setting: AgentModel.Setting) -> String {
    setting.id == "effort" || setting.id == "reasoning" ? "Effort" : setting.label
  }

  static func value(_ setting: AgentModel.Setting, _ values: [String: String]) -> String {
    values[setting.id] ?? setting.value
  }

  static func valueLabel(_ setting: AgentModel.Setting, _ values: [String: String]) -> String {
    let value = value(setting, values)
    return setting.options.first { $0.value == value }?.label ?? value
  }

  private static func rank(_ id: String) -> Int { order.firstIndex(of: id) ?? 99 }
}

extension ModelCatalog {
  func model(_ id: String) -> AgentModel? {
    for list in models.values {
      if let model = list.first(where: { $0.id == id || $0.nativeId == id }) { return model }
    }
    return nil
  }
}

/// The access modes (11 §11.17 item 4), in the quick composer's order.
enum AccessMode: CaseIterable {
  case supervised, autoAcceptEdits, auto, fullAccess

  init(_ mode: RuntimeMode) {
    switch mode {
    case .autoAcceptEdits: self = .autoAcceptEdits
    case .auto: self = .auto
    case .fullAccess: self = .fullAccess
    default: self = .supervised
    }
  }

  var runtimeMode: RuntimeMode {
    switch self {
    case .supervised: .supervised
    case .autoAcceptEdits: .autoAcceptEdits
    case .auto: .auto
    case .fullAccess: .fullAccess
    }
  }

  var label: String {
    switch self {
    case .supervised: "Supervised"
    case .autoAcceptEdits: "Auto-accept edits"
    case .auto: "Auto"
    case .fullAccess: "Full access"
    }
  }

  var hint: String {
    switch self {
    case .supervised: "Ask before commands and file changes."
    case .autoAcceptEdits: "Auto-approve edits, ask before other actions."
    case .auto: "An AI reviewer can approve or deny actions."
    case .fullAccess: "Allow commands, edits, and supported MCP confirmations in non-plan turns without prompts."
    }
  }

  /// Lock, Pencil, Sparkles, or the amber Shield (desktop icons as SF Symbols).
  var symbol: String {
    switch self {
    case .supervised: "lock"
    case .autoAcceptEdits: "pencil"
    case .auto: "sparkles"
    case .fullAccess: "exclamationmark.shield"
    }
  }
}
