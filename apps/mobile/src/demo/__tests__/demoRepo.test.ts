import { describe, expect, it } from "vitest";
import { statusLetter } from "../../workspace/status";
import { DemoRepo } from "../demoRepo";

describe("the demo repository", () => {
  it("has every kind of change, staged and not", () => {
    const files = DemoRepo.mainCheckout().status().files;
    expect(files.map((file) => [file.relative, statusLetter(file.status), file.staged, file.unstaged])).toEqual([
      ["scripts/release.sh", "U", false, true],
      ["src/app/App.tsx", "M", true, true],
      ["src/auth/legacy.ts", "D", false, true],
      ["src/auth/session.ts", "M", false, true],
      ["src/auth/token.ts", "A", true, false],
      ["src/utils/dates.ts", "R", true, false],
      ["test/auth.test.ts", "M", true, false],
    ]);
  });

  it("lists folders first and dims ignored folders", () => {
    const root = DemoRepo.mainCheckout().list("");
    expect(root.slice(0, 7).map((entry) => [entry.name, entry.isDir, entry.ignored])).toEqual([
      [".git", true, true],
      ["dist", true, true],
      ["docs", true, false],
      ["node_modules", true, true],
      ["scripts", true, false],
      ["src", true, false],
      ["test", true, false],
    ]);
    expect(root.every((entry, index) => index === 0 || !entry.isDir || root[index - 1].isDir)).toBe(true);
    expect(DemoRepo.mainCheckout().list("src/app").map((entry) => entry.path)).toEqual(["src/app/screens", "src/app/App.tsx"]);
  });

  it("refuses binary, oversized and missing files like the host", () => {
    const repo = DemoRepo.mainCheckout();
    expect(repo.read("README.md")).toContain("# my-app");
    expect(() => repo.read("docs/images/logo.png")).toThrow("Binary file cannot be previewed");
    expect(() => repo.read("test/fixtures/big-log.txt")).toThrow("File is too large to preview");
    expect(() => repo.read("src")).toThrow("Path is not a file");
    expect(() => repo.read("../etc/passwd")).toThrow("Path is outside the workspace");
    expect(() => repo.list(".git")).toThrow("Path is outside the workspace");
    expect(() => repo.read(".git/HEAD")).toThrow("Path is outside the workspace");
  });

  it("searches paths, not ignored folders", () => {
    const repo = DemoRepo.mainCheckout();
    expect(repo.search("session").map((entry) => entry.path)).toEqual(["src/auth/session.ts"]);
    expect(repo.search("react")).toEqual([]);
  });

  it("diffs the side asked for", () => {
    const repo = DemoRepo.mainCheckout();
    const unstaged = repo.fileDiff("src/auth/session.ts", false);
    expect(unstaged.original).not.toBe(unstaged.current);
    expect(repo.fileDiff("src/auth/token.ts", true)).toMatchObject({ original: "", status: "added" });
    expect(repo.fileDiff("src/utils/dates.ts", true).original).toContain("shortDuration");
    expect(() => repo.fileDiff("README.md", false)).toThrow("File has no uncommitted changes");
  });

  it("commits what is staged and pushes it", () => {
    const repo = DemoRepo.mainCheckout();
    repo.commit("Serialise token refresh");
    const after = repo.status();
    expect(after.files.map((file) => file.relative)).toEqual(["scripts/release.sh", "src/app/App.tsx", "src/auth/legacy.ts", "src/auth/session.ts"]);
    // The commit took App.tsx's staged change; its later edit is still there.
    expect(after.files.find((file) => file.relative === "src/app/App.tsx")).toMatchObject({ staged: false, unstaged: true });
    expect(after.ahead).toBe(1);
    expect(() => repo.commit("Again")).toThrow("no changes added to commit");
    repo.push();
    expect(repo.status()).toMatchObject({ ahead: 0, headPushed: true, upstream: "origin/main" });
  });

  it("stages and unstages one file, leaving the others", () => {
    const repo = DemoRepo.mainCheckout();
    repo.stage("src/auth/session.ts");
    expect(repo.status().files.find((file) => file.relative === "src/auth/session.ts")).toMatchObject({ staged: true, unstaged: false });
    repo.unstage("test/auth.test.ts");
    expect(repo.status().files.find((file) => file.relative === "test/auth.test.ts")).toMatchObject({ staged: false, unstaged: true });
    expect(repo.status().files.find((file) => file.relative === "src/auth/token.ts")).toMatchObject({ staged: true });
  });

  it("stages deletions and untracked files, and unstaging an added file makes it untracked", () => {
    const repo = DemoRepo.mainCheckout();
    repo.stage("src/auth/legacy.ts");
    repo.stage("scripts/release.sh");
    const staged = repo.status().files;
    expect(staged.find((file) => file.relative === "src/auth/legacy.ts")).toMatchObject({ status: "deleted", staged: true, unstaged: false });
    expect(staged.find((file) => file.relative === "scripts/release.sh")).toMatchObject({ status: "added", staged: true, unstaged: false });
    repo.unstage("src/auth/token.ts");
    expect(repo.status().files.find((file) => file.relative === "src/auth/token.ts")).toMatchObject({ status: "untracked", staged: false });
  });

  it("has a partly staged file, with a different diff on each side", () => {
    const repo = DemoRepo.mainCheckout();
    const staged = repo.fileDiff("src/app/App.tsx", true);
    const unstaged = repo.fileDiff("src/app/App.tsx", false);
    expect(staged.current).toBe(unstaged.original);
    expect(staged.original).not.toBe(staged.current);
    expect(unstaged.current).toContain("Home when no route is given");
    repo.stage("src/app/App.tsx");
    expect(repo.status().files.find((file) => file.relative === "src/app/App.tsx")).toMatchObject({ staged: true, unstaged: false });
  });

  it("stages a folder's files at once", () => {
    const repo = DemoRepo.mainCheckout();
    repo.stage("src/auth");
    const auth = repo.status().files.filter((file) => file.relative.startsWith("src/auth/"));
    expect(auth.map((file) => [file.relative, file.staged, file.unstaged])).toEqual([
      ["src/auth/legacy.ts", true, false],
      ["src/auth/session.ts", true, false],
      ["src/auth/token.ts", true, false],
    ]);
  });

  it("breaks a staged rename back into a deletion and an untracked file", () => {
    const repo = DemoRepo.mainCheckout();
    repo.unstage("src/utils/dates.ts");
    const files = repo.status().files;
    expect(files.find((file) => file.relative === "src/utils/dates.ts")).toMatchObject({ status: "untracked" });
    expect(files.find((file) => file.relative === "src/utils/time.ts")).toMatchObject({ status: "deleted", staged: true });
  });

  it("stages all and unstages all like add -A and reset", () => {
    const repo = DemoRepo.mainCheckout();
    repo.stageAll();
    expect(repo.status().files.every((file) => file.staged && !file.unstaged)).toBe(true);
    expect(repo.status().files.map((file) => file.relative)).not.toContain("node_modules/react/package.json");
    repo.unstageAll();
    expect(repo.status().files.every((file) => !file.staged && file.unstaged)).toBe(true);
  });

  it("goes from unstaged changes to a clean commit", () => {
    const repo = DemoRepo.mainCheckout();
    repo.unstageAll();
    expect(() => repo.commit("Nothing staged")).toThrow("no changes added to commit");
    repo.stageAll();
    repo.commit("Serialise token refresh");
    expect(repo.status().files).toEqual([]);
    expect(repo.read("src/auth/token.ts")).toContain("createToken");
    expect(() => repo.read("src/auth/legacy.ts")).toThrow("ENOENT");
  });

  it("refuses paths that match nothing, like git", () => {
    const repo = DemoRepo.mainCheckout();
    expect(() => repo.stage("nope.ts")).toThrow("did not match any files");
    expect(() => repo.unstage("nope.ts")).toThrow("did not match any file(s) known to git");
    expect(() => repo.stage("")).toThrow("Path is outside the workspace");
  });

  it("needs a message to commit and a remote to push", () => {
    expect(() => DemoRepo.mainCheckout().commit("  ")).toThrow("Enter a commit message");
    const api = DemoRepo.api();
    expect(api.status().remote).toBeNull();
    api.commit("Raise the page size");
    expect(() => api.push()).toThrow("'origin' does not appear to be a git repository");
  });
});
