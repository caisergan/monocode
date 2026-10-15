import {
  linkedWorkItemsOf,
  type LinkedWorkItem,
} from "../../sessions/model/session";
import type { GithubWorkItem } from "./githubTasks";
import type { SessionSummary } from "../../sessions/data/sessionStore";

export type LinkedWorkItemTarget = {
  key: string;
  item: LinkedWorkItem;
};

export type LinkedSessionUpdate = {
  sessionId: string;
  item: GithubWorkItem;
  /** The last local turn or acknowledged remote snapshot, whichever is newer. */
  since: number;
  updatedAt: number;
};

export function linkedWorkItemUpdateKey(
  item: Pick<LinkedWorkItem, "repo" | "kind" | "number">,
): string {
  return `${item.repo.trim().toLowerCase()}:${item.kind}:${item.number}`;
}

export function linkedWorkItemTargets(
  sessions: readonly SessionSummary[],
): LinkedWorkItemTarget[] {
  const targets = new Map<string, LinkedWorkItem>();
  for (const session of sessions) {
    if (session.archived) continue;
    for (const item of linkedWorkItemsOf(session)) {
      const key = linkedWorkItemUpdateKey(item);
      if (!targets.has(key)) targets.set(key, item);
    }
  }
  return [...targets].map(([key, item]) => ({ key, item }));
}

/**
 * Sessions with a GitHub item that changed after the last local turn/read
 * snapshot. A session with several links reports its latest change.
 */
export function linkedSessionUpdates(
  sessions: readonly SessionSummary[],
  workItems: ReadonlyMap<string, GithubWorkItem>,
  seenAt: (sessionId: string) => number = () => 0,
): Map<string, LinkedSessionUpdate> {
  const updates = new Map<string, LinkedSessionUpdate>();
  for (const session of sessions) {
    if (session.archived) continue;
    const since = Math.max(session.updatedAt, seenAt(session.id));
    for (const linked of linkedWorkItemsOf(session)) {
      const item = workItems.get(linkedWorkItemUpdateKey(linked));
      if (!item) continue;
      const remoteUpdatedAt = Date.parse(item.updatedAt);
      if (!Number.isFinite(remoteUpdatedAt) || remoteUpdatedAt <= since) {
        continue;
      }
      if ((updates.get(session.id)?.updatedAt ?? 0) >= remoteUpdatedAt) {
        continue;
      }
      updates.set(session.id, {
        sessionId: session.id,
        item,
        since,
        updatedAt: remoteUpdatedAt,
      });
    }
  }
  return updates;
}

export function linkedSessionUpdateIds(
  sessions: readonly SessionSummary[],
  workItems: ReadonlyMap<string, GithubWorkItem>,
  seenAt?: (sessionId: string) => number,
): Set<string> {
  return new Set(linkedSessionUpdates(sessions, workItems, seenAt).keys());
}
