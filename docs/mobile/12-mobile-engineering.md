# 12. iOS engineering

How the phone app is built: a native iOS app in Swift (D19). This document describes
the Swift app. The Expo prototype on `feat/mobile-app` implemented the same behaviour
in TypeScript. It is frozen as the reference and deleted at parity
([16](16-ios-native-design.md)). The plan, porting map and milestones are in 16. This
document is the engineering reference the app is built against.

## 12.1 Stack

| Layer | Choice | Notes |
|---|---|---|
| Platform | iOS 26.0 minimum; Xcode 27, iOS 27 SDK | [16 §16.2](16-ios-native-design.md#162-platform-baseline) |
| Language | Swift 6 language mode, complete strict concurrency | Main-actor UI; actors for connections |
| UI | SwiftUI for screens, navigation, sheets, menus and glass. UIKit for the transcript and viewers (`MonoTranscriptView`) and wherever spikes S19 and S20 call for it | [16 §16.6](16-ios-native-design.md#166-design-by-surface) |
| Navigation | `TabView` with a `NavigationStack` per tab; typed destinations in a `Router` | [11 §11.10](11-design-and-ux.md#1110-navigation) |
| State | `@Observable` stores on the main actor, plus one `HostRuntime` actor per host | §12.4, §12.5 |
| Storage | SQLite through GRDB, encrypted per spike S18; Keychain Services for secrets; `UserDefaults` for small preferences | §12.6 |
| Lists | SwiftUI `List` with MonoCode card rows (spike S19; fallback `UICollectionView`) | §12.9 |
| Transcript, diff viewer, file viewer | `MonoTranscriptView` (UIKit, CoreText) | [15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview) |
| Animation and gestures | SwiftUI animations with the token curves; Core Animation inside the transcript; system gestures | Bezier timings from `@monocode/design`; springs only for gesture hand-off ([11 §11.1](11-design-and-ux.md#111-design-parity-rules) M8) |
| Materials | Liquid Glass: system chrome, `.glassEffect` for MonoCode's floating surfaces; `UIGlassEffect` inside UIKit | [11 §11.4](11-design-and-ux.md#114-shape-materials-and-elevation) |
| Sound | AVFoundation (`AVAudioPlayer`) playing the exported `cuelume` cues | [11 §11.8](11-design-and-ux.md#118-sound-and-haptics) |
| Icons | SF Symbols (M12); harness marks, file-type icons and mascots in the asset catalog | [11 §11.7](11-design-and-ux.md#117-iconography-brand-and-mascots) |
| Context menus | SwiftUI `.contextMenu(menuItems:preview:)`; `UIContextMenuInteraction` inside the transcript | |
| Crypto | CryptoKit (X25519, ChaCha20-Poly1305, SHA-256, HMAC, HKDF); `SecRandomCopyBytes` | [03](03-identity-and-crypto.md) |
| Compression | Apple `Compression` (raw deflate) with bounded output | [03 §3.5](03-identity-and-crypto.md#35-record-layer) |
| Networking | `URLSessionWebSocketTask` (spike S23; fallback `NWConnection` with `NWProtocolWebSocket`); `NWPathMonitor` | [05](05-connectivity.md) |
| Markdown | A Swift port of the prototype's block and inline parser → transcript rows (incremental tail parse) | §12.9 |
| Code highlighting | MonoHighlight, engine chosen by spike S21 | §12.9 |
| Images | ImageIO for decode and downsampling off the main thread; PhotosUI `PhotosPicker`; `UIImagePickerController` for the camera; `UIDocumentPickerViewController` for files | §12.10 |
| QR | VisionKit `DataScannerViewController` (QR only) | [04 §4.7](04-pairing.md#47-phone-screens) |
| Notifications | UserNotifications; a Notification Service Extension target | [08](08-notifications.md) |
| Background | `UIApplication.beginBackgroundTask`, BackgroundTasks (`BGAppRefreshTask`, `BGContinuedProcessingTask`) | [05 §5.10](05-connectivity.md#510-app-lifecycle) |
| Device features | `.sensoryFeedback` haptics, LocalAuthentication, `UIPasteboard`, `ShareLink` | |
| Testing | Swift Testing for the packages (`swift test` on the Mac); XCTest and XCUITest for the app, the transcript and performance | [13](13-testing-and-release.md), [15 §15.6](15-performance.md#156-measurement-and-gates) |

Third-party packages are limited to GRDB (with SQLCipher if S18 keeps it) and the
highlighter S21 chooses. No analytics or crash-reporting SDK ships in v1
([12.16](#1216-logging-and-diagnostics)).

## 12.2 Project layout (`apps/ios`)

```
apps/ios/
  MonoCode.xcodeproj         # targets: MonoCode (app), NotificationService (extension),
                             #   MonoCodeUITests; folders are synchronized groups
  Config/                    # Shared.xcconfig, Personal.xcconfig, Official.xcconfig (13.5)
  MonoCode/
    App/                     # MonoCodeApp, RootView (TabView), Router, deep links, scene phase,
                             #   app lock and privacy overlay
    Agents/                  # Agents tab, bottom accessory
    Projects/                # Projects tab, Project screen, open-folder flow
    Session/                 # session screen, transcript host, approval banner, question form,
                             #   tool and attachment sheets, session info
    Compose/                 # composer, chips, pickers, queue card, usage tab, New session
    Workspace/               # Explorer, Changes, file and diff viewers
    Settings/                # Settings pages, Machine details, notifications settings
    Pairing/                 # pairing sheet and stages, scanner
    Debug/                   # Transcript Lab, fling benchmark, hitch meter (debug builds)
    Resources/               # Assets.xcassets, cue sounds, Localizable.xcstrings, Info.plist
  NotificationService/       # the extension (8.7)
  Packages/
    MonoChannel/             # Noise IK, records, envelope, offer and links, proof and code,
                             #   push open and ticket seal
    MonoWire/                # Codable wire and session types; applySessionSync; turn and step
                             #   grouping; question replies; summaries; windowing
    MonoStore/               # GRDB database, schema and migrations; Keychain wrapper
    MonoSync/                # transports, race, HostRuntime, registry, watch, session windows,
                             #   paging, attachments, outbox, pairing state machine, workspace API
    MonoDesign/              # generated tokens; theme; motion; type scale; SF Symbol alias map
    MonoTranscript/          # engine, layout, models, view; row builder; Markdown; document mode
    MonoHighlight/           # highlighting (S21)
    MonoDemo/                # demo host and its fixtures
  scripts/
    gen-design-tokens.mjs    # @monocode/design → MonoDesign/Sources/MonoDesign/Generated/Tokens.swift
    gen-fixtures.mjs         # TypeScript → golden JSON fixtures for the packages' tests
    build-native-assets.mjs  # harness marks, file-type icons, mascots → Assets.xcassets
    export-cues.mjs          # cuelume cues → audio files (11 §11.8)
    check.sh                 # swift test for every package, then xcodebuild test
```

## 12.3 Code shared with the desktop and host

The Swift app does not import TypeScript. It **ports** what it needs, and the port is
held to the TypeScript behaviour by vectors, golden fixtures and an interop test
([16 §16.5](16-ios-native-design.md#165-keeping-the-swift-client-compatible-with-the-host)).

- **Into MonoWire, from `@monocode/core`** and the desktop model code it re-exports:
  - **Types:** `Session`, `Block`, `HostSession`, `HostSessionSummary`, `HostCommand`,
    `SessionSync`, `RemoteAttachment`, `AgentModel`, `ModelSetting`, `RuntimeMode`,
    `UserQuestionPrompt`, `ToolPreview`, `ContextUsage`, and the workspace wire types.
  - **Logic:**
    - `applySessionSync`, `groupTurns`, `groupTurnItems`, `buildActivityPhases`,
      `workSummaryLine`;
    - `toolCallState`, `resolveToolCallDisplay`, `isHiddenTool`;
    - `buildQuestionReply`, `questionIsComplete`;
    - `planTitle`, `buildPlanPrompt`;
    - `sessionNeedsInput`, `hasPendingApproval`, `compareSessionSummaries`;
    - `findRemoteModel`, `carryModelSettings`, `isEffortSettingId`;
    - `contextPercent`, `formatTokens`, `relativeTime`, `fuzzy`, `truncateBlock`,
      `plainTextPreview`.
  - **Constants:** `REMOTE_PROVIDERS`, `HARNESS_LABEL`/`HARNESS_TITLE`, runtime-mode
    labels and hints, attachment limits.
- **Into MonoChannel, from `@monocode/channel`:** the Noise initiator, the record
  layer, the envelope types, the offer and link codec, the pairing proof and
  confirmation code, push `open`, and ticket `seal`.
- **Into MonoDesign, generated:** everything `@monocode/design` exports (§12.11).

Strings that the desktop's sources must match verbatim live in
`Localizable.xcstrings`. A check in `gen-fixtures.mjs` compares them with the desktop
sources, as the TypeScript parity test does for tokens.

## 12.4 Host runtime

One `HostRuntime` actor per paired host (MonoSync), created at launch from the host
registry.

```swift
enum HostConnState: Sendable, Equatable {
  case idle, connecting
  case online(transport: TransportKind, endpoint: String, rttMs: Int, since: Date)
  case reconnecting(since: Date)
  case offline(reason: OfflineReason, retryAt: Date, lastOnlineAt: Date?)   // noNetwork, hostUnreachable, timeout
  case blocked(BlockReason)  // deviceRevoked, unknownDevice, hostIdentityChanged, protocolIncompatible, appTooOld
}

actor HostRuntime {
  let env: String
  private(set) var state: HostConnState
  private(set) var welcome: Welcome?
  private(set) var clockOffset: Duration                 // hostNow − localNow
  func connect(_ reason: ConnectReason)                  // no-op when online; bypasses backoff for user/OS reasons
  func verify(timeout: Duration) async -> Bool
  func request<R: Decodable & Sendable>(_ method: String, _ params: some Encodable & Sendable,
                                        key: String?, timeout: Duration) async throws -> R
  func setWatch(_ watch: WatchSet)                       // debounced 50 ms; resent after every (re)connect
  nonisolated var events: AsyncStream<RuntimeEvent> { get }  // state | evt | welcome
  func scenePhaseChanged(_ phase: ScenePhase)
  func pathChanged(_ path: NWPath)
}
```

**Transports** (MonoSync):

```swift
protocol Transport: Sendable {
  var kind: TransportKind { get }        // .direct, .relay, .demo
  var key: String { get }                // candidate key "lan|192.168.1.20|3775"
  func open() async throws -> FrameSocket          // cancelled through task cancellation
}
protocol FrameSocket: Sendable {
  func send(_ frame: Data) async throws
  var frames: AsyncThrowingStream<Data, Error> { get }
  func close(code: Int, reason: String) async
}
```

- **Direct and relay** both use `URLSessionWebSocketTask` with binary messages:
  - Direct: `ws://<addr>:<port>/v1/channel`, with IPv6 literals bracketed.
  - Relay: `wss://…/v1/client?room=…&v=1`.
- **Demo** connects the demo host (§12.13) and tests in process.

**The race** implements [05 §5.5](05-connectivity.md#55-transport-racing) with a task
group.
- Each child task runs `open` → Noise handshake (hello) → welcome.
- The first child to finish wins. The others are cancelled.
- The winner's socket and cipher states become the runtime's `Channel`.

**`Channel`** (MonoChannel):
- request and response matching with timeouts;
- an event stream;
- `ping` every 15 s with presence;
- priority send queues;
- reassembly limits.

It knows nothing about SwiftUI or storage.

**Request queue.**
- While the runtime isn't `online`, `request` waits up to 15 s for a channel, then
  throws `offline`.
- Commands never go through `request` directly. They go through the outbox (§12.8).

## 12.5 Stores

`@Observable` classes on the main actor hold UI-facing state. Runtimes and engines
write to them by hopping to the main actor, at most once per display frame for
streaming data. Views read the properties they show, so Observation re-renders only
the views whose properties changed.

| Store | Contents | Written by |
|---|---|---|
| `HostsStore` | `HostRecord`s (registry) and each runtime's `HostConnState` | Registry, runtimes |
| `InboxStore` | Per host `{boot, revision, items, fetchedAt}`; merged and sectioned on demand | Inbox sync |
| `ProjectsStore` | Per host `HostProject`s, plus per project `SessionListItem` pages and cursor | Project sync |
| `SessionStore` (one per open session) | `HostSession` window, window meta, `revision`, `freshness` (`cached` or `live`), ids of loading older pages | Watch apply pipeline |
| `OutboxStore` | Entries by host and session, as a view of the outbox table | Outbox engine |
| `CatalogStore` | Model catalogs per host and project | Composer |
| `UIState` | Composer drafts (debounced to the drafts table), the presented sheet, toasts, app lock state | Views |

Streaming deltas never re-render SwiftUI. The transcript is fed by the row builder
directly (§12.9), so the header and composer re-render only when their own fields
change.

## 12.6 Persistence

**SQLite** (`monocode.sqlite` in Application Support, excluded from backups with
`isExcludedFromBackup`), through GRDB:
- a `DatabasePool` in WAL mode; reads run concurrently off the main thread;
- encrypted per **spike S18**: either SQLCipher with a 32-byte random key in the
  Keychain (`mc.cache.dbKey`), or plain SQLite with the file protection class
  `completeUntilFirstUserAuthentication`.

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
CREATE TABLE drafts (env TEXT, session_id TEXT, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
                     PRIMARY KEY (env, session_id));
```

These are the prototype's tables at its schema version 2. The Swift app starts them
as its version 1, since it is a new install.

```swift
struct HostRecord: Codable, Sendable {
  var env: String; var label: String; var color: String
  var hostName: String; var platform: String; var fingerprint: String
  var hostKey: String                      // public, pinned
  var deviceId: String; var role: Role     // .admin, .member
  var endpoints: [Endpoint]
  var relay: RelayInfo?                    // url, room
  var pushEnabled: Bool                    // host side; the gateway comes from the publisher config
  var pairedAt: Date; var lastOnlineAt: Date?
  var lastWelcome: WelcomeSummary?         // host, capabilities, providers, limits
  var notifications: NotificationPrefs     // enabled, categories, preview, mutedProjects, mutedSessions
}
```

**Keychain items** (generic passwords, service `mc`,
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`):

| Account | Value | Access group |
|---|---|---|
| `mc.host.<env>.deviceKey` | X25519 private key | App |
| `mc.host.<env>.counter` | Handshake counter, written before every attempt | App |
| `mc.push.key`, `mc.push.key.prev` | Push private keys | Shared with the extension |
| `mc.cache.dbKey` | Cache key, if S18 keeps SQLCipher | App |
| `mc.pending.pairing` | The pending pairing record ([04 §4.7](04-pairing.md#47-phone-screens)) | App |
| `mc.applock` | App lock settings | App |

**Budgets and eviction:**
- `session_windows` is capped at 64 MiB in total. Windows are evicted by oldest
  `opened_at`. A window with outbox entries pending is never evicted.
- A single window over 4 MiB is kept in memory only.
- The image cache (decoded thumbnails in memory, files in `Caches/`) is capped at
  200 MiB on disk.
- Summaries and inbox data are small and never evicted while the host is paired.

**Migrations.** GRDB's `DatabaseMigrator`, forward only. A failed migration drops the
cache tables, but never `outbox`, `hosts` or `drafts`, and refetches.

## 12.7 Sync engine

- **WatchManager** (MonoSync) turns view interest into one `WatchSet` per host. Views
  register interest with reference counts through modifiers:
  - `.watchInbox()` (on the Agents tab, and on the root while the app is active);
  - `.watchProject(env, projectId)`;
  - `.watchSession(env, sessionId)`.

  A session leaves the watch 30 s after its last view disappears. At most 8 sessions
  per host are watched; beyond that, the least recently viewed is dropped.
- **Apply pipeline** for `session.sync`, off the main actor:
  1. Run `applySessionSync(window, sync)` (MonoWire). On a base mismatch, request a
     snapshot (no revision, same anchor).
  2. Update the window meta.
  3. Pass the changed blocks to the row builder, which hands ops to the transcript on
     the main thread once per frame (§12.9). Then publish the window to its
     `SessionStore`.
  4. Persist, debounced: 1 s while running, immediately on settle.
- **Agents (inbox data):** on `inbox.changed`, or a host coming online, call
  `inbox.list` if `(boot, revision)` differs. Merge across hosts in `InboxStore`.
- **Projects:** on `project.sessions`, refetch the first page of `sessions.page` for
  that project. Further pages load as the list nears its end.
- **Freshness.** A session window is `cached` until the first `session.sync` (or
  `unchanged`) after the current watch was sent. Then it is `live`. A reconnect resets
  it to `cached`.

## 12.8 Outbox engine

Implements [06 §6.8](06-channel-protocol.md#68-idempotency-and-retries).

- `enqueue(env, command, options)` writes to SQLite, then wakes the sender. A host
  with a new entry is connected immediately.
- **Sender, one task per host:**
  - Runs while the host is `online`.
  - Takes entries in `created_at` order, skipping those whose `dependsOn` isn't acked.
  - Sends through `runtime.request("commands.dispatch", command)`.
- **Other mutating methods** (Git writes, config) go through `mutate`, keyed, and are
  retried for 60 s when the host lists `mutations.idempotent`. Git writes run one at a
  time.
- **Ids for commands that follow a `create`.** They carry a local session id. When the
  create's receipt arrives, the engine rewrites their `sessionId` in SQLite before
  sending.
- **Optimistic UI.** The transcript shows user blocks from `send`, `queue` and
  `create.initial` entries until a block with the same id arrives. Approval cards show
  "Sending…" while an `approve` entry is pending.
- **Background flush.** When the scene goes to the background, the engine flushes
  inside `UIApplication.beginBackgroundTask`, then ends the task
  ([05 §5.10](05-connectivity.md#510-app-lifecycle)). Entries still pending are
  retried in a `BGAppRefreshTask` when iOS grants one.

## 12.9 Rendering

### Transcript

The transcript is `MonoTranscriptView`
([15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview)), a UIKit
view hosted in SwiftUI by a `UIViewControllerRepresentable`.

- **The row builder** (MonoTranscript) builds `RowSpec`s from the session window with
  MonoWire's grouping and the Markdown and code pipelines below. It runs off the main
  thread. Changes go to the view as ops, applied once per display frame.
- **The view** measures rows with CoreText off the main thread, keeps exact
  prefix-sum offsets, recycles row layers, paints, and runs the transcript
  animations.
- **SwiftUI never renders transcript content.** The session screen's SwiftUI tree
  holds the hosted transcript, the navigation bar, the jump-to-latest button and the
  composer.
- **Diff and file viewers.** The same view in document mode serves them, with rows of
  diff lines or source lines.

### Markdown

- **Parse:** a Swift port of the prototype's block and inline parser
  (`apps/mobile/src/transcript/markdown.ts`): GFM tables, fenced code, lists,
  blockquotes, emphasis, links and workspace file links. Its fixtures port with it.
  The hard-break behaviour matches the desktop's `hardBreaks.ts`.
- **Render:** the row builder maps blocks to `RowSpec`s. One top-level block is one
  row:
  - paragraphs, headings and list items become `markdown` rows of styled runs (bold,
    italic, inline code, links, file refs);
  - blockquotes and thematic breaks become `markdown` rows with box decorations;
  - tables become `table` rows (native horizontal scroller);
  - code becomes `codeBlock` rows with highlighted runs;
  - images become placeholders, or image specs for `data:` images.
- **Streaming.** The text is split at top-level block boundaries (blank lines outside
  fenced code). Blocks before the last boundary are parsed once and memoised by
  content hash. Only the trailing block is re-parsed on each delta, which keeps cost
  proportional to the newest paragraph.
- **Sanitising.** Raw HTML renders as literal text. Links with `javascript:`, `data:`
  or `file:` schemes are inert. External links need confirmation
  ([11 §11.16](11-design-and-ux.md#1116-transcript-rendering-rules)).

### Code

- **Highlighter** (MonoHighlight): the engine from spike S21, with the desktop's
  `github-dark` and `github-light` colours. Languages: ts, tsx, js, jsx, json,
  bash/sh, python, rust, go, swift, kotlin, java, c, cpp, csharp, css, scss, html,
  xml, markdown, yaml, toml, sql, diff, dockerfile, ruby, php.
- **Output** is styled runs. A row is first shown plain, then updated with tokens when
  highlighting finishes (one `update` op). Monospace runs keep their widths, so
  nothing is re-measured.
- **Limits.** Highlight the first 400 lines of a code block, and files up to 64 KiB or
  1,000 lines; the rest stays plain.
- **Scheduling.** Highlighting runs on a background task with utility priority. Results
  are cached by `(language, theme, SHA-256 of the code)`.

### Diffs and files

- The diff viewer computes the unified diff on the phone from `git.fileDiff`'s two
  sides (Myers, as the desktop's `buildUnifiedFile` and the prototype do), in hunks
  with 3 lines of context. It sends one row per line (gutter numbers, tint, token
  runs) plus hunk rows to `MonoTranscriptView` in document mode.
- The file viewer sends source lines the same way. Long files fling like transcripts.
- Word-level highlight within changed lines is a later item.

### Images

- ImageIO decodes and downsamples to the display size on a background queue. Memory
  and disk caches are bounded (§12.6).
- Attachment images come from `attachments.read`, chunked, as on the desktop
  (`remoteAttachmentPreviews.ts`). They are written to `Caches/` as files and shown
  from there.

## 12.10 Attachment pipeline

1. **Pick:**
   - camera: `UIImagePickerController` with `.camera`;
   - photos: `PhotosPicker`, multiple selection, so no library permission is needed;
   - files: `UIDocumentPickerViewController`, multiple, copied to `Caches/`.
2. **Normalise images** unless "Send original" is on: ImageIO resizes to 2,048 px on
   the long edge and writes JPEG at quality 0.85 without metadata, so EXIF and
   location are stripped.
3. **Validate:** at most 20 attachments and 20 MiB each. Get the type from the picker
   or the extension (`UTType`). `kind` is `image`, `audio` or `file`.
4. **Upload at once**, in the background of the composer: generate a UUID `id`, read
   512 KiB chunks with `FileHandle`, base64-encode, and call `attachments.upload {id,
   offset, size, data}`. Resume from the last acknowledged offset after a reconnect.
   The host's offset check makes repeats safe.
5. **Reference** the `RemoteAttachment {id, name, mimeType, kind, size}` in `send`,
   `queue`, `draft` or `create.initial`.

## 12.11 Design system

The design language is specified in
[11 §11.1 to §11.9](11-design-and-ux.md#111-design-parity-rules). Its implementation:

- **`packages/design` (`@monocode/design`) stays the source.** It is pure TypeScript:
  `palette({hue, saturation, darkLightness, scheme, userAccent})`, radii, spacing, type
  roles, durations and easing tuples, accent presets, project colours, mode, status
  and diff colours, the icon alias table and harness metadata. Its parity test against
  the desktop's `index.css`, `appearance.ts` and `tabGroups.ts` stays where it is.
- **`gen-design-tokens.mjs`** evaluates the package and writes
  `MonoDesign/Sources/MonoDesign/Generated/Tokens.swift`:
  - the static tokens (radii, spacing, type roles, motion curves, presets);
  - a Swift port of `palette()`, checked against palette outputs that the script
    generates for a grid of inputs;
  - the SF Symbol map for the desktop's icon aliases (M12).

  CI regenerates the file and fails on a diff, so a desktop token change reaches the
  phone or breaks the build.
- **`Theme`** (MonoDesign, `@Observable`) holds the appearance settings and recomputes
  the palette when they change, when the colour scheme changes, or when Reduce
  Transparency toggles. Views read tokens through `@Environment(\.tokens)`, never
  literals. `check.sh` fails on colour literals outside MonoDesign.
- **Motion helpers** turn the token curves into `Animation.timingCurve` values and read
  `accessibilityReduceMotion`.
- **`packages/brand`** keeps the provider SVGs, the app icon, the mascot sprite data
  and the cue sources. `build-native-assets.mjs` and `export-cues.mjs` turn them into
  the asset catalog and audio files.

## 12.12 Device security

- **App lock** (LocalAuthentication):
  - When enabled, a lock screen covers the app at cold start and after the configured
    time in the background.
  - `deviceOwnerAuthentication` uses biometrics and falls back to the passcode.
  - Notification taps still route, but behind the lock.
- **Privacy overlay.** When `scenePhase` leaves `.active`, a blurred brand view covers
  the UI, so app-switcher snapshots don't show code. This is the default.
- **Secrets:** see [03 §3.9](03-identity-and-crypto.md#39-where-secrets-live). There
  is no jailbreak detection; it adds friction without real protection.
- **Clipboard.** Copying code is explicit. The app never reads the pasteboard except
  through the system `PasteButton` in the pairing flow, which needs no permission
  prompt.

## 12.13 Demo host

MonoDemo implements the `demo` transport and a `DemoHost` actor that answers this
subset of the protocol:

- `inbox.list`, `projects.list`, `sessions.page`;
- `sessions.sync`, `sessions.blocks`, `watch.set`;
- `models.list`;
- `commands.dispatch`, with simulated turns: streaming text, a tool call that asks
  for approval, a question, a plan;
- `git.index`, `git.fileDiff`, `git.action`, `files.list`, `files.read`, with
  in-memory repositories.

The responses come from JSON fixtures that `gen-fixtures.mjs` produces from the
prototype's `demoHost.ts` and `demoRepo.ts`. The demo skips Noise, since the transport
is in process, but otherwise uses the real runtime, stores, outbox and screens. Uses:

- App Review and first-run curiosity;
- XCUITest flows in CI without a real host;
- the transcript benchmark scenarios ([15 §15.6](15-performance.md#156-measurement-and-gates));
- screenshots for store listings.

## 12.14 App configuration

| Item | Value |
|---|---|
| Identifiers, team, scheme, link domains, gateway | From the track's xcconfig (`Config/Personal.xcconfig`, `Config/Official.xcconfig`), selected by the build configuration ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)). Personal track: `com.monocode.mobile.dev`, scheme `monocode-dev`, app name "MonoCode Dev". Official track: `com.monocode.mobile`, scheme `monocode`, `usemono.dev` links |
| Minimum OS | iOS 26.0 |
| Associated domains | One `applinks:<domain>` entry per link domain, for `https://<domain>/pair`. None on the personal track by default |
| Info.plist | `NSCameraUsageDescription` ("Scan pairing codes and take photos to send to agents"), `NSLocalNetworkUsageDescription` ("Connect directly to your computers on this network"), `NSFaceIDUsageDescription` ("Unlock MonoCode and confirm approvals"), `NSAppTransportSecurity: {NSAllowsLocalNetworking: true}` plus an exception domain for `ts.net` (spike S23), `ITSAppUsesNonExemptEncryption` per [13 §13.8](13-testing-and-release.md#138-compliance), `BGTaskSchedulerPermittedIdentifiers`, `CADisableMinimumFrameDurationOnPhone = YES`, and the publisher keys (gateway URL and keys, link domains) |
| Entitlements | `aps-environment`, `com.apple.security.application-groups: [<appGroup>]`, `keychain-access-groups: [<keychainGroup>]`, `com.apple.developer.usernotifications.time-sensitive`, `com.apple.developer.associated-domains` |
| Extension | `NotificationService` (bundle `<bundleId>.NotificationService`), sharing the app group and keychain group |
| Background modes | `fetch` (for `BGAppRefreshTask`) and `remote-notification` |

## 12.15 Performance budgets

Budgets, rules and gates are in [15](15-performance.md).

## 12.16 Logging and diagnostics

- **Logger:** `os.Logger` with one subsystem per package, plus an in-memory ring
  buffer of 2,000 entries for the diagnostics export.
- **Levels:** debug (debug builds only), info, notice, error.
- **Redaction.** No message bodies, payloads, keys, tokens, tickets or file contents.
  Interpolations are `.private` by default. Host ids and session ids are logged as
  their first 6 characters.
- **Diagnostics export** ([05 §5.12](05-connectivity.md#512-diagnostics)): the app
  version and build, OS, device model, network type, host versions and capabilities,
  connection events, and the last 200 log lines.
- **No crash reporter in v1.** Crash reports come from App Store Connect and Xcode
  Organizer. Opt-in crash reporting can be evaluated after v1, with explicit consent.
