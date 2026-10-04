# 7. Relay and push service

One Cloudflare Worker, `services/relay`, provides two things:

- **Relay rooms.** A rendezvous point where a host that dialled out meets the
  phones that want to reach it. It forwards ciphertext frames in both directions.
- **Push gateway.** It accepts signed, encrypted notifications from hosts and hands
  them to Apple and Google through a delivery provider.

It is the only piece the project operates rather than the user. It never sees
plaintext, and it can be self-hosted.

## 7.1 Principles

- **A dumb pipe.** The relay forwards opaque binary frames. It doesn't parse Noise,
  doesn't buffer more than it must, and doesn't persist anything but room ownership.
- **Hosts are authenticated; phones aren't.** A room is owned by the Ed25519 relay
  key that first claimed it. Phones are authenticated end to end by the host, inside
  Noise. The relay only rate-limits them.
- **Fail open to direct.** If the relay is down, direct connections still work.
  If the gateway is down, the in-app experience still works and only pushes are
  missed.
- **No accounts.** Rooms are created by hosts on demand. There is no user database.

## 7.2 Deployment

| Item | Value |
|---|---|
| Runtime | Cloudflare Workers with Durable Objects (WebSocket hibernation API) |
| Package | `services/relay` (`@monocode/relay`), TypeScript, `wrangler.toml` |
| Durable Object classes | `Room` (one per `roomId`, `idFromName("room:" + roomId)`) |
| Routes | Official: `relay.usemono.dev/v1/*` and `/health`. Personal: the maintainer's domain or `*.workers.dev` |
| Environments | `staging` (`relay-staging.usemono.dev`) and `production` for the official track; `personal` for the maintainer's own deployment ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)). Each environment is a separate gateway with its own keys and Expo token, matching one app build |
| Secrets | `GATEWAY_KEYS` (JSON list of `{id, private}`), `EXPO_ACCESS_TOKEN`, optional `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `FCM_SERVICE_ACCOUNT` |
| Deploy | Official: GitHub Actions on tags `relay-v*` (`wrangler deploy --env production`); staging on merge to `dev`. Personal: `wrangler deploy --env personal` by hand |
| Tests | `@cloudflare/vitest-pool-workers` (workerd), [13 §13.2](13-testing-and-release.md#132-automated-tests) |

## 7.3 Host control socket

```
GET wss://relay.usemono.dev/v1/host?room=<roomId>
```

All control messages are JSON text frames.

```
relay → host  {"t":"challenge","nonce":"<base64url 32>","v":1}
host  → relay {"t":"auth","pub":"<relay public key>","ts":<unix ms>,
               "sig":"<ed25519(sign, 'monocode/relay/auth/1' || roomId || nonce || ts)>",
               "host":{"version":"0.9.0"}}
relay → host  {"t":"ready","claimed":true|false,"conns":["c1","c2"]}     // or close
relay → host  {"t":"connect","conn":"c3"}
relay → host  {"t":"disconnect","conn":"c1","code":1000}
host  → relay {"t":"ping"}   relay → host {"t":"pong"}                  // auto-response
```

**Room claim:**
- If the `Room` has no stored key, it stores `pub` and `claimedAt`, and replies
  `claimed: true`.
- If it has a key and `pub` matches, the reply is `ready`.
- Otherwise the relay closes with **4403** "room owned by another key".
- A bad signature, or `ts` more than 120 s from relay time, closes with **4401**.
- The handshake must finish within 10 s, else close **4408**.

**One control socket per room.** A second authenticated control socket replaces the
first, which is closed with **4409** "replaced". A host that restarts reclaims its
room immediately. Because replacement needs the room key, an attacker cannot evict
the real host, unlike an unauthenticated room.

**`conns` in `ready`** lists phones already waiting. That covers phones that
connected while the control socket was reconnecting.

**Hibernation.** The ping/pong pair is registered with
`state.setWebSocketAutoResponse`, so keepalives don't wake the Durable Object.

## 7.4 Data path

**Phone side:**

```
GET wss://relay.usemono.dev/v1/client?room=<roomId>&v=1
```

- The relay assigns `conn` (16 random bytes, hex) and sends `connect` to the host's
  control socket.
- If no control socket is attached, it waits up to 3 s for one. If none arrives it
  closes the phone socket with **4404** "host not connected". The phone treats that
  as "host offline" and stops waiting early ([05 §5.5](05-connectivity.md#55-transport-racing)).

**Host side, one socket per phone:**

```
GET wss://relay.usemono.dev/v1/host/data?room=<roomId>&conn=<conn>&ts=<unix ms>&sig=<ed25519(…)>
sig signs: 'monocode/relay/data/1' || roomId || conn || ts
```

- The signature is checked against the room key, with `ts` within 120 s.
- The relay then pairs the data socket with the phone socket `conn` and flushes any
  buffered phone frames in order.

**Forwarding rules:**
- Binary frames only. A text frame closes both sides with 1003.
- Frames over 65,536 bytes close both sides with 1009.
- Before the host data socket attaches, the relay buffers at most 64 frames or 1 MiB
  per conn. Overflow closes the phone socket with **4413**.
- If the host doesn't attach a data socket within 10 s of `connect`, the relay
  resends `connect` once. After 15 s total it closes the phone socket with **4504**
  "host did not answer".
- **Phone closes:** the relay closes the paired host data socket with 1000 and sends
  `disconnect` on the control socket.
- **Host data socket closes:** the relay closes the phone socket with **1012**.
- **Control socket drops:** existing pairs keep forwarding. A host process that
  really died also drops its data sockets.

**Close codes seen by the phone:**

| Code | Meaning | Phone reaction |
|---|---|---|
| 1000 | Normal close | Reconnect if still needed |
| 1003 / 1009 | Protocol misuse | Treat as a bug; log; reconnect with backoff |
| 1012 | Host side closed | Reconnect race |
| 4404 | Host not connected | `offline` (host unreachable) |
| 4413 | Buffer overflow before host attached | Reconnect race |
| 4429 | Rate limited | Backoff at least 30 s |
| 4504 | Host did not answer | Reconnect race; after 3 in a row, mark the relay candidate failed |

## 7.5 Push gateway

### `GET /v1/keys`

```json
{ "keys": [ { "id": "g2026a", "public": "<base64url X25519>", "notAfter": 1790000000 } ] }
```

The default gateway's keys are also compiled into the app ([03 §3.8](03-identity-and-crypto.md#38-push-tickets)).

### `POST /v1/push`

Headers:

```
Content-Type: application/json
X-Mono-Room: <roomId>
X-Mono-Ts: <unix ms>
X-Mono-Nonce: <base64url 16>
X-Mono-Key: <relay public key>          (needed only when the room is new here)
X-Mono-Sig: <ed25519(sign, 'monocode/push/1' || roomId || ts || nonce || sha256(body))>
```

Hosts send each phone's pushes to the gateway that phone named
([08 §8.6](08-notifications.md#86-push-targets-and-registration)). A host may
therefore reach a gateway deployment it has never connected a relay socket to. The
first signed push claims the room there, exactly like a relay control-socket claim.

Body (≤ 256 KiB):

```json
{
  "messages": [
    {
      "ticket": "1.<sealed ticket>",
      "gatewayKeyId": "g2026a",
      "payload": "1.<sealed payload for the phone>",
      "kind": "approval",
      "priority": "high",
      "ttlSeconds": 3600,
      "thread": "<opaque per-session tag>"
    }
  ]
}
```

| Field | Rules |
|---|---|
| `kind` | `approval`, `question`, `finished`, `failed`, `interrupted`, `usage_limit` or `test`. Picks the platform category and channel |
| `priority` | `high` for approval, question and test; `normal` otherwise |
| `ttlSeconds` | 60 to 86,400 |
| `thread` | `base64url(HMAC(hostKeyBytes, sessionId))[0..16]`. It groups notifications per session on the device without revealing the session id |
| Message count | ≤ 50 per request |

**Verification, in order:**

1. `ts` within ±300 s.
2. `nonce` not seen in the last 10 min. The `Room` keeps a bounded set.
3. `X-Mono-Sig` verifies with the room key. If the room has no key yet, it verifies
   with `X-Mono-Key`, and that key becomes the room key (claim). Otherwise **401**.
   A claim counts against the per-IP room-claim limit.
4. Per room rate limit ([§7.6](#76-limits-and-abuse-controls)). Otherwise **429**
   with `Retry-After`.
5. For each message:
   1. Open the ticket with the gateway key named by `gatewayKeyId`.
   2. Check `ticket.roomId === roomId`. A mismatch gives that message the status
      `invalid_ticket`.
   3. Check the ticket's push token isn't on the room's unregistered list.
   4. Dispatch to the delivery provider.

**Response:**

```json
{ "results": [ { "status": "ok" } , { "status": "unregistered" }, { "status": "invalid_ticket" } ] }
```

| Status | Host reaction |
|---|---|
| `ok` | none |
| `unregistered` | The token is dead. Drop this push target ([08 §8.6](08-notifications.md#86-push-targets-and-registration)) |
| `invalid_ticket` | Drop the target; the phone re-registers on its next connect |
| `rate_limited` | Keep. The host drops `finished` pushes for this window and retries approvals once after `Retry-After` |
| `provider_error` | Keep; retry once after 30 s |

### Delivery providers

**v1: Expo Push Service.** `POST https://exp.host/--/api/v2/push/send` with
`Authorization: Bearer EXPO_ACCESS_TOKEN`. The project enables "enhanced push
security", so tokens alone can't be used to send.

- **iOS message:**
  ```json
  { "to": "<expoToken>", "title": "MonoCode", "body": "New activity",
    "mutableContent": true, "sound": "default", "priority": "high",
    "categoryId": "approval", "data": { "e": "1.<payload>", "t": "<thread>", "k": "approval" },
    "ttl": 3600 }
  ```
  - The Notification Service Extension replaces the placeholder title and body with
    the decrypted content.
  - If decryption fails, the placeholder is what shows. It contains nothing private.
- **Android message:** data-only, so the app's background task builds the
  notification after decrypting.
  ```json
  { "to": "<expoToken>", "data": { "e": "1.<payload>", "t": "<thread>", "k": "approval" },
    "priority": "high", "ttl": 3600 }
  ```
- **Errors.**
  - Expo push tickets can return `DeviceNotRegistered` at once. That maps to
    `unregistered`.
  - Receipt-level errors only appear in a later receipts call. The `Room` schedules
    a Durable Object alarm 15 min after a send to fetch receipts for that batch.
    Tokens that come back `DeviceNotRegistered` are stored, hashed, in the room's
    unregistered list for 30 days. The next push with that ticket returns
    `unregistered`.

**Alternative: direct APNs and FCM.** The ticket already carries the raw device
token. A provider module can send:
- to APNs over HTTP/2 with a `.p8` JWT, using `apns-push-type: alert`,
  `apns-collapse-id`, `mutable-content: 1`;
- to FCM HTTP v1 with a service account.

APNs requires HTTP/2, and Workers' outbound `fetch` support for it must be verified
**(spike S5)**. If it is missing, this provider runs as a small Node service instead.
Either way the host protocol and the phone are unchanged.

## 7.6 Limits and abuse controls

| Limit | Value | Response |
|---|---|---|
| New WebSocket connections per IP | 60/min (Cloudflare rate limiting rule) | 429 at upgrade |
| Room claims (new rooms) per IP | 20/h | 429 |
| Phone sockets per room | 16 concurrent | Close **4429** |
| Host data sockets per room | ≤ phone sockets | Extras closed **4409** |
| Frame size | 65,536 bytes | Close 1009 |
| Pre-attach buffer | 64 frames / 1 MiB per conn | Close **4413** |
| Control handshake | 10 s | Close **4408** |
| Pushes per room | 120/min, burst 30 | 429 `Retry-After` |
| Pushes per ticket | 30/min | That message gets `rate_limited` |
| Push body | 256 KiB, ≤ 50 messages | 413 |
| Idle rooms | Storage deleted after 180 days with no host connection | The host re-claims on next connect |

## 7.7 State kept by the service

Per `Room`, in Durable Object storage:

```ts
{
  publicKey: string;            // relay key that owns the room
  claimedAt: number;
  lastHostSeenAt: number;
  recentNonces: string[];       // push replay protection, ≤ 2,000, 10-min window
  unregistered: { tokenHash: string; at: number }[];   // ≤ 500, 30 days
  pendingReceipts: { expoTicketId: string; tokenHash: string; at: number }[];
}
```

In memory only, while the object is awake: the attached sockets, conn ids and
buffers.

**Logging.** Request path, room id prefix (first 6 chars), status codes, close codes,
byte counts, durations. Never frame contents, tickets, payloads, signatures or tokens.

## 7.8 Operations

- **Health.** `GET /health` returns `{ok, version}`. An uptime monitor checks it, and
  separately runs a synthetic room: a canary host and client pair exchanging an echo
  every 5 min.
- **Metrics** (Workers Analytics Engine):
  - active rooms, phone connections and data bytes;
  - close codes;
  - push requests and results by status;
  - Expo error rates.
- **Alerts:**
  - health failing for 3 min;
  - push `provider_error` above 5 % for 10 min;
  - 4504 rate above 10 % for 15 min, which suggests hosts aren't attaching.
- **Incidents.** Relay down: direct still works, and hosts back off reconnecting.
  Gateway down: pushes are lost, not queued (hosts don't retry beyond one attempt);
  the in-app Inbox still shows everything.
- **Gateway key rotation.**
  1. Add a new key to `GATEWAY_KEYS` and `/v1/keys`.
  2. Ship it in the next app release.
  3. New registrations use it.
  4. Remove the old private key after 6 months. Phones re-register on every connect,
     so active phones move within days.

## 7.9 Cost estimate

These are assumptions, to be checked against the actual Cloudflare price list in M4.
Workers Paid ($5/month) includes allowances.

| Driver | Assumption per active user per day | 1,000 users per month |
|---|---|---|
| Relay frames | 10 min with the app open on the relay while a session streams: about 5,000 frames | ≈ 150 M frames. Billed as WebSocket messages at 20:1 → ≈ 7.5 M requests |
| Durable Object duration | Awake only while frames flow (hibernation otherwise) ≈ 10 min | ≈ 2.3 M GB-s |
| Push | 20 pushes | 600 k Expo sends (free) and ≈ 600 k Worker requests |

The estimate is roughly **$30 to $60 per month per 1,000 daily active users** on the
relay path. Users who connect directly cost nothing.

## 7.10 Self-hosting

- **Relay.** Supported.
  1. Deploy `services/relay` to your own Cloudflare account (`wrangler deploy`, with
     your domain).
  2. Set the host's `relay.url` (`monocode-host relay enable --url wss://…`, or the
     desktop).
  3. Phones learn the URL from the offer and the welcome.
- **Push.** A gateway can only deliver to the app build whose credentials it holds.
  That is why each publisher track has its own deployment, and why each phone names
  its gateway when registering. The personal track is exactly this setup: the
  maintainer's gateway serves MonoCode Dev phones. A host can disable push for every
  device with `push.enabled: false`, and its phones then hide notification settings
  for that host.
- **A Node adapter** for non-Cloudflare self-hosting is a later item
  (`services/relay/src/node.ts`: the same protocol over `ws` and SQLite).
