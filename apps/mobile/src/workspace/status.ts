// Changes rows and stats (11 §11.20): the desktop's status letters, with the
// phone's colours (M amber, A or U emerald, D red, R accent), and "+N −M".

import type { Palette } from "@monocode/design";
import type { GitChangedFile } from "./types";

export type StatusTone = "attention" | "done" | "danger" | "accent";

/** The desktop's `statusLetter`, plus R for renames. */
export function statusLetter(status: string): "M" | "A" | "U" | "D" | "R" {
  if (status === "untracked") return "U";
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  return "M";
}

export function statusTone(status: string): StatusTone {
  switch (statusLetter(status)) {
    case "A":
    case "U":
      return "done";
    case "D":
      return "danger";
    case "R":
      return "accent";
    default:
      return "attention";
  }
}

/** The tone as a @monocode/design colour. */
export function statusColor(t: Pick<Palette, "status" | "accent">, status: string): string {
  const tone = statusTone(status);
  return tone === "accent" ? t.accent : t.status[tone];
}

const STATUS_WORDS: Record<ReturnType<typeof statusLetter>, string> = {
  M: "modified",
  A: "added",
  U: "untracked",
  D: "deleted",
  R: "renamed",
};

/** For screen readers: the status in words, not only a coloured letter. */
export function statusWord(status: string): string {
  return STATUS_WORDS[statusLetter(status)];
}

/** 1234 → "1,234", as the desktop's `formatInteger`. */
export function formatCount(value: number): string {
  return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "+N" and "−M" for the Changes header and segment; zero sides are left out,
 * as on the desktop. Empty when nothing changed. */
export function diffStat(additions: number, deletions: number): { added?: string; deleted?: string } {
  return {
    ...(additions > 0 ? { added: `+${formatCount(additions)}` } : {}),
    ...(deletions > 0 ? { deleted: `−${formatCount(deletions)}` } : {}),
  };
}

/** A changed file's row label parts: the name, and its folder. */
export function changeLabel(file: Pick<GitChangedFile, "relative">): { name: string; dir: string } {
  const index = file.relative.lastIndexOf("/");
  return index < 0 ? { name: file.relative, dir: "" } : { name: file.relative.slice(index + 1), dir: file.relative.slice(0, index) };
}

/** STAGED CHANGES lists index changes, CHANGES work tree changes. */
export type ChangeSide = "staged" | "unstaged";

export type ChangeRow =
  | { type: "section"; key: string; side: ChangeSide; count: number }
  | { type: "file"; key: string; side: ChangeSide; file: GitChangedFile };

/** A side's files, in the index's order. */
export function sideFiles(files: readonly GitChangedFile[], side: ChangeSide): GitChangedFile[] {
  return files.filter((file) => (side === "staged" ? file.staged : file.unstaged));
}

/** The desktop's two lists: STAGED CHANGES when something is staged, then
 * CHANGES. A partly staged file is in both. */
export function changeRows(files: readonly GitChangedFile[]): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const side of ["staged", "unstaged"] as const) {
    const listed = sideFiles(files, side);
    if (!listed.length) continue;
    rows.push({ type: "section", key: `section:${side}`, side, count: listed.length });
    for (const file of listed) rows.push({ type: "file", key: `${side}:${file.relative}`, side, file });
  }
  return rows;
}

/** Prev and Next file in the diff viewer, within the same side. */
export function neighbours(files: readonly GitChangedFile[], path: string, side: ChangeSide): { previous?: GitChangedFile; next?: GitChangedFile } {
  const listed = sideFiles(files, side);
  const index = listed.findIndex((file) => file.relative === path);
  if (index < 0) return {};
  return { previous: listed[index - 1], next: listed[index + 1] };
}
