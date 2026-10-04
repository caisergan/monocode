// Markdown to transcript rows. One top-level block is one row (a list item
// is one row; a code block is cut into chunks), so streaming re-parses only
// the trailing block. Raw HTML stays literal text; javascript:, data: and
// file: links are inert.

import type { RowSpec, StyleId, TextRun } from "@transcript";

const CODE_CHUNK_LINES = 40;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const EXTENSIONLESS = /(^|\/)(Makefile|Dockerfile|LICENSE|README|Gemfile|Procfile|Rakefile|Justfile|Brewfile)$/;

type MdBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; marker: string; depth: number; text: string }
  | { kind: "code"; lang: string; lines: string[]; closed: boolean }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "table"; rows: string[] };

/** The desktop's `inlineFileName` rule: inline code that names a file. */
export function isFileName(text: string): boolean {
  if (!text || text.length > 240 || /\s/.test(text)) return false;
  const path = text.replace(/(:\d+(:\d+)?|#L\d+(-L?\d+)?)$/, "");
  return /\.[A-Za-z0-9]{1,12}$/.test(path) || EXTENSIONLESS.test(path);
}

export function splitMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const marker = fence[1];
      const code: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (lines[i].trim().startsWith(marker[0].repeat(marker.length)) && !lines[i].trim().slice(marker.length).trim()) {
          closed = true;
          break;
        }
        code.push(lines[i]);
      }
      blocks.push({ kind: "code", lang: fence[2] ?? "", lines: code, closed });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const item = line.match(LIST);
    if (item) {
      flush();
      const depth = Math.min(4, Math.floor(item[1].replace(/\t/g, "  ").length / 2));
      const marker = /\d/.test(item[2]) ? item[2].replace(")", ".") : "•";
      const text = [item[3]];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !LIST.test(lines[i + 1])) text.push(lines[++i].trim());
      blocks.push({ kind: "item", marker, depth, text: text.join("\n") });
      continue;
    }
    const quote = line.match(QUOTE);
    if (quote) {
      flush();
      const text = [quote[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) text.push(lines[++i].match(QUOTE)![1]);
      blocks.push({ kind: "quote", text: text.join("\n") });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const rows = [line];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(lines[i]);
      i--;
      blocks.push({ kind: "table", rows });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const SAFE_LINK = /^(https?:|mailto:|#|\/|\.{0,2}\/)/i;

/** Inline markdown: `code`, **strong**, *em*, [links](url). */
export function inlineRuns(text: string, base: StyleId = "prose"): TextRun[] {
  const runs: TextRun[] = [];
  let plain = "";
  let strong = false;
  let em = false;
  const style = (): StyleId => (strong ? "strong" : em ? "em" : base);
  const push = () => {
    if (plain) runs.push({ t: plain, s: style() });
    plain = "";
  };
  for (let i = 0; i < text.length; ) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length && /[\\`*_[\]()#+\-.!|>]/.test(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (char === "`") {
      const ticks = text.slice(i).match(/^`+/)![0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end > i) {
        push();
        const code = text.slice(i + ticks.length, end).trim();
        runs.push({ t: code, s: "inlineCode", chip: isFileName(code) ? 2 : 1 });
        i = end + ticks.length;
        continue;
      }
    }
    if ((char === "*" || char === "_") && text[i + 1] === char) {
      push();
      strong = !strong;
      i += 2;
      continue;
    }
    if ((char === "*" || char === "_") && (em || /\S/.test(text[i + 1] ?? ""))) {
      // Underscores inside words (snake_case) are text.
      if (char === "_" && /\w/.test(text[i - 1] ?? "") && /\w/.test(text[i + 1] ?? "")) {
        plain += char;
        i++;
        continue;
      }
      push();
      em = !em;
      i++;
      continue;
    }
    if (char === "[") {
      const link = text.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
      if (link) {
        push();
        const href = link[2];
        runs.push(SAFE_LINK.test(href) ? { t: link[1], s: "link", link: href } : { t: link[1], s: style() });
        i += link[0].length;
        continue;
      }
    }
    if (char === "!" && text[i + 1] === "[") {
      // Remote images are not loaded (as on the desktop); show the alt text.
      const image = text.slice(i).match(/^!\[([^\]]*)\]\(([^)]+)\)/);
      if (image) {
        push();
        if (image[1]) runs.push({ t: image[1], s: "meta" });
        i += image[0].length;
        continue;
      }
    }
    plain += char;
    i++;
  }
  push();
  return runs.length ? runs : [{ t: "", s: base }];
}

/** Fast stable hash for row versions. */
export function hash(text: string, seed = 5381): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

function blockRows(block: MdBlock, id: string, base: StyleId, gap: number): RowSpec[] {
  switch (block.kind) {
    case "paragraph":
      return [{ id, v: hash(block.text, hash(base)), k: "markdown", runs: inlineRuns(block.text, base), gap }];
    case "heading": {
      const style = (["h1", "h2", "h3", "h4", "h4", "h4"] as const)[block.level - 1];
      return [{ id, v: hash(block.text, block.level), k: "markdown", runs: inlineRuns(block.text, style), gap: gap + 4 }];
    }
    case "item":
      return [
        {
          id,
          v: hash(block.text + block.marker, block.depth),
          k: "markdown",
          marker: block.marker,
          depth: block.depth,
          runs: inlineRuns(block.text, base),
          gap: Math.min(gap, 4),
        },
      ];
    case "quote":
      return [{ id, v: hash(block.text, 7), k: "markdown", quote: true, runs: inlineRuns(block.text, "em"), gap }];
    case "rule":
      return [{ id, v: 1, k: "spacer", h: 24 + gap }];
    case "table":
      return codeRows(id, "table", block.rows.filter((_, index) => index !== 1), gap, true);
    case "code":
      return codeRows(id, block.lang || "text", block.lines, gap, block.closed);
  }
}

function codeRows(id: string, label: string, lines: string[], gap: number, closed: boolean): RowSpec[] {
  const rows: RowSpec[] = [];
  const chunks = Math.max(1, Math.ceil(lines.length / CODE_CHUNK_LINES));
  for (let c = 0; c < chunks; c++) {
    const slice = lines.slice(c * CODE_CHUNK_LINES, (c + 1) * CODE_CHUNK_LINES);
    const last = c === chunks - 1;
    rows.push({
      id: `${id}.c${c}`,
      v: hash(slice.join("\n"), hash(label, (c === 0 ? 1 : 0) + (last && closed ? 2 : 0) + (last ? 4 : 0))),
      k: "codeBlock",
      label,
      first: c === 0,
      last,
      lines: slice.map((line) => [{ t: line.replace(/\t/g, "  "), s: "code" }]),
      gap: c === 0 ? gap : 0,
    });
  }
  return rows;
}

/** Rows for one markdown body. Earlier blocks are memoised by content, so a
 * streamed delta re-parses and re-measures only the trailing block. */
export function markdownRows(source: string, idPrefix: string, base: StyleId = "prose", firstGap = 12): RowSpec[] {
  const blocks = splitMarkdown(source);
  const rows: RowSpec[] = [];
  blocks.forEach((block, index) => {
    const gap = index === 0 ? firstGap : block.kind === "item" ? 4 : 14;
    rows.push(...blockRows(block, `${idPrefix}#${index}`, base, gap));
  });
  return rows;
}
