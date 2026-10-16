/**
 * Which delegated run's sheet is open, per session. The pane showing the
 * session draws the sheet, while the sidebar's tree opens runs and marks the
 * open one; a row can open a run before its session's pane has mounted, so
 * the choice lives here rather than in the pane.
 */
const open = new Map<string, string>();
/** Panes showing each session. A session no pane shows has no open sheet. */
const holders = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openSubagentSheet(sessionId: string, runId: string): void {
  if (open.get(sessionId) === runId) return;
  open.set(sessionId, runId);
  emit();
}

export function closeSubagentSheet(sessionId: string): void {
  if (!open.delete(sessionId)) return;
  emit();
}

export function toggleSubagentSheet(sessionId: string, runId: string): void {
  if (open.get(sessionId) === runId) closeSubagentSheet(sessionId);
  else openSubagentSheet(sessionId, runId);
}

export function peekSubagentSheet(sessionId: string): string | null {
  return open.get(sessionId) ?? null;
}

/** The open run, only while a pane is showing its session. */
export function shownSubagentSheet(sessionId: string): string | null {
  return holders.has(sessionId) ? peekSubagentSheet(sessionId) : null;
}

/**
 * A pane holds its session's sheet while it shows the session. When the last
 * one lets go the sheet closes, as it did when it was the pane's own state.
 * Letting go waits a microtask, so a pane mounted again in the same commit
 * (StrictMode, a pane moving in the layout) keeps the sheet open.
 */
export function holdSubagentSheet(sessionId: string): () => void {
  const count = holders.get(sessionId);
  holders.set(sessionId, (count ?? 0) + 1);
  if (count === undefined) emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holders.get(sessionId) ?? 1) - 1;
    holders.set(sessionId, left);
    if (left > 0) return;
    queueMicrotask(() => {
      if (holders.get(sessionId) !== 0) return;
      holders.delete(sessionId);
      open.delete(sessionId);
      emit();
    });
  };
}

export function subscribeSubagentSheets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
