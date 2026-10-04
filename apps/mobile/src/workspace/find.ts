// The file viewer's find bar (11 §11.20): "Find in file", case-insensitive,
// with an "n of m" counter that wraps around at either end.

export type FindMatch = { line: number; start: number; end: number };

/** More matches than this stop the search; the counter then reads "m+". */
export const MAX_MATCHES = 10_000;

/** Non-overlapping matches, in reading order. */
export function findMatches(lines: readonly string[], query: string): FindMatch[] {
  const matches: FindMatch[] = [];
  if (!query) return matches;
  const needle = query.toLowerCase();
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    // Case folding that changes a line's length would shift the offsets;
    // such lines are searched as they are.
    const lower = text.toLowerCase();
    const haystack = lower.length === text.length ? lower : text;
    const target = lower.length === text.length ? needle : query;
    for (let at = haystack.indexOf(target); at >= 0; at = haystack.indexOf(target, at + target.length)) {
      matches.push({ line, start: at, end: at + target.length });
      if (matches.length >= MAX_MATCHES) return matches;
    }
  }
  return matches;
}

/** "n of m", 1-based; "0 of 0" when nothing matches. */
export function findCounter(current: number, total: number): string {
  if (total <= 0) return "0 of 0";
  return `${Math.min(current, total - 1) + 1} of ${total}${total >= MAX_MATCHES ? "+" : ""}`;
}

/** Next (1) or previous (-1) match, wrapping around. */
export function stepMatch(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}

/** The first match at or below `line`, so a new query starts where the
 * person is reading; the first match when none follows. */
export function matchFrom(matches: readonly FindMatch[], line: number): number {
  const index = matches.findIndex((match) => match.line >= line);
  return index < 0 ? 0 : index;
}

export type LineMark = { start: number; end: number; current: boolean };

/** Each line's marks, for drawing; `current` is the selected match. */
export function marksByLine(matches: readonly FindMatch[], current: number): Map<number, LineMark[]> {
  const byLine = new Map<number, LineMark[]>();
  matches.forEach((match, index) => {
    const marks = byLine.get(match.line);
    const mark = { start: match.start, end: match.end, current: index === current };
    if (marks) marks.push(mark);
    else byLine.set(match.line, [mark]);
  });
  return byLine;
}
