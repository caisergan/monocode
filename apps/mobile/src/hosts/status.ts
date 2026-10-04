// Connection copy from the states catalog (11 §11.23), shared by the Agents
// banner, machine rows, the Project screen and the session notice bar.

import { useEffect, useState } from "react";
import type { HostConnState, HostRecord } from "./types";

/** "Reconnecting…" shows only after this long, so blips stay quiet. */
export const RECONNECTING_AFTER_MS = 3_000;

export function lastSeen(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The notice for a machine that can't serve requests, or undefined. */
export function hostNotice(record: Pick<HostRecord, "label" | "lastOnlineAt">, state: HostConnState | undefined, now = Date.now()): string | undefined {
  const name = record.label;
  if (state?.kind === "blocked") {
    if (state.reason === "device_revoked" || state.reason === "unknown_device") return `This phone was removed from ${name}.`;
    if (state.reason === "host_identity_changed") return `Can’t verify ${name}. It was reinstalled or its identity changed.`;
    return `${name} needs a host update. Update it from MonoCode on your computer: Settings → Connections → Update Host.`;
  }
  if (state?.kind === "offline") {
    const seen = state.lastOnlineAt ?? record.lastOnlineAt;
    return seen ? `${name} is offline · last seen ${lastSeen(seen, now)}.` : `${name} is offline.`;
  }
  return undefined;
}

/** True once a reconnect has lasted longer than 3 s. */
export function useReconnecting(state: HostConnState | undefined): boolean {
  const since = state?.kind === "reconnecting" ? state.since : undefined;
  const [late, setLate] = useState<number>();
  useEffect(() => {
    if (since === undefined) return;
    const timer = setTimeout(() => setLate(since), Math.max(0, since + RECONNECTING_AFTER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since]);
  return since !== undefined && late === since;
}

/** The status dot of a machine row (11 §11.13). */
export function hostDot(state: HostConnState | undefined): "online" | "connecting" | "offline" {
  if (state?.kind === "online") return "online";
  if (state?.kind === "connecting" || state?.kind === "reconnecting") return "connecting";
  return "offline";
}
