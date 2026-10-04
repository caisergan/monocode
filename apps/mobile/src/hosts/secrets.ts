// Keychain storage (03 §3.3, 12 §12.6). After-first-unlock, this device only:
// out of iCloud and backups, and usable while the phone is locked.

import * as SecureStore from "expo-secure-store";
import { fromBase64Url, keyPairFromSecret, toBase64Url, type KeyPair } from "@monocode/channel";
import type { HostRecord } from "./types";

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
const INDEX = "mc.hosts";
const safe = (env: string) => env.replace(/[^A-Za-z0-9._-]/g, "_");

export async function loadHostRecords(): Promise<HostRecord[]> {
  const index = JSON.parse((await SecureStore.getItemAsync(INDEX, options)) ?? "[]") as string[];
  const records: HostRecord[] = [];
  for (const env of index) {
    const raw = await SecureStore.getItemAsync(`mc.host.${safe(env)}.record`, options);
    if (raw) records.push(JSON.parse(raw) as HostRecord);
  }
  return records;
}

export async function saveHostRecord(record: HostRecord): Promise<void> {
  await SecureStore.setItemAsync(`mc.host.${safe(record.env)}.record`, JSON.stringify(record), options);
  const index = JSON.parse((await SecureStore.getItemAsync(INDEX, options)) ?? "[]") as string[];
  if (!index.includes(record.env)) {
    index.push(record.env);
    await SecureStore.setItemAsync(INDEX, JSON.stringify(index), options);
  }
}

export async function deleteHost(env: string): Promise<void> {
  const index = (JSON.parse((await SecureStore.getItemAsync(INDEX, options)) ?? "[]") as string[]).filter(
    (item) => item !== env,
  );
  await SecureStore.setItemAsync(INDEX, JSON.stringify(index), options);
  for (const key of ["record", "deviceKey", "counter"])
    await SecureStore.deleteItemAsync(`mc.host.${safe(env)}.${key}`, options);
}

export async function saveDeviceKey(env: string, key: KeyPair): Promise<void> {
  await SecureStore.setItemAsync(`mc.host.${safe(env)}.deviceKey`, toBase64Url(key.secretKey), options);
}

export async function loadDeviceKey(env: string): Promise<KeyPair | undefined> {
  const raw = await SecureStore.getItemAsync(`mc.host.${safe(env)}.deviceKey`, options);
  return raw ? keyPairFromSecret(fromBase64Url(raw)) : undefined;
}

/** The handshake counter: written before every attempt (03 §3.4). */
export class HandshakeCounter {
  private value = 0;
  private loaded = false;

  constructor(private readonly env: string) {}

  async next(): Promise<number> {
    if (!this.loaded) {
      this.value = Number((await SecureStore.getItemAsync(`mc.host.${safe(this.env)}.counter`, options)) ?? "0") || 0;
      this.loaded = true;
    }
    this.value += 1;
    await SecureStore.setItemAsync(`mc.host.${safe(this.env)}.counter`, String(this.value), options);
    return this.value;
  }
}
