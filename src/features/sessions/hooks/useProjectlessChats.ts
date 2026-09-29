import { useEffect, useRef, useState } from "react";
import {
  listProjectlessSessions,
  type SessionSummary,
} from "../data/sessionStore";
import {
  mergeProjectlessChats,
  type ProjectlessChat,
} from "../model/projectlessChats";
import type { Session } from "../model/session";

/**
 * Chats that belong to no project. The saved list reloads whenever one opens
 * or closes: a closed chat is only in the store, a new one is only open.
 */
export function useProjectlessChats(
  sessions: readonly Session[],
): ProjectlessChat[] {
  const [saved, setSaved] = useState<SessionSummary[]>([]);
  const openKey = sessions
    .filter((session) => session.cwd === "~")
    .map((session) => session.id)
    .sort()
    .join(",");

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
  }, [openKey]);

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
