import { useEffect, useState } from "react";
import { listAgentSessions } from "../../../platform/tauri/agentSessions";
import { listRemoteAgentSessions } from "../../connections/model/remoteAgentSessions";
import { isRemoteProjectPath } from "../../projects/model/recents";

/** Past this the hint just says "20+". */
const HINT_LIMIT = 20;

export type ImportableSessionCount = { count: number; more: boolean };

const NONE: ImportableSessionCount = { count: 0, more: false };

/**
 * Terminal sessions in `cwd` that MonoCode does not have yet, on the
 * project's machine for a remote project. Re-checks when
 * `refreshKey` changes (an import adds a session) and when the window regains
 * focus, since new sessions appear while the user is in the terminal.
 */
export function useImportableSessionCount(
  cwd: string | undefined,
  refreshKey: unknown,
): ImportableSessionCount {
  // Kept with the folder it counts, so switching projects never shows the
  // last project's count while the new one loads.
  const [result, setResult] = useState<{
    cwd: string;
    value: ImportableSessionCount;
  } | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    const onFocus = () => setFocusTick((tick) => tick + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!cwd || cwd === "~") return;
    let active = true;
    void (
      isRemoteProjectPath(cwd)
        ? listRemoteAgentSessions(cwd, { limit: HINT_LIMIT })
        : listAgentSessions({ cwd, limit: HINT_LIMIT })
    )
      .then((listing) => {
        if (!active) return;
        const count = listing.sessions.filter(
          (session) => session.folder === "ok",
        ).length;
        setResult({ cwd, value: { count, more: listing.hasMore } });
      })
      .catch(() => {
        if (active) setResult({ cwd, value: NONE });
      });
    return () => {
      active = false;
    };
  }, [cwd, refreshKey, focusTick]);

  return result && result.cwd === cwd ? result.value : NONE;
}
