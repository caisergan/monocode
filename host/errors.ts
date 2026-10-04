import type { ChannelError, ChannelErrorCode } from "@monocode/channel/envelope";

/** An error a client can act on. HTTP keeps `{error: message}` and adds
 * `code`; the channel sends the whole `ChannelError`. */
export class HostError extends Error {
  constructor(
    readonly code: ChannelErrorCode,
    message: string,
    readonly retryable = false,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const MESSAGE_CODES: [RegExp, ChannelErrorCode, boolean][] = [
  [/^Unsupported host method$/, "method_not_found", false],
  [/^(Session not found|Project is not registered|Draft not found)/, "not_found", false],
  [
    /^(This session is already running|Wait for the current turn|Stop this session before deleting|Wait for running host sessions|This session cannot save another draft)/,
    "session_busy",
    false,
  ],
  [/^(Wait for the branch switch to finish|A branch switch is already in progress)/, "branch_switching", true],
  [/^This request belongs to a finished or replaced turn/, "stale_turn", false],
  [/^(Approval|Question) is already resolved/, "already_resolved", false],
  [/^Plan is not ready to build/, "plan_not_ready", false],
  [/^Command ID was already used with a different payload/, "idempotency_conflict", false],
  [/(is not available on this host|Context compaction is unavailable)/, "provider_unavailable", false],
  [/^Request is too large/, "payload_too_large", false],
  [/^Host is stopping/, "host_stopping", true],
  [/^Session transfer expired/, "transfer_expired", true],
  [/^Device credential is invalid or revoked/, "unauthorized", false],
  [/^(Invalid|Unsupported command|Session does not belong|No session changes|Choose an absolute|Project path is not)/, "invalid_params", false],
];

export function toHostError(error: unknown): HostError {
  if (error instanceof HostError) return error;
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, code, retryable] of MESSAGE_CODES)
    if (pattern.test(message)) return new HostError(code, message, retryable);
  // Workspace and git helpers throw human-readable messages for bad input
  // (missing files, traversal, git failures). Keep the text; mark it internal.
  return new HostError("internal", message || "Host request failed");
}

export function wireError(error: unknown): ChannelError {
  const host = toHostError(error);
  return {
    code: host.code,
    message: host.message,
    retryable: host.retryable,
    ...(host.data === undefined ? {} : { data: host.data }),
  };
}
