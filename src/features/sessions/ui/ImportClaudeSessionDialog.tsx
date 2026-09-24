import { useEffect, useState } from "react";
import { Modal } from "../../../shared/ui/Modal";
import { prettyCwd } from "../../../shared/lib/paths";
import { formatRelativeTime } from "../../inbox/model/githubTasks";
import {
  listClaudeSessions,
  type ClaudeSessionSummary,
} from "../../../platform/tauri/claudeSessions";
import {
  claudeSessionsInMonoCode,
  importClaudeSession,
} from "../model/claudeSessionImport";

type Props = {
  cwd: string;
  onClose: () => void;
  /** Called with the MonoCode session to open once the import is saved. */
  onImported: (sessionId: string) => void;
};

type Listing = {
  sessions: ClaudeSessionSummary[];
  inMonoCode: Map<string, string>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lists Claude Code conversations started outside MonoCode for a project and
 * imports the chosen one. The imported chat resumes the same Claude session.
 */
export function ImportClaudeSessionDialog({ cwd, onClose, onImported }: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([listClaudeSessions(cwd), claudeSessionsInMonoCode(cwd)])
      .then(([sessions, inMonoCode]) => {
        if (active) setListing({ sessions, inMonoCode });
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, [cwd]);

  const pick = (session: ClaudeSessionSummary) => {
    if (importing) return;
    setImporting(session.id);
    setError("");
    void importClaudeSession(cwd, session.id)
      .then((result) => onImported(result.sessionId))
      .catch((reason: unknown) => {
        setError(errorText(reason));
        setImporting(null);
      });
  };

  const now = Date.now();

  return (
    <Modal
      title="Continue a Claude Code session"
      description={prettyCwd(cwd)}
      onClose={onClose}
      fitViewport
    >
      <div className="flex flex-col gap-2 p-4 pt-3 text-[12px]">
        <p className="text-content/55">
          Conversations started with the <code>claude</code> CLI in this
          folder. The imported chat picks up where it left off.
        </p>
        {error ? (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        ) : null}
        {!listing && !error ? (
          <p className="py-6 text-center text-content/45">Looking for sessions…</p>
        ) : null}
        {listing && listing.sessions.length === 0 ? (
          <p className="py-6 text-center text-content/45">
            No Claude Code sessions found for this folder.
          </p>
        ) : null}
        {listing && listing.sessions.length > 0 ? (
          <ul className="flex flex-col gap-1" aria-label="Claude Code sessions">
            {listing.sessions.map((session) => {
              const inMonoCode = listing.inMonoCode.has(session.id);
              const title =
                session.title || session.firstPrompt || "Untitled session";
              const busy = importing === session.id;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    disabled={importing != null}
                    onClick={() => pick(session)}
                    className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-content/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-content">
                        {title}
                      </span>
                      {inMonoCode ? (
                        <span className="shrink-0 rounded bg-content/8 px-1.5 py-0.5 text-[10px] text-content/55">
                          In MonoCode
                        </span>
                      ) : null}
                      <span className="shrink-0 text-[11px] text-content/40">
                        {busy
                          ? "Importing…"
                          : formatRelativeTime(
                              new Date(session.updatedAt).toISOString(),
                              now,
                            )}
                      </span>
                    </span>
                    <span className="truncate text-[11px] text-content/45">
                      {[
                        session.title && session.firstPrompt
                          ? session.firstPrompt
                          : null,
                        `${session.promptCount} ${session.promptCount === 1 ? "prompt" : "prompts"}`,
                        session.gitBranch,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}
