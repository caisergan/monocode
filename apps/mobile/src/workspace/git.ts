// Git writes from Changes (11 §11.20): commit, push, and staging with the
// desktop's stage, unstage, stage all and unstage all. All are `git.action`
// mutations: the app passes the outbox's `mutate`, so each carries an
// idempotency key and is retried with it for 60 s (06 §6.8). Push gets the
// longer timeout (06 §6.3). The index is refreshed after every action,
// whatever the outcome. Pure apart from the injected calls.

import { MutationUnknownError, RESULT_UNKNOWN } from "../outbox/mutate";
import { scopeParams, type GitDiffIndex, type Scope } from "./types";

export const COMMIT_TIMEOUT_MS = 60_000;
export const PUSH_TIMEOUT_MS = 120_000;
/** Staging uses the default mutation timeout. */
export const STAGE_TIMEOUT_MS = 60_000;

/** `mutate(host, method, params, timeoutMs)` from the outbox, bound to a host. */
export type Mutate = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

export type GitActionResult = {
  committed: boolean;
  pushed: boolean;
  /** Toast text: the host's refusal, or "Result unknown. Refresh to check." */
  error?: string;
};

export function actionError(error: unknown): string {
  if (error instanceof MutationUnknownError) return RESULT_UNKNOWN;
  return error instanceof Error && error.message ? error.message : String(error);
}

type Refresh = () => Promise<unknown> | void;

/** One `git.action`, then a refresh of the index, even when it failed. */
async function gitStep(mutate: Mutate, scope: Scope, params: Record<string, unknown>, timeoutMs: number, refresh: Refresh): Promise<void> {
  try {
    await mutate("git.action", { ...scopeParams(scope), ...params }, timeoutMs);
  } finally {
    await Promise.resolve()
      .then(refresh)
      .catch(() => undefined);
  }
}

/** Commit, then push when asked. Stops at the first failure. */
export async function commitAndPush(mutate: Mutate, scope: Scope, message: string, push: boolean, refresh: Refresh): Promise<GitActionResult> {
  const step = (params: Record<string, unknown>, timeoutMs: number) => gitStep(mutate, scope, params, timeoutMs, refresh);
  let committed = false;
  let pushed = false;
  try {
    await step({ action: "commit", message }, COMMIT_TIMEOUT_MS);
    committed = true;
    if (push) {
      await step({ action: "push" }, PUSH_TIMEOUT_MS);
      pushed = true;
    }
    return { committed, pushed };
  } catch (error) {
    return { committed, pushed, error: actionError(error) };
  }
}

/** The desktop's staging actions; `path` is for one file. */
export type StageAction = { action: "stage" | "unstage"; path: string } | { action: "stageAll" | "unstageAll" };

/** Stages or unstages, then refreshes. `error` is the toast text. */
export async function stageChanges(mutate: Mutate, scope: Scope, change: StageAction, refresh: Refresh): Promise<{ done: boolean; error?: string }> {
  try {
    await gitStep(mutate, scope, { ...change }, STAGE_TIMEOUT_MS, refresh);
    return { done: true };
  } catch (error) {
    return { done: false, error: actionError(error) };
  }
}

/** Every Git write waits while a session in the project runs (the host's
 * `withIdleProject`), while another one from this screen is in flight, and
 * needs the host's `git.action`. */
export function gitWritable({ running, busy, capable }: { running: boolean; busy: boolean; capable: boolean }): boolean {
  return capable && !running && !busy;
}

/** The staging buttons: per file whenever writable; Stage All and Unstage
 * All when their section has files. */
export function stageState(input: { index: GitDiffIndex | undefined; running: boolean; busy: boolean; capable: boolean }): {
  canStage: boolean;
  canStageAll: boolean;
  canUnstageAll: boolean;
} {
  const writable = gitWritable(input);
  const files = input.index?.files ?? [];
  return {
    canStage: writable,
    canStageAll: writable && files.some((file) => file.unstaged),
    canUnstageAll: writable && files.some((file) => file.staged),
  };
}

export type CommitInput = {
  message: string;
  index: GitDiffIndex | undefined;
  /** A session in the project runs: the host would refuse (`withIdleProject`). */
  running: boolean;
  /** A commit or push from this screen is still in flight. */
  busy: boolean;
  /** The host lists `git.action`. */
  capable: boolean;
};

/** The desktop's rules (`canCommit`, `canCommitPush`): something staged, a
 * message, nothing running; push also needs a remote and no divergence. */
export function commitState({ message, index, running, busy, capable }: CommitInput): { canCommit: boolean; canCommitPush: boolean } {
  const staged = !!index?.files.some((file) => file.staged);
  const canCommit = gitWritable({ running, busy, capable }) && staged && message.trim().length > 0;
  const diverged = (index?.ahead ?? 0) > 0 && (index?.behind ?? 0) > 0;
  return { canCommit, canCommitPush: canCommit && !!index?.remote && !diverged };
}

/** One report of a session's status: an inbox row, a session list item, or
 * the open session's sync. */
export type SessionStatus = { id: string; projectId: string; status: string; revision: number };

/** Whether any session in the project runs, by the newest report of each.
 * The host refuses Git writes project-wide, so a working copy's view asks
 * the same question. Later sources win ties. */
export function projectRunning(projectId: string, ...sources: readonly (readonly SessionStatus[])[]): boolean {
  const latest = new Map<string, SessionStatus>();
  for (const source of sources)
    for (const report of source) {
      if (report.projectId !== projectId) continue;
      const seen = latest.get(report.id);
      if (!seen || report.revision >= seen.revision) latest.set(report.id, report);
    }
  for (const report of latest.values()) if (report.status === "running") return true;
  return false;
}
