import { describe, expect, it } from "vitest";
import { diffLines, fileDiffModel, hunkRows, splitLines, type DiffLine, type DiffRow } from "../diff";

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const text = (items: string[]) => items.join("\n") + "\n";
const shape = (rows: DiffRow[]) => rows.map((row) => (row.kind === "hunk" ? row.text : `${{ add: "+", del: "-", context: " " }[row.kind]}${row.text}`));

/** Both sides rebuilt from a diff: the old file from context and deletions,
 * the new one from context and additions. */
function sides(diff: DiffLine[]) {
  return {
    before: diff.filter((line) => line.kind !== "add").map((line) => line.text),
    after: diff.filter((line) => line.kind !== "del").map((line) => line.text),
  };
}

describe("splitting lines", () => {
  it("drops the final newline and carriage returns", () => {
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("parsing a file diff into rows", () => {
  it("shows a changed line with three lines of context under a hunk header", () => {
    const before = lines(10);
    const after = [...before];
    after[4] = "line 5 changed";
    const model = fileDiffModel(text(before), text(after));
    expect(model.additions).toBe(1);
    expect(model.deletions).toBe(1);
    expect(shape(model.rows)).toEqual([
      "@@ -2,7 +2,7 @@",
      " line 2",
      " line 3",
      " line 4",
      "-line 5",
      "+line 5 changed",
      " line 6",
      " line 7",
      " line 8",
    ]);
  });

  it("numbers old and new lines like git", () => {
    const model = fileDiffModel("a\nb\nc\n", "a\nx\nb\nc\n");
    const rows = model.rows.filter((row) => row.kind !== "hunk") as DiffLine[];
    expect(rows.map((row) => [row.kind, row.oldNumber, row.newNumber])).toEqual([
      ["context", 1, 1],
      ["add", null, 2],
      ["context", 2, 3],
      ["context", 3, 4],
    ]);
    expect(model.rows[0]).toMatchObject({ kind: "hunk", text: "@@ -1,3 +1,4 @@" });
  });

  it("splits distant changes into separate hunks", () => {
    const before = lines(30);
    const after = [...before];
    after[2] = "early";
    after[25] = "late";
    const hunks = fileDiffModel(text(before), text(after)).rows.filter((row) => row.kind === "hunk");
    expect(hunks.map((row) => row.text)).toEqual(["@@ -1,6 +1,6 @@", "@@ -23,7 +23,7 @@"]);
  });

  it("merges changes whose context overlaps", () => {
    const before = lines(20);
    const after = [...before];
    after[5] = "a";
    after[10] = "b";
    expect(fileDiffModel(text(before), text(after)).rows.filter((row) => row.kind === "hunk")).toHaveLength(1);
  });

  it("shows a new file as one hunk from an empty side", () => {
    const model = fileDiffModel("", "one\ntwo\nthree\n");
    expect(shape(model.rows)).toEqual(["@@ -0,0 +1,3 @@", "+one", "+two", "+three"]);
    expect(model.additions).toBe(3);
  });

  it("shows a deleted file as removals", () => {
    const model = fileDiffModel("gone\nalso gone\n", "");
    expect(shape(model.rows)).toEqual(["@@ -1,2 +0,0 @@", "-gone", "-also gone"]);
    expect(model.deletions).toBe(2);
  });

  it("uses git's single-line range form", () => {
    expect(shape(fileDiffModel("a\n", "b\n").rows)[0]).toBe("@@ -1 +1 @@");
  });

  it("has no rows when nothing changed", () => {
    expect(fileDiffModel("same\n", "same\n").rows).toEqual([]);
  });

  it("gives every row a unique key", () => {
    const before = lines(40);
    const after = before.map((line, i) => (i % 7 === 0 ? `${line}!` : line));
    const keys = fileDiffModel(text(before), text(after)).rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rebuilds both sides exactly from random edits", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 200; round++) {
      const alphabet = ["a", "b", "c", "d", "e"];
      const before = Array.from({ length: Math.floor(random() * 30) }, () => alphabet[Math.floor(random() * alphabet.length)]);
      const after = before
        .filter(() => random() > 0.2)
        .flatMap((line) => (random() > 0.8 ? [line, alphabet[Math.floor(random() * alphabet.length)]] : [line]));
      expect(sides(diffLines(before, after))).toEqual({ before, after });
    }
  });

  it("finds a minimal script for small inputs", () => {
    const diff = diffLines(["a", "b", "c", "a", "b", "b", "a"], ["c", "b", "a", "b", "a", "c"]);
    // Myers' paper example: D = 5.
    expect(diff.filter((line) => line.kind !== "context")).toHaveLength(5);
  });

  it("falls back to one replacement past its budget and still rebuilds both sides", () => {
    const before = lines(3000, "old");
    const after = lines(3000, "new");
    const diff = diffLines(before, after);
    expect(sides(diff)).toEqual({ before, after });
    expect(diff.slice(0, 3000).every((line) => line.kind === "del")).toBe(true);
  });

  it("hunks need no context lines when asked for none", () => {
    const rows = hunkRows(diffLines(["a", "b", "c"], ["a", "x", "c"]), 0);
    expect(shape(rows)).toEqual(["@@ -2 +2 @@", "-b", "+x"]);
  });
});
