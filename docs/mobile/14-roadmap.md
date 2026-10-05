# 14. Roadmap

## 14.1 Milestones

**Since D19 (2026-10-05) the phone app is a native Swift iOS app.** The milestones
below are the rev 3 plan. Their host, desktop, relay and gateway scope stands. Their
phone scope (the Expo app, Android, the hybrid transcript bridge) is replaced by the
Swift milestones R0 to R8 ([16 §16.7](16-ios-native-design.md#167-milestones)),
summarised after the table.

Estimates are in engineer-weeks for one person familiar with the codebase. M8
depends on upstream review.

```
M0 Foundations ──▶ M1 Channel + pairing ──▶ M2 Read path ──▶ M3 Write path ──▶ M6 Workspace ──▶ M7 Hardening ──▶ M8 Official
      │                  │                        ▲   │
      └──▶ T Native transcript (iOS ∥ Android) ───┘   └──▶ M4 Relay ──▶ M5 Push ─────────────────▲
```

| Milestone | Scope | Exit criteria | Estimate |
|---|---|---|---|
| **M0 Foundations** | npm workspaces. Extract `@monocode/core` with the KV-store injection ([02 §2.6](02-architecture.md#26-repository-layout-and-shared-code)). `@monocode/channel`: Noise, records, offer, push crypto, all with vectors. Host `rpc.ts` dispatcher and `HostError`, with no behaviour change. Expo app skeleton: router, storage, CI, publisher configs for both tracks. **Design foundation:** `@monocode/design` (palette, type, radii, motion, icon aliases) with the desktop parity test, `@monocode/brand`, theme provider, core primitives (Text, Icon, Chip, Button, Toggle, Segmented, BrailleSpinner, Shimmer), native shell (native stack, `NativeTabs`, form sheets, context menus). **Performance harness:** hitch overlay, benchmark scenarios on the demo host, XCTest and Macrobenchmark jobs ([15 §15.6](15-performance.md#156-measurement-and-gates)). Spikes S1 to S13 | `npm run check` and `npm run test:host` green with the HTTP API unchanged. The MonoCode Dev app builds for iOS and Android. The parity test passes. The benchmark jobs run. Spike decisions recorded below | 5 |
| **T Native transcript** (in parallel from M0) | `MonoTranscriptView` on iOS (TextKit 2/CoreText) and Android (StaticLayout): `RowSpec` bridge and ops, layout thread with exact heights and prefix sums, row recycling and painting, every row kind in [11 §11.16](11-design-and-ux.md#1116-transcript-rendering-rules), follow-tail and anchoring, nested code/table scrollers, native animations (fold, step entrance, veil, shimmer, spinner, mascot), hit testing, context menus, accessibility, find highlights, document mode for diffs and files. Shared fixtures, golden and screenshot tests | The §15.5 transcript budgets pass on every reference device. Streaming equals final layout. VoiceOver and TalkBack pass the transcript checklist | 8 (about 4 per platform) |
| **M1 Channel and pairing (direct)** | Host: keys, config, DB migration 1, device API, pairing manager, direct listener, channel connection, RPC over the channel, welcome, endpoints, `pair --mobile`, `devices`/`revoke`/`rename-device`, `/lifecycle` actions, basic `doctor`. App: onboarding and pairing screens ([11 §11.11](11-design-and-ux.md#1111-onboarding-and-pairing)), offer parsing, scanner, direct-only race, machine registry, Settings → Machines and Machine details | A phone on the same LAN pairs with a CLI-started host, lists its projects and survives a host restart. Revoke closes the channel. All handshake and pairing tests green | 4 |
| **M2 Read path and desktop pairing** | Host: watch and events, windowed sync, `sessions.blocks`/`block`/`page`, inbox, summary additions. App: Agents, Projects, Project screen with session cards (FlashList, deterministic heights), the session screen hosting `MonoTranscriptView` (from T) fed by the row builder, encrypted cache, freshness, older pages, tool sheet, attachment images. **Parity review** of these screens against the desktop. List and navigation budgets from §15.5 pass. Desktop: "This computer" setup, Settings → Mobile, pairing dialog, device list, allow-list | J3 and J8 met. Pairing from the desktop works for macOS, Linux and Windows hosts. Watch/sync property test green | 4 |
| **M3 Write path** | Host: `create` with `initial`/`worktree`, queue commands, mutation receipts, error codes throughout. Host also: `editQueued` and `steer`. App: the desktop composer (top bar, chips, + sheet, slash picker, model and access sheets, queue card, usage tab), attachments, inline approvals and approval banner, question form, outbox, empty-session new-session screen with docking, drafts, Plan and Build, Stop, `/compact`. **Parity review** | J1, J2 (in app), J4, J5 and J7 met. Zero lost or duplicated commands in Toxiproxy runs | 5 |
| **M4 Relay** | `services/relay` rooms. Host relay client, config and consent. App relay transport and upgrade probe. Desktop relay toggle. Staging deployment | The app works on cellular with no VPN, and upgrades to direct on the same Wi-Fi within 60 s. Relay test suite green. Measured cost per active user recorded | 3 |
| **M5 Push** | Host attention engine, presence, push sender. Gateway. App registration, iOS extension, Android background task, categories and actions, settings, badge, troubleshooting. Desktop presence calls | Locked-phone approval push p50 < 3 s, p95 < 8 s. Suppression while watching verified on both the desktop and the phone. No content visible to the gateway (test) | 4 |
| **M6 Workspace** | Changes, diff viewer, files, file viewer, commit and push with idempotency keys | J6 met. Commit and push are never duplicated under fault injection | 3 |
| **M7 Hardening** | Performance pass against every §15.5 row on every reference device, app lock, privacy overlay, iPad split view, accessibility pass, P1 motion (word fade, particle titles, insertion, prompt rise, dock, plan burst), sounds and haptics, demo host polish, diagnostics, performance budgets, the QA matrix, user documentation (`docs/remote-access.md` updates and a phone guide) | MonoCode Dev passes the QA matrix and every §15.5 budget. Every [11 §11.1](11-design-and-ux.md#111-design-parity-rules) deviation is the recorded one; nothing else differs from the desktop | 5 |
| **M8 Official publication** | Upstream PRs for host, desktop, packages and the app merged and released. The official publisher fills `publisher/official.ts`, deploys the official relay and gateway, sets up store records, compliance and store assets. Beta, then release | The [release checklist](13-testing-and-release.md#139-release-readiness-checklist-v1) is complete | 2, plus upstream review time |

**Total (rev 3 plan): about 43 engineer-weeks** (34 before the hybrid decision, plus 8 for the native transcript and 2 for the performance harness and pass, minus 1 for the React transcript it replaces). D19 drops the Android half of the transcript and every Android item, and adds the Swift rewrite of what the prototype built. New estimates are written here after R0.

### Swift app milestones (D19)

The detail is in [16 §16.7](16-ios-native-design.md#167-milestones).

| Milestone | Replaces the phone scope of | Status |
|---|---|---|
| R0 Skeleton and transcript | M0 (app skeleton, design foundation, performance harness), T (iOS), S11 | In progress: the simulator steps are built (As built, R0, below); the iPhone 13 run and S11 remain |
| R1 Shell and read path (UI first, on the demo host) | M2's screens | In progress (As built, R1, below) |
| R2 Channel, pairing and a real host | M1, and M2's cache and real host | |
| R3 Write path | M3 | |
| R4 Workspace and parity | M6. `apps/mobile` is deleted here | |
| R5 Relay | M4 | |
| R6 Push | M5 | |
| R7 Hardening | M7 | |
| R8 Official publication | M8 | |

R1 and R2 were swapped on 2026-10-06 (owner decision, UI first): R1 builds the shell
and the read-path screens on the demo host, and R2 brings the channel, pairing, the
cache and a real host. [16 §16.7](16-ios-native-design.md#167-milestones) has the
detail.

### Personal track checkpoints

MonoCode Dev is usable for the maintainer's own work long before the official release
([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)).

| After | MonoCode Dev can… | Needs |
|---|---|---|
| R3 | Pair, read, reply, approve, start sessions over LAN or Tailscale | Fork-built host packages; Xcode development builds on the iPhone |
| R4 | Review changes, commit and push | none |
| R5 | Do the same from anywhere | A personal `services/relay` deployment on the maintainer's Cloudflare account |
| R6 | Notify on approvals, questions and finished turns | An APNs key from the maintainer's team in the personal gateway |

### Pull requests

Work lands as small PRs into the fork's `dev`, per `CONTRIBUTING.md`, each keeping
`npm run check` green. Host, desktop and shared-package changes are written for
upstream (D13): they follow upstream's conventions, stay rebase-clean on upstream
`main`, and are proposed upstream as each milestone stabilises. Phone-facing host
features stay dormant until a phone pairs, so they are safe to ship in desktop
releases before the app is public.

## 14.2 M0 spikes

Each spike is time-boxed to 1 to 3 days and ends with a written decision in this
section.

| ID | Question | Pass condition | Fallback if it fails |
|---|---|---|---|
| S1 | *(Closed by D19: Markdown, highlighting and crypto no longer run on Hermes. Highlighting is S21.)* | | |
| S2 | Can the Notification Service Extension read the push key from the shared keychain group, and open a noble-sealed payload with MonoChannel's CryptoKit code? | An end-to-end push decrypts and displays on a device | Store the push key in the App Group container, encrypted with a key from the shared keychain group |
| S3 | *(Deferred with Android, D19.)* | | |
| S4 | *(Taken over by S23 for the Swift transports.)* | | |
| S5 | Cloudflare Durable Objects: hibernation with control and data sockets, auto-response pings, forwarding latency, real cost. HTTP/2 to APNs is S22 | Added latency < 30 ms in-region; costs within §7.9 | Revisit the Durable Object layout; the relay protocol is unchanged |
| S6 | *(Closed by D19: `apps/ios` is not an npm package.)* | | |
| S7 | *(Replaced by S11. The transcript no longer uses FlashList.)* | | |
| S8 | Can notification actions approve without opening the app (a `UNNotificationAction` without `.foreground`, handled in the background)? | Approve dispatches within the OS's background window | Keep foreground actions in v1 (as specified in [08 §8.9](08-notifications.md#89-tapping-and-actions)) |
| S9 | *(Closed by D19 and M12: SF Symbols replace Hugeicons on iOS.)* | | |
| S11 | **Native transcript benchmark**, the go/no-go for the transcript design. `MonoTranscriptView` with markdown, code-block and trail rows, fed by fixtures in process, streaming at 90 chars/s, with a fling benchmark. The view exists from the prototype; R0 ports it and measures | 0 hitches flinging 1,000 turns while streaming on the iPhone 13; tail re-layout ≤ 1 ms; streaming equals final | Reduce scope (fewer animated row kinds), or move layout to a shared Rust core as zeron does |
| S12 | *(Closed by D19: the chrome is SwiftUI's own.)* | | |
| S13 | *(Closed by D19: there is no JS thread. The off-main budget per delta is in [15 §15.5](15-performance.md#155-budgets).)* | | |
| S10 | *(Closed by D19: Android and pre-26 blur are out of scope.)* | | |
| S18 | Cache encryption: GRDB with SQLCipher through SwiftPM (build size, open time, migration speed), against plain SQLite under Data Protection `completeUntilFirstUserAuthentication` | A decision recorded with numbers from the iPhone 13 | Data Protection only; 03 §3.9 and 12 §12.6 amended |
| S19 | A SwiftUI `List` of MonoCode cards with swipe actions and context menus | 0 hitches flinging 500 cards on the iPhone 13 | A `UICollectionView` list layout with the cards in `UIHostingConfiguration` |
| S20 | Keyboard: the composer in `safeAreaBar` follows interactive dismissal frame by frame, and the UIKit transcript's bottom inset follows with no double offset | The keyboard row of §15.5 passes | A UIKit session controller with a hosted composer pinned to `keyboardLayoutGuide` |
| S21 | Highlighting: tree-sitter (SwiftTreeSitter and grammars) against highlight.js in JavaScriptCore, with the desktop's `github-dark` and `github-light` colours | A 400-line TypeScript file within 50 ms on the iPhone 13 | highlight.js in JavaScriptCore, matching the prototype's output |
| S22 | Can the Cloudflare Worker send to APNs directly (HTTP/2, ES256 token auth)? | A test push from a deployed Worker arrives on a device | A small APNs forwarder outside Workers, called by the gateway |
| S23 | `URLSessionWebSocketTask` to `ws://` LAN, Tailscale `100.x` and `*.ts.net` addresses with `NSAllowsLocalNetworking`. When does the local network prompt fire? | Connects on the iPhone with the documented plist | Network.framework `NWConnection` with `NWProtocolWebSocket`; advertise Tailscale IPs, not names |

### As built (2026-10-04, branch `feat/mobile-app`)

**The app rows below describe the Expo prototype**, frozen at `b286412` as the
reference for the Swift rewrite (D19). The host, desktop and package rows stand.

The owner dropped the "small upstream PRs" constraint, so foundations and the first
slice landed together. A second pass the same day added the host write path, the
app's read and write paths (M2, M3) and the desktop changes from spec 10. A third
pass added M6, Changes and commit. What exists, and what is still unverified:

| Item | Status |
|---|---|
| S6 monorepo | Root `workspaces: ["packages/*"]`. **Deviation:** `apps/mobile` is its own npm project (React Native 0.86 pins React 19.2.3; the desktop has 19.2.8). Metro watches `packages/` and `src/` and resolves their deps from the app. `@tauri-apps/*` is stubbed in Metro, because the desktop model reaches `platform/tauri/fs.ts` through `terminalTab.ts`. Both apps type-check; desktop `npm test` is green |
| `@monocode/channel` | Noise IK passes the cacophony and snow vectors. Records, priorities, bounded deflate, offers, proof, confirmation code, channel client. Push crypto not written yet |
| `@monocode/core` | **Deviation:** re-exports the desktop model in place (moving files is deferred while other branches edit them), so its type-check still needs DOM types. Adds wire types (now also `HostConfigView`, `HostConfigPatch`, `PresenceUpdate` and `DoctorReport`), windowing, truncation, inbox summaries. `HostWorktree`, the question helpers and `buildPlanPrompt` are not exported yet, so the app keeps local copies |
| `@monocode/design` | Palette, tokens, type scale; parity test against `index.css`, `appearance.ts`, `tabGroups.ts` passes |
| Host (M1, M2) | `rpc.ts` dispatcher with error codes (HTTP contract unchanged, 93 old tests green), migration 1, keys, config, pairing manager, direct listener on LAN and Tailscale (:3775), watch with coalesced deltas, `inbox.list`, `sessions.page`, `sessions.blocks` and `sessions.block`, windowed sync, `pair --mobile` with terminal QR. In-memory and real-process end-to-end tests pass |
| Host (M3) | Commands through `engine.commandAsync`: `queue`, `unqueue`, `editQueued`, `steer`, `resumeQueue`, and `create` with `initial` and `worktree`. Mutation receipts keyed by the envelope key, with hourly housekeeping. `finishedAt` and `lastTurnOutcome` on sessions. `host.config.get` and `set`, `presence.update`, and `doctor --json` (`DoctorReport`). New capabilities: `mutations.idempotent`, `sessions.queue`, `sessions.createWithPrompt`, `presence`, `host.config`; `environment.describe` reports `hostVersion`. Not done: relay, push |
| Host (M6) | The workspace methods were already there (`files.list`, `files.read`, `files.search`, `git.index`, `git.fileDiff`, and `git.action` as a mutating method inside `withIdleProject`). Push now gets 110 s, inside the phone's 120 s; other Git calls keep 10 s. `git-action-faults.test.ts` runs against a real checkout whose bare origin counts pushes: a keyed commit or push whose response is lost runs once, whether the phone retries at once, later or over a real channel; a key reused with other params runs nothing; receipts survive a host restart; Git writes wait for running sessions |
| Host deviations | Starting a turn clears `usageLimit`. The queue pauses only when it has items, and `steer` still sends while it is paused. An error-notice block counts as a failed turn. Reusing a receipt key from another device or for another method is a conflict. A new worktree is created only through `commands.dispatch`. At most 100 queued items, with only the `default` and `plan` intents. Config validation is stricter than 06 §6.5. An enabled relay reports `error`, since there is no relay client yet. `doctor` has no firewall, relay, push or clock checks. Presence is tracked per device |
| S11 native transcript | `MonoTranscriptView` (Swift): CoreText measuring on a layout queue, tail-first cold layout then parallel, exact prefix sums, recycled layers rasterised off the main thread, anchoring, follow-tail, taps, fold, approval buttons, in-app fling benchmark writing `Documents/benchmarks/latest.json`. **Compiles and signs for device; the benchmark has not been run on the iPhone 13 yet**, so the go/no-go is open. Unchanged by the second pass |
| App (M1) | Agents, Settings, pairing (QR, paste, links, 6-digit confirm), session screen (native transcript, send, stop, approve), transcript lab, demo machine over a real Noise channel in memory |
| App read path (M2) | Encrypted cache in `src/storage` (expo-sqlite with SQLCipher, forward-only migrations). Projects tab and Project screen with paged session cards (FlashList). Older history, tool sheet, attachment sheet. The demo host serves all of it. ESLint with `eslint-config-expo` |
| App write path (M3) | The outbox (`src/outbox`) sends every command. Other mutating methods are keyed and retried for 60 s when the host lists `mutations.idempotent`. Composer with top bar, chips, + sheet, slash picker, model and access sheets, queue card and usage tab. Approval banner, question form, Plan and Build, Stop, `/compact`. New session with `initial` and `worktree`. Drafts (cache migration 2). **Not built:** the docking animation, Plan burst, dot grid, coloured `/plan` text, context ring, file picking, hardware-keyboard Enter |
| App (M6) | The Project screen has Sessions, Explorer and Changes segments (Changes shows `+N −M`), and a session's ⋯ menu opens Explorer and Changes for its working copy. Explorer: breadcrumbs, folders first, dimmed ignored entries, Go to File; `.git` is listed but doesn't open, since the host refuses paths through it. File viewer: line numbers, wrap, find with "n of m", Markdown Preview, and the "can't be shown" state for the host's oversized and binary refusals. Changes: header with branch and ahead/behind, message field, Commit with a chevron for Commit and push, STAGED CHANGES and CHANGES with the desktop's stage and unstage actions, status letters. Diff viewer: unified diff, Prev and Next within the side it was opened from, wrap. Git writes go through the outbox's `mutate`, one at a time, and are disabled while a session in the project runs. Both viewers are highlighted: plain text first, tokens swapped in after that paint, kept per screen by path, content and scheme; the diff highlights both whole sides and maps tokens to rows by old and new line number. The demo host serves all of it from in-memory repositories (`demoRepo.ts`) |
| App (M6) deviations | FlashList viewers instead of the native transcript's document mode. The diff is computed on the phone from `git.fileDiff`'s two sides (Myers, like the desktop's `buildUnifiedFile`), in hunks with 3 lines of context and no expandable folds. File icons are SF Symbols. R appears only in the demo, because the host reports renames as modified. The diff tints and the disabled primary colours are defined locally, because `@monocode/design` has no tokens for them. No discard actions. Markdown Preview renders through the native transcript. The count pill is neutral. The running check is project-wide, as the host's refusal is. No highlight result cache across screens yet (§12.9 asks for one keyed by language, theme and code hash). Transcript code blocks are not highlighted: the Swift `RowSpec` has no token runs yet |
| App deviations | Backgrounding keeps the channel for 4 s while the outbox flushes, then relies on `expo-background-task`, which runs after 15 minutes at the earliest. Failed and draft bubbles get an action row under them, so the Swift transcript did not change |
| Desktop (spec 10) | `local_host.rs`: "This computer" setup, update, restart, remove, start and doctor. `StoredMachine.local` and the §10.5 allow-list additions in `remote.rs`. `MONOCODE_HOST_LOCAL_ARCHIVE` in both bootstrap scripts. A fork can build with `MONOCODE_RELEASE_BASE` so its desktop installs the fork's host packages. `src/features/mobile`: the Mobile settings page (its own section after Connections), the pairing dialog, the device list, presence calls. "This computer" projects get the phone badge, and the machine picker lists it first. **Not built:** the firewall fix (§10.5), the scheduled host update on launch and every 6 h (updates run only from the Mobile page), and the project menu's "Open on this computer's host" |
| Validation | After M6: desktop `npm test` (4,501 passed, 13 skipped) and `tsc`; `npm run test:host` (179 passed, 5 skipped). App: `tsc`, `expo lint` with no errors or warnings, 219 unit tests, 10 transcript tests. `npm run check:rust` (fmt, clippy, 616 tests) last ran in the second pass; no Rust changed since. The app's commands and methods, the demo host and the desktop allow-list were checked against the host, and M6's workspace calls again in the third pass |
| S4 | `NSAllowsLocalNetworking` plus a `ts.net` exception are configured; not yet verified on the phone |
| S1 | Not measured on a phone yet. In Node (V8), a 400-line TypeScript file takes Shiki 44 to 72 ms, and 190 to 340 ms with the JIT off, which is closer to Hermes; highlight.js takes 6 to 8 ms, and 18 to 30 ms. `hermesc` compiles all 3,399 unique regexes the bundled grammars produce at the ES2018 target; Shiki's precompiled grammars are rejected for the `v` flag. **Decision until S1 runs:** the "auto" backend is highlight.js on Hermes and Shiki elsewhere (Node tests, web), one constant in `src/highlight/backend.ts` to flip if S1 passes on the iPhone 13. The Markdown and crypto parts of S1 have not run |
| Markdown and highlighting | **Deviation:** a small block/inline parser instead of remark. `src/highlight`: Shiki core on its JavaScript regex engine with the desktop's `github-dark` and `github-light`, and highlight.js as the fallback, coloured from the same themes; input over 64 KiB or 1,000 lines stays plain. It colours the file and diff viewers, with highlight.js on Hermes (S1) |

**Still unverified:** the S11 benchmark on the iPhone 13, the camera scan, LAN and
Tailscale access from the phone, and every new screen and sheet. None of them has run
on a device or simulator. The same goes for the background flush, SQLCipher on device,
and a real "This computer" setup run. The app needs a new dev build first: expo-sqlite
(SQLCipher), expo-image-picker, expo-image-manipulator, expo-background-task and
expo-task-manager are native.

None of M6 has run on a device either. Also unverified: `Stack.Toolbar.Menu` (the
session's ⋯ menu) is experimental in Expo Router. The wrap width is estimated from
Menlo's advance, not measured. Shiki has not run on Hermes: its JavaScript engine needs
`d`-flag match indices and a `RegExp` subclass that Babel transforms, and its 500 ms
limit per line can drop multi-line state after a slow line. S1 is still to be measured
on the iPhone 13.

**Not started:** relay, push and app lock. Android is out of v1 (D19).

**Follow-ups:**

- The firewall fix (§10.5) and scheduled host updates on the desktop.
- Export `HostWorktree`, the question helpers and `buildPlanPrompt` from
  `@monocode/core`, so the app can drop its copies.
- Host contract gaps: no question-in-progress signal, no host clock offset, and no
  context usage on the wire.

### As built, R0 (2026-10-06, branch `feat/ios-native-design`)

The Swift app's R0, step by step. Screenshots from the iPhone 17 simulator are in
[`screenshots/r0`](screenshots/r0).

| Item | Status |
|---|---|
| Xcode project | `apps/ios/MonoCode.xcodeproj`, created with Xcode 27 (the iOS App template). Edited by hand after that: the xcconfig references, the `Info.plist` membership exception, the two local package references, and the `MonoCodeUITests` target (objects Xcode generated, plus the host-app dependency and `TEST_TARGET_NAME` its multiplatform template leaves out). No scheme is shared yet; `xcodebuild` generates `MonoCode` with the UI tests in its test action. One app target, MonoCode, whose folder is a synchronized group. iOS 26.0 minimum, iPhone only (`TARGETED_DEVICE_FAMILY = 1`; iPad is R7), portrait, Swift 6 language mode with complete strict concurrency, and Xcode's default main-actor isolation for the app target. `Config/Shared.xcconfig` holds the shared settings and `Config/Personal.xcconfig` the personal track (`com.monocode.mobile.dev`, team `8854B8S8X2`, "MonoCode Dev", scheme `monocode-dev`); `Official.xcconfig` is not written yet. `MonoCode/Resources/Info.plist` adds the URL type and the `MCTrack` and `MCURLScheme` keys, and is excluded from the resources phase. Builds and runs on the iPhone 17 simulator (iOS 27.0) with one empty screen |
| MonoDesign | `apps/ios/Packages/MonoDesign` (iOS 26 and macOS 26, so `swift test` runs on the Mac). `scripts/gen-design-tokens.mjs` bundles `@monocode/design` with esbuild, runs it, and writes `Generated/Tokens.swift`: the tint ranges, accent, project colours, user accent presets, motion curves and durations, radii, the type scale, and `palette()` for dark and light at the default tint, as nested `Palette` structs whose shape is generated from the TypeScript object. `--check` fails when the file is stale. Hand-written: `MonoColor`, `TypeRole`, `CubicBezier`, and conversions to SwiftUI `Color`, `CGColor`, `UIColor`, `Animation` and `CAMediaTimingFunction`. 5 Swift Testing cases. **Deviation (16 R0-1):** no runtime `palette()` for custom tints yet, and no spacing tokens, since the package has none |
| MonoTranscript | `apps/ios/Packages/MonoTranscript` (iOS 26 only). `TranscriptEngine`, `TranscriptLayout` and `TranscriptModels` are carried over from `apps/mobile/modules/transcript/ios` with only Swift 6 changes: `Sendable` conformances (the immutable layout objects and the queue-confined engine are `@unchecked Sendable`), a main-actor `publish`, and `setTheme` taking the JSON string so the parse happens on the layout queue. One carried-over bug is fixed: the paragraph style's line-height settings pointed at a variable outside its scope. `MonoTranscriptView` is a `UIView`: `TranscriptViewDelegate` (action, link, at-bottom, needs-older, ready, benchmark finished) replaces the Expo events, `BenchmarkResult` is a `Codable` struct, `contentScrollView` is exposed for hosting, and the display scale comes from the trait collection. `MonoTranscriptModule` is dropped. The fling benchmark still writes `Documents/benchmarks/latest.json`, now with the model identifier (`iPhone14,5`) as `device`. 6 Swift Testing cases on the simulator, including streaming equals final. **Deviation (16 R0-2):** JSON input stays. **Not built yet** (the prototype had none of them): `reset(rows:anchor:)`, `setTypeScale`, `setHighlights`, `setBottomSpacer`, `menuForLongPress` and `visibleRangeChanged` |
| Fixtures | `scripts/gen-fixtures.mjs` bundles the Expo app's TypeScript with esbuild (`fixtures.ts`, `rows.ts`, `transcriptTheme` from `theme.ts`, `diffRows` from the module's `diff.ts`), stubbing `react`, `react-native` and `@tauri-apps/*`, with the clock fixed at 2026-10-01 09:00 UTC and `TZ=UTC`, so the output is deterministic; `--check` fails on a stale file. It writes `rows-120.json` (855 rows), `rows-1000.json` (7,087 rows), `theme-dark.json`, and `stream.json`: the Expo Lab's stream loop run on a simulated 60 Hz clock (90 chars/s, a tool event every 12 frames), recorded as `diffRows` ops per frame with the time and character count, plus the final live rows. `TranscriptFixture` and `StreamRecording` load them. Tests: the 120-turn rows lay out, the recording runs at 90 chars/s, and replaying all 1,794 frames on the 1,000-turn base ends at the same ids and heights as laying out the final rows at once. **Deviation (16 R0-3):** the fixtures are package resources, not test resources, and the stream is 30 s |
| `scripts/check.sh` | Checks that the generated tokens and fixtures are current (`--check`), runs `swift test` for every package whose manifest lists macOS (MonoDesign), then `xcodebuild test` on the simulator for the iOS-only packages (MonoTranscript) and the app (`MonoCodeUITests`). Parallel testing is off, so no simulator clones are booted. `MC_SIMULATOR` picks the destination (default `name=iPhone 17,OS=27.0`). Passes from a clean build in about 4 minutes: 5 + 9 + 2 tests |
| Transcript Lab | Debug → Transcript Lab (`MonoCode/Debug`, debug builds only): SwiftUI in the root `NavigationStack`, hosting the transcript through `TranscriptHost` (a `UIViewControllerRepresentable` around `TranscriptHostController`). Bottom toolbar: 120, 1,000, Stream or Stop, Fling 10 s; a glass status card in a `.safeAreaBar` shows the scenario, the stream and the benchmark result. The stream replays `stream.json` by time from a `CADisplayLink`, applying every due frame as one batch per display frame. Unattended runs: `monocode-dev://lab?run=huge-stream`, or `-MCOpen <url>` at launch. Debug → Scroll edge control is a plain SwiftUI `List` under the same bars, for comparison. A UI test target, `MonoCodeUITests`, opens the Lab from the Debug list and runs `huge-stream` to the benchmark result. Release builds compile without the Debug folder's code. **Deviations (16 R0-4, R0-5):** no fold or approval taps in the Lab; simulator numbers only |
| Scroll under glass | **Passes on the iPhone 17 simulator.** The hosted transcript scrolls under the glass navigation bar with the same soft scroll-edge blur as the control `List`, and under the bottom toolbar the same way. The effect is the same with `setContentScrollView` skipped. A `.safeAreaBar` is not in the hosting controller's safe area, so its height is passed in (16 §16.6.4). Screenshots 03 to 07 in [`screenshots/r0`](screenshots/r0). Not yet checked on the iPhone 13 |
| Simulator benchmark | iPhone 17 simulator (iOS 27.0, `iPhone18,3`), 1,000 turns (7,087 rows; 7,151 with the live turn), fling at 6,000 pt/s for 10 s. The display link runs at 60 Hz (16.7 ms frames). **Streaming at 90 chars/s with 5 tool events/s, three runs: 0 hitches in 601 frames each**, frame p99 and max 16.7 ms; cold layout first screen 7 to 11 ms, all rows 464 to 489 ms; measure p95 2.3 ms; **tail re-layout p50 1.3 to 1.4 ms, p95 2.0 to 2.2 ms** (about 620 updates); raster p95 3.1 to 3.9 ms; 0 or 1 synchronous draws; the Lab's main-thread work per streamed frame p95 0.03 ms. Idle fling: 0 hitches in 600 frames, raster p95 7.4 ms. A run straight after a cold simulator boot had 3 hitches (6.0 ms/s, max frame 43 ms, raster p95 28 ms) and is discarded as warm-up. These are not S11: the tail re-layout above the 1 ms budget, and the cold layout above 60 ms, are measured on the Mac's CPU and must be re-measured on the iPhone 13 |


### As built, R1 (2026-10-06, branch `feat/ios-native-design`)

UI first (16 §16.7): the shell and the read-path screens on the demo host. One commit
per step. Deviations are in [16 "R1 deviations"](16-ios-native-design.md#r1-deviations).

| Item | Status |
|---|---|
| Fixtures | `scripts/gen-fixtures.mjs` now also bundles `demoHost.ts` (Expo modules stubbed, its private instance exported at bundle time, nothing in `apps/mobile` edited), `@monocode/core/window` and `@monocode/core/transcript`, and writes: `MonoDemo/Resources/demo-state.json` (the demo's projects, worktrees, all 61 `HostSession`s, the model catalog and six seeded replies, 611 KB); MonoDemo's `demo-responses.json` (the demo's answers to 24 read calls: `inbox.list`, `projects.list`, `models.list`, every `sessions.page` page with cursors, `sessions.sync` snapshots and `unchanged`, the `sessions.blocks` chains, a truncated window, an anchor and a reset anchor); MonoWire's `wire-samples.json`, `sync-cases.json` (14 `applySessionSync` cases, five of them errors) and `grouping.json` (19 block lists: the three live demo sessions, a 60-turn fixture and 15 edge cases, with `groupTurns`, `groupTurnItems` settled and live, `foldableWork`, `workSummaryLine`, `turnCopyText` and per block `toolCallLabel`, `toolCallState`, `resolveToolCallDisplay`, `subagentName`, `proseSummary`); and MonoTranscript's `theme-light.json` |
| MonoWire | `Packages/MonoWire` (iOS 26, macOS 26). Codable `Block`, `Session`, `HostSession`, `HostProject`, `ModelCatalog`, `InboxItem`/`InboxList`, `SessionListItem`/`SessionPage`, `SessionSync` (unchanged, snapshot, delta, chunked), `WindowMeta`, `WatchSet`, `OlderBlocks`, `Welcome` and the event payloads; unknown fields are ignored and wire enumerations stay open (R1-2). `applySessionSync`, the window helpers and truncation (`window.ts`), the summaries (`summary.ts`), and the desktop's grouping with its dependencies ported line for line: `transcriptActivity.ts`, the tool predicates and `composeToolTitle` from `preview.ts`, `shellIntent.ts`, the path helpers, `monocodeToolCall.ts`. Strings are counted and sliced in UTF-16 and matched with JavaScript-compatible regular expressions, so the output is the TypeScript's. 10 Swift Testing cases, one of them run over all 19 grouping cases; every fixture object re-encodes to the same JSON |
| MonoSync | `Packages/MonoSync` (iOS 26, macOS 26). `Transport` and `FrameSocket` (12 §12.4), `HostConnState`, and `HostRuntime` as an actor: hello and welcome, request and response matching with timeouts, host errors as `ChannelError`, an ordered event stream, the 50 ms watch debounce, reconnect with backoff (R1-3). `WatchManager`: reference-counted inbox, project and session interest, the 30 s linger, at most 8 sessions (the most recently viewed). The `@Observable` main-actor stores: `HostsStore`, `InboxStore`, `ProjectsStore`, `SessionStore`, `CatalogStore`, `SeenStore`, `PinsStore`. `HostSync` per host: coalesced `inbox.list`, `projects.list`, `models.list`, first and next `sessions.page` pages, windows that decode and apply `session.sync` on a serial queue off the main thread, base-mismatch resync and older pages. `paging.ts` and `older.ts` ported; 17 cases, the paging ones from `paging.test.ts` one for one |
| MonoDemo | `Packages/MonoDemo` (iOS 26, macOS 26). `DemoHost` actor and `DemoTransport`: in process, no Noise. Answers `inbox.list`, `projects.list`, `sessions.page`, `sessions.sync`, `sessions.blocks`, `watch.set` and `models.list`, refuses the rest with `method_not_found`, and advertises only those capabilities. Its history is moved so the fixture's clock is the launch time. Block revision stamps make real deltas; `session.sync` is coalesced to 100 ms per session and `inbox.changed` and `project.sessions` to 500 ms (06 §6.6). `startLiveTurns()` runs R1-1's two turns. 6 cases: all 24 golden answers match the TypeScript demo, and an end-to-end run through `SyncEngine` fills the inbox, both pages, a window and its older page, then streams a live turn into the window until it equals the host's |
| `scripts/check.sh` | Unchanged: it already runs `swift test` for every package whose manifest lists macOS, now MonoDemo, MonoDesign, MonoSync and MonoWire |
| App shell | The project file references MonoWire, MonoSync and MonoDemo. `AppModel` holds the `SyncEngine` and the `Router` (the selected tab, one typed `Destination` path per tab). `RootView` is the `TabView` of 16 §16.6.1: Agents (badge: needs input), Projects, Settings, `accent` tint, `.tabBarMinimizeBehavior(.onScrollDown)`, and the bottom accessory reading its placement (expanded: `plus` "New session" and the braille spinner with "N working" or "Nothing running"; inline: only the count). Each tab is a `NavigationStack(path:)` with large titles. `MonoTheme` puts the dark or light palette from MonoDesign into the environment. Shared pieces: `BrailleSpinner` (frames from the clock, so every spinner turns together), `ShimmerText`, `NoticeBar`, `SectionLabel` with the pulsing dot, `MonoButtonStyle`, `EmptyState`, `DotGrid`, `DemoTag`. Welcome (11 §11.11) with the desktop's app icon over the dot grid; Try the demo adds the demo machine and starts its turns (`-MCDemo YES` does it at launch). Settings is a placeholder page with Debug → Transcript Lab, Scroll edge control and Card fling (S19). Debug links now open on the Settings tab. UI tests: the Lab tests reach it through Settings, and a shell test goes Welcome → Try the demo → Agents → Projects. Deviations R1-5 to R1-7 |

## 14.3 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The host dispatcher refactor breaks the desktop's remote features | Medium | High | M0 is a no-behaviour-change PR. The `server.test.ts` contract is unchanged. The cross-version compatibility test ([13 §13.7](13-testing-and-release.md#137-compatibility-matrix)) |
| OS firewalls block the direct listener | High | Low | The relay fallback, `doctor`, and the desktop's firewall fix button |
| iOS background limits make the app feel stale | Medium | Medium | Push plus the extension; fast foreground verify; cached paint |
| A bug in the custom crypto implementation | Low | High | A standard Noise pattern; official vectors on both implementations (noble and CryptoKit); an external security review of `@monocode/channel` and MonoChannel before v1 |
| The rewrite repeats built work and slips | Medium | Medium | Only the client is rewritten; the prototype's tests are the acceptance list; R0 starts with the transcript, the riskiest piece that carries over ([16 §16.9](16-ios-native-design.md#169-risks)) |
| The Swift client drifts from the TypeScript protocol | Medium | High | Vectors, golden fixtures regenerated in CI, the interop test against a real host, tolerant decoding ([16 §16.5](16-ios-native-design.md#165-keeping-the-swift-client-compatible-with-the-host)) |
| Relay abuse or cost growth | Medium | Medium | Limits (§7.6); direct preferred; per-room push limits; alerts |
| Workers can't reach APNs over HTTP/2 | Medium | Medium | Spike S22; a small APNs forwarder behind the gateway, with no change to hosts or phones |
| Large transcripts on older iPhones | Medium | Medium | Windowing, truncation, the native transcript's exact layout and recycling ([15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview)) |
| The custom transcript lags UIKit text conveniences (text selection, accessibility, find) | Medium | Medium | Specified up front in 15 §15.4; the accessibility checklist is an exit criterion of R1 |
| SwiftUI misses a budget (long lists, keyboard) | Medium | Medium | Spikes S19 and S20, each with a UIKit fallback named up front |
| Smoothness regresses as features land | High | High | §15.3 coding rules; benchmark gates on PRs touching hot paths; the nightly device run |
| App Store review rejection ("requires external server") | Medium | Medium | Demo host, review notes, video |
| Upstream doesn't accept part of the work, or changes the host underneath it | Medium | High | Build on upstream's shipped host (D13); small PRs; language-neutral channel; the personal track runs on fork builds meanwhile |
| The phone drifts from the desktop's design | High | Medium | `@monocode/design` single-sources tokens; the parity test; parity reviews in M2, M3 and M7; the deviations list in [11 §11.1](11-design-and-ux.md#111-design-parity-rules) |
| Personal-account limits (registered device cap, TestFlight review for external testers) | Low | Low | TestFlight internal testing; local Xcode builds |
| Scope creep into desktop parity | High | Medium | [01 §1.3](01-product.md#13-non-goals-for-v1) non-goals; a later list (§14.5) |

## 14.4 Decisions and open questions

**Decided on 2026-10-04** (recorded as D12-D16 in the [README](README.md#decisions)):

1. **Accounts.** The maintainer owns the Apple Developer account (and, until D19, the Expo account) for now
   and builds MonoCode Dev for local workflows. The app is planned as MonoCode's
   official agent app, and an official publisher can take over through the publisher
   config ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)).
2. **Upstream.** Build on upstream's shipped remote host. The fork's Rust daemon plan
   is superseded.
3. **Relay default.** Off until someone opts in.
4. **Full access from the phone.** Allowed, with a confirmation.
5. **App names.** "MonoCode" (official) and "MonoCode Dev" (personal track).

**Decided on 2026-10-05** (recorded as D19):

1. **Native iOS app in Swift.** SwiftUI, with UIKit where a budget needs it. It
   supersedes D1 (Expo, iOS and Android) and D17 (the hybrid architecture).
2. **Minimum iOS 26.** One material tier, Liquid Glass.
3. **Android is out of v1.** Android sections stay in the spec, marked deferred.
4. **The Expo app is frozen** as the reference and deleted when the Swift app
   reaches parity (R4).
5. **The coding agent may build and run the app on the iOS simulator** for this
   work. Installs on the physical iPhone stay with the owner.

**Still open:**

1. **Telemetry.** This spec ships none. Confirm that diagnostics stay local and
   manual. *Before M7.*
2. **Official publisher.** Who publishes the official app and runs `usemono.dev`
   services: upstream's maintainers, or the maintainer with upstream's blessing?
   *Before M8.*
3. ~~**Android distribution for the personal track.**~~ Moot until an Android app
   exists (D19).
4. **After v1.** Is a phone terminal wanted? It needs host PTY support first. Is
   merging local and host sessions into one desktop project entry a priority?

## 14.5 After v1

- Approve and reply directly from notifications in the background (S8).
- iOS Live Activities and Dynamic Island for running turns. Home-screen widgets for
  Agents.
- MonoCode's PR/issue Inbox on the phone (it is desktop-local today; it needs host-side
  integrations first).
- Host-offline alerts from the relay. The room knows when its host disappears while
  turns were running.
- Pairing a new host from a phone already paired with it (needs an `admin` mobile
  role or a delegated invite).
- Short typed pairing codes through the relay (PAKE), for when the camera can't be
  used.
- mDNS discovery (`_monocode._tcp`) of hosts on the LAN.
- Read-only devices and per-device scopes. Sharing a host with a teammate.
- Terminal on mobile, once the host has PTY support (native grid renderer and a
  virtual key row, as Paseo does).
- Voice push-to-talk.
- Editing files, staging hunks, discarding changes, branch switching, pull requests.
- Syncing read and unseen state between desktop and phones.
- Merging a folder's local and host sessions into one desktop project entry.
- A Node adapter for self-hosting the relay outside Cloudflare.
- Windows power assertions while turns run.
- An Android app (Kotlin), implementing the same channel protocol, with FCM tickets
  ([03 §3.8](03-identity-and-crypto.md#38-push-tickets)) and the delivery design in
  [08 §8.8](08-notifications.md#88-android-delivery-deferred).
- F-Droid / no-Google builds with UnifiedPush, once an Android app exists.
