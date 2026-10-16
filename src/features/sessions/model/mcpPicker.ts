import type { HarnessId } from "./session";
import type { LiveMcpServer } from "../../../integrations/harness/core/types";
import {
  MCP_PROVIDER_LABELS,
  type McpConnection,
} from "../../settings/model/mcp";

export type McpPickerServer = McpConnection & {
  availability: "available" | "authentication" | "unavailable";
  detail: string;
  /** Claude can be asked to connect this server again. */
  reconnectable: boolean;
};

/** A reconnect MonoCode asked the running Claude for, by server name. */
export type McpReconnect =
  | { state: "running" }
  | { state: "connected" }
  | { state: "failed"; error: string };

/** Status of a configured server the running Claude does not have. */
const NOT_LOADED = "Not loaded";

/** Status words for what a running Claude reports through `mcp_status`. */
export function liveMcpStatusText(status: string): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "failed":
      return "Failed to connect";
    case "needs-auth":
      return "Needs authentication";
    case "pending":
      return "Connecting";
    case "disabled":
      return "Disabled";
    default:
      return status;
  }
}

export type McpTag = { server: McpConnection; token: string };

export function newMcpTag(server: McpConnection, existing: McpTag[]): McpTag {
  const used = new Set(existing.map((tag) => tag.token));
  const base = `@mcp/${server.name}`;
  const candidates = [
    base,
    `@mcp/${server.provider}/${server.name}`,
    `@mcp/${server.provider}/${server.scope}/${server.name}`,
  ];
  let token = candidates.find((candidate) => !used.has(candidate));
  if (!token) {
    let suffix = 2;
    while (used.has(`${candidates[2]}-${suffix}`)) suffix += 1;
    token = `${candidates[2]}-${suffix}`;
  }
  return { server, token };
}

export function mcpTagParts(
  text: string,
  tags: McpTag[],
): { text: string; tag?: McpTag }[] {
  if (!text || tags.length === 0) return text ? [{ text }] : [];
  const parts: { text: string; tag?: McpTag }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let hit: { start: number; tag: McpTag } | undefined;
    for (const tag of tags) {
      let start = text.indexOf(tag.token, cursor);
      while (start >= 0) {
        const end = start + tag.token.length;
        const before = start === 0 || /[\s([{]/.test(text[start - 1]);
        const after = end === text.length || /[\s)\]}.!?;,]/.test(text[end]);
        if (before && after) break;
        start = text.indexOf(tag.token, start + 1);
      }
      if (
        start >= 0 &&
        (!hit ||
          start < hit.start ||
          (start === hit.start && tag.token.length > hit.tag.token.length))
      ) {
        hit = { start, tag };
      }
    }
    if (!hit) break;
    if (hit.start > cursor) parts.push({ text: text.slice(cursor, hit.start) });
    parts.push({ text: hit.tag.token, tag: hit.tag });
    cursor = hit.start + hit.tag.token.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

export function taggedMcpServers(
  text: string,
  tags: McpTag[],
): McpConnection[] {
  const present = new Set(
    mcpTagParts(text, tags).flatMap((part) =>
      part.tag ? [part.tag.token] : [],
    ),
  );
  return tags.filter((tag) => present.has(tag.token)).map((tag) => tag.server);
}

export function mcpPickerServers(
  connections: McpConnection[],
  harness: HarnessId,
  claudeStatus: ReadonlyMap<string, string>,
  query: string,
): McpPickerServer[] {
  const search = query.trim().toLowerCase();
  const priority = { available: 0, authentication: 1, unavailable: 2 };
  return connections
    .filter((server) =>
      `${server.name} ${MCP_PROVIDER_LABELS[server.provider]} ${server.scopeLabel ?? server.scope}`
        .toLowerCase()
        .includes(search),
    )
    .map((server) => {
      const status =
        server.provider === "claude"
          ? claudeStatus.get(server.name)
          : undefined;
      const matches = server.provider === harness;
      const disabled =
        server.enabled === false || (matches && status === "Disabled");
      const notLoaded = matches && status === NOT_LOADED;
      const authentication =
        matches &&
        status != null &&
        /auth|sign.?in|log.?in|unauthorized/i.test(status);
      const failed =
        matches &&
        status != null &&
        /failed|error|offline|unreachable|disconnected/i.test(status);
      return {
        ...server,
        availability:
          !matches || disabled || notLoaded || failed
            ? ("unavailable" as const)
            : authentication
              ? ("authentication" as const)
              : ("available" as const),
        detail: !matches
          ? "Different provider"
          : disabled
            ? "Disabled in provider configuration"
            : notLoaded
              ? "Loads when the session restarts"
              : failed
                ? "Failed to connect"
                : "Configured for this provider",
        reconnectable:
          matches &&
          server.provider === "claude" &&
          !disabled &&
          (failed || authentication),
      };
    })
    .sort(
      (a, b) =>
        priority[a.availability] - priority[b.availability] ||
        // A server Claude can reconnect comes before another provider's.
        Number(b.reconnectable) - Number(a.reconnectable) ||
        a.name.localeCompare(b.name) ||
        a.provider.localeCompare(b.provider),
    );
}

/**
 * The picker's rows and Claude statuses once the running Claude has said
 * which servers it has. Servers no local config file holds, such as claude.ai
 * connectors and plugin servers, get rows of their own.
 */
export function withLiveMcpServers(
  connections: McpConnection[],
  live: LiveMcpServer[],
): { connections: McpConnection[]; status: Map<string, string> } {
  const status = new Map(
    live.map((server) => [server.name, liveMcpStatusText(server.status)]),
  );
  const configured = connections.filter(
    // Rows a health check added for servers it could not place.
    (server) =>
      server.provider !== "claude" ||
      server.configPath !== "" ||
      !status.has(server.name),
  );
  const known = new Set(
    configured
      .filter((server) => server.provider === "claude")
      .map((server) => server.name),
  );
  // Claude reads its servers at launch; one added since is not loaded.
  for (const server of configured) {
    if (server.provider === "claude" && !status.has(server.name)) {
      status.set(server.name, NOT_LOADED);
    }
  }
  const extra = live
    .filter((server) => !known.has(server.name))
    .map((server): McpConnection => ({
      provider: "claude",
      name: server.name,
      scope:
        server.scope === "project" || server.scope === "local"
          ? server.scope
          : "user",
      scopeLabel:
        server.scope === "claudeai" ? "claude.ai" : (server.scope ?? "user"),
      configPath: "",
      transport: "",
    }));
  return { connections: [...configured, ...extra], status };
}

/** Why a reconnect left a server unusable, from its Claude status text. */
export function mcpReconnectError(status: string | undefined): string {
  if (!status) return "Claude Code did not list this server";
  if (/auth|sign.?in|log.?in|unauthorized/i.test(status)) {
    return "Needs authentication. Sign in to this server, then reconnect.";
  }
  return status;
}

/** Claude's health text for a server it reached. */
export function isConnectedMcpStatus(status: string | undefined): boolean {
  return /(^|[^a-z])connected/i.test(status ?? "");
}

export function mcpPickerKey(server: McpConnection): string {
  return `${server.provider}:${server.scope}:${server.configPath}:${server.name}`;
}

/**
 * Keeps rows where they were once a reconnect has been asked for, so a
 * server that comes back does not slide another row's button under the
 * pointer. Rows that were not listed before go last.
 */
export function keepMcpPickerOrder(
  servers: McpPickerServer[],
  previous: readonly string[],
): McpPickerServer[] {
  const index = new Map(previous.map((key, position) => [key, position]));
  const at = (server: McpPickerServer) =>
    index.get(mcpPickerKey(server)) ?? previous.length;
  return [...servers].sort((a, b) => at(a) - at(b));
}

export function mcpContextText(servers: McpConnection[], text: string): string {
  if (servers.length === 0) return text;
  const names = servers
    .map((server) => `${JSON.stringify(server.name)} (${server.provider})`)
    .join(", ");
  return `MCP context: Use the configured server${servers.length === 1 ? "" : "s"} ${names} when relevant to this request.\n\n${text}`;
}
