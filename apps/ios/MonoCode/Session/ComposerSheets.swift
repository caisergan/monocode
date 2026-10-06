import MonoDesign
import MonoSync
import MonoWire
import SwiftUI

/// The model sheet (11 §11.17 item 3, 16 §16.6.5): the desktop's model menu
/// and its flyout on one page. Settings come first in the desktop's order,
/// with Effort as segments rather than a sub-list; then the flyout's provider
/// strip, search row and model rows with a favourite star and a check.
struct ModelSheet: View {
  var env: String
  var session: Session?
  var running: Bool
  var draft: ComposerDraft
  @Environment(SyncEngine.self) private var engine
  @Environment(\.palette) private var palette
  @Environment(\.dismiss) private var dismiss
  @State private var tab: Tab = .harness("")
  @State private var query = ""
  @AppStorage("mc.models.favorites") private var favoritesRaw = ""

  enum Tab: Hashable {
    case favorites
    case harness(String)
  }

  private var catalog: ModelCatalog? { engine.catalogs.catalogs[env] }
  private var currentId: String { draft.model(for: session) }
  private var current: AgentModel? { catalog?.model(currentId) }
  private var values: [String: String] { draft.settings(for: session) }
  /// The provider is fixed once the session has started.
  private var harness: String { session?.harness ?? current?.harness ?? "claude" }
  private var favorites: [String] { favoritesRaw.split(separator: "\n").map(String.init) }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if let current, !ModelSettings.visible(current).isEmpty {
            settingsCard(current)
          }
          modelsCard
          if running {
            Text("Changes apply to the next turn.")
              .font(.mono(Tokens.TypeScale.meta))
              .foregroundStyle(palette.text.tertiary.color)
              .padding(.horizontal, 4)
          }
        }
        .padding(16)
      }
      .scrollDismissesKeyboard(.immediately)
      .background(palette.base.color)
      .navigationTitle("Model")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close", systemImage: "xmark") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .onAppear { if tab == .harness("") { tab = .harness(harness) } }
  }

  // MARK: Settings

  private func settingsCard(_ model: AgentModel) -> some View {
    VStack(spacing: 0) {
      ForEach(Array(ModelSettings.visible(model).enumerated()), id: \.element.id) { index, setting in
        if index > 0 { divider }
        settingRow(setting)
      }
    }
    .card(palette)
  }

  @ViewBuilder private func settingRow(_ setting: AgentModel.Setting) -> some View {
    if setting.kind == "toggle" {
      Toggle(isOn: Binding(
        get: { ModelSettings.value(setting, values) == "true" },
        set: { draft.settings[setting.id] = $0 ? "true" : "false" }
      )) {
        Text(ModelSettings.label(setting) == "Fast mode" ? "Fast" : ModelSettings.label(setting))
          .font(.mono(Tokens.TypeScale.row))
          .foregroundStyle(palette.content.color)
      }
      .tint(palette.content.color.opacity(0.35))
      .padding(.horizontal, 14)
      .frame(minHeight: 48)
    } else if ModelSettings.isEffort(setting) && setting.options.count <= 5 {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text(ModelSettings.label(setting))
            .font(.mono(Tokens.TypeScale.row))
            .foregroundStyle(palette.content.color)
          Spacer()
          Text(ModelSettings.valueLabel(setting, values))
            .font(.mono(Tokens.TypeScale.row))
            .foregroundStyle(palette.text.secondary.color)
            .contentTransition(.numericText())
        }
        Segmented(
          options: setting.options.map { ($0.value, $0.label) },
          selection: Binding(
            get: { ModelSettings.value(setting, values) },
            set: { draft.settings[setting.id] = $0 }))
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .sensoryFeedback(.selection, trigger: ModelSettings.value(setting, values))
    } else {
      NavigationLink {
        OptionList(setting: setting, value: ModelSettings.value(setting, values)) { draft.settings[setting.id] = $0 }
      } label: {
        HStack(spacing: 8) {
          Text(ModelSettings.label(setting)).foregroundStyle(palette.content.color)
          Spacer()
          Text(ModelSettings.valueLabel(setting, values)).foregroundStyle(palette.text.secondary.color).lineLimit(1)
          Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
            .foregroundStyle(palette.text.tertiary.color)
        }
        .font(.mono(Tokens.TypeScale.row))
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
    }
  }

  // MARK: Models

  /// The flyout: providers, search, then the list.
  private var modelsCard: some View {
    VStack(spacing: 0) {
      providerStrip
      divider
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").font(.system(size: 14))
          .foregroundStyle(palette.text.tertiary.color)
        TextField("Search models", text: $query)
          .font(.mono(Tokens.TypeScale.row))
          .foregroundStyle(palette.content.color)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.search)
      }
      .padding(.horizontal, 14)
      .frame(minHeight: 44)
      divider
      let models = visibleModels
      if models.isEmpty {
        Text(emptyText)
          .font(.mono(Tokens.TypeScale.secondary))
          .foregroundStyle(palette.text.tertiary.color)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
      } else {
        VStack(spacing: 2) {
          ForEach(models, id: \.id) { modelRow($0) }
        }
        .padding(4)
      }
    }
    .card(palette)
  }

  /// Favorites, then each harness this machine lists. The session's own is
  /// the only one it can switch within.
  private var providerStrip: some View {
    let harnesses = catalog.map { Array($0.models.keys).sorted { $0 == harness ? true : $1 == harness ? false : $0 < $1 } } ?? [harness]
    return ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 4) {
        providerTab(.favorites, title: "Favorites") {
          Image(systemName: tab == .favorites ? "star.fill" : "star").font(.system(size: 15))
        }
        ForEach(harnesses, id: \.self) { id in
          providerTab(.harness(id), title: id.capitalized) { HarnessMark(harness: id, size: 18) }
            .disabled(id != harness)
            .opacity(id == harness ? 1 : 0.35)
        }
      }
      .padding(6)
    }
  }

  private func providerTab(_ value: Tab, title: String, @ViewBuilder _ icon: () -> some View) -> some View {
    Button {
      withAnimation(.easeOut(duration: 0.15)) { tab = value }
    } label: {
      icon()
        .foregroundStyle(tab == value ? palette.content.color : palette.text.secondary.color)
        .frame(width: 40, height: 36)
        .background(tab == value ? palette.selection.strong.color : .clear, in: .rect(cornerRadius: Tokens.Radius.md))
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityAddTraits(tab == value ? [.isSelected] : [])
  }

  private var visibleModels: [AgentModel] {
    let all: [AgentModel]
    switch tab {
    case .favorites:
      let every = catalog?.models.values.flatMap { $0 } ?? []
      all = favorites.compactMap { id in every.first { $0.id == id } }
    case let .harness(id):
      all = catalog?.models[id] ?? []
    }
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    return q.isEmpty ? all : all.filter { $0.name.lowercased().contains(q) || $0.id.lowercased().contains(q) }
  }

  private var emptyText: String {
    if tab == .favorites && query.trimmingCharacters(in: .whitespaces).isEmpty { return "No favorite models" }
    if catalog == nil { return "Loading models…" }
    return "No matching models"
  }

  private func modelRow(_ model: AgentModel) -> some View {
    let selected = model.id == currentId || model.nativeId == currentId
    let favorited = favorites.contains(model.id)
    let usable = model.harness == harness
    return HStack(spacing: 4) {
      Button {
        guard usable else { return }
        draft.pick(model, from: session)
        dismiss()
      } label: {
        HStack(spacing: 10) {
          if tab == .favorites { HarnessMark(harness: model.harness, size: 16) }
          Text(model.name)
            .font(.mono(Tokens.TypeScale.row))
            .foregroundStyle(usable ? palette.content.color : palette.text.faint.color)
            .lineLimit(1)
          Spacer(minLength: 0)
        }
        .padding(.leading, 10)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(!usable)
      Button {
        toggleFavorite(model.id)
      } label: {
        Image(systemName: favorited ? "star.fill" : "star")
          .font(.system(size: 14))
          .foregroundStyle(favorited ? palette.text.secondary.color : palette.text.faint.color)
          .frame(width: 36, height: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(favorited ? "Remove from favorites" : "Add to favorites")
      Image(systemName: "checkmark")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(palette.text.secondary.color)
        .frame(width: 28)
        .opacity(selected ? 1 : 0)
        .accessibilityHidden(true)
    }
    .padding(.trailing, 6)
    .background(selected ? palette.selection.normal.color : .clear, in: .rect(cornerRadius: Tokens.Radius.md))
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }

  private func toggleFavorite(_ id: String) {
    var list = favorites
    if let i = list.firstIndex(of: id) { list.remove(at: i) } else { list.append(id) }
    favoritesRaw = list.joined(separator: "\n")
  }

  private var divider: some View {
    Rectangle().fill(palette.border.subtle.color).frame(height: 1)
  }
}

/// A select setting other than Effort: its options with a check.
private struct OptionList: View {
  var setting: AgentModel.Setting
  var value: String
  var pick: (String) -> Void
  @Environment(\.palette) private var palette
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List(setting.options, id: \.value) { option in
      Button {
        pick(option.value)
        dismiss()
      } label: {
        HStack {
          Text(option.label).foregroundStyle(palette.content.color)
          Spacer()
          if option.value == value {
            Image(systemName: "checkmark").foregroundStyle(palette.text.secondary.color)
          }
        }
        .font(.mono(Tokens.TypeScale.row))
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .listRowBackground(palette.fill.code.color)
    }
    .scrollContentBackground(.hidden)
    .background(palette.base.color)
    .navigationTitle(ModelSettings.label(setting))
    .toolbarTitleDisplayMode(.inline)
  }
}

/// The access sheet (11 §11.17 item 4): the quick composer's permission
/// rows, 16 pt icon, 15 pt label, 13 pt hint, accent check. Full access asks
/// first (D16).
struct AccessSheet: View {
  var running: Bool
  var current: AccessMode
  var pick: (AccessMode) -> Void
  @Environment(\.palette) private var palette
  @Environment(\.dismiss) private var dismiss
  @State private var confirming = false
  @State private var height: CGFloat = 360

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 12) {
        VStack(spacing: 2) {
          ForEach(AccessMode.allCases, id: \.self) { mode in
            Button {
              if mode == .fullAccess && current != .fullAccess {
                confirming = true
              } else {
                pick(mode)
                dismiss()
              }
            } label: {
              HStack(alignment: .top, spacing: 12) {
                AccessIcon(mode: mode, size: 16).frame(width: 20).padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                  Text(mode.label)
                    .font(.mono(Tokens.TypeScale.row, .medium))
                    .foregroundStyle(palette.content.color)
                  Text(mode.hint)
                    .font(.mono(Tokens.TypeScale.secondary))
                    .foregroundStyle(palette.text.tertiary.color)
                    .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if mode == current {
                  Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(palette.accent.color)
                }
              }
              .padding(.horizontal, 12)
              .padding(.vertical, 10)
              .background(mode == current ? palette.selection.normal.color : .clear, in: .rect(cornerRadius: Tokens.Radius.md))
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(mode.label)
            .accessibilityHint(mode.hint)
            .accessibilityAddTraits(mode == current ? [.isButton, .isSelected] : [.isButton])
          }
        }
        if running {
          Text("Access changes apply to the next turn. Stop and resend to apply them now.")
            .font(.mono(Tokens.TypeScale.meta))
            .foregroundStyle(palette.text.tertiary.color)
            .padding(.horizontal, 12)
        }
      }
      .padding(.horizontal, 12)
      .padding(.top, 4)
      .padding(.bottom, 12)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 + 70 }
      .frame(maxHeight: .infinity, alignment: .top)
      .background(palette.base.color)
      .navigationTitle("Access")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close", systemImage: "xmark") { dismiss() }
        }
      }
      .alert("Allow full access?", isPresented: $confirming) {
        Button("Cancel", role: .cancel) {}
        Button("Allow full access") {
          pick(.fullAccess)
          dismiss()
        }
      } message: {
        Text("The agent will run commands and edit files without asking.")
      }
    }
    .presentationDetents([.height(height)])
    .presentationDragIndicator(.visible)
  }
}

/// Add to message (11 §11.17 item 1): files arrive with the write path; Plan
/// and Draft set the composer's mode.
struct AddSheet: View {
  var mode: ComposerDraft.Mode?
  var pick: (ComposerDraft.Mode?) -> Void
  @Environment(\.palette) private var palette
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 2) {
        row("Upload file", hint: "Attach files or images", symbol: "paperclip", tint: palette.text.secondary.color, on: false)
          .disabled(true)
          .opacity(0.45)
        row("Plan mode", hint: "Review a plan before building", symbol: "lightbulb", tint: palette.status.attention.color.opacity(0.8), on: mode == .plan) {
          pick(mode == .plan ? nil : .plan)
        }
        row("Draft", hint: "Save this message without starting the agent", symbol: "circle.dashed", tint: palette.text.secondary.color, on: mode == .draft) {
          pick(mode == .draft ? nil : .draft)
        }
      }
      .padding(12)
      .frame(maxHeight: .infinity, alignment: .top)
      .background(palette.base.color)
      .navigationTitle("Add to message")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close", systemImage: "xmark") { dismiss() }
        }
      }
    }
    .presentationDetents([.height(300)])
    .presentationDragIndicator(.visible)
  }

  private func row(_ title: String, hint: String, symbol: String, tint: Color, on: Bool, action: @escaping () -> Void = {}) -> some View {
    Button {
      action()
      dismiss()
    } label: {
      HStack(spacing: 12) {
        Image(systemName: symbol).font(.system(size: 16)).foregroundStyle(tint).frame(width: 20)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.mono(Tokens.TypeScale.row, .medium)).foregroundStyle(palette.content.color)
          Text(hint).font(.mono(Tokens.TypeScale.secondary)).foregroundStyle(palette.text.tertiary.color)
        }
        Spacer(minLength: 0)
        if on {
          Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(palette.accent.color)
        }
      }
      .padding(.horizontal, 12)
      .frame(minHeight: 56)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(title)
    .accessibilityHint(hint)
    .accessibilityAddTraits(on ? [.isButton, .isSelected] : [.isButton])
  }
}

private extension View {
  /// The desktop's popover surface: `r.lg`, `fill.composer`, border α .10.
  func card(_ palette: Palette) -> some View {
    background(palette.fill.composer.color, in: .rect(cornerRadius: Tokens.Radius.lg))
      .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.lg).strokeBorder(palette.border.default.color))
      .clipShape(.rect(cornerRadius: Tokens.Radius.lg))
  }
}

/// How full the model's context window is (the desktop's `ContextMeter`):
/// a ring that turns amber at 75% and red at 90%. It shows only when the
/// harness reports both the level and the window.
struct ContextMeter: View {
  var ratio: Double
  var size: CGFloat
  @Environment(\.palette) private var palette

  var body: some View {
    let stroke = size / 7
    ZStack {
      Circle().stroke(color.opacity(0.25), lineWidth: stroke)
      Circle()
        .trim(from: 0, to: ratio)
        .stroke(color, style: StrokeStyle(lineWidth: stroke, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .padding(stroke / 2)
    .frame(width: size, height: size)
    .animation(.easeOut(duration: 0.3), value: ratio)
  }

  private var color: Color {
    ratio >= 0.9 ? palette.status.danger.color
      : ratio >= 0.75 ? palette.status.attention.color
      : palette.content.color.opacity(0.45)
  }

  /// The fraction in use, or nil while the window is unknown.
  static func ratio(_ usage: ContextUsage) -> Double? {
    guard let window = usage.window, window > 0, usage.used.isFinite, usage.used >= 0 else { return nil }
    return min(1, usage.used / window)
  }

  /// "69% context used".
  static func headline(_ usage: ContextUsage) -> String {
    ratio(usage).map { "\(Int(($0 * 100).rounded()))% context used" } ?? "Context used"
  }

  /// "176K / 256K tokens".
  static func detail(_ usage: ContextUsage) -> String {
    usage.window.map { "\(tokens(usage.used)) / \(tokens($0)) tokens" } ?? "\(tokens(usage.used)) tokens"
  }

  /// The desktop's `formatTokens`: 980, 1.5K, 176K, 1.2M.
  static func tokens(_ count: Double) -> String {
    guard count.isFinite, count >= 0 else { return "0" }
    if count < 1000 { return String(Int(count.rounded())) }
    func short(_ value: Double, _ unit: String) -> String {
      value < 10 ? String(format: "%.1f", value).replacingOccurrences(of: ".0", with: "") + unit : "\(Int(value.rounded()))\(unit)"
    }
    return count < 1_000_000 ? short(count / 1000, "K") : short(count / 1_000_000, "M")
  }
}

/// The ring's sheet (11 §11.17): the numbers and Compact now, which is
/// `/compact` and waits for the write path.
struct ContextSheet: View {
  var usage: ContextUsage
  @Environment(\.palette) private var palette
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(spacing: 16) {
        HStack(spacing: 14) {
          ContextMeter(ratio: ContextMeter.ratio(usage) ?? 0, size: 44)
          VStack(alignment: .leading, spacing: 3) {
            Text(ContextMeter.headline(usage))
              .font(.mono(Tokens.TypeScale.row, .medium))
              .foregroundStyle(palette.content.color)
            Text(ContextMeter.detail(usage))
              .font(.mono(Tokens.TypeScale.secondary))
              .foregroundStyle(palette.text.tertiary.color)
          }
          Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        Button {} label: {
          Text("Compact now")
            .font(.mono(Tokens.TypeScale.row, .medium))
            .foregroundStyle(palette.content.color)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(palette.selection.normal.color, in: .rect(cornerRadius: Tokens.Radius.md))
        }
        .buttonStyle(.plain)
        .disabled(true)
        .opacity(0.45)
        .accessibilityHint("Compacting from the phone arrives with the write path.")
      }
      .padding(16)
      .frame(maxHeight: .infinity, alignment: .top)
      .background(palette.base.color)
      .navigationTitle("Context")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close", systemImage: "xmark") { dismiss() }
        }
      }
    }
    .presentationDetents([.height(220)])
    .presentationDragIndicator(.visible)
  }
}
