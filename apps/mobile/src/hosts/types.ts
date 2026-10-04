import type { Endpoint, Welcome } from "@monocode/channel";

/** A paired host, as the phone remembers it (12 §12.6). No secrets: the
 * device key and handshake counter live in the Keychain. */
export type HostRecord = {
  env: string;
  label: string;
  color: string;
  hostName: string;
  platform: string;
  fingerprint: string;
  /** The host's static key, pinned at pairing (base64url). */
  hostKey: string;
  deviceId: string;
  role: "admin" | "member";
  endpoints: Endpoint[];
  pairedAt: number;
  lastOnlineAt?: number;
  lastWelcome?: Pick<Welcome, "host" | "capabilities" | "providers" | "limits">;
  /** The in-app demo machine (12 §12.13). */
  demo?: boolean;
};

export type HostConnState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "online"; endpoint: string; via: Endpoint["kind"]; rttMs: number; since: number }
  | { kind: "reconnecting"; since: number }
  | { kind: "offline"; reason: "no_network" | "host_unreachable" | "timeout"; retryAt: number; lastOnlineAt?: number }
  | {
      kind: "blocked";
      reason: "device_revoked" | "unknown_device" | "host_identity_changed" | "protocol_incompatible";
    };
