import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canCheckOutPullRequest,
  clearPullRequestCache,
  fetchPullRequests,
  githubCliHint,
  isCurrentBranchPullRequest,
  isPullRequestListUnsupported,
  orderPullRequests,
  peekPullRequests,
  pullRequestInboxItem,
  pullRequestReview,
  pullRequestTime,
  type ProjectPullRequest,
} from "./pullRequests";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  clearPullRequestCache();
  vi.mocked(invoke).mockReset();
});

function pr(patch: Partial<ProjectPullRequest> = {}): ProjectPullRequest {
  return {
    number: 1,
    title: "Fix",
    url: "https://github.com/acme/web/pull/1",
    state: "open",
    draft: false,
    author: "octo",
    authorAvatarUrl: "",
    authorIsBot: false,
    headRef: "feat/fix",
    baseRef: "dev",
    crossRepository: false,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewDecision: "",
    checks: "",
    ...patch,
  };
}

describe("orderPullRequests", () => {
  it("lifts the checked-out branch's PR and keeps GitHub's order otherwise", () => {
    const items = [
      pr({ number: 3, headRef: "a" }),
      pr({ number: 2, headRef: "dev-work" }),
      pr({ number: 1, headRef: "b" }),
    ];
    expect(orderPullRequests(items, "dev-work").map((item) => item.number)).toEqual([
      2, 3, 1,
    ]);
    expect(orderPullRequests(items, null).map((item) => item.number)).toEqual([
      3, 2, 1,
    ]);
  });

  it("ignores a fork's branch that only shares the name", () => {
    const fork = pr({ headRef: "main", crossRepository: true });
    expect(isCurrentBranchPullRequest(fork, "main")).toBe(false);
  });
});

describe("row details", () => {
  it("reports when a PR was merged or closed, else its last update", () => {
    expect(pullRequestTime(pr())).toBe("2026-10-02T10:00:00Z");
    expect(
      pullRequestTime(pr({ state: "merged", mergedAt: "2026-10-03T00:00:00Z" })),
    ).toBe("2026-10-03T00:00:00Z");
    expect(
      pullRequestTime(pr({ state: "closed", closedAt: "2026-10-04T00:00:00Z" })),
    ).toBe("2026-10-04T00:00:00Z");
  });

  it("only surfaces review decisions on open PRs", () => {
    expect(pullRequestReview(pr({ reviewDecision: "APPROVED" }))?.tone).toBe(
      "approved",
    );
    expect(
      pullRequestReview(pr({ reviewDecision: "CHANGES_REQUESTED" }))?.label,
    ).toBe("Changes requested");
    expect(pullRequestReview(pr({ reviewDecision: "REVIEW_REQUIRED" }))).toBeNull();
    expect(
      pullRequestReview(pr({ state: "merged", reviewDecision: "APPROVED" })),
    ).toBeNull();
  });

  it("offers checkout only for open same-repo branches that are not current", () => {
    expect(canCheckOutPullRequest(pr(), "dev")).toBe(true);
    expect(canCheckOutPullRequest(pr(), "feat/fix")).toBe(false);
    expect(canCheckOutPullRequest(pr({ crossRepository: true }), "dev")).toBe(false);
    expect(canCheckOutPullRequest(pr({ state: "merged" }), "dev")).toBe(false);
  });

  it("builds an Inbox item that can seed a session", () => {
    expect(pullRequestInboxItem(pr({ number: 9 }), "acme/web", "/repo")).toMatchObject({
      kind: "pr",
      provider: "github",
      repo: "acme/web",
      number: 9,
      projectPath: "/repo",
    });
  });

  it("explains a missing or signed-out GitHub CLI", () => {
    expect(githubCliHint("gh: executable file not found in $PATH")).toMatch(
      /Install the GitHub CLI/,
    );
    expect(githubCliHint("To get started with GitHub CLI, please run: gh auth login")).toMatch(
      /gh auth login/,
    );
    expect(githubCliHint("HTTP 502")).toBeNull();
  });
});

describe("fetchPullRequests", () => {
  it("caches each state's list with the page size it was fetched at", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      repo: "caisergan/monocode",
      viewer: "caisergan",
      items: [pr()],
    });
    await fetchPullRequests("/repo", "merged", 30);
    expect(invoke).toHaveBeenCalledWith("git_github_pull_requests", {
      cwd: "/repo",
      state: "merged",
      limit: 30,
    });
    expect(peekPullRequests("/repo", "merged")).toMatchObject({
      repo: "caisergan/monocode",
      limit: 30,
    });
    expect(peekPullRequests("/repo", "open")).toBeNull();
  });

  it("remembers a checkout with no GitHub remote", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      "none of the git remotes configured for this repository point to a known GitHub host",
    );
    await expect(fetchPullRequests("/plain", "open", 30)).rejects.toThrow();
    expect(isPullRequestListUnsupported("/plain")).toBe(true);
  });
});
