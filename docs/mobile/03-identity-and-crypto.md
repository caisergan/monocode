# 3. Identity and cryptography

This document defines every key, the secure channel, the record layer, push payload
encryption, where secrets live, and the threat model. Wire-level JSON shapes for
the handshake payloads are repeated in [06](06-channel-protocol.md) with the rest
of the protocol.

## 3.1 Key inventory

| Key | Algorithm | Created by | Stored at | Lifetime | Purpose |
|---|---|---|---|---|---|
| Host key | X25519 | Host, first start of a channel-capable version | `~/.monocode-host/keys.json` | Until rotated | Noise static key. Phones pin it from the offer |
| Relay key | Ed25519 | Host, same time | `keys.json` | Until rotated | Signs relay room claims and push gateway requests |
| `roomId` | 16 random bytes, base64url | Host | `config.json` | Until rotated with the relay key | Relay rendezvous name and push identity |
| Device key | X25519 | Phone, once per host at pairing | Phone secure storage | Until the host is removed or the device revoked | Noise static key of the phone for that host |
| Push key | X25519 | Phone, once per app install | Phone secure storage, shared with the iOS extension | Until reinstall or rotation | Decrypts notification payloads |
| Pairing secret | 32 random bytes | Host, per offer | Host process memory only; the QR | ≤ 30 min (default 10), single use | Proves the phone saw the QR |
| Gateway key | X25519 | Gateway operator (one per publisher track) | Gateway secret; public half in that track's app build | Rotated by app releases | Opens push tickets |
| Admin token | 32 random bytes (existing) | Host `pair` CLI | Host DB (SHA-256), desktop `remote-machines.json` | Until revoked | Existing desktop HTTP RPC auth |

Keys for different algorithms are never derived from one another. The relay key is
not the host key.

## 3.2 Host keys

`~/.monocode-host/keys.json`, mode 0600 on Unix and protected with the existing
`protectWindowsDirectory` ACL on Windows:

```json
{
  "v": 1,
  "createdAt": 1759999999123,
  "host": { "public": "<base64url 32>", "private": "<base64url 32>" },
  "relay": { "public": "<base64url 32>", "private": "<base64url 32>" }
}
```

- Created atomically (write to a temp file, `fsync`, rename) the first time a
  channel-capable host starts. Existing hosts gain keys on upgrade without losing
  sessions or desktop devices.
- **Host fingerprint.** `SHA-256(host.public)`. It is shown in the UI as the first
  20 bytes in Crockford base32, grouped in 4s
  (`7G2K-9QXM-4TNB-…`). It identifies the host to humans in the pairing dialog, the
  CLI and the phone's host details.
- **Rotation.** `monocode-host keys rotate` generates new host and relay keys and a
  new `roomId`. It revokes every mobile device, since they pinned the old key. Desktop
  admin tokens stay valid. It requires `--yes`, and is intended for a suspected
  compromise.
- The private keys never leave the host and are never logged.

## 3.3 Device keys on the phone

- One X25519 key pair per (phone, host). The phone generates it during pairing,
  before the first handshake.
- Separate keys per host mean revocation on one host, or a compromise of one host's
  device table, says nothing about the others.
- Storage: `expo-secure-store` with `keychainAccessible:
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. That keeps keys out of iCloud and device
  backups and lets the app reconnect while the phone is locked. On Android it is
  encrypted with an Android Keystore key.
- Deleting a host from the phone deletes its device key.
- A per-host **handshake counter** (`uint53`) is stored next to the key. It
  increases before every connection attempt ([§3.4](#34-the-noise-channel)).

## 3.4 The Noise channel

### Pattern

`Noise_IK_25519_ChaChaPoly_SHA256` ([Noise spec rev 34](https://noiseprotocol.org/noise.html)).

```
IK:
  <- s
  ...
  -> e, es, s, ss      (message 1, phone → host, payload: hello)
  <- e, ee, se         (message 2, host → phone, payload: welcome or error)
```

- **Why IK.** The phone always knows the host key: from the offer the first time,
  and from storage after that. IK gives mutual authentication with static keys,
  forward secrecy for everything after message 2, and one round trip to a usable
  channel. The hello rides in message 1 and the welcome in message 2.
- **Why not TLS.** A direct connection reaches a LAN IP or a tailnet address with no
  public certificate. Pinned self-signed TLS needs native certificate pinning in
  React Native, and it would differ from the relay path. Noise gives one
  implementation for both paths.
- **Prologue.** `"monocode/channel/1" || 0x00 || environmentId` (UTF-8). Both sides
  know the `environmentId` (from the offer or the saved host), so a phone can't
  complete a handshake with the wrong host, even one holding a copied key file.
- **Implementation.** `@monocode/channel/noise`, on `@noble/curves` (`x25519`),
  `@noble/ciphers` (`chacha20poly1305`) and `@noble/hashes` (`sha256`, `hmac`,
  `hkdf`). It is validated against the published cacophony test vectors for this
  exact protocol name, and against the snow (Rust) vectors as a second source.
- **Maximum Noise message** is 65,535 bytes, as the spec requires. Larger
  application messages use the record layer ([§3.5](#35-record-layer)).

### WebSocket framing

Every WebSocket message is **binary**. The first byte is a frame kind:

| Kind | Direction | Body |
|---|---|---|
| `0x01` HANDSHAKE_1 | phone → host | Noise message 1 |
| `0x02` HANDSHAKE_2 | host → phone | Noise message 2 |
| `0x03` TRANSPORT | both | One Noise transport message (a record, §3.5) |
| `0x04` REJECT | host → phone | Plaintext UTF-8 JSON `{"code": "..."}`, sent only when the host can't produce message 2 |

- Text WebSocket frames, or a kind other than these, close the socket with WebSocket
  close code 1003.
- A REJECT is unauthenticated, so the phone treats it as a hint ("handshake
  failed") and never as proof of revocation.
- The phone must send HANDSHAKE_1 within 10 s of the socket opening. The host must
  answer within 10 s. Otherwise either side closes.

### Message 1 payload: hello

JSON, UTF-8. Schema in [06 §6.2](06-channel-protocol.md#62-handshake-payloads). Rules
the host applies in order:

1. Decrypt message 1. Failure means a wrong host key, a wrong prologue
   (`environmentId`) or corruption. The host sends REJECT
   `{"code":"handshake_failed"}` and closes.
2. `hello.env` must equal its `environmentId`, else error `host_identity_changed`.
3. The channel version range must overlap `[1, 1]`, else `protocol_incompatible`.
4. Look up the initiator static key `rs` among devices with `status = active`:
   - Found: the principal is that device.
   - Not found and `hello.pair` is present: the principal is a **pairing
     principal** for `hello.pair.offer` ([04](04-pairing.md)).
   - Otherwise: error `unknown_device`.
5. **Replay check** for a device principal: `hello.n` must not be in that device's
   recent-counter set (the last 256 values) and must be greater than
   `maxSeen - 256`. Otherwise `replayed_handshake`. Racing several transports gives
   several in-flight values, so strict monotonicity is not required. `maxSeen` is
   persisted; the set lives in memory.
6. Rate limits ([05 §5.9](05-connectivity.md#59-limits-and-rate-limits)).

Errors from steps 2 to 6 are sent **inside message 2** as `{"ok":false,"code":…}`.
Message 2 is authenticated by the host key, so the phone can trust them, then the
host closes the socket.

### Message 2 payload: welcome

Either a welcome (device principal), a pairing welcome (pairing principal), or an
error. See [06 §6.2](06-channel-protocol.md#62-handshake-payloads).

### After the handshake

- `Split()` gives one cipher state per direction. Nonces are the implicit 64-bit
  counters, so a replayed, dropped or reordered transport message fails
  authentication and closes the channel.
- **Channel lifetime.** The host ends a channel after 24 h with
  `bye{code:"rekey"}`. The phone reconnects at once. This bounds key usage without
  implementing Noise `Rekey()`.
- **Handshake hash.** `h`, the final handshake hash, identifies the channel. It
  binds the pairing proof and the 6-digit confirmation code ([§3.6](#36-pairing-proof-and-confirmation-code)).

## 3.5 Record layer

Each TRANSPORT frame decrypts to one **record**:

```
offset  size  field
0       1     type    0x01 = JSON, 0x02 = JSON, deflate-raw compressed
1       1     flags   bit 0 = FIN (last fragment); bits 1-7 MUST be 0
2       4     msgId   big-endian u32, per sender, +1 per application message, wraps
6       ≤65,513 fragment
```

- **Fragmentation.** An application message is serialised (and compressed if
  applicable), then cut into fragments of at most 65,513 bytes. That is 65,535 minus
  the 16-byte AEAD tag minus the 6-byte header. Fragments of one message are sent in
  order. Fragments of different messages MAY interleave.
- **Scheduling.** The sender keeps three queues and always sends from the highest
  non-empty one:
  - **P0:** `pong`, `bye`, small responses (< 4 KiB), `attention` and `pair.*`
    events.
  - **P1:** other responses and events.
  - **P2:** bulk: `sessions.sync` snapshots, `sessions.blocks`, `sessions.syncChunk`,
    `attachments.read`, `files.read`, `git.fileDiff`.
  
  An approval event therefore never waits behind a 10 MiB snapshot.
- **Reassembly limits.** The largest assembled message is `limits.maxMessage` (16 MiB,
  from the welcome). At most 32 partial messages at once, and at most 48 MiB
  buffered per channel. A violation closes with `bye{code:"protocol_error"}`.
- **Compression.** Allowed when both sides advertise the `deflate` capability. The
  sender compresses a JSON message of 1 KiB or more with deflate-raw (RFC 1951; `zlib`
  on the host, `fflate` on the phone) and uses type `0x02` if that is smaller.
  Decompression is streamed and aborts past `maxMessage`, which guards against
  compression bombs.
  - **Side channel.** Compression before encryption leaks information through
    ciphertext length. The only observer of lengths is the relay or the network
    path, and exploiting it needs both injected content and many observations of a
    secret in the same message. We accept that for the bandwidth saving, about 5 to
    10× on transcripts. Settings → Privacy → "Compress traffic" can turn it off.

## 3.6 Pairing proof and confirmation code

Both come from the handshake hash `h` of the pairing channel:

```
proof = HMAC-SHA256(key = pairingSecret, msg = "monocode/pair/1" || h)
code  = uint32_be(SHA-256("monocode/sas/1" || h)[0..4]) mod 1_000_000, zero-padded to 6 digits
```

- `proof` shows that whoever completed this specific handshake also holds the
  secret from the QR. Because it is bound to `h`, it can't be replayed on another
  channel.
- `code` is shown on the phone and on the confirming screen (the desktop dialog or
  the CLI). If they match, the request on the desktop came from the phone in your
  hand.

## 3.7 Push payload encryption

The host seals each notification to the phone's push public key. A sealed payload
looks like this:

```
eph      = fresh X25519 key pair
ss       = X25519(eph.private, pushPublic)
key      = HKDF-SHA256(ikm = ss, salt = eph.public || pushPublic,
                       info = "monocode/push/1", length = 32)
keyId    = SHA-256(pushPublic)[0..8]
nonce    = 12 zero bytes             (each key encrypts exactly one message)
ct       = ChaCha20-Poly1305(key, nonce, plaintext, aad = "monocode/push/1" || keyId)
envelope = "1." || base64url(keyId || eph.public || ct)
```

- This is implementable with CryptoKit on iOS, inside the Notification Service
  Extension:
  - `Curve25519.KeyAgreement.PrivateKey(rawRepresentation:)`
  - `sharedSecretFromKeyAgreement(with:)`
  - `hkdfDerivedSymmetricKey(using: SHA256.self, salt:, sharedInfo:, outputByteCount: 32)`
  - `ChaChaPoly.open`
- The same code runs in `@monocode/channel/push` (noble) on the host and the Android
  background task.
- Cross-implementation vectors (Node noble ↔ Hermes noble ↔ CryptoKit) are part of
  `packages/channel/vectors` **(spike S2)**.
- The plaintext budget is 1,800 bytes. That keeps the APNs and FCM payload under
  4 KiB after base64 and the outer fields. The host truncates the body to fit.
- `keyId` lets the phone rotate its push key: it keeps the previous private key for
  7 days after registering a new one.

## 3.8 Push tickets

A host must never learn a phone's push token, and the gateway must only deliver to
tokens that a phone paired with that host chose to give it. The phone gives each
host an opaque **push ticket**:

```
ticket = seal(gatewayPublic, JSON{
  v: 1, provider: "expo", expoToken: "ExponentPushToken[...]",
  deviceToken: "<raw APNs/FCM token>", platform: "ios" | "android",
  roomId: "<host roomId>", deviceId: "<device id on that host>",
  issuedAt: <unix ms>
})
```

- `seal` uses the §3.7 construction with `info = "monocode/push-ticket/1"`.
- **What the gateway checks.** It opens the ticket and checks that `roomId` matches
  the room whose key signed the request ([07 §7.5](07-relay-and-push-service.md#75-push-gateway)).
  A stolen ticket is useless to any other host.
- **Gateway public keys.** Each app build knows exactly one gateway: its publisher's
  ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)). The URL
  and public keys `[{id, public}]` are compiled in from the publisher config. The
  phone seals tickets to that gateway and tells each host to deliver its pushes
  there ([08 §8.6](08-notifications.md#86-push-targets-and-registration)). A
  MonoCode Dev phone and a MonoCode phone paired with the same host therefore use
  different gateways, each holding credentials for its own app.
- Both tokens are inside the ticket. The gateway can therefore switch delivery
  provider (Expo or direct APNs/FCM) without an app update.

## 3.9 Where secrets live

| Location | Secrets | Protection |
|---|---|---|
| Host `keys.json` | Host and relay private keys | 0600 or user-only ACL |
| Host `host.db` `devices` | Admin token hashes; device public keys; push public keys; sealed tickets | 0600 data directory; no plaintext tokens |
| Host process memory | Open pairing offers and their secrets | Never written to disk; lost on restart; at most 8 open |
| Desktop `remote-machines.json` | Admin tokens, including the local host's | Existing: 0600, never sent to the renderer |
| Phone secure storage | Device keys, push key, cache DB key, app-lock settings | Keychain `AfterFirstUnlockThisDeviceOnly` / Android Keystore |
| Phone iOS keychain access group | Push private key only | Shared with the Notification Service Extension |
| Phone SQLite cache | Transcripts, summaries, outbox | SQLCipher, key in secure storage; excluded from backups |
| Gateway | Gateway private key, Expo access token | Worker secrets |
| Relay Durable Object storage | Room → relay public key | Public data only |

**Never logged, on any component:** private keys, pairing secrets, proofs, admin
tokens, push tokens, tickets, decrypted payloads. Host logs show device ids and
offer ids only.

## 3.10 Threat model

| Threat | What the attacker gets | Mitigation |
|---|---|---|
| Relay operator, or a compromised relay | Metadata: IPs, timing, sizes, room ids, connection counts. Can drop or delay frames | End-to-end Noise. No plaintext reaches it. The host still works directly |
| Network attacker on LAN or Wi-Fi | Nothing beyond denial of service | Noise with pinned host key; device keys authenticated |
| Someone photographs the QR | Could start a pairing within 10 min | Single use; 10-min TTL; confirmation required by default, with a matching 6-digit code; the device appears in the device list |
| Stolen phone, unlocked | Full agent control on paired hosts | Optional app lock (Face ID or passcode at launch and after 5 min in background); revoke from desktop or CLI; `member` role can't pair devices or change host settings |
| Stolen phone, locked | Keys accessible to the app after first unlock | Revoke. Keys are not in backups. Lock-screen notification previews are minimal by default |
| Phone backup extraction | Nothing useful | Keys are `ThisDeviceOnly`; the cache is encrypted and excluded from backup |
| Host `keys.json` stolen | Can impersonate the host to phones, which then reveal hello payloads (no secrets) and later commands | `keys rotate` and re-pair. Recorded past traffic stays safe (forward secrecy after message 2) |
| Device key stolen | Can act as that phone | Revoke the device |
| Push gateway compromised | Can withhold or spam pushes and learn token-to-room mapping. Cannot read content | Sealed payloads; tickets bound to rooms; rate limits |
| Relay room squatting | Cannot evict the host or claim its room | Rooms are claimed by an Ed25519 key; later connections must sign with it |
| Denial of service on the direct listener | CPU usage | Listener only on private interfaces; per-IP handshake rate limits; 10 s handshake deadline; bounded buffers |
| A malicious or impostor host | Can show fake transcripts; receives what you type and attach | The phone pins hosts at pairing. Markdown renders without HTML; links open only after confirmation; remote images in markdown are not loaded automatically |
| Downgrade to an older channel version | None | Version negotiation is inside the encrypted, authenticated handshake payloads |
| Compression length side channel | Partial content inference under narrow conditions | §3.5 conditions; a setting to disable |
| Lock-screen shoulder surfing | Notification text | Previews default to "when unlocked" on iOS; Android uses private visibility with a public generic version |
