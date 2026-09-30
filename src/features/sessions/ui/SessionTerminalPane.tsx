import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { killPty } from "../../../platform/tauri/pty";
import {
  sessionPtyId,
  sessionTerminalLaunch,
} from "../../terminal/model/sessionTerminal";
import { TerminalView } from "../../terminal/ui/TerminalView";
import {
  sessionDisplayTitle,
  sessionWorkCwd,
  type Session,
} from "../model/session";
import { SessionPaneHeader } from "./SessionPaneHeader";

type Props = {
  session: Session;
  visible: boolean;
  focused: boolean;
  inSplit: boolean;
  onFocus: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onBindProviderSession?: (sessionId: string, providerSessionId: string) => void;
  onOpenSessionAsChat?: (sessionId: string) => void;
  onTerminalExit?: (sessionId: string) => void;
  onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
};

/** A session running in the agent's own CLI. */
export function SessionTerminalPane({
  session,
  visible,
  focused,
  inSplit,
  onFocus,
  onClose,
  onBindProviderSession,
  onOpenSessionAsChat,
  onTerminalExit,
  onPaneDragStart,
}: Props) {
  return (
    <div
      data-session-drop={session.id}
      className="relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onMouseDown={() => onFocus(session.id)}
    >
      {inSplit ? (
        <SessionPaneHeader
          sessionId={session.id}
          title={sessionDisplayTitle(session.title, session.harness)}
          focused={focused}
          onClose={onClose}
          onPaneDragStart={onPaneDragStart}
        />
      ) : null}
      <SessionTerminal
        session={session}
        visible={visible}
        focused={focused}
        onBindProviderSession={onBindProviderSession}
        onOpenSessionAsChat={onOpenSessionAsChat}
        onTerminalExit={onTerminalExit}
      />
    </div>
  );
}

/**
 * The terminal itself. Its PTY belongs to the session, so leaving the pane
 * (another workspace tab) does not stop the agent, and coming back finds the
 * same process. Nothing starts until the pane is first on screen, so restoring
 * a workspace does not launch every agent at once.
 */
function SessionTerminal({
  session,
  visible,
  focused,
  onBindProviderSession,
  onOpenSessionAsChat,
  onTerminalExit,
}: Pick<
  Props,
  | "session"
  | "visible"
  | "focused"
  | "onBindProviderSession"
  | "onOpenSessionAsChat"
  | "onTerminalExit"
>) {
  const [shown, setShown] = useState(visible);
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (visible) setShown(true);
  }, [visible]);

  // The launch is worked out when a PTY has to start, from the session as it
  // is then, not as it was when this pane mounted.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const bindRef = useRef(onBindProviderSession);
  bindRef.current = onBindProviderSession;
  const launch = useCallback(
    () =>
      sessionTerminalLaunch(sessionRef.current, (id, providerSessionId) =>
        bindRef.current?.(id, providerSessionId),
      ),
    [],
  );

  const restart = useCallback(() => {
    // The ended PTY is remembered until it is killed or spawned again.
    void killPty(sessionPtyId(sessionRef.current.id)).then(() => {
      setExit(null);
      setEpoch((value) => value + 1);
    });
  }, []);

  if (!shown) return <div className="min-h-0 flex-1" />;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 min-w-0 flex-1">
        <TerminalView
          key={epoch}
          id={sessionPtyId(session.id)}
          cwd={sessionWorkCwd(session)}
          active={visible && focused}
          persistent
          launch={launch}
          onExit={(code) => {
            setExit({ code });
            onTerminalExit?.(session.id);
          }}
        />
      </div>
      {session.terminalSync?.error ? (
        <div
          role="status"
          className="shrink-0 border-t border-stroke px-3 py-2 text-xs text-content/70"
        >
          History stopped updating: {session.terminalSync.error}
        </div>
      ) : null}
      {exit ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-t border-stroke px-3 py-2 text-xs text-content/70"
        >
          <span className="min-w-0 flex-1 truncate">
            {session.harness === "codex" ? "Codex" : "Claude Code"} exited
            {exit.code == null ? "" : ` (${exit.code})`}.
          </span>
          <button
            type="button"
            className="rounded px-2 py-1 text-content hover:bg-content/10"
            onClick={restart}
          >
            Restart
          </button>
          {onOpenSessionAsChat ? (
            <button
              type="button"
              className="rounded px-2 py-1 text-content hover:bg-content/10"
              onClick={() => onOpenSessionAsChat(session.id)}
            >
              Open as chat
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
