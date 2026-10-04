# 12. Mobile engineering

## 12.1 Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Expo SDK 57 (current when this was written; pin the exact SDK in M0), React Native New Architecture, Hermes | Upgrade once per release cycle |
| Architecture | **Hybrid** (D17): Expo app plus the native transcript module `MonoTranscriptView` (Swift and Kotlin, Expo Modules API) | [15](15-performance.md) |
| Language | TypeScript `strict`, React Compiler on | Shares `@monocode/core` and `@monocode/channel` |
| Navigation | Expo Router (typed routes) on the `react-native-screens` native stack; `NativeTabs` (`expo-router/unstable-native-tabs`) for the tab bar and its iOS 26 bottom accessory; native form sheets with detents | [11 §11.10](11-design-and-ux.md#1110-navigation), [15 §15.2](15-performance.md#152-architecture-by-surface) |
| State | Zustand stores, plus one runtime object per host that lives outside React | §12.4, §12.5 |
| Storage | `expo-sqlite` with SQLCipher; `expo-secure-store`; `expo-sqlite/kv-store` for small preferences | §12.6 |
| Lists | `@shopify/flash-list` v2 for every list except the transcript, with deterministic row heights | §12.9 |
| Transcript, diff viewer, file viewer | `MonoTranscriptView` (native) | [15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview) |
| Animation and gestures | `react-native-reanimated` 4, `react-native-gesture-handler`, `react-native-keyboard-controller` | Bezier timings from `@monocode/design` (desktop parity); springs only for gesture hand-off ([11 §11.1](11-design-and-ux.md#111-design-parity-rules) M8) |
| Materials and effects | `expo-glass-effect` (`GlassView`, `GlassContainer`: Liquid Glass on iOS 26), `expo-blur` (before iOS 26), `@react-native-masked-view/masked-view` + `expo-linear-gradient` (shimmer), `@shopify/react-native-skia` (title particles, effort tiles, pixel ring) | [11 §11.4](11-design-and-ux.md#114-shape-materials-and-elevation), [§11.6](11-design-and-ux.md#116-motion) |
| Sound | `expo-audio` playing the exported `cuelume` cues | [11 §11.8](11-design-and-ux.md#118-sound-and-haptics) |
| Icons | Hugeicons: `@hugeicons/react-native` with `@hugeicons/core-free-icons` in React; build-time native vector assets for the transcript and tab bar | The desktop's icon family and stroke 1.75 |
| Context menus | Native context menus (UIMenu / Android popup), via a maintained library or Expo UI (spike S12) | [15 §15.2](15-performance.md#152-architecture-by-surface) |
| Crypto | `react-native-quick-crypto` (JSI, native) for X25519 and ChaCha20-Poly1305 on the hot path; `@noble/*` for the Noise state machine glue, tests and vectors; `expo-crypto` `getRandomValues` | Keeps per-frame JS work in budget ([15 §15.5](15-performance.md#155-budgets)) |
| Compression | `fflate` (deflate-raw) | |
| Markdown | `unified` + `remark-parse` + `remark-gfm` → transcript `RowSpec`s (incremental tail parse) | §12.9 |
| Code highlighting | Shiki core with the JavaScript regex engine, producing styled runs for the native transcript, computed in idle slices or a worklet runtime; fallback `highlight.js` | Spikes S1, S13 |
| Images | `expo-image`, `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker` | |
| Camera / QR | `expo-camera` (barcode scanning) | |
| Notifications | `expo-notifications`, `expo-task-manager`; iOS Notification Service Extension via `@bacons/apple-targets` | [08](08-notifications.md) |
| Device features | `expo-haptics`, `expo-local-authentication`, `expo-clipboard`, `expo-sharing`, `expo-linking`, `@react-native-community/netinfo` | |
| SVG | `react-native-svg` + `react-native-svg-transformer` (provider logos, file-type icons, mascots) | |
| Testing | Jest (`jest-expo`) for the app, Vitest for shared packages, React Native Testing Library, Maestro for end-to-end; XCTest and Jetpack Macrobenchmark for performance | [13](13-testing-and-release.md), [15 §15.6](15-performance.md#156-measurement-and-gates) |

No analytics or crash-reporting SDK ships in v1 ([12.16](#1216-logging-and-diagnostics)).

## 12.2 Project layout (`apps/mobile`)

```
apps/mobile/
  app.config.ts              # identifiers, permissions, plugins (12.14)
  eas.json                   # build profiles (13.5)
  app/                       # Expo Router routes (11.2)
  src/
    channel/                 # transports (direct, relay, memory) + FrameSocket adapters
    hosts/                   # HostRuntime, registry, candidates, race, upgrade probe
    sync/                    # WatchManager, session windows, inbox merge, apply pipeline
    outbox/                  # outbox engine and persistence
    storage/                 # sqlite (schema, migrations), secure store, kv
    push/                    # registration, handlers, categories, background task
    pairing/                 # offer parsing, pairing state machine
    transcript/              # row model, renderers per block kind, markdown, code, diff
    composer/                # input, chips, pickers, attachments, queue view
    approvals/               # approval card, sticky bar, question sheet
    workspace/               # changes, diff viewer, files, file viewer
    settings/                # settings screens
    ui/                      # design system: tokens, primitives, sheets, toasts
    security/                # app lock, privacy overlay
    demo/                    # demo host
    log/                     # ring-buffer logger and diagnostics export
    strings.ts               # all user-facing text
  modules/
    background-task/         # Expo module: begin/end background task (iOS)
    transcript/              # MonoTranscriptView: src/ (TS spec + bridge), ios/ (Swift, TextKit 2/CoreText),
                             #   android/ (Kotlin, StaticLayout); fixtures shared with tests (15.4)
  scripts/
    build-native-assets      # Hugeicons, brand SVGs, mascots → iOS asset catalog + Android VectorDrawables
  targets/
    notification-service/    # Swift NSE (8.7) + expo-target.config.js
  plugins/                   # config plugins (12.14)
```

## 12.3 Code shared with the desktop and host

The app imports these from `@monocode/core` ([02 §2.6](02-architecture.md#26-repository-layout-and-shared-code)):

- **Types:** `Session`, `Block`, `HostSession`, `HostSessionSummary`, `HostCommand`,
  `SessionSync`, `RemoteAttachment`, `AgentModel`, `ModelSetting`, `RuntimeMode`,
  `UserQuestionPrompt`, `ToolPreview`, `ContextUsage`.
- **Logic:**
  - `applySessionSync`, `groupTurns`, `groupTurnItems`, `buildActivityPhases`,
    `workSummaryLine`;
  - `toolCallState`, `resolveToolCallDisplay`, `isHiddenTool`;
  - `buildQuestionReply`, `questionIsComplete`;
  - `planTitle`, `buildPlanPrompt`;
  - `sessionNeedsInput`, `compareSessionSummaries`;
  - `findRemoteModel`, `carryModelSettings`, `isEffortSettingId`;
  - `contextPercent`, `formatTokens`, `relativeTime`, `fuzzy`, `truncateBlock`,
    `plainTextPreview`;
  - a pure unified-diff parser.
- **Constants:** `REMOTE_PROVIDERS`, `HARNESS_LABEL`/`HARNESS_TITLE`, runtime-mode
  labels and hints, attachment limits.

From `@monocode/channel`: the Noise initiator, the record layer, the envelope types,
the offer codec and push crypto (`open`).

## 12.4 Host runtime

One `HostRuntime` per paired host (`src/hosts/HostRuntime.ts`). It is a plain class,
created at startup from the host registry, outside React.

```ts
type HostConnState =
  | { kind: "idle" } | { kind: "connecting" }
  | { kind: "online"; transport: "direct" | "relay"; endpoint: string; rttMs: number; since: number }
  | { kind: "reconnecting"; since: number }
  | { kind: "offline"; reason: "no_network" | "host_unreachable" | "timeout"; retryAt: number; lastOnlineAt?: number }
  | { kind: "blocked"; reason: "device_revoked" | "unknown_device" | "host_identity_changed"
                            | "protocol_incompatible" | "app_too_old" };

class HostRuntime {
  readonly env: string;
  state: HostConnState;
  welcome?: Welcome;
  clockOffsetMs: number;                 // hostNow - localNow
  connect(reason: ConnectReason): void;  // no-op when online; bypasses backoff for user/OS reasons
  verify(timeoutMs?: number): Promise<boolean>;
  request<T>(method: string, params?: object,
             opts?: { key?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
  setWatch(watch: WatchSet): void;       // debounced 50 ms; resent after every (re)connect
  subscribe(listener: (e: RuntimeEvent) => void): () => void;   // state | evt | welcome
  onAppState(state: "active" | "background"): void;
  onNetwork(info: NetInfoState): void;
  dispose(): void;
}
```

**Transports** (`src/channel/`):

```ts
interface Transport {
  kind: "direct" | "relay" | "memory";
  key: string;                           // candidate key "lan|192.168.1.20|3775"
  open(signal: AbortSignal): Promise<FrameSocket>;
}
interface FrameSocket {
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
}
```

- **Direct and relay** both use the React Native `WebSocket`, with `binaryType =
  "arraybuffer"`:
  - Direct: `ws://<addr>:<port>/v1/channel`, with IPv6 literals bracketed.
  - Relay: `wss://…/v1/client?room=…&v=1`.
- **Memory** connects the demo host (§12.13) and tests.

**The race** (`src/hosts/race.ts`) implements [05 §5.5](05-connectivity.md#55-transport-racing).
- Each attempt is `open` → `ChannelClient.handshake(hello)` → welcome.
- Losers are aborted through their `AbortSignal`.
- The winner's `FrameSocket` and cipher states become the runtime's `Channel`.

**`Channel`** (`@monocode/channel/client`):
- request and response matching with timeouts;
- an event emitter;
- `ping` every 15 s with presence;
- priority send queues;
- reassembly limits.

It knows nothing about React or storage.

**Request queue.**
- While the runtime isn't `online`, `request()` waits up to 15 s for a channel, then
  rejects with `offline`.
- Commands never go through `request()` directly. They go through the outbox (§12.8).

## 12.5 Stores

Zustand stores hold UI-facing state. Runtimes and engines write to them, and
components read with selectors.

| Store | Contents | Written by |
|---|---|---|
| `hosts` | `HostRecord[]` (registry) and each runtime's `HostConnState` | Registry, runtimes |
| `inbox` | Per host `{boot, revision, items, fetchedAt}`; merged and sectioned with memoised selectors | Inbox sync |
| `projects` | Per host `HostProject[]`, plus per project `SessionListItem[]` pages and cursor | Project sync |
| `sessions` | Per open session: `HostSession` window, `window` meta, `revision`, `freshness: "cached" | "live"`, and ids of loading older pages | WatchManager apply pipeline |
| `outbox` | Entries by host and session, as a view of the SQLite table | Outbox engine |
| `catalogs` | Model catalogs per host and project | Composer |
| `ui` | Composer drafts (debounced to KV), sheet state, toasts, app lock state | Components |

Selectors are narrow, for example `useSession(env, id, s => s.status)`. Streaming
deltas never re-render React: the transcript is fed by the row builder through the
native bridge, so the header and composer re-render only when their own fields change.

## 12.6 Persistence

**SQLite** (`monocode.db` in the app's documents directory, excluded from backups):
- encrypted with SQLCipher (`expo-sqlite` `useSQLCipher` config option);
- the key is 32 random bytes in secure storage (`mc.cache.dbKey`);
- WAL mode.

```sql
CREATE TABLE schema (version INTEGER NOT NULL);
CREATE TABLE hosts (env TEXT PRIMARY KEY, record TEXT NOT NULL);           -- HostRecord JSON (no secrets)
CREATE TABLE projects (env TEXT, id TEXT, json TEXT NOT NULL, updated_at INTEGER,
                       PRIMARY KEY (env, id));
CREATE TABLE session_items (env TEXT, id TEXT, project_id TEXT, json TEXT NOT NULL,
                            updated_at INTEGER, PRIMARY KEY (env, id));
CREATE INDEX session_items_project ON session_items (env, project_id, updated_at DESC);
CREATE TABLE session_windows (env TEXT, id TEXT, revision INTEGER NOT NULL, anchor TEXT,
                              json TEXT NOT NULL, bytes INTEGER NOT NULL, opened_at INTEGER NOT NULL,
                              PRIMARY KEY (env, id));
CREATE TABLE inbox (env TEXT PRIMARY KEY, boot TEXT, revision INTEGER, json TEXT NOT NULL,
                    fetched_at INTEGER NOT NULL);
CREATE TABLE outbox (command_id TEXT PRIMARY KEY, env TEXT NOT NULL, session_key TEXT,
                     json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
                     expires_at INTEGER NOT NULL);
CREATE TABLE seen (env TEXT, session_id TEXT, seen_at INTEGER NOT NULL, PRIMARY KEY (env, session_id));
CREATE TABLE catalogs (env TEXT, project_id TEXT, json TEXT NOT NULL, fetched_at INTEGER,
                       PRIMARY KEY (env, project_id));
CREATE TABLE candidates (env TEXT, key TEXT, stats TEXT NOT NULL, PRIMARY KEY (env, key));
```

```ts
type HostRecord = {
  env: string; label: string; color: string;
  hostName: string; platform: string; fingerprint: string;
  hostKey: string;                       // public, pinned
  deviceId: string; role: "admin" | "member";
  endpoints: Endpoint[];
  relay: { url: string; room: string } | null;
  pushEnabled: boolean;                  // host side; the gateway comes from the publisher config
  pairedAt: number; lastOnlineAt?: number;
  lastWelcome?: Pick<Welcome, "host" | "capabilities" | "providers" | "limits">;
  notifications: { enabled: boolean; categories: PushRegistration["categories"];
                   preview: "full" | "minimal"; mutedProjects: string[]; mutedSessions: string[] };
};
```

**Secure storage keys:**

| Key | Value |
|---|---|
| `mc.host.<env>.deviceKey` | X25519 private key |
| `mc.host.<env>.counter` | Handshake counter, written before every attempt |
| `mc.push.key`, `mc.push.key.prev` | Push private keys, in the shared keychain group on iOS |
| `mc.cache.dbKey` | SQLCipher key |
| `mc.pending.pairing` | The pending pairing record ([04 §4.7](04-pairing.md#47-phone-screens)) |
| `mc.applock` | App lock settings |

**Budgets and eviction:**
- `session_windows` is capped at 64 MiB in total. Windows are evicted by oldest
  `opened_at`. A window with outbox entries pending is never evicted.
- A single window over 4 MiB is kept in memory only.
- The image cache (`expo-image` disk cache) is capped at 200 MiB.
- Summaries and inbox data are small and never evicted while the host is paired.

**Migrations.** A `schema.version` integer with forward-only migration functions. A
failed migration drops the cache tables, but never `outbox` or `hosts`, and refetches.

## 12.7 Sync engine

- **WatchManager** (`src/sync/watch.ts`) turns UI interest into one `WatchSet` per
  host. Hooks register interest with reference counts:
  - `useInboxWatch()` (mounted by the Agents tab, and by the app shell while the app is
    active);
  - `useProjectWatch(env, projectId)`;
  - `useSessionWatch(env, sessionId)`.

  A session leaves the watch 30 s after its last subscriber unmounts. At most 8
  sessions per host are watched; beyond that, the least recently viewed is dropped.
- **Apply pipeline** for `session.sync`:
  1. Run `applySessionSync(window, sync)` from core. On a base mismatch, request a
     snapshot (no revision, same anchor).
  2. Update the window meta.
  3. Write the store, and pass the changed blocks to the row builder, which sends ops
     to `MonoTranscriptView` once per frame (§12.9).
  4. Persist, debounced: 1 s while running, immediately on settle.
- **Agents (inbox data):** on `inbox.changed`, or a host coming online, call `inbox.list` if `(boot,
  revision)` differs. Merge across hosts in a selector.
- **Projects:** on `project.sessions`, refetch the first page of `sessions.page`
  for that project. Further pages load on scroll.
- **Freshness.** A session window is `cached` until the first `session.sync` (or
  `unchanged`) after the current watch was sent. Then it is `live`. A reconnect
  resets it to `cached`.

## 12.8 Outbox engine

Implements [06 §6.8](06-channel-protocol.md#68-idempotency-and-retries).

- `enqueue(env, command, opts)` writes to SQLite, then wakes the sender. A host with a
  new entry is connected immediately.
- **Sender, per host:**
  - Runs while the host is `online`.
  - Takes entries in `created_at` order, skipping those whose `dependsOn` isn't acked.
  - Sends through `runtime.request("commands.dispatch", command)`.
- **Ids for commands that follow a `create`.** They carry a local session id. When the
  create's receipt arrives, the engine rewrites their `sessionId` in SQLite before
  sending.
- **Optimistic UI.** The transcript shows user blocks from `send`, `queue` and
  `create.initial` entries until a block with the same id arrives. Approval cards show
  "Sending…" while an `approve` entry is pending.
- **Background flush.** When the app backgrounds, it calls `BackgroundTask.begin()`,
  flushes, then calls `end()` ([05 §5.10](05-connectivity.md#510-app-lifecycle)).

## 12.9 Rendering

### Transcript

The transcript is the native `MonoTranscriptView`
([15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview)).

- **What JavaScript does.** It builds `RowSpec`s from the session window with the
  shared grouping code and the markdown and code pipelines below. Changes go out as
  ops, batched once per frame.
- **What native code does.** It measures rows with the platform text engine off the
  main thread, keeps exact prefix-sum offsets, recycles row views, paints, and runs
  the transcript animations.
- **No React rendering.** No React component renders transcript content. The
  session screen's React tree contains the native view, the navigation bar, the
  jump-to-latest button and the composer.
- **Diff and file viewers.** The same view in document mode serves them, with rows of
  diff lines or source lines.

### Markdown

- **Parse:** `unified().use(remarkParse).use(remarkGfm).use(remarkWorkspaceFileLinks)`.
  `remarkWorkspaceFileLinks` is shared from core. The hard-break behaviour matches the
  desktop's `hardBreaks.ts`, applied at the mdast level.
- **Render:** a row builder maps mdast nodes to `RowSpec`s for the native transcript.
  One top-level block is one row:
  - paragraphs, headings and list items become `markdown` rows of styled runs (bold,
    italic, inline code, links, file refs);
  - blockquotes and thematic breaks become `markdown` rows with box decorations;
  - tables become `table` rows (native horizontal scroller);
  - code becomes `codeBlock` rows with Shiki token runs;
  - images become placeholders, or image specs for `data:` images.
- **Streaming.** The text is split at top-level block boundaries (blank lines outside
  fenced code). Blocks before the last boundary are parsed once and memoised by
  content hash. Only the trailing block is re-parsed on each delta, which keeps cost
  proportional to the newest paragraph.
- **Sanitising.** Raw HTML nodes render as literal text. Links with `javascript:`,
  `data:` or `file:` schemes are inert. External links need confirmation
  ([11 §11.8](11-design-and-ux.md#1116-transcript-rendering-rules)).

### Code

- **Highlighter:**
  - Shiki core, `createJavaScriptRegexEngine`, themes `github-dark` and
    `github-light` (the desktop's).
  - Languages load lazily: ts, tsx, js, jsx, json, bash/sh, python, rust, go, swift,
    kotlin, java, c, cpp, csharp, css, scss, html, xml, markdown, yaml, toml, sql,
    diff, dockerfile, ruby, php.
- **Output** is styled runs inside the `codeBlock` row. The row is first shown plain,
  then updated with tokens when highlighting finishes (one `update` op). Native code
  re-measures nothing, because monospace runs keep their widths.
- **Limits.** Highlight the first 400 lines of a block; the rest stays plain.
- **Scheduling.** Highlight in idle slices, or in a background worklet runtime if
  spike S13 shows idle slices miss the JS budget. Cache by `(lang, theme, sha1(code))`.
- **Fallback.** If S1 shows Shiki's regexes failing or too slow on Hermes, switch to
  `highlight.js` with the same languages.

### Diffs and files

- The diff viewer parses unified diff text (`git.fileDiff`, `git.diff`) with the core
  parser. It sends one row per line (gutter numbers, tint, token runs) plus hunk and
  fold rows to `MonoTranscriptView` in document mode.
- The file viewer sends source lines the same way. Long files fling like transcripts.
- Word-level highlight within changed lines is a later item.

### Images

- `expo-image` with a memory and disk cache.
- Attachment images come from `attachments.read`, chunked, as on the desktop
  (`remoteAttachmentPreviews.ts`). They are written to the cache directory as files
  and shown by URI.

## 12.10 Attachment pipeline

1. **Pick:**
   - camera: `ImagePicker.launchCameraAsync`;
   - photos: `launchImageLibraryAsync`, multiple selection, PHPicker on iOS so no
     full-library permission;
   - files: `DocumentPicker.getDocumentAsync`, multiple, copied to cache.
2. **Normalise images** unless "Send original" is on: `ImageManipulator`, resize to
   2,048 px on the long edge, JPEG 0.85, EXIF stripped (location removed).
3. **Validate:** at most 20 attachments and 20 MiB each. Get the MIME type from the
   picker or the extension. `kind` is `image`, `audio` or `file`.
4. **Upload at once**, in the background of the composer: generate a UUID `id`, read
   512 KiB chunks with `expo-file-system`, base64-encode, and call `attachments.upload
   {id, offset, size, data}`. Resume from the last acknowledged offset after a
   reconnect. The host's offset check makes repeats safe.
5. **Reference** the `RemoteAttachment {id, name, mimeType, kind, size}` in `send`,
   `queue`, `draft` or `create.initial`.

## 12.11 Design system

The design language is specified in [11 §11.1 to §11.9](11-design-and-ux.md#111-design-parity-rules).
Its implementation:

- **`packages/design` (`@monocode/design`).** Pure TypeScript with no React:
  - `palette({hue, saturation, darkLightness, scheme, userAccent})` returns every
    resolved colour token.
  - It exports radii, spacing, type roles, durations and easing tuples.
  - It exports the accent presets, project colours (`tabGroups.ts`), mode, status and
    diff colours.
  - It holds the Hugeicons alias table (from `src/shared/ui/icons.tsx`) and harness
    metadata.
- **Parity test.** `packages/design/parity.test.ts` parses `src/styles/index.css`
  (`@theme`, `:root`, `html.theme-light`), `appearance.ts` and `tabGroups.ts`, and
  asserts that every shared value matches. A desktop token change without a matching
  package change fails CI, so the phone can't drift. The same test checks the strings
  listed as verbatim in `apps/mobile/src/strings.ts` against the desktop sources.
- **`packages/brand`.** Provider SVGs, the app icon, mascot sprite data (from
  `projectMascots.ts`), the pixel terminal illustration, and the exported `cuelume`
  cue files.
- **Theme provider** (`apps/mobile/src/ui/theme.tsx`). It holds the appearance
  settings and recomputes `palette()` when they change, the system scheme changes,
  or Reduce Transparency toggles. Components read tokens through `useTokens()`, never
  literals; a lint rule forbids colour literals in `src/` outside `packages/design`.
- **Motion helpers** (`src/ui/motion.ts`) wrap Reanimated `withTiming` with the token
  curves, and read the reduced-motion flag once per change.

## 12.12 Device security

- **App lock** (`expo-local-authentication`):
  - When enabled, a lock screen covers the app at cold start and after the configured
    time in the background.
  - Biometrics fall back to the device passcode.
  - Notification taps still route, but behind the lock.
- **Privacy overlay.** On `AppState` `inactive`/`background`, cover the UI with a
  blurred brand view, so app-switcher snapshots don't show code. This is the default.
- **Android `FLAG_SECURE`** is optional, under Settings → Security → "Block
  screenshots". It is off by default, since screenshots are useful.
- **Secrets:** see [03 §3.9](03-identity-and-crypto.md#39-where-secrets-live). There
  is no root or jailbreak detection; it adds friction without real protection.
- **Clipboard.** Copying code is explicit. The app never reads the clipboard except
  when the person presses Paste in the pairing flow.

## 12.13 Demo host

`src/demo/` implements a `memory` transport and a `DemoHost` that answers this subset
of the protocol:

- `inbox.list`, `projects.list`, `sessions.page`;
- `sessions.sync`, `sessions.blocks`, `watch.set`;
- `models.list`;
- `commands.dispatch`, with simulated turns: streaming text, a tool call that asks
  for approval, a question, a plan;
- `git.index`, `git.fileDiff`, `files.list`, `files.read`.

The responses come from fixtures in `src/demo/fixtures/*.json`. The demo bypasses
Noise, since the memory transport is in-process, but otherwise uses the real runtime,
stores, outbox and UI. Uses:

- App Review and first-run curiosity;
- Maestro end-to-end tests in CI without a real host;
- screenshot generation for store listings.

## 12.14 App configuration

| Item | Value |
|---|---|
| Identifiers, team, EAS project, scheme, link domains, gateway | From the publisher config `apps/mobile/publisher/<track>.ts`, selected by `MONOCODE_PUBLISHER` ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)). Personal track: `com.monocode.mobile.dev`, scheme `monocode-dev`, app name "MonoCode Dev". Official track: `com.monocode.mobile`, scheme `monocode`, `usemono.dev` links |
| Minimum OS | iOS 16.0, Android 9 (API 28) |
| Associated domains / App Links | One `applinks:<domain>` entry and one Android `autoVerify` intent filter for `https://<domain>/pair` per `linkDomains` entry. None on the personal track by default |
| iOS Info.plist | `NSCameraUsageDescription` ("Scan pairing codes and take photos to send to agents"), `NSLocalNetworkUsageDescription` ("Connect directly to your computers on this network"), `NSFaceIDUsageDescription` ("Unlock MonoCode and confirm approvals"), `NSPhotoLibraryAddUsageDescription` (saving images), `NSAppTransportSecurity: {NSAllowsLocalNetworking: true}` plus an exception domain for `ts.net` (spike S4), `ITSAppUsesNonExemptEncryption` per [13 §13.7](13-testing-and-release.md#138-compliance) |
| iOS entitlements | `aps-environment`, `com.apple.security.application-groups: [<appGroup>]`, `keychain-access-groups: [<keychainGroup>]` (from the publisher config), `com.apple.developer.usernotifications.time-sensitive`, `com.apple.developer.associated-domains` |
| iOS extension | `MonoCodeNotificationService` (bundle `<nseBundleId>`), sharing the app group and keychain group |
| Android permissions | `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `CAMERA`, `USE_BIOMETRIC`, `VIBRATE` |
| Android network security | Config plugin `plugins/withNetworkSecurity.ts`: `cleartextTrafficPermitted="true"` in the base config, needed for `ws://` to LAN and tailnet addresses. Traffic is Noise-encrypted |
| Config plugins | `@bacons/apple-targets`, `expo-build-properties`, `plugins/withNetworkSecurity`, `plugins/withAppGroupAndKeychain`, `expo-notifications` (icon, colour, default channel) |
| Custom Expo modules | `modules/background-task` (iOS `beginBackgroundTask`/`endBackgroundTask`; no-op on Android) |

## 12.15 Performance budgets

Budgets, rules and gates are in [15](15-performance.md), which supersedes the earlier
table that was here.

## 12.16 Logging and diagnostics

- **Logger:** `src/log` keeps a ring buffer of 2,000 entries in memory, plus a
  rotating file (1 MiB × 3) in the cache directory.
- **Levels:** debug (development only), info, warn, error.
- **Redaction.** No message bodies, payloads, keys, tokens, tickets or file
  contents. Host ids and session ids are logged as their first 6 characters.
- **Diagnostics export** ([05 §5.12](05-connectivity.md#512-diagnostics)): the app
  version and build, OS, device model, network type, host versions and capabilities,
  connection events, and the last 200 log lines.
- **No crash reporter in v1.** Native crash reports come from App Store Connect and
  Google Play Console. Opt-in crash reporting can be evaluated after v1, with explicit
  consent.
