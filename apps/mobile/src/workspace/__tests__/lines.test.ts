import { describe, expect, it } from "vitest";
import { columnsFor, columnsOf, displayText, displayTokens, markSpans, MAX_LINE_CHARS, rowHeight, wrapCount, wrapSpans, type CodeSpan } from "../lines";

const join = (spans: CodeSpan[]) => spans.map((span) => span.text).join("");

describe("display text", () => {
  it("expands tabs to two spaces", () => {
    expect(displayText("\tif (x)\t{")).toBe("  if (x)  {");
  });

  it("cuts very long lines with an ellipsis", () => {
    const shown = displayText("x".repeat(MAX_LINE_CHARS + 500));
    expect(shown).toHaveLength(MAX_LINE_CHARS + 1);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("treats tokens the same way, so highlighted and plain lines match", () => {
    const raw = "\tconst x = 1;" + "y".repeat(MAX_LINE_CHARS);
    const tokens = displayTokens([
      { text: "\tconst", color: "#f00" },
      { text: " x = 1;" + "y".repeat(MAX_LINE_CHARS), color: "#0f0" },
    ]);
    expect(tokens.map((token) => token.text).join("")).toBe(displayText(raw));
    expect(tokens[0]).toEqual({ text: "  const", color: "#f00" });
  });
});

describe("find marks on spans", () => {
  it("splits spans at mark edges, across tokens", () => {
    const spans = markSpans(
      [
        { text: "const ", color: "a" },
        { text: "token", color: "b" },
      ],
      [{ start: 4, end: 8, current: true }],
    );
    expect(spans).toEqual([
      { text: "cons", color: "a" },
      { text: "t ", color: "a", mark: "current" },
      { text: "to", color: "b", mark: "current" },
      { text: "ken", color: "b" },
    ]);
  });

  it("leaves lines without marks alone", () => {
    const spans = [{ text: "plain" }];
    expect(markSpans(spans, undefined)).toBe(spans);
  });
});

describe("wrapping at a column limit", () => {
  it("counts the lines it draws", () => {
    for (const text of ["", "short", "x".repeat(40), "x".repeat(41), "x".repeat(100), "中文字符".repeat(7)]) {
      const lines = wrapSpans([{ text }], 20);
      expect(lines).toHaveLength(wrapCount(text, 20));
      expect(lines.map(join).join("")).toBe(text);
      for (const line of lines) expect(columnsOf(join(line))).toBeLessThanOrEqual(20);
    }
  });

  it("counts wide characters as two columns", () => {
    expect(columnsOf("ab中")).toBe(4);
    expect(wrapCount("中".repeat(11), 20)).toBe(2);
  });

  it("is one line when wrapping is off", () => {
    expect(wrapCount("x".repeat(500), undefined)).toBe(1);
    expect(wrapSpans([{ text: "x".repeat(500) }], undefined)).toHaveLength(1);
  });

  it("keeps token colours across a wrap", () => {
    const lines = wrapSpans([{ text: "abcdef", color: "red" }], 4);
    expect(lines).toEqual([[{ text: "abcd", color: "red" }], [{ text: "ef", color: "red" }]]);
  });
});

describe("row geometry", () => {
  it("grows a row by one text line per wrapped line", () => {
    expect(rowHeight(22, 18, 1)).toBe(22);
    expect(rowHeight(22, 18, 3)).toBe(58);
    expect(rowHeight(19, 19, 2)).toBe(38);
  });

  it("fits whole columns of mono text", () => {
    expect(columnsFor(300, 13)).toBe(Math.floor(300 / (13 * 0.62)));
    expect(columnsFor(10, 13)).toBe(8);
  });
});
