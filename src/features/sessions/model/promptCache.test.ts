import { describe, expect, it } from "vitest";
import {
  PROMPT_CACHE_MIN_CONTEXT,
  promptCacheExpired,
  promptCacheState,
  promptCacheTooltip,
  promptCacheWorthWarning,
} from "./promptCache";
import type { Block } from "./session";

const HOUR = 3_600_000;

function turn(
  id: string,
  startedAt: number,
  durationMs: number | undefined,
  turnMetrics?: Block["turnMetrics"],
): Block {
  return {
    id,
    role: "user",
    text: "",
    startedAt,
    ...(durationMs != null ? { durationMs } : {}),
    ...(turnMetrics ? { turnMetrics } : {}),
  };
}

describe("promptCacheState", () => {
  it("expires one TTL after the last cached turn ends", () => {
    const state = promptCacheState([
      turn("u1", 0, 5_000, { cacheWriteTokens: 900, cacheTtlSeconds: 3600 }),
      { id: "a1", role: "assistant", text: "hi" },
      turn("u2", 60_000, 10_000, { cacheReadTokens: 900 }),
    ]);
    expect(state).toEqual({
      ttlMs: HOUR,
      lastUsedAt: 70_000,
      expiresAt: 70_000 + HOUR,
    });
    // Warns 30s early: MonoCode sees the turn end after the last request.
    expect(promptCacheExpired(state, 40_000 + HOUR - 1)).toBe(false);
    expect(promptCacheExpired(state, 40_000 + HOUR)).toBe(true);
  });

  it("credits metrics on a message sent mid-turn to that turn", () => {
    const state = promptCacheState([
      turn("u1", 0, 20_000),
      {
        id: "u2",
        role: "user",
        text: "",
        sentAt: 5_000,
        turnMetrics: { cacheReadTokens: 100, cacheTtlSeconds: 300 },
      },
    ]);
    expect(state).toMatchObject({ lastUsedAt: 20_000, ttlMs: 300_000 });
  });

  it("keeps the last tier when a later turn only read the cache", () => {
    expect(
      promptCacheState([
        turn("u1", 0, 1_000, { cacheWriteTokens: 50, cacheTtlSeconds: 300 }),
        turn("u2", 10_000, 1_000, { cacheReadTokens: 50 }),
      ]),
    ).toMatchObject({ ttlMs: 300_000, lastUsedAt: 11_000 });
  });

  it("ignores turns that never touched the cache or are still running", () => {
    expect(
      promptCacheState([
        turn("u1", 0, 1_000, { cacheWriteTokens: 50, cacheTtlSeconds: 300 }),
        turn("u2", 10_000, 1_000),
        turn("u3", 20_000, undefined, { cacheReadTokens: 50 }),
      ]),
    ).toMatchObject({ lastUsedAt: 1_000 });
  });

  it("returns undefined without a reported tier", () => {
    expect(
      promptCacheState([turn("u1", 0, 1_000, { cacheReadTokens: 50 })]),
    ).toBeUndefined();
    expect(promptCacheExpired(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe("promptCacheTooltip", () => {
  it("says how long the session idled and what the next message costs", () => {
    const state = { ttlMs: HOUR, lastUsedAt: 0, expiresAt: HOUR };
    expect(promptCacheTooltip(state, HOUR + 12 * 60_000, 164_000)).toEqual({
      headline: "Prompt cache expired",
      detail:
        "Idle for 1h 12m. The provider keeps this session's cache for 1 hour after the last request.",
      consequence:
        "Your next message re-sends about 164K tokens of context uncached, so it uses more of your limits and takes longer to start.",
    });
    expect(
      promptCacheTooltip({ ...state, ttlMs: 300_000 }, 7 * 60_000).detail,
    ).toContain("for 5 minutes");
  });
});

describe("promptCacheWorthWarning", () => {
  it("skips small contexts but warns when the size is unknown", () => {
    expect(promptCacheWorthWarning(PROMPT_CACHE_MIN_CONTEXT - 1)).toBe(false);
    expect(promptCacheWorthWarning(PROMPT_CACHE_MIN_CONTEXT)).toBe(true);
    expect(promptCacheWorthWarning(undefined)).toBe(true);
  });
});
