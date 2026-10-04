// Highlighting for the file and diff viewers (12 §12.9). Rows paint as plain
// text first; tokens are computed after that paint and swapped in. Tokens are
// kept per raw line and only used when they join back to it exactly, so a
// row draws the same characters, and has the same height, with or without
// them (CodeLine's `codeLayout`). Find marks split the tokens as drawn.

import { useEffect, useRef, useState } from "react";
import { highlightCode, languageForPath, withinHighlightCap, type HighlightedLine } from "../highlight";
import type { DiffRow } from "./diff";

/** Tokens per row, in row order; undefined draws that row plain. */
export type RowTokens = readonly (HighlightedLine | undefined)[];

type Scheme = "dark" | "light";

/** `line` if its tokens join back to `text`, else undefined. */
function matching(line: HighlightedLine | undefined, text: string): HighlightedLine | undefined {
  if (!line) return undefined;
  let joined = "";
  for (const token of line) joined += token.text;
  return joined === text ? line : undefined;
}

/** The cache key for highlighting `contents` of `path` in `scheme`, or null
 * when there is nothing to do: a language the module doesn't highlight, or
 * any of `contents` over its cap. Viewable text has no NUL bytes. */
export function highlightKey(scheme: Scheme, path: string, ...contents: string[]): string | null {
  if (!languageForPath(path) || !contents.every(withinHighlightCap)) return null;
  return [scheme, path, ...contents].join("\0");
}

/** The file viewer's tokens, one per line of `lines` (`splitLines(text)`),
 * or null to stay plain. */
export async function highlightFile(text: string, lines: readonly string[], path: string, scheme: Scheme): Promise<RowTokens | null> {
  const highlighted = await highlightCode(text, { path, scheme });
  return highlighted && lines.map((line, index) => matching(highlighted[index], line));
}

/** The diff viewer's tokens, one per row: deletions from `original`,
 * additions and context from `current`, hunk headers plain. Each side is
 * highlighted as a whole file, so state that spans lines (a block comment,
 * a template string) is right inside a hunk. Null when either side is over
 * the cap or fails. */
export async function highlightDiff(
  { original, current }: { original: string; current: string },
  rows: readonly DiffRow[],
  path: string,
  scheme: Scheme,
): Promise<RowTokens | null> {
  if (!withinHighlightCap(original) || !withinHighlightCap(current)) return null;
  const before = rows.some((row) => row.kind === "del") ? await highlightCode(original, { path, scheme }) : [];
  const after = rows.some((row) => row.kind === "add" || row.kind === "context") ? await highlightCode(current, { path, scheme }) : [];
  if (!before || !after) return null;
  return rows.map((row) => {
    if (row.kind === "hunk") return undefined;
    if (row.kind === "del") return row.oldNumber === null ? undefined : matching(before[row.oldNumber - 1], row.text);
    return row.newNumber === null ? undefined : matching(after[row.newNumber - 1], row.text);
  });
}

/** Calls `run` once the next frame has painted; returns a cancel. */
function afterPaint(run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(run, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** `run`'s result while `key` is current, computed after the plain rows have
 * painted, so highlighting never blocks first paint. Results are kept by key
 * for the life of the screen. A result for an earlier key (another file or
 * scheme) is dropped. A wrap change re-lays out every row, so a result still
 * pending then lands after that paint. Null until there is a result, and
 * when `run` gives null or throws. */
export function useDeferredHighlight<T>(key: string | null, run: () => Promise<T | null>, wrap: boolean): T | null {
  const cache = useRef<Map<string, Promise<T | null>>>(null);
  const [result, setResult] = useState<{ key: string; value: T | null } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const cancel = afterPaint(() => {
      const results = (cache.current ??= new Map<string, Promise<T | null>>());
      let pending = results.get(key);
      if (!pending) {
        pending = run().catch(() => null);
        results.set(key, pending);
      }
      void pending.then((value) => {
        if (current) setResult((previous) => (previous?.key === key && previous.value === value ? previous : { key, value }));
      });
    });
    return () => {
      current = false;
      cancel();
    };
  }, [key, run, wrap]);
  return result?.key === key ? result.value : null;
}
