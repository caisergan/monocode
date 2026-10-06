import { formatTokens } from "./contextUsage";
import type { Block } from "./session";

/**
 * Tokens the session has spent across every turn so far.
 *
 * Unlike the context level this is a running total, so compaction never lowers
 * it. Input splits into `uncached`, the prompt tokens the model processed
 * fresh (including those it wrote to the cache), and `cacheRead`, the ones
 * served from the cache.
 */
export type SessionTokenTotals = {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

/**
 * Sum the per-turn metrics on the session's user blocks.
 *
 * Deriving the total from the blocks keeps it persisted for free and stays
 * right when a harness reports a turn's metrics more than once. Claude reports
 * `input_tokens` without the cached share, so cache writes are added to it to
 * count every token not read from the cache.
 */
export function sessionTokenTotals(
  blocks: readonly Block[],
): SessionTokenTotals | undefined {
  const totals: SessionTokenTotals = {
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  for (const block of blocks) {
    const metrics = block.role === "user" ? block.turnMetrics : undefined;
    if (!metrics) continue;
    const cacheWrite = metrics.cacheWriteTokens ?? 0;
    totals.uncached += (metrics.inputTokens ?? 0) + cacheWrite;
    totals.cacheRead += metrics.cacheReadTokens ?? 0;
    totals.cacheWrite += cacheWrite;
    totals.output += metrics.outputTokens ?? 0;
  }
  return totals.uncached > 0 || totals.cacheRead > 0 || totals.output > 0
    ? totals
    : undefined;
}

/** Hover text: "Session tokens" over "120K uncached · 5.8M cached · 45K output". */
export function sessionTokensTooltip(totals: SessionTokenTotals): {
  headline: string;
  detail: string;
} {
  return {
    headline: "Session tokens",
    detail: [
      `${formatTokens(totals.uncached)} uncached`,
      `${formatTokens(totals.cacheRead)} cached`,
      `${formatTokens(totals.output)} output`,
    ].join(" · "),
  };
}
