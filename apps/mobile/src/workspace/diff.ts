// The unified diff for the diff viewer (11 §11.20). `git.fileDiff` returns
// both sides of a file, not a patch, so the phone diffs the lines itself, as
// the desktop does (`buildUnifiedFile`): a Myers diff over line ids, trimmed
// to the shared prefix and suffix, then hunks with three lines of context.
// Like the desktop's line pass it has a budget; past it, the changed middle
// shows as one replacement.

export type DiffLineKind = "add" | "del" | "context";

export type DiffLine = { kind: DiffLineKind; text: string; oldNumber: number | null; newNumber: number | null };

export type DiffRow = { kind: "hunk"; key: string; text: string } | (DiffLine & { key: string });

export type FileDiffModel = { rows: DiffRow[]; additions: number; deletions: number };

/** Unchanged lines kept around each change (desktop UNIFIED_CONTEXT_DEFAULT). */
export const DIFF_CONTEXT = 3;
/** Edits the precise pass may find before the middle becomes one replacement. */
const MAX_EDITS = 1_000;
/** Loop steps, snakes included, before the same fallback. */
const MAX_STEPS = 4_000_000;

/** Lines of a file, without a trailing empty line or carriage returns. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;

/** Myers' O(ND) edit script for a[a0, a0+n) → b[b0, b0+m), or null past the
 * budget. Each op is [kind, index in a, index in b]. Only the diagonals a
 * step can reach are kept per step, so memory is O(D²). */
function myers(a: Int32Array, b: Int32Array, a0: number, n: number, b0: number, m: number): [number, number, number][] | null {
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  let steps = 0;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(d === 0 ? new Int32Array(0) : v.slice(offset - (d - 1), offset + d));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
        steps++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
      if (++steps > MAX_STEPS) return null;
    }
  }
  if (found < 0) return null;
  const ops: [number, number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d];
    const at = (k: number) => before[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push([EQUAL, a0 + --x, b0 + --y]);
    if (x === prevX) ops.push([INSERT, -1, b0 + prevY]);
    else ops.push([DELETE, a0 + prevX, -1]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) ops.push([EQUAL, a0 + --x, b0 + --y]);
  return ops.reverse();
}

/** Every line of both sides, in unified order. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const ids = new Map<string, number>();
  const encode = (lines: readonly string[]) =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) ids.set(line, (id = ids.size));
      return id;
    });
  const a = encode(before);
  const b = encode(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  const context = (i: number, j: number) => out.push({ kind: "context", text: after[j], oldNumber: i + 1, newNumber: j + 1 });
  const del = (i: number) => out.push({ kind: "del", text: before[i], oldNumber: i + 1, newNumber: null });
  const add = (j: number) => out.push({ kind: "add", text: after[j], oldNumber: null, newNumber: j + 1 });
  for (let i = 0; i < start; i++) context(i, i);
  const ops = myers(a, b, start, endA - start, start, endB - start);
  if (ops) {
    for (const [kind, i, j] of ops) {
      if (kind === EQUAL) context(i, j);
      else if (kind === DELETE) del(i);
      else add(j);
    }
  } else {
    for (let i = start; i < endA; i++) del(i);
    for (let j = start; j < endB; j++) add(j);
  }
  for (let i = endA; i < a.length; i++) context(i, endB + (i - endA));
  return out;
}

/** git's hunk range: "start" for one line, "start,count" otherwise; an empty
 * side names the line before it. */
function range(seen: number, count: number): string {
  if (count === 0) return `${seen},0`;
  return count === 1 ? `${seen + 1}` : `${seen + 1},${count}`;
}

/** Hunks of changed lines with `context` lines around them, each under an
 * "@@ -a,b +c,d @@" header. */
export function hunkRows(lines: readonly DiffLine[], context = DIFF_CONTEXT): DiffRow[] {
  const visible = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) visible[i] = 1;
  });
  const rows: DiffRow[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  let index = 0;
  while (index < lines.length) {
    if (!visible[index]) {
      if (lines[index].kind !== "add") oldSeen++;
      if (lines[index].kind !== "del") newSeen++;
      index++;
      continue;
    }
    const header = rows.length;
    rows.push({ kind: "hunk", key: `h:${index}`, text: "" });
    const oldStart = oldSeen;
    const newStart = newSeen;
    for (; index < lines.length && visible[index]; index++) {
      const line = lines[index];
      if (line.kind !== "add") oldSeen++;
      if (line.kind !== "del") newSeen++;
      rows.push({ ...line, key: `${line.kind}:${line.oldNumber ?? ""}:${line.newNumber ?? ""}` });
    }
    rows[header] = {
      kind: "hunk",
      key: `h:${oldStart}:${newStart}`,
      text: `@@ -${range(oldStart, oldSeen - oldStart)} +${range(newStart, newSeen - newStart)} @@`,
    };
  }
  return rows;
}

export function fileDiffModel(original: string, current: string, context = DIFF_CONTEXT): FileDiffModel {
  const lines = diffLines(splitLines(original), splitLines(current));
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === "add") additions++;
    else if (line.kind === "del") deletions++;
  }
  return { rows: hunkRows(lines, context), additions, deletions };
}
