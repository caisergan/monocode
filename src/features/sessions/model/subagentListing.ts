/**
 * Sessions whose delegated runs the sidebar lists under their card. The
 * composer's dock stands aside for these, so each run shows in one place; it
 * covers only a session the sidebar can't, as when the sidebar is closed, on
 * another tab, or the card is folded away or filtered out.
 */
const listed = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** List the session's runs until the returned release is called. */
export function listSubagents(sessionId: string): () => void {
  const count = listed.get(sessionId);
  listed.set(sessionId, (count ?? 0) + 1);
  if (count === undefined) emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (listed.get(sessionId) ?? 1) - 1;
    listed.set(sessionId, left);
    if (left > 0) return;
    // A row mounted again in the same commit (StrictMode, a row moving into a
    // folder) takes the session back first, so the dock never sees it go.
    queueMicrotask(() => {
      if (listed.get(sessionId) !== 0) return;
      listed.delete(sessionId);
      emit();
    });
  };
}

export function subagentsListed(sessionId: string): boolean {
  return listed.has(sessionId);
}

export function subscribeSubagentListing(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
