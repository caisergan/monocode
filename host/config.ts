// `config.json` (spec 09 §9.3): how phones reach this host.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writePrivateFile } from "./keys";

export type DirectMode = "off" | "private" | "all";

export type HostConfig = {
  v: 1;
  direct: { mode: DirectMode; port: number; advertise: { addr: string; port: number }[] };
  relay: { enabled: boolean; url: string; roomId: string };
  push: { enabled: boolean; allowPrivateGateways: boolean };
  pairing: { requireConfirmation: boolean; defaultTtlSeconds: number; linkBase: string };
  power: { preventIdleSleepWhileRunning: boolean };
};

export const DEFAULT_DIRECT_PORT = 3775;
/** Personal-track default. The official track uses https://usemono.dev/pair. */
export const DEFAULT_LINK_BASE = "monocode-dev://pair";

export function defaultConfig(): HostConfig {
  return {
    v: 1,
    direct: { mode: "private", port: DEFAULT_DIRECT_PORT, advertise: [] },
    relay: { enabled: false, url: "wss://relay.usemono.dev", roomId: randomBytes(16).toString("base64url") },
    push: { enabled: true, allowPrivateGateways: false },
    pairing: { requireConfirmation: true, defaultTtlSeconds: 600, linkBase: DEFAULT_LINK_BASE },
    power: { preventIdleSleepWhileRunning: true },
  };
}

export function validateConfig(value: HostConfig, rpcPort: number): HostConfig {
  const { direct, pairing, relay } = value;
  if (!["off", "private", "all"].includes(direct.mode)) throw new Error("Invalid direct mode");
  if (!Number.isInteger(direct.port) || direct.port < 1024 || direct.port > 65_535 || direct.port === rpcPort)
    throw new Error("Direct port must be 1024-65535 and differ from the RPC port");
  if (!Array.isArray(direct.advertise) || direct.advertise.length > 4)
    throw new Error("At most 4 advertised addresses");
  if (!/^(https:\/\/.+|monocode(-dev)?:\/\/.*)\/?pair$/.test(pairing.linkBase))
    throw new Error("Pairing links must be https://…/pair or monocode-dev://pair");
  if (!(relay.url.startsWith("wss://") || /^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(relay.url)))
    throw new Error("Relay URL must use wss://");
  if (pairing.defaultTtlSeconds < 60 || pairing.defaultTtlSeconds > 1_800)
    throw new Error("Pairing TTL must be 60-1800 seconds");
  return value;
}

/** Loads config.json, creating it with defaults on first start. Unknown or
 * missing fields fall back to defaults, so older files keep working. */
export function loadConfig(directory: string, rpcPort: number): HostConfig {
  const path = join(directory, "config.json");
  const defaults = defaultConfig();
  if (!existsSync(path)) {
    writePrivateFile(path, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HostConfig>;
  return validateConfig(
    {
      v: 1,
      direct: { ...defaults.direct, ...raw.direct },
      relay: { ...defaults.relay, ...raw.relay },
      push: { ...defaults.push, ...raw.push },
      pairing: { ...defaults.pairing, ...raw.pairing },
      power: { ...defaults.power, ...raw.power },
    },
    rpcPort,
  );
}

export function saveConfig(directory: string, config: HostConfig): void {
  writePrivateFile(join(directory, "config.json"), JSON.stringify(config, null, 2));
}
