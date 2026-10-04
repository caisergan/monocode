# 9. Host changes

Everything here lands in `host/` (plus the shared packages). Existing behaviour is
unchanged unless stated: the HTTP `/rpc` API, the desktop's SSH setup, session
storage, and provider adapters.

## 9.1 New and changed modules

| Path | New / changed | Responsibility |
|---|---|---|
| `host/rpc.ts` | new | One dispatcher and method manifest for HTTP and channel (§9.2) |
| `host/errors.ts` | new | `HostError` and the message-to-code table ([06 §6.11](06-channel-protocol.md#611-errors)) |
| `host/server.ts` | changed | HTTP wrapper around `rpc.dispatch`; token → principal; adds `code` to error bodies; new admin methods (`pairing.*`, `devices.list`/`rename`/`revoke`/`events`, `host.config.*`, `presence.update`); `environment.describe` gains `hostVersion` |
| `host/keys.ts` | new | Load or create `keys.json`; fingerprint; rotation |
| `host/config.ts` | new | `config.json` schema, defaults, validation, atomic save, change events |
| `host/store.ts` | changed | Migrations, device v2 API, windowed sync, block paging, summary additions, inbox, change emitter, mutation receipts |
| `host/engine.ts` | changed | Observer hook, `finishedAt` and turn outcome, `create` with `initial`/`worktree`, queue commands, `HostError` |
| `host/pairing.ts` | new | In-memory offers, claims, decisions, codes |
| `host/channel/server.ts` | new | Direct listeners per address, upgrade handling, pre-auth limits |
| `host/channel/connection.ts` | new | One Noise channel: handshake, records, principal, requests, events, presence |
| `host/channel/watch.ts` | new | Watch state, per-session last-sent revisions, coalescing, backpressure |
| `host/channel/relay.ts` | new | Relay control socket and data sockets |
| `host/channel/endpoints.ts` | new | Interface scan, classification, Tailscale name |
| `host/attention.ts` | new | Transition detection and dedupe ([08 §8.2](08-notifications.md#82-attention-events)) |
| `host/presence.ts` | new | Presence map and queries |
| `host/push.ts` | new | Policy, sealing, batching, gateway client, target bookkeeping |
| `host/power.ts` | new | Keeps the machine awake while turns run (§9.10) |
| `host/cli.ts` | changed | New commands, extended lifecycle endpoint (§9.9) |
| `host/doctor.ts` | new | `monocode-host doctor` |

## 9.2 One dispatcher for HTTP and channel

Today `createHostServer` holds a large `switch` (`host/server.ts`). It moves into
`host/rpc.ts`:

```ts
type Principal = { deviceId: string; role: "admin" | "member"; kind: "desktop" | "mobile" };
type CallContext = {
  principal: Principal;
  transport: "http" | "direct" | "relay";
  channel?: ChannelConnection;          // for channel-only methods
  signal: AbortSignal;                  // cancel support
};
type MethodSpec = {
  kind: "read" | "mutating" | "command";
  roles: ("admin" | "member")[];
  capability?: string;                  // listed in welcome when available
  channelOnly?: boolean;                // watch.set, pair.claim
  bulk?: boolean;                       // P2 scheduling (03 §3.5)
  handler: (params: Record<string, unknown>, ctx: CallContext) => Promise<unknown>;
};
export const METHODS: Record<string, MethodSpec>;
export async function dispatch(method: string, params: unknown, ctx: CallContext): Promise<unknown>;
```

- **`dispatch` does, in order:**
  1. Look up the method. Unknown methods throw `method_not_found`.
  2. Check the role. Failure throws `forbidden`.
  3. If the method is `mutating` and the request carries `key`, wrap it in the
     mutation-receipt cache (§9.7).
  4. Call the handler.
  5. Map thrown errors to `HostError` ([06 §6.11](06-channel-protocol.md#611-errors)).
- **The HTTP path** keeps its checks (no `Origin`, POST `/rpc`, bearer token, protocol
  version, `environmentId`).
  - It builds a principal from the token's device row (`kind:desktop`,
    `role:admin`).
  - It returns `{result}` or `{error, code}`.
  - The desktop's Rust allow-list still decides what the desktop may call.
- **A contract test** checks that every `METHODS` entry has a role list, and that
  every method in the old `switch` still exists with the same result shape
  (`server.test.ts` fixtures).

## 9.3 Keys and config

**`keys.ts`:**
- Load or create `keys.json` ([03 §3.2](03-identity-and-crypto.md#32-host-keys)) with
  `@noble/curves`: `x25519.utils.randomPrivateKey()` and `ed25519.utils.randomPrivateKey()`.
- Write it atomically with mode 0600. On Windows, call `protectWindowsDirectory`.
- `fingerprint()` returns the grouped base32 string. `rotate()` implements
  `keys rotate`.

**`config.ts`**, `~/.monocode-host/config.json`, created with defaults on first
start:

```json
{
  "v": 1,
  "direct": { "mode": "private", "port": 3775, "advertise": [] },
  "relay": { "enabled": false, "url": "wss://relay.usemono.dev", "roomId": "<generated>" },
  "push": { "enabled": true, "allowPrivateGateways": false },
  "pairing": { "requireConfirmation": true, "defaultTtlSeconds": 600,
               "linkBase": "https://usemono.dev/pair" },
  "power": { "preventIdleSleepWhileRunning": true }
}
```

- **Validation:**
  - `port` must be 1024 to 65535 and differ from the RPC port.
  - `advertise` holds at most 4 entries.
  - `relay.url` must be `wss:`. `ws:` is allowed only when `relay.url` is loopback,
    for tests.
  - `pairing.linkBase` must be an `https:` URL or a `monocode:` / `monocode-dev:`
    scheme URL ending in `/pair`.
  - There is no push gateway setting. Each phone names its gateway when it
    registers ([08 §8.6](08-notifications.md#86-push-targets-and-registration)).
    `push.enabled: false` turns push off for every device.
- **Writers:** `host.config.set` (admin), the CLI through `/lifecycle reload`, and
  `keys rotate`.
- Changes emit `config.changed`. The channel server restarts listeners, the relay
  client reconnects or stops, and channels receive `evt host.config`.

## 9.4 Database migrations

The host DB adopts `PRAGMA user_version`. It is `0` today; the existing ad-hoc
`summary` column check stays as part of version 0. Migration 1 runs in one
`BEGIN IMMEDIATE` transaction at startup, before the engine starts:

```sql
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
PRAGMA user_version = 1;
```

- **Pairing offers are not stored.** They live in the server's memory (§9.5), so
  pairing secrets never touch disk. A host restart cancels open offers.
- **Housekeeping**, hourly:
  - delete `device_tombstones` older than 30 days;
  - keep the last 500 `device_events`;
  - delete `mutation_receipts` older than 24 h;
  - clear `push_json` where `push_registered_at` is older than 30 days.
- **`HostSession` gains optional fields**, persisted inside the existing snapshot
  JSON so no schema change is needed:
  - `finishedAt?: number`;
  - `lastTurnOutcome?: "finished" | "failed" | "interrupted" | "cancelled"`.
  `Session` already has `queuedMessages` and `queueStatus`.
- **Store API changes:**
  - `issueDevice(name)` writes a desktop admin device.
  - `authenticated(token)` becomes `deviceByToken(token): Principal | undefined`.
  - `revokeToken` and `revokeDevice` also write a `device_events` row.
  - New: `addMobileDevice`, `activateDevice`, `deviceByPublicKey`,
    `recordHandshake(deviceId, n)`, `touchDevice(deviceId, via)`, `listDevices`,
    `renameDevice`, `setPush`, `clearPush`, `tombstone(publicKey)`.
- **Downgrade.** An older host binary started on a migrated DB would fail on the
  missing `hash` column. Hosts are versioned with the desktop and updated forward
  only. `service install` refuses to install an older version over a newer
  `user_version`, with a clear message.

## 9.5 Pairing (`host/pairing.ts`)

```ts
class PairingManager {
  create(input: { createdBy: string; relay?: boolean; ttlSeconds?: number; label?: string }): Offer;
  status(offerId: string): PairingStatus;
  claim(offerId: string, proof: Uint8Array, h: Uint8Array, rs: Uint8Array, info: ClaimInfo): ClaimResult;
  decide(offerId: string, allow: boolean, by: string): PairingStatus;
  cancel(offerId: string): PairingStatus;
  on(event: "approved" | "denied" | "expired", cb): void;   // to notify the pairing channel
}
```

- **Offers** live in a `Map`, at most 8 open at once (oldest cancelled).
  - Each holds `{id, secret, status, expiresAt, createdBy, deviceId?, code?, failures}`.
  - A 1 s timer expires them.
- **`create`:**
  1. If `relay: true` and the relay is disabled, enable it in `config.json` first.
     The caller got consent.
  2. Compute endpoints, which must not be empty when the relay is off.
  3. Return the URL ([04 §4.2](04-pairing.md#42-the-offer)).
- **`claim`** follows [04 §4.6](04-pairing.md#46-host-offer-and-device-state-machine).
  It writes a `pending` device row and computes the 6-digit code from `h`.
- **`decide`** activates or deletes the device and emits the event. The channel
  layer turns that into `evt pair.status`.

## 9.6 Engine changes

- **Observer hook.** `HostStore.save(input, event)` already receives the event
  object. After the transaction commits it calls registered observers with
  `(previous, saved, event)`. `previous` is the value from `find()` before the save.
  Observers:
  - `attention.ts`;
  - `watch.ts`, through a `changed` emitter;
  - the inbox revision counter.
- **Turn outcome.** `settled()` sets `finishedAt = endedAt` and `lastTurnOutcome`:
  - `cancelled` when `active.cancelled`;
  - `failed` when an error message is present;
  - `interrupted` when the status is `interrupted`;
  - `finished` otherwise.
- **`create` with `worktree` and `initial`:**
  - `parseCommand` accepts the new optional fields ([06 §6.9](06-channel-protocol.md#69-commands)).
  - A new `commandAsync(raw)` handles creates that need a worktree:
    1. Check `receipts`. A stored receipt is returned as is.
    2. Check an in-memory `inflight: Map<commandId, Promise<CommandReceipt>>`.
    3. Run `createHostWorktree(project.cwd, branch = "mc/" + sha256(commandId).slice(0, 8),
       base, existing = <reuse if that branch and worktree already exist>)`.
    4. Run the synchronous `command()` path with `worktreeCwd` and
       `autoWorktreeBranch` set, and `initial` folded in. The saved value contains
       the session, its first user block (id = `commandId`) and `status:"running"`.
       The `effect` starts the turn.
  - `commands.dispatch` calls `commandAsync` when `worktree.mode === "new"`, and
    `command()` otherwise.
- **Queue commands** (`queue`, `unqueue`, `editQueued`, `steer`, `resumeQueue`):
  - Implemented in `command()` with the shared helpers from `messageQueue.ts`.
  - After `settled()` saves an idle result, the engine checks
    `canDispatchQueuedHead(session)`. If true, it dispatches the head through the same
    path as `send`, with `commandId = queued.id`.
  - An error, interruption, usage limit or cancel sets `queueStatus = "paused"`,
    except a cancel issued by `steer`, which keeps the queue active.
- **Errors.** Every `throw new Error("…")` in `engine.ts`, `store.ts`, `server.ts`
  and `workspace*.ts` that can reach a client becomes a `HostError` with a code. The
  fallback mapping table catches anything missed.

## 9.7 Store changes

- **`sync(id, revision?, window?, maxBlockChars?)`.** The windowed algorithm from
  [06 §6.7](06-channel-protocol.md#67-windowed-session-sync). Without `window` and
  `maxBlockChars` the output is byte-for-byte what it is today. A test pins that
  with the existing fixtures.
- **`blocks(id, before, turns, maxBlockChars)`** and **`block(id, blockId)`.**
- **Truncation helper.** `truncateBlock(block, max)` lives in `@monocode/core`, so
  it is covered by unit tests on its own.
- **`summary()`** adds:
  - `lastText`: the last assistant block's text, stripped with a shared
    `plainTextPreview` helper, 280 chars at most;
  - `finishedAt`;
  - `queueLength`.
- **`page(projectId, archived, limit, cursor)`** orders by
  `(pinned desc, updatedAt desc, id)`, matching `compareSessionSummaries`. The cursor
  is base64url JSON of the last row's sort key.
- **`inbox(limit)`** reads `id, project_id, summary` for all sessions, filters and
  sorts as in [06 §6.10](06-channel-protocol.md#610-inbox-semantics), and joins
  project names. It handles thousands of sessions within milliseconds, since
  summaries are cached JSON.
- **Mutation receipts.**
  - `withMutationReceipt(key, deviceId, method, params, run)` hashes the params
    (sha256 of canonical JSON).
  - A stored row is returned when the hash matches. A different hash throws
    `idempotency_conflict`.
  - In-flight duplicates share one in-memory promise.
  - The result is stored after success. Failures are not stored, so a retry runs
    again.
- **Change emitter.** `onChanged(cb)` is called with `{sessionId, projectId,
  revision, deleted?, summaryChanged}` after save, update and delete.

## 9.8 Channel modules

**`channel/server.ts`:**
- Owns one `http.Server` per bound address (private mode) or one on `::` (all mode).
  Each has an `upgrade` handler that accepts only `/v1/channel`, with no `Origin`.
- Pre-auth limits per remote IP, as in [05 §5.9](05-connectivity.md#59-limits-and-rate-limits).
- Rebinds when `endpoints.ts` reports a change.

**`channel/connection.ts`:**
- **States:** `handshake → pairing | device → closed`.
- **Handshake:** runs Noise IK as responder ([03 §3.4](03-identity-and-crypto.md#34-the-noise-channel))
  and applies the hello rules. On success it records the handshake counter and calls
  `touchDevice`.
- **Records:** reader and writer with P0/P1/P2 queues, plus deflate via `zlib`
  (`deflateRawSync` under 64 KiB, streaming above).
- **Requests:**
  - Parses envelopes and enforces `maxInFlight`.
  - Calls `rpc.dispatch` with an `AbortController` per request.
  - Handles `cancel`.
  - Sends `res` at P0 or P1, or P2 for `bulk` methods.
- **Channel-only methods:** `watch.set` and `pair.claim`. Presence from `ping` goes
  to `presence.ts`.
- **Lifecycle:**
  - Idle timeout 45 s.
  - Maximum lifetime 24 h (`bye rekey`).
  - When the device is revoked, `bye device_revoked`.
  - When the host stops, `bye host_stopping`.

**`channel/watch.ts`:**
- Holds `WatchState`, per-session `lastSent` and timers.
- Coalescing and backpressure follow [06 §6.6](06-channel-protocol.md#66-watch-and-events).
- Uses `ws.bufferedAmount`, and for the relay transport the data socket's buffered
  amount.

**`channel/relay.ts`:**
- The control socket implements [07 §7.3](07-relay-and-push-service.md#73-host-control-socket):
  signing, `ready`/`connect`/`disconnect`, backoff and status reporting.
- For each `connect` it opens a data socket and wraps it in a `ChannelConnection`
  with `transport:"relay"`.

**`channel/endpoints.ts`:** as in [05 §5.2](05-connectivity.md#52-endpoints).

## 9.9 CLI

New and changed commands (`monocode-host --help`):

```
pair --mobile [--name <label>] [--relay|--no-relay] [--ttl <minutes>] [--yes] [--json]
                          Pair a phone (shows a QR code; needs the running host)
pair --name <device> [--json]
                          Unchanged: issue a desktop credential
devices [--json]          List devices: id, name, kind, role, platform, paired, last seen (via)
rename-device <id> <name> Rename a device
revoke <device-id>        Revoke a device (closes its live connections)
relay enable [--url <wss-url>] [--yes] | relay disable | relay status
pairing link-base <url>   Set the base of pairing links (https://…/pair or monocode-dev://pair)
direct off|private|all [--port <port>] | direct status
endpoints                 Show the addresses phones will be offered
keys fingerprint          Print the host fingerprint
keys rotate --yes         New host and relay keys; revokes all phones
doctor [--json]           Check listener, firewall, relay, push gateway, keys, providers, disk
```

- **`/lifecycle` endpoint.** It gains the actions `reload`, `pairing.create`,
  `pairing.status`, `pairing.decide`, `pairing.cancel`, `devices.changed` and
  `config.changed`.
  - The body limit rises from 128 bytes to 4 KiB, and the body becomes
    `{action, params?}`.
  - It is still authenticated by the per-process secret in `running.json`, which the
    desktop never sees.
- **Commands that open the DB directly** (`devices`, `rename-device`, `revoke`) then
  POST `devices.changed` to `/lifecycle`. A running server closes any revoked
  channels at once.
- **QR rendering** uses the `qrcode` package's terminal renderer (UTF-8 half
  blocks), with an `--ascii` fallback when the locale isn't UTF-8.

## 9.10 Service, power and doctor

- **Service definitions** (`host/service.ts`) are unchanged. The host still runs
  `serve`, and the new listeners start inside it.
- **`power.ts`.** While any session is `running` and
  `power.preventIdleSleepWhileRunning` is on:
  - **macOS:** hold `caffeinate -i -w <host pid>`.
  - **Linux:** hold `systemd-inhibit --what=idle --why="MonoCode agents running" sleep infinity`.
  - The child is killed when the last turn settles.
  - This prevents idle sleep, not lid-close sleep. Windows support comes later.
- **`doctor`** checks each item and prints a fix for each failure:
  - host running, version, `user_version`;
  - key file permissions;
  - config validity;
  - listener addresses and whether a loopback connect to each succeeds;
  - OS firewall state ([05 §5.3](05-connectivity.md#53-the-hosts-direct-listener));
  - relay authentication (a real control handshake);
  - each push gateway in use by a registered target: `GET /v1/keys`;
  - clock skew against the relay's `Date` header;
  - provider binaries;
  - free disk space;
  - `PRAGMA quick_check`.

## 9.11 Dependencies and packaging

| Package | Use | Licence |
|---|---|---|
| `ws` | WebSocket server and client | MIT |
| `@noble/curves`, `@noble/ciphers`, `@noble/hashes` | Through `@monocode/channel` | MIT |
| `qrcode` | Terminal QR | MIT |

- All three are bundled by `host/build.mjs`. Their licences are appended to the
  archive's licence file by `host/package.mjs`.
- The package layout, release assets and SSH bootstrap are unchanged.
- The bundle grows by roughly 150 KiB.

## 9.12 Tests

| Area | Tests |
|---|---|
| Handshake | Success; wrong host key (REJECT); wrong `env`; unknown device; revoked (tombstone); pending; replay window, including two racing counters; channel version mismatch |
| Pairing | Approve; deny; expire before and after claim; reused offer; proof wrong ×3 cancels; approval while the phone is disconnected, then a later device handshake; `replacesDeviceId`; `requireConfirmation:false` |
| Records | Fragmentation and interleaving; out-of-order fragment ids; oversize messages; too many partials; deflate bomb; text frame rejection |
| Watch and sync | Property test: random engine event sequences against a client applying `session.sync` events, so the client window always equals `store.sync(window)`. Anchor deleted; older pages followed by deltas; backpressure dirty flush |
| Windowed sync compatibility | No window gives output identical to today for every `large-sync.test.ts` fixture |
| Commands | `create` with `initial` and `worktree` new, plus a crash between worktree creation and receipt (simulated) followed by a retry; queue dispatch, pause and resume; `unqueue` |
| Mutation receipts | Same key and params; same key, different params; concurrent duplicates |
| Attention | Every row of [08 §8.2](08-notifications.md#82-attention-events) and the user-cancel exclusion. Policy table: presence, prefs, delay, coalescing |
| Push | Sealing against cross-implementation vectors; gateway client against a stub server, covering each result status |
| Relay | The control and data protocol against `services/relay` run in workerd (cross-package CI job) |
| Endpoints | Interface classification from fixture `networkInterfaces()` output |
| Migration | A version-0 `host.db` fixture with desktop devices migrates, and the desktop tokens still authenticate |
| HTTP compatibility | `server.test.ts` unchanged and green; errors gain `code` |

All tests use fake providers and temporary directories. Any test that spawns git
must drop inherited `GIT_*` variables. The pre-push hook runs the suite with
`GIT_DIR` set, and an inherited value has written into the real repository before.
