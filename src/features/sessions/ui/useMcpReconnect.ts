import { useCallback, useEffect, useRef, useState } from "react";
import {
  harnessMcpStatus,
  reconnectHarnessMcp,
} from "../../../integrations/harness/core/registry";
import type { LiveMcpServer } from "../../../integrations/harness/core/types";
import { recheckClaudeMcpHealth } from "../../settings/model/mcpSettingsCache";
import type { McpConnection } from "../../settings/model/mcp";
import {
  isConnectedMcpStatus,
  mcpReconnectError,
  liveMcpStatusText,
  type McpReconnect,
} from "../model/mcpPicker";
import type { HarnessId } from "../model/session";

/**
 * Claude MCP servers for the composer's picker: what the session's running
 * Claude reports, and reconnecting one. Without a running Claude, reconnect
 * runs Claude's health check again, since the next message starts a process
 * that connects every server anyway.
 */
export function useMcpReconnect({
  open,
  harness,
  sessionId,
  cwd,
  remote,
}: {
  open: boolean;
  harness: HarnessId;
  sessionId: string | undefined;
  cwd: string;
  remote: boolean;
}): {
  /** Null until the running Claude answers, or when there is none. */
  live: LiveMcpServer[] | null;
  /** The live status has been asked for and answered (or refused). */
  checked: boolean;
  reconnects: ReadonlyMap<string, McpReconnect>;
  reconnect?: (server: McpConnection) => void;
} {
  // Remote sessions run on their host, out of reach of this app's processes.
  const enabled = harness === "claude" && !remote;
  const [live, setLive] = useState<LiveMcpServer[] | null>(null);
  const [checked, setChecked] = useState(false);
  const [reconnects, setReconnects] = useState<Map<string, McpReconnect>>(
    () => new Map(),
  );
  const target = `${harness}\n${sessionId ?? ""}\n${cwd}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  const reconnectsRef = useRef(reconnects);
  reconnectsRef.current = reconnects;

  // A reconnect belongs to the session it was asked for.
  useEffect(() => {
    setReconnects(new Map());
    setLive(null);
  }, [target]);

  useEffect(() => {
    if (!open) return;
    setChecked(false);
    // Outcomes are news for the picker they were asked from.
    setReconnects(
      (current) =>
        new Map([...current].filter(([, entry]) => entry.state === "running")),
    );
    if (!enabled || !sessionId) {
      setLive(null);
      setChecked(true);
      return;
    }
    let current = true;
    harnessMcpStatus(harness, sessionId)
      .catch(() => null)
      .then((servers) => {
        if (!current) return;
        setLive(servers);
        setChecked(true);
      });
    return () => {
      current = false;
    };
  }, [open, enabled, harness, sessionId]);

  const settle = useCallback(
    (asked: string, name: string, entry: McpReconnect) => {
      if (targetRef.current !== asked) return;
      setReconnects((current) => new Map(current).set(name, entry));
    },
    [],
  );

  const reconnect = useCallback(
    (server: McpConnection) => {
      const name = server.name;
      if (reconnectsRef.current.get(name)?.state === "running") return;
      const asked = targetRef.current;
      settle(asked, name, { state: "running" });
      void (async () => {
        try {
          const servers = sessionId
            ? await reconnectHarnessMcp(harness, sessionId, name)
            : null;
          if (servers) {
            if (targetRef.current === asked) setLive(servers);
            const row = servers.find((entry) => entry.name === name);
            // "pending" means Claude is still connecting it after the reply.
            settle(
              asked,
              name,
              !row || row.status === "connected" || row.status === "pending"
                ? { state: "connected" }
                : {
                    state: "failed",
                    error:
                      row.error ??
                      mcpReconnectError(liveMcpStatusText(row.status)),
                  },
            );
            return;
          }
          // No running Claude, or it went away: check from scratch.
          if (targetRef.current === asked) setLive(null);
          const snapshot = await recheckClaudeMcpHealth(cwd);
          const row = snapshot.servers.find(
            (entry) => entry.provider === "claude" && entry.name === name,
          );
          settle(
            asked,
            name,
            isConnectedMcpStatus(row?.status)
              ? { state: "connected" }
              : {
                  state: "failed",
                  error: snapshot.claudeError || mcpReconnectError(row?.status),
                },
          );
        } catch (error) {
          settle(asked, name, {
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    [cwd, harness, sessionId, settle],
  );

  return {
    live,
    checked,
    reconnects,
    reconnect: enabled ? reconnect : undefined,
  };
}
