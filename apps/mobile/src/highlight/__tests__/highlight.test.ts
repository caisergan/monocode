import { afterEach, describe, expect, it, vi } from "vitest";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import { highlightCode, languageForPath, type HighlightedLine } from "../index";
import {
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  autoBackend,
  highlightWithBackend,
  setHighlightBackend,
  withinHighlightCap,
  type Backend,
} from "../backend";
import { themeStyle } from "../hljs";
import { LANGUAGES, type LanguageId } from "../languages";
import { SAMPLES, TS } from "./samples";

afterEach(() => {
  setHighlightBackend();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const texts = (lines: HighlightedLine[]) => lines.map((line) => line.map((token) => token.text).join(""));
const colorOf = (lines: HighlightedLine[], text: string) => lines.flat().find((token) => token.text === text)?.color;

describe("languageForPath", () => {
  it("maps extensions and file names to grammar names", () => {
    expect(languageForPath("src/app/index.tsx")).toBe("tsx");
    expect(languageForPath("host/engine.ts")).toBe("typescript");
    expect(languageForPath("C:\\work\\Main.KT")).toBe("kotlin");
    expect(languageForPath("scripts/build.sh")).toBe("shellscript");
    expect(languageForPath("/home/me/.zshrc")).toBe("shellscript");
    expect(languageForPath("Cargo.lock")).toBe("toml");
    expect(languageForPath("fix.patch")).toBe("diff");
  });

  it("returns undefined for files it doesn't highlight", () => {
    for (const path of ["notes.txt", "Makefile", "image.png", ".gitignore", "a.constructor", ""])
      expect(languageForPath(path)).toBeUndefined();
  });
});

describe("highlightCode", () => {
  it("colours TypeScript with the desktop's GitHub themes", async () => {
    const result = await highlightWithBackend(TS, { lang: "ts", scheme: "dark" });
    expect(result?.backend).toBe("shiki");
    expect(colorOf(result!.lines, "export")).toBe("#F97583");
    expect(colorOf(result!.lines, '"node:fs/promises"')).toBe("#9ECBFF");
    expect(colorOf(result!.lines, "// Tabs, trailing spaces, empty lines and non-ASCII text survive.")).toBe("#6A737D");
    expect(new Set(result!.lines.flat().map((token) => token.color)).size).toBeGreaterThan(3);
  });

  it("takes the language from the path when there is no usable fence name", async () => {
    const byPath = await highlightCode(TS, { path: "src/load.ts", scheme: "dark" });
    expect(byPath).toEqual(await highlightCode(TS, { lang: "typescript", scheme: "dark" }));
    expect(await highlightCode(TS, { lang: "nonsense", path: "src/load.ts", scheme: "dark" })).toEqual(byPath);
  });

  it("returns null for an unknown language, plain text, or no language", async () => {
    expect(await highlightCode("+++ ---", { lang: "brainfuck", scheme: "dark" })).toBeNull();
    expect(await highlightCode("let x = 1", { path: "notes.unknown", scheme: "dark" })).toBeNull();
    expect(await highlightCode("let x = 1", { lang: "text", path: "a.ts", scheme: "dark" })).toBeNull();
    expect(await highlightCode("let x = 1", { scheme: "light" })).toBeNull();
  });

  it("gives dark and light different colours", async () => {
    const dark = (await highlightCode(TS, { lang: "ts", scheme: "dark" }))!;
    const light = (await highlightCode(TS, { lang: "ts", scheme: "light" }))!;
    expect(texts(dark)).toEqual(texts(light));
    expect(colorOf(dark, "export")).toBe("#F97583");
    expect(colorOf(light, "export")).toBe("#D73A49");
    expect(colorOf(dark, '"utf8"')).toBe("#9ECBFF");
    expect(colorOf(light, '"utf8"')).toBe("#032F62");
    const colors = (lines: HighlightedLine[]) => new Set(lines.flat().map((token) => token.color));
    // Only the comment grey is shared by the two themes.
    expect([...colors(dark)].filter((color) => colors(light).has(color))).toEqual(["#6A737D"]);
  });

  it("returns null above the size cap", async () => {
    expect(await highlightCode("x".repeat(MAX_HIGHLIGHT_CHARS + 1), { lang: "ts", scheme: "dark" })).toBeNull();
    expect(await highlightCode("\n".repeat(MAX_HIGHLIGHT_LINES), { lang: "ts", scheme: "dark" })).toBeNull();
    const atCap = Array.from({ length: MAX_HIGHLIGHT_LINES }, (_, i) => `let v${i} = ${i};`).join("\n");
    expect(atCap.length).toBeLessThanOrEqual(MAX_HIGHLIGHT_CHARS);
    expect(await highlightCode(atCap, { lang: "ts", scheme: "dark" })).toHaveLength(MAX_HIGHLIGHT_LINES);
  });

  it("keeps a very long line as one plain run", async () => {
    const long = `const s = "${"a".repeat(3_000)}";`;
    const [line] = (await highlightCode(long, { lang: "ts", scheme: "dark" }))!;
    expect(line).toHaveLength(1);
    expect(line[0].text).toBe(long);
  });

  it.each<Backend>(["shiki", "highlightjs"])("joins %s tokens back to every source line exactly", async (backend) => {
    setHighlightBackend(backend);
    for (const lang of LANGUAGES) {
      const code = SAMPLES[lang];
      const result = await highlightWithBackend(code, { lang, scheme: "dark" });
      expect(result?.backend, lang).toBe(backend);
      expect(texts(result!.lines), lang).toEqual(code.split("\n"));
      expect(result!.lines.flat().every((token) => token.text.length > 0), lang).toBe(true);
      expect(result!.lines.flat().some((token) => token.color !== result!.lines[0][0]?.color), lang).toBe(true);
    }
    // Windows line breaks split like `\n`, and a lone `\r` stays in the text.
    const crlf = "let a = 1;\r\n\tlet b = 'x\r';\r\n";
    const result = await highlightWithBackend(crlf, { lang: "ts", scheme: "light" });
    expect(texts(result!.lines)).toEqual(["let a = 1;", "\tlet b = 'x\r';", ""]);
  });

  it("falls back to highlight.js with the theme's colours when Shiki fails to start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setHighlightBackend("auto", { startShiki: () => Promise.reject(new Error("no regex engine")) });
    const dark = await highlightWithBackend(TS, { lang: "typescript", scheme: "dark" });
    expect(dark?.backend).toBe("highlightjs");
    expect(texts(dark!.lines)).toEqual(TS.split("\n"));
    expect(colorOf(dark!.lines, "export")).toBe(themeStyle(githubDark, "keyword").color);
    expect(colorOf(dark!.lines, "export")).toBe("#F97583");
    const light = await highlightCode(TS, { lang: "typescript", scheme: "light" });
    expect(colorOf(light!, "export")).toBe(themeStyle(githubLight, "keyword").color);
    expect(colorOf(light!, '"utf8"')).toBe(themeStyle(githubLight, "string").color);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Shiki failed"), "no regex engine");
  });

  it("moves only the language Shiki threw for to highlight.js", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tokenize = vi.fn(async (code: string, lang: LanguageId) => {
      if (lang === "python") throw new SyntaxError("Invalid regular expression");
      return code.split("\n").map((text) => [{ text, color: "#123456" }]);
    });
    setHighlightBackend("auto", { startShiki: async () => ({ tokenize }) });
    expect((await highlightWithBackend("x = 1", { lang: "py", scheme: "dark" }))?.backend).toBe("highlightjs");
    expect((await highlightWithBackend("y = 2", { lang: "py", scheme: "dark" }))?.backend).toBe("highlightjs");
    expect((await highlightWithBackend("let z = 3", { lang: "ts", scheme: "dark" }))?.backend).toBe("shiki");
    expect(tokenize.mock.calls.map(([, lang]) => lang)).toEqual(["python", "typescript"]);
  });

  it("caps input by characters and by lines", () => {
    expect(withinHighlightCap("")).toBe(true);
    expect(withinHighlightCap("x".repeat(MAX_HIGHLIGHT_CHARS))).toBe(true);
    expect(withinHighlightCap("x".repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(false);
    expect(withinHighlightCap("\n".repeat(MAX_HIGHLIGHT_LINES - 1))).toBe(true);
    expect(withinHighlightCap("\n".repeat(MAX_HIGHLIGHT_LINES))).toBe(false);
  });

  it("returns null when Shiki is forced and fails", async () => {
    setHighlightBackend("shiki", { startShiki: () => Promise.reject(new Error("no regex engine")) });
    expect(await highlightCode(TS, { lang: "ts", scheme: "dark" })).toBeNull();
  });
});

describe("backend selection", () => {
  it("picks highlight.js on Hermes and Shiki elsewhere", () => {
    expect(autoBackend({ HermesInternal: {} })).toBe("highlightjs");
    expect(autoBackend({})).toBe("shiki");
    expect(autoBackend({ HermesInternal: undefined })).toBe("shiki");
    // Vitest runs on Node.
    expect(autoBackend()).toBe("shiki");
  });

  it("uses highlight.js in auto mode on Hermes without starting Shiki", async () => {
    const startShiki = vi.fn(() => Promise.reject(new Error("not expected")));
    setHighlightBackend("auto", { startShiki });
    vi.stubGlobal("HermesInternal", {});
    const result = await highlightWithBackend(TS, { lang: "ts", scheme: "dark" });
    expect(result?.backend).toBe("highlightjs");
    expect(texts(result!.lines)).toEqual(TS.split("\n"));
    expect(colorOf(result!.lines, "export")).toBe("#F97583");
    expect(startShiki).not.toHaveBeenCalled();
  });

  it("uses Shiki in auto mode elsewhere", async () => {
    expect((await highlightWithBackend(TS, { lang: "ts", scheme: "dark" }))?.backend).toBe("shiki");
  });

  it("still honours a forced backend on Hermes", async () => {
    vi.stubGlobal("HermesInternal", {});
    setHighlightBackend("shiki");
    expect((await highlightWithBackend(TS, { lang: "ts", scheme: "dark" }))?.backend).toBe("shiki");
  });
});
