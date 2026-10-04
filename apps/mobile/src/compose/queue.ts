// The queue card's state (11 §11.17): the host's queued messages, with the
// phone's unsent queue commands applied on top so edits, removals, steers and
// new items show at once. Pure; tested without React.

import type { HostCommand, Session } from "@monocode/core/session";
import type { OutboxEntry } from "../storage/repo";

export type QueueRow = {
  /** The queued id: the queue command's command id. */
  id: string;
  text: string;
  attachments: number;
  /** The host doesn't have this row (or its latest edit) yet. */
  pending: boolean;
  /** The phone's queue command failed: Retry or Discard. */
  failedEntry?: string;
  /** The row may be steered: the host has it and a turn is running. */
  canSteer: boolean;
  /** Edit and Remove act on the host's item. */
  canEdit: boolean;
};

export type QueueCardState = {
  rows: QueueRow[];
  paused: boolean;
  pausedText?: string;
};

type QueueSession = Pick<Session, "queuedMessages" | "queueStatus" | "usageLimit">;

type Queued = Extract<HostCommand, { type: "queue" }>;

const unsent = (entry: OutboxEntry) => entry.state === "pending" || entry.state === "sending";

/** Undefined when there is nothing to show. */
export function queueCardState(input: {
  session?: QueueSession;
  status: "idle" | "running" | "interrupted";
  runId?: string;
  /** The session's outbox entries, in send order. */
  entries: readonly OutboxEntry[];
}): QueueCardState | undefined {
  const { session, status, runId, entries } = input;
  const running = status === "running" && !!runId;
  const removed = new Set<string>();
  const edits = new Map<string, string>();
  let steered: string | undefined;
  let resuming = false;
  for (const entry of entries) {
    const command = entry.command;
    if (!unsent(entry) && entry.state !== "acked") continue;
    if (command.type === "unqueue") removed.add(command.queuedId);
    else if (command.type === "editQueued" && unsent(entry)) edits.set(command.queuedId, command.text);
    else if (command.type === "steer" && unsent(entry)) steered = command.queuedId;
    else if (command.type === "resumeQueue" && unsent(entry)) resuming = true;
  }

  const hostRows: QueueRow[] = (session?.queuedMessages ?? [])
    .filter((item) => !removed.has(item.id))
    .map((item) => ({
      id: item.id,
      text: edits.get(item.id) ?? item.text,
      attachments: item.attachments?.length ?? 0,
      pending: edits.has(item.id),
      canSteer: running,
      canEdit: true,
    }));
  const known = new Set(hostRows.map((row) => row.id));
  const localRows: QueueRow[] = entries
    .filter((entry): entry is OutboxEntry & { command: Queued } => entry.command.type === "queue")
    .filter((entry) => !known.has(entry.commandId) && !removed.has(entry.commandId))
    // An acked queue command the host ran at once is a turn now, not a row.
    .filter((entry) => entry.state !== "acked")
    .map((entry) => ({
      id: entry.commandId,
      text: entry.command.text,
      attachments: entry.command.attachments?.length ?? 0,
      pending: true,
      ...(entry.state === "failed" ? { failedEntry: entry.commandId } : {}),
      canSteer: false,
      canEdit: false,
    }));

  let rows = [...hostRows, ...localRows];
  if (steered) {
    const head = rows.find((row) => row.id === steered);
    if (head) rows = [{ ...head, pending: true, canSteer: false }, ...rows.filter((row) => row !== head)];
  }
  if (!rows.length) return undefined;
  const paused = session?.queueStatus === "paused" && hostRows.length > 0 && !resuming;
  return {
    rows,
    paused,
    ...(paused
      ? { pausedText: session?.usageLimit ? "Queue paused because the usage limit was reached" : "Queue paused because you interrupted" }
      : {}),
  };
}

/** Whether new messages queue instead of starting a turn (06 §6.9 `queue`):
 * a turn is running, something is already queued, or a usage limit holds. */
export function shouldQueue(session: QueueSession | undefined, status: "idle" | "running" | "interrupted"): boolean {
  return status === "running" || !!session?.queuedMessages?.length || !!session?.usageLimit;
}
