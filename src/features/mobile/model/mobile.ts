import { invoke } from "@tauri-apps/api/core";
import type {
  Device,
  DoctorReport,
  HostConfigPatch,
  HostConfigView,
  PairingOffer,
  PairingStatus,
} from "@monocode/core/wire";
import { remoteRequest } from "../../connections/model/connections";
import type {
  HostDescriptor,
  HostProject,
  HostSessionSummary,
  RemoteMachine,
} from "../../connections/model/protocol";
import {
  loadAccentColor,
  loadThemeDarkLightness,
  loadThemeHue,
  loadThemePreference,
  loadThemeSaturation,
} from "../../settings/model/appearance";

export type {
  Device,
  DoctorReport,
  HostConfigView,
  PairingOffer,
  PairingStatus,
};

/** `local_host_status`: MonoCode Host on this computer's own account. */
export type LocalHostStatus = {
  installed: boolean;
  running: boolean;
  /** The running host's version, or else the installed package's. */
  version?: string | null;
  port?: number | null;
  /** The saved "This computer" machine, once this desktop is paired. */
  machineId?: string | null;
  appVersion: string;
  dataDir: string;
  /** A setup, update or removal still in progress. */
  jobId?: string | null;
};

/** Projects on "This computer" run in its own host, so phones can use them. */
export const LOCAL_HOST_PROJECT_HINT =
  "On this computer’s host. Available on your phone.";

export type LocalHostStep =
  | "detect"
  | "download"
  | "verify"
  | "install"
  | "start"
  | "connect"
  | "done";

/** A local-host job, polled like SSH setup (`local_host_poll`). */
export type LocalHostJob = {
  id: string;
  message: string;
  step: LocalHostStep;
  done: boolean;
  error?: string | null;
  /** What the failed command printed. */
  output?: string | null;
  machine?: RemoteMachine | null;
};

export type RemoveMode = "stopSharing" | "uninstall";

export const localHostStatus = () =>
  invoke<LocalHostStatus>("local_host_status");
export const setUpLocalHost = () => invoke<string>("local_host_setup");
export const updateLocalHost = () => invoke<string>("local_host_update");
export const restartLocalHost = () => invoke<string>("local_host_restart");
export const removeLocalHost = (mode: RemoveMode) =>
  invoke<string>("local_host_remove", { mode });
export const startLocalHost = () => invoke<void>("local_host_start");
export const localHostDoctor = () =>
  invoke<DoctorReport>("local_host_doctor");
export const pollLocalHost = (jobId: string) =>
  invoke<LocalHostJob>("local_host_poll", { jobId });
export const cancelLocalHost = (jobId: string) =>
  invoke<void>("local_host_cancel", { jobId });

export type LocalHostState =
  | { kind: "loading" }
  | { kind: "notSetUp" }
  | { kind: "running"; version?: string }
  | { kind: "updateAvailable"; version: string; appVersion: string }
  | { kind: "stopped" };

/** Which row of the "This computer" table applies (spec 10 §10.2). Setup in
 * progress is the job's own state. */
export function localHostState(status?: LocalHostStatus): LocalHostState {
  if (!status) return { kind: "loading" };
  // No saved machine, or the host's folder was deleted by hand.
  if (!status.machineId || (!status.installed && !status.running))
    return { kind: "notSetUp" };
  if (!status.running) return { kind: "stopped" };
  if (status.version && status.version !== status.appVersion)
    return {
      kind: "updateAvailable",
      version: status.version,
      appVersion: status.appVersion,
    };
  return { kind: "running", version: status.version ?? undefined };
}

/** Negative when `a` is older. Pre-releases sort before their release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, pre] = value.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number(part) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export function updateCopy(version: string, appVersion: string): string {
  return compareVersions(version, appVersion) < 0
    ? `Host ${version} is older than this app (${appVersion}).`
    : `Host ${version} is newer than this app (${appVersion}).`;
}

const STEP_ORDER: LocalHostStep[] = [
  "detect",
  "download",
  "verify",
  "install",
  "start",
  "connect",
  "done",
];

/** The setup steps the page lists, after detection. */
export function setupSteps(
  version: string,
): { step: LocalHostStep; label: string }[] {
  return [
    { step: "download", label: `Download host ${version}` },
    { step: "verify", label: "Verify checksum" },
    { step: "install", label: "Install background service" },
    { step: "start", label: "Start" },
    { step: "connect", label: "Connect this desktop" },
    { step: "done", label: "Done" },
  ];
}

export type StepState = "done" | "active" | "failed" | "pending";

export function stepState(job: LocalHostJob, step: LocalHostStep): StepState {
  const current = STEP_ORDER.indexOf(job.step);
  const index = STEP_ORDER.indexOf(step);
  if (job.step === "done" || index < current) return "done";
  if (index > current) return "pending";
  if (job.error) return "failed";
  return job.done ? "done" : "active";
}

/** Hosts that pair phones list `pairing`. Hosts from before that capability
 * was listed over HTTP are known by `host.config`, which shipped with it. */
export function supportsPairing(descriptor?: HostDescriptor): boolean {
  return !!descriptor?.capabilities?.some(
    (capability) => capability === "pairing" || capability === "host.config",
  );
}

export function supportsPresence(descriptor?: HostDescriptor): boolean {
  return !!descriptor?.capabilities?.includes("presence");
}

export const RELAY_CONSENT =
  "The relay lets your phone reach this machine when it isn’t on the same network. Traffic is end-to-end encrypted: the relay sees only when you connect and how much data moves, never your code or messages.";

/** Who runs the relay, from the host's `relay.url`. */
export function relayOperator(url: string): string {
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    /* shown as configured */
  }
  return hostname === "relay.usemono.dev"
    ? "The relay is run by the MonoCode project."
    : `This relay is run by whoever operates ${hostname || url}.`;
}

export function reachableThrough(reachable: PairingOffer["reachable"]): string {
  return [
    reachable.lan && "local network",
    reachable.tailscale && "Tailscale",
    reachable.manual && "configured address",
    reachable.relay && "relay",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The six-digit confirmation, grouped as phones show it: `482 913`. */
export function formatCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function formatCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function relativeTime(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `on ${shortDate(at)}`;
}

function shortDate(at: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(at));
  } catch {
    return "";
  }
}

/** `iPhone 16 Pro · paired Oct 4 · last seen 2 min ago (relay)`. */
export function deviceDetail(device: Device, now = Date.now()): string {
  if (device.current) return `this desktop · ${device.role}`;
  if (device.status === "pending") return "Waiting for approval";
  const seen = device.lastSeenAt
    ? `last seen ${relativeTime(device.lastSeenAt, now)}${device.lastSeenVia ? ` (${device.lastSeenVia})` : ""}`
    : "never connected";
  return [
    device.model ?? device.platform,
    `paired ${shortDate(device.createdAt)}`,
    seen,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type DeviceEvent = {
  at: number;
  deviceId?: string;
  type: string;
  detail?: string;
};

export function eventLabel(event: DeviceEvent, devices: Device[]): string {
  const name =
    devices.find((device) => device.id === event.deviceId)?.name ??
    "A device";
  const what: Record<string, string> = {
    paired: "was paired",
    claimed: "asked to pair",
    approved: "was allowed",
    renamed: "was renamed",
    revoked: "was removed",
    denied: "was denied",
    expired: "wasn’t approved in time",
    cancelled: "stopped pairing",
    superseded: "paired again",
  };
  return `${name} ${what[event.type] ?? event.type}`;
}

export const listDevices = (machineId: string) =>
  remoteRequest<Device[]>(machineId, "devices.list");
export const renameDevice = (machineId: string, deviceId: string, name: string) =>
  remoteRequest<Device>(machineId, "devices.rename", { deviceId, name });
export const revokeDevice = (machineId: string, deviceId: string) =>
  remoteRequest<{ revoked: boolean }>(machineId, "devices.revoke", {
    deviceId,
  });
export const deviceEvents = (machineId: string) =>
  remoteRequest<DeviceEvent[]>(machineId, "devices.events", { limit: 50 });

export const hostConfig = (machineId: string) =>
  remoteRequest<HostConfigView>(machineId, "host.config.get");
export const setHostConfig = (machineId: string, patch: HostConfigPatch) =>
  remoteRequest<HostConfigView>(machineId, "host.config.set", patch);

/** This desktop's look, so the phone can offer to match it (spec 11 §11.2). */
export function offerAppearance() {
  return {
    theme: loadThemePreference(),
    hue: loadThemeHue(),
    sat: loadThemeSaturation(),
    dark: loadThemeDarkLightness(),
    accent: loadAccentColor(),
  };
}

export const createPairing = (machineId: string) =>
  remoteRequest<PairingOffer>(machineId, "pairing.create", {
    ui: offerAppearance(),
  });
export const pairingStatus = (machineId: string, offerId: string) =>
  remoteRequest<PairingStatus>(machineId, "pairing.status", { offerId });
export const decidePairing = (
  machineId: string,
  offerId: string,
  allow: boolean,
) =>
  remoteRequest<PairingStatus>(machineId, "pairing.decide", {
    offerId,
    allow,
  });
export const cancelPairing = (machineId: string, offerId: string) =>
  remoteRequest<PairingStatus>(machineId, "pairing.cancel", { offerId });

/** Whether an agent is working on the machine. Host updates wait for idle. */
export async function hostBusy(machineId: string): Promise<boolean> {
  const projects = await remoteRequest<HostProject[]>(
    machineId,
    "projects.list",
  );
  for (const project of projects) {
    const sessions = await remoteRequest<HostSessionSummary[]>(
      machineId,
      "sessions.list",
      { projectId: project.id },
    );
    if (sessions.some((session) => session.status === "running")) return true;
  }
  return false;
}

const PAIR_OPTIONS_KEY = "monocode.mobile-pair-options.v1";

/** The "How should your phone reach…" step shows once per machine. */
export function pairOptionsSeen(environmentId: string): boolean {
  try {
    const seen: unknown = JSON.parse(
      localStorage.getItem(PAIR_OPTIONS_KEY) ?? "[]",
    );
    return Array.isArray(seen) && seen.includes(environmentId);
  } catch {
    return false;
  }
}

export function rememberPairOptions(environmentId: string) {
  try {
    const seen: unknown = JSON.parse(
      localStorage.getItem(PAIR_OPTIONS_KEY) ?? "[]",
    );
    const next = Array.isArray(seen) ? seen : [];
    if (!next.includes(environmentId)) next.push(environmentId);
    localStorage.setItem(PAIR_OPTIONS_KEY, JSON.stringify(next));
  } catch {
    /* the step shows again next time */
  }
}

/** A host's error without the transport's prefix. */
export function hostMessage(reason: unknown): string {
  return String(reason instanceof Error ? reason.message : reason)
    .replace(/^Error: /, "")
    .replace(/^Host rejected request: /, "");
}
