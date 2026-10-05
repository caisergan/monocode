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
| R0 Skeleton and transcript | M0 (app skeleton, design foundation, performance harness), T (iOS), S11 | In progress (As built, R0, below) |
| R1 Channel and pairing | M1 | |
| R2 Read path | M2 | |
| R3 Write path | M3 | |
| R4 Workspace and parity | M6. `apps/mobile` is deleted here | |
| R5 Relay | M4 | |
| R6 Push | M5 | |
| R7 Hardening | M7 | |
| R8 Official publication | M8 | |

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
| Xcode project | `apps/ios/MonoCode.xcodeproj`, created with Xcode 27 (the iOS App template), not written by hand. One app target, MonoCode, whose folder is a synchronized group. iOS 26.0 minimum, iPhone only (`TARGETED_DEVICE_FAMILY = 1`; iPad is R7), portrait, Swift 6 language mode with complete strict concurrency, and Xcode's default main-actor isolation for the app target. `Config/Shared.xcconfig` holds the shared settings and `Config/Personal.xcconfig` the personal track (`com.monocode.mobile.dev`, team `8854B8S8X2`, "MonoCode Dev", scheme `monocode-dev`); `Official.xcconfig` is not written yet. `MonoCode/Resources/Info.plist` adds the URL type and the `MCTrack` and `MCURLScheme` keys, and is excluded from the resources phase. Builds and runs on the iPhone 17 simulator (iOS 27.0) with one empty screen |
| MonoDesign | `apps/ios/Packages/MonoDesign` (iOS 26 and macOS 26, so `swift test` runs on the Mac). `scripts/gen-design-tokens.mjs` bundles `@monocode/design` with esbuild, runs it, and writes `Generated/Tokens.swift`: the tint ranges, accent, project colours, user accent presets, motion curves and durations, radii, the type scale, and `palette()` for dark and light at the default tint, as nested `Palette` structs whose shape is generated from the TypeScript object. `--check` fails when the file is stale. Hand-written: `MonoColor`, `TypeRole`, `CubicBezier`, and conversions to SwiftUI `Color`, `CGColor`, `UIColor`, `Animation` and `CAMediaTimingFunction`. 5 Swift Testing cases. **Deviation (16 R0-1):** no runtime `palette()` for custom tints yet, and no spacing tokens, since the package has none |

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
| The custom transcript lags UIKit text conveniences (text selection, accessibility, find) | Medium | Medium | Specified up front in 15 §15.4; the accessibility checklist is an exit criterion of R2 |
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
