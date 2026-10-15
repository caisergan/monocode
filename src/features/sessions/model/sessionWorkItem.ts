import { isExecuteTool } from "../../../integrations/harness/core/preview";
import { gitPrStatus } from "../../../platform/tauri/fs";
import {
  githubRepo,
  inboxIdentityKey,
  type InboxItem,
  type GithubTaskKind,
} from "../../inbox/model/githubTasks";
import {
  linkedWorkItemsOf,
  sameLinkedWorkItem,
  withLinkedWorkItems,
  type Block,
  type LinkedWorkItem,
  type LinkedWorkItems,
  type Session,
} from "./session";
import type { GeneratedWorkItemHint } from "./sessionTitle";

const GITHUB_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)\b/i;

function validNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function githubUrl(repo: string, kind: GithubTaskKind, number: number): string {
  return `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

export function parseGithubWorkItemUrl(message: string): LinkedWorkItem | null {
  const match = GITHUB_URL_RE.exec(message);
  if (!match) return null;
  const number = Number(match[4]);
  if (!validNumber(number)) return null;
  const repo = `${match[1]}/${match[2]}`;
  const kind = match[3].toLowerCase() === "pull" ? "pr" : "issue";
  return { kind, repo, number, url: githubUrl(repo, kind, number) };
}

function explicitHint(message: string): GeneratedWorkItemHint | null {
  const patterns: Array<[GithubTaskKind, RegExp]> = [
    ["pr", /\b(?:pr|pull\s+request)\s*#?\s*(\d+)\b/i],
    ["issue", /\bissue\s*#?\s*(\d+)\b/i],
  ];
  for (const [kind, pattern] of patterns) {
    const match = pattern.exec(message);
    const number = Number(match?.[1]);
    if (match && validNumber(number)) return { kind, number };
  }
  return null;
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function repoFromGithubUrl(url: string): string | null {
  const match = GITHUB_URL_RE.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

function referencesCurrentPr(message: string): boolean {
  return /\b(?:this|the|current)\s+(?:pr|pull\s+request)\b/i.test(message);
}

const PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const PR_URL_RE =
  /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\b/gi;

/** PRs the agent opened with `gh pr create`, newest first, read from its output. */
export function createdPullRequests(
  blocks: readonly Block[],
): LinkedWorkItem[] {
  const created: LinkedWorkItem[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    // A failed create still counts: gh exits non-zero when the branch already
    // has a PR, and prints that PR's URL.
    if (block.role !== "tool") continue;
    const command = block.text || block.tool?.title || "";
    if (!isExecuteTool(block.tool?.kind, command)) continue;
    if (!PR_CREATE_RE.test(command)) continue;
    const output = block.tool?.detail || block.tool?.preview?.output || "";
    // gh prints the new PR's URL last; earlier URLs can be warnings or links.
    const url = output.match(PR_URL_RE)?.at(-1);
    const item = url ? parseGithubWorkItemUrl(url) : null;
    if (item && !created.some((seen) => sameLinkedWorkItem(seen, item))) {
      created.push(item);
    }
  }
  return created;
}

/** Blocks after the prompt that started the latest turn. */
function latestTurn(session: Session): Block[] {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (block.role !== "user") continue;
    // Queued prompts sit after the running turn until they are sent.
    if (session.queuedMessages?.some((queued) => queued.blockId === block.id)) {
      continue;
    }
    return session.blocks.slice(i + 1);
  }
  return session.blocks;
}

/**
 * Add the PRs the agent opened to the session's links, newest first. A linked
 * session only reads its latest turn, so a link removed by hand stays removed.
 */
export function withCreatedPullRequests(session: Session): Session {
  const linked = linkedWorkItemsOf(session);
  const created = createdPullRequests(
    linked.length > 0 ? latestTurn(session) : session.blocks,
  ).filter((item) => !linked.some((seen) => sameLinkedWorkItem(seen, item)));
  return created.length > 0
    ? withLinkedWorkItems(session, [...created, ...linked])
    : session;
}

/** Resolve explicit first-message context to one stable GitHub identity. */
export async function resolveLinkedWorkItem(
  message: string,
  cwd: string,
  generatedHint: GeneratedWorkItemHint | null,
): Promise<LinkedWorkItem | null> {
  const fromUrl = parseGithubWorkItemUrl(message);
  if (fromUrl) return fromUrl;

  const hint = explicitHint(message) ?? generatedHint;
  if (hint && validNumber(hint.number)) {
    try {
      const repo = await githubRepo(cwd);
      if (!validRepo(repo)) return null;
      return {
        ...hint,
        repo,
        url: githubUrl(repo, hint.kind, hint.number),
      };
    } catch {
      return null;
    }
  }

  if (!referencesCurrentPr(message)) return null;
  try {
    const pr = await gitPrStatus(cwd);
    if (!pr || !validNumber(pr.number)) return null;
    const repo = repoFromGithubUrl(pr.url) ?? (await githubRepo(cwd));
    if (!validRepo(repo)) return null;
    return {
      kind: "pr",
      repo,
      number: pr.number,
      url: pr.url || githubUrl(repo, "pr", pr.number),
    };
  } catch {
    return null;
  }
}

export function linkedWorkItemFromInboxItem(
  item: InboxItem,
): LinkedWorkItem | null {
  if (
    item.provider !== "github" ||
    (item.kind !== "issue" && item.kind !== "pr") ||
    !validNumber(item.number) ||
    !validRepo(item.repo)
  ) {
    return null;
  }
  return {
    kind: item.kind,
    repo: item.repo,
    number: item.number,
    url: item.url || githubUrl(item.repo, item.kind, item.number),
  };
}

/** Restore the GitHub identity persisted on an event-triggered automation run. */
export function linkedWorkItemFromAutomationEvent(run: {
  trigger: string;
  eventKind?: string;
  eventKey?: string;
}): LinkedWorkItem | null {
  if (run.trigger !== "event" || run.eventKind !== "github") return null;
  const match = /^github:(pr|issue):([^/:]+\/[^/:]+):([1-9]\d*)$/i.exec(
    run.eventKey?.trim() ?? "",
  );
  if (!match) return null;
  const number = Number(match[3]);
  if (!validNumber(number)) return null;
  const kind = match[1].toLowerCase() === "pr" ? "pr" : "issue";
  const repo = match[2];
  if (!validRepo(repo)) return null;
  return { kind, repo, number, url: githubUrl(repo, kind, number) };
}

export function inboxItemMatchesLinkedWorkItem(
  item: InboxItem,
  linked: LinkedWorkItem,
): boolean {
  return (
    item.provider === "github" &&
    item.kind === linked.kind &&
    item.number === linked.number &&
    item.repo.trim().toLowerCase() === linked.repo.trim().toLowerCase()
  );
}

/** Same key used by Inbox selection, without synthesizing a full Inbox item. */
export function linkedWorkItemInboxKey(linked: LinkedWorkItem): string {
  return `github:${inboxIdentityKey(linked)}`;
}

/** Find local sessions with a persisted link to an Inbox row. */
export function relatedSessionsForInboxItem<T extends LinkedWorkItems>(
  item: InboxItem,
  sessions: readonly T[],
): T[] {
  if (item.provider !== "github") return [];
  return sessions.filter((session) =>
    linkedWorkItemsOf(session).some((linked) =>
      inboxItemMatchesLinkedWorkItem(item, linked),
    ),
  );
}
