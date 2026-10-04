// File-type icons for Explorer and Changes. The desktop's material icon set
// isn't exported as native assets yet (11 §11.7), so files get the SF Symbol
// for their kind, by name and extension, in one muted colour.

import { Icon, type IconName } from "./icon";
import { useTokens } from "./theme";

const BY_NAME: Record<string, IconName> = {
  dockerfile: "shippingbox",
  makefile: "hammer",
  license: "doc.plaintext",
  ".gitignore": "eye.slash",
  ".env": "gearshape",
};

const BY_EXTENSION: [IconName, string[]][] = [
  ["doc.text", ["md", "markdown", "mdx", "txt", "rst", "adoc"]],
  ["photo", ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "heic", "bmp", "avif"]],
  ["curlybraces", ["json", "jsonc", "json5"]],
  ["gearshape", ["yaml", "yml", "toml", "ini", "cfg", "conf", "env", "plist", "xml"]],
  ["swift", ["swift"]],
  ["terminal", ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]],
  ["lock", ["lock"]],
  ["doc.zipper", ["zip", "tar", "gz", "tgz", "7z", "rar", "xz", "bz2"]],
  ["doc.richtext", ["pdf"]],
  ["waveform", ["mp3", "wav", "m4a", "aac", "flac", "ogg"]],
  ["film", ["mp4", "mov", "webm", "mkv", "avi"]],
  [
    "chevron.left.forwardslash.chevron.right",
    [
      "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "m", "mm", "cs",
      "php", "css", "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro", "sql", "lua", "dart", "scala", "ex", "exs", "zig",
      "hs", "ml", "clj", "erl", "r", "jl", "nim", "vim", "graphql", "gql", "proto",
    ],
  ],
];

const EXTENSIONS = new Map(BY_EXTENSION.flatMap(([icon, extensions]) => extensions.map((extension) => [extension, icon] as const)));

export function fileIconName(name: string, isDir: boolean): IconName {
  if (isDir) return "folder.fill";
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.endsWith("-lock.json") || lower.endsWith(".lock")) return "lock";
  const dot = lower.lastIndexOf(".");
  return (dot > 0 && EXTENSIONS.get(lower.slice(dot + 1))) || "doc";
}

export function FileTypeIcon({ name, isDir = false, size = 18, faded }: { name: string; isDir?: boolean; size?: number; faded?: boolean }) {
  const t = useTokens();
  return <Icon name={fileIconName(name, isDir)} size={size} color={t.contentAlpha(faded ? 0.3 : isDir ? 0.6 : 0.55)} />;
}
