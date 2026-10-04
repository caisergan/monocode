// Paired hosts and their runtimes. Created at startup from the Keychain,
// outside React; screens read the stores and call runtimes directly. The
// Agents data paints from the cache, then refreshes (12 §12.7).

import { randomUUID } from "expo-crypto";
import { AppState } from "react-native";
import { compareInboxItems } from "@monocode/core/summary";
import type { KeyPair } from "@monocode/channel";
import { HostRuntime } from "./runtime";
import { generateKeyPair } from "@monocode/channel";
import { DEMO_ENV, demoRecord } from "@/demo/demoHost";
import { runMutation } from "@/outbox/mutate";
import { openCache } from "@/storage/cache";
import { deleteHost, loadDeviceKey, loadHostRecords, saveDeviceKey, saveHostRecord } from "./secrets";
import { useAgents, useHosts, type AgentRow } from "./store";
import type { HostRecord } from "./types";

const runtimes = new Map<string, HostRuntime>();
let started: Promise<void> | undefined;

export function runtime(env: string): HostRuntime | undefined {
  return runtimes.get(env);
}

export function allRuntimes(): HostRuntime[] {
  return [...runtimes.values()];
}

function mergeAgents(): void {
  const items: AgentRow[] = [];
  for (const host of runtimes.values())
    for (const item of host.inbox?.items ?? []) items.push({ ...item, env: host.env, hostLabel: host.record.label });
  items.sort(compareInboxItems);
  useAgents.setState({
    items,
    needsInput: items.filter((item) => item.needsInput).length,
    cached: [...runtimes.values()].some((host) => host.inboxCached),
  });
}

function publishHosts(): void {
  useHosts.setState({
    loaded: true,
    records: [...runtimes.values()].map((host) => host.record),
    states: Object.fromEntries([...runtimes.values()].map((host) => [host.env, host.state])),
  });
}

function add(record: HostRecord, key: KeyPair): HostRuntime {
  runtimes.get(record.env)?.dispose();
  const host = new HostRuntime(record, key);
  host.subscribe((event) => {
    if (event.type === "state") publishHosts();
    if (event.type === "inbox") {
      mergeAgents();
      // The demo machine is never persisted.
      if (!event.cached && !host.record.demo)
        void openCache().then((cache) => cache?.saveInbox(host.env, event.inbox).catch(() => undefined));
    }
  });
  runtimes.set(record.env, host);
  return host;
}

export function startHosts(): Promise<void> {
  started ??= (async () => {
    for (const record of await loadHostRecords()) {
      const key = await loadDeviceKey(record.env);
      if (key) add(record, key);
    }
    publishHosts();
    for (const host of runtimes.values()) host.connect();
    void restoreCache();
    AppState.addEventListener("change", (state) => {
      for (const host of runtimes.values()) {
        if (state === "active") host.onForeground();
        else if (state === "background") host.onBackground();
      }
    });
  })();
  return started;
}

/** Drops cache rows of hosts that are gone, then paints each host's last
 * inbox until its first fetch arrives. */
async function restoreCache(): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  const paired = [...runtimes.values()].filter((host) => !host.record.demo).map((host) => host.env);
  await cache.purgeHostsExcept(paired).catch(() => undefined);
  for (const host of runtimes.values()) {
    if (host.record.demo) continue;
    const cached = await cache.loadInbox(host.env).catch(() => undefined);
    if (cached) host.seedInbox(cached.inbox);
  }
}

/** Called when pairing finishes: remember the host and connect. */
export async function addPairedHost(record: HostRecord, key: KeyPair): Promise<HostRuntime> {
  await saveDeviceKey(record.env, key);
  await saveHostRecord(record);
  const host = add(record, key);
  publishHosts();
  host.connect();
  return host;
}

/** The in-app demo machine: never persisted, gone on restart. */
export function addDemoHost(): HostRuntime {
  const existing = runtimes.get(DEMO_ENV);
  if (existing) return existing;
  const host = add(demoRecord(), generateKeyPair());
  publishHosts();
  host.connect();
  return host;
}

export async function removeHost(env: string): Promise<void> {
  const host = runtimes.get(env);
  if (host?.record.demo) {
    host.dispose();
    runtimes.delete(env);
    publishHosts();
    mergeAgents();
    return;
  }
  if (host) {
    // One keyed try: removal never waits on an unreachable machine.
    await runMutation({
      idempotent: host.has("mutations.idempotent"),
      request: (key) => host.request("devices.revokeSelf", {}, 5_000, { key }),
      newKey: randomUUID,
      retryForMs: 0,
    }).catch(() => undefined);
    host.dispose();
    runtimes.delete(env);
  }
  await deleteHost(env);
  await openCache().then((cache) => cache?.purgeHost(env).catch(() => undefined));
  publishHosts();
  mergeAgents();
}
