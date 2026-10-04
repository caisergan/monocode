import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@monocode/core/wire";
import {
  cachedList,
  canLoadMore,
  compareSessionItems,
  mergeFirstPage,
  mergeNextPage,
  removeSession,
  visibleSessions,
  type SessionList,
} from "../paging";

const item = (id: string, updatedAt: number, extra: Partial<SessionListItem> = {}): SessionListItem =>
  ({ id, title: `Session ${id}`, harness: "claude", projectId: "p1", revision: 1, status: "idle", updatedAt, ...extra }) as SessionListItem;
const ids = (list: SessionList) => list.items.map((i) => i.id);

describe("session paging", () => {
  it("orders like the host: pinned, newest, then id", () => {
    const items = [item("b", 5), item("a", 5), item("c", 9), item("p", 1, { pinned: true })];
    expect(items.sort(compareSessionItems).map((i) => i.id)).toEqual(["p", "c", "a", "b"]);
  });

  it("paints cached summaries filtered by the archived toggle, but can't page from them", () => {
    const items = [item("a", 1), item("b", 3, { archived: true }), item("c", 2)];
    const live = cachedList(items, "exclude");
    expect(ids(live)).toEqual(["c", "a"]);
    expect(ids(cachedList(items, "only"))).toEqual(["b"]);
    expect(canLoadMore(live)).toBe(false);
  });

  it("the first page replaces a cached list and reports what to drop from the cache", () => {
    const cached = cachedList([item("a", 9), item("gone", 8), item("old-tail", 1)], "exclude");
    const { list, removed } = mergeFirstPage(cached, { items: [item("a", 10), item("b", 7)], cursor: "k1" });
    expect(ids(list)).toEqual(["a", "b"]);
    expect(list).toMatchObject({ cursor: "k1", complete: false, cached: false });
    expect(removed.sort()).toEqual(["gone", "old-tail"]);
    expect(canLoadMore(list)).toBe(true);
  });

  it("appends next pages, deduplicating by id", () => {
    const first = mergeFirstPage(undefined, { items: [item("a", 10), item("b", 9)], cursor: "k1" }).list;
    const second = mergeNextPage(first, { items: [item("b", 9), item("c", 8)], cursor: "k2" });
    expect(ids(second)).toEqual(["a", "b", "c"]);
    expect(second.cursor).toBe("k2");
    const third = mergeNextPage(second, { items: [item("d", 2)] });
    expect(third).toMatchObject({ complete: true, cursor: undefined });
    expect(canLoadMore(third)).toBe(false);
  });

  it("a refreshed first page keeps later pages and their cursor", () => {
    let list = mergeFirstPage(undefined, { items: [item("a", 10), item("b", 9)], cursor: "k1" }).list;
    list = mergeNextPage(list, { items: [item("c", 8), item("d", 7)], cursor: "k2" });
    // "d" changed and moved to the top; "a", inside the page's range, was deleted.
    const { list: next, removed } = mergeFirstPage(list, { items: [item("d", 20), item("b", 9)], cursor: "k3" });
    expect(ids(next)).toEqual(["d", "b", "c"]);
    expect(next.items[0].updatedAt).toBe(20);
    expect(next.cursor).toBe("k2");
    expect(removed).toEqual(["a"]);
  });

  it("keeps old items past the refreshed page's range: they belong to later pages", () => {
    let list = mergeFirstPage(undefined, { items: [item("a", 10), item("b", 9)], cursor: "k1" }).list;
    list = mergeNextPage(list, { items: [item("c", 8)], cursor: "k2" });
    const { list: next, removed } = mergeFirstPage(list, { items: [item("new", 30), item("a", 10)], cursor: "k3" });
    expect(ids(next)).toEqual(["new", "a", "b", "c"]);
    expect(removed).toEqual([]);
  });

  it("a complete first page drops everything else", () => {
    let list = mergeFirstPage(undefined, { items: [item("a", 10)], cursor: "k1" }).list;
    list = mergeNextPage(list, { items: [item("b", 5)] });
    const { list: next, removed } = mergeFirstPage(list, { items: [item("a", 11)] });
    expect(ids(next)).toEqual(["a"]);
    expect(next.complete).toBe(true);
    expect(removed).toEqual(["b"]);
  });

  it("a newly pinned session moves into the pinned group", () => {
    const list = mergeFirstPage(undefined, { items: [item("a", 10), item("b", 9)] }).list;
    const { list: next } = mergeFirstPage(list, { items: [item("b", 9, { pinned: true }), item("a", 10)] });
    expect(visibleSessions(next, "")).toEqual({ pinned: [next.items[0]], rest: [next.items[1]] });
    expect(next.items[0].id).toBe("b");
  });

  it("removes a deleted session and filters by search", () => {
    const list = mergeFirstPage(undefined, {
      items: [item("a", 10, { title: "Fix flaky auth test" }), item("b", 9, { branch: "feat/auth" }), item("c", 8)],
    }).list;
    expect(ids(removeSession(list, "b"))).toEqual(["a", "c"]);
    expect(removeSession(list, "zzz")).toBe(list);
    expect(visibleSessions(list, "AUTH").rest.map((i) => i.id)).toEqual(["a", "b"]);
    expect(visibleSessions(undefined, "")).toEqual({ pinned: [], rest: [] });
  });
});
