import type { RowSpec, TranscriptOp } from "./spec";

/** Ops that turn `before` into `after`. Rows are matched by id; a changed
 * version is an update. When the common rows changed order, it resets. */
export function diffRows(before: readonly RowSpec[], after: readonly RowSpec[]): TranscriptOp[] {
  if (!before.length) return after.length ? [{ op: "reset", rows: [...after] }] : [];
  // Streaming changes the tail: skip the shared prefix and suffix cheaply.
  const same = (a: RowSpec, b: RowSpec) => a === b || (a.id === b.id && a.v === b.v);
  let head = 0;
  while (head < before.length && head < after.length && same(before[head], after[head])) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    same(before[before.length - 1 - tail], after[after.length - 1 - tail])
  )
    tail++;
  if (head === before.length && head === after.length) return [];
  if (head > 0 || tail > 0) {
    const ops = diffMiddle(before.slice(head, before.length - tail), after.slice(head, after.length - tail));
    if (ops === null) return [{ op: "reset", rows: [...after] }];
    return ops.map((op) => {
      // Re-anchor inserts that start the middle region.
      if (op.op === "insert" && op.after === null && head > 0) return { ...op, after: after[head - 1].id };
      if (op.op === "append" && tail > 0) return { op: "insert", after: anchorBefore(op.rows[0], after), rows: op.rows };
      return op;
    });
  }
  return diffMiddle(before, after) ?? [{ op: "reset", rows: [...after] }];
}

function anchorBefore(row: RowSpec, after: readonly RowSpec[]): string | null {
  const index = after.findIndex((candidate) => candidate.id === row.id);
  return index > 0 ? after[index - 1].id : null;
}

function diffMiddle(before: readonly RowSpec[], after: readonly RowSpec[]): TranscriptOp[] | null {
  if (!before.length) return after.length ? [{ op: "append", rows: [...after] }] : [];
  const nextIds = new Set(after.map((row) => row.id));
  const previous = new Map(before.map((row) => [row.id, row]));
  const kept = before.filter((row) => nextIds.has(row.id)).map((row) => row.id);
  const order = after.filter((row) => previous.has(row.id)).map((row) => row.id);
  if (kept.length !== order.length || kept.some((id, i) => id !== order[i])) return null;
  const ops: TranscriptOp[] = [];
  const removed = before.filter((row) => !nextIds.has(row.id)).map((row) => row.id);
  if (removed.length) ops.push({ op: "remove", ids: removed });
  const updated = after.filter((row) => {
    const old = previous.get(row.id);
    return old && old.v !== row.v;
  });
  if (updated.length) ops.push({ op: "update", rows: updated });
  // Runs of new rows go after the row before them (or at the top).
  let i = 0;
  while (i < after.length) {
    if (previous.has(after[i].id)) {
      i++;
      continue;
    }
    const start = i;
    while (i < after.length && !previous.has(after[i].id)) i++;
    const rows = after.slice(start, i);
    if (start === 0) ops.push({ op: "insert", after: null, rows });
    else if (i === after.length) ops.push({ op: "append", rows });
    else ops.push({ op: "insert", after: after[start - 1].id, rows });
  }
  return ops;
}
