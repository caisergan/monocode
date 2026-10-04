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
