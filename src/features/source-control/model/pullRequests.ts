import { invoke } from "@tauri-apps/api/core";
import { normalizeProjectPath } from "../../projects/model/recents";
import type { InboxItem } from "../../inbox/model/githubTasks";

export type PullRequestState = "open" | "merged" | "closed";

export const PULL_REQUEST_STATES: readonly PullRequestState[] = [
  "open",
  "merged",
  "closed",
];

export type ProjectPullRequest = {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  author: string;
  authorAvatarUrl: string;
  authorIsBot: boolean;
  headRef: string;
  baseRef: string;
  /** The head branch lives in another repository, usually a contributor's fork. */
  crossRepository: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  reviewDecision: string;
  /** Rolled-up CI for open pull requests; empty when there are no checks. */
  checks: "pass" | "fail" | "pending" | "";
};

export type PullRequestList = {
  repo: string;
  /** Signed-in GitHub login, or empty when it could not be read. */
  viewer: string;
  items: ProjectPullRequest[];
};

/** Rows per page; the Show more button adds another page up to the cap. */
export const PULL_REQUEST_PAGE = 30;
export const PULL_REQUEST_MAX = 100;

type CachedList = PullRequestList & { limit: number; fetchedAt: number };

const lists = new Map<string, CachedList>();
const inflight = new Map<string, Promise<CachedList>>();
/** Projects whose remote is not on GitHub, so the section stays hidden. */
const unsupported = new Set<string>();

function listKey(cwd: string, state: PullRequestState): string {
  return `${normalizeProjectPath(cwd)}\n${state}`;
}

export function peekPullRequests(
  cwd: string,
  state: PullRequestState,
): CachedList | null {
  return lists.get(listKey(cwd, state)) ?? null;
}

export function isPullRequestListUnsupported(cwd: string): boolean {
  return unsupported.has(normalizeProjectPath(cwd));
}

export function fetchPullRequests(
  cwd: string,
  state: PullRequestState,
  limit: number,
): Promise<CachedList> {
  const key = listKey(cwd, state);
  const pendingKey = `${key}\n${limit}`;
  const pending = inflight.get(pendingKey);
  if (pending) return pending;
  const promise = invoke<PullRequestList>("git_github_pull_requests", {
    cwd,
    state,
    limit,
  })
    .then((list) => {
      unsupported.delete(normalizeProjectPath(cwd));
      const cached = { ...list, limit, fetchedAt: Date.now() };
      lists.set(key, cached);
      return cached;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (isNotGithubError(message)) {
        unsupported.add(normalizeProjectPath(cwd));
      }
      throw new Error(message);
    })
    .finally(() => {
      if (inflight.get(pendingKey) === promise) inflight.delete(pendingKey);
    });
  inflight.set(pendingKey, promise);
  return promise;
}

/** gh could not map the checkout to a GitHub repository at all. */
export function isNotGithubError(message: string): boolean {
  return /not a git repository|no git remotes|known github host|could not determine|unable to determine/i.test(
    message,
  );
}

/** gh is missing or signed out, which the user can fix from a terminal. */
export function githubCliHint(message: string): string | null {
  if (/not found|no such file|executable file not found/i.test(message)) {
    return "Install the GitHub CLI (gh) to see pull requests.";
  }
  if (/auth login|not logged in|authentication/i.test(message)) {
    return "Sign in with `gh auth login` to see pull requests.";
  }
  return null;
}

/** The time a row reports: when it was merged or closed, else last activity. */
export function pullRequestTime(pr: ProjectPullRequest): string {
  if (pr.state === "merged") return pr.mergedAt || pr.updatedAt;
  if (pr.state === "closed") return pr.closedAt || pr.updatedAt;
  return pr.updatedAt;
}

/** Keep GitHub's newest-first order, but lift the current branch's PR to the top. */
export function orderPullRequests(
  items: readonly ProjectPullRequest[],
  branch: string | null | undefined,
): ProjectPullRequest[] {
  const current = branch?.trim();
  if (!current) return [...items];
  const own = items.filter(
    (pr) => !pr.crossRepository && pr.headRef === current,
  );
  if (own.length === 0) return [...items];
  return [...own, ...items.filter((pr) => !own.includes(pr))];
}

export function isCurrentBranchPullRequest(
  pr: ProjectPullRequest,
  branch: string | null | undefined,
): boolean {
  return !!branch && !pr.crossRepository && pr.headRef === branch.trim();
}

export type PullRequestReview = {
  label: string;
  tone: "approved" | "changes";
};

/** Only decisions worth a glance; "review required" is the default state. */
export function pullRequestReview(
  pr: ProjectPullRequest,
): PullRequestReview | null {
  if (pr.state !== "open") return null;
  if (pr.reviewDecision === "APPROVED") {
    return { label: "Approved", tone: "approved" };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { label: "Changes requested", tone: "changes" };
  }
  return null;
}

/** Check out from the list only where git can: same-repo branches that are open. */
export function canCheckOutPullRequest(
  pr: ProjectPullRequest,
  branch: string | null | undefined,
): boolean {
  return (
    pr.state === "open" &&
    !pr.crossRepository &&
    !!pr.headRef &&
    !isCurrentBranchPullRequest(pr, branch)
  );
}

/** The Inbox's shape for a GitHub pull request, so it can seed a session. */
export function pullRequestInboxItem(
  pr: ProjectPullRequest,
  repo: string,
  projectPath: string,
): InboxItem {
  return {
    kind: "pr",
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    labels: [],
    assignees: [],
    draft: pr.draft,
    repo,
    projectPath,
    provider: "github",
  };
}

export function clearPullRequestCache() {
  lists.clear();
  inflight.clear();
  unsupported.clear();
}
