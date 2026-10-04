// Shiki with the desktop's GitHub themes on the JavaScript regex engine only
// (no Oniguruma WASM). Only shiki/core and the grammars listed here reach the
// bundle, and a grammar is loaded the first time its language is highlighted.

import { createHighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { LanguageId } from "./languages";
import type { ColorScheme, HighlightedLine, HighlightToken } from "./types";

/** Hermes rejects the `v` regex flag that Shiki's precompiled grammars and its
 * newer targets use, so grammars are compiled to ES2018 regexes on every
 * runtime. scripts/hermes-regex-check.ts compiles the same output with hermesc. */
export const REGEX_TARGET = "ES2018";

/** The themes the desktop's code blocks use (codeHighlightPlugin.ts). */
export const THEMES: Record<ColorScheme, string> = { dark: "github-dark", light: "github-light" };

type GrammarModule = { default: LanguageRegistration[] };

export const GRAMMARS: Record<LanguageId, () => Promise<GrammarModule>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  markdown: () => import("@shikijs/langs/markdown"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  java: () => import("@shikijs/langs/java"),
  rust: () => import("@shikijs/langs/rust"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  sql: () => import("@shikijs/langs/sql"),
  diff: () => import("@shikijs/langs/diff"),
};

/** Longer lines stay plain: TextMate grammars can take seconds on minified code. */
const MAX_LINE_LENGTH = 2_000;

// Shiki's FontStyle bits; NotSet is -1.
const ITALIC = 1;
const BOLD = 2;

export type ShikiBackend = {
  tokenize(code: string, lang: LanguageId, scheme: ColorScheme): Promise<HighlightedLine[]>;
};

function toToken(token: ThemedToken): HighlightToken {
  const out: HighlightToken = { text: token.content };
  if (token.color) out.color = token.color;
  const style = token.fontStyle ?? 0;
  if (style > 0 && style & BOLD) out.fontStyle = "bold";
  else if (style > 0 && style & ITALIC) out.fontStyle = "italic";
  return out;
}

export async function startShiki(): Promise<ShikiBackend> {
  const highlighter = await createHighlighterCore({
    themes: [import("@shikijs/themes/github-dark"), import("@shikijs/themes/github-light")],
    langs: [],
    // Not forgiving: a regex that fails surfaces as an error, and the
    // language falls back to highlight.js instead of losing tokens silently.
    engine: createJavaScriptRegexEngine({ target: REGEX_TARGET }),
  });
  const loaded = new Map<LanguageId, Promise<void>>();
  return {
    async tokenize(code, lang, scheme) {
      let loading = loaded.get(lang);
      if (!loading) {
        loading = highlighter.loadLanguage(GRAMMARS[lang]);
        loaded.set(lang, loading);
      }
      await loading;
      return highlighter
        .codeToTokensBase(code, { lang, theme: THEMES[scheme], tokenizeMaxLineLength: MAX_LINE_LENGTH })
        .map((line) => line.map(toToken));
    },
  };
}
