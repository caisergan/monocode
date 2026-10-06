import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { sessionTokenTotals, sessionTokensTooltip } from "./sessionTokens";

function user(id: string, turnMetrics?: Block["turnMetrics"]): Block {
  return {
    id,
    role: "user",
    text: "",
    ...(turnMetrics ? { turnMetrics } : {}),
  };
}

describe("sessionTokenTotals", () => {
  it("sums every user turn and splits cached input out", () => {
    const totals = sessionTokenTotals([
      user("u1", {
        inputTokens: 10,
        outputTokens: 400,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 200,
      }),
      { id: "a1", role: "assistant", text: "hi" },
      user("u2"),
      user("u3", { inputTokens: 5, outputTokens: 100, cacheReadTokens: 2_000 }),
    ]);
    expect(totals).toEqual({
      uncached: 215,
      cacheRead: 3_000,
      cacheWrite: 200,
      output: 500,
    });
  });

  it("ignores metrics on non-user blocks", () => {
    expect(
      sessionTokenTotals([
        {
          id: "a1",
          role: "assistant",
          text: "",
          turnMetrics: { inputTokens: 9, outputTokens: 9 },
        },
      ]),
    ).toBeUndefined();
  });

  it("is undefined until a turn reports tokens", () => {
    expect(sessionTokenTotals([])).toBeUndefined();
    expect(sessionTokenTotals([user("u1"), user("u2", {})])).toBeUndefined();
  });
});

describe("sessionTokensTooltip", () => {
  it("lists uncached, cached and output", () => {
    expect(
      sessionTokensTooltip({
        uncached: 120_000,
        cacheRead: 5_800_000,
        cacheWrite: 90_000,
        output: 45_000,
      }),
    ).toEqual({
      headline: "Session tokens",
      detail: "120K uncached · 5.8M cached · 45K output",
    });
  });
});
