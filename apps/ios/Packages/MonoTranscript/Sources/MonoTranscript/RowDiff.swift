import Foundation

/// The ops that turn `before` into `after` (apps/mobile/modules/transcript/
/// src/diff.ts). Rows are matched by id; a changed version is an update.
/// When the shared rows changed order, it resets.
public enum RowDiff {
  public static func ops(_ before: [RowSpec], _ after: [RowSpec]) -> [TranscriptOp] {
    if before.isEmpty { return after.isEmpty ? [] : [.reset(after)] }
    // Streaming changes the tail: skip the shared prefix and suffix cheaply.
    func same(_ a: RowSpec, _ b: RowSpec) -> Bool { a.id == b.id && a.version == b.version }
    var head = 0
    while head < before.count && head < after.count && same(before[head], after[head]) { head += 1 }
    var tail = 0
    while tail < before.count - head && tail < after.count - head
      && same(before[before.count - 1 - tail], after[after.count - 1 - tail])
    {
      tail += 1
    }
    if head == before.count && head == after.count { return [] }
    if head > 0 || tail > 0 {
      guard let ops = middle(Array(before[head..<(before.count - tail)]), Array(after[head..<(after.count - tail)])) else {
        return [.reset(after)]
      }
      return ops.map { op in
        // Re-anchor inserts that start the middle region.
        if case let .insert(nil, rows) = op, head > 0 { return .insert(after: after[head - 1].id, rows) }
        if case let .append(rows) = op, tail > 0 { return .insert(after: anchor(before: rows[0], in: after), rows) }
        return op
      }
    }
    return middle(before, after) ?? [.reset(after)]
  }

  private static func anchor(before row: RowSpec, in after: [RowSpec]) -> String? {
    guard let index = after.firstIndex(where: { $0.id == row.id }), index > 0 else { return nil }
    return after[index - 1].id
  }

  private static func middle(_ before: [RowSpec], _ after: [RowSpec]) -> [TranscriptOp]? {
    if before.isEmpty { return after.isEmpty ? [] : [.append(after)] }
    let nextIds = Set(after.map(\.id))
    var previous: [String: RowSpec] = [:]
    for row in before { previous[row.id] = row }
    let kept = before.filter { nextIds.contains($0.id) }.map(\.id)
    let order = after.filter { previous[$0.id] != nil }.map(\.id)
    if kept != order { return nil }
    var ops: [TranscriptOp] = []
    let removed = before.filter { !nextIds.contains($0.id) }.map(\.id)
    if !removed.isEmpty { ops.append(.remove(removed)) }
    let updated = after.filter { row in previous[row.id].map { $0.version != row.version } ?? false }
    if !updated.isEmpty { ops.append(.update(updated)) }
    // Runs of new rows go after the row before them (or at the top).
    var i = 0
    while i < after.count {
      if previous[after[i].id] != nil {
        i += 1
        continue
      }
      let start = i
      while i < after.count && previous[after[i].id] == nil { i += 1 }
      let rows = Array(after[start..<i])
      if start == 0 {
        ops.append(.insert(after: nil, rows))
      } else if i == after.count {
        ops.append(.append(rows))
      } else {
        ops.append(.insert(after: after[start - 1].id, rows))
      }
    }
    return ops
  }
}
