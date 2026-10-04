// Code highlighting for code blocks, diffs and files (12 §12.9): Shiki on its
// JavaScript regex engine, with highlight.js as the fallback.

import { highlightWithBackend } from "./backend";
import { languageIdForPath } from "./languages";
import type { HighlightedLine } from "./types";

export type { HighlightToken, HighlightedLine } from "./types";
export { withinHighlightCap } from "./backend";

/** The language id for a file path, or undefined when it isn't highlighted. */
export function languageForPath(path: string): string | undefined {
  return languageIdForPath(path);
}

/** Tokens per line (split at `\n` or `\r\n`), or null to render plain text:
 * an unknown language, input over the size cap, or both highlighters failing.
 * `lang` (a fence name or alias) wins over `path`. */
export async function highlightCode(
  code: string,
  options: { lang?: string; path?: string; scheme: "dark" | "light" },
): Promise<HighlightedLine[] | null> {
  return (await highlightWithBackend(code, options))?.lines ?? null;
}
