// Wire types for channel 1 (spec 06). Session-level shapes (blocks, summaries)
// live in @monocode/core; this file only knows the envelope and handshake.

export const CHANNEL_VERSION = 1;

export const FRAME_HANDSHAKE_1 = 0x01;
export const FRAME_HANDSHAKE_2 = 0x02;
export const FRAME_TRANSPORT = 0x03;
export const FRAME_REJECT = 0x04;

export type Endpoint =
  | { kind: "lan"; addr: string; port: number }
  | { kind: "tailscale"; addr: string; port: number; dns?: string }
  | { kind: "manual"; addr: string; port: number };

export type Presence = { visible: boolean; focusedSessionId?: string };

export type ClientCap = "deflate" | "attention" | "windowedSync" | "truncatedBlocks";

export type Hello = {
  v: 1;
  env: string;
  /** Handshake counter; 0 when pairing. */
  n: number;
  channel: { min: number; max: number };
  app: {
    name: string;
    version: string;
    build: string;
    platform: "ios" | "android" | "node";
    os: string;
    model?: string;
  };
  caps: ClientCap[];
  providers: string[];
  presence?: Presence;
  pair?: { offer: string };
};

export type HostInfo = {
  name: string;
  platform: string;
  version: string;
  fingerprint: string;
};

export type Role = "admin" | "member";

export type Welcome = {
  ok: true;
  channel: 1;
  env: string;
  boot: string;
  time: number;
  host: HostInfo;
  device: { id: string; name: string; role: Role };
  capabilities: string[];
  providers: string[];
  endpoints: Endpoint[];
  relay: { url: string; room: string } | null;
  push: { enabled: boolean };
  limits: { maxMessage: number; maxInFlight: number; maxWatchedSessions: number };
};

export type PairingWelcome = {
  ok: true;
  channel: 1;
  env: string;
  boot: string;
  time: number;
  host: HostInfo;
  pairing: { offer: string; expiresAt: number };
};

export type HandshakeError = { ok: false; code: ChannelErrorCode; message: string };

export type HandshakeReply = Welcome | PairingWelcome | HandshakeError;

export function isPairingWelcome(value: HandshakeReply): value is PairingWelcome {
  return value.ok && "pairing" in value;
}

export type ByeCode =
  | "rekey"
  | "replaced"
  | "background"
  | "device_revoked"
  | "host_stopping"
  | "protocol_error"
  | "idle_timeout"
  | "pairing_closed";

export type ChannelErrorCode =
  // requests
  | "invalid_params"
  | "method_not_found"
  | "not_found"
  | "session_busy"
  | "branch_switching"
  | "stale_turn"
  | "already_resolved"
  | "plan_not_ready"
  | "idempotency_conflict"
  | "provider_unavailable"
  | "payload_too_large"
  | "host_stopping"
  | "transfer_expired"
  | "unauthorized"
  | "forbidden"
  | "capability_missing"
  | "rate_limited"
  | "internal"
  // handshake
  | "handshake_failed"
  | "unknown_device"
  | "device_revoked"
  | "device_pending"
  | "replayed_handshake"
  | "host_identity_changed"
  | "protocol_incompatible"
  // pairing
  | "pairing_expired"
  | "pairing_used"
  | "pairing_cancelled"
  | "pairing_proof_invalid"
  | "device_key_in_use"
  // client-side only
  | "offline"
  | "timeout";

export type ChannelError = {
  code: ChannelErrorCode;
  message: string;
  retryable: boolean;
  data?: unknown;
};

export type ClientMessage =
  | { t: "req"; id: number; m: string; p?: Record<string, unknown>; key?: string }
  | { t: "cancel"; id: number }
  | { t: "ping"; ts: number; presence?: Presence }
  | { t: "bye"; code: ByeCode };

export type HostMessage =
  | { t: "res"; id: number; ok: true; r: unknown }
  | { t: "res"; id: number; ok: false; e: ChannelError }
  | { t: "evt"; e: string; d: unknown }
  | { t: "pong"; ts: number; now: number }
  | { t: "bye"; code: ByeCode; message?: string };

/** Message scheduling classes (spec 03 §3.5). */
export type Priority = 0 | 1 | 2;

export class ChannelRequestError extends Error {
  readonly code: ChannelErrorCode;
  readonly retryable: boolean;
  readonly data?: unknown;

  constructor(error: ChannelError) {
    super(error.message);
    this.code = error.code;
    this.retryable = error.retryable;
    this.data = error.data;
  }
}

/** The Noise prologue binds the channel to one host identity. */
export function channelPrologue(environmentId: string): string {
  return `monocode/channel/1\0${environmentId}`;
}
