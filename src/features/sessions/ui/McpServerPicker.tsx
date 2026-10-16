import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  LoaderCircle,
  RefreshCw,
  Search,
  Settings,
} from "../../../shared/ui/icons";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { HarnessIcon } from "./HarnessIcon";
import {
  MCP_PROVIDER_LABELS,
  type McpConnection,
} from "../../settings/model/mcp";
import {
  keepMcpPickerOrder,
  mcpPickerKey,
  mcpPickerServers,
  type McpPickerServer,
  type McpReconnect,
} from "../model/mcpPicker";
import type { HarnessId } from "../model/session";

const STATUS_TONE = {
  muted: "text-content/45",
  warning: "text-amber-400",
  error: "text-red-400",
  success: "text-diff-add",
} as const;

function rowStatus(
  server: McpPickerServer,
  reconnect: McpReconnect | undefined,
): { text: string; tone: keyof typeof STATUS_TONE } {
  if (reconnect?.state === "running") {
    return { text: "Reconnecting…", tone: "muted" };
  }
  if (reconnect?.state === "failed") {
    return { text: "Reconnect failed", tone: "error" };
  }
  if (server.availability === "authentication") {
    return { text: "Needs authentication", tone: "warning" };
  }
  if (server.availability === "unavailable") {
    return { text: server.detail, tone: "muted" };
  }
  return reconnect?.state === "connected"
    ? { text: "Connected", tone: "success" }
    : { text: "Available", tone: "muted" };
}

const NO_RECONNECTS: ReadonlyMap<string, McpReconnect> = new Map();

export function McpServerPicker({
  connections,
  harness,
  claudeStatus,
  reconnects = NO_RECONNECTS,
  loading,
  error,
  onPick,
  onReconnect,
  onManage,
  onDismiss,
}: {
  connections: McpConnection[];
  harness: HarnessId;
  claudeStatus: ReadonlyMap<string, string>;
  /** Reconnects asked for in this picker, by Claude server name. */
  reconnects?: ReadonlyMap<string, McpReconnect>;
  loading: boolean;
  error: string;
  onPick: (server: McpConnection) => void;
  /** Absent when this session cannot reconnect a server. */
  onReconnect?: (server: McpConnection) => void;
  onManage: () => void;
  onDismiss: (reason: "escape" | "outside") => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listboxId = `mcp-server-picker-${useId()}`;
  const search = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const order = useRef<{ query: string; keys: string[] }>({
    query,
    keys: [],
  });
  const [reconnected, setReconnected] = useState(false);
  const servers = useMemo(() => {
    const ranked = mcpPickerServers(connections, harness, claudeStatus, query);
    const kept =
      reconnected && order.current.query === query
        ? keepMcpPickerOrder(ranked, order.current.keys)
        : ranked;
    order.current = { query, keys: kept.map(mcpPickerKey) };
    return kept;
  }, [connections, harness, claudeStatus, query, reconnected]);
  const selectable = servers.flatMap((server, index) =>
    server.availability === "available" ? [index] : [],
  );

  useEffect(() => {
    search.current?.focus();
  }, []);
  useEffect(() => {
    setActive(selectable[0] ?? 0);
  }, [query, connections, harness, claudeStatus]);
  useEffect(() => {
    activeOption.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !picker.current?.contains(event.target)
      ) {
        onDismiss("outside");
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [onDismiss]);

  return (
    <div
      ref={picker}
      data-mcp-picker
      role="dialog"
      aria-label="Choose an MCP server"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDismiss("escape");
        }
      }}
      className="overflow-hidden rounded-lg border border-content/10 bg-content/5 shadow-xl backdrop-blur-xl"
    >
      <div className="flex items-center gap-2 border-b border-content/10 px-3 py-2">
        <Search className="size-3.5 shrink-0 text-content/45" />
        <input
          ref={search}
          role="combobox"
          aria-controls={listboxId}
          aria-expanded="true"
          aria-activedescendant={
            servers[active]?.availability === "available"
              ? `${listboxId}-option-${active}`
              : undefined
          }
          aria-label="Search MCP servers"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (selectable.length === 0) return;
              const index = selectable.indexOf(active);
              const offset = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                selectable[
                  (index + offset + selectable.length) % selectable.length
                ],
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const server = servers[active];
              if (server?.availability === "available") onPick(server);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/40"
          placeholder="Search MCP servers…"
        />
        <button
          type="button"
          aria-label="Close MCP picker"
          title="Back to the conversation (Esc)"
          onClick={() => onDismiss("escape")}
          className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 transition-colors hover:bg-content/8 hover:text-content focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <ChevronDown className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <div
        ref={lockOverscroll}
        id={listboxId}
        role="listbox"
        aria-label="MCP servers"
        className="max-h-[min(184px,45vh)] overflow-y-auto overscroll-none p-1"
      >
        {loading ? (
          <p className="px-2 py-2 text-[12px] text-content/50">
            Checking MCP servers…
          </p>
        ) : error ? (
          <p role="alert" className="px-2 py-2 text-[12px] text-red-400">
            {error}
          </p>
        ) : servers.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-content/50">
            {query ? "No matching MCP servers" : "No MCP servers found"}
          </p>
        ) : (
          servers.map((server, index) => {
            const available = server.availability === "available";
            const reconnect =
              server.provider === "claude"
                ? reconnects.get(server.name)
                : undefined;
            const reconnecting = reconnect?.state === "running";
            const status = rowStatus(server, reconnect);
            const canReconnect =
              onReconnect != null && (server.reconnectable || reconnecting);
            return (
              <div
                key={mcpPickerKey(server)}
                className={`flex items-center gap-1 rounded-md ${available && active === index ? "bg-selection" : available ? "hover:bg-content/5" : ""}`}
              >
                <button
                  id={`${listboxId}-option-${index}`}
                  ref={available && active === index ? activeOption : undefined}
                  type="button"
                  role="option"
                  aria-selected={available && active === index}
                  aria-disabled={!available}
                  disabled={!available}
                  onFocus={() => {
                    if (available) setActive(index);
                  }}
                  onMouseEnter={() => {
                    if (available) setActive(index);
                  }}
                  onClick={() => onPick(server)}
                  className={`flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${available ? "text-content" : "cursor-default text-content/40"}`}
                >
                  <HarnessIcon
                    harness={
                      server.provider === "claude_desktop"
                        ? "claude"
                        : server.provider
                    }
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      {server.name}
                    </span>
                    {reconnect?.state === "failed" ? (
                      <span
                        title={reconnect.error}
                        className="block truncate text-[11px] text-red-400/80"
                      >
                        {reconnect.error}
                      </span>
                    ) : (
                      <span className="block truncate text-[11px] text-content/45">
                        {MCP_PROVIDER_LABELS[server.provider]} ·{" "}
                        {server.scopeLabel ?? server.scope}
                      </span>
                    )}
                  </span>
                  <span
                    className={`max-w-[40%] shrink-0 truncate text-[11px] ${STATUS_TONE[status.tone]}`}
                  >
                    {status.text}
                  </span>
                </button>
                {canReconnect && (
                  <button
                    type="button"
                    aria-label={`Reconnect ${server.name}`}
                    title={
                      reconnecting
                        ? "Reconnecting…"
                        : `Ask Claude to connect ${server.name} again`
                    }
                    disabled={reconnecting}
                    onClick={() => {
                      setReconnected(true);
                      onReconnect(server);
                    }}
                    className="mr-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-content/10 px-2 text-[11px] text-content/70 transition-colors hover:bg-content/8 hover:text-content disabled:cursor-default disabled:text-content/45 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  >
                    {reconnecting ? (
                      <LoaderCircle
                        className="size-3 animate-spin"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    ) : (
                      <RefreshCw
                        className="size-3"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    )}
                    {reconnect?.state === "failed" ? "Retry" : "Reconnect"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
      <button
        type="button"
        onClick={onManage}
        className="flex w-full items-center gap-2 border-t border-content/10 px-3 py-2 text-left text-[12px] text-content/65 hover:bg-content/5 hover:text-content"
      >
        <Settings className="size-3.5" />
        Manage MCP Servers…
      </button>
    </div>
  );
}
