// The languages the phone highlights (12 §12.9), keyed by Shiki grammar name.
// Each one also has a highlight.js language for the fallback.

export const LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "css",
  "scss",
  "html",
  "swift",
  "kotlin",
  "java",
  "rust",
  "python",
  "go",
  "shellscript",
  "yaml",
  "toml",
  "sql",
  "diff",
] as const;

export type LanguageId = (typeof LANGUAGES)[number];

const KNOWN = new Set<string>(LANGUAGES);

/** Fence info strings and other names people use for the same languages. */
const ALIASES: Record<string, LanguageId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsonc: "json",
  md: "markdown",
  htm: "html",
  xhtml: "html",
  kt: "kotlin",
  kts: "kotlin",
  rs: "rust",
  py: "python",
  python3: "python",
  golang: "go",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  shell: "shellscript",
  yml: "yaml",
  patch: "diff",
};

/** File extensions, lower case, without the dot. */
const EXTENSIONS: Record<string, LanguageId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};

const FILE_NAMES: Record<string, LanguageId> = {
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".zprofile": "shellscript",
  ".profile": "shellscript",
  "Cargo.lock": "toml",
  Pipfile: "toml",
};

/** Names that ask for plain text on purpose. */
const PLAIN = new Set(["text", "txt", "plain", "plaintext"]);

/** The language a fence or caller names, `null` for an explicit plain text
 * request, `undefined` when the name is unknown. */
export function languageForName(name: string): LanguageId | null | undefined {
  const lower = name.trim().toLowerCase();
  if (PLAIN.has(lower)) return null;
  if (KNOWN.has(lower)) return lower as LanguageId;
  return Object.hasOwn(ALIASES, lower) ? ALIASES[lower] : undefined;
}

export function languageIdForPath(path: string): LanguageId | undefined {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (Object.hasOwn(FILE_NAMES, base)) return FILE_NAMES[base];
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = base.slice(dot + 1).toLowerCase();
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
}
