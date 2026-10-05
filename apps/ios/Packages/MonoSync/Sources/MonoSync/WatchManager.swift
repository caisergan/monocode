import Foundation
import MonoWire

/// A registered interest. Release it when the view that asked goes away;
/// releasing twice is harmless.
@MainActor
public final class Interest {
  private var onRelease: (@MainActor () -> Void)?

  init(_ onRelease: @escaping @MainActor () -> Void) {
    self.onRelease = onRelease
  }

  public func release() {
    onRelease?()
    onRelease = nil
  }

  /// An interest that holds nothing.
  public static var none: Interest { Interest {} }
}

/// Turns view interest into one `WatchSet` per host (12 §12.7). Counts are
/// reference counts. A session leaves the watch 30 s after its last view
/// goes away; at most 8 sessions are watched, the least recently viewed
/// dropped first.
@MainActor
public final class WatchManager {
  public typealias Current = @MainActor () -> (revision: Int?, window: SyncWindow)

  static let linger: Duration = .seconds(30)
  static let maxSessions = 8
  static let maxProjects = 64
  static let maxBlockChars = 20_000

  private struct SessionEntry {
    var count: Int
    /// When it was last viewed, as a sequence number.
    var viewedAt: Int
    var current: Current
    var linger: Task<Void, Never>?
  }

  private let send: (WatchSet, Bool) -> Void
  private var inbox = 0
  private var projects: [(id: String, count: Int)] = []
  private var sessions: [String: SessionEntry] = [:]
  private var views = 0

  /// `send(set, immediately)` hands the set to the runtime.
  init(send: @escaping (WatchSet, Bool) -> Void) {
    self.send = send
  }

  public var watchesInbox: Bool { inbox > 0 }

  public func watchInbox() -> Interest {
    inbox += 1
    update()
    return Interest { [weak self] in
      guard let self else { return }
      self.inbox -= 1
      self.update()
    }
  }

  public func watchProject(_ projectId: String) -> Interest {
    if let i = projects.firstIndex(where: { $0.id == projectId }) {
      projects[i].count += 1
    } else {
      projects.append((projectId, 1))
    }
    update(immediately: true)
    return Interest { [weak self] in
      guard let self, let i = self.projects.firstIndex(where: { $0.id == projectId }) else { return }
      self.projects[i].count -= 1
      if self.projects[i].count <= 0 { self.projects.remove(at: i) }
      self.update()
    }
  }

  public func watchSession(_ sessionId: String, current: @escaping Current) -> Interest {
    if var entry = sessions[sessionId] {
      entry.linger?.cancel()
      entry.linger = nil
      entry.count += 1
      views += 1
      entry.viewedAt = views
      entry.current = current
      sessions[sessionId] = entry
    } else {
      views += 1
      sessions[sessionId] = SessionEntry(count: 1, viewedAt: views, current: current)
    }
    update(immediately: true)
    return Interest { [weak self] in self?.unwatch(sessionId) }
  }

  private func unwatch(_ sessionId: String) {
    guard var entry = sessions[sessionId] else { return }
    entry.count -= 1
    if entry.count > 0 {
      sessions[sessionId] = entry
      return
    }
    entry.linger = Task { [weak self] in
      try? await Task.sleep(for: Self.linger)
      guard !Task.isCancelled, let self else { return }
      self.sessions[sessionId] = nil
      self.update()
    }
    sessions[sessionId] = entry
  }

  /// Re-sends the set, e.g. after an older page moved a session's anchor.
  public func refresh() {
    update(immediately: true)
  }

  /// The set for the current interests.
  public var current: WatchSet {
    let watched = sessions.sorted { $0.value.viewedAt > $1.value.viewedAt }.prefix(Self.maxSessions)
    return WatchSet(
      inbox: inbox > 0,
      projects: projects.suffix(Self.maxProjects).map(\.id),
      sessions: watched.sorted { $0.key < $1.key }.map { id, entry in
        let now = entry.current()
        return WatchSet.Entry(id: id, revision: now.revision, window: now.window, maxBlockChars: Self.maxBlockChars)
      })
  }

  private func update(immediately: Bool = false) {
    send(current, immediately)
  }
}
