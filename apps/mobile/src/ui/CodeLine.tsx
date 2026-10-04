// One code or diff line, the row behind the file viewer and the diff viewer
// (11 §11.20). Its height is fixed by the type scale and the wrap count, so
// lists never measure text (15 §15.3). `tokens` is the highlighter's output
// for the line; without it the line draws as plain text.

import { parseColor, rgba, TYPE } from "@monocode/design";
import { Fragment, memo } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";
import {
  columnsFor,
  displayTokens,
  gutterDigits,
  markSpans,
  monoWidth,
  rowHeight,
  wrapSpans,
  type CodeMark,
  type CodeSpan,
  type CodeToken,
} from "@/workspace/lines";
import type { Tokens } from "./theme";

export type { CodeMark, CodeToken };

export const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** Row metrics: `base` is a one-line row's height, `line` each further
 * wrapped line's, `size` the font size. */
export type CodeMetrics = { base: number; line: number; size: number };

/** File viewer rows: mono 13 / 19. */
export const FILE_METRICS: CodeMetrics = { base: TYPE.code.line, line: TYPE.code.line, size: TYPE.code.size };
/** Diff rows: 22 pt, mono 12 / 18. */
export const DIFF_METRICS: CodeMetrics = { base: 22, line: 18, size: 12 };
/** Gutter numbers use the caption size (11 §11.3). */
export const NUMBER_SIZE = TYPE.caption.size;
/** Space between the gutter and the text, and after the text. */
export const CODE_PAD = 10;

export type CodeTone = "add" | "del" | "hunk";

export type CodeColors = {
  text: string;
  number: string;
  hunkText: string;
  hunkFill: string;
  add: { fill: string; gutter: string; number: string };
  del: { fill: string; gutter: string; number: string };
  match: string;
  current: string;
};

/** The desktop diff tints (11 §11.2 `diff.add` / `diff.del`: emerald-500 and
 * rose-500 rows at α .15, gutters at α .25, numbers in the -300 shades).
 * @monocode/design has no diff tokens yet, so they are spelled out here. */
const EMERALD_500 = parseColor("#10b981");
const ROSE_500 = parseColor("#f43f5e");

export function codeColors(t: Tokens): CodeColors {
  return {
    text: t.contentAlpha(0.85),
    number: t.contentAlpha(0.35),
    hunkText: t.contentAlpha(0.4),
    hunkFill: t.fill.hover,
    add: { fill: rgba(EMERALD_500, 0.15), gutter: rgba(EMERALD_500, 0.25), number: "#6ee7b7" },
    del: { fill: rgba(ROSE_500, 0.15), gutter: rgba(ROSE_500, 0.25), number: "#fda4af" },
    match: t.selection.emphasis,
    current: rgba(parseColor(t.accent), 0.45),
  };
}

/** A gutter wide enough for `maxNumber`, plus its padding. */
export function gutterWidth(maxNumber: number): number {
  return monoWidth(gutterDigits(maxNumber), NUMBER_SIZE) + 14;
}

/** Columns per visual line when wrapping in a view `width` wide. */
export function wrapColumns(width: number, gutter: number, metrics: CodeMetrics): number {
  return columnsFor(width - gutter - CODE_PAD * 2, metrics.size);
}

/** Width of unwrapped rows: the longest line, gutter and padding. */
export function contentWidth(maxColumns: number, gutter: number, metrics: CodeMetrics): number {
  return gutter + CODE_PAD * 2 + monoWidth(maxColumns, metrics.size);
}

/** Lines and height of a row, from the same rule that draws it. */
export function codeLayout(text: string, tokens: readonly CodeToken[] | undefined, metrics: CodeMetrics, wrap: number | undefined, marks?: readonly CodeMark[]) {
  const spans = markSpans(tokens ? displayTokens(tokens) : [{ text }], marks);
  const lines = wrapSpans(spans, wrap);
  return { lines, height: rowHeight(metrics.base, metrics.line, lines.length) };
}

function spanStyle(span: CodeSpan, colors: CodeColors): TextStyle | undefined {
  if (!span.color && !span.fontStyle && !span.mark) return undefined;
  return {
    ...(span.color ? { color: span.color } : {}),
    ...(span.fontStyle === "italic" ? { fontStyle: "italic" as const } : span.fontStyle === "bold" ? { fontWeight: "600" as const } : {}),
    ...(span.mark ? { backgroundColor: span.mark === "current" ? colors.current : colors.match } : {}),
  };
}

export const CodeLine = memo(function CodeLine({
  text,
  tokens,
  number,
  gutter,
  metrics,
  wrap,
  tone,
  marks,
  colors,
  accessibilityLabel,
}: {
  /** The line as drawn (`displayText`); used when `tokens` is absent. */
  text: string;
  tokens?: readonly CodeToken[];
  number?: number | null;
  /** Gutter width; 0 hides it. */
  gutter: number;
  metrics: CodeMetrics;
  /** Columns per visual line; one unwrapped line when absent. */
  wrap?: number;
  tone?: CodeTone;
  marks?: readonly CodeMark[];
  colors: CodeColors;
  accessibilityLabel?: string;
}) {
  const { lines, height } = codeLayout(text, tokens, metrics, wrap, marks);
  const pad = Math.max(0, (metrics.base - metrics.line) / 2);
  const tint = tone === "add" ? colors.add : tone === "del" ? colors.del : undefined;
  return (
    <View
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      style={{ height, flexDirection: "row", overflow: "hidden", backgroundColor: tone === "hunk" ? colors.hunkFill : tint?.fill }}
    >
      {gutter > 0 ? (
        <View style={{ width: gutter, paddingRight: 6, paddingTop: pad, backgroundColor: tint?.gutter }}>
          <Text
            style={{
              fontFamily: MONO,
              fontSize: NUMBER_SIZE,
              lineHeight: metrics.line,
              textAlign: "right",
              fontVariant: ["tabular-nums"],
              color: tint?.number ?? colors.number,
            }}
          >
            {number ?? ""}
          </Text>
        </View>
      ) : null}
      <Text
        numberOfLines={lines.length}
        ellipsizeMode="clip"
        style={{
          flex: 1,
          paddingLeft: CODE_PAD,
          paddingRight: CODE_PAD,
          paddingTop: pad,
          fontFamily: MONO,
          fontSize: metrics.size,
          lineHeight: metrics.line,
          color: tone === "hunk" ? colors.hunkText : colors.text,
        }}
      >
        {lines.map((spans, index) => (
          <Fragment key={index}>
            {index > 0 ? "\n" : null}
            {spans.map((span, at) => {
              const style = spanStyle(span, colors);
              return style ? (
                <Text key={at} style={style}>
                  {span.text}
                </Text>
              ) : (
                span.text
              );
            })}
          </Fragment>
        ))}
      </Text>
    </View>
  );
});
