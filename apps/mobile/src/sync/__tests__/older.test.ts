import { describe, expect, it } from "vitest";
import type { Block, HostSession } from "@monocode/core/session";
import { hasOlder, mergeOlder, type WindowValue } from "../older";

const user = (id: string): Block => ({ id, role: "user", text: id });
const reply = (id: string): Block => ({ id, role: "assistant", text: id });

function windowOf(blocks: Block[], olderTurns: number, olderBlocks: number): WindowValue {
  const value = {
    projectId: "p1",
    revision: 7,
    status: "idle",
    updatedAt: 1,
    session: { id: "s1", harness: "claude", model: "m", modelSettings: {}, runtimeMode: "supervised", title: "t", cwd: "/", blocks },
  } as HostSession;
  return { value, window: { anchor: blocks[0]?.id ?? null, olderTurns, olderBlocks } };
}

describe("older history merge", () => {
  const current = windowOf([user("u3"), reply("a3")], 2, 4);

  it("prepends the page and moves the anchor to its first block", () => {
    const next = mergeOlder(current, "u3", { blocks: [user("u2"), reply("a2")], olderTurns: 1 });
    expect(next?.value.session.blocks.map((b) => b.id)).toEqual(["u2", "a2", "u3", "a3"]);
    expect(next?.window).toEqual({ anchor: "u2", olderTurns: 1, olderBlocks: 2 });
    expect(next?.value.revision).toBe(7);
    expect(hasOlder(next?.window)).toBe(true);
  });

  it("ends at the first turn", () => {
    const next = mergeOlder(current, "u3", { blocks: [user("u1"), reply("a1"), user("u2"), reply("a2")], olderTurns: 0 });
    expect(next?.window).toEqual({ anchor: "u1", olderTurns: 0, olderBlocks: 0 });
    expect(hasOlder(next?.window)).toBe(false);
  });

  it("drops a page requested against a window that has since been replaced", () => {
    const replaced = windowOf([user("u9"), reply("a9")], 5, 10);
    expect(mergeOlder(replaced, "u3", { blocks: [user("u2")], olderTurns: 1 })).toBeUndefined();
  });

  it("never duplicates blocks the window already has", () => {
    const next = mergeOlder(current, "u3", { blocks: [user("u2"), user("u3")], olderTurns: 1 });
    expect(next?.value.session.blocks.map((b) => b.id)).toEqual(["u2", "u3", "a3"]);
  });

  it("an empty page stops further loading without touching the blocks", () => {
    const next = mergeOlder(current, "u3", { blocks: [], olderTurns: 0 });
    expect(next?.value).toBe(current.value);
    expect(next?.window).toEqual({ anchor: "u3", olderTurns: 0, olderBlocks: 0 });
  });

  it("keeps the rest of the session object", () => {
    const next = mergeOlder(current, "u3", { blocks: [user("u2")], olderTurns: 1 });
    expect(next?.value.session.title).toBe("t");
    expect(current.value.session.blocks.map((b) => b.id)).toEqual(["u3", "a3"]);
  });
});
