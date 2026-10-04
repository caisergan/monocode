// The host's workspace shapes (host/workspace.ts, src/platform/tauri/fs.ts).
// @monocode/core/wire doesn't export them yet, so the app mirrors them.

/** `files.list` and `files.search` entries; paths are relative and use "/". */
export type FileEntry = { name: string; path: string; isDir: boolean; ignored: boolean };

export type GitChangedFile = {
  path: string;
  relative: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed" | string;
  additions: number;
  deletions: number;
  staged: boolean;
  unstaged: boolean;
};

/** `git.index`. */
export type GitDiffIndex = {
  branch: string | null;
  head: string | null;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  remote: string | null;
  upstream: string | null;
  defaultBranch: string | null;
  ahead: number;
  behind: number;
  aheadOfDefault: number;
  headPushed: boolean;
};

/** `git.fileDiff`: both sides of one file, not a patch. */
export type GitFileDiff = {
  path: string;
  relative: string;
  status: string;
  original: string;
  current: string;
  binary: boolean;
  tooLarge: boolean;
};

/** Where workspace calls go: a project, optionally one of its working copies
 * (a session's worktree). Without `cwd` the host uses the project folder. */
export type Scope = { env: string; projectId: string; cwd?: string };

export const scopeKey = (scope: Scope): string => `${scope.env}/${scope.projectId}/${scope.cwd ?? ""}`;

/** The params every workspace method takes (06 §6.5). */
export function scopeParams(scope: Scope): { projectId: string; cwd?: string } {
  return scope.cwd ? { projectId: scope.projectId, cwd: scope.cwd } : { projectId: scope.projectId };
}
