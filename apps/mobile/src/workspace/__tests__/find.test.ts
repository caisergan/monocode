import { describe, expect, it } from "vitest";
import { findCounter, findMatches, marksByLine, matchFrom, MAX_MATCHES, stepMatch } from "../find";

const lines = ["const token = refresh(Token);", "// no hits here", "TOKEN token"];

describe("find in file", () => {
  it("matches without case, every hit on a line, in reading order", () => {
    expect(findMatches(lines, "token")).toEqual([
      { line: 0, start: 6, end: 11 },
      { line: 0, start: 22, end: 27 },
      { line: 2, start: 0, end: 5 },
      { line: 2, start: 6, end: 11 },
    ]);
  });

  it("doesn't overlap matches", () => {
    expect(findMatches(["aaaa"], "aa")).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 2, end: 4 },
    ]);
  });

  it("finds nothing for an empty query", () => {
    expect(findMatches(lines, "")).toEqual([]);
  });

  it("stops at the match cap", () => {
    expect(findMatches(["x".repeat(MAX_MATCHES + 50)], "x")).toHaveLength(MAX_MATCHES);
  });
});

describe("the n of m counter", () => {
  it("counts from one", () => {
    expect(findCounter(0, 4)).toBe("1 of 4");
    expect(findCounter(3, 4)).toBe("4 of 4");
  });

  it("reads 0 of 0 without matches", () => {
    expect(findCounter(0, 0)).toBe("0 of 0");
  });

  it("clamps a stale index and marks a capped total", () => {
    expect(findCounter(9, 3)).toBe("3 of 3");
    expect(findCounter(0, MAX_MATCHES)).toBe(`1 of ${MAX_MATCHES}+`);
  });

  it("wraps next and previous around the ends", () => {
    expect(stepMatch(3, 4, 1)).toBe(0);
    expect(stepMatch(0, 4, -1)).toBe(3);
    expect(stepMatch(1, 4, 1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });

  it("starts a new search at the line being read", () => {
    const matches = findMatches(lines, "token");
    expect(matchFrom(matches, 1)).toBe(2);
    expect(matchFrom(matches, 0)).toBe(0);
    expect(matchFrom(matches, 9)).toBe(0);
  });

  it("groups marks by line and flags the current match", () => {
    const marks = marksByLine(findMatches(lines, "token"), 1);
    expect(marks.get(0)).toEqual([
      { start: 6, end: 11, current: false },
      { start: 22, end: 27, current: true },
    ]);
    expect(marks.get(1)).toBeUndefined();
    expect(marks.get(2)?.every((mark) => !mark.current)).toBe(true);
  });
});
