# 4. Pairing

Pairing makes a phone a **device** of a host. Each host keeps its own device list,
so a phone paired with three machines is three devices.

## 4.1 Devices

The host's `devices` table moves to a v2 schema ([09 §9.4](09-host-changes.md#94-database-migrations)).
Each row is one of two kinds:

| Field | Desktop device (existing) | Mobile device (new) |
|---|---|---|
| `id` | UUID | UUID |
| `name` | Computer name (`remote_ssh.rs` `device_name`) | From the phone, editable |
| `kind` | `desktop` | `mobile` |
| `role` | `admin` | `member` |
| `status` | `active` | `pending` → `active` |
| Credential | Bearer token (SHA-256 stored) | X25519 device public key |
| `platform`, `model`, `appVersion` | `null` until reported | From `pair.claim`, refreshed on each hello |
| `createdAt`, `lastSeenAt`, `lastSeenVia` | `http` | `direct` / `relay` |
| Push | none | Push public key, sealed ticket, categories, preview mode |

**Roles.**

| Capability | `admin` | `member` |
|---|---|---|
| Sessions, commands, approvals, attachments, models, files, git, projects | ✓ | ✓ |
| `devices.list` | all devices | itself only |
| `devices.rename` | any device | itself |
| `devices.revoke` | any device | itself (`devices.revokeSelf`) |
| `pairing.create` / `decide` / `cancel` | ✓ | ✗ |
| `host.config.get` | ✓ | read-only subset (relay on/off, direct mode) |
| `host.config.set` | ✓ | ✗ |

A stolen phone can't add devices, lock out the desktop, or turn the relay on or off.

## 4.2 The offer

An offer is a single-use invitation. The host creates it, and it is encoded in a
QR code and a link.

### Fields

```json
{
  "v": 1,
  "env": "6f0b1f8e-3c2a-4a59-9a77-5d1c2b0f4e11",
  "name": "mac-mini",
  "key": "q3Xr…43 chars base64url…",
  "offer": "Zk9xV1p…22 chars",
  "secret": "c2VjcmV0…43 chars",
  "exp": 1760000599,
  "direct": [
    { "kind": "lan", "addr": "192.168.1.20", "port": 3775 },
    { "kind": "tailscale", "addr": "100.101.12.7", "port": 3775, "dns": "mac-mini.tail1234.ts.net" },
    { "kind": "manual", "addr": "dev.example.com", "port": 443 }
  ],
  "relay": { "url": "wss://relay.usemono.dev", "room": "Q2hhbm5lbFJvb20…22 chars" },
  "ui": { "theme": "dark", "hue": 240, "sat": 0, "dark": 9, "accent": "#4da3f5" }
}
```

| Field | Rules |
|---|---|
| `v` | `1`. A phone that does not know the version shows "Update MonoCode to pair with this machine" |
| `env` | The host `environmentId`. It goes into the Noise prologue |
| `name` | The host's display name (`os.hostname()`, or the CLI `--name`). Max 64 chars. A suggestion only |
| `key` | The host key, base64url of 32 bytes |
| `offer` | Offer id, 16 random bytes, base64url |
| `secret` | Pairing secret, 32 random bytes, base64url |
| `exp` | Expiry, Unix seconds by host clock. Default now + 600, range 60 to 1,800 |
| `direct` | 0 to 8 candidates ([05 §5.2](05-connectivity.md#52-endpoints)). Omitted when the direct listener is off |
| `relay` | Present only when the host has the relay enabled |
| `ui` | Optional. The appearance of the desktop that created the offer (`theme`, `hue`, `sat`, `dark` lightness, `accent` or `null`), so the phone can offer to match it ([11 §11.2](11-design-and-ux.md#112-color)). Omitted for CLI-created offers |

At least one of `direct` or `relay` must be present, or the host refuses to create
the offer ("Turn on direct connections or the relay first").

### Encoding

- **Link.** `<linkBase>#o=<base64url(UTF-8 JSON)>`. `linkBase` is the host setting
  `pairing.linkBase`: `https://usemono.dev/pair` on the official track,
  `monocode-dev://pair` on the personal track
  ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)).
  - The offer sits in the URL **fragment**, which browsers never send to a server.
  - The path is a universal link (iOS `apple-app-site-association`; an Android App
    Link through `assetlinks.json` once an Android app exists). When the app is
    installed, scanning with the OS
    camera opens it directly. When it isn't, the web page shows store links and
    explains that the code must be scanned again from the app.
- **Custom schemes.** `monocode://pair#o=…` and `monocode-dev://pair#o=…`. Each app
  registers only its own scheme with the OS, but both apps' in-app scanners and
  "Paste link" accept any MonoCode pairing link, whatever its base.
- **QR.** It encodes the https link, byte mode, error correction M. A typical offer
  is about 600 characters, which fits QR version 19 or 20. Render it at least 280 pt
  wide on the desktop, with a quiet zone of 4 modules.

### Phone-side validation (before any network traffic)

1. Fragment parameter `o` decodes as base64url to JSON under 4 KiB.
2. `v` is 1. `env` is a UUID. `key`, `secret` and `offer` decode to 32, 32 and 16
   bytes.
3. `direct` entries:
   - `kind` must be `lan`, `tailscale` or `manual`.
   - `addr` must be an IPv4 or IPv6 literal, or a hostname matching
     `^[a-z0-9.-]{1,253}$`.
   - `port` must be 1 to 65535.
   - Unknown kinds are ignored.
4. `relay.url` uses `wss:`. `ws:` is accepted only in development builds.
5. If `exp` is in the past by phone clock, warn ("This code may have expired") but
   still try. The host clock decides.
6. If a host with the same `env` is already paired, ask "Pair again? This replaces
   this phone's access to mac-mini". If yes, the claim carries
   `replacesDeviceId` (§4.6).

## 4.3 Where offers are created

| Initiator | How | Confirmation shown on |
|---|---|---|
| Desktop, any machine it manages, including "This computer" | `Settings → Mobile → <machine> → Pair a phone`, which calls `pairing.create` over the existing HTTP RPC with the desktop's admin token | The desktop dialog |
| Host terminal | `monocode-host pair --mobile` (talks to the running host through the local lifecycle endpoint) | The terminal |
| Later: an already-paired phone | Not in v1; mobile devices are `member`s | n/a |

## 4.4 Flow A: from the desktop

```mermaid
sequenceDiagram
  autonumber
  participant D as Desktop
  participant H as Host
  participant P as Phone
  D->>H: HTTP pairing.create {relay?}
  H-->>D: {offerId, url, expiresAt, fingerprint}
  D->>D: Render QR + link + countdown
  P->>P: Scan QR, validate offer, generate device key
  P->>H: Noise IK msg1 (via fastest of direct/relay) hello{pair:{offer}}
  H-->>P: msg2 pairing welcome
  P->>H: pair.claim {offer, proof, name, platform, model, app}
  H->>H: check offer open + unexpired, verify proof, create device(status=pending)
  H-->>P: {status:"pending", code:"482913", deviceId}
  loop every 1 s
    D->>H: HTTP pairing.status {offerId}
  end
  H-->>D: {status:"claimed", device:{name, platform, model}, code:"482913"}
  D->>D: "Ege's iPhone wants to connect. Code 482 913" [Deny] [Allow]
  D->>H: HTTP pairing.decide {offerId, allow:true}
  H->>H: device.status = active, offer.status = approved
  H-->>P: evt pair.status {status:"approved", welcome:{…full welcome…}}
  P->>P: Save host record; channel is now a device channel
  P->>H: push.register {ticket, pushKey, categories}
```

Steps 4 to 11 also work when the phone reaches the host through the relay, with no
change. The desktop polls `pairing.status` because it uses HTTP RPC (D11). One
request per second for at most 12 minutes is negligible.

## 4.5 Flow B: from the host terminal

For hosts with no desktop, or when the desktop is elsewhere.

```
$ monocode-host pair --mobile
Pair a phone with mac-mini
Scan this code with the MonoCode app, or open the link on your phone.

  ██████████████  ▄▄ ▄ ▄▄▄  ██████████████
  … (UTF-8 half-block QR) …

  https://usemono.dev/pair#o=eyJ2IjoxLCJlbnYiOiI2ZjBi…
  Host fingerprint: 7G2K-9QXM-4TNB-WR8C-D1PZ
  Reachable through: local network (192.168.1.20), Tailscale (100.101.12.7), relay
  Expires in 10:00. Press Ctrl+C to cancel.

"iPhone 17" (iOS 27) wants to pair. Code on the phone: 482 913
Allow? [y/N] y
Paired "iPhone 17" (device 1f3a9c…). Manage devices with: monocode-host devices
```

- **Requires a running host.** Otherwise it fails with "The host is not running.
  Start it with: monocode-host start".
- **Talks to the running host** through the existing loopback `/lifecycle` endpoint
  and its `running.json` secret ([09 §9.9](09-host-changes.md#99-cli)), using actions
  `pairing.create`, `pairing.status`, `pairing.decide` and `pairing.cancel`. The
  server stays the only owner of offers and keys.
- **Flags:**
  - `--name <label>` is the suggested host name for the phone.
  - `--relay` turns the relay on. It persists to `config.json` after printing what
    the relay can and can't see, and asks for confirmation unless `--yes`.
  - `--no-relay` leaves the relay out of this offer.
  - `--ttl <minutes>` sets the expiry, 1 to 30.
  - `--yes` approves the first valid claim without a prompt. It still prints the
    code.
  - `--json` prints one JSON line with `{offerId, url, expiresAt, fingerprint}`,
    then status lines. This is for scripts and for the desktop's local setup.
- **Without a TTY** and without `--yes`, it exits with an error, since nobody could
  confirm.
- **Ctrl+C** cancels the offer (`pairing.cancel`).

## 4.6 Host offer and device state machine

```
offer:   open ──claim(valid proof)──▶ claimed ──decide(allow)──▶ approved
           │                              │──decide(deny)─────▶ denied
           │                              │──2 min no decision▶ expired
           ├──exp passed──────────────────────────────────────▶ expired
           └──cancel──────────────────────────────────────────▶ cancelled
device:  (none) ──claim──▶ pending ──allow──▶ active ──revoke──▶ (deleted + tombstone)
                              └──deny / expire──▶ (deleted)
```

**Rules for `pair.claim`:**

- Only a pairing principal may call it, once per channel, within 30 s of the
  handshake. Otherwise the channel is closed.
- The offer must be `open` and unexpired. Anything else gets `pairing_expired`,
  `pairing_used` or `pairing_cancelled`.
- `proof` must equal `HMAC(secret, "monocode/pair/1" || h)`. The check is
  constant-time. A failure gets `pairing_proof_invalid` and counts towards the offer
  being closed: 3 failures move it to `cancelled`.
- The initiator's static key must not belong to an active device
  (`device_key_in_use`).
- **Success:**
  1. Create the device (`kind:mobile`, `role:member`, `status:pending`, `public_key`
     = the Noise `rs`).
  2. Set the offer to `claimed` with the device id.
  3. Return `{status, deviceId, code}`.
- **`replacesDeviceId`.** If present and it names a mobile device whose
  `name`/`platform` came from the same phone, that device is revoked when the new one
  becomes active. Re-pairing therefore never leaves a stale entry.

**Confirmation.**
- `config.json` `pairing.requireConfirmation` defaults to `true`.
- When it is `false`, used only by explicit choice (CLI `--yes`), a valid claim goes
  straight to `approved` and the claim response carries the full welcome.
- Pending devices can't call anything except wait for `pair.status`.
- A pending device that disconnects stays pending until decided or expired.

**When approved:**
1. Set `device.status = active`.
2. Set `offer.status = approved`.
3. Discard the secret from memory. Offers are never written to disk, so a host
   restart cancels open offers.
4. Push `evt pair.status {status:"approved", welcome}` to the pairing channel, if
   it is still open. From then on that channel is treated as a device channel, with
   no reconnect.

## 4.7 Phone screens

See [11 §11.3](11-design-and-ux.md#1111-onboarding-and-pairing) for layouts. The logic:

1. **Entry.** One of:
   - Onboarding "Scan QR code" (VisionKit `DataScannerViewController`, QR only).
   - "Paste link" (explicit paste button; no clipboard snooping).
   - An incoming universal link or custom-scheme link while the app is running or
     cold-starting.
2. **Review.** "Connect to mac-mini?" shows:
   - The fingerprint.
   - How it is reachable ("Local network · Tailscale · Relay").
   - The phone name field, defaulting to the device model and editable.
   - The access warning: "This phone will be able to run agents and read files on
     mac-mini with the same access as its user account."
   - The **Connect** button.
3. **Local network permission (iOS).** If the offer has `lan` candidates and the
   permission is undetermined, show the explainer first, then trigger the system
   prompt by attempting the LAN connection. If it is denied, carry on with the other
   candidates.
4. **Persist intent.** Before connecting, write a *pending pairing* record to secure
   storage: `{env, key, offer, deviceKey, candidates, startedAt}`. The pairing can
   then finish even if the app is killed while waiting.
5. **Connect.** Race the candidates ([05 §5.5](05-connectivity.md#55-transport-racing)),
   with a 20 s overall deadline. Then send `pair.claim`.
6. **Confirm.** Show the 6-digit code large: "Check that mac-mini shows **482 913**,
   then allow the connection there." Below it, a 2-minute countdown and Cancel.
   Cancel closes the channel; the host expires the claim.
7. **Approved.**
   - Convert the pending record into a host record:
     `{env, name, key, deviceId, role, endpoints, relay, pushGateway, pairedAt}`.
   - Delete the pending record.
   - Haptic success.
8. **Notifications.**
   - If the OS permission is undetermined, show the explainer ("Get notified when an
     agent needs approval or finishes") with **Allow** and **Not now**.
   - On Allow, request the permission, then `push.register`.
   - If already granted, register silently.
9. **Done.** Open the new host's project list. On the first pairing, open Agents.

**Resuming a pending pairing.**
- On launch, or on foreground with a pending record, the phone connects with the
  pending device key and no `pair` field:
  - `welcome` means the pairing was approved while the app was away (step 7).
  - `device_pending` means keep waiting.
  - `unknown_device` means it was denied or expired. The phone shows "mac-mini
    didn't approve this phone. Scan a new code to try again."
- Pending records older than 15 min are deleted.

## 4.8 Device lifecycle after pairing

| Action | Where | Effect |
|---|---|---|
| Rename | Phone (host details), desktop device list, `monocode-host rename-device <id> <name>` | `devices.rename`; the new name shows everywhere |
| See devices | Desktop Settings → Mobile; `monocode-host devices` | Name, kind, platform, paired date, last seen and via |
| Revoke a phone | Desktop (admin), `monocode-host revoke <id>` | Deletes the device and writes a tombstone `{publicKeyHash, revokedAt, by}` kept 30 days. Closes that device's live channels with `bye{code:"device_revoked"}`. Drops its push target. The next connect gets `device_revoked` |
| Remove host on the phone | Phone: host details → Remove | Online: `devices.revokeSelf`. Then, either way: delete the device key, cached data, outbox entries for that host and the push registration |
| Phone reinstalled or reset | n/a | Keys are gone, so the old device is never used again. Re-pair; the desktop can revoke the stale entry ("last seen 3 weeks ago") |
| Host keys rotated (`keys rotate`) | Host | All mobile devices revoked. Phones see the handshake fail with the host reachable, and show "mac-mini's identity changed. Pair again" (§4.9) |
| Host data directory deleted | Host | New `environmentId` and keys. Phones behave as for rotation |

## 4.9 Errors and copy

| Code / condition | Shown on phone | Shown on desktop / CLI |
|---|---|---|
| Offer malformed | "This isn't a MonoCode pairing code." | n/a |
| `v` unknown | "Update MonoCode to pair with this machine." | n/a |
| No candidate reachable in 20 s | "Can't reach mac-mini. Check that your phone is on the same network or Tailscale, or turn on the relay on mac-mini." + Retry | n/a |
| `handshake_failed` REJECT during pairing | "This code doesn't match mac-mini. Generate a new code and scan again." | n/a |
| `pairing_expired` | "This code expired. Generate a new one on mac-mini." | Dialog: "Code expired" + Generate new code |
| `pairing_used` | "This code was already used. Generate a new one." | n/a |
| `pairing_proof_invalid` | "Pairing failed. Generate a new code and try again." | Counter shown after 3 failures: "Code cancelled after failed attempts" |
| Denied | "mac-mini didn't allow this phone." | n/a |
| No decision in 2 min | "Nobody approved the connection in time." | "Request expired" |
| `protocol_incompatible` | "mac-mini runs an older MonoCode host. Update it from the desktop (Settings → Connections → Update Host) or with the host installer." | n/a |
| Later, host key mismatch on a paired host (handshake fails 3× while the socket opens) | Host shows a red state: "Can't verify mac-mini. Its identity changed, or it was reinstalled." + Pair again / Remove | n/a |
| Later, `device_revoked` | "This phone was removed from mac-mini." + Pair again / Remove | n/a |

## 4.10 Security notes

- The QR and link are secrets for up to 10 minutes. The desktop dialog says "Anyone
  who can scan this code can ask for access. Keep it private." Closing the dialog
  cancels the offer.
- Confirmation with the matching code is the default because a photographed code is
  the main realistic attack.
- The host fingerprint in the dialog and on the phone lets a careful person check the
  key. That isn't required, since the offer travels by camera from the host's own
  screen.
- Offers, claims, approvals, denials and revocations are logged on the host with
  device ids, never secrets, in `host.log`. They are also kept in a `device_events`
  table (last 500 rows) that the desktop shows as "Recent activity".
