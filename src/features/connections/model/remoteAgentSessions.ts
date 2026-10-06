import type {
  AgentSessionListing,
  AgentSessionSummary,
  ImportableHarness,
} from "../../../platform/tauri/agentSessions";
import { remoteMachineFor, remoteRequest } from "./connections";
import { remoteProjectFor } from "./remoteProjects";

/** Agents whose terminal sessions a host can import. */
export const REMOTE_IMPORTABLE_HARNESSES = ["claude"] as const satisfies
  readonly ImportableHarness[];

export type RemoteAgentSessionQuery = {
  harnesses?: ImportableHarness[];
  query?: string;
  limit?: number;
  includeImported?: boolean;
  since?: number;
};

/** Hosts from before terminal session import answer this. */
const UNSUPPORTED = "Unsupported host method";

export class RemoteImportUnsupported extends Error {
  constructor() {
    super(
      "Update this machine's host in Settings → Connections to import its terminal sessions.",
    );
  }
}

async function target(project: string) {
  const remote = remoteProjectFor(project);
  if (!remote) throw new Error("This project is not on a connected machine.");
  const machine = await remoteMachineFor(remote.environmentId);
  if (!machine)
    throw new Error("Connect this project's machine to import its sessions.");
  return { machineId: machine.id, projectId: remote.projectId };
}

async function request<T>(
  project: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const { machineId, projectId } = await target(project);
  try {
    return await remoteRequest<T>(machineId, method, { projectId, ...params });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes(UNSUPPORTED)) throw new RemoteImportUnsupported();
    throw new Error(text.replace(/^Host rejected request: /, ""));
  }
}

/** Terminal sessions that ran in a remote project's folder or worktrees, on
 * its host. Newest first. */
export function listRemoteAgentSessions(
  project: string,
  query: RemoteAgentSessionQuery,
): Promise<AgentSessionListing> {
  return request(project, "agentSessions.list", query);
}

/** Saves a terminal session as a host session that resumes the same
 * conversation, or finds the one that already does. */
export function importRemoteAgentSession(
  project: string,
  session: Pick<AgentSessionSummary, "harness" | "id" | "cwd">,
): Promise<{ sessionId: string; existing: boolean }> {
  return request(project, "agentSessions.import", {
    harness: session.harness,
    cwd: session.cwd,
    sessionId: session.id,
  });
}
