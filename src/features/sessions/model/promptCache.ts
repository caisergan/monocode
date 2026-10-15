import { formatResetDuration } from "../../providers/model/rateLimits";
import { formatTokens } from "./contextUsage";
import type { Block } from "./session";

/**
 * When the provider's prompt cache for this conversation runs out.
 *
 * Every request reads the cached prefix and resets its timer, so the cache
 * lives until one TTL after the last turn that used it. Past that point the
 * next message re-sends the whole context uncached.
 */
export type PromptCacheState = {
  ttlMs: number;
  /** Epoch ms the last turn that used the cache finished. */
  lastUsedAt: number;
  expiresAt: number;
};

/**
 * Derive the cache window from the session's user blocks.
 *
 * A turn starts at a user block without `sentAt` and carries the duration;
 * messages sent mid-turn join it and may hold the turn's metrics instead.
 * Only harnesses that report the cache tier set `cacheTtlSeconds`, so the
 * rest return undefined rather than guess a lifetime.
 */
export function promptCacheState(
  blocks: readonly Block[],
): PromptCacheState | undefined {
  let ttlSeconds: number | undefined;
  let turnEnd: number | undefined;
  let turnCached = false;
  let lastUsedAt: number | undefined;
  const closeTurn = () => {
    if (turnCached && turnEnd != null) lastUsedAt = turnEnd;
  };
  for (const block of blocks) {
    if (block.role !== "user") continue;
    if (block.sentAt == null) {
      closeTurn();
      turnEnd =
        block.startedAt != null && block.durationMs != null
          ? block.startedAt + block.durationMs
          : undefined;
      turnCached = false;
    }
    const metrics = block.turnMetrics;
    if (!metrics) continue;
    if (
      (metrics.cacheReadTokens ?? 0) > 0 ||
      (metrics.cacheWriteTokens ?? 0) > 0
    ) {
      turnCached = true;
    }
    if (metrics.cacheTtlSeconds) ttlSeconds = metrics.cacheTtlSeconds;
  }
  closeTurn();
  if (!ttlSeconds || lastUsedAt == null) return undefined;
  const ttlMs = ttlSeconds * 1000;
  return { ttlMs, lastUsedAt, expiresAt: lastUsedAt + ttlMs };
}

/**
 * Treat the cache as gone a little before the computed moment.
 *
 * The expiry is measured from when MonoCode saw the turn end, which trails the
 * provider's last request, so a message sent at the edge may already miss.
 */
export const PROMPT_CACHE_EXPIRY_MARGIN_MS = 30_000;

/**
 * Below this much context a re-read costs little, so it is not worth a
 * warning. A fresh Claude Code session starts around 20K.
 */
export const PROMPT_CACHE_MIN_CONTEXT = 30_000;

/** When the warning should appear, margin included. */
export function promptCacheWarnAt(state: PromptCacheState): number {
  return state.expiresAt - PROMPT_CACHE_EXPIRY_MARGIN_MS;
}

export function promptCacheExpired(
  state: PromptCacheState | undefined,
  now: number,
): boolean {
  return state != null && now >= promptCacheWarnAt(state);
}

/** An unknown context size still warns; a small known one does not. */
export function promptCacheWorthWarning(contextUsed: number | undefined) {
  return contextUsed == null || contextUsed >= PROMPT_CACHE_MIN_CONTEXT;
}

/** Chats where the user turned off the send confirmation. In-memory only. */
const sendConfirmSkipped = new Set<string>();

export function skipPromptCacheSendConfirm(sessionId: string) {
  sendConfirmSkipped.add(sessionId);
}

export function promptCacheSendConfirmSkipped(sessionId: string | undefined) {
  return sessionId != null && sendConfirmSkipped.has(sessionId);
}

/** "5 minutes", "1 hour". */
function formatTtl(ttlMs: number): string {
  const minutes = Math.round(ttlMs / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * Hover text for an expired cache: what happened, then what it costs.
 *
 * `contextUsed` is the size of the prompt the next message will re-send.
 */
export function promptCacheTooltip(
  state: PromptCacheState,
  now: number,
  contextUsed?: number,
): { headline: string; detail: string; consequence: string } {
  const idle = formatResetDuration(now - state.lastUsedAt);
  const resend =
    contextUsed && contextUsed > 0
      ? `about ${formatTokens(contextUsed)} tokens of context`
      : "the whole context";
  return {
    headline: "Prompt cache expired",
    detail: `Idle for ${idle}. The provider keeps this session's cache for ${formatTtl(state.ttlMs)} after the last request.`,
    consequence: `Your next message re-sends ${resend} uncached, so it uses more of your limits and takes longer to start.`,
  };
}
