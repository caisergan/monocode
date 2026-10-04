import { describe, expect, it } from "vitest";
import { newSession, type Session } from "./session";
import {
  formatUsageLimitReset,
  reportedUsageLimit,
  USAGE_LIMIT_RESUME_GRACE_MS,
  usageLimitResumeDue,
  withUsageLimitReset,
} from "./usageLimit";

function limited(patch: Partial<Session> = {}): Session {
  return {
    ...newSession("codex", "/tmp/project"),
    usageLimit: { resetsAt: 10_000, resumeAtReset: true },
    ...patch,
  };
}

describe("usageLimitResumeDue", () => {
  it("waits for the reset plus a grace period", () => {
    expect(usageLimitResumeDue(limited(), 10_000)).toBe(false);
    expect(
      usageLimitResumeDue(limited(), 10_000 + USAGE_LIMIT_RESUME_GRACE_MS),
    ).toBe(true);
  });

  it("only resumes idle sessions the user armed", () => {
    const later = 10_000 + USAGE_LIMIT_RESUME_GRACE_MS;
    expect(usageLimitResumeDue(limited({ busy: true }), later)).toBe(false);
    expect(
      usageLimitResumeDue(
        limited({ usageLimit: { resetsAt: 10_000 } }),
        later,
      ),
    ).toBe(false);
    expect(
      usageLimitResumeDue(limited({ usageLimit: { resumeAtReset: true } }), later),
    ).toBe(false);
  });
});

describe("reportedUsageLimit", () => {
  it("stays unarmed unless Settings arms it", () => {
    expect(reportedUsageLimit(10_000, 0, false)).toEqual({ resetsAt: 10_000 });
    expect(reportedUsageLimit(undefined, 0, false)).toEqual({});
  });

  it("arms a limit whose reset is ahead, or not yet known", () => {
    expect(reportedUsageLimit(10_000, 0, true)).toEqual({
      resetsAt: 10_000,
      resumeAtReset: true,
    });
    expect(reportedUsageLimit(undefined, 0, true)).toEqual({
      resumeAtReset: true,
    });
  });

  it("does not arm a reset already behind us", () => {
    expect(reportedUsageLimit(10_000, 10_000, true)).toEqual({
      resetsAt: 10_000,
    });
  });
});

describe("withUsageLimitReset", () => {
  it("keeps the arming for a reset still ahead", () => {
    expect(withUsageLimitReset({ resumeAtReset: true }, 10_000, 0)).toEqual({
      resetsAt: 10_000,
      resumeAtReset: true,
    });
  });

  it("disarms a reset already behind us", () => {
    expect(
      withUsageLimitReset({ resumeAtReset: true }, 10_000, 20_000),
    ).toEqual({ resetsAt: 10_000 });
  });
});

describe("formatUsageLimitReset", () => {
  it("shows the time and what is left", () => {
    const now = new Date(2026, 8, 25, 22, 34).getTime();
    const today = new Date(2026, 8, 25, 23, 50).getTime();
    expect(formatUsageLimitReset(today, now)).toMatch(/ · in 1h 16m$/);
    const tomorrow = new Date(2026, 8, 26, 3, 16).getTime();
    expect(formatUsageLimitReset(tomorrow, now)).toMatch(/26.* · in 4h 42m$/);
  });
});
