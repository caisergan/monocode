# 5. Connectivity

## 5.1 Model

A phone reaches a host over a WebSocket, either **direct** (straight to the host's
channel listener) or **relay** (through the relay room the host keeps open).

On both paths the bytes inside are the same Noise channel ([03](03-identity-and-crypto.md)),
so everything above the transport is identical. The phone races candidates,
keeps the first channel that completes a handshake, and moves to a direct path when
one becomes available.

```
phone ──ws://192.168.1.20:3775/v1/channel──────────────────────────▶ host   (direct, LAN)
phone ──ws://100.101.12.7:3775/v1/channel──────────────────────────▶ host   (direct, Tailscale)
phone ──wss://relay.usemono.dev/v1/client?room=R──▶ relay ◀──wss── host     (relay)
```

## 5.2 Endpoints

### Kinds

| Kind | Meaning | Example |
|---|---|---|
| `lan` | A private address on a physical or Wi-Fi interface of the host | `192.168.1.20:3775`, `[fd12:3456::20]:3775` |
| `tailscale` | A tailnet address of the host, plus its MagicDNS name when known | `100.101.12.7:3775`, `mac-mini.tail1234.ts.net` |
| `manual` | An address the user configured on the host: a port forward, a VPN outside private ranges, a reverse proxy | `dev.example.com:443` |
| `relay` | The relay room | `wss://relay.usemono.dev`, room `R` |

### Host-side discovery (`host/channel/endpoints.ts`)

- Every 15 s, read `os.networkInterfaces()` and classify each address:
  - **`lan`:**
    - IPv4 in `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`.
    - IPv6 in `fc00::/7`.
    - Exclude loopback, link-local (`169.254.0.0/16`, `fe80::/10`) and virtual
      interfaces whose names start with `docker`, `br-`, `veth`, `virbr`, `vmnet`,
      `vboxnet`, `bridge`, `awdl`, `llw` or `lo`.
  - **`tailscale`:** IPv4 in `100.64.0.0/10` or IPv6 in `fd7a:115c:a1e0::/48`, on any
    interface. If a `tailscale` binary is on `PATH`, run `tailscale status --json`
    (2 s timeout, cached 5 min) and take `Self.DNSName` without its trailing dot as
    `dns`.
  - **`manual`:** `config.json` `direct.advertise: [{addr, port}]`, verbatim.
- Order the list `lan` (interface `en0`/`eth0`/`wlan0` first), then `tailscale`,
  then `manual`. Cap it at 8.
- When the list changes, the host pushes `evt host.endpoints` to every open channel.
  The welcome always carries the current list ([06 §6.2](06-channel-protocol.md#62-handshake-payloads)).

### Phone-side memory

- For each host, the phone stores the candidate list from the last welcome, falling
  back to the offer.
- For each candidate key `kind|addr|port` it also stores `lastSuccessAt`,
  `lastFailureAt`, `consecutiveFailures` and `rttMs` (an exponentially weighted
  moving average).
- A Tailscale candidate with `dns` is tried by IP first. The name is a second
  candidate, since iOS may not resolve MagicDNS without the Tailscale VPN active.

## 5.3 The host's direct listener

- **Path.** `GET /v1/channel` with `Upgrade: websocket`. Any other request gets 404.
  Requests with an `Origin` header get 403, so browsers can't reach it.
- **Port.** `config.json` `direct.port`, default **3775**. The existing HTTP RPC
  stays on `127.0.0.1:3774`, unchanged.
- **Bind modes** (`direct.mode`):

  | Mode | Behaviour | Default |
  |---|---|---|
  | `private` | One listener per `lan` and `tailscale` address. Listeners are added and removed as the 15 s interface scan changes | ✓ |
  | `all` | One dual-stack listener on `::`. For port forwards and unusual VPN ranges. The host logs a warning at start, and the desktop shows "Listening on all interfaces" | |
  | `off` | No listener. Phones use the relay only | |

- **Server.** It uses Node `http.createServer` plus the `ws` package in `noServer`
  mode, bundled by esbuild. `maxPayload` is 70 KiB, since every WebSocket message
  is one frame of at most 65,536 bytes ([03 §3.4](03-identity-and-crypto.md#34-the-noise-channel)).
  `perMessageDeflate` is off: the record layer compresses before encryption, and
  ciphertext doesn't compress.
- **Firewalls.** The host binary is the packaged `node` under
  `~/.monocode-host/runtime`.

  | OS | Issue | Handling |
  |---|---|---|
  | macOS | With the Application Firewall on, an unsigned `node` accepting connections may be blocked silently, because a LaunchAgent can't show the prompt | `monocode-host doctor` checks `socketfilterfw --getglobalstate` and prints the `--add`/`--unblockapp` command. The desktop's local setup offers to run it (it needs an admin password) |
  | Windows | Defender Firewall blocks inbound connections for `node.exe` unless a rule exists | `doctor` prints a `New-NetFirewallRule` command scoped to the private profile and port 3775. The desktop's local setup offers to run it elevated |
  | Linux | `ufw`/`firewalld` may block 3775 | `doctor` detects an active firewall and prints the allow command for the LAN subnet |

  In all three cases the relay still works, so a blocked direct path costs latency,
  not function.

## 5.4 The host's relay client

Enabled by `config.json` `relay.enabled` (default `false` until the user consents in
a pairing dialog or the CLI).

- **Control socket.**
  - The host keeps one outbound socket,
    `wss://<relay>/v1/host?room=<roomId>`, authenticated with the relay key
    ([07 §7.3](07-relay-and-push-service.md#73-host-control-socket)).
  - It reconnects with backoff of `min(30 s, 1 s × 2^n)` ±20 % jitter, reset after
    60 s connected.
- **Data sockets.**
  - When the relay announces a phone connection `c`, the host opens
    `wss://<relay>/v1/host/data?room=<roomId>&conn=<c>` (signed the same way).
  - It then runs the same channel server logic on it as on a direct socket.
- **Status** is shown in `monocode-host relay status`, the desktop's machine details
  and `doctor`: `disabled`, `connecting`, `online`, `unauthorized` (room key
  mismatch), `blocked` (HTTP 4xx), or `error`.
- Turning the relay off closes the control socket and every data socket. Phones
  connected through it reconnect directly or go offline.

## 5.5 Transport racing

The phone runs a race when it first connects, reconnects, or foregrounds a host that
didn't answer the verify ping.

**1. Eligible candidates** depend on the current network (Network.framework `NWPathMonitor`):

| Phone network | Eligible |
|---|---|
| Wi-Fi or Ethernet | all `lan`, `tailscale`, `manual`, `relay` |
| Cellular | `tailscale`, `manual`, `relay`. `lan` is skipped unless the current path has a VPN interface |
| None | none; go to `offline` immediately |

**2. Order:**
1. The candidate that succeeded most recently, if within 24 h.
2. Then `lan`.
3. Then `tailscale` by IP, then by name.
4. Then `manual`.

Within a kind, order by fewest consecutive failures, then lowest `rttMs`.

**3. Schedule** (happy-eyeballs style):
- Start the first direct candidate at t = 0, then one more every 200 ms.
- Start the relay at t = 1,200 ms.
- Start the relay at t = 0 instead when any of these hold:
  - there are no eligible direct candidates;
  - the last 3 connections all ended up on the relay;
  - the phone is on cellular and has no `tailscale` or `manual` candidates.

**4. Per-attempt deadlines:**
- WebSocket open: 2.5 s direct, 6 s relay.
- Handshake, from sending message 1 to the welcome: 5 s.

**5. Winner:**
- The first attempt that receives a valid welcome wins. All other attempts are
  closed. A handshake that completes after the winner is closed with
  `bye{code:"replaced"}`.
- The winner's transport and RTT, measured by the first ping, are recorded.

**6. Overall deadline: 20 s.** If nothing wins, the host goes to `offline`
(§5.7). Fast failures shorten it:
- Every candidate refused or timed out, and the relay answered close code 4404
  ("host not connected"): go to `offline` at once with reason `host_unreachable`.
- A `blocked` reason from an authenticated message 2 (`device_revoked`,
  `unknown_device`, `protocol_incompatible`) stops the race at once.

Two transports can both reach the handshake. Each sends its own `hello.n`, and the
host's replay window accepts both ([03 §3.4](03-identity-and-crypto.md#34-the-noise-channel)).

## 5.6 Upgrading from relay to direct

- **When.** While a host's channel uses the relay and the app is in the foreground,
  the phone probes direct candidates:
  - every 60 s;
  - at once after a network change;
  - at once after `evt host.endpoints`.
- **How.** A probe is the §5.5 race restricted to direct candidates. It sends no
  `watch.set` until it wins.
- **Switch rule.** Switch when a probe completes and its first ping RTT is at most
  `relayRtt × 1.5 + 20 ms`.
  - Direct is preferred even when slightly slower: it costs the relay nothing and
    exposes no metadata to it.
  - The probe's channel is closed otherwise.
- **Switching steps:**
  1. Send `watch.set` with the current watch state on the new channel.
  2. Route new requests to the new channel.
  3. Let the old channel finish its in-flight requests for up to 10 s, then close it
     with `bye{code:"replaced"}`.
  4. If the old channel closes without answering an in-flight **command**, the
     outbox resends it on the new channel. Commands are idempotent by `commandId`.
     Unsafe non-command requests follow [06 §6.8](06-channel-protocol.md#68-idempotency-and-retries).
- **Downgrade** happens only on failure: a lost direct channel goes through a normal
  reconnect race, relay included.

## 5.7 Per-host connection state

```
          ┌────────────── foreground / pull to refresh / network change ──────────────┐
          ▼                                                                           │
 idle ─▶ connecting ──welcome──▶ online(direct|relay) ──lost──▶ reconnecting ──20 s──▶ offline
                │                     ▲                            │                   │
                │                     └──────── welcome ───────────┘◀── backoff timer ──┘
                └── authenticated error ──▶ blocked(reason) ── user action / app update ──▶ connecting
```

| State | Meaning | Host status UI |
|---|---|---|
| `idle` | Not connected and not trying (app in background, or host not needed) | Last known status, unchanged |
| `connecting` | First race since launch or foreground | Cached content; a spinner only after 1 s |
| `online` | A channel is up | Green dot. Host details add "Direct · Wi-Fi", "Direct · Tailscale" or "Relay", and the RTT |
| `reconnecting` | The channel was lost; racing again | Nothing for the first 3 s, then amber "Reconnecting…" |
| `offline` | No route; retry with backoff `1, 2, 4, 8, 16, 30 s` ±20 %, capped at 30 s | Grey "Offline · seen 5 min ago" |
| `blocked` | Needs a person: `device_revoked`, `unknown_device`, `host_identity_changed`, `protocol_incompatible`, `app_too_old` | Red, with the reason and an action ([04 §4.9](04-pairing.md#49-errors-and-copy)) |

- **Backoff is bypassed:** on foreground, on a network change, on pull-to-refresh,
  when the user opens a session on that host, and when the outbox has a new entry
  for the host.
- **Blocked hosts** are retried only on foreground (once) or after an app update.
  `protocol_incompatible` also retries hourly, since the host may have been updated.
- The **3 s grace** before showing `reconnecting` matches the multi-host plan. Short
  blips never flicker the UI. Requests made during the grace wait in the request
  queue (§5.11).

## 5.8 Liveness

| Check | Who | Interval | Failure rule |
|---|---|---|---|
| App ping | Phone → host `{t:"ping"}` | 15 s while foreground and online | No `pong` in 5 s marks the channel suspect. A second consecutive miss closes it and starts a reconnect |
| Foreground verify | Phone | Once per foreground, per online host | No `pong` in 2 s: close and race at once |
| Idle timeout | Host | n/a | Closes a channel that sent nothing for 45 s |
| Relay keepalive | Relay ↔ both sides | WebSocket protocol pings, handled at the Cloudflare edge | Relay closes dead sockets; the phone sees code 1006 or 1012 |
| Host control socket | Host → relay ping | 20 s | Two misses: reconnect the control socket |
| Channel lifetime | Host | 24 h | `bye{code:"rekey"}`; the phone reconnects at once |

The `pong` carries `now` (host Unix ms). The phone keeps a per-host clock offset and
uses it for anything the host timestamps:
- `UserQuestionPrompt.autoResolveAt` countdowns;
- "updated 2 min ago" labels;
- offer expiry.

## 5.9 Limits and rate limits

| Limit | Value | Where |
|---|---|---|
| WebSocket message | ≤ 65,536 bytes (1-byte kind + Noise message) | Both ends and the relay |
| Assembled application message | 16 MiB | Record layer |
| Unauthenticated sockets per IP | 8 concurrent, 20 handshakes/min | Host |
| Unauthenticated sockets total | 64 | Host |
| Channels per device | 4 (oldest closed with `bye{code:"replaced"}`) | Host |
| Channels total | 64 | Host |
| Handshake deadline | 10 s from socket open | Host |
| Pairing claims per offer | 3 failed proofs, then cancelled | Host |
| Requests in flight per channel | 64 (excess gets `rate_limited`, `retryable:true`) | Host |
| Outbound buffer per channel | 8 MiB, then events are coalesced (§6.6) and P2 sends pause | Host |
| Relay limits | See [07 §7.6](07-relay-and-push-service.md#76-limits-and-abuse-controls) | Relay |

## 5.10 App lifecycle

| Event | Behaviour |
|---|---|
| Moves to background (`scenePhase` becomes `.background`) | Send `presence{visible:false}`. Flush the outbox under `UIApplication.beginBackgroundTask` (≤ 25 s). Close channels with `bye{code:"background"}` after the flush or after 30 s. A running Commit and push continues as a `BGContinuedProcessingTask` ([16 §16.6.6](16-ios-native-design.md#1666-project-screen-explorer-changes)) |
| Suspended or killed | Nothing runs. Pushes arrive through APNs. The Notification Service Extension decrypts them. A `BGAppRefreshTask` flushes outbox entries left behind, when iOS grants one |
| Returns to foreground | Verify pings for hosts that are still open. Race the rest without backoff. Send `presence{visible:true}` and `watch.set` |
| Network change (`NWPathMonitor`) | Verify active channels (2 s ping). Probe direct if on the relay. Race hosts that are offline |
| Low Data Mode (`NWPath.isConstrained`) | Fewer turns per session window (8 instead of 20). Attachment previews load on tap only. Compression stays on |
| Notification tapped while killed | Cold start goes straight to the session route. The cached transcript paints first, then a channel is raced for that host before any others |

Android is out of v1 (D19). A later Android app follows the same rules, with channels
closed 60 s after backgrounding and no foreground service.

The app never keeps a socket open in the background. Pushes cover the background.

## 5.11 Many hosts

- In the foreground the phone connects **every** paired host, up to 8 concurrent
  channels, because the Agents screen shows all of them. Beyond 8, it connects the hosts
  with the most recent activity. The others connect when opened, and Agents shows their
  cached rows dimmed.
- Each host has its own runtime ([12 §12.4](12-mobile-engineering.md#124-host-runtime)),
  with its own state, backoff, request queue and watch.
- **Request queue while not online:**
  - Reads wait up to 15 s for `online`, then fail with `offline`. The screen shows
    cached data.
  - Commands go to the outbox and survive app restarts ([06 §6.8](06-channel-protocol.md#68-idempotency-and-retries)).

## 5.12 Diagnostics

Host details → **Connection** shows:

- The current transport, endpoint, RTT, clock offset, connected-since time and
  `bootId` age.
- The last 50 connection events: race start, each candidate result (open
  failed / refused / timeout / handshake failed / won), state changes and `bye`
  codes.
- **Test connection.** It runs a full race with every candidate, not stopping at the
  first winner, and reports each result.
- **Copy diagnostics.** A redacted text bundle: host id prefix, versions, network
  type, candidate results, last errors. It contains no keys or content.
