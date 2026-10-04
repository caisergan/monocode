// The outbox rules from 06 §6.8 and §6.9 as data: how long a command may wait,
// which errors end it, and how long to back off. Pure, so the engine and its
// tests share them.

import type { ChannelError, ChannelErrorCode } from "@monocode/channel";
import type { HostCommand } from "@monocode/core/session";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long an unsent command may wait for the host (06 §6.9). */
export const EXPIRY_MS: Record<HostCommand["type"], number> = {
  create: 24 * HOUR,
  configure: HOUR,
  compact: HOUR,
  send: 24 * HOUR,
  draft: 24 * HOUR,
  removeDraft: 24 * HOUR,
  cancel: 10 * MINUTE,
  approve: 10 * MINUTE,
  answer: 10 * MINUTE,
  queue: 24 * HOUR,
  unqueue: HOUR,
  resumeQueue: HOUR,
  editQueued: HOUR,
  steer: 10 * MINUTE,
};

/** An acked send, queue or create stays on screen until its user block
 * arrives, or this long at most. */
export const OPTIMISTIC_MS = 10 * MINUTE;

/** Commands whose command id becomes a user block (or queued item) id. */
export function isOptimistic(type: HostCommand["type"]): boolean {
  return type === "send" || type === "queue" || type === "create";
}

/** Past expiry these are dropped, not failed: the turn has moved on. */
export function discardOnExpiry(type: HostCommand["type"]): boolean {
  return type === "approve" || type === "answer" || type === "cancel";
}

/** Retry delays: 1, 2, 4, … 30 s. `failures` counts from 1. */
export function backoffMs(failures: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1));
}

/** Errors that end an entry; everything else retryable goes back to pending. */
export const NON_RETRYABLE: readonly ChannelErrorCode[] = [
  "invalid_params",
  "stale_turn",
  "already_resolved",
  "session_busy",
  "not_found",
  "idempotency_conflict",
  "capability_missing",
  "provider_unavailable",
];

export type Verdict =
  /** Back to pending, with backoff. */
  | { kind: "retry" }
  /** Failed: the person can Retry (same command id) or Discard. */
  | { kind: "fail" }
  /** Dropped at once, with a quiet notice. */
  | { kind: "discard"; notice: string };

/** The quiet notice for a command the host no longer needs (11 §11.22). */
function discardNotice(code: ChannelErrorCode, type: HostCommand["type"]): string | undefined {
  if (code === "already_resolved") return "Answered on another device";
  if (code !== "stale_turn") return undefined;
  if (type === "approve") return "This approval is no longer needed";
  if (type === "answer") return "This request ended before your answer arrived.";
  return "This turn already ended.";
}

/** What to do with an entry after `error` (06 §6.8 rules 4 and 5). */
export function classify(error: ChannelError, type: HostCommand["type"]): Verdict {
  const notice = discardNotice(error.code, type);
  if (notice) return { kind: "discard", notice };
  if (NON_RETRYABLE.includes(error.code)) return { kind: "fail" };
  return error.retryable ? { kind: "retry" } : { kind: "fail" };
}

/** Any thrown value as a ChannelError. Transport failures without a code
 * count as `offline`, which is retryable. */
export function toChannelError(error: unknown): ChannelError {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    const value = error as { code: ChannelErrorCode; message?: string; retryable?: boolean; data?: unknown };
    return {
      code: value.code,
      message: value.message || "The machine couldn’t do that.",
      retryable: value.retryable ?? false,
      ...(value.data === undefined ? {} : { data: value.data }),
    };
  }
  return { code: "offline", message: error instanceof Error ? error.message : String(error), retryable: true };
}

/** The error an entry carries once its expiry passed unsent. */
export const EXPIRED: ChannelError = {
  code: "offline",
  message: "Not sent. The host was unreachable.",
  retryable: false,
  data: { expired: true },
};

export function isExpiredError(error: ChannelError | undefined): boolean {
  return !!error && (error.data as { expired?: boolean } | undefined)?.expired === true;
}

/** Copy for a failed entry, in the states catalog's words (11 §11.23). */
export function failureText(error: ChannelError | undefined, machine: string): string {
  if (!error || isExpiredError(error)) return `Not sent. ${machine} was unreachable.`;
  if (error.code === "internal") return `Couldn’t send the message on ${machine}.`;
  return error.message;
}
