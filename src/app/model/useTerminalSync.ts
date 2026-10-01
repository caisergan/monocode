import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  isTerminalSession,
  type Session,
} from "../../features/sessions/model/session";
import { syncTerminalSession } from "../../integrations/harness/core/terminalSyncRunner";

/** How often a terminal session's transcript is checked for new records. */
export const TERMINAL_SYNC_INTERVAL_MS = 5000;

/**
 * A long transcript is read whole and saved whole each time it grows. The
 * periodic check waits this many times as long as the last sync took, so a huge
 * session being written to costs a fraction of the app's time, not all of it.
 */
export const TERMINAL_SYNC_BACKOFF = 4;

type Deps = {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
};

/**
 * Reads what the agent's CLI writes into MonoCode's own history while a
 * session runs in the terminal: every few seconds, when a terminal session is
 * loaded (a restart, or opening it from history), and when its CLI exits.
 * Checking is a file size, so an idle session costs nothing; the transcript is
 * only read when it grew.
 */
export function useTerminalSync({ sessions, sessionsRef, setSessions }: Deps) {
  const inFlight = useRef(new Set<string>());
  /** When each session's last sync ended, and how long it took. */
  const lastSync = useRef(new Map<string, { endedAt: number; tookMs: number }>());

  const syncNow = useCallback(
    async (sessionId: string) => {
      if (inFlight.current.has(sessionId)) return;
      const current = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (!current || !isTerminalSession(current)) return;
      inFlight.current.add(sessionId);
      const startedAt = Date.now();
      try {
        const synced = await syncTerminalSession(current);
        if (!synced) return;
        const next = sessionsRef.current.map((session) => {
          if (session.id !== sessionId || !isTerminalSession(session)) {
            return session;
          }
          // Something else changed the session while the transcript was being
          // read; keep that and take only what the transcript decides.
          if (session === current) return synced;
          return {
            ...session,
            providerSessionId:
              session.providerSessionId ?? synced.providerSessionId,
            blocks: synced.blocks,
            terminalSync: synced.terminalSync,
            ...(synced.context ? { context: synced.context } : {}),
            title: session.title === current.title ? synced.title : session.title,
          };
        });
        sessionsRef.current = next;
        setSessions(next);
      } finally {
        inFlight.current.delete(sessionId);
        const endedAt = Date.now();
        lastSync.current.set(sessionId, { endedAt, tookMs: endedAt - startedAt });
      }
    },
    [sessionsRef, setSessions],
  );

  const syncAll = useCallback(() => {
    const now = Date.now();
    for (const session of sessionsRef.current) {
      if (!isTerminalSession(session)) continue;
      const last = lastSync.current.get(session.id);
      if (last && now - last.endedAt < last.tookMs * TERMINAL_SYNC_BACKOFF) continue;
      void syncNow(session.id);
    }
  }, [sessionsRef, syncNow]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) syncAll();
    }, TERMINAL_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [syncAll]);

  // A terminal session that has just been loaded catches up at once, instead of
  // showing what was saved until the next check.
  const known = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(
      sessions.filter(isTerminalSession).map((session) => session.id),
    );
    for (const id of now) {
      if (!known.current.has(id)) void syncNow(id);
    }
    known.current = now;
  }, [sessions, syncNow]);

  return { syncNow };
}
