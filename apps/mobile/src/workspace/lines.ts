// Code and diff lines as fixed-height rows (15 §15.3: heights from the type
// scale, never from layout). Text is monospaced, so a row's height follows
// from its column count: unwrapped rows are one line; wrapped rows are cut
// here, at a column limit, and drawn as exactly that many lines.

/** One highlighted piece of a line. Lines without tokens draw plain text. */
export type CodeToken = { text: string; color?: string; fontStyle?: "italic" | "bold" };

/** A find match on a line, in display offsets. */
export type CodeMark = { start: number; end: number; current: boolean };

export type CodeSpan = CodeToken & { mark?: "match" | "current" };

/** Tabs draw as two spaces, as in transcript code blocks. */
export const TAB = "  ";
/** Longer lines are cut, so no row is wider or taller than a few screens. */
export const MAX_LINE_CHARS = 1_000;
const ELLIPSIS = "…";
/** Menlo advances 0.602 em; the extra keeps a hard wrap from wrapping again. */
export const MONO_ADVANCE = 0.62;

/** Columns a code point takes: two for East Asian wide characters and emoji. */
function width(code: number): 1 | 2 {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1;
}

/** Tokens as drawn: tabs expanded and the line cut at MAX_LINE_CHARS. */
export function displayTokens(tokens: readonly CodeToken[]): CodeToken[] {
  const out: CodeToken[] = [];
  let length = 0;
  for (const token of tokens) {
    let text = token.text.includes("\t") ? token.text.replace(/\t/g, TAB) : token.text;
    if (length + text.length > MAX_LINE_CHARS) {
      text = text.slice(0, MAX_LINE_CHARS - length);
      if (text) out.push({ ...token, text });
      out.push({ text: ELLIPSIS });
      return out;
    }
    length += text.length;
    if (text) out.push({ ...token, text });
  }
  return out;
}

/** A raw line as drawn; find runs on this text, so marks line up. */
export function displayText(raw: string): string {
  if (raw.length <= MAX_LINE_CHARS && !raw.includes("\t")) return raw;
  return displayTokens([{ text: raw }])
    .map((token) => token.text)
    .join("");
}

/** Splits spans at mark edges and tags the marked pieces. */
export function markSpans(spans: readonly CodeToken[], marks: readonly CodeMark[] | undefined): CodeSpan[] {
  if (!marks?.length) return spans as CodeSpan[];
  const out: CodeSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const end = offset + span.text.length;
    let at = offset;
    for (const mark of marks) {
      if (mark.end <= at || mark.start >= end) continue;
      const from = Math.max(mark.start, at);
      const to = Math.min(mark.end, end);
      if (from > at) out.push({ ...span, text: span.text.slice(at - offset, from - offset) });
      out.push({ ...span, text: span.text.slice(from - offset, to - offset), mark: mark.current ? "current" : "match" });
      at = to;
    }
    if (at < end) out.push({ ...span, text: span.text.slice(at - offset) });
    offset = end;
  }
  return out;
}

/** Visual lines of `text` at `columns` per line; 1 when unwrapped. Matches
 * `wrapSpans` exactly. */
export function wrapCount(text: string, columns: number | undefined): number {
  if (!columns || columns <= 0) return 1;
  let lines = 1;
  let used = 0;
  for (const char of text) {
    const w = width(char.codePointAt(0)!);
    if (used + w > columns && used > 0) {
      lines++;
      used = 0;
    }
    used += w;
  }
  return lines;
}

/** Spans cut into visual lines of at most `columns`. */
export function wrapSpans(spans: readonly CodeSpan[], columns: number | undefined): CodeSpan[][] {
  if (!columns || columns <= 0) return [spans as CodeSpan[]];
  const lines: CodeSpan[][] = [[]];
  let used = 0;
  for (const span of spans) {
    let piece = "";
    for (const char of span.text) {
      const w = width(char.codePointAt(0)!);
      if (used + w > columns && used > 0) {
        if (piece) lines[lines.length - 1].push({ ...span, text: piece });
        lines.push([]);
        piece = "";
        used = 0;
      }
      piece += char;
      used += w;
    }
    if (piece) lines[lines.length - 1].push({ ...span, text: piece });
  }
  return lines;
}

/** Columns a line takes unwrapped, for the scroll width. */
export function columnsOf(text: string): number {
  let used = 0;
  for (const char of text) used += width(char.codePointAt(0)!);
  return used;
}

/** Whole columns that fit `widthPt` of `fontSize` mono text. */
export function columnsFor(widthPt: number, fontSize: number): number {
  return Math.max(8, Math.floor(widthPt / (fontSize * MONO_ADVANCE)));
}

/** Width of `columns` of `fontSize` mono text. */
export function monoWidth(columns: number, fontSize: number): number {
  return Math.ceil(columns * fontSize * MONO_ADVANCE);
}

/** Row height: the first line takes `base` (the row's own height), each
 * wrapped line adds a text line height. */
export function rowHeight(base: number, line: number, lines: number): number {
  return base + Math.max(0, lines - 1) * line;
}

/** Gutter digits for the largest line number. */
export function gutterDigits(maxNumber: number): number {
  return Math.max(2, String(Math.max(1, maxNumber)).length);
}
