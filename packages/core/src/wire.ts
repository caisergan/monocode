// Wire shapes added for phones (spec 06 §6.5-6.7). Host and phone are
// type-checked against these.

import type {
  Block,
  HostSession,
  HostSessionSummary,
  RemoteProvider,
  RuntimeMode,
  Session,
  ToolPreview,
} from "./session";

/** The blocks from an anchor block to the end. */
export type SyncWindow = { anchor?: string; tailTurns?: number };

export type WindowMeta = { anchor: string | null; olderTurns: number; olderBlocks: number };

/** `sessions.sync` with a window: snapshot and delta carry `window`. */
export type WindowedSync =
  | { kind: "unchanged"; revision: number; window?: WindowMeta }
  | { kind: "snapshot"; value: HostSession; window?: WindowMeta }
  | {
      kind: "delta";
      base: number;
      value: Omit<HostSession, "session" | "blockRevisions"> & {
        session: Omit<Session, "blocks">;
      };
      blockIds: string[];
      blocks: Block[];
      window?: WindowMeta;
    };

/** A block cut down for transit; `truncated.chars` is its full JSON length. */
export type TruncatedBlock = Block & { truncated?: { chars: number } };

export type WatchSet = {
  inbox?: boolean;
  projects?: string[];
  sessions?: { id: string; revision?: number; window?: SyncWindow; maxBlockChars?: number }[];
};

export type SessionListItem = HostSessionSummary & {
  lastText?: string;
  finishedAt?: number;
  queueLength?: number;
};

export type Attention =
  | "approval"
  | "question"
  | "error"
  | "interrupted"
  | "usage_limit"
  | "finished"
  | null;

export type InboxItem = {
  sessionId: string;
  projectId: string;
  projectName: string;
  title: string;
  harness: RemoteProvider;
  model?: string;
  runtimeMode?: RuntimeMode;
  status: "idle" | "running" | "interrupted";
  runId?: string;
  attention: Attention;
  needsInput: boolean;
  approval?: { requestId: number; title: string; kind?: string; preview?: ToolPreview };
  question?: { requestId: number; title?: string; count: number; autoResolveAt?: number };
  lastText?: string;
  updatedAt: number;
  finishedAt?: number;
  branch?: string;
  worktreeCwd?: string;
  pinned?: boolean;
  archived?: boolean;
  revision: number;
  queueLength?: number;
};

export type InboxList = { boot: string; revision: number; items: InboxItem[]; truncated: boolean };

export type Device = {
  id: string;
  name: string;
  kind: "desktop" | "mobile";
  role: "admin" | "member";
  status: "pending" | "active";
  platform?: string;
  model?: string;
  appVersion?: string;
  createdAt: number;
  lastSeenAt?: number;
  lastSeenVia?: "http" | "direct" | "relay";
  current: boolean;
  push: boolean;
};

export type PairingStatus = {
  offerId: string;
  status: "open" | "claimed" | "approved" | "denied" | "expired" | "cancelled";
  expiresAt: number;
  device?: { id: string; name: string; platform: string; model?: string };
  code?: string;
};

/** `pairing.create` result. */
export type PairingOffer = {
  offerId: string;
  url: string;
  expiresAt: number;
  fingerprint: string;
  reachable: { lan: boolean; tailscale: boolean; manual: boolean; relay: boolean };
};

/** `host.config.get` and `host.config.set` (spec 06 §6.5). */
export type HostConfigView = {
  relay: {
    enabled: boolean;
    url: string;
    status: "disabled" | "connecting" | "online" | "unauthorized" | "blocked" | "error";
  };
  direct: {
    mode: "off" | "private" | "all";
    port: number;
    /** Addresses the direct listener is bound to right now. */
    listening: string[];
    advertise: { addr: string; port: number }[];
  };
  push: { enabled: boolean; allowPrivateGateways: boolean };
  pairing: { requireConfirmation: boolean; linkBase: string };
};

/** Omitted fields keep their value. Unknown fields are rejected. */
export type HostConfigPatch = {
  relay?: { enabled?: boolean; url?: string };
  direct?: {
    mode?: "off" | "private" | "all";
    port?: number;
    advertise?: { addr: string; port: number }[];
  };
  push?: { enabled?: boolean; allowPrivateGateways?: boolean };
  pairing?: { requireConfirmation?: boolean; linkBase?: string };
};

/** `presence.update`, and `presence` in hello and ping (spec 08 §8.3). */
export type PresenceUpdate = { visible: boolean; focusedSessionId?: string };

export type DoctorCheckId =
  | "host"
  | "version"
  | "database"
  | "integrity"
  | "keys"
  | "config"
  | "listeners"
  | "providers"
  | "disk"
  | "relay"
  | "push";

/** One `monocode-host doctor` line. `fix` is null when there is nothing to do. */
export type DoctorCheck = {
  id: DoctorCheckId;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix: string | null;
};

/** `monocode-host doctor --json`. `ok` is false when any check failed. */
export type DoctorReport = {
  v: 1;
  hostVersion: string;
  ok: boolean;
  checks: DoctorCheck[];
};
