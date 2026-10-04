// `config.json` (spec 09 §9.3): how phones reach this host.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { HostConfigView } from "@monocode/core/wire";
import { writePrivateFile } from "./keys";
import { HostError } from "./errors";
import type { MethodSpec } from "./rpc";

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

const invalid = (message: string) => new HostError("invalid_params", message);

/** `wss:` anywhere; `ws:` only to this machine, for tests. */
function relayUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "wss:") return !!url.hostname;
  return url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function linkBaseAllowed(value: string): boolean {
  if (value.length > 512 || !/^(https:\/\/.+|monocode(-dev)?:\/\/.*)\/?pair$/.test(value)) return false;
  try {
    return new URL(value).protocol !== "https:" || !!new URL(value).hostname;
  } catch {
    return false;
  }
}

const advertiseAllowed = (entry: unknown) => {
  const { addr, port, ...rest } = (entry ?? {}) as Record<string, unknown>;
  return (
    !!entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    !Object.keys(rest).length &&
    typeof addr === "string" &&
    /^[A-Za-z0-9.:_-]{1,253}$/.test(addr) &&
    Number.isInteger(port) &&
    Number(port) >= 1 &&
    Number(port) <= 65_535
  );
};

export function validateConfig(value: HostConfig, rpcPort: number): HostConfig {
  const { direct, pairing, relay, push, power } = value;
  if (!["off", "private", "all"].includes(direct.mode)) throw invalid("Invalid direct mode");
  if (!Number.isInteger(direct.port) || direct.port < 1024 || direct.port > 65_535 || direct.port === rpcPort)
    throw invalid("Invalid direct port: use 1024-65535, different from the RPC port");
  if (!Array.isArray(direct.advertise) || direct.advertise.length > 4)
    throw invalid("Invalid advertised addresses: at most 4");
  if (!direct.advertise.every(advertiseAllowed))
    throw invalid("Invalid advertised address: use {addr, port}");
  if (typeof pairing.linkBase !== "string" || !linkBaseAllowed(pairing.linkBase))
    throw invalid("Invalid pairing link base: use https://…/pair or monocode-dev://pair");
  if (typeof relay.url !== "string" || !relayUrlAllowed(relay.url))
    throw invalid("Invalid relay URL: use wss://");
  if (typeof relay.roomId !== "string" || !relay.roomId) throw invalid("Invalid relay room");
  if (
    !Number.isInteger(pairing.defaultTtlSeconds) ||
    pairing.defaultTtlSeconds < 60 ||
    pairing.defaultTtlSeconds > 1_800
  )
    throw invalid("Invalid pairing TTL: use 60-1800 seconds");
  for (const [label, flag] of [
    ["relay.enabled", relay.enabled],
    ["push.enabled", push.enabled],
    ["push.allowPrivateGateways", push.allowPrivateGateways],
    ["pairing.requireConfirmation", pairing.requireConfirmation],
    ["power.preventIdleSleepWhileRunning", power.preventIdleSleepWhileRunning],
  ] as const)
    if (typeof flag !== "boolean") throw invalid(`Invalid ${label}: use true or false`);
  return value;
}

/** Reads config.json without creating it. Unknown or missing fields fall back
 * to defaults, so older files keep working. Throws when the file is invalid. */
export function readConfig(directory: string, rpcPort: number): HostConfig | undefined {
  const path = join(directory, "config.json");
  if (!existsSync(path)) return undefined;
  const defaults = defaultConfig();
  let raw: Partial<HostConfig>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HostConfig>;
  } catch {
    throw invalid("Invalid config.json: not readable JSON");
  }
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

/** Loads config.json, creating it with defaults on first start. */
export function loadConfig(directory: string, rpcPort: number): HostConfig {
  const existing = readConfig(directory, rpcPort);
  if (existing) return existing;
  const defaults = defaultConfig();
  writePrivateFile(join(directory, "config.json"), JSON.stringify(defaults, null, 2));
  return defaults;
}

export function saveConfig(directory: string, config: HostConfig): void {
  writePrivateFile(join(directory, "config.json"), JSON.stringify(config, null, 2));
}

const PATCH_KEYS: Record<string, string[]> = {
  relay: ["enabled", "url"],
  direct: ["mode", "port", "advertise"],
  push: ["enabled", "allowPrivateGateways"],
  pairing: ["requireConfirmation", "linkBase"],
};

/** Applies a `host.config.set` patch (spec 06 §6.5 `HostConfigPatch`). Only
 * the listed fields can change; everything is validated before anything is. */
export function applyConfigPatch(config: HostConfig, patch: unknown, rpcPort: number): HostConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("Invalid settings");
  const next = structuredClone(config);
  for (const [section, value] of Object.entries(patch)) {
    const allowed = PATCH_KEYS[section];
    if (!allowed) throw invalid(`Invalid setting: ${section}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`Invalid setting: ${section}`);
    for (const [key, item] of Object.entries(value)) {
      if (!allowed.includes(key)) throw invalid(`Invalid setting: ${section}.${key}`);
      if (item === undefined) continue;
      (next as unknown as Record<string, Record<string, unknown>>)[section][key] =
        key === "advertise" && Array.isArray(item) ? item.map((entry) => ({ ...entry })) : item;
    }
  }
  return validateConfig(next, rpcPort);
}

export function configView(config: HostConfig, listening: string[]): HostConfigView {
  return {
    // This build has no relay client yet, so an enabled relay can't be online.
    relay: { enabled: config.relay.enabled, url: config.relay.url, status: config.relay.enabled ? "error" : "disabled" },
    direct: {
      mode: config.direct.mode,
      port: config.direct.port,
      listening,
      advertise: config.direct.advertise.map((entry) => ({ ...entry })),
    },
    push: { ...config.push },
    pairing: { requireConfirmation: config.pairing.requireConfirmation, linkBase: config.pairing.linkBase },
  };
}

type ConfigListener = (config: HostConfig, previous: HostConfig) => void | Promise<void>;

/** The live config. Writers: `host.config.set`, `/lifecycle reload`. Each
 * change is saved atomically, then announced (`config.changed`). */
export class HostConfigStore {
  private value: HostConfig;
  private listeners = new Set<ConfigListener>();

  constructor(
    readonly directory: string,
    readonly rpcPort: number,
  ) {
    this.value = loadConfig(directory, rpcPort);
  }

  get current(): HostConfig {
    return this.value;
  }

  onChanged(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once listeners have applied the change (listeners rebound). */
  async set(patch: unknown): Promise<HostConfig> {
    return this.replace(applyConfigPatch(this.value, patch, this.rpcPort), true);
  }

  /** Re-reads config.json after the CLI edited it. */
  async reload(): Promise<HostConfig> {
    return this.replace(loadConfig(this.directory, this.rpcPort), false);
  }

  private async replace(next: HostConfig, save: boolean): Promise<HostConfig> {
    const previous = this.value;
    if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
    if (save) saveConfig(this.directory, next);
    this.value = next;
    await Promise.all(
      [...this.listeners].map(async (listener) => {
        try {
          await listener(next, previous);
        } catch (error) {
          console.error("Config change listener failed:", error instanceof Error ? error.message : error);
        }
      }),
    );
    return next;
  }
}

/** `host.config.get` for any device, `host.config.set` for admins. */
export function hostConfigMethods(config: HostConfigStore, listening: () => string[]): Record<string, MethodSpec> {
  return {
    "host.config.get": {
      kind: "read",
      roles: ["admin", "member"],
      handler: () => configView(config.current, listening()),
    },
    "host.config.set": {
      kind: "mutating",
      roles: ["admin"],
      handler: async (params) => {
        await config.set(params);
        return configView(config.current, listening());
      },
    },
  };
}
