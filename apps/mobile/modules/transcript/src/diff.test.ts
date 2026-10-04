import { describe, expect, it } from "vitest";
import { diffRows } from "./diff";
import type { RowSpec, TranscriptOp } from "./spec";

const row = (id: string, v = 1): RowSpec => ({ id, v, k: "markdown" });

/** Applies ops the way the native engine does. */
function apply(rows: RowSpec[], ops: TranscriptOp[]): RowSpec[] {
  let out = [...rows];
  for (const op of ops) {
    if (op.op === "reset") out = [...op.rows];
    else if (op.op === "append") out.push(...op.rows);
    else if (op.op === "insert") {
      const at = op.after === null ? 0 : out.findIndex((r) => r.id === op.after) + 1;
      out.splice(at, 0, ...op.rows);
    } else if (op.op === "update")
      out = out.map((r) => op.rows.find((u) => u.id === r.id) ?? r);
    else out = out.filter((r) => !op.ids.includes(r.id));
  }
  return out;
}

describe("diffRows", () => {
  const cases: [string, RowSpec[], RowSpec[]][] = [
    ["streaming tail update", [row("a"), row("b"), row("c")], [row("a"), row("b"), row("c", 2)]],
    ["append", [row("a"), row("b")], [row("a"), row("b"), row("c"), row("d")]],
    ["prepend older", [row("c"), row("d")], [row("a"), row("b"), row("c"), row("d")]],
    ["insert in the middle", [row("a"), row("d"), row("end")], [row("a"), row("b"), row("c"), row("d"), row("end")]],
    ["insert before a stable tail", [row("a"), row("end")], [row("a"), row("b"), row("end")]],
    ["remove", [row("a"), row("b"), row("c")], [row("a"), row("c")]],
    ["fold opens", [row("u"), row("fold"), row("ans"), row("end")], [row("u"), row("fold", 2), row("t1"), row("t2"), row("ans"), row("end")]],
    ["reorder resets", [row("a"), row("b")], [row("b"), row("a")]],
    ["unchanged", [row("a")], [row("a")]],
  ];
  it.each(cases)("%s", (_name, before, after) => {
    expect(apply(before, diffRows(before, after))).toEqual(after);
  });
  it("sends only the changed tail while streaming", () => {
    const before = Array.from({ length: 5000 }, (_, i) => row(`r${i}`));
    const after = [...before.slice(0, -1), row("r4999", 2)];
    expect(diffRows(before, after)).toEqual([{ op: "update", rows: [row("r4999", 2)] }]);
  });
});
