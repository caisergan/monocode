// Opening a channel to a host (05 §5.5): direct candidates raced
// happy-eyeballs style, the first valid welcome wins, the rest are closed.

import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import {
  HandshakeFailure,
  openChannel,
  openWebSocket,
  type Channel,
  type Endpoint,
  type Hello,
  type KeyPair,
  type PairingWelcome,
  type WebSocketLike,
  type Welcome,
} from "@monocode/channel";
import { REMOTE_PROVIDERS } from "@monocode/core/session";

const OPEN_TIMEOUT_MS = 2_500;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const STAGGER_MS = 200;
const OVERALL_MS = 20_000;

export type Candidate = { key: string; url: string; endpoint: Endpoint; label: string };

export function candidates(endpoints: Endpoint[], preferred?: string): Candidate[] {
  const out: Candidate[] = [];
  const url = (addr: string, port: number) =>
    `ws://${addr.includes(":") ? `[${addr}]` : addr}:${port}/v1/channel`;
  for (const endpoint of endpoints) {
    out.push({
      key: `${endpoint.kind}|${endpoint.addr}|${endpoint.port}`,
      url: url(endpoint.addr, endpoint.port),
      endpoint,
      label: endpoint.kind === "lan" ? "Wi-Fi" : endpoint.kind === "tailscale" ? "Tailscale" : endpoint.addr,
    });
    // iOS may not resolve MagicDNS without the VPN, so the name comes second.
    if (endpoint.kind === "tailscale" && endpoint.dns)
      out.push({
        key: `tailscale|${endpoint.dns}|${endpoint.port}`,
        url: url(endpoint.dns, endpoint.port),
        endpoint,
        label: "Tailscale",
      });
  }
  const rank = (candidate: Candidate) =>
    candidate.key === preferred ? -1 : candidate.endpoint.kind === "lan" ? (candidate.endpoint.addr.includes(":") ? 1 : 0) : candidate.endpoint.kind === "tailscale" ? (candidate.url.includes(".ts.net") ? 3 : 2) : 4;
  return out.sort((a, b) => rank(a) - rank(b));
}

export function appInfo(): Hello["app"] {
  return {
    name: "MonoCode",
    version: Constants.expoConfig?.version ?? "0.1.0",
    build: String(Constants.expoConfig?.ios?.buildNumber ?? "1"),
    platform: Platform.OS === "android" ? "android" : "ios",
    os: String(Device.osVersion ?? Platform.Version),
    ...(Device.modelId ? { model: String(Device.modelId) } : {}),
  };
}

export function hello(env: string, n: number, pair?: string): Hello {
  return {
    v: 1,
    env,
    n,
    channel: { min: 1, max: 1 },
    app: appInfo(),
    caps: ["deflate", "windowedSync", "truncatedBlocks"],
    providers: [...REMOTE_PROVIDERS],
    presence: { visible: true },
    ...(pair ? { pair: { offer: pair } } : {}),
  };
}

export type Connected = {
  channel: Channel;
  reply: Welcome | PairingWelcome;
  candidate: Candidate;
  rttMs: number;
};

export type AttemptLog = { candidate: string; result: string; ms: number };

/** Races the candidates. Rejects with the most telling failure: an
 * authenticated handshake error stops the race at once. */
export function race(options: {
  env: string;
  hostKey: string;
  deviceKey: KeyPair;
  endpoints: Endpoint[];
  preferred?: string;
  nextCounter: () => Promise<number>;
  pairOffer?: string;
  log?: (entry: AttemptLog) => void;
}): Promise<Connected> {
  const list = candidates(options.endpoints, options.preferred);
  return new Promise((resolve, reject) => {
    if (!list.length) {
      reject(new Error("This computer has no reachable address"));
      return;
    }
    let settled = false;
    let remaining = list.length;
    let lastError: Error = new Error("Can't reach the computer");
    const winners: Connected[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const overall = setTimeout(() => finish(new Error("Can't reach the computer")), OVERALL_MS);
    const finish = (error?: Error, won?: Connected) => {
      if (settled) {
        if (won) won.channel.sayBye("replaced");
        return;
      }
      settled = true;
      clearTimeout(overall);
      timers.forEach(clearTimeout);
      if (won) resolve(won);
      else reject(error ?? lastError);
    };
    list.forEach((candidate, index) => {
      timers.push(
        setTimeout(async () => {
          if (settled) return;
          const started = Date.now();
          try {
            const socket = await openWebSocket(() => new WebSocket(candidate.url) as unknown as WebSocketLike, {
              timeoutMs: OPEN_TIMEOUT_MS,
            });
            if (settled) {
              socket.close(1000, "replaced");
              return;
            }
            const n = options.pairOffer ? 0 : await options.nextCounter();
            const { channel, reply } = await openChannel(socket, {
              env: options.env,
              hostKey: options.hostKey,
              deviceKey: options.deviceKey,
              hello: hello(options.env, n, options.pairOffer),
              timeoutMs: HANDSHAKE_TIMEOUT_MS,
            });
            const rttMs = Date.now() - started;
            options.log?.({ candidate: candidate.key, result: "won", ms: rttMs });
            const won = { channel, reply, candidate, rttMs };
            winners.push(won);
            finish(undefined, won);
          } catch (error) {
            const failure = error as Error;
            options.log?.({ candidate: candidate.key, result: failure.message, ms: Date.now() - started });
            if (failure instanceof HandshakeFailure && failure.authenticated) {
              finish(failure);
              return;
            }
            if (!(lastError instanceof HandshakeFailure)) lastError = failure;
            remaining -= 1;
            if (remaining === 0) finish(lastError);
          }
        }, index * STAGGER_MS),
      );
    });
  });
}
