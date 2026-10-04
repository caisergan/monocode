// Who is looking at what (spec 08 §8.3). Phones report presence in their
// hello, in pings and through `presence.update`; the desktop over HTTP. Memory
// only: a restart forgets it, and a closed channel clears its device.

import type { Presence } from "@monocode/channel/envelope";
import type { Via } from "./devices";
import { HostError } from "./errors";

export type PresenceEntry = Presence & { at: number; via: Via };

/** A phone counts as present for this long after its last report. */
export const PHONE_PRESENCE_MS = 45_000;
/** The desktop reports every 30 s while focused. */
export const DESKTOP_PRESENCE_MS = 60_000;

export function parsePresence(value: unknown): Presence {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.visible !== "boolean")
    throw new HostError("invalid_params", "Invalid presence");
  if (
    v.focusedSessionId !== undefined &&
    v.focusedSessionId !== null &&
    (typeof v.focusedSessionId !== "string" || !v.focusedSessionId || v.focusedSessionId.length > 128)
  )
    throw new HostError("invalid_params", "Invalid presence session");
  return {
    visible: v.visible,
    ...(typeof v.focusedSessionId === "string" ? { focusedSessionId: v.focusedSessionId } : {}),
  };
}

export class PresenceMap {
  private entries = new Map<string, PresenceEntry>();

  update(deviceId: string, presence: Presence, via: Via, now = Date.now()): void {
    this.entries.set(deviceId, { ...presence, at: now, via });
  }

  clear(deviceId: string): void {
    this.entries.delete(deviceId);
  }

  get(deviceId: string): PresenceEntry | undefined {
    return this.entries.get(deviceId);
  }

  /** Whether the device reported itself visible recently enough to count. */
  isPresent(deviceId: string, now = Date.now()): boolean {
    const entry = this.entries.get(deviceId);
    return !!entry && entry.visible && now - entry.at <= maxAge(entry);
  }

  /** Devices present and focused on the session within `withinMs`. */
  watching(sessionId: string, withinMs: number, now = Date.now()): string[] {
    return [...this.entries]
      .filter(
        ([, entry]) =>
          entry.visible &&
          entry.focusedSessionId === sessionId &&
          now - entry.at <= Math.min(withinMs, maxAge(entry)),
      )
      .map(([deviceId]) => deviceId);
  }
}

const maxAge = (entry: PresenceEntry) =>
  entry.via === "http" ? DESKTOP_PRESENCE_MS : PHONE_PRESENCE_MS;
