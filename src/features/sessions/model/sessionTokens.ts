import { formatTokens } from "./contextUsage";
import type { Block } from "./session";

/**
 * Tokens the session has spent across every turn so far.
 *
 * Unlike the context level this is a running total, so compaction never lowers
 * it. `input` counts every prompt token the model read, cached or not; the
 * cache fields say how much of it was served from or written to the cache.
 */
export type SessionTokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Sum the per-turn metrics on the session's user blocks.
 *
 * Deriving the total from the blocks keeps it persisted for free and stays
 * right when a harness reports a turn's metrics more than once. Claude reports
 * `input_tokens` without the cached share, so cached reads and writes are added
 * back to make `input` the whole prompt.
 */
export function sessionTokenTotals(
  blocks: readonly Block[],
): SessionTokenTotals | undefined {
  const totals: SessionTokenTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const block of blocks) {
    const metrics = block.role === "user" ? block.turnMetrics : undefined;
    if (!metrics) continue;
    const cacheRead = metrics.cacheReadTokens ?? 0;
    const cacheWrite = metrics.cacheWriteTokens ?? 0;
    totals.input += (metrics.inputTokens ?? 0) + cacheRead + cacheWrite;
    totals.output += metrics.outputTokens ?? 0;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
  }
  return totals.input > 0 || totals.output > 0 ? totals : undefined;
}

/** Hover text: "Session tokens" over "1.2M input (1.1M cached) · 45K output". */
export function sessionTokensTooltip(totals: SessionTokenTotals): {
  headline: string;
  detail: string;
} {
  const cached = totals.cacheRead
    ? ` (${formatTokens(totals.cacheRead)} cached)`
    : "";
  return {
    headline: "Session tokens",
    detail: `${formatTokens(totals.input)} input${cached} · ${formatTokens(totals.output)} output`,
  };
}
