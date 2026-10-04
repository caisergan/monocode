import { describe, expect, it } from "vitest";
import { ChannelRequestError } from "@monocode/channel/envelope";
import { cantShowError, fileDiff, gitIndex, listFiles, MAX_FILE_BYTES, readFile, searchFiles, utf8Length, viewableText } from "../api";

function host(result: unknown) {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  return {
    calls,
    request: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push([method, params]);
      return result as T;
    },
  };
}

describe("workspace reads", () => {
  const project = { env: "e", projectId: "p-app" };
  const worktree = { ...project, cwd: "/work/fix-auth" };

  it("pass the working copy only when there is one", async () => {
    const reader = host("text");
    await readFile(reader, project, "README.md");
    await readFile(reader, worktree, "README.md");
    expect(reader.calls).toEqual([
      ["files.read", { projectId: "p-app", path: "README.md" }],
      ["files.read", { projectId: "p-app", cwd: "/work/fix-auth", path: "README.md" }],
    ]);
  });

  it("list folders first", async () => {
    const reader = host([
      { name: "b.ts", path: "b.ts", isDir: false, ignored: false },
      { name: "src", path: "src", isDir: true, ignored: false },
    ]);
    const entries = await listFiles(reader, project, "");
    expect(entries.map((entry) => entry.name)).toEqual(["src", "b.ts"]);
    expect(reader.calls[0]).toEqual(["files.list", { projectId: "p-app", path: "" }]);
  });

  it("use the host's method names and params", async () => {
    const reader = host(null);
    await searchFiles(reader, worktree, "sess");
    await gitIndex(reader, worktree);
    await fileDiff(reader, worktree, "src/a.ts", true);
    expect(reader.calls).toEqual([
      ["files.search", { projectId: "p-app", cwd: "/work/fix-auth", query: "sess" }],
      ["git.index", { projectId: "p-app", cwd: "/work/fix-auth" }],
      ["git.fileDiff", { projectId: "p-app", cwd: "/work/fix-auth", path: "src/a.ts", staged: true }],
    ]);
  });
});

describe("what the file viewer can show", () => {
  it("shows text up to 1 MiB", () => {
    expect(viewableText("hello")).toBe("hello");
    expect(viewableText("x".repeat(MAX_FILE_BYTES))).toHaveLength(MAX_FILE_BYTES);
  });

  it("refuses binary, oversized and non-text results", () => {
    expect(viewableText("PNG\0\0")).toBeUndefined();
    expect(viewableText("x".repeat(MAX_FILE_BYTES + 1))).toBeUndefined();
    expect(viewableText("é".repeat(MAX_FILE_BYTES / 2 + 1))).toBeUndefined();
    expect(viewableText(null)).toBeUndefined();
  });

  it("treats the host's oversized and binary refusals as can't-show, not as failures", () => {
    const refusal = (message: string) => new ChannelRequestError({ code: "internal", message, retryable: false });
    expect(cantShowError(refusal("File is too large to preview"))).toBe(true);
    expect(cantShowError(refusal("Binary file cannot be previewed"))).toBe(true);
    expect(cantShowError(new Error("Binary file cannot be previewed"))).toBe(true);
    expect(cantShowError(refusal("ENOENT: no such file or directory, realpath '/work/a.ts'"))).toBe(false);
    expect(cantShowError(new Error("Request timed out"))).toBe(false);
  });

  it("measures UTF-8 without encoding", () => {
    for (const text of ["abc", "é", "中文", "😀 ok", ""]) expect(utf8Length(text)).toBe(Buffer.byteLength(text, "utf8"));
  });
});
