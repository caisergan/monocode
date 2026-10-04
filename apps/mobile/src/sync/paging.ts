// Session lists paged with `sessions.page` (06 §6.5, 11 §11.14). Pure, so
// the merge rules are unit-tested; the project sync applies them.

import type { SessionListItem } from "@monocode/core/wire";

export type ArchivedFilter = "exclude" | "only";

export type SessionPage = { items: SessionListItem[]; cursor?: string };

export type SessionList = {
  /** In the host's page order. */
  items: SessionListItem[];
  /** Where the next page starts; absent when complete or unknown. */
  cursor?: string;
  complete: boolean;
  /** Painted from the cache; no page fetched since the list opened. */
  cached: boolean;
};

/** The host's page order (`HostStore.page`): pinned first, then newest,
 * then id. */
export function compareSessionItems(a: SessionListItem, b: SessionListItem): number {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function matchesArchived(item: SessionListItem, archived: ArchivedFilter): boolean {
  return archived === "only" ? !!item.archived : !item.archived;
}

const ordered = (items: Iterable<SessionListItem>) => [...items].sort(compareSessionItems);

/** A list painted from cached summaries. Its extent is unknown, so it can't
 * page until the first page has been fetched. */
export function cachedList(items: readonly SessionListItem[], archived: ArchivedFilter): SessionList {
  return { items: ordered(items.filter((item) => matchesArchived(item, archived))), complete: false, cached: true };
}

/** Applies a refetched first page. The page is the truth for the range it
 * covers: anything old in that range it doesn't contain was deleted,
 * archived or moved. Pages loaded beyond it are kept, and so is their
 * cursor, which stays valid because the host's cursors are sort keys, not
 * offsets. `removed` lists ids to drop from the cache. */
export function mergeFirstPage(list: SessionList | undefined, page: SessionPage): { list: SessionList; removed: string[] } {
  const fresh = new Map(page.items.map((item) => [item.id, item]));
  const items = ordered(fresh.values());
  const last = items[items.length - 1];
  const old = list?.items ?? [];
  // A cached list's tail may be arbitrarily stale, so only a live list keeps one.
  const keepTail = !!list && !list.cached && !!page.cursor && !!last;
  const tail = keepTail ? old.filter((item) => !fresh.has(item.id) && compareSessionItems(item, last) > 0) : [];
  const kept = new Set(tail.map((item) => item.id));
  const removed = old.filter((item) => !fresh.has(item.id) && !kept.has(item.id)).map((item) => item.id);
  return {
    list: tail.length
      ? { items: [...items, ...tail], cursor: list!.cursor, complete: list!.complete, cached: false }
      : { items, cursor: page.cursor, complete: !page.cursor, cached: false },
    removed,
  };
}

/** Appends the page after `list.cursor`. Fresh copies replace old ones. */
export function mergeNextPage(list: SessionList, page: SessionPage): SessionList {
  const byId = new Map(list.items.map((item) => [item.id, item]));
  for (const item of page.items) byId.set(item.id, item);
  return { items: ordered(byId.values()), cursor: page.cursor, complete: !page.cursor, cached: false };
}

export function canLoadMore(list: SessionList | undefined): boolean {
  return !!list && !list.cached && !list.complete && !!list.cursor;
}

export function removeSession(list: SessionList, id: string): SessionList {
  return list.items.some((item) => item.id === id) ? { ...list, items: list.items.filter((item) => item.id !== id) } : list;
}

/** What the list shows: the search applied, pinned sessions first. */
export function visibleSessions(list: SessionList | undefined, query: string): { pinned: SessionListItem[]; rest: SessionListItem[] } {
  const needle = query.trim().toLowerCase();
  const items = (list?.items ?? []).filter(
    (item) =>
      !needle ||
      item.title.toLowerCase().includes(needle) ||
      !!item.branch?.toLowerCase().includes(needle) ||
      !!item.lastText?.toLowerCase().includes(needle),
  );
  return { pinned: items.filter((item) => item.pinned), rest: items.filter((item) => !item.pinned) };
}
