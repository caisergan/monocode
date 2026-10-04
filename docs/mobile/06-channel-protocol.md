# 6. Channel protocol

The application protocol that runs inside the Noise channel. Version: **channel 1**.

## 6.1 Layers

```
application message   JSON envelope (§6.3)
record layer          type | flags | msgId | fragment     (03 §3.5)
Noise transport       ChaCha20-Poly1305, implicit nonces   (03 §3.4)
frame                 0x03 | noise message                 (03 §3.4)
WebSocket             binary message, ≤ 65,536 bytes
transport             direct TCP, or relay data socket      (05)
```

Design rules:

1. **Reuse, don't fork.** Every existing host method keeps its name, params and
   result over the channel. The handler code is shared with HTTP `/rpc`
   ([09 §9.2](09-host-changes.md#92-one-dispatcher-for-http-and-channel)). On the
   channel `version` and `environmentId` are implied by the handshake and are not
   repeated.
2. **Additive only.** New fields are optional. New methods, events, block roles and
   error codes are gated by capabilities or ignored when unknown.
3. **Pull-on-notify.** Deltas are computed by the existing `HostStore.sync` logic.
   The host pushes them to channels that watch a session. Nothing polls.

## 6.2 Handshake payloads

Carried in Noise message 1 (phone → host) and message 2 (host → phone).

```ts
type Hello = {
  v: 1;
  env: string;                        // host environmentId the phone expects
  n: number;                          // handshake counter; 0 when pairing
  channel: { min: 1; max: 1 };
  app: {
    name: "MonoCode";
    version: string;                  // "1.0.0"
    build: string;                    // "1000123"
    platform: "ios" | "android";
    os: string;                       // "18.1"
    model?: string;                   // "iPhone17,1"
  };
  caps: ClientCap[];                  // §6.4
  providers: string[];                // providers this build can render (REMOTE_PROVIDERS)
  presence?: Presence;
  pair?: { offer: string };           // only when pairing
};

type Presence = { visible: boolean; focusedSessionId?: string };

type Welcome = {
  ok: true;
  channel: 1;
  env: string;
  boot: string;                       // bootId, random per host process start
  time: number;                       // host Unix ms
  host: {
    name: string;                     // os.hostname()
    platform: "darwin" | "linux" | "win32";
    version: string;                  // host package version
    fingerprint: string;              // 03 §3.2
  };
  device: { id: string; name: string; role: "admin" | "member" };
  capabilities: string[];             // §6.4
  providers: RemoteProvider[];        // installed AND in hello.providers
  endpoints: Endpoint[];              // 05 §5.2
  relay: { url: string; room: string } | null;
  push: { enabled: boolean };         // false when the host disabled push
  limits: { maxMessage: number; maxInFlight: number; maxWatchedSessions: number };
};

type PairingWelcome = {
  ok: true;
  channel: 1;
  env: string;
  boot: string;
  time: number;
  host: Welcome["host"];
  pairing: { offer: string; expiresAt: number };
};

type HandshakeError = { ok: false; code: ChannelErrorCode; message: string };

type Endpoint =
  | { kind: "lan"; addr: string; port: number }
  | { kind: "tailscale"; addr: string; port: number; dns?: string }
  | { kind: "manual"; addr: string; port: number };
```

`welcome.providers` follows today's `environment.describe` rule. The host lists only
providers named in `hello.providers` (`host/server.ts`), so an older app never sees
a provider it can't render.

## 6.3 Envelope

```ts
type ClientMessage =
  | { t: "req"; id: number; m: string; p?: Record<string, unknown>; key?: string }
  | { t: "cancel"; id: number }
  | { t: "ping"; ts: number; presence?: Presence }
  | { t: "bye"; code: ByeCode };

type HostMessage =
  | { t: "res"; id: number; ok: true; r: unknown }
  | { t: "res"; id: number; ok: false; e: ChannelError }
  | { t: "evt"; e: string; d: unknown }
  | { t: "pong"; ts: number; now: number }
  | { t: "bye"; code: ByeCode; message?: string };

type ChannelError = {
  code: ChannelErrorCode;             // §6.11
  message: string;                    // human-readable, safe to show
  retryable: boolean;
  data?: unknown;
};

type ByeCode =
  | "rekey" | "replaced" | "background" | "device_revoked" | "host_stopping"
  | "protocol_error" | "idle_timeout" | "pairing_closed";
```

- **Request ids.** Per channel, starting at 1 and increasing. The host echoes them.
  Responses may come in any order.
- **`key`.** An idempotency key for mutating methods (§6.8). Commands carry their
  own `commandId` instead.
- **Timeouts** are client-side. Defaults: 30 s for reads, 60 s for mutations and
  commands, 120 s for `git.action` with `push`.
- **`cancel`** is best effort. The host stops streaming a large response if it
  hasn't been sent yet. It never undoes a mutation.
- **At most `limits.maxInFlight`** (64) requests per channel. Beyond that the host
  returns `rate_limited`.

## 6.4 Capabilities

`welcome.capabilities` contains everything `environment.describe` lists today
(`sessions`, `projects.browse`, `models.list`, `approvals`, `questions`, `diff`,
`git.branches`, `git.switch`, `git.createBranch`, `git.worktrees`,
`git.worktreeCreate`, `files.read`, `files.list`, `files.index`, `workspace.run`,
`files.search`, `files.searchContent`, `files.create`, `files.write`, `git.index`,
`git.fileDiff`, `git.action`, `attachments.upload`, `attachments.read`,
`sessions.draft`, `sessions.plan`), plus:

| Capability | Meaning | Required by the phone |
|---|---|---|
| `channel.watch` | `watch.set` and the events in §6.6 | ✓ |
| `sessions.window` | Windowed `sessions.sync`, `sessions.blocks`, `sessions.block` | ✓ |
| `sessions.page` | Paged session lists with `lastText` | ✓ |
| `inbox` | `inbox.list` and `inbox.changed` | ✓ |
| `devices` | `devices.list`, `devices.rename`, `devices.revoke` | ✓ |
| `pairing` | The `pairing.*` methods | Desktop only |
| `push` | `push.register`, `push.unregister`, `push.test` | Optional; the phone hides notification settings for the host without it |
| `presence` | `presence.update` and presence in pings | Optional |
| `sessions.queue` | `queue`, `unqueue`, `editQueued`, `steer`, `resumeQueue` commands | Optional; without it, Send is disabled while a turn runs |
| `sessions.createWithPrompt` | `create` with `initial` and `worktree` | Optional; without it, the phone uses two commands like the desktop |
| `mutations.idempotent` | Idempotency `key` honoured for mutating methods | Optional; without it, unsafe mutations are never retried |
| `host.config` | `host.config.get` and `host.config.set` | Optional |

**Client capabilities** (`hello.caps`):
- `deflate`: may receive record type `0x02`.
- `attention`: wants `attention` events.
- `windowedSync`: understands window fields.
- `truncatedBlocks`: understands `block.truncated`.

## 6.5 Method catalogue

### Existing methods available on the channel

| Method | Params → result | Kind | Retry safety | Phone uses |
|---|---|---|---|---|
| `environment.describe` | `{supportedProviders?}` → `HostDescriptor`, which gains an optional `hostVersion` (the host package version; the desktop uses it to offer updates) | read | safe | Diagnostics only (the welcome has it) |
| `projects.list` | `{}` → `HostProject[]` | read | safe | ✓ |
| `projects.browse` | `{path?}` → `HostDirectory` | read | safe | ✓ (open folder) |
| `projects.open` | `{cwd}` → `HostProject` | mutating | naturally idempotent | ✓ |
| `models.list` | `{projectId?}` → `HostModelCatalog` | read | safe | ✓ |
| `sessions.list` | `{projectId}` → `HostSessionSummary[]` | read | safe | Fallback for `sessions.page` |
| `sessions.update` | `{projectId, sessionId, title?, archived?, pinned?, linkedWorkItem?}` → summary | mutating | naturally idempotent | ✓ |
| `sessions.delete` | `{projectId, sessionId}` → `{deleted}` | mutating | retry: `not_found` counts as success | ✓ |
| `sessions.sync` | `{sessionId, revision?, window?, maxBlockChars?}` → `SessionSyncResponse` | read | safe | ✓ (§6.7) |
| `sessions.syncChunk` | `{sessionId, transfer, offset}` → `{data}` | read | safe | Only when a sync exceeds 16 MiB |
| `commands.dispatch` | `HostCommand` → `CommandReceipt` | command | idempotent by `commandId` | ✓ (§6.9) |
| `attachments.upload` | `{id, offset, size, data}` → `{offset}` | mutating | idempotent by offset (`host/attachments.ts`) | ✓ |
| `attachments.read` | `{sessionId, id, offset}` → `{data, offset, size}` | read | safe | ✓ |
| `devices.revokeSelf` | `{}` → `{revoked}` | mutating | idempotent | ✓ (remove host). On the channel it revokes the calling device by id, not by token |
| `git.worktrees` | `{projectId}` → `HostWorktree[]` | read | safe | ✓ |
| `git.worktreeCreate` | `{projectId, cwd?, branch, base?, existing?}` → `HostWorktree` | mutating | needs `key` | Fallback for `create.worktree` |
| `git.branches` | `{projectId, cwd?}` → branches | read | safe | ✓ (labels) |
| `git.index` | `{projectId, cwd?}` → `GitDiffIndex` | read | safe | ✓ Changes |
| `git.fileDiff` | `{projectId, cwd?, path, staged}` → `GitFileDiff` | read | safe | ✓ |
| `git.diff` | `{projectId, cwd?}` → unified diff text (2 MiB cap) | read | safe | ✓ ("all changes" view) |
| `git.action` | `{projectId, cwd?, action, path?, message?, content?}` → varies | mutating | needs `key` | ✓ commit, push (M6) |
| `files.list` | `{projectId, cwd?, path}` → entries | read | safe | ✓ |
| `files.read` | `{projectId, cwd?, path}` → text (1 MiB cap) | read | safe | ✓ |
| `files.search` | `{projectId, cwd?, query}` → matches | read | safe | ✓ (go to file) |

`workspace.run`, `files.write`, `files.create`, `files.index`, `files.searchContent`,
`git.switch` and `git.createBranch` stay available, but the phone doesn't call them
in v1. The host does not filter methods by device kind, only by role (§4.1).

### New methods

```ts
// ── watch and sync ─────────────────────────────────────────────────────────
"watch.set": (p: WatchSet) => {}                                     // §6.6
"sessions.sync": (p: { sessionId: string; revision?: number;
                       window?: SyncWindow; maxBlockChars?: number })
                 => SessionSyncResponse                              // extended, §6.7
"sessions.blocks": (p: { sessionId: string; before: string; turns: number;
                         maxBlockChars?: number })
                 => { blocks: Block[]; hasOlder: boolean; olderTurns: number; revision: number }
"sessions.block": (p: { sessionId: string; blockId: string }) => { block: Block; revision: number }
"sessions.page": (p: { projectId: string; archived?: "exclude" | "only" | "include";
                       limit?: number /* ≤ 200, default 50 */; cursor?: string })
                 => { items: SessionListItem[]; cursor?: string }
"inbox.list": (p: { limit?: number /* ≤ 200 */ }) => { boot: string; revision: number;
                                                       items: InboxItem[]; truncated: boolean }

// ── devices and pairing ────────────────────────────────────────────────────
"devices.list": () => Device[]                                  // member: only itself
"devices.rename": (p: { deviceId: string; name: string }) => Device
"devices.revoke": (p: { deviceId: string }) => { revoked: boolean } // admin, or self
"devices.events": (p: { limit?: number /* ≤ 500 */ })              // admin
                 => { at: number; deviceId?: string; type: string; detail?: string }[]
"pairing.create": (p: { relay?: boolean; ttlSeconds?: number; label?: string;
                         ui?: { theme: "dark" | "light" | "system"; hue: number; sat: number;
                                dark: number; accent: string | null } })
                 => { offerId: string; url: string; expiresAt: number; fingerprint: string;
                      reachable: { lan: boolean; tailscale: boolean; manual: boolean; relay: boolean } }
"pairing.status": (p: { offerId: string }) => PairingStatus
"pairing.decide": (p: { offerId: string; allow: boolean }) => PairingStatus
"pairing.cancel": (p: { offerId: string }) => PairingStatus
"pair.claim": (p: { offer: string; proof: string; name: string; platform: "ios" | "android";
                    model?: string; os?: string; appVersion: string; replacesDeviceId?: string })
              => { status: "pending" | "approved"; deviceId: string; code: string; welcome?: Welcome }

// ── notifications and presence ─────────────────────────────────────────────
"push.register": (p: PushRegistration) => { registered: true }
"push.unregister": () => { registered: false }
"push.test": () => { sent: boolean; error?: string }
"presence.update": (p: Presence) => {}                          // also on HTTP for the desktop

// ── host settings ──────────────────────────────────────────────────────────
"host.config.get": () => HostConfigView
"host.config.set": (p: HostConfigPatch) => HostConfigView       // admin
```

Shared types:

```ts
type SyncWindow = { anchor?: string; tailTurns?: number };   // §6.7

type SessionListItem = HostSessionSummary & {
  lastText?: string;          // last assistant text, markdown stripped, ≤ 280 chars
  finishedAt?: number;        // when the last turn settled
  queueLength?: number;
};

type InboxItem = {
  sessionId: string; projectId: string; projectName: string;
  title: string; harness: RemoteProvider; model?: string; runtimeMode?: RuntimeMode;
  status: "idle" | "running" | "interrupted";
  attention: "approval" | "question" | "error" | "interrupted" | "usage_limit" | "finished" | null;
  needsInput: boolean;
  approval?: { requestId: number; title: string; kind?: string; preview?: ToolPreview };
  question?: { requestId: number; title?: string; count: number; autoResolveAt?: number };
  lastText?: string;
  updatedAt: number;
  finishedAt?: number;
  branch?: string; worktreeCwd?: string;
  pinned?: boolean; archived?: boolean;
  revision: number;
  queueLength?: number;
};

type Device = {
  id: string; name: string; kind: "desktop" | "mobile"; role: "admin" | "member";
  status: "pending" | "active"; platform?: string; model?: string; appVersion?: string;
  createdAt: number; lastSeenAt?: number; lastSeenVia?: "http" | "direct" | "relay";
  current: boolean;           // the calling device
  push: boolean;              // has a push registration
};

type PairingStatus = {
  offerId: string;
  status: "open" | "claimed" | "approved" | "denied" | "expired" | "cancelled";
  expiresAt: number;
  device?: { id: string; name: string; platform: string; model?: string };
  code?: string;              // 6 digits, present from "claimed"
};

type PushRegistration = {
  gateway: string;            // https URL of the phone's publisher gateway (08 §8.6)
  ticket: string;             // sealed to that gateway, 03 §3.8
  gatewayKeyId: string;
  pushPublicKey: string;      // base64url X25519
  categories: { approval: boolean; question: boolean; finished: boolean;
                failed: boolean; usageLimit: boolean };
  preview: "full" | "minimal";
  mutedProjects?: string[];
  mutedSessions?: string[];
};

type HostConfigView = {
  relay: { enabled: boolean; url: string; status: "disabled" | "connecting" | "online"
           | "unauthorized" | "blocked" | "error" };
  direct: { mode: "off" | "private" | "all"; port: number; listening: string[];
            advertise: { addr: string; port: number }[] };
  push: { enabled: boolean; allowPrivateGateways: boolean };
  pairing: { requireConfirmation: boolean; linkBase: string };
};
type HostConfigPatch = {
  relay?: { enabled?: boolean; url?: string };
  direct?: { mode?: "off" | "private" | "all"; port?: number;
             advertise?: { addr: string; port: number }[] };
  push?: { enabled?: boolean; allowPrivateGateways?: boolean };
  pairing?: { requireConfirmation?: boolean; linkBase?: string };
};
```

**`lastText` and `finishedAt`** are computed in `summary()` (`host/store.ts`) and
stored in the existing `sessions.summary` JSON column, so they cost nothing per
request.

## 6.6 Watch and events

### `watch.set`

```ts
type WatchSet = {
  inbox?: boolean;
  projects?: string[];                 // ≤ 64 project ids
  sessions?: {                         // ≤ limits.maxWatchedSessions (8)
    id: string;
    revision?: number;                 // the phone's cached revision
    window?: SyncWindow;
    maxBlockChars?: number;
  }[];
};
```

**Semantics:**
- `watch.set` **replaces** the channel's watch state.
- For every watched session the host computes `sessions.sync` from the given
  revision and window right away. If the result isn't `unchanged`, it sends
  `evt session.sync`. Afterwards it sends a delta each time the session changes.
- The host keeps, per channel and per watched session, the **last revision it sent**,
  not the last revision acknowledged. The channel is ordered, so the phone applies
  every delta in order.
- After a reconnect the phone sends `watch.set` again with the revisions it actually
  holds. Nothing has to be remembered across connections.

### Events

| Event | Payload | When | Coalescing |
|---|---|---|---|
| `session.sync` | `{sessionId, sync: SessionSyncResponse}` | A watched session's revision changed | ≥ 100 ms apart per session. The engine already batches stream output every 120 ms (`host/engine.ts` `FLUSH_MS`) |
| `session.deleted` | `{sessionId, projectId}` | A watched session, or one in a watched project, was deleted | none |
| `project.sessions` | `{projectId}` | Any summary in a watched project changed | 500 ms; the phone refetches `sessions.page` |
| `projects.changed` | `{}` | A project was added | none |
| `inbox.changed` | `{boot, revision}` | Any inbox-relevant summary changed, if `inbox` is watched | 500 ms; the phone refetches `inbox.list` |
| `attention` | `AttentionEvent` ([08 §8.2](08-notifications.md#82-attention-events)) | An attention transition, sent to every device channel advertising `attention` | none |
| `pair.status` | `{status, welcome?}` | Pairing decided (pairing principal only) | none |
| `host.endpoints` | `{endpoints}` | The endpoint list changed | 5 s |
| `host.config` | `HostConfigView` | Relay or direct settings changed | none |
| `device.updated` | `Device` | This device was renamed | none |

Unknown events are ignored by the phone.

### Backpressure

- If a channel's outbound buffer passes 8 MiB, the host stops sending `session.sync`
  on it and marks each affected watch "dirty".
- When the buffer drains below 1 MiB, it sends one delta per dirty session, computed
  from the last revision it actually sent. Intermediate revisions are skipped.
  Deltas compose because `blockRevisions` are stamps, not diffs.

## 6.7 Windowed session sync

Today `sessions.sync` returns whole transcripts. A long session can be tens of MiB,
too much for a phone on cellular. The phone therefore asks for a **window**: the
blocks from an **anchor** block to the end.

**Params:**
- `window.anchor`: a block id. The window starts at that block.
- `window.tailTurns`: when there is no anchor, or it no longer exists, start at the
  user block that opens the Nth-from-last turn. A turn starts at each `role:"user"`
  block, as in `groupTurns`. Default 20, range 1 to 200.
- No `window` at all gives exactly today's behaviour, so the desktop is unaffected.

**Host algorithm**, in `HostStore.sync`, extended:

```
value  = session(id)
idx    = anchor present and found ? indexOf(anchor)
       : tailTurns ? startOfNthLastTurn(tailTurns) : 0
reset  = anchor present and not found
if revision == value.revision and not reset   → unchanged
if revision missing | revision > value.revision | no blockRevisions | reset
                                               → snapshot of blocks[idx..]
else                                           → delta:
     blockIds = ids of blocks[idx..]
     blocks   = blocks[idx..] where blockRevisions[id] > revision
window = { anchor: blocks[idx]?.id ?? null, olderTurns, olderBlocks }
apply maxBlockChars truncation to every block in the response
```

**Result additions:**
- `snapshot` and `delta` gain `window: {anchor: string|null, olderTurns: number,
  olderBlocks: number}`.
- `value.session.blocks` (snapshot) and `blockIds` (delta) cover only the window.
- The existing `applySessionSync` (`protocol.ts`) applies a windowed delta unchanged,
  because `blockIds` defines the list.

**Truncation** (`maxBlockChars`; the phone sends 20,000):

| Field | Kept |
|---|---|
| `text` (any role) | first `max` chars |
| `tool.detail` | last `max / 2` chars |
| `tool.preview.output` | last `max / 2` chars |
| `tool.preview.lines` | first 400 lines |
| `agentRun.steps` | last 100 steps, each truncated by the same rules |

- A truncated block gains `truncated: {chars: number}`, the original serialized
  length. That is a new optional field on `Block`, set only in transit.
- `sessions.block` returns the full block. Over 16 MiB it fails with
  `payload_too_large`, and the phone offers "Open on desktop".

**Older history.** `sessions.blocks {before, turns}` returns the `turns` turns that
end just before block `before`.
- The phone prepends them and makes the first returned block its new anchor.
- It sends the new anchor in its next `watch.set`, which goes out at once.
- Blocks in the new region that changed after the phone's revision arrive in the next
  delta, because the delta is computed over the whole new window.

**Phone algorithm** for an open session:

1. Paint the cached window at once, marked stale if it is older than the last
   reconnect.
2. `watch.set` with `{id, revision, window:{anchor}}`. A first open uses
   `{tailTurns: 20}`, or 8 under Low Data Mode.
3. On `evt session.sync`, apply the change with `applySessionSync`:
   - **`snapshot`:** replace the cached window.
   - **`delta`:** merge into the cached window.
   - **`unchanged`:** nothing to apply.
   - **Base mismatch** (should not happen on an ordered channel): request
     `sessions.sync {sessionId, window:{anchor}}` with no revision, which returns a
     snapshot.
4. Persist the new window and revision to the cache, debounced to 1 s while the
   session runs.
5. Scrolled near the top: if `olderTurns > 0`, call `sessions.blocks`.
6. Leaving the screen: drop the session from the watch, with a 30 s linger so quick
   back-and-forth doesn't churn.

## 6.8 Idempotency and retries

| Request class | Mechanism | Phone retry policy |
|---|---|---|
| Reads | none needed | Retried automatically on reconnect while the screen needs them |
| Commands (`commands.dispatch`) | `commandId`, host receipts (existing, `host/store.ts` `receipts`) | Through the persistent **outbox**: survives restarts, retried until a definitive result or expiry |
| Mutating methods with `mutations.idempotent` | `key` (UUID) in the envelope. The host keeps a `mutation_receipts` row `{key, method, paramsHash, result, createdAt}` for 24 h. The same key and params return the stored result. A key still in flight waits for the first execution | Retried in memory with the same key for up to 60 s while the app is alive. After that the UI shows "Result unknown. Refresh to check." |
| Mutating methods without that capability | none | Never retried automatically |

**Outbox entries** (phone SQLite):

```ts
type OutboxEntry = {
  commandId: string;                 // also the entry id
  hostEnv: string;
  command: HostCommand;              // fully formed, except a placeholder sessionId
  localSessionId?: string;           // for commands that follow a create
  dependsOn?: string;                // commandId of a create that must be acked first
  createdAt: number;
  expiresAt: number;                 // §6.9 table
  attempts: number;
  state: "pending" | "sending" | "acked" | "failed";
  receipt?: CommandReceipt;
  error?: ChannelError;
};
```

**Rules:**
1. Write the entry before the first send.
2. Send when the host is `online`, in FIFO order per session.
3. A receipt marks the entry `acked`.
   - For `send`, `queue` and `create`, the entry stays visible as "Sending…" until the
     session window contains a block with `id === commandId` (the host uses the
     command id as the user block id). It is then deleted. Without that block it is
     deleted after 10 min.
   - Other commands are deleted at once.
4. Error with `retryable:false`: the entry becomes `failed` and the UI explains it.
   - Codes: `invalid_params`, `stale_turn`, `already_resolved`, `session_busy`,
     `not_found`, `idempotency_conflict`, `capability_missing`,
     `provider_unavailable`.
   - The person can Retry (same `commandId`) or Discard. `already_resolved` and
     `stale_turn` are discarded automatically, with a quiet notice ("Answered on
     another device" / "This approval is no longer needed").
5. Transport loss or a retryable error: back to `pending`, then backoff
   `1, 2, 4, … 30 s`. Backoff resets when the host comes back online.
6. Expiry passed: the entry becomes `failed` with "Not sent. The host was
   unreachable." plus Retry and Discard. Approve, answer and cancel are discarded
   instead, since the turn has moved on.

## 6.9 Commands

Every existing `HostCommand` (`protocol.ts`) is valid on the channel, with the
host's existing validation limits (`host/engine.ts` `parseCommand`).

| Command | Fields | Outbox expiry |
|---|---|---|
| `create` | `{projectId, worktreeCwd?, autoWorktreeBranch?, harness, model, modelSettings?, runtimeMode}` + **new** `initial?`, `worktree?` | 24 h |
| `configure` | `{sessionId, model, modelSettings, runtimeMode}` | 1 h |
| `compact` | `{sessionId}` | 1 h |
| `send` | `{sessionId, text, attachments?, intent?, draftBlockId?, planBlockId?}` | 24 h |
| `draft` / `removeDraft` | as today | 24 h |
| `cancel` | `{sessionId, runId}` | 10 min |
| `approve` | `{sessionId, runId, requestId, decision}` | 10 min |
| `answer` | `{sessionId, runId, requestId, reply}` | 10 min |
| **`queue`** (new) | `{sessionId, text, attachments?, intent?}` | 24 h |
| **`unqueue`** (new) | `{sessionId, queuedId}` | 1 h |
| **`resumeQueue`** (new) | `{sessionId}` | 1 h |
| **`editQueued`** (new) | `{sessionId, queuedId, text}` | 1 h |
| **`steer`** (new) | `{sessionId, queuedId, runId}` | 10 min |

### `create` with `initial` and `worktree` (`sessions.createWithPrompt`)

```ts
{
  type: "create", commandId, projectId, harness, model, modelSettings?, runtimeMode,
  worktree?: { mode: "current" }
           | { mode: "existing"; cwd: string }
           | { mode: "new"; base?: string },          // base branch; default HEAD
  initial?: { text: string; attachments?: RemoteAttachment[]; intent?: "default" | "plan" }
}
```

- **`worktree.mode = "new"`.** The host creates the worktree with a temporary branch
  `mc/<first 8 hex chars of sha256(commandId)>`. Deriving it from the command id
  makes a retried create find and reuse the same worktree. It is then renamed after
  the first turn, as `autoWorktreeBranch` already does.
- **`initial`.** The host starts the first turn in the same transaction that records
  the receipt. One round trip, one outbox entry, and no window in which a session
  exists without its first message.
- **Async step.** Creating a worktree is asynchronous, but `HostEngine.command` is
  synchronous today. The new path keeps an in-memory `commandId → Promise` map so
  that a duplicate arriving mid-creation waits for the first one
  ([09 §9.6](09-host-changes.md#96-engine-changes)).

### Queue (`sessions.queue`)

The host reuses the existing session queue fields (`Session.queuedMessages`,
`queueStatus`) and the pure helpers in `messageQueue.ts` (`canDispatchQueuedHead`,
`dequeueQueuedMessage`).

- **`queue`:**
  - If the session is idle, with nothing queued and no usage limit, it behaves
    exactly like `send`.
  - Otherwise it appends `{id: commandId, text, attachments, intent}` to
    `queuedMessages`.
- **When a turn settles `idle`** without an error and the queue is `active`, the
  engine dispatches the head as a new turn. The user block id is the queued id, so
  the outbox entry resolves when it appears.
- **Pausing.** A turn that ends in error, interruption or a usage limit, or a
  `cancel`, sets `queueStatus:"paused"`. `resumeQueue` sets it back to `active` and
  dispatches if possible.
- **`unqueue`** removes one queued item. **`editQueued`** replaces a queued item's
  text in place.
- **`steer`** is the desktop queue's Steer action. It moves the item to the head,
  cancels the running turn (`runId` must match), and dispatches the item as soon as
  that turn settles, without pausing the queue.
- The desktop can render these fields as it already does for local sessions. Its
  remote overrides keep the queue handlers as no-ops until it adopts the commands.

## 6.10 Inbox semantics

`inbox.list` feeds the phone's **Agents** screen. The method keeps the name "inbox"
for protocol stability; the UI does not use the word, because MonoCode's Inbox is the
PR/issue inbox.

- **`attention`**, by priority:
  1. `approval`: an undecided `block.approval`.
  2. `question`: a `pendingQuestion`.
  3. `error`: the last turn ended with a `notice:"error"` block.
  4. `interrupted`: `status:"interrupted"`.
  5. `usage_limit`: `session.usageLimit` is set.
  6. `finished`: the last turn settled `idle` with none of the above.
  7. `null`: running, or no turn yet.
- **Item selection.** The inbox includes every session that is running, needs input,
  or has `updatedAt` within 7 days. Sorted by attention priority, then `updatedAt`
  descending. Capped at `limit` (default 200), with `truncated` set when capped.
- **`revision`** is a host-wide in-memory counter, bumped whenever an inbox-relevant
  summary field changes. It resets on restart, so the phone compares `(boot,
  revision)`.
- **Read state is the phone's.** Each phone stores `seenAt[sessionId]` and shows
  "Unread" when `finishedAt > seenAt`. The desktop keeps its own unseen-finished
  tracking (`sessionDone.ts`); syncing the two is a later item.

## 6.11 Errors

The host gains `class HostError extends Error { code; retryable; data? }`. HTTP
`/rpc` keeps its body `{error: message}` and adds `code`, so older desktops are
unaffected. Existing thrown messages map to codes:

| Code | `retryable` | Existing host message(s) |
|---|---|---|
| `invalid_params` | false | "Invalid …", "Session does not belong to this project", "Unsupported command" |
| `method_not_found` | false | "Unsupported host method" |
| `not_found` | false | "Session not found on this machine", "Project is not registered on this machine", "Draft not found" |
| `session_busy` | false | "This session is already running", "Wait for the current turn before changing settings", "Stop this session before deleting it", "Wait for running host sessions before switching branches", "This session cannot save another draft right now" |
| `branch_switching` | true | "Wait for the branch switch to finish", "A branch switch is already in progress" |
| `stale_turn` | false | "This request belongs to a finished or replaced turn" |
| `already_resolved` | false | "Approval is already resolved", "Question is already resolved" |
| `plan_not_ready` | false | "Plan is not ready to build" |
| `idempotency_conflict` | false | "Command ID was already used with a different payload" |
| `provider_unavailable` | false | "<provider> is not available on this host", "Context compaction is unavailable for this provider" |
| `payload_too_large` | false | "Request is too large" |
| `host_stopping` | true | "Host is stopping" |
| `transfer_expired` | true | "Session transfer expired; reload the session" |
| `unauthorized` | false | "Device credential is invalid or revoked" (HTTP only) |
| `forbidden` | false | New: role check failed |
| `capability_missing` | false | New: method or command field not supported by this host |
| `rate_limited` | true | New |
| `internal` | false | Anything else (the message is logged; the phone shows a generic text) |

**Handshake and pairing codes:**
- Handshake: `unknown_device`, `device_revoked`, `device_pending`,
  `replayed_handshake`, `host_identity_changed`, `protocol_incompatible`,
  `rate_limited`.
- Pairing: `pairing_expired`, `pairing_used`, `pairing_cancelled`,
  `pairing_proof_invalid`, `device_key_in_use`.

## 6.12 Versioning and compatibility

- **`channel` stays 1** as long as changes are additive. A breaking change would be
  channel 2. The phone and host then negotiate the highest common version, and both
  keep version 1 for at least 12 months.
- **Phone minimums.** The phone requires `channel.watch`, `sessions.window`,
  `sessions.page`, `inbox`, `devices`, `sessions`, `approvals`, `questions` and
  `models.list`. A host missing any of them is `blocked(protocol_incompatible)`,
  with "Update the host" guidance.
- **Optional capabilities** degrade per feature (§6.4). The phone checks a
  capability once per welcome, never per call.
- **Unknown data:**
  - Unknown block roles render as a neutral row with `block.text`, plus a link to
    "Update MonoCode to see this content".
  - Unknown fields are ignored.
  - Unknown error codes are treated as `internal`.
- **Compatibility shims** carry `// COMPAT(<name>): added host vX.Y, remove after
  YYYY-MM` so they can be found and removed.
- **Shared types.** Wire types live in `@monocode/core` (session, blocks, protocol)
  and `@monocode/channel` (envelope, handshake, new methods). Host and phone are
  type-checked against the same definitions. Runtime validation on the phone uses
  small hand-written guards on hot paths. `session.sync` payloads are trusted after
  structural checks, since they come from an authenticated host. That avoids
  Zod-on-Hermes costs.

## 6.13 Example exchange

```jsonc
// msg1 payload (phone → host)
{"v":1,"env":"6f0b…","n":118,"channel":{"min":1,"max":1},
 "app":{"name":"MonoCode","version":"1.0.0","build":"1000123","platform":"ios","os":"18.1","model":"iPhone17,1"},
 "caps":["deflate","attention","windowedSync","truncatedBlocks"],
 "providers":["codex","claude","cursor","grok","opencode","pi","omp","fx","hermes","antigravity"],
 "presence":{"visible":true}}

// msg2 payload (host → phone)
{"ok":true,"channel":1,"env":"6f0b…","boot":"b7c1…","time":1759999999123,
 "host":{"name":"mac-mini","platform":"darwin","version":"0.9.0","fingerprint":"7G2K-9QXM-4TNB-WR8C-D1PZ"},
 "device":{"id":"1f3a…","name":"Ege's iPhone","role":"member"},
 "capabilities":["sessions","approvals","questions","models.list","channel.watch","sessions.window", "…"],
 "providers":["claude","codex"],
 "endpoints":[{"kind":"lan","addr":"192.168.1.20","port":3775}],
 "relay":{"url":"wss://relay.usemono.dev","room":"Q2hh…"},
 "push":{"enabled":true},
 "limits":{"maxMessage":16777216,"maxInFlight":64,"maxWatchedSessions":8}}

// phone → host
{"t":"req","id":1,"m":"watch.set","p":{"inbox":true,"sessions":[{"id":"s-42","revision":311,"window":{"anchor":"b-900"},"maxBlockChars":20000}]}}
// host → phone
{"t":"res","id":1,"ok":true,"r":{}}
{"t":"evt","e":"session.sync","d":{"sessionId":"s-42","sync":{"kind":"delta","base":311,"value":{"…":"…"},"blockIds":["b-900","…","b-951"],"blocks":[{"id":"b-951","role":"tool","text":"npm test","tool":{"kind":"execute","status":"pending"},"approval":{"requestId":7}}],"window":{"anchor":"b-900","olderTurns":12,"olderBlocks":240}}}}
{"t":"evt","e":"attention","d":{"sessionId":"s-42","projectId":"p-1","kind":"approval","requestId":7,"title":"Claude needs approval","body":"Run: npm test"}}

// phone → host
{"t":"req","id":2,"m":"commands.dispatch","p":{"type":"approve","commandId":"c-77","sessionId":"s-42","runId":"r-9","requestId":7,"decision":"allow"}}
// host → phone
{"t":"res","id":2,"ok":true,"r":{"commandId":"c-77","sessionId":"s-42","revision":313}}
{"t":"evt","e":"session.sync","d":{"sessionId":"s-42","sync":{"kind":"delta","base":312,"…":"…"}}}
```
