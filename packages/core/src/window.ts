// Windowed sync and transit truncation (spec 06 §6.7).

import type { Block } from "./session";
import type { TruncatedBlock, WindowMeta } from "./wire";

export const DEFAULT_TAIL_TURNS = 20;
export const MAX_TAIL_TURNS = 200;
const MAX_PREVIEW_LINES = 400;
const MAX_AGENT_STEPS = 100;

/** Index of every block that opens a turn (a submitted user block). */
export function turnStarts(blocks: readonly Block[]): number[] {
  const starts: number[] = [];
  blocks.forEach((block, index) => {
    if (block.role === "user" && !block.draft) starts.push(index);
  });
  return starts;
}

/** Index of the user block that opens the Nth-from-last turn, or 0. */
export function startOfNthLastTurn(blocks: readonly Block[], turns: number): number {
  const starts = turnStarts(blocks);
  const n = Math.max(1, Math.min(MAX_TAIL_TURNS, Math.floor(turns)));
  return starts.length >= n ? starts[starts.length - n] : 0;
}

export function windowMeta(blocks: readonly Block[], start: number): WindowMeta {
  let olderTurns = 0;
  for (let i = 0; i < start; i++)
    if (blocks[i].role === "user" && !blocks[i].draft) olderTurns++;
  return { anchor: blocks[start]?.id ?? null, olderTurns, olderBlocks: start };
}

/** Where a window starts. `reset` means the anchor no longer exists. */
export function windowStart(
  blocks: readonly Block[],
  window: { anchor?: string; tailTurns?: number },
): { start: number; reset: boolean } {
  if (window.anchor) {
    const index = blocks.findIndex((block) => block.id === window.anchor);
    if (index >= 0) return { start: index, reset: false };
    return { start: startOfNthLastTurn(blocks, window.tailTurns ?? DEFAULT_TAIL_TURNS), reset: true };
  }
  return { start: startOfNthLastTurn(blocks, window.tailTurns ?? DEFAULT_TAIL_TURNS), reset: false };
}

/** The `turns` turns that end just before block `before`. */
export function olderBlocks(
  blocks: readonly Block[],
  before: string,
  turns: number,
): { blocks: Block[]; olderTurns: number } {
  const end = blocks.findIndex((block) => block.id === before);
  if (end < 0) return { blocks: [], olderTurns: 0 };
  const starts = turnStarts(blocks).filter((index) => index < end);
  const n = Math.max(1, Math.min(MAX_TAIL_TURNS, Math.floor(turns)));
  const start = starts.length > n ? starts[starts.length - n] : 0;
  return { blocks: blocks.slice(start, end), olderTurns: Math.max(0, starts.length - n) };
}

const head = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const tail = (text: string, max: number) => (text.length > max ? text.slice(-max) : text);

/** Cuts a block down for transit. Unchanged blocks keep their identity. */
export function truncateBlock(block: Block, max: number): TruncatedBlock {
  if (!(max > 0)) return block;
  const half = Math.floor(max / 2);
  let changed = false;
  const next: TruncatedBlock = { ...block };
  if (block.text.length > max) {
    next.text = head(block.text, max);
    changed = true;
  }
  if (block.tool) {
    const tool = { ...block.tool };
    if (tool.detail && tool.detail.length > half) {
      tool.detail = tail(tool.detail, half);
      changed = true;
    }
    if (tool.preview) {
      const preview = { ...tool.preview };
      if (preview.output && preview.output.length > half) {
        preview.output = tail(preview.output, half);
        changed = true;
      }
      if (preview.lines && preview.lines.length > MAX_PREVIEW_LINES) {
        preview.lines = preview.lines.slice(0, MAX_PREVIEW_LINES);
        changed = true;
      }
      tool.preview = preview;
    }
    next.tool = tool;
  }
  if (block.agentRun) {
    const steps = block.agentRun.steps.slice(-MAX_AGENT_STEPS).map((step) => {
      const cut = { ...step };
      if (cut.text.length > max) cut.text = head(cut.text, max);
      if (cut.detail && cut.detail.length > half) cut.detail = tail(cut.detail, half);
      if (cut.preview?.output && cut.preview.output.length > half)
        cut.preview = { ...cut.preview, output: tail(cut.preview.output, half) };
      if (cut.preview?.lines && cut.preview.lines.length > MAX_PREVIEW_LINES)
        cut.preview = { ...cut.preview, lines: cut.preview.lines.slice(0, MAX_PREVIEW_LINES) };
      return cut;
    });
    if (
      steps.length !== block.agentRun.steps.length ||
      JSON.stringify(steps) !== JSON.stringify(block.agentRun.steps)
    ) {
      next.agentRun = { ...block.agentRun, steps };
      changed = true;
    }
  }
  if (!changed) return block;
  next.truncated = { chars: JSON.stringify(block).length };
  return next;
}
