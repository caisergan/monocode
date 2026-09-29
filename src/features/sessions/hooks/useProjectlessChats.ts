import { useEffect, useRef, useState } from "react";
import {
  listProjectlessSessions,
  onProjectlessSessionsChange,
  type SessionSummary,
} from "../data/sessionStore";
import {
  mergeProjectlessChats,
  type ProjectlessChat,
} from "../model/projectlessChats";
import type { Session } from "../model/session";

/** Saves arrive in bursts while a chat streams; one reload covers a burst. */
const RELOAD_DEBOUNCE_MS = 300;

/**
 * Chats that belong to no project. The saved list reloads whenever one opens
 * or closes (a closed chat is only in the store, a new one is only open) and
 * after a write changes one: a save moves it up, a rename, archive or delete
 * can come from its row while it is closed.
 */
export function useProjectlessChats(
  sessions: readonly Session[],
): ProjectlessChat[] {
  const [saved, setSaved] = useState<SessionSummary[]>([]);
  const [changes, setChanges] = useState(0);
  const openKey = sessions
    .filter((session) => session.cwd === "~")
    .map((session) => session.id)
    .sort()
    .join(",");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onProjectlessSessionsChange(() => {
      clearTimeout(timer);
      timer = setTimeout(
        () => setChanges((count) => count + 1),
        RELOAD_DEBOUNCE_MS,
      );
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void listProjectlessSessions()
      .then((rows) => {
        if (active) setSaved(rows);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [openKey, changes]);

  // Sessions change on every streamed token; hand the rail the same array
  // until a row it shows actually changes.
  const merged = mergeProjectlessChats(saved, sessions);
  const stable = useRef(merged);
  if (!sameChats(stable.current, merged)) stable.current = merged;
  return stable.current;
}

function sameChats(
  left: readonly ProjectlessChat[],
  right: readonly ProjectlessChat[],
): boolean {
  return (
    left.length === right.length &&
    left.every((chat, index) => {
      const other = right[index];
      return (
        chat.id === other.id &&
        chat.title === other.title &&
        chat.harness === other.harness &&
        chat.updatedAt === other.updatedAt &&
        chat.busy === other.busy
      );
    })
  );
}
