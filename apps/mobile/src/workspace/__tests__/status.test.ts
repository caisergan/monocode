import { palette } from "@monocode/design";
import { describe, expect, it } from "vitest";
import { changeLabel, changeRows, diffStat, formatCount, neighbours, sideFiles, statusColor, statusLetter, statusTone, statusWord } from "../status";
import type { GitChangedFile } from "../types";

describe("status letters and colours", () => {
  const dark = palette({ scheme: "dark" });
  const light = palette({ scheme: "light" });

  it("uses the desktop's letters, plus R for renames", () => {
    expect(["modified", "added", "untracked", "deleted", "renamed", "copied"].map(statusLetter)).toEqual(["M", "A", "U", "D", "R", "M"]);
  });

  it("colours M amber, A and U emerald, D red and R accent", () => {
    expect(["modified", "added", "untracked", "deleted", "renamed"].map(statusTone)).toEqual(["attention", "done", "done", "danger", "accent"]);
    expect(statusColor(dark, "modified")).toBe("#fbbf24");
    expect(statusColor(dark, "added")).toBe("#34d399");
    expect(statusColor(dark, "untracked")).toBe("#34d399");
    expect(statusColor(dark, "deleted")).toBe("#f87171");
    expect(statusColor(dark, "renamed")).toBe(dark.accent);
  });

  it("follows the light theme's tokens", () => {
    expect(statusColor(light, "modified")).toBe(light.status.attention);
    expect(statusColor(light, "added")).toBe(light.status.done);
    expect(statusColor(light, "deleted")).toBe(light.status.danger);
  });

  it("names the status for screen readers", () => {
    expect(statusWord("untracked")).toBe("untracked");
    expect(statusWord("whatever")).toBe("modified");
  });
});

describe("diff stats", () => {
  it("formats +N and −M with thousands separators", () => {
    expect(diffStat(1234, 5)).toEqual({ added: "+1,234", deleted: "−5" });
    expect(formatCount(1_000_000)).toBe("1,000,000");
  });

  it("leaves out a zero side, and both when nothing changed", () => {
    expect(diffStat(3, 0)).toEqual({ added: "+3" });
    expect(diffStat(0, 2)).toEqual({ deleted: "−2" });
    expect(diffStat(0, 0)).toEqual({});
  });
});

describe("change rows", () => {
  it("splits the name from its folder", () => {
    expect(changeLabel({ relative: "src/auth/session.ts" })).toEqual({ name: "session.ts", dir: "src/auth" });
    expect(changeLabel({ relative: "README.md" })).toEqual({ name: "README.md", dir: "" });
  });
});

const file = (relative: string, staged: boolean, unstaged: boolean, status = "modified"): GitChangedFile => ({
  path: relative,
  relative,
  status,
  additions: 1,
  deletions: 0,
  staged,
  unstaged,
});

describe("the staged and unstaged lists", () => {
  const files = [
    file("a.ts", true, false, "added"),
    file("b.ts", true, true),
    file("c.ts", false, true),
    file("d.ts", false, true, "untracked"),
  ];

  it("lists STAGED CHANGES first, then CHANGES, each with its count", () => {
    expect(changeRows(files).map((row) => (row.type === "section" ? `${row.side}:${row.count}` : row.key))).toEqual([
      "staged:2",
      "staged:a.ts",
      "staged:b.ts",
      "unstaged:3",
      "unstaged:b.ts",
      "unstaged:c.ts",
      "unstaged:d.ts",
    ]);
  });

  it("puts a partly staged file in both lists, with distinct keys", () => {
    const rows = changeRows(files).filter((row) => row.type === "file" && row.file.relative === "b.ts");
    expect(rows.map((row) => row.side)).toEqual(["staged", "unstaged"]);
    const keys = changeRows(files).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves out an empty list", () => {
    expect(changeRows([file("c.ts", false, true)]).map((row) => row.key)).toEqual(["section:unstaged", "unstaged:c.ts"]);
    expect(changeRows([file("a.ts", true, false)]).map((row) => row.key)).toEqual(["section:staged", "staged:a.ts"]);
    expect(changeRows([])).toEqual([]);
  });

  it("steps Prev and Next within one side", () => {
    expect(sideFiles(files, "staged").map((entry) => entry.relative)).toEqual(["a.ts", "b.ts"]);
    expect(neighbours(files, "b.ts", "staged")).toEqual({ previous: files[0], next: undefined });
    expect(neighbours(files, "b.ts", "unstaged")).toEqual({ previous: undefined, next: files[2] });
    expect(neighbours(files, "c.ts", "unstaged")).toEqual({ previous: files[1], next: files[3] });
    expect(neighbours(files, "c.ts", "staged")).toEqual({});
  });
});
