import { formatResetDuration } from "../../providers/model/rateLimits";
import { loadResumeAfterUsageLimit } from "../../settings/model/settings";
import type { Session, UsageLimit } from "./session";

/** Providers can still refuse right at the reset; give them a moment. */
export const USAGE_LIMIT_RESUME_GRACE_MS = 30_000;

/** "3:16 AM · in 4h 42m" today, "Sep 26, 3:16 AM · in 1d 4h" later. */
export function formatUsageLimitReset(resetsAt: number, now: number): string {
  const reset = new Date(resetsAt);
  const sameDay = reset.toDateString() === new Date(now).toDateString();
  const when = reset.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
  return `${when} · in ${formatResetDuration(resetsAt - now)}`;
}

/** Idle, armed, and past its reset: time to send the continue turn. */
export function usageLimitResumeDue(session: Session, now: number): boolean {
  const limit = session.usageLimit;
  if (!limit?.resumeAtReset || limit.resetsAt == null || session.busy) {
    return false;
  }
  return now >= limit.resetsAt + USAGE_LIMIT_RESUME_GRACE_MS;
}

/**
 * The limit a turn just hit. With "Resume after usage limit" on it starts
 * armed, unless its reset is already behind us: continuing then would hit the
 * same limit again and loop.
 */
export function reportedUsageLimit(
  resetsAt: number | undefined,
  now = Date.now(),
  armed = loadResumeAfterUsageLimit(),
): UsageLimit {
  if (resetsAt == null) return armed ? { resumeAtReset: true } : {};
  return armed && resetsAt > now
    ? { resetsAt, resumeAtReset: true }
    : { resetsAt };
}

/** The reset time looked up after the fact; a past one cannot be waited for. */
export function withUsageLimitReset(
  limit: UsageLimit,
  resetsAt: number,
  now: number,
): UsageLimit {
  return resetsAt > now ? { ...limit, resetsAt } : { resetsAt };
}
