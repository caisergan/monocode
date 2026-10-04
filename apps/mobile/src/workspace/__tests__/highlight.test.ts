import { afterEach, describe, expect, it } from "vitest";
import { MAX_HIGHLIGHT_CHARS, setHighlightBackend, type Backend } from "../../highlight/backend";
import { fileDiffModel, splitLines } from "../diff";
import { findMatches, marksByLine } from "../find";
import { highlightDiff, highlightFile, highlightKey } from "../highlight";
import { displayText, displayTokens, markSpans, MAX_LINE_CHARS, wrapSpans, type CodeToken } from "../lines";

afterEach(() => setHighlightBackend());

const joined = (tokens: readonly CodeToken[]) => tokens.map((token) => token.text).join("");
const COMMENT = "#6A737D";
const KEYWORD = "#F97583";

const FILE = [
  'import { readFile } from "node:fs/promises";',
  "",
  "\tconst wide = \"漢字 and emoji 🎉\";",
  "/* a comment",
  "   that spans lines */",
  // After the comment: under load, Shiki's per-line time limit may stop
  // early on a line this long and drop the state that follows it.
  `const long = "${"x".repeat(MAX_LINE_CHARS + 200)}";`,
  "export async function load(path: string) {",
  '\treturn readFile(path, "utf8");',
  "}",
  "",
].join("\n");

describe("highlightKey", () => {
  it("is null for files the module doesn't highlight or input over the cap", () => {
    expect(highlightKey("dark", "notes.txt", "hello")).toBeNull();
    expect(highlightKey("dark", "Makefile", "all:")).toBeNull();
    expect(highlightKey("dark", "a.ts", "let a = 1;", "x".repeat(MAX_HIGHLIGHT_CHARS + 1))).toBeNull();
  });

  it("separates path, content and scheme", () => {
    const key = highlightKey("dark", "a.ts", "let a = 1;");
    expect(key).toBe(highlightKey("dark", "a.ts", "let a = 1;"));
    expect(key).not.toBe(highlightKey("light", "a.ts", "let a = 1;"));
    expect(key).not.toBe(highlightKey("dark", "b.ts", "let a = 1;"));
    expect(key).not.toBe(highlightKey("dark", "a.ts", "let a = 2;"));
    expect(highlightKey("dark", "a.ts", "ab", "c")).not.toBe(highlightKey("dark", "a.ts", "a", "bc"));
  });
});

describe.each<Backend>(["shiki", "highlightjs"])("with %s", (backend) => {
  it("gives the file viewer one token line per line, joining back to it", async () => {
    setHighlightBackend(backend);
    const lines = splitLines(FILE);
    const tokens = (await highlightFile(FILE, lines, "src/load.ts", "dark"))!;
    expect(tokens).toHaveLength(lines.length);
    tokens.forEach((line, index) => expect(joined(line!)).toBe(lines[index]));
    expect(tokens[0]!.find((token) => token.text === "import")?.color).toBe(KEYWORD);
    expect(tokens[4]!.every((token) => token.color === COMMENT)).toBe(true);
  });

  it("keeps every row's text and height when tokens and find marks arrive", async () => {
    setHighlightBackend(backend);
    const lines = splitLines(FILE);
    const shown = lines.map(displayText);
    const tokens = (await highlightFile(FILE, lines, "src/load.ts", "dark"))!;
    const marks = marksByLine(findMatches(shown, "a"), 3);
    for (const columns of [undefined, 9, 40]) {
      shown.forEach((text, index) => {
        const plain = wrapSpans(markSpans([{ text }], marks.get(index)), columns);
        const styled = wrapSpans(markSpans(displayTokens(tokens[index]!), marks.get(index)), columns);
        expect(styled.length, `line ${index} at ${columns}`).toBe(plain.length);
        expect(styled.map(joined)).toEqual(plain.map(joined));
        expect(styled.flat().filter((span) => span.mark).map((span) => span.text)).toEqual(
          plain.flat().filter((span) => span.mark).map((span) => span.text),
        );
      });
    }
  });

  it("highlights diff rows from whole files: deletions from the original, the rest from the current text", async () => {
    setHighlightBackend(backend);
    const original = ["/**", " * line 1", " * line 2", " * line 3", " * line 4", " * old wording", " * line 6", " */", "export const a = 1;", ""].join("\n");
    const current = original.replace("old wording", "new wording");
    const { rows } = fileDiffModel(original, current);
    const tokens = (await highlightDiff({ original, current }, rows, "src/a.ts", "dark"))!;
    expect(tokens).toHaveLength(rows.length);
    expect(rows[0].kind).toBe("hunk");
    expect(tokens[0]).toBeUndefined();
    // The hunk starts inside the block comment; only whole-file highlighting
    // knows that.
    const del = rows.findIndex((row) => row.kind === "del");
    const add = rows.findIndex((row) => row.kind === "add");
    expect(joined(tokens[del]!)).toBe(" * old wording");
    expect(joined(tokens[add]!)).toBe(" * new wording");
    for (const index of [del, add]) expect(tokens[index]!.every((token) => token.color === COMMENT)).toBe(true);
    const last = tokens[rows.length - 1]!;
    expect(joined(last)).toBe("export const a = 1;");
    expect(last.find((token) => token.text === "export")?.color).toBe(KEYWORD);
  });
});

describe("highlightDiff", () => {
  it("maps rows by old and new line numbers when lines move", async () => {
    const original = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", ""].join("\n");
    const current = ["const a = 1;", "const c = 3;", "const d = 4;", "const e = 5;", ""].join("\n");
    const { rows } = fileDiffModel(original, current);
    const tokens = (await highlightDiff({ original, current }, rows, "x.ts", "light"))!;
    rows.forEach((row, index) => {
      if (row.kind === "hunk") expect(tokens[index]).toBeUndefined();
      else expect(joined(tokens[index]!)).toBe(row.text);
    });
  });

  it("highlights an added file from the current text alone", async () => {
    const current = "export const a = 1;\n";
    const { rows } = fileDiffModel("", current);
    const tokens = (await highlightDiff({ original: "", current }, rows, "a.ts", "dark"))!;
    expect(joined(tokens[1]!)).toBe("export const a = 1;");
  });

  it("stays plain when either side is over the cap", async () => {
    const big = `${"let x = 1;\n".repeat(MAX_HIGHLIGHT_CHARS / 8)}`;
    const { rows } = fileDiffModel(big, "let x = 1;\n");
    expect(await highlightDiff({ original: big, current: "let x = 1;\n" }, rows, "a.ts", "dark")).toBeNull();
    expect(await highlightDiff({ original: "let x = 1;\n", current: big }, rows, "a.ts", "dark")).toBeNull();
  });

  it("stays plain for a language the module doesn't highlight", async () => {
    const { rows } = fileDiffModel("a\n", "b\n");
    expect(await highlightDiff({ original: "a\n", current: "b\n" }, rows, "notes.txt", "dark")).toBeNull();
    expect(await highlightFile("a\n", ["a"], "notes.txt", "dark")).toBeNull();
  });
});
