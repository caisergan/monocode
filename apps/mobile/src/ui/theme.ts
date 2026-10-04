import { palette, TYPE, type Palette } from "@monocode/design";
import { useMemo } from "react";
import { useColorScheme } from "react-native";
import type { TranscriptTheme } from "@transcript";

export type Tokens = Palette;

/** Dark is MonoCode's default; light follows the system when chosen. */
export function useTokens(): Tokens {
  const scheme = useColorScheme();
  return useMemo(() => palette({ scheme: scheme === "light" ? "light" : "dark" }), [scheme]);
}

/** Text styles and colours for the native transcript, from the same tokens. */
export function transcriptTheme(t: Tokens, scale = 1): TranscriptTheme {
  const text = (size: { size: number; line: number }, color: string, extra: object = {}) => ({
    size: size.size,
    line: size.line,
    color,
    ...extra,
  });
  return {
    background: t.base,
    scale,
    colors: {
      bubble: t.fill.bubble,
      code: t.fill.code,
      chip: t.fill.chip,
      fileChip: t.fill.code,
      border: t.border.default,
      borderDashed: t.border.dashed,
      rail: t.contentAlpha(0.14),
      chevron: t.contentAlpha(0.45),
      quoteBar: t.contentAlpha(0.2),
      primary: t.primary,
      danger: t.status.danger,
      attention: t.status.attention,
    },
    styles: {
      prose: text(TYPE.prose, t.text.prose),
      strong: text(TYPE.prose, t.content, { weight: "600" }),
      em: text(TYPE.prose, t.content, { italic: true }),
      code: text(TYPE.code, t.contentAlpha(0.85), { mono: true }),
      inlineCode: { size: 13.5, line: TYPE.prose.line, color: t.contentAlpha(0.9), mono: true },
      link: text(TYPE.prose, t.link),
      h1: text(TYPE.h1, t.content, { weight: "600" }),
      h2: text(TYPE.h2, t.content, { weight: "600" }),
      h3: text(TYPE.h3, t.content, { weight: "600" }),
      h4: text(TYPE.h4, t.content, { weight: "600" }),
      marker: text(TYPE.prose, t.text.secondary),
      user: text(TYPE.prose, t.contentAlpha(0.9)),
      reasoning: text(TYPE.prose, t.text.reasoning),
      fold: text(TYPE.prose, t.text.secondary),
      trailVerb: text(TYPE.prose, t.text.secondary),
      trailTarget: text(TYPE.toolChip, t.contentAlpha(0.7), { mono: true }),
      trailFailed: text(TYPE.prose, t.status.danger),
      notice: text(TYPE.toolChip, t.text.secondary, { mono: true }),
      meta: text(TYPE.secondary, t.text.faint),
      codeLabel: text(TYPE.secondary, t.contentAlpha(0.65), { mono: true, weight: "500" }),
      approvalTitle: text(TYPE.row, t.contentAlpha(0.9), { weight: "500" }),
      buttonLabel: text(TYPE.row, t.contentAlpha(0.85), { weight: "500" }),
      primaryLabel: text(TYPE.row, t.primaryText, { weight: "500" }),
      dangerLabel: text(TYPE.row, "#fca5a5", { weight: "500" }),
    },
  };
}
