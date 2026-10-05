import Foundation

public enum SessionSyncError: Error, Equatable, Sendable {
  /// The delta or `unchanged` does not apply to the known window; request a
  /// snapshot (06 §6.7).
  case baseMismatch
  /// A delta's `blockIds` names a block it neither carries nor had.
  case missingBlock(String)
  /// A chunked transfer must be read with `sessions.syncChunk` first.
  case chunked

  /// The TypeScript error message, for the golden fixtures.
  public var message: String {
    switch self {
    case .baseMismatch: "Session sync base does not match"
    case .missingBlock: "Session sync is missing a block"
    case .chunked: "Session sync is chunked"
    }
  }
}

/// `applySessionSync` (protocol.ts): the window after `sync`. Throws when a
/// delta does not apply to `known`.
public func applySessionSync(_ known: HostSession?, _ sync: SessionSync) throws -> HostSession {
  switch sync {
  case let .snapshot(value, _):
    return value
  case let .unchanged(revision, _):
    guard let known, known.revision == revision else { throw SessionSyncError.baseMismatch }
    return known
  case let .delta(base, value, blockIds, blocks, _):
    guard let known, known.revision == base else { throw SessionSyncError.baseMismatch }
    var byId = Dictionary(known.session.blocks.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
    for block in blocks { byId[block.id] = block }
    var next = value
    next.session.blocks = try blockIds.map { id in
      guard let block = byId[id] else { throw SessionSyncError.missingBlock(id) }
      return block
    }
    return next
  case .chunked:
    throw SessionSyncError.chunked
  }
}
