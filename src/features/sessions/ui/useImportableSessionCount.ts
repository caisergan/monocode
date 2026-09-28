import { useEffect, useState } from "react";
import { listClaudeSessions } from "../../../platform/tauri/claudeSessions";

/** Past this the hint just says "20+". */
const HINT_LIMIT = 20;

export type ImportableSessionCount = { count: number; more: boolean };

const NONE: ImportableSessionCount = { count: 0, more: false };

/**
 * Terminal sessions in `cwd` that MonoCode does not have yet. Re-checks when
 * `refreshKey` changes (an import adds a session) and when the window regains
 * focus, since new sessions appear while the user is in the terminal.
 */
export function useImportableSessionCount(
  cwd: string | undefined,
  refreshKey: unknown,
): ImportableSessionCount {
  const [result, setResult] = useState<ImportableSessionCount>(NONE);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    const onFocus = () => setFocusTick((tick) => tick + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!cwd || cwd === "~") {
      setResult(NONE);
      return;
    }
    let active = true;
    void listClaudeSessions({ cwd, limit: HINT_LIMIT })
      .then((listing) => {
        if (!active) return;
        const count = listing.sessions.filter(
          (session) => session.folder === "ok",
        ).length;
        setResult({ count, more: listing.hasMore });
      })
      .catch(() => {
        if (active) setResult(NONE);
      });
    return () => {
      active = false;
    };
  }, [cwd, refreshKey, focusTick]);

  return result;
}
