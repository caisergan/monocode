// Opens the encrypted cache (12 §12.6): `monocode.db`, SQLCipher with a
// 32-byte key from the Keychain (`mc.cache.dbKey`), WAL, then migrations.
// Without a cache the app still works; screens just wait for the host.

import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { CacheRepo } from "./repo";
import { migrate } from "./schema";
import { serialSql, type SqlDriver } from "./sql";

const DB_NAME = "monocode.db";
const KEY_NAME = "mc.cache.dbKey";
const keychain: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

async function cacheKey(): Promise<{ hex: string; created: boolean }> {
  const stored = await SecureStore.getItemAsync(KEY_NAME, keychain);
  if (stored && /^[0-9a-f]{64}$/.test(stored)) return { hex: stored, created: false };
  const hex = Array.from(getRandomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await SecureStore.setItemAsync(KEY_NAME, hex, keychain);
  return { hex, created: true };
}

async function openKeyed(hex: string): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(DB_NAME);
  try {
    // A raw 256-bit key: SQLCipher skips its passphrase derivation.
    await db.execAsync(`PRAGMA key = "x'${hex}'"`);
    // The first read fails when the key doesn't open the file.
    await db.getFirstAsync("SELECT count(*) FROM sqlite_master");
    await db.execAsync("PRAGMA journal_mode = WAL");
    return db;
  } catch (error) {
    await db.closeAsync().catch(() => undefined);
    throw error;
  }
}

function driver(db: SQLiteDatabase): SqlDriver {
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params) => ({ changes: (await db.runAsync(sql, params)).changes }),
    all: (sql, params) => db.getAllAsync(sql, params),
  };
}

let opening: Promise<CacheRepo | undefined> | undefined;

/** The cache, opened once. Undefined if it can't be opened. */
export function openCache(): Promise<CacheRepo | undefined> {
  opening ??= (async () => {
    try {
      const key = await cacheKey();
      // A new key can't read a file written under a lost one.
      if (key.created) await deleteDatabaseAsync(DB_NAME).catch(() => undefined);
      let db: SQLiteDatabase;
      try {
        db = await openKeyed(key.hex);
      } catch {
        // The key no longer opens the file (for example a restored phone):
        // start empty. Queued commands are lost with it.
        await deleteDatabaseAsync(DB_NAME).catch(() => undefined);
        db = await openKeyed(key.hex);
      }
      const sql = serialSql(driver(db));
      const result = await migrate(sql);
      if (result.reset) console.warn(`Cache rebuilt: ${result.error}`);
      return new CacheRepo(sql);
    } catch (error) {
      console.warn("Cache unavailable", error);
      return undefined;
    }
  })();
  return opening;
}
