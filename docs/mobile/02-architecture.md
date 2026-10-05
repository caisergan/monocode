# 2. Architecture

## 2.1 What exists today

| Piece | Where | Relevant facts |
|---|---|---|
| Desktop app | `src/`, `src-tauri/` | Tauri + React 19. Local sessions run provider adapters in the webview (`src/integrations/harness/providers/*`) through Tauri child-process IPC (`core/child.ts`). They are stored in `monocode.db` (`session_store.rs`) |
| Headless host | `host/` | Node 24 bundle (`host/build.mjs`, esbuild). Reuses the same TS adapters through a swappable `ChildBackend` (`host/child-backend.ts`, `configureChildBackend`). Stores projects, sessions, receipts, an event journal and devices in `~/.monocode-host/host.db` (`host/store.ts`) |
| Host API | `host/server.ts` | `POST /rpc` on `127.0.0.1:3774`, JSON `{version:1, environmentId, method, params}`, `Authorization: Bearer <43-char token>`. No browser origins. About 30 methods |
| Session engine | `host/engine.ts` | Commands with `commandId` idempotency (sha256 signature + `receipts` table). Streamed provider events batched every 120 ms; approvals, questions and errors written at once. Interrupted turns marked on restart, never replayed |
| Sync model | `host/store.ts`, `protocol.ts` | Each session has a `revision` and per-block revisions. `sessions.sync{revision}` returns `unchanged`, `delta` (changed blocks + ordered `blockIds`) or `snapshot`. Over 4 MiB it is served in chunks (`host/sync-transfer.ts`) |
| Pairing today | `host/cli.ts`, `src-tauri/src/remote.rs`, `remote_ssh.rs` | `monocode-host pair --name X --json` prints `{id, token, environmentId}`. The desktop runs it over SSH, keeps the token in `remote-machines.json` (0600) and reaches the host through an `ssh -L` forward |
| Desktop remote client | `src/features/connections/` | Polls `sessions.sync` every 0.75 s (running) or 3 s, `sessions.list` every 3 s, `environment.describe` every 15 s. Outbox of commands in `localStorage` |

The host is already the right shape for a phone: it owns state, it speaks in
revisions and deltas, and commands are idempotent. What is missing is a way for a
phone to reach it, authenticate, and be told about changes without polling.

**Basis (D13).** This spec extends upstream MonoCode's shipped remote host: the Node
host, host-owned sessions, and the desktop's HTTP RPC with SSH setup. The fork's
earlier Paseo-style proposal for a Rust daemon with client-side session history
(`docs/multi-host.md` on `feat/multi-host-support`) is superseded and not used here.

Upstream's own docs mention a future Rust daemon/worker split
(`docs/remote-access.md`, "the planned Rust daemon/worker IPC"). Nothing in this spec
depends on the host being Node:
- The channel is Noise plus JSON, with published test vectors. The Rust `snow` crate
  implements the same Noise pattern.
- Methods and events are defined as wire schemas, not as TypeScript internals.

A Rust host could therefore serve the same phones unchanged.

**Upstreaming.** Host and desktop changes ([09](09-host-changes.md),
[10](10-desktop-changes.md)) are written to land upstream. Official host packages, and
the official app, depend on upstream releases. Until then the personal track builds
its own host packages ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)).

## 2.2 Target components

```
                         ┌──────────────────────────────────────────────┐
                         │ Relay + push gateway (Cloudflare Worker)     │
                         │  • Durable Object per room: rendezvous,      │
                         │    forwards ciphertext frames                │
                         │  • /v1/push: verifies host signature,        │
                         │    opens push ticket, forwards to APNs       │
                         │    (HTTP/2, token auth)                      │
                         └───────▲───────────────────────▲──────────────┘
              wss (ciphertext)   │                       │ wss, dialled out by host
                                 │                       │ + HTTPS push requests
┌────────────────────────┐       │        ┌──────────────┴─────────────────────────────┐
│ Phone (iOS, Swift)     │───────┘        │ monocode-host (one per OS user per machine) │
│  • HostRuntime per     │                │  • existing: engine, store, adapters,      │
│    host: candidates,   │  ws (Noise)    │    HTTP /rpc on 127.0.0.1:3774             │
│    racing, channel     │───────────────▶│  • new: channel server on private          │
│  • sync, cache, outbox │  direct: LAN / │    interfaces :3775, relay client,         │
│  • UI                  │  Tailscale/VPN │    pairing, watch/events, attention,       │
│  • NSE (push decrypt)  │                │    push sender, presence                   │
└──────────▲─────────────┘                └──────────────▲─────────────────────────────┘
           │ push (APNs)                                 │ HTTP /rpc (loopback or ssh -L)
           │                                ┌────────────┴─────────────┐
     Apple APNs ◀──────────────────── gateway│ Desktop app (Tauri)      │
                                            │  • Settings → Mobile:    │
                                            │    local host install,   │
                                            │    pairing QR, devices   │
                                            │  • existing remote views │
                                            └──────────────────────────┘
```

- **Phone.** A client of one or more hosts. It holds a separate device key per host,
  keeps a cache, and never talks to the desktop app directly.
- **Host.** Unchanged as the agent runtime. It gains a second front door, the
  channel, beside the existing loopback HTTP RPC.
- **Desktop.** It manages hosts. It is the usual place to start pairing, it can
  install a host on its own computer, and it keeps using HTTP RPC.
- **Relay and push gateway.** One small stateless-by-design service. It forwards
  ciphertext and delivers encrypted pushes. It is the only component run by the
  project rather than the user, and it can be self-hosted.

## 2.3 Trust boundaries

| Boundary | Who is trusted | Enforced by |
|---|---|---|
| Phone ↔ host | Each side, by its static key | Noise IK with the host key pinned from the offer and the device key registered at pairing ([03](03-identity-and-crypto.md)) |
| Phone ↔ relay | Nobody | Relay sees only Noise ciphertext and connection metadata |
| Host ↔ relay | Relay trusts the room owner key; host trusts nothing | Ed25519 room claim ([07](07-relay-and-push-service.md)) |
| Host ↔ push gateway | Gateway trusts signed requests for tickets bound to the room | Ed25519 request signature + sealed push ticket |
| Gateway ↔ APNs ↔ phone | Nobody, for content | Payload sealed to the phone's push key |
| Desktop ↔ host | Desktop holds an admin device token | Existing bearer token over loopback or SSH forward |
| Phone storage | The phone's OS | Keychain for keys; an encrypted cache ([12 §12.6](12-mobile-engineering.md#126-persistence), spike S18) |

Every paired device can run agents as the host's OS user. Pairing is therefore
equivalent to granting shell access, and the UI says so.

## 2.4 Data ownership

| Data | Owner | Phone holds |
|---|---|---|
| Projects, sessions, blocks, revisions | Host (`host.db`) | A windowed cache per session ([06 §6.7](06-channel-protocol.md#67-windowed-session-sync)) |
| Attachments sent by the phone | Host (`~/.monocode-host/attachments`) | The original until the upload is acknowledged |
| Model catalog | Host (provider discovery, 5 min cache) | Last catalog per host and project |
| Devices, roles, push targets, presence | Host | Its own device id and keys |
| Pairing offers | Host (DB table, 10 min TTL) | Nothing after pairing |
| Notification preferences | Phone (sent to each host as a filter) | Authoritative copy |
| Seen / unread state | Phone | Authoritative; desktop keeps its own (not synced in v1) |
| Host list, labels, colours, endpoint candidates | Phone | Authoritative |
| Relay room claim | Relay Durable Object storage | n/a |

## 2.5 What changes where

| Component | Change | Spec |
|---|---|---|
| `packages/core` (new) | Shared session model, protocol types, transcript grouping, previews, diff parsing, formatting | §2.6 |
| `packages/channel` (new) | Noise, record layer, envelope types, offer codec, push crypto, error codes | [03](03-identity-and-crypto.md), [06](06-channel-protocol.md) |
| `packages/design`, `packages/brand` (new) | MonoCode's tokens, motion, icon aliases and brand assets, parity-tested against the desktop | [11](11-design-and-ux.md), [12 §12.11](12-mobile-engineering.md#1211-design-system) |
| `host/` | Keys, device v2 table, pairing, channel server, relay client, watch/events, windowed sync, inbox, queue, atomic create, mutation idempotency, attention + push, presence, config, CLI | [09](09-host-changes.md) |
| `services/relay` (new) | Worker + Durable Objects: relay rooms and push gateway | [07](07-relay-and-push-service.md) |
| `src-tauri/`, `src/` | Local host install, Settings → Mobile, pairing dialog, device list, presence calls, allow-list additions | [10](10-desktop-changes.md) |
| `apps/ios` (new) | The Swift app: Xcode project, app and Notification Service Extension targets, local Swift packages (MonoChannel, MonoWire, MonoStore, MonoSync, MonoDesign, MonoTranscript, MonoHighlight, MonoDemo) | [11](11-design-and-ux.md), [12](12-mobile-engineering.md), [15](15-performance.md), [16](16-ios-native-design.md) |
| `apps/mobile` (prototype) | The Expo app built on `feat/mobile-app`. Frozen as the reference for the Swift rewrite and deleted at parity (D19) | [14 "As built"](14-roadmap.md#as-built-2026-10-04-branch-featmobile-app) |
| `.github/workflows` | Package builds, relay deploy, iOS build and test jobs | [13](13-testing-and-release.md) |

## 2.6 Repository layout and shared code

### Layout

```
monocode/
  package.json            # root stays the desktop app; adds "workspaces"
  src/  src-tauri/  host/ # unchanged locations
  packages/
    core/                 # @monocode/core: pure TS shared by desktop and host
    channel/              # @monocode/channel: secure channel + wire types
    design/               # @monocode/design: tokens, motion, icon aliases (parity-tested)
    brand/                # provider logos, app icon, mascots, sound cues
  apps/
    ios/                  # the Swift app (Xcode project + local Swift packages), 16 §16.3
    mobile/               # the Expo prototype, frozen; deleted at parity (D19)
  services/
    relay/                # Cloudflare Worker (@monocode/relay)
```

- The root `package.json` gains `"workspaces": ["packages/*", "services/*"]`.
  The desktop remains the root package, so `npm run tauri dev`, the release
  workflow and the pre-push hook keep working.
- `apps/ios` is not an npm package. Its scripts (`gen-design-tokens.mjs`,
  `gen-fixtures.mjs`) run with the root's Node and import the workspace packages
  ([16 §16.5](16-ios-native-design.md#165-keeping-the-swift-client-compatible-with-the-host)).
- `apps/mobile` stays its own npm project, outside the workspaces, until it is
  deleted.
- The host bundle (`host/build.mjs`) already bundles whatever it imports, so moving
  modules into packages changes import paths only.

### What moves into `@monocode/core`

From the code-sharing audit. "Clean" means no DOM, `window`, `localStorage`, Tauri
or React DOM, directly or transitively.

**Move as is (already clean):**

- `features/connections/model/protocol.ts`, `remoteAttachmentPreviews.ts` (pure parts)
- `features/sessions/model/`: `userQuestion.ts`, `contextUsage.ts`, `taskList.ts`,
  `plan.ts`, `transcriptActivity.ts`, `transcriptFind.ts`, `monocodeToolCall.ts`,
  `messageQueue.ts`, `compact.ts`, `draftCommand.ts`, `sessionTitle.ts`,
  `sessionDone.ts`, `usageLimit.ts`, `sessionSurface.ts`
- `features/sessions/data/sessionHistory.ts`, `sessionCache.ts`
- `integrations/harness/core/types.ts`, `apply.ts`, `preview.ts`, `streamText.ts`,
  `shellIntent.ts`
- `shared/lib/`: `relativeTime.ts`, `numbers.ts`, `fuzzy.ts`, `jsonText.ts`,
  `listWindow.ts`, `remotePaths.ts`
- `features/source-control/model/`: `gitText.ts`, `gitGraph.ts`, `prDiff.ts`,
  `workingTreeDiff.ts`
- `features/files/model/markdownFileLinks.ts`, `fileName.ts`, plus `inlineFileName` and
  `isExtensionlessFileName` extracted from `sessions/ui/AgentMarkdown.tsx` (the
  file-chip rule), and the Material Icon Theme name/extension resolution used by
  `FileTypeIcon`;
  `features/sessions/ui/hardBreaks.ts` (a rehype plugin, no React)

**Move after a small split (offender → fix):**

| Module | Offender | Fix |
|---|---|---|
| `sessions/model/session.ts` | Runtime import of `models.ts` and `projectProviders.ts` (circular); type-only imports of inbox, notes and orchestration types | Move the card and meta types into core; replace the `loadProjectProviderSettings` call with an injected lookup |
| `sessions/model/models.ts` | `localStorage` for favourites, recents, defaults | Inject a `KeyValueStore` interface (desktop: `localStorage`; host: in-memory). The static catalog and `resolveModel` move unchanged |
| `sessions/model/attachments.ts` | Tauri `invoke`, `pickFiles`, `URL`/`File` | Extract `MAX_ATTACHMENTS`, `isVisionImage`, `normalizeImageMime`, `mergeAttachments`. This also removes a Tauri import from the host bundle |
| `connections/model/remoteModels.ts` | Imports `claudeCatalog.ts`, which imports Tauri `homeDir` | Move the static `CLAUDE_MODEL_CATALOG` constant to its own file. Move `findRemoteModel` and `carryModelSettings` into core |
| `connections/model/remoteSessionState.ts`, `remoteProjects.ts` | `localStorage`, `window` events | Split pure path helpers (`remotePath`, `parseRemotePath`) from storage |
| `source-control/model/worktrees.ts` | Tauri and workspace layout | Extract `namedWorktreeBranch` (the host's only use) |
| `source-control/model/unifiedDiff.ts`, `lineDiff.ts` | Import `@codemirror/merge` and `@codemirror/state` | Write a small pure unified-diff parser in core. Desktop keeps its CodeMirror-based views |
| `platform/tauri/fs.ts` | Holds wire types (`GitDiffIndex`, `GitFileDiff`, `FsEntry`, …) used by the host | Move the types to `core/wire/workspace.ts`; the Tauri file re-exports them |
| `shared/lib/paths.ts` | `IS_WIN` from the client platform | Add host-platform-aware variants that take `HostDescriptor.platform` |

**Stays desktop-only:** `src/platform/tauri/*`, `src/app/*`, all `*.tsx` UI, the
terminal, editor, notifications, quick composer, automations, `connections.ts`.

### Mechanics

1. Move each file with `git mv` into `packages/core/src/…`, keeping its colocated
   `*.test.ts`. About 70 model tests run unchanged.
2. Leave a one-line re-export at the old path
   (`export * from "@monocode/core/sessions/userQuestion"`) so desktop imports keep
   compiling. Remove the shims in a later mechanical PR.
3. `packages/core/tsconfig.json` uses `lib: ["ES2023"]` with **no DOM**, so any
   accidental DOM use fails type-checking. This is stricter than `host/tsconfig.json`,
   which includes DOM today.
4. Root `vitest.config.ts` adds `packages/**/*.test.ts`.
5. `packages/core` exports subpaths (`@monocode/core/protocol`,
   `@monocode/core/sessions/session`, …).
6. The Swift app does not import these packages. It ports the parts it needs into
   MonoWire, and golden fixtures generated from this code keep the port honest
   ([16 §16.4](16-ios-native-design.md#164-porting-map)).

### `@monocode/channel`

New code, used by the host, host tests and a debug CLI, also no DOM. The Swift app's
MonoChannel is a port of it, held to the same vectors and to fixtures generated from
it ([16 §16.5](16-ios-native-design.md#165-keeping-the-swift-client-compatible-with-the-host)):

- `noise/`: `Noise_IK_25519_ChaChaPoly_SHA256` handshake state, cipher state,
  transport. Built on `@noble/curves`, `@noble/ciphers`, `@noble/hashes`.
- `record.ts`: fragmentation, reassembly, compression flags ([03 §3.5](03-identity-and-crypto.md#35-record-layer)).
- `envelope.ts`: message types, request ids, error codes ([06](06-channel-protocol.md)).
- `offer.ts`: offer encode/decode and validation ([04](04-pairing.md)).
- `push.ts`: push payload seal/open ([03 §3.7](03-identity-and-crypto.md#37-push-payload-encryption)).
- `client.ts`: a transport-agnostic channel client (used by host tests, the debug CLI
  and the fixture generator).
- `vectors/`: Noise test vectors (the cacophony vectors for this pattern) and
  cross-implementation push vectors.
