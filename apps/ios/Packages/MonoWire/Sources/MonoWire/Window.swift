import Foundation

// Windowed sync and transit truncation (packages/core/src/window.ts, 06 §6.7).

public enum SessionWindow {
  public static let defaultTailTurns = 20
  public static let maxTailTurns = 200
  static let maxPreviewLines = 400
  static let maxAgentSteps = 100

  /// Index of every block that opens a turn (a submitted user block).
  public static func turnStarts(_ blocks: [Block]) -> [Int] {
    blocks.indices.filter { blocks[$0].role == .user && !blocks[$0].isDraft }
  }

  /// Index of the user block that opens the Nth-from-last turn, or 0.
  public static func startOfNthLastTurn(_ blocks: [Block], _ turns: Int) -> Int {
    let starts = turnStarts(blocks)
    let n = max(1, min(maxTailTurns, turns))
    return starts.count >= n ? starts[starts.count - n] : 0
  }

  public static func meta(_ blocks: [Block], start: Int) -> WindowMeta {
    var olderTurns = 0
    for i in 0..<min(start, blocks.count) where blocks[i].role == .user && !blocks[i].isDraft { olderTurns += 1 }
    return WindowMeta(anchor: start < blocks.count ? blocks[start].id : nil, olderTurns: olderTurns, olderBlocks: start)
  }

  /// Where a window starts. `reset` means the anchor no longer exists.
  public static func start(_ blocks: [Block], _ window: SyncWindow) -> (start: Int, reset: Bool) {
    if let anchor = window.anchor, !anchor.isEmpty {
      if let index = blocks.firstIndex(where: { $0.id == anchor }) { return (index, false) }
      return (startOfNthLastTurn(blocks, window.tailTurns ?? defaultTailTurns), true)
    }
    return (startOfNthLastTurn(blocks, window.tailTurns ?? defaultTailTurns), false)
  }

  /// The `turns` turns that end just before block `before`.
  public static func older(_ blocks: [Block], before: String, turns: Int) -> (blocks: [Block], olderTurns: Int) {
    guard let end = blocks.firstIndex(where: { $0.id == before }) else { return ([], 0) }
    let starts = turnStarts(blocks).filter { $0 < end }
    let n = max(1, min(maxTailTurns, turns))
    let start = starts.count > n ? starts[starts.count - n] : 0
    return (Array(blocks[start..<end]), max(0, starts.count - n))
  }

  /// Cuts a block down for transit. `chars` is the full block's JSON length,
  /// which only the host's serializer knows exactly; pass a measure.
  public static func truncate(_ block: Block, max: Int, length: (Block) -> Int = jsonLength) -> Block {
    guard max > 0 else { return block }
    let half = max / 2
    var changed = false
    var next = block
    if block.text.jsLength > max {
      next.text = block.text.jsSlice(0, max)
      changed = true
    }
    if var tool = block.tool {
      if let detail = tool.detail, detail.jsLength > half {
        tool.detail = detail.jsSlice(-half)
        changed = true
      }
      if var preview = tool.preview {
        if let output = preview.output, output.jsLength > half {
          preview.output = output.jsSlice(-half)
          changed = true
        }
        if let lines = preview.lines, lines.count > maxPreviewLines {
          preview.lines = Array(lines.prefix(maxPreviewLines))
          changed = true
        }
        tool.preview = preview
      }
      next.tool = tool
    }
    if let run = block.agentRun {
      let steps = run.steps.suffix(maxAgentSteps).map { step -> AgentStep in
        var cut = step
        if cut.text.jsLength > max { cut.text = cut.text.jsSlice(0, max) }
        if let detail = cut.detail, detail.jsLength > half { cut.detail = detail.jsSlice(-half) }
        if let output = cut.preview?.output, output.jsLength > half { cut.preview?.output = output.jsSlice(-half) }
        if let lines = cut.preview?.lines, lines.count > maxPreviewLines { cut.preview?.lines = Array(lines.prefix(maxPreviewLines)) }
        return cut
      }
      if steps != run.steps {
        next.agentRun?.steps = Array(steps)
        changed = true
      }
    }
    guard changed else { return block }
    next.truncated = Block.Truncated(chars: length(block))
    return next
  }

  /// `JSON.stringify(block).length`, with the keys in the order the host
  /// wrote them unknown here; the length does not depend on key order.
  public static func jsonLength(_ block: Block) -> Int {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(block), let text = String(data: data, encoding: .utf8) else { return 0 }
    return text.jsLength
  }
}
