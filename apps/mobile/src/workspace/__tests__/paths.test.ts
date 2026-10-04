import { describe, expect, it } from "vitest";
import { basename, breadcrumbs, dirname, isGitMetadata, isMarkdown, sortEntries } from "../paths";
import type { FileEntry } from "../types";

const file = (name: string, isDir = false): FileEntry => ({ name, path: name, isDir, ignored: false });

describe("breadcrumbs", () => {
  it("starts at the working copy root", () => {
    expect(breadcrumbs("", "my-app")).toEqual([{ label: "my-app", path: "" }]);
  });

  it("adds one crumb per folder, each with its full path", () => {
    expect(breadcrumbs("src/app/screens", "my-app")).toEqual([
      { label: "my-app", path: "" },
      { label: "src", path: "src" },
      { label: "app", path: "src/app" },
      { label: "screens", path: "src/app/screens" },
    ]);
  });

  it("ignores empty parts from stray slashes", () => {
    expect(breadcrumbs("/src//app/", "root").map((crumb) => crumb.path)).toEqual(["", "src", "src/app"]);
  });
});

describe("folders-first order", () => {
  it("puts folders before files, each by name", () => {
    const sorted = sortEntries([file("zeta.ts"), file("src", true), file("README.md"), file("docs", true), file("app.ts")]);
    expect(sorted.map((entry) => entry.name)).toEqual(["docs", "src", "app.ts", "README.md", "zeta.ts"]);
  });

  it("compares numbers by value and ignores case, like the host", () => {
    const sorted = sortEntries([file("file10.ts"), file("File2.ts"), file("file1.ts")]);
    expect(sorted.map((entry) => entry.name)).toEqual(["file1.ts", "File2.ts", "file10.ts"]);
  });

  it("leaves the input untouched", () => {
    const input = [file("b"), file("a", true)];
    sortEntries(input);
    expect(input.map((entry) => entry.name)).toEqual(["b", "a"]);
  });
});

describe("path parts", () => {
  it("splits names and folders", () => {
    expect(basename("src/auth/session.ts")).toBe("session.ts");
    expect(basename("README.md")).toBe("README.md");
    expect(dirname("src/auth/session.ts")).toBe("src/auth");
    expect(dirname("README.md")).toBe("");
  });

  it("offers Preview for Markdown only", () => {
    expect(isMarkdown("docs/architecture.md")).toBe(true);
    expect(isMarkdown("NOTES.MARKDOWN")).toBe(true);
    expect(isMarkdown("src/index.ts")).toBe(false);
  });
});

describe("isGitMetadata", () => {
  it("matches .git and anything under it, as the host refuses them", () => {
    for (const path of [".git", ".git/HEAD", "vendor/lib/.git", "sub/.GIT/config"]) expect(isGitMetadata(path), path).toBe(true);
    for (const path of [".gitignore", "src/.github/ci.yml", "git/readme.md", ""]) expect(isGitMetadata(path), path).toBe(false);
  });
});
