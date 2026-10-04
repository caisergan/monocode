import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Device } from "@monocode/core/wire";

export type Role = "admin" | "member";
export type DeviceKind = "desktop" | "mobile";
export type Via = "http" | "direct" | "relay";

/** Who is calling: a desktop token or a phone's Noise static key. */
export type Principal = { deviceId: string; role: Role; kind: DeviceKind; name: string };

type Row = {
  id: string;
  name: string;
  kind: DeviceKind;
  role: Role;
  status: "pending" | "active";
  token_hash: string | null;
  public_key: string | null;
  platform: string | null;
  model: string | null;
  os: string | null;
  app_version: string | null;
  created_at: number;
  last_seen_at: number | null;
  last_seen_via: Via | null;
  handshake_max: number;
  offer_id: string | null;
  push_json: string | null;
};

const REPLAY_WINDOW = 256;
const TOMBSTONE_DAYS = 30;
const MAX_EVENTS = 500;

/** Migration 1 (spec 09 §9.4): typed devices, tombstones, device events,
 * mutation receipts. Runs once, before anything reads the devices table. */
export function migrateDevices(db: DatabaseSync): void {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (version >= 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE devices_v2 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('desktop','mobile')),
        role TEXT NOT NULL CHECK (role IN ('admin','member')),
        status TEXT NOT NULL CHECK (status IN ('pending','active')),
        token_hash TEXT UNIQUE,
        public_key TEXT UNIQUE,
        platform TEXT, model TEXT, os TEXT, app_version TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        last_seen_via TEXT,
        handshake_max INTEGER NOT NULL DEFAULT 0,
        offer_id TEXT,
        push_json TEXT,
        push_registered_at INTEGER,
        CHECK ((kind = 'desktop' AND token_hash IS NOT NULL) OR (kind = 'mobile' AND public_key IS NOT NULL))
      );
      INSERT INTO devices_v2 (id, name, kind, role, status, token_hash, created_at)
        SELECT id, name, 'desktop', 'admin', 'active', hash, CAST(strftime('%s','now') AS INTEGER) * 1000
        FROM devices;
      DROP TABLE devices;
      ALTER TABLE devices_v2 RENAME TO devices;
      CREATE TABLE device_tombstones (
        public_key_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL,
        revoked_at INTEGER NOT NULL, revoked_by TEXT
      );
      CREATE TABLE device_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        device_id TEXT, type TEXT NOT NULL, detail TEXT
      );
      CREATE TABLE mutation_receipts (
        key TEXT PRIMARY KEY, device_id TEXT NOT NULL, method TEXT NOT NULL,
        params_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class DeviceStore {
  /** Recently accepted handshake counters per device (memory only). */
  private recent = new Map<string, Set<number>>();
  /** Last `touch` write per device; the desktop polls several times a second. */
  private touched = new Map<string, number>();

  constructor(private readonly db: DatabaseSync) {}

  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE id=?").get(id) as Row | undefined;
  }

  issueDesktop(name: string): { id: string; token: string } {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO devices (id, name, kind, role, status, token_hash, created_at) VALUES (?, ?, 'desktop', 'admin', 'active', ?, ?)",
      )
      .run(id, name, sha256(token), Date.now());
    this.event(id, "paired", "desktop");
    return { id, token };
  }

  byToken(token: string): Principal | undefined {
    const row = this.db
      .prepare("SELECT * FROM devices WHERE token_hash=? AND status='active'")
      .get(sha256(token)) as Row | undefined;
    return row ? principal(row) : undefined;
  }

  revokeToken(token: string): boolean {
    const row = this.db.prepare("SELECT id FROM devices WHERE token_hash=?").get(sha256(token)) as
      | { id: string }
      | undefined;
    return row ? this.revoke(row.id, row.id) : false;
  }

  /** Deletes the device. A phone's key is tombstoned so a later handshake gets
   * `device_revoked` instead of `unknown_device`. */
  revoke(id: string, by?: string): boolean {
    const row = this.row(id);
    if (!row) return false;
    this.db.prepare("DELETE FROM devices WHERE id=?").run(id);
    if (row.public_key)
      this.db
        .prepare("INSERT OR REPLACE INTO device_tombstones VALUES (?, ?, ?, ?)")
        .run(sha256(row.public_key), id, Date.now(), by ?? null);
    this.recent.delete(id);
    this.event(id, "revoked", by ? `by ${by.slice(0, 6)}` : undefined);
    return true;
  }

  addMobile(input: {
    name: string;
    publicKey: string;
    platform: string;
    model?: string;
    os?: string;
    appVersion?: string;
    offerId: string;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO devices (id, name, kind, role, status, public_key, platform, model, os, app_version, created_at, offer_id)
         VALUES (?, ?, 'mobile', 'member', 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.publicKey,
        input.platform,
        input.model ?? null,
        input.os ?? null,
        input.appVersion ?? null,
        Date.now(),
        input.offerId,
      );
    this.event(id, "claimed", input.platform);
    return id;
  }

  activate(id: string): void {
    this.db.prepare("UPDATE devices SET status='active' WHERE id=?").run(id);
    this.event(id, "approved");
  }

  /** Drops a pending device that was denied or expired. No tombstone. */
  discardPending(id: string, reason: string): void {
    this.db.prepare("DELETE FROM devices WHERE id=? AND status='pending'").run(id);
    this.event(id, reason);
  }

  byPublicKey(publicKey: string):
    | (Principal & { status: "pending" | "active"; handshakeMax: number })
    | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE public_key=?").get(publicKey) as
      | Row
      | undefined;
    return row ? { ...principal(row), status: row.status, handshakeMax: row.handshake_max } : undefined;
  }

  tombstoned(publicKey: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM device_tombstones WHERE public_key_hash=?")
      .get(sha256(publicKey));
  }

  /** Spec 03 §3.4 step 5: reject reused or very old counters. Racing
   * transports send several values, so strict ordering is not required. */
  acceptHandshake(id: string, n: number): boolean {
    const row = this.row(id);
    if (!row || !Number.isSafeInteger(n) || n < 1) return false;
    const seen = this.recent.get(id) ?? new Set<number>();
    if (seen.has(n) || n <= row.handshake_max - REPLAY_WINDOW) return false;
    seen.add(n);
    if (seen.size > REPLAY_WINDOW) seen.delete(seen.values().next().value!);
    this.recent.set(id, seen);
    if (n > row.handshake_max)
      this.db.prepare("UPDATE devices SET handshake_max=? WHERE id=?").run(n, id);
    return true;
  }

  touch(id: string, via: Via, app?: { platform?: string; model?: string; os?: string; version?: string }): void {
    const now = Date.now();
    if (!app && now - (this.touched.get(id) ?? 0) < 60_000) return;
    this.touched.set(id, now);
    this.db
      .prepare(
        `UPDATE devices SET last_seen_at=?, last_seen_via=?,
           platform=COALESCE(?, platform), model=COALESCE(?, model), os=COALESCE(?, os), app_version=COALESCE(?, app_version)
         WHERE id=?`,
      )
      .run(Date.now(), via, app?.platform ?? null, app?.model ?? null, app?.os ?? null, app?.version ?? null, id);
  }

  list(current?: string): Device[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY created_at").all() as Row[]).map(
      (row) => device(row, current),
    );
  }

  get(id: string, current?: string): Device | undefined {
    const row = this.row(id);
    return row ? device(row, current) : undefined;
  }

  rename(id: string, name: string): Device {
    const clean = name.trim();
    if (!clean || clean.length > 64 || clean.includes("\0")) throw new Error("Invalid device name");
    if (!Number(this.db.prepare("UPDATE devices SET name=? WHERE id=?").run(clean, id).changes))
      throw new Error("Device not found");
    this.event(id, "renamed");
    return this.get(id)!;
  }

  event(deviceId: string | undefined, type: string, detail?: string): void {
    this.db
      .prepare("INSERT INTO device_events (at, device_id, type, detail) VALUES (?, ?, ?, ?)")
      .run(Date.now(), deviceId ?? null, type, detail ?? null);
  }

  events(limit = 100): { at: number; deviceId?: string; type: string; detail?: string }[] {
    return (
      this.db
        .prepare("SELECT at, device_id, type, detail FROM device_events ORDER BY id DESC LIMIT ?")
        .all(Math.max(1, Math.min(MAX_EVENTS, limit))) as {
        at: number;
        device_id: string | null;
        type: string;
        detail: string | null;
      }[]
    ).map((row) => ({
      at: row.at,
      ...(row.device_id ? { deviceId: row.device_id } : {}),
      type: row.type,
      ...(row.detail ? { detail: row.detail } : {}),
    }));
  }

  housekeeping(now = Date.now()): void {
    this.db
      .prepare("DELETE FROM device_tombstones WHERE revoked_at < ?")
      .run(now - TOMBSTONE_DAYS * 86_400_000);
    this.db
      .prepare(
        "DELETE FROM device_events WHERE id <= (SELECT id FROM device_events ORDER BY id DESC LIMIT 1 OFFSET ?)",
      )
      .run(MAX_EVENTS);
    this.db.prepare("DELETE FROM mutation_receipts WHERE created_at < ?").run(now - 86_400_000);
  }
}

function principal(row: Row): Principal {
  return { deviceId: row.id, role: row.role, kind: row.kind, name: row.name };
}

function device(row: Row, current?: string): Device {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    status: row.status,
    ...(row.platform ? { platform: row.platform } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.app_version ? { appVersion: row.app_version } : {}),
    createdAt: row.created_at,
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    ...(row.last_seen_via ? { lastSeenVia: row.last_seen_via } : {}),
    current: row.id === current,
    push: !!row.push_json,
  };
}
