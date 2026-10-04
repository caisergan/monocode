// The demo machine's repositories (12 §12.13): an in-memory Git working copy
// per project folder or worktree, answering files.list, files.read,
// files.search, git.index, git.fileDiff and git.action (stage, unstage,
// stageAll, unstageAll, commit, push) with the host's shapes and error
// messages (host/workspace.ts). Three trees, as
// in Git: HEAD, the index and the working tree; status letters come from
// comparing them, like `git status --porcelain`.
//
// The main checkout of my-app has nested folders, a Markdown README, a
// binary logo, an oversized log, a long generated file, and modified,
// added, untracked, deleted and renamed changes, some staged and one partly
// staged. Pure: the
// demo host adds the busy rule and timing.

import { fileDiffModel } from "../workspace/diff";
import type { FileEntry, GitChangedFile, GitDiffIndex, GitFileDiff } from "../workspace/types";

/** Text, or a stand-in for a file the host won't send. */
type Blob = string | { binary: true; size: number } | { tooLarge: true; size: number };
type Tree = Map<string, Blob>;

const MAX_FILE = 1024 * 1024;

const SESSION_TS = `import { readToken, writeToken } from "./token-store";
import type { Session, Token } from "./types";

const REFRESH_MARGIN_MS = 60_000;

export class SessionStore {
  private session: Session | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  current(): Session | null {
    return this.session;
  }

  async refresh(userId: string): Promise<Token> {
    const token = await readToken(userId);
    if (token.expiresAt - this.now() > REFRESH_MARGIN_MS) return token;
    const next = await fetchToken(userId, token.refreshToken);
    await writeToken(userId, next);
    this.session = { userId, token: next };
    return next;
  }

  signOut(): void {
    this.session = null;
  }
}

async function fetchToken(userId: string, refreshToken: string): Promise<Token> {
  const response = await fetch("/api/token", {
    method: "POST",
    body: JSON.stringify({ userId, refreshToken }),
  });
  if (!response.ok) throw new Error(\`Token refresh failed: \${response.status}\`);
  return (await response.json()) as Token;
}
`;

const SESSION_TS_NEW = `import { readToken, writeToken } from "./token-store";
import { createToken } from "./token";
import type { Session, Token } from "./types";

const REFRESH_MARGIN_MS = 60_000;

export class SessionStore {
  private session: Session | null = null;
  /** One refresh per user at a time; later callers share it. */
  private inFlight = new Map<string, Promise<Token>>();

  constructor(private readonly now: () => number = Date.now) {}

  current(): Session | null {
    return this.session;
  }

  refresh(userId: string): Promise<Token> {
    const running = this.inFlight.get(userId);
    if (running) return running;
    const promise = this.refreshOnce(userId).finally(() => this.inFlight.delete(userId));
    this.inFlight.set(userId, promise);
    return promise;
  }

  private async refreshOnce(userId: string): Promise<Token> {
    const token = await readToken(userId);
    if (token.expiresAt - this.now() > REFRESH_MARGIN_MS) return token;
    const next = createToken(await fetchToken(userId, token.refreshToken));
    await writeToken(userId, next);
    this.session = { userId, token: next };
    return next;
  }

  signOut(): void {
    this.inFlight.clear();
    this.session = null;
  }
}

async function fetchToken(userId: string, refreshToken: string): Promise<Token> {
  const response = await fetch("/api/token", {
    method: "POST",
    body: JSON.stringify({ userId, refreshToken }),
  });
  if (!response.ok) throw new Error(\`Token refresh failed: \${response.status}\`);
  return (await response.json()) as Token;
}
`;

const TOKEN_TS = `import type { Token } from "./types";

/** Normalises a token from the server: seconds become milliseconds. */
export function createToken(raw: { access: string; refresh: string; expiresIn: number }, now = Date.now()): Token {
  return {
    accessToken: raw.access,
    refreshToken: raw.refresh,
    expiresAt: now + raw.expiresIn * 1000,
  };
}
`;

const LEGACY_TS = `// Kept for the v1 cookie flow; nothing imports it any more.
export function legacyCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(\`\${name}=\`))
    ?.split("=")[1];
}
`;

const AUTH_TEST = `import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/auth/session";

describe("SessionStore", () => {
  it("keeps a fresh token", async () => {
    const store = new SessionStore(() => 0);
    expect(await store.refresh("u1")).toBeDefined();
  });
});
`;

const AUTH_TEST_NEW = `import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/auth/session";

describe("SessionStore", () => {
  it("keeps a fresh token", async () => {
    const store = new SessionStore(() => 0);
    expect(await store.refresh("u1")).toBeDefined();
  });

  it("refreshes once when two callers race", async () => {
    const store = new SessionStore(() => Number.MAX_SAFE_INTEGER);
    const fetch = vi.spyOn(globalThis, "fetch");
    await Promise.all([store.refresh("u1"), store.refresh("u1")]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
`;

const TIME_TS = `/** "5m", "2h", "3d" from a duration in milliseconds. */
export function shortDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return \`\${minutes}m\`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return \`\${hours}h\`;
  return \`\${Math.floor(hours / 24)}d\`;
}
`;

const DATES_TS = `/** "5m", "2h", "3d" from a duration in milliseconds. */
export function shortDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return \`\${minutes}m\`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return \`\${hours}h\`;
  return \`\${Math.floor(hours / 24)}d\`;
}
`;

const README = `# my-app

A small app with a session store, used to try **MonoCode** from a phone.

## Getting started

1. Install dependencies with \`npm install\`.
2. Run the tests with \`npm test\`.
3. Start the dev server with \`npm run dev\`.

## Layout

| Folder | What lives there |
|---|---|
| \`src/auth\` | Sessions and tokens |
| \`src/app\` | Screens |
| \`test\` | Unit tests and fixtures |

> Tokens refresh one at a time per user; see \`src/auth/session.ts\`.

\`\`\`ts
const store = new SessionStore();
await store.refresh("u1");
\`\`\`

Read the [architecture notes](docs/architecture.md) before changing the store.
`;

const ARCHITECTURE = `# Architecture

## Auth

The session store owns the current session. Token writes go through
\`token-store.ts\`, which persists them per user.

- Refreshes are serialised per user.
- A failed refresh signs the user out.

## Screens

Screens read the store through hooks and never write tokens themselves.
`;

const RELEASE_SH = `#!/usr/bin/env bash
set -euo pipefail
version="\${1:?usage: release.sh <version>}"
npm version "$version" --no-git-tag-version
npm run build
git tag "v$version"
`;

function generated(): string {
  const lines = ["// Generated by scripts/strings.mjs. Do not edit.", "", "export const STRINGS = {"];
  for (let i = 1; i <= 2400; i++) lines.push(`  key${i}: "String number ${i} for the ${i % 2 ? "settings" : "session"} screen",`);
  lines.push("} as const;", "");
  return lines.join("\n");
}

const APP_TSX = `import { HomeScreen } from "./screens/Home";
import { SettingsScreen } from "./screens/Settings";

export function App({ route }: { route: "home" | "settings" }) {
  return route === "home" ? <HomeScreen /> : <SettingsScreen />;
}
`;

/** App.tsx with a staged change and a further unstaged one. */
const APP_TSX_STAGED = `import { HomeScreen } from "./screens/Home";
import { SettingsScreen } from "./screens/Settings";

export type Route = "home" | "settings";

export function App({ route }: { route: Route }) {
  return route === "home" ? <HomeScreen /> : <SettingsScreen />;
}
`;

const APP_TSX_WORK = `import { HomeScreen } from "./screens/Home";
import { SettingsScreen } from "./screens/Settings";

export type Route = "home" | "settings";

/** The app's root; Home when no route is given. */
export function App({ route = "home" }: { route?: Route }) {
  return route === "home" ? <HomeScreen /> : <SettingsScreen />;
}
`;

const HOME_TSX = `export function HomeScreen() {
  return <main>Welcome back</main>;
}
`;

const SETTINGS_TSX = `export function SettingsScreen() {
\treturn (
\t\t<section>
\t\t\t<h1>Settings</h1>
\t\t</section>
\t);
}
`;

const PACKAGE_JSON = `{
  "name": "my-app",
  "private": true,
  "scripts": { "dev": "vite", "test": "vitest run", "build": "tsc && vite build" },
  "dependencies": { "react": "^19.2.0" },
  "devDependencies": { "typescript": "^6.0.0", "vitest": "^4.0.0" }
}
`;

const BASE: [string, Blob][] = [
  ["README.md", README],
  ["package.json", PACKAGE_JSON],
  [".gitignore", "node_modules\ndist\n"],
  ["tsconfig.json", `{\n  "compilerOptions": { "strict": true, "jsx": "react-jsx" }\n}\n`],
  ["docs/architecture.md", ARCHITECTURE],
  ["docs/images/logo.png", { binary: true, size: 4_812 }],
  ["src/index.ts", `export { App } from "./app/App";\n`],
  ["src/app/App.tsx", APP_TSX],
  ["src/app/screens/Home.tsx", HOME_TSX],
  ["src/app/screens/Settings.tsx", SETTINGS_TSX],
  ["src/auth/session.ts", SESSION_TS],
  ["src/auth/legacy.ts", LEGACY_TS],
  ["src/auth/types.ts", `export type Token = { accessToken: string; refreshToken: string; expiresAt: number };\nexport type Session = { userId: string; token: Token };\n`],
  ["src/generated/strings.ts", generated()],
  ["src/utils/time.ts", TIME_TS],
  ["test/auth.test.ts", AUTH_TEST],
  ["test/fixtures/big-log.txt", { tooLarge: true, size: 3 * MAX_FILE }],
];

/** Git-ignored folders: listed (dimmed) but never in status or search. */
const IGNORED = ["node_modules", "dist"];
const IGNORED_FILES: [string, Blob][] = [
  ["node_modules/react/package.json", `{ "name": "react", "version": "19.2.3" }\n`],
  ["dist/index.js", `export { App } from "./app/App.js";\n`],
];

const isIgnored = (path: string) => IGNORED.some((dir) => path === dir || path.startsWith(`${dir}/`));
const sameBlob = (a: Blob | undefined, b: Blob | undefined) => (typeof a === "string" || typeof b === "string" ? a === b : a?.size === b?.size);
const textOf = (blob: Blob | undefined) => (typeof blob === "string" ? blob : "");

export type RepoOptions = { branch: string; remote: boolean; upstream: boolean; ahead?: number };

export class DemoRepo {
  private head: Tree;
  private index: Tree;
  private work: Tree;
  /** Staged renames: new path → old path. */
  private renames = new Map<string, string>();
  private branch: string;
  private remote: boolean;
  private upstream: boolean;
  private ahead: number;
  private headPushed: boolean;

  constructor(files: [string, Blob][], options: RepoOptions) {
    this.head = new Map(files);
    this.index = new Map(files);
    this.work = new Map([...files, ...IGNORED_FILES]);
    this.branch = options.branch;
    this.remote = options.remote;
    this.upstream = options.upstream;
    this.ahead = options.ahead ?? 0;
    this.headPushed = this.ahead === 0 && options.upstream;
  }

  /** my-app's main checkout, with every kind of change. */
  static mainCheckout(): DemoRepo {
    const repo = new DemoRepo(BASE, { branch: "main", remote: true, upstream: true });
    repo.edit("src/auth/session.ts", SESSION_TS_NEW);
    repo.edit("test/auth.test.ts", AUTH_TEST_NEW, true);
    repo.edit("src/auth/token.ts", TOKEN_TS, true);
    repo.edit("scripts/release.sh", RELEASE_SH);
    repo.remove("src/auth/legacy.ts");
    repo.rename("src/utils/time.ts", "src/utils/dates.ts", DATES_TS);
    repo.edit("src/app/App.tsx", APP_TSX_STAGED, true);
    repo.edit("src/app/App.tsx", APP_TSX_WORK);
    return repo;
  }

  /** The fix/auth worktree: one staged fix, not pushed yet. */
  static fixAuthWorktree(): DemoRepo {
    const repo = new DemoRepo(BASE, { branch: "fix/auth", remote: true, upstream: false, ahead: 2 });
    repo.edit("src/auth/session.ts", SESSION_TS_NEW, true);
    return repo;
  }

  /** A worktree made from New session: clean, on its own branch. */
  static newWorktree(branch: string): DemoRepo {
    return new DemoRepo(BASE, { branch, remote: true, upstream: false });
  }

  /** api: no remote, so Commit and push stays off. */
  static api(): DemoRepo {
    const repo = new DemoRepo(
      [
        ["README.md", "# api\n\nThe sessions API.\n"],
        ["src/routes/sessions.ts", `export const PAGE_SIZE = 50;\n\nexport function page(cursor?: string) {\n  return { cursor, limit: PAGE_SIZE };\n}\n`],
      ],
      { branch: "main", remote: false, upstream: false },
    );
    repo.edit("src/routes/sessions.ts", `export const PAGE_SIZE = 100;\n\nexport function page(cursor?: string, limit = PAGE_SIZE) {\n  return { cursor, limit };\n}\n`, true);
    return repo;
  }

  private edit(path: string, text: string, stage = false): void {
    this.work.set(path, text);
    if (stage) this.index.set(path, text);
  }

  private remove(path: string, stage = false): void {
    this.work.delete(path);
    if (stage) this.index.delete(path);
  }

  /** A staged rename (`git mv`) with further edits staged too. */
  private rename(from: string, to: string, text: string): void {
    this.work.delete(from);
    this.index.delete(from);
    this.work.set(to, text);
    this.index.set(to, text);
    this.renames.set(to, from);
  }

  // ── Files ────────────────────────────────────────────────────────────────

  private dirs(): Set<string> {
    const dirs = new Set<string>([""]);
    for (const path of this.work.keys()) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  }

  private checkPath(input: unknown, allowRoot = false): string {
    if (typeof input !== "string" || input.length > 4096 || input.includes("\0")) throw new Error("Invalid workspace path");
    const path = input.replace(/^\.?\/+/, "").replace(/\/+$/, "");
    if ((!allowRoot && !path) || path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git"))
      throw new Error("Path is outside the workspace");
    return path;
  }

  /** `files.list`: one folder, folders first. The root lists `.git`, dimmed,
   * as the host does, though any path through it is refused. */
  list(input: unknown): FileEntry[] {
    const dir = this.checkPath(input, true);
    const dirs = this.dirs();
    if (!dirs.has(dir)) {
      if (this.work.has(dir)) throw new Error("Path is not a directory");
      throw new Error(`ENOENT: no such file or directory, realpath '${dir}'`);
    }
    const prefix = dir ? `${dir}/` : "";
    const names = new Map<string, boolean>(dir ? [] : [[".git", true]]);
    for (const path of [...this.work.keys(), ...dirs]) {
      if (!path.startsWith(prefix) || path === dir) continue;
      const rest = path.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) names.set(name, (names.get(name) ?? false) || rest.includes("/") || dirs.has(`${prefix}${name}`));
    }
    return [...names]
      .map(([name, isDir]) => ({ name, path: `${prefix}${name}`, isDir, ignored: name === ".git" || isIgnored(`${prefix}${name}`) }))
      .sort(
        (a, b) =>
          Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      );
  }

  /** `files.read`, with the host's refusals. */
  read(input: unknown): string {
    const path = this.checkPath(input);
    const blob = this.work.get(path);
    if (blob === undefined) {
      if (this.dirs().has(path)) throw new Error("Path is not a file");
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }
    if (typeof blob === "string") return blob;
    if ("tooLarge" in blob || blob.size > MAX_FILE) throw new Error("File is too large to preview");
    throw new Error("Binary file cannot be previewed");
  }

  /** `files.search`: up to 200 tracked or untracked paths containing the query. */
  search(input: unknown): FileEntry[] {
    if (typeof input !== "string" || input.length > 200) throw new Error("Invalid search");
    const query = input.trim().toLocaleLowerCase();
    if (!query) return [];
    return [...this.work.keys()]
      .filter((path) => !isIgnored(path) && path.toLocaleLowerCase().includes(query))
      .sort()
      .slice(0, 200)
      .map((path) => ({ name: path.split("/").pop() || path, path, isDir: false, ignored: false }));
  }

  // ── Git ──────────────────────────────────────────────────────────────────

  /** Porcelain codes: [index vs HEAD, work tree vs index]. */
  private code(path: string): string {
    const head = this.head.get(path);
    const index = this.index.get(path);
    const work = this.work.get(path);
    if (head === undefined && index === undefined) return work === undefined ? "  " : "??";
    const x = this.renames.has(path) ? "R" : head === undefined ? "A" : index === undefined ? "D" : sameBlob(head, index) ? " " : "M";
    const y = index === undefined ? " " : work === undefined ? "D" : sameBlob(index, work) ? " " : "M";
    return x + y;
  }

  /** The host's `statusName`, plus "renamed" (the host reports renames as
   * modified). */
  private static status(code: string): string {
    if (code === "??") return "untracked";
    if (code[0] === "R") return "renamed";
    if (code.includes("D")) return "deleted";
    if (code.includes("A")) return "added";
    return "modified";
  }

  private changes(): GitChangedFile[] {
    const paths = new Set([...this.head.keys(), ...this.index.keys(), ...this.work.keys()]);
    const renamedFrom = new Set(this.renames.values());
    const files: GitChangedFile[] = [];
    for (const path of paths) {
      if (isIgnored(path) || renamedFrom.has(path)) continue;
      const code = this.code(path);
      if (code === "  ") continue;
      const before = this.head.get(this.renames.get(path) ?? path);
      const { additions, deletions } = fileDiffModel(textOf(before), textOf(this.work.get(path)));
      files.push({
        path,
        relative: path,
        status: DemoRepo.status(code),
        additions,
        deletions,
        staged: code[0] !== " " && code !== "??",
        unstaged: code[1] !== " " || code === "??",
      });
    }
    return files.sort((a, b) => a.relative.localeCompare(b.relative));
  }

  /** `git.index`. */
  status(): GitDiffIndex {
    const files = this.changes();
    return {
      branch: this.branch,
      head: "a1b2c3d4e5f6",
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      remote: this.remote ? "origin" : null,
      upstream: this.upstream ? `origin/${this.branch}` : null,
      defaultBranch: this.remote ? "main" : null,
      ahead: this.ahead,
      behind: 0,
      aheadOfDefault: this.branch === "main" ? 0 : this.ahead,
      headPushed: this.headPushed,
    };
  }

  /** `git.fileDiff`: HEAD or the index against the index or the work tree. */
  fileDiff(input: unknown, staged: boolean): GitFileDiff {
    const path = this.checkPath(input);
    const file = this.changes().find((entry) => entry.relative === path);
    if (!file) throw new Error("File has no uncommitted changes");
    const original = staged ? this.head.get(this.renames.get(path) ?? path) : this.index.get(path);
    const current = staged ? this.index.get(path) : this.work.get(path);
    const kind = (blob: Blob | undefined, key: "binary" | "tooLarge") => !!blob && typeof blob !== "string" && key in blob;
    return {
      path,
      relative: path,
      status: file.status,
      original: textOf(original),
      current: textOf(current),
      binary: kind(original, "binary") || kind(current, "binary"),
      tooLarge: kind(original, "tooLarge") || kind(current, "tooLarge"),
    };
  }

  /** Paths in `trees` at or under `path`, outside ignored folders. */
  private matching(path: string, trees: Tree[]): string[] {
    const found = new Set<string>();
    for (const tree of trees)
      for (const key of tree.keys()) if (!isIgnored(key) && (key === path || key.startsWith(`${path}/`))) found.add(key);
    return [...found];
  }

  /** Copies the work tree's state of `path` into the index: an edit, a new
   * file or a deletion. */
  private add(path: string): void {
    const blob = this.work.get(path);
    if (blob === undefined) this.index.delete(path);
    else this.index.set(path, blob);
  }

  /** Puts HEAD's state of `path` back in the index. A staged rename it
   * touches becomes an untracked file and a staged deletion again. */
  private restore(path: string): void {
    const blob = this.head.get(path);
    if (blob === undefined) this.index.delete(path);
    else this.index.set(path, blob);
    this.renames.delete(path);
    for (const [to, from] of this.renames) if (from === path) this.renames.delete(to);
  }

  /** `git add -- path`. */
  stage(input: unknown): void {
    const path = this.checkPath(input);
    const paths = this.matching(path, [this.work, this.index]);
    if (!paths.length) throw new Error(`Command failed: git add: fatal: pathspec '${path}' did not match any files`);
    for (const each of paths) this.add(each);
  }

  /** `git restore --staged -- path`. */
  unstage(input: unknown): void {
    const path = this.checkPath(input);
    const paths = this.matching(path, [this.index, this.head]);
    if (!paths.length) throw new Error(`Command failed: git restore: error: pathspec '${path}' did not match any file(s) known to git`);
    for (const each of paths) this.restore(each);
  }

  /** `git add -A -- .` */
  stageAll(): void {
    for (const path of new Set([...this.work.keys(), ...this.index.keys()])) if (!isIgnored(path)) this.add(path);
  }

  /** `git reset -q -- .` */
  unstageAll(): void {
    this.index = new Map(this.head);
    this.renames.clear();
  }

  /** `git commit -m`: what is staged becomes HEAD. */
  commit(message: unknown): void {
    if (typeof message !== "string" || !message.trim() || message.length > 100_000) throw new Error("Enter a commit message");
    if (!this.changes().some((file) => file.staged))
      throw new Error("Command failed: git commit: no changes added to commit (use \"git add\" and/or \"git commit -a\")");
    this.head = new Map(this.index);
    this.renames.clear();
    this.ahead += 1;
    this.headPushed = false;
  }

  /** `git push -u origin HEAD`. */
  push(): void {
    if (!this.remote) throw new Error("Command failed: git push: fatal: 'origin' does not appear to be a git repository");
    this.upstream = true;
    this.ahead = 0;
    this.headPushed = true;
  }
}
