import { describe, expect, it } from "vitest";
import { buildContinuationBrief } from "./continuation";
import { newSession, type Block, type Session } from "./session";

function sessionWith(blocks: Block[]): Session {
  return { ...newSession("claude", "/repo"), blocks };
}

function edit(id: string, path: string, additions?: number, deletions?: number) {
  return {
    id,
    role: "tool",
    text: `Edit ${path.split("/").pop()}`,
    tool: {
      kind: "edit",
      preview: { kind: "write", path, additions, deletions },
    },
  } as Block;
}

function read(id: string, path: string) {
  return {
    id,
    role: "tool",
    text: `Read ${path.split("/").pop()}`,
    tool: { kind: "read", preview: { kind: "read", path } },
  } as Block;
}

describe("buildContinuationBrief", () => {
  it("keeps the first request, recent requests and the full latest reply", () => {
    const reply = `Done.\n\n${"Detail line. ".repeat(200).trim()}`;
    const { brief } = buildContinuationBrief(
      sessionWith([
        { id: "u1", role: "user", text: "Fix the legal pages" },
        { id: "a1", role: "assistant", text: "Old reply" },
        { id: "u2", role: "user", text: "second" },
        { id: "u3", role: "user", text: "third" },
        { id: "u4", role: "user", text: "fourth" },
        { id: "u5", role: "user", text: "fifth" },
        { id: "a2", role: "assistant", text: reply },
      ]),
    );
    expect(brief).toContain("## First request\nFix the legal pages");
    expect(brief).toContain(
      "## Latest requests\n(1 earlier messages omitted)\n- third\n- fourth\n- fifth",
    );
    expect(brief).toContain(`## Latest response\n${reply}`);
    expect(brief).not.toContain("Old reply");
  });

  it("joins every reply of the last turn and cuts long ones from the start", () => {
    const { brief } = buildContinuationBrief(
      sessionWith([
        { id: "u1", role: "user", text: "go" },
        { id: "a1", role: "assistant", text: `START ${"x".repeat(9_000)}` },
        { id: "a2", role: "assistant", text: "Final summary" },
      ]),
    );
    expect(brief).toContain("[earlier part truncated]");
    expect(brief).not.toContain("START");
    expect(brief).toMatch(/Final summary$/);
  });

  it("lists only this session's edits with summed line counts", () => {
    const result = buildContinuationBrief(
      sessionWith([
        { id: "u1", role: "user", text: "go" },
        edit("t1", "/repo/src/a.ts", 3, 1),
        edit("t2", "/repo/src/a.ts", 2, 0),
        edit("t3", "/repo/src/b.ts"),
        read("t4", "/repo/src/a.ts"),
        read("t5", "/repo/src/c.ts"),
        read("t6", "/repo/src/d.ts"),
        { id: "a1", role: "assistant", text: "ok" },
      ]),
    );
    expect(result.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.brief).toContain(
      "## Files changed in this session\n- src/a.ts (+5 −1)\n- src/b.ts\n",
    );
    expect(result.brief).toContain(
      "## Files read in this session\n(most recent first)\n- src/d.ts\n- src/c.ts",
    );
  });

  it("carries the recap of the chat this one continued", () => {
    const { brief } = buildContinuationBrief(
      sessionWith([
        {
          id: "u1",
          role: "user",
          text: "keep going",
          secondOpinion: {
            from: "claude",
            to: "claude",
            kind: "handoff",
            brief: "## First request\nOriginal goal",
          },
        },
        { id: "a1", role: "assistant", text: "ok" },
      ]),
    );
    expect(brief.indexOf("## Earlier context")).toBe(0);
    expect(brief).toContain("Original goal");
  });

  it("skips internal orchestration turns", () => {
    const { brief } = buildContinuationBrief(
      sessionWith([
        { id: "u1", role: "user", text: "real" },
        { id: "a1", role: "assistant", text: "visible" },
        { id: "u2", role: "user", text: "managed", internal: true },
        { id: "a2", role: "assistant", text: "hidden", internal: true },
      ]),
    );
    expect(brief).not.toContain("managed");
    expect(brief).not.toContain("hidden");
    expect(brief).toContain("## Latest response\nvisible");
  });
});
