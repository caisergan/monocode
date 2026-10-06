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
  it("sums every user turn and folds cache into input", () => {
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
      input: 3_215,
      output: 500,
      cacheRead: 3_000,
      cacheWrite: 200,
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
  it("names the cached share of input", () => {
    expect(
      sessionTokensTooltip({
        input: 1_200_000,
        output: 45_000,
        cacheRead: 1_100_000,
        cacheWrite: 0,
      }),
    ).toEqual({
      headline: "Session tokens",
      detail: "1.2M input (1.1M cached) · 45K output",
    });
  });

  it("leaves out the cached note without cache reads", () => {
    expect(
      sessionTokensTooltip({
        input: 980,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
      }).detail,
    ).toBe("980 input · 12 output");
  });
});
