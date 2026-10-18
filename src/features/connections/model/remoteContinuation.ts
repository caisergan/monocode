import type { Session } from "../../sessions/model/session";
import {
  loadRemoteSession,
  remoteMachineFor,
  remoteRequest,
} from "./connections";
import {
  HOST_HANDOFF_CAPABILITY,
  REMOTE_PROVIDERS,
  type HostDescriptor,
  type HostWorktree,
} from "./protocol";
import { remoteProjectFor } from "./remoteProjects";

export type RemoteContinuationSource = {
  /** The host's copy of the chat, with host paths. */
  session: Session;
  /** The host worktree the chat ran in, when it was not the project folder. */
  worktree?: string;
};

/** Reads a host chat for "Continue in new session". It refuses, with a reason
 * to show, anything the new chat could not start from: an offline or outdated
 * host, or a worktree that is gone. */
export async function readRemoteContinuationSource(
  project: string,
  sessionId: string,
): Promise<RemoteContinuationSource> {
  const remote = remoteProjectFor(project);
  if (!remote)
    throw new Error(
      "This project’s machine details are missing. Add the project again from the project rail.",
    );
  const machine = await remoteMachineFor(remote.environmentId);
  if (!machine)
    throw new Error(
      "The machine for this project isn’t connected on this computer.",
    );
  let host: HostDescriptor;
  try {
    host = await remoteRequest<HostDescriptor>(
      machine.id,
      "environment.describe",
      { supportedProviders: REMOTE_PROVIDERS },
    );
  } catch {
    throw new Error(
      `Couldn’t reach ${machine.name}. Reconnect it to continue this chat.`,
    );
  }
  if (host.environmentId !== machine.environmentId)
    throw new Error(
      "Host identity changed. Reconnect this machine before continuing.",
    );
  // An older host would drop the recap and send only what the user typed.
  if (!host.capabilities?.includes(HOST_HANDOFF_CAPABILITY))
    throw new Error(
      `The host on ${machine.name} is too old to continue chats in a new session. Install a host built from this version of MonoCode.`,
    );
  const snapshot = await loadRemoteSession(machine.id, sessionId);
  if (snapshot.projectId !== remote.projectId)
    throw new Error("This session belongs to a different host project");
  const { cwd } = snapshot.session;
  if (cwd === remote.cwd) return { session: snapshot.session };
  const { worktrees } = await remoteRequest<{ worktrees: HostWorktree[] }>(
    machine.id,
    "git.worktrees",
    { projectId: remote.projectId },
  );
  if (!worktrees.some((tree) => tree.path === cwd && !tree.missing))
    throw new Error(
      `This chat’s worktree no longer exists on ${machine.name}.`,
    );
  return { session: snapshot.session, worktree: cwd };
}
