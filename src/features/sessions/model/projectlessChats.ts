import type { SessionSummary } from "../data/sessionStore";
import type { HarnessId, Session } from "./session";

/** A chat that belongs to no project, as the rail's Chats section lists it. */
export type ProjectlessChat = {
  id: string;
  title: string;
  harness: HarnessId;
  /** Last saved change; absent while a new chat waits for its first save. */
  updatedAt?: number;
  busy: boolean;
};

const HIDDEN_KEY = "monocode.railChatsHidden";

/**
 * Saved chats merged with the open ones, newest first. An open chat brings
 * its live title and busy state; one not saved yet leads the list.
 */
export function mergeProjectlessChats(
  saved: readonly SessionSummary[],
  open: readonly Session[],
): ProjectlessChat[] {
  const live = new Map<string, Session>();
  for (const session of open) {
    if (
      session.cwd === "~" &&
      !session.inboxAsk &&
      !session.orchestrationLeadId &&
      session.blocks.some((block) => block.role === "user")
    ) {
      live.set(session.id, session);
    }
  }
  const chats: ProjectlessChat[] = [];
  const listed = new Set<string>();
  for (const summary of saved) {
    if (summary.archived || summary.draft) continue;
    const session = live.get(summary.id);
    listed.add(summary.id);
    chats.push({
      id: summary.id,
      title: session?.title || summary.title,
      harness: session?.harness ?? summary.harness,
      updatedAt: summary.updatedAt,
      busy: !!session?.busy,
    });
  }
  const unsaved: ProjectlessChat[] = [];
  for (const session of live.values()) {
    if (listed.has(session.id)) continue;
    unsaved.push({
      id: session.id,
      title: session.title,
      harness: session.harness,
      busy: !!session.busy,
    });
  }
  return [...unsaved, ...chats];
}

export function loadChatsHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveChatsHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, "1");
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Storage can be unavailable; the section just opens expanded next time.
  }
}
