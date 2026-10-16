import { invoke } from "@tauri-apps/api/core";
import { parseClaudeMcpList, type McpConnection } from "./mcp";

export type McpServerRow = McpConnection & { status: string };

export type McpSettingsSnapshot = {
  servers: McpServerRow[];
  error: string;
  claudeError: string;
};

const snapshots = new Map<string, McpSettingsSnapshot>();
const requests = new Map<string, Promise<McpSettingsSnapshot>>();
const healthRequests = new Map<string, Promise<void>>();
const listeners = new Map<
  string,
  Set<(snapshot: McpSettingsSnapshot) => void>
>();

export function getCachedMcpSettings(cwd: string) {
  return snapshots.get(cwd);
}

export function subscribeMcpSettings(
  cwd: string,
  listener: (snapshot: McpSettingsSnapshot) => void,
) {
  const subscribers = listeners.get(cwd) ?? new Set();
  subscribers.add(listener);
  listeners.set(cwd, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(cwd);
  };
}

function publish(cwd: string, snapshot: McpSettingsSnapshot) {
  snapshots.set(cwd, snapshot);
  listeners.get(cwd)?.forEach((listener) => listener(snapshot));
}

/** Discovery is shared across settings and pickers; health never delays the list. */
export function loadMcpSettings(
  cwd: string,
  force = false,
  options: { claudeHealth?: boolean } = {},
) {
  let request = requests.get(cwd);
  if (!request || force) {
    const discovery = fetchMcpSettings(cwd).then((snapshot) => {
      if (requests.get(cwd) === discovery) {
        healthRequests.delete(cwd);
        publish(cwd, snapshot);
      }
      return snapshot;
    });
    requests.set(cwd, discovery);
    request = discovery;
  }
  const discovery = request;
  return discovery.then((snapshot) => {
    if (
      options.claudeHealth !== false &&
      !snapshot.error &&
      requests.get(cwd) === discovery
    ) {
      loadClaudeHealth(cwd, discovery);
    }
    return snapshots.get(cwd) ?? snapshot;
  });
}

/**
 * Run Claude's health check again and resolve with what it found. `claude
 * mcp list` connects every server itself, so this is a fresh attempt.
 */
export async function recheckClaudeMcpHealth(
  cwd: string,
): Promise<McpSettingsSnapshot> {
  const snapshot = await loadMcpSettings(cwd, false, { claudeHealth: false });
  const discovery = requests.get(cwd);
  if (snapshot.error || !discovery) return snapshot;
  healthRequests.delete(cwd);
  loadClaudeHealth(cwd, discovery);
  await healthRequests.get(cwd);
  return snapshots.get(cwd) ?? snapshot;
}

async function fetchMcpSettings(cwd: string): Promise<McpSettingsSnapshot> {
  try {
    const configured = await invoke<McpConnection[]>("mcp_discover", { cwd });
    const servers = configured.map((server) => ({
      ...server,
      status: server.enabled === false ? "Disabled" : "Configured",
    }));
    return { servers, error: "", claudeError: "" };
  } catch (cause) {
    return { servers: [], error: String(cause), claudeError: "" };
  }
}

function loadClaudeHealth(
  cwd: string,
  discovery: Promise<McpSettingsSnapshot>,
) {
  if (healthRequests.has(cwd)) return;
  // A newer discovery or a recheck replaces this one.
  const stale = () =>
    requests.get(cwd) !== discovery || healthRequests.get(cwd) !== request;
  const request: Promise<void> = invoke<string>("claude_mcp_list", { cwd })
    .then((output) => {
      if (stale()) return;
      const snapshot = snapshots.get(cwd)!;
      const health = new Map(
        parseClaudeMcpList(output).map((server) => [
          server.name,
          server.status,
        ]),
      );
      const servers: McpServerRow[] = snapshot.servers.map((server) => ({
        ...server,
        status:
          server.enabled === false
            ? "Disabled"
            : server.provider === "claude"
              ? (health.get(server.name) ?? "Configured")
              : server.status,
      }));
      // Claude can supply connections that are not stored in a local config file.
      for (const [name, status] of health) {
        if (
          servers.some(
            (server) => server.provider === "claude" && server.name === name,
          )
        )
          continue;
        servers.push({
          provider: "claude",
          name,
          scope: "local",
          configPath: "",
          transport: "",
          status,
        });
      }
      publish(cwd, { ...snapshot, servers, claudeError: "" });
    })
    .catch((cause) => {
      if (stale()) return;
      publish(cwd, { ...snapshots.get(cwd)!, claudeError: String(cause) });
    });
  healthRequests.set(cwd, request);
}

export function clearMcpSettingsCache() {
  snapshots.clear();
  requests.clear();
  healthRequests.clear();
}
