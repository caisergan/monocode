// Explorer paths (11 §11.20): breadcrumbs and the desktop's folders-first
// order. Paths are relative to the working copy and use "/"; "" is its root.

import type { FileEntry } from "./types";

export type Crumb = { label: string; path: string };

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** The folder part of a relative path; "" at the root. */
export function dirname(path: string): string {
  const index = path.replace(/\/+$/, "").lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/** Root first, then one crumb per folder down to `path`. */
export function breadcrumbs(path: string, rootLabel: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: rootLabel, path: "" }];
  let current = "";
  for (const part of path.split("/")) {
    if (!part) continue;
    current = current ? `${current}/${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

/** The host's listing order (`listHostFiles`): folders first, then names
 * compared with numeric runs and without case. */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  return Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort(compareEntries);
}

/** Paths through `.git`: the host lists `.git`, dimmed, but refuses to
 * list or read anything at or under it (`workspacePath`). */
export function isGitMetadata(path: string): boolean {
  return path.split("/").some((part) => part.toLowerCase() === ".git");
}

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** Files that offer Preview. */
export function isMarkdown(path: string): boolean {
  return MARKDOWN.test(path);
}
