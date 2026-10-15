import { describe, expect, it } from "vitest";
import type { LinkedWorkItem } from "../../sessions/model/session";
import type { GithubWorkItem } from "./githubTasks";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import {
  linkedSessionUpdateIds,
  linkedSessionUpdates,
  linkedWorkItemTargets,
  linkedWorkItemUpdateKey,
} from "./linkedSessionUpdates";

const linked: LinkedWorkItem = {
  kind: "pr",
  repo: "Acme/App",
  number: 42,
  url: "https://github.com/Acme/App/pull/42",
};

function remote(updatedAt: number): GithubWorkItem {
  return {
    ...linked,
    title: "Update sidebar activity",
    state: "open",
    updatedAt: new Date(updatedAt).toISOString(),
    labels: [],
    assignees: [],
    draft: false,
  };
}

function session(
  id: string,
  updatedAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    cwd: "/tmp/app",
    harness: "codex",
    model: "gpt-5",
    runtimeMode: "supervised",
    title: `codex · ${id}`,
    createdAt: 1,
    updatedAt,
    linkedWorkItem: linked,
    ...overrides,
  };
}

describe("linked session updates", () => {
  it("marks a session when its linked item changed after the local session", () => {
    const snapshots = new Map([[linkedWorkItemUpdateKey(linked), remote(200)]]);
    expect([
      ...linkedSessionUpdateIds([session("old", 100)], snapshots),
    ]).toEqual(["old"]);
  });

  it("clears naturally once the session advances past the remote update", () => {
    const snapshots = new Map([[linkedWorkItemUpdateKey(linked), remote(200)]]);
    expect(
      linkedSessionUpdateIds([session("continued", 201)], snapshots).size,
    ).toBe(0);
  });

  it("tracks related sessions independently and ignores archived sessions", () => {
    const snapshots = new Map([[linkedWorkItemUpdateKey(linked), remote(200)]]);
    const ids = linkedSessionUpdateIds(
      [
        session("stale", 100),
        session("current", 250),
        session("archived", 100, { archived: true }),
        session("unlinked", 100, { linkedWorkItem: undefined }),
      ],
      snapshots,
    );
    expect([...ids]).toEqual(["stale"]);
  });

  it("normalizes repository case and deduplicates lookup targets", () => {
    const lower = { ...linked, repo: "acme/app" };
    const snapshots = new Map([[linkedWorkItemUpdateKey(lower), remote(200)]]);
    expect(
      linkedSessionUpdateIds([session("same", 100)], snapshots).has("same"),
    ).toBe(true);
    expect(
      linkedWorkItemTargets([
        session("first", 100),
        session("second", 150, { linkedWorkItem: lower }),
      ]),
    ).toHaveLength(1);
  });

  it("watches every link and reports the latest change", () => {
    const older = { ...linked, number: 41, url: "https://github.com/Acme/App/pull/41" };
    const issue = {
      kind: "issue" as const,
      repo: "Acme/App",
      number: 7,
      url: "https://github.com/Acme/App/issues/7",
    };
    const snapshots = new Map([
      [linkedWorkItemUpdateKey(older), { ...remote(300), ...older }],
      [linkedWorkItemUpdateKey(issue), { ...remote(250), ...issue }],
    ]);
    const several = session("several", 100, {
      linkedWorkItems: [linked, older, issue],
    });

    const update = linkedSessionUpdates([several], snapshots).get("several");
    expect(update?.item.number).toBe(41);
    expect(update?.updatedAt).toBe(300);
    expect(linkedWorkItemTargets([several]).map((target) => target.key)).toEqual(
      [linked, older, issue].map(linkedWorkItemUpdateKey),
    );
  });

  it("uses the acknowledged snapshot as the next activity baseline", () => {
    const snapshots = new Map([[linkedWorkItemUpdateKey(linked), remote(200)]]);
    expect(
      linkedSessionUpdateIds([session("read", 100)], snapshots, () => 200).size,
    ).toBe(0);
    expect(
      linkedSessionUpdateIds([session("newer", 100)], snapshots, () => 150).has(
        "newer",
      ),
    ).toBe(true);
  });
});
