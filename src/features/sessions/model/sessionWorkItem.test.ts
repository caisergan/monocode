import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInboxCache,
  githubPrAction,
  githubWorkItem,
  inboxItemKey,
  type GithubWorkItem,
  type InboxItem,
} from "../../inbox/model/githubTasks";
import {
  linkedWorkItemsOf,
  newSession,
  withLinkedWorkItems,
  type Block,
  type LinkedWorkItem,
  type QueuedMessage,
} from "./session";
import {
  createdPullRequests,
  inboxItemMatchesLinkedWorkItem,
  linkedWorkItemInboxKey,
  linkedWorkItemFromAutomationEvent,
  linkedWorkItemFromInboxItem,
  parseGithubWorkItemUrl,
  relatedSessionsForInboxItem,
  resolveLinkedWorkItem,
  withCreatedPullRequests,
} from "./sessionWorkItem";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  clearInboxCache();
  vi.mocked(invoke).mockReset();
});

describe("session work items", () => {
  it("parses a GitHub pull request URL without repository lookup", () => {
    expect(
      parseGithubWorkItemUrl(
        "Please review https://github.com/openai/codex/pull/321?diff=split",
      ),
    ).toEqual({
      kind: "pr",
      repo: "openai/codex",
      number: 321,
      url: "https://github.com/openai/codex/pull/321",
    });
  });

  it("creates a stable link from a GitHub Inbox item", () => {
    const item = {
      provider: "github",
      kind: "issue",
      repo: "openai/codex",
      number: 12,
      url: "https://github.com/openai/codex/issues/12",
    } as InboxItem;
    const linked = linkedWorkItemFromInboxItem(item);
    expect(linked).toEqual({
      kind: "issue",
      repo: "openai/codex",
      number: 12,
      url: "https://github.com/openai/codex/issues/12",
    });
    expect(inboxItemMatchesLinkedWorkItem(item, linked!)).toBe(true);
    expect(linkedWorkItemInboxKey(linked!)).toBe(inboxItemKey(item));
  });

  it("restores a linked PR from a persisted automation event", () => {
    expect(
      linkedWorkItemFromAutomationEvent({
        trigger: "event",
        eventKind: "github",
        eventKey: "github:pr:openai/codex:321",
      }),
    ).toEqual({
      kind: "pr",
      repo: "openai/codex",
      number: 321,
      url: "https://github.com/openai/codex/pull/321",
    });
  });

  it("does not link non-GitHub or malformed automation events", () => {
    expect(
      linkedWorkItemFromAutomationEvent({
        trigger: "event",
        eventKind: "gitlab",
        eventKey: "gitlab:pr:openai/codex:321",
      }),
    ).toBeNull();
    expect(
      linkedWorkItemFromAutomationEvent({
        trigger: "event",
        eventKind: "github",
        eventKey: "github:pr:missing-number",
      }),
    ).toBeNull();
  });

  it("resolves an explicit PR number against the session repository", async () => {
    vi.mocked(invoke).mockResolvedValue("openai/codex");

    await expect(
      resolveLinkedWorkItem("Please fix PR #42", "/tmp/codex", null),
    ).resolves.toEqual({
      kind: "pr",
      repo: "openai/codex",
      number: 42,
      url: "https://github.com/openai/codex/pull/42",
    });
    expect(invoke).toHaveBeenCalledWith("git_github_repo", {
      cwd: "/tmp/codex",
    });
  });

  it("fetches an exact cache miss once and reuses that result", async () => {
    const result: GithubWorkItem = {
      kind: "pr",
      repo: "openai/codex",
      number: 42,
      title: "Faster linked navigation",
      url: "https://github.com/openai/codex/pull/42",
      state: "open",
      updatedAt: "2026-09-09T12:00:00Z",
      labels: [],
      assignees: [],
      draft: false,
    };
    vi.mocked(invoke).mockResolvedValue(result);

    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42),
    ).resolves.toEqual(result);
    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42),
    ).resolves.toEqual(result);

    const refreshed = { ...result, updatedAt: "2026-09-09T12:01:00Z" };
    vi.mocked(invoke).mockResolvedValueOnce(refreshed);
    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42, {
        force: true,
      }),
    ).resolves.toEqual(refreshed);
    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42),
    ).resolves.toEqual(refreshed);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith("git_github_work_item", {
      cwd: "/tmp/codex",
      repo: "openai/codex",
      kind: "pr",
      number: 42,
    });
  });

  it("runs a pull request action and caches the refreshed result", async () => {
    const merged: GithubWorkItem = {
      kind: "pr",
      repo: "openai/codex",
      number: 42,
      title: "Faster linked navigation",
      url: "https://github.com/openai/codex/pull/42",
      state: "merged",
      updatedAt: "2026-09-09T12:05:00Z",
      labels: [],
      assignees: [],
      draft: false,
    };
    vi.mocked(invoke).mockResolvedValue(merged);

    await expect(
      githubPrAction("/tmp/codex", "openai/codex", 42, "squash"),
    ).resolves.toEqual(merged);
    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42),
    ).resolves.toEqual(merged);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("git_github_pr_action", {
      cwd: "/tmp/codex",
      repo: "openai/codex",
      number: 42,
      action: "squash",
    });
  });

  it("does not associate a Linear Inbox item", () => {
    expect(
      linkedWorkItemFromInboxItem({
        provider: "linear",
        kind: "linear",
        number: 12,
        repo: "",
      } as InboxItem),
    ).toBeNull();
  });

  it("finds sessions related to the same GitHub Inbox item", () => {
    const item = {
      provider: "github",
      kind: "pr",
      repo: "Acme/App",
      number: 42,
    } as InboxItem;
    const matching = {
      id: "matching",
      linkedWorkItem: {
        kind: "pr" as const,
        repo: "acme/app",
        number: 42,
        url: "https://github.com/acme/app/pull/42",
      },
    };
    const sessions = [
      matching,
      {
        id: "other-number",
        linkedWorkItem: { ...matching.linkedWorkItem, number: 43 },
      },
      {
        id: "other-kind",
        linkedWorkItem: {
          ...matching.linkedWorkItem,
          kind: "issue" as const,
        },
      },
      { id: "unlinked" },
    ];

    expect(relatedSessionsForInboxItem(item, sessions)).toEqual([matching]);
    expect(
      relatedSessionsForInboxItem(
        { ...item, provider: "linear", kind: "linear" } as InboxItem,
        sessions,
      ),
    ).toEqual([]);
  });
});

function shell(id: string, command: string, output: string): Block {
  return {
    id,
    role: "tool",
    text: command,
    tool: { kind: "execute", status: "completed", title: command, detail: output },
  };
}

describe("PRs the agent opened", () => {
  const created = shell(
    "t1",
    "cd /repo && gh pr create -R acme/web --base dev --title \"Fix\"",
    "Warning: 1 uncommitted change\nhttps://github.com/acme/web/pull/32\n",
  );
  const later = shell(
    "t2",
    "gh pr create --fill",
    "https://github.com/acme/web/pull/40",
  );
  const issue3 = {
    kind: "issue" as const,
    repo: "acme/web",
    number: 3,
    url: "https://github.com/acme/web/issues/3",
  };
  const user = (id: string): Block => ({ id, role: "user", text: "go on" });

  it("reads the PR URL from gh pr create output", () => {
    expect(createdPullRequests([created])).toEqual([
      {
        kind: "pr",
        repo: "acme/web",
        number: 32,
        url: "https://github.com/acme/web/pull/32",
      },
    ]);
  });

  it("uses the PR gh reports when the branch already has one", () => {
    const exists = shell(
      "t1",
      "gh pr create --fill",
      'a pull request for branch "feat" into branch "dev" already exists:\nhttps://github.com/acme/web/pull/7',
    );
    exists.tool!.status = "failed";
    expect(createdPullRequests([exists]).map((item) => item.number)).toEqual([
      7,
    ]);
  });

  it("ignores PR URLs from other commands", () => {
    expect(
      createdPullRequests([
        shell("t1", "gh pr view 12", "https://github.com/acme/web/pull/12"),
        shell("t2", "gh pr list", "https://github.com/acme/web/pull/13"),
      ]),
    ).toEqual([]);
  });

  it("links every PR an unlinked session opened, newest first", () => {
    const session = {
      ...newSession("claude", "/repo"),
      blocks: [user("u1"), created, user("u2"), later],
    };
    const linked = withCreatedPullRequests(session);
    expect(linked.linkedWorkItem?.number).toBe(40);
    expect(linkedWorkItemsOf(linked).map((item) => item.number)).toEqual([
      40, 32,
    ]);
    // Reporting a PR again makes it the newest.
    expect(
      createdPullRequests([created, later, created]).map((item) => item.number),
    ).toEqual([32, 40]);
  });

  it("adds a new PR ahead of existing links", () => {
    const session = {
      ...newSession("claude", "/repo"),
      linkedWorkItem: issue3,
      blocks: [user("u1"), created],
    };
    const linked = withCreatedPullRequests(session);
    expect(linked.linkedWorkItem?.number).toBe(32);
    expect(linkedWorkItemsOf(linked)).toEqual([
      expect.objectContaining({ number: 32 }),
      issue3,
    ]);
    expect(withCreatedPullRequests(linked)).toBe(linked);
  });

  it("reads only the latest turn once linked, so a removed link stays removed", () => {
    const session = {
      ...newSession("claude", "/repo"),
      linkedWorkItem: issue3,
      blocks: [user("u1"), created, user("u2")],
    };
    expect(withCreatedPullRequests(session)).toBe(session);

    // A queued prompt is not the start of the running turn.
    const queued = {
      ...session,
      blocks: [user("u2"), later, user("q1")],
      queuedMessages: [{ blockId: "q1" } as QueuedMessage],
    };
    expect(withCreatedPullRequests(queued).linkedWorkItem?.number).toBe(40);
  });
});

describe("linked work item lists", () => {
  const pr = (number: number, repo = "acme/web"): LinkedWorkItem => ({
    kind: "pr",
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
  });

  it("puts the card's item first and drops duplicates", () => {
    expect(
      linkedWorkItemsOf({
        linkedWorkItem: pr(2),
        linkedWorkItems: [pr(1), pr(2, "ACME/web"), pr(1)],
      }).map((item) => item.number),
    ).toEqual([2, 1]);
    expect(linkedWorkItemsOf({ linkedWorkItems: [pr(1)] })).toEqual([]);
  });

  it("keeps the list only while there is more than one link", () => {
    expect(withLinkedWorkItems({}, [pr(2), pr(1)])).toEqual({
      linkedWorkItem: pr(2),
      linkedWorkItems: [pr(2), pr(1)],
    });
    const single = withLinkedWorkItems(
      { linkedWorkItem: pr(2), linkedWorkItems: [pr(2), pr(1)] },
      [pr(1)],
    );
    expect(single.linkedWorkItem).toEqual(pr(1));
    expect(single.linkedWorkItems).toBeUndefined();
    expect(withLinkedWorkItems(single, []).linkedWorkItem).toBeUndefined();
  });

  it("relates a session to an Inbox row through any of its links", () => {
    const item = {
      provider: "github",
      kind: "pr",
      repo: "acme/web",
      number: 1,
    } as InboxItem;
    const sessions = [
      { id: "a", linkedWorkItem: pr(2), linkedWorkItems: [pr(2), pr(1)] },
      { id: "b", linkedWorkItem: pr(2) },
    ];
    expect(
      relatedSessionsForInboxItem(item, sessions).map((session) => session.id),
    ).toEqual(["a"]);
  });
});
