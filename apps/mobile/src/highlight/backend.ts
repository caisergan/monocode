// Picks the highlighter (12 §12.9): "auto" is highlight.js on Hermes and Shiki
// elsewhere, and Shiki falls back to highlight.js when it fails to start or
// throws for a language. Both load on first use, so importing the highlight
// module costs nothing until a block is highlighted.

import { languageForName, languageIdForPath, type LanguageId } from "./languages";
import type { HljsBackend } from "./hljs";
import type { ShikiBackend } from "./shiki";
import type { ColorScheme, HighlightedLine, HighlightToken } from "./types";

/** Larger input stays plain. Tokenizing is synchronous on the JS thread, and
 * the row builder highlights the first 400 lines of a block (12 §12.9). */
export const MAX_HIGHLIGHT_CHARS = 64 * 1024;
export const MAX_HIGHLIGHT_LINES = 1_000;

/** Whether `code` is within both caps, so callers can skip work that would
 * come back null. */
export function withinHighlightCap(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return false;
  let lines = 1;
  for (let at = code.indexOf("\n"); at >= 0; at = code.indexOf("\n", at + 1)) if (++lines > MAX_HIGHLIGHT_LINES) return false;
  return true;
}

export type Backend = "shiki" | "highlightjs";
export type BackendMode = "auto" | Backend;

export type HighlightOptions = { lang?: string; path?: string; scheme: ColorScheme };

/** "auto" on Hermes, while spike S1 (14) is open. A 400-line TypeScript file
 * takes Shiki 44 to 72 ms in Node and 190 to 340 ms with V8's JIT off, which
 * is closer to Hermes; highlight.js takes 6 to 8 ms and 18 to 30 ms. S1 asks
 * for under 50 ms on a phone. Flip this to "shiki" if S1 passes on the
 * iPhone 13. */
const HERMES_BACKEND: Backend = "highlightjs";

/** The backend "auto" starts with: HERMES_BACKEND on Hermes, Shiki elsewhere
 * (Node tests, web). */
export function autoBackend(global: object = globalThis): Backend {
  return (global as { HermesInternal?: unknown }).HermesInternal != null ? HERMES_BACKEND : "shiki";
}

const defaultStartShiki = () => import("./shiki").then((module) => module.startShiki());

let mode: BackendMode = "auto";
let startShiki: () => Promise<ShikiBackend> = defaultStartShiki;
let shiki: Promise<ShikiBackend> | undefined;
let hljs: Promise<HljsBackend> | undefined;
/** Languages Shiki threw for; they stay on highlight.js for this run. */
const shikiFailed = new Set<LanguageId>();

/** Internal, for tests and diagnostics: forces one backend, or replaces Shiki
 * start-up (for example with one that fails). No arguments restores both. */
export function setHighlightBackend(next: BackendMode = "auto", options: { startShiki?: () => Promise<ShikiBackend> } = {}): void {
  mode = next;
  startShiki = options.startShiki ?? defaultStartShiki;
  shiki = undefined;
  shikiFailed.clear();
}

function resolveLanguage(options: HighlightOptions): LanguageId | undefined {
  const named = options.lang ? languageForName(options.lang) : undefined;
  if (named === null) return undefined;
  return named ?? (options.path ? languageIdForPath(options.path) : undefined);
}

const sameStyle = (a: HighlightToken, b: HighlightToken) => a.color === b.color && a.fontStyle === b.fontStyle;

/** One line per source line. A line whose tokens don't join back to the source
 * exactly is replaced by one plain token, so callers can rely on the text. */
function fit(source: string[], highlighted: HighlightedLine[]): HighlightedLine[] {
  return source.map((text, index) => {
    const tokens = highlighted[index] ?? [];
    if (tokens.map((token) => token.text).join("") !== text) return text ? [{ text }] : [];
    const merged: HighlightedLine = [];
    for (const token of tokens) {
      if (!token.text) continue;
      const last = merged[merged.length - 1];
      if (last && sameStyle(last, token)) merged[merged.length - 1] = { ...last, text: last.text + token.text };
      else merged.push(token);
    }
    return merged;
  });
}

function warn(message: string, error: unknown) {
  console.warn(`[highlight] ${message}`, error instanceof Error ? error.message : error);
}

/** `highlightCode` plus the backend that produced the tokens. */
export async function highlightWithBackend(
  code: string,
  options: HighlightOptions,
): Promise<{ lines: HighlightedLine[]; backend: Backend } | null> {
  const lang = resolveLanguage(options);
  if (!lang || !withinHighlightCap(code)) return null;
  const source = code.split(/\r?\n/);
  const text = source.join("\n");

  const preferred = mode === "auto" ? autoBackend() : mode;
  if (preferred === "shiki" && !shikiFailed.has(lang)) {
    try {
      const backend = await (shiki ??= startShiki());
      return { lines: fit(source, await backend.tokenize(text, lang, options.scheme)), backend: "shiki" };
    } catch (error) {
      if (mode === "shiki") return null;
      shikiFailed.add(lang);
      warn(`Shiki failed for ${lang}; using highlight.js`, error);
    }
  }
  try {
    const backend = await (hljs ??= import("./hljs").then((module) => module.createHljsBackend()));
    const lines = backend.tokenize(text, lang, options.scheme);
    return lines && { lines: fit(source, lines), backend: "highlightjs" };
  } catch (error) {
    warn(`highlight.js failed for ${lang}`, error);
    return null;
  }
}
