# MonoCode Mobile: product and technical specification

Status: **draft for review** (rev 3, 2026-10-04). Nothing here is implemented yet.
Rev 2 recorded the owner's answers: the official-app framing, MonoCode design parity,
upstream's remote host as the only architecture basis, and the publisher setup.
Rev 3 adds the hybrid architecture (a native transcript) and app-wide smoothness
budgets ([15](15-performance.md)).

This folder is the complete plan for a MonoCode phone app. The app pairs with one or
more machines that run coding agents. It shows their sessions, lets you reply,
approve and steer them, and notifies you when an agent needs you. The machines are
headless MonoCode hosts, or the same computer that runs the MonoCode desktop app.

It is planned as **MonoCode's official agent app**. It uses the desktop's design
language, adapted to phones, and builds on upstream MonoCode's shipped remote host
(`host/`, `docs/remote-access.md`). Until an official publisher takes over, it is
built and run under the maintainer's own Apple and Expo accounts for local workflows
([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)).

## Reading order

| # | Document | What it settles |
|---|---|---|
| 1 | [Product](01-product.md) | Goals, non-goals, users, journeys, release scope, success metrics |
| 2 | [Architecture](02-architecture.md) | Components, trust boundaries, data ownership, repository layout, shared code |
| 3 | [Identity and cryptography](03-identity-and-crypto.md) | Keys, the Noise channel, record layer, push encryption, secret storage, threat model |
| 4 | [Pairing](04-pairing.md) | Offers, QR and link format, every pairing flow, confirmation, device lifecycle, revocation |
| 5 | [Connectivity](05-connectivity.md) | Endpoints, the direct listener, relay use, transport racing, reconnect, background behaviour |
| 6 | [Channel protocol](06-channel-protocol.md) | Envelope, handshake payloads, RPC catalogue, subscriptions, windowed sync, idempotency, errors, versioning |
| 7 | [Relay and push service](07-relay-and-push-service.md) | The Cloudflare Worker: relay rooms, host auth, push gateway, limits, operations, self-hosting |
| 8 | [Notifications](08-notifications.md) | Attention engine, presence, push policy, payloads, iOS and Android delivery, actions, badges |
| 9 | [Host changes](09-host-changes.md) | Every change to `host/`: modules, schema migrations, CLI, config, tests |
| 10 | [Desktop changes](10-desktop-changes.md) | Local host install, Settings → Mobile, pairing dialog, device management, Rust allow-list |
| 11 | [Design language and UX](11-design-and-ux.md) | MonoCode's design language translated to phones (tokens, type, materials, motion, components), navigation, every screen and state, transcript rendering, composer, approvals, voice and copy |
| 12 | [Mobile engineering](12-mobile-engineering.md) | Stack, modules, runtime, stores, cache, outbox, rendering, device security, build config |
| 15 | [Performance and smoothness](15-performance.md) | The hybrid architecture, the native transcript, native chrome, per-surface rules, budgets and benchmark gates (read after 12) |
| 13 | [Testing and release](13-testing-and-release.md) | Test strategy, QA matrix, CI, EAS, store submission, compatibility, compliance |
| 14 | [Roadmap](14-roadmap.md) | Milestones, spikes, exit criteria, estimates, risks, open questions |

## Summary

- **The host is the source of truth.** `monocode-host` (`host/`) already runs the
  provider adapters, owns the session database and serves revisioned, delta-capable
  snapshots (`host/store.ts`, `host/engine.ts`). The phone is a thin, cached client
  of that model, and it never runs agents.
- **One secure channel, two ways to reach it.** The phone opens a WebSocket either
  directly to the host (same LAN, Tailscale, VPN) or through a relay that the host
  dials out to. Over either path the same `Noise_IK_25519_ChaChaPoly_SHA256` session
  authenticates both ends with static keys and encrypts everything. The relay only
  ever sees ciphertext.
- **Pairing is a QR code.** The QR carries a short-lived, single-use offer: host key,
  endpoints, relay room and a pairing secret. The desktop shows it for any machine it
  manages, and `monocode-host pair --mobile` prints it in a terminal. The phone scans
  it, proves it knows the secret, and the person at the QR screen confirms with one
  tap while both screens show the same 6-digit code.
- **Your own computer counts.** The desktop can install and run a `monocode-host` on
  the computer it runs on and pair a phone with it. Sessions in projects opened on
  "This computer" are visible on both. Today's in-app local sessions stay desktop-only.
- **Push without content leaks.** The host decides when you need attention: an
  approval, a question, a finished or failed turn. It encrypts the notification to a
  key held only by the phone and sends it through a small push gateway that runs in
  the relay Worker. iOS decrypts in a Notification Service Extension and Android in a
  background task.
- **It looks like MonoCode.** The same neutral tinted surfaces, accent, 13 px-scale
  type, chips, session cards, "Worked for…" fold lines, provider icons and motion as
  the desktop, recomposed for one hand and touch. Users' desktop appearance settings
  (theme, tint, accent) can be mirrored on the phone.
- **Native-smooth.** Expo runs the app, but the navigation, tabs, sheets, menus and
  glass are the platform's own components. The transcript is a native view that
  measures every row before showing it and paints text with the platform text engine.
  Streaming never goes through React. The target is zero hitches while flinging a
  1,000-turn transcript during streaming, measured on real devices.
- **Shared TypeScript.** The session model, transcript grouping, tool previews, host
  protocol types and the new channel code move into workspace packages used by the
  desktop, the host and the Expo app.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Expo / React Native, one codebase for iOS and Android | User, 2026-10-04 |
| D2 | Direct connection first (LAN/Tailscale/VPN), end-to-end-encrypted relay as fallback | User, 2026-10-04 |
| D3 | The desktop can run a local `monocode-host`; the phone sees sessions in projects opened on it. Existing in-app local sessions stay desktop-only | User, 2026-10-04 |
| D4 | A hosted push gateway with end-to-end-encrypted payloads | User, 2026-10-04 |
| D5 | The host stays the single source of truth. The phone caches, it never owns state | Derived from the existing host design |
| D6 | One channel protocol over both transports. Noise with pinned static keys, no TLS certificates | [03](03-identity-and-crypto.md) |
| D7 | Per-device, per-host keys. Mobile devices are `member`s: they cannot pair other devices or change host settings | [04](04-pairing.md) |
| D8 | Existing RPC methods are reused unchanged over the channel. New behaviour is additive and gated by capabilities | [06](06-channel-protocol.md) |
| D9 | Pull-on-notify sync. The host pushes small revision deltas for watched sessions; the phone never polls | [06](06-channel-protocol.md) |
| D10 | The relay and push gateway are one Cloudflare Worker with a Durable Object per host room. It is self-hostable, and the URL is a host setting | [07](07-relay-and-push-service.md) |
| D11 | The desktop keeps its existing HTTP RPC to hosts. Only new host-management methods are added to its allow-list | [10](10-desktop-changes.md) |
| D12 | The app is planned and branded as MonoCode's official agent app, matching the desktop's design language and voice, adapted to mobile | Owner, 2026-10-04 |
| D13 | Architecture basis is upstream's shipped remote host (Node host, host-owned sessions, HTTP RPC). The fork's Rust daemon proposal (`docs/multi-host.md` on `feat/multi-host-support`) is superseded. The channel protocol stays language-neutral so a future upstream Rust daemon could implement it | Owner, 2026-10-04 |
| D14 | Builds run under the maintainer's Apple Developer and Expo accounts for now (personal track). Every publisher-specific value lives in one publisher config, so an official publisher can take over without code changes | Owner, 2026-10-04 |
| D15 | The relay stays off until someone opts in at pairing time or in settings | Owner, 2026-10-04 |
| D16 | Phones may choose Full access, after a confirmation | Owner, 2026-10-04 |
| D17 | Hybrid architecture: Expo for the app, plus a native transcript component (`MonoTranscriptView`, iOS and Android) that measures rows off the main thread and paints with the platform text engine. The same engine powers the diff and file viewers | Owner, 2026-10-04 |
| D18 | App-wide smoothness is a requirement: native navigation, tabs, sheets, menus and glass; UI-thread-only animation; budgets enforced by device benchmarks | Owner, 2026-10-04 |

## Glossary

| Term | Meaning |
|---|---|
| Host | A `monocode-host` process (one per OS account per machine) that runs agents and stores sessions |
| Machine | The desktop's word for a host it is connected to (`Settings → Connections`) |
| This computer | The local host the desktop installs on its own machine (D3) |
| `environmentId` | The host's permanent identity (UUID in the host DB `metadata` table). The phone's `hostId` is the same value |
| `bootId` | A random id generated each time the host process starts |
| Host key | The host's static X25519 key for Noise. Its SHA-256 is the host fingerprint |
| Relay key | The host's Ed25519 key that authenticates it to the relay and push gateway |
| Room | The relay rendezvous slot for one host, named by a random `roomId` |
| Device | A paired client (desktop or phone), with an id, name, role and credential stored on the host |
| Device key | A phone's static X25519 key for one host |
| Push key | The phone's X25519 key used to decrypt notification payloads |
| Offer | A single-use pairing invitation encoded in a QR code or link |
| Channel | An authenticated Noise session between a phone and a host over a WebSocket |
| Watch | The set of sessions, projects and inbox a channel wants change events for |
| Attention | A reason to notify a person: approval, question, finished, failed, interrupted, usage limit |
| Outbox | The phone's persisted queue of commands that have not yet been acknowledged by the host |

## Conventions in this spec

- File references point at the current `dev` tree, for example `host/engine.ts:414`.
  Line numbers drift, so treat them as hints.
- "MUST", "SHOULD" and "MAY" are used in their RFC 2119 sense in protocol and security
  sections only.
- Sizes use binary units (KiB, MiB). Durations use `ms`, `s`, `min`, `h`.
- Domains such as `usemono.dev` and `relay.usemono.dev` are the **official track**
  values. The personal track uses the maintainer's own domains or none. Both come from
  the publisher config ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)),
  and none are hard-coded in the host protocol.
- Items that depend on a platform behaviour we have not verified are marked
  **(spike Sn)** and listed in [Roadmap → spikes](14-roadmap.md#142-m0-spikes).
