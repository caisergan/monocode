// Optimistic transcript content from the outbox (12 §12.8): user blocks for
// send, draft and create.initial entries until the host's block with the same
// id arrives, and the outbox state under each bubble (11 §11.16). Pure.

import type { Attachment, Block, RemoteAttachment } from "@monocode/core/session";
import type { OutboxEntry } from "../storage/repo";
import { failureText } from "../outbox/policy";

export type PendingMark = {
  /** Under the bubble: "Sending…", "Waiting for {machine}" or "Not sent". */
  label: string;
  /** A failed entry: its row offers Retry and Discard. */
  failed?: { commandId: string; text: string };
};

const attachments = (files: readonly RemoteAttachment[] | undefined): { attachments?: Attachment[] } =>
  files?.length ? { attachments: files.map((file) => ({ ...file })) } : {};

/** The user block an entry stands for, if it makes one. */
function userBlock(entry: OutboxEntry): Block | undefined {
  const command = entry.command;
  if (command.type === "send" && !command.draftBlockId)
    return { id: command.commandId, role: "user", text: command.text, startedAt: entry.createdAt, ...attachments(command.attachments) };
  if (command.type === "draft")
    return { id: command.commandId, role: "user", text: command.text, draft: true, ...attachments(command.attachments) };
  if (command.type === "create" && command.initial)
    return { id: command.commandId, role: "user", text: command.initial.text, startedAt: entry.createdAt, ...attachments(command.initial.attachments) };
  return undefined;
}

/** Blocks to append after the window: entries whose block hasn't arrived. */
export function optimisticBlocks(entries: readonly OutboxEntry[], known: ReadonlySet<string>): Block[] {
  return entries.flatMap((entry) => {
    if (known.has(entry.commandId)) return [];
    const block = userBlock(entry);
    return block ? [block] : [];
  });
}

/** The outbox state to show under each optimistic bubble. */
export function pendingMarks(entries: readonly OutboxEntry[], machine: string, online: boolean): Map<string, PendingMark> {
  const marks = new Map<string, PendingMark>();
  for (const entry of entries) {
    if (!userBlock(entry)) continue;
    if (entry.state === "failed")
      marks.set(entry.commandId, {
        label: "Not sent",
        failed: { commandId: entry.commandId, text: failureText(entry.error, machine) },
      });
    else if (entry.state !== "acked" && !online) marks.set(entry.commandId, { label: `Waiting for ${machine}` });
    else marks.set(entry.commandId, { label: "Sending…" });
  }
  return marks;
}

/** Approvals with an approve entry in the outbox: their buttons read "Sending…". */
export function sendingApprovals(entries: readonly OutboxEntry[]): Set<number> {
  const ids = new Set<number>();
  for (const entry of entries) if (entry.command.type === "approve" && entry.state !== "failed") ids.add(entry.command.requestId);
  return ids;
}
