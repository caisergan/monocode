// The highlight.js fallback (12 §12.9), used when Shiki can't start or fails
// on a language. Its scopes are mapped to TextMate scopes and coloured from
// the same GitHub themes Shiki uses, so a fallback block looks the same.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import type { LanguageId } from "./languages";
import type { ColorScheme, HighlightedLine, HighlightToken } from "./types";

type LanguageFn = Parameters<typeof hljs.registerLanguage>[1];

/** Registered under the Shiki names; xml's embedded script and style blocks
 * find `javascript` and `css` by these names too. */
const LANGUAGE_FNS: Record<LanguageId, LanguageFn> = {
  typescript,
  tsx: typescript,
  javascript,
  jsx: javascript,
  json,
  markdown,
  css,
  scss,
  html: xml,
  swift,
  kotlin,
  java,
  rust,
  python,
  go,
  shellscript: bash,
  yaml,
  toml: ini,
  sql,
  diff,
};

/** highlight.js scopes and the TextMate scopes Shiki's grammars give the same
 * constructs. A scope missing here takes its parent's, then its outer span's. */
const TEXTMATE: Record<string, string> = {
  keyword: "keyword",
  built_in: "support.function",
  type: "support.type",
  literal: "constant.language",
  number: "constant.numeric",
  operator: "keyword.operator",
  property: "variable.other.property",
  regexp: "string.regexp",
  string: "string",
  "char.escape": "constant.character.escape",
  subst: "variable.other",
  symbol: "constant.other.symbol",
  class: "entity.name.type.class",
  function: "entity.name.function",
  variable: "variable",
  "variable.language": "variable.language",
  "variable.constant": "variable.other.constant",
  title: "entity.name",
  "title.class": "entity.name.type.class",
  "title.class.inherited": "entity.other.inherited-class",
  "title.function": "entity.name.function",
  params: "variable.parameter.function",
  comment: "comment",
  doctag: "storage.type.class.jsdoc",
  section: "markup.heading",
  name: "entity.name.tag",
  attr: "entity.other.attribute-name",
  attribute: "entity.other.attribute-name",
  bullet: "punctuation.definition.list.begin.markdown",
  code: "markup.inline.raw",
  emphasis: "markup.italic",
  strong: "markup.bold",
  link: "string.other.link",
  quote: "markup.quote",
  "selector-tag": "entity.name.tag",
  "selector-id": "entity.other.attribute-name",
  "selector-class": "entity.other.attribute-name",
  "selector-attr": "entity.other.attribute-name",
  "selector-pseudo": "entity.other.attribute-name",
  "template-tag": "entity.name.tag",
  "template-variable": "variable",
  addition: "markup.inserted",
  deletion: "markup.deleted",
};

type Style = Omit<HighlightToken, "text">;
type ThemeRule = { scope?: string | readonly string[]; settings: { foreground?: string; fontStyle?: string } };
type Theme = { colors?: Record<string, string>; tokenColors?: readonly ThemeRule[]; settings?: readonly ThemeRule[] };

/** The colour and style a theme gives a TextMate scope: the most specific
 * matching selector wins, the later rule on a tie. Descendant selectors are
 * ignored, since a span here has one scope. */
export function themeStyle(theme: Theme, scope: string): Style {
  let color: [length: number, value: string] | undefined;
  let font: [length: number, value: string] | undefined;
  for (const rule of theme.tokenColors ?? theme.settings ?? []) {
    const selectors = typeof rule.scope === "string" ? rule.scope.split(",") : (rule.scope ?? []);
    for (const raw of selectors) {
      const selector = raw.trim();
      if (!selector || selector.includes(" ")) continue;
      if (scope !== selector && !scope.startsWith(`${selector}.`)) continue;
      const { foreground, fontStyle } = rule.settings;
      if (foreground && (!color || selector.length >= color[0])) color = [selector.length, foreground];
      if (fontStyle !== undefined && (!font || selector.length >= font[0])) font = [selector.length, fontStyle];
    }
  }
  const style: Style = {};
  const value = color?.[1] ?? theme.colors?.["editor.foreground"];
  // Upper case, as Shiki reports theme colours.
  if (value) style.color = value.toUpperCase();
  if (font?.[1].includes("bold")) style.fontStyle = "bold";
  else if (font?.[1].includes("italic")) style.fontStyle = "italic";
  return style;
}

const THEMES: Record<ColorScheme, Theme> = { dark: githubDark, light: githubLight };

/** Style for an hljs class list such as `hljs-title class_ inherited__`. */
function classStyle(palette: Map<string, Style | undefined>, theme: Theme, classes: string): Style | undefined {
  if (palette.has(classes)) return palette.get(classes);
  let style: Style | undefined;
  const [first, ...rest] = classes.split(" ");
  // Sub-language spans (`language-xml`) carry no scope.
  if (first.startsWith("hljs-")) {
    const parts = [first.slice(5), ...rest.map((part) => part.replace(/_+$/, ""))];
    for (let length = parts.length; length > 0 && !style; length--) {
      const scope = TEXTMATE[parts.slice(0, length).join(".")];
      if (scope) style = themeStyle(theme, scope);
    }
  }
  palette.set(classes, style);
  return style;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
const unescape = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]);

export type HljsBackend = {
  /** `code` uses `\n` line breaks only. Returns null when highlight.js gave up. */
  tokenize(code: string, lang: LanguageId, scheme: ColorScheme): HighlightedLine[] | null;
};

export function createHljsBackend(): HljsBackend {
  const instance = hljs.newInstance();
  for (const [id, fn] of Object.entries(LANGUAGE_FNS)) instance.registerLanguage(id, fn);
  const palettes: Record<ColorScheme, Map<string, Style | undefined>> = { dark: new Map(), light: new Map() };
  return {
    tokenize(code, lang, scheme) {
      const result = instance.highlight(code, { language: lang, ignoreIllegals: true });
      if (result.errorRaised) return null;
      const theme = THEMES[scheme];
      const base = themeStyle(theme, "source");
      const stack: Style[] = [base];
      const lines: HighlightedLine[] = [[]];
      for (const [, classes, text] of result.value.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
        const style = stack[stack.length - 1];
        if (classes !== undefined) {
          stack.push(classStyle(palettes[scheme], theme, classes) ?? style);
        } else if (text === undefined) {
          if (stack.length > 1) stack.pop();
        } else {
          unescape(text)
            .split("\n")
            .forEach((part, index) => {
              if (index > 0) lines.push([]);
              if (part) lines[lines.length - 1].push({ text: part, ...style });
            });
        }
      }
      return lines;
    },
  };
}
