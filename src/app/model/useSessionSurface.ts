import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  providerAccountExists,
  selectedProviderAccountId,
  supportsProviderAccounts,
} from "../../features/providers/model/providerAccounts";
import {
  createWorktree,
  temporaryWorktreeBranchName,
} from "../../features/source-control/model/worktrees";
import {
  sessionDisplayTitle,
  type Session,
} from "../../features/sessions/model/session";
import {
  terminalRefusal,
  withChatSurface,
  withTerminalSurface,
} from "../../features/sessions/model/sessionSurface";
import {
  isSessionTerminalAlive,
  killSessionTerminal,
} from "../../features/terminal/model/sessionTerminal";
import {
  initialTerminalSync,
  syncTerminalSession,
} from "../../integrations/harness/core/terminalSyncRunner";

type Deps = {
  sessionsRef: MutableRefObject<Session[]>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  /** Cancels a running turn, then stops the chat child so nothing else drives the conversation. */
  stopChat: (sessionId: string) => Promise<void>;
};

/**
 * Moves a session between MonoCode's chat and the agent's own CLI in a
 * terminal. A provider conversation must never have both writing to it, so a
 * move stops the side it leaves before the other starts.
 */
export function useSessionSurface({ sessionsRef, setSessions, stopChat }: Deps) {
  // Two clicks on the same menu item must not run one move twice.
  const moving = useRef(new Set<string>());

  const find = useCallback(
    (sessionId: string) =>
      sessionsRef.current.find((session) => session.id === sessionId),
    [sessionsRef],
  );

  const commit = useCallback(
    (sessionId: string, update: (session: Session) => Session) => {
      const next = sessionsRef.current.map((session) =>
        session.id === sessionId ? update(session) : session,
      );
      sessionsRef.current = next;
      setSessions(next);
    },
    [sessionsRef, setSessions],
  );

  /** Claude's new conversation id, chosen by the terminal pane just before it spawns. */
  const bindProviderSession = useCallback(
    (sessionId: string, providerSessionId: string) => {
      const current = find(sessionId);
      if (!current || current.providerSessionId === providerSessionId) return;
      commit(sessionId, (session) => ({ ...session, providerSessionId }));
    },
    [commit, find],
  );

  const openInTerminal = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (moving.current.has(sessionId)) return false;
      const current = find(sessionId);
      if (!current) return false;
      const refusal = terminalRefusal(current);
      if (refusal) {
        void message(refusal, { title: "MonoCode", kind: "info" });
        return false;
      }
      moving.current.add(sessionId);
      try {
        if (current.busy) {
          const stop = await ask(
            `"${sessionDisplayTitle(current.title, current.harness)}" is still working. Stop it and open the session in the terminal?`,
            { title: "MonoCode", kind: "warning" },
          );
          if (!stop) return false;
        }
        await stopChat(sessionId);
        const stopped = find(sessionId);
        if (!stopped) return false;

        // A conversation that already exists stays on its account; a new one
        // takes the account selected for the project, as the first chat turn does.
        let providerAccountId = stopped.providerAccountId;
        if (
          !providerAccountId &&
          !stopped.providerSessionId &&
          supportsProviderAccounts(stopped.harness)
        ) {
          providerAccountId = selectedProviderAccountId(
            stopped.harness,
            stopped.cwd,
          );
        }
        if (
          providerAccountId &&
          supportsProviderAccounts(stopped.harness) &&
          !providerAccountExists(stopped.harness, providerAccountId)
        ) {
          void message(
            "This conversation uses a removed provider account. Switch accounts from the usage control to start a new conversation.",
            { title: "MonoCode", kind: "warning" },
          );
          return false;
        }

        // The CLI runs in the working copy, so a worktree chosen for the first
        // turn has to exist before it starts.
        let worktree: Partial<Session> = {};
        if (!stopped.worktreeCwd && stopped.workspaceMode === "worktree") {
          const tree = await createWorktree(
            stopped.cwd,
            temporaryWorktreeBranchName(),
            stopped.worktreeBase || "HEAD",
            false,
          );
          worktree = {
            worktreeCwd: tree.path,
            branch: tree.branch ?? undefined,
            workspaceMode: undefined,
            worktreeBase: undefined,
          };
        }

        // Everything the session has now stays as it is. What the CLI writes
        // from here on is read back after it.
        const sync = await initialTerminalSync({
          ...stopped,
          ...worktree,
          providerAccountId,
        });
        commit(sessionId, (session) =>
          withTerminalSurface(
            { ...session, ...worktree, providerAccountId },
            sync,
          ),
        );
        return true;
      } catch (error) {
        void message(
          `Could not open the session in the terminal.\n\n${String(error)}`,
          { title: "MonoCode", kind: "error" },
        );
        return false;
      } finally {
        moving.current.delete(sessionId);
      }
    },
    [commit, find, stopChat],
  );

  const openAsChat = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (moving.current.has(sessionId)) return false;
      const current = find(sessionId);
      if (current?.surface !== "terminal") return false;
      moving.current.add(sessionId);
      try {
        if (await isSessionTerminalAlive(sessionId)) {
          const confirmed = await ask(
            `Switching "${sessionDisplayTitle(current.title, current.harness)}" to chat stops the agent running in the terminal. Continue?`,
            { title: "MonoCode", kind: "warning" },
          );
          if (!confirmed) return false;
        }
        await killSessionTerminal(sessionId);
        // Read what the CLI wrote up to the moment it stopped, so the chat
        // starts from the whole conversation.
        const latest = find(sessionId);
        const synced = latest
          ? await syncTerminalSession(latest).catch(() => null)
          : null;
        commit(sessionId, (session) =>
          withChatSurface(
            synced && session === latest
              ? synced
              : session,
          ),
        );
        return true;
      } finally {
        moving.current.delete(sessionId);
      }
    },
    [commit, find],
  );

  return { bindProviderSession, openInTerminal, openAsChat };
}
