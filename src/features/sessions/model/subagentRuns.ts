import type { AgentRunUsage, Block } from "./session";
import {
  isSubagentBlock,
  subagentName,
  toolCallState,
} from "./transcriptActivity";

/** Where a delegated run stands, as the dock and its sheet tell it. */
export type SubagentRunState = "running" | "done" | "failed" | "stopped";

/**
 * Every delegated run of the latest turn, in the order they started. Walks
 * back from the end and stops at the message that opened the turn, so a long
 * session costs only its last turn. A message sent into a running turn
 * belongs to that turn and is walked past.
 */
export function latestTurnSubagents(blocks: readonly Block[]): Block[] {
  const runs: Block[] = [];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role === "user" && !block.sentAt && !block.internal) break;
    if (isSubagentBlock(block)) runs.push(block);
  }
  return runs.reverse();
}

/**
 * `live` is whether the session is still working. A run left pending once the
 * session has stopped never reported back, so it reads as stopped.
 */
export function subagentRunState(
  block: Block,
  live: boolean,
): SubagentRunState {
  const state = toolCallState(block);
  if (state === "pending") return live ? "running" : "stopped";
  if (block.agentRun?.stopped) return "stopped";
  return state === "rejected" ? "failed" : "done";
}

/**
 * Names of the runs still working in a live session, for the sidebar's count.
 * A session that has stopped has none running.
 */
export function runningSubagentNames(
  blocks: readonly Block[],
  live: boolean,
): string[] {
  if (!live) return [];
  return latestTurnSubagents(blocks)
    .filter((block) => subagentRunState(block, true) === "running")
    .map(subagentName);
}

/** How long the run has worked, or worked for, when the app knows. */
export function subagentElapsedMs(
  block: Block,
  now: number,
  running: boolean,
): number | undefined {
  const run = block.agentRun;
  if (!running && run?.usage?.durationMs != null) return run.usage.durationMs;
  if (run?.startedAt == null) return undefined;
  const end = run.endedAt ?? (running ? now : undefined);
  if (end == null) return undefined;
  const elapsed = end - run.startedAt;
  // A run replayed from an import starts and ends in the same instant.
  return elapsed >= 1_000 ? elapsed : undefined;
}

/** Tokens across several runs, for the dock's running total. */
export function subagentTokenTotals(
  blocks: readonly Block[],
): Pick<AgentRunUsage, "uncached" | "cacheRead" | "output"> | undefined {
  let found = false;
  const totals = { uncached: 0, cacheRead: 0, output: 0 };
  for (const block of blocks) {
    const usage = block.agentRun?.usage;
    if (!usage) continue;
    found = true;
    totals.uncached += usage.uncached;
    totals.cacheRead += usage.cacheRead;
    totals.output += usage.output;
  }
  return found ? totals : undefined;
}

/**
 * The runs that get a chip of their own when not all fit. Order never
 * changes under the reader; what gives way first is the oldest finished run,
 * so work still going stays in view.
 */
export function visibleSubagents(
  blocks: readonly Block[],
  live: boolean,
  limit: number,
  /** A run that must keep its chip, e.g. the one whose sheet is open. */
  keep?: string,
): { visible: Block[]; hidden: Block[] } {
  if (blocks.length <= limit) return { visible: [...blocks], hidden: [] };
  const drop = new Set<Block>();
  const excess = blocks.length - limit;
  for (const block of blocks) {
    if (drop.size === excess) break;
    if (block.id === keep) continue;
    if (subagentRunState(block, live) !== "running") drop.add(block);
  }
  for (const block of blocks) {
    if (drop.size === excess) break;
    if (block.id !== keep) drop.add(block);
  }
  return {
    visible: blocks.filter((block) => !drop.has(block)),
    hidden: blocks.filter((block) => drop.has(block)),
  };
}
