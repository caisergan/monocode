# 14. Roadmap

## 14.1 Milestones

Estimates are in engineer-weeks for one person familiar with the codebase. The
hybrid architecture (D17) adds native work on both platforms. With three engineers in
parallel (TypeScript, host and desktop; iOS native; Android native), the calendar time
to a hardened MonoCode Dev (M7) is roughly 5 to 6 months. M8 depends on upstream
review.

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

**Total: about 43 engineer-weeks** (34 before the hybrid decision, plus 8 for the native transcript and 2 for the performance harness and pass, minus 1 for the React transcript it replaces).

### Personal track checkpoints

MonoCode Dev is usable for the maintainer's own work long before the official release
([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)).

| After | MonoCode Dev can… | Needs |
|---|---|---|
| M3 | Pair, read, reply, approve, start sessions over LAN or Tailscale | Fork-built host packages; EAS internal builds |
| M4 | Do the same from anywhere | A personal `services/relay` deployment on the maintainer's Cloudflare account |
| M5 | Notify on approvals, questions and finished turns | APNs key and FCM project in the maintainer's EAS project; the personal gateway with the maintainer's Expo access token |
| M6 | Review changes, commit and push | none |

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
| S1 | Do `remark-parse` + `remark-gfm`, Shiki's JS regex engine, `@noble/*` and `fflate` run correctly and fast enough on Hermes? | Markdown of 50 KiB parses in < 30 ms; a 400-line TS block highlights in < 50 ms; ChaCha20-Poly1305 ≥ 20 MB/s on Pixel 7 | `highlight.js`; `react-native-quick-crypto` for AEAD and X25519 |
| S2 | Can the iOS NSE (via `@bacons/apple-targets`) read a key written by the app into a shared keychain group, and decrypt a noble-sealed payload with CryptoKit? Where does Expo put `data` in the APNs payload? | An end-to-end push decrypts and displays on a device | A small custom Expo module writes the key to the group if `expo-secure-store` can't target it |
| S3 | Do data-only Expo pushes start the Android background task when the app is swiped away, and under Doze? | A notification is shown within 10 s for high-priority messages on Pixel and Samsung | A native `FirebaseMessagingService` in a config plugin that decrypts in Kotlin |
| S4 | Does `ws://` to LAN IPs, Tailscale `100.x` and `*.ts.net` work from iOS (ATS, Local Network permission) and Android (cleartext config)? When does the iOS permission prompt fire? | Connects on both platforms with the documented plist and config | Connect by IP only; advertise Tailscale IPs, not names |
| S5 | Cloudflare Durable Objects: hibernation with control and data sockets, auto-response pings, forwarding latency, real cost; `fetch` to the Expo push API; HTTP/2 to APNs | Added latency < 30 ms in-region; costs within §7.9 | Run the gateway's direct-APNs provider in a small Node service; keep Expo as the default |
| S6 | Expo with npm workspaces: a different React version from the desktop, Metro resolving `@monocode/*` through `exports`, and the root desktop build unaffected | Both apps build and test from a clean `npm ci` | Pin the desktop's React to Expo's version, or vendor packages into the app with a build step |
| S7 | *(Replaced by S11. The transcript no longer uses FlashList.)* | | |
| S8 | Can notification actions approve without opening the app (iOS background action handling, Android action intents) through Expo? | Approve dispatches within the OS's background window | Keep foreground actions in v1 (as specified in [08 §8.9](08-notifications.md#89-tapping-and-actions)) |
| S9 | Can Hugeicons' free set render in React Native with the desktop's names and stroke 1.75 (an official RN package, or `react-native-svg` over `@hugeicons/core-free-icons` data)? | All icons in the desktop alias table render identically to the desktop at 16-22 pt | Generate RN components from the icon data at build time |
| S11 | **Native transcript prototype**, the go/no-go for D17. On both platforms, a minimal `MonoTranscriptView` with markdown, code-block and trail rows, fed by fixtures through the JSI bridge, with streaming at 90 chars/s and a fling benchmark | 0 hitches flinging 1,000 turns while streaming on iPhone 13 and Pixel 7; tail re-layout ≤ 1 ms; streaming equals final | Reduce scope (fewer animated row kinds), or move layout to a shared Rust core as zeron does |
| S12 | Native chrome with MonoCode tokens: `NativeTabs` with the iOS 26 bottom accessory and minimise behaviour, form sheets with detents, native context menus, `GlassView` composer, Android Material 3 equivalents | Looks like [11](11-design-and-ux.md) and passes the sheet, tab and back-swipe budgets | Custom chrome only where a native component can't be styled to match |
| S13 | JS thread budget per streamed delta on low-end Android: quick-crypto decrypt, inflate, JSON, `applySessionSync`, row build, Shiki in idle slices or a worklet runtime | ≤ 5 ms p95 on a Galaxy A15 class device | Move the row builder and highlighting to a background worklet runtime; reduce coalescing granularity |
| S10 | Glass and effects cost: `expo-blur` bars and sheets, MaskedView shimmer and Skia particles while a transcript streams on a low-end Android | ≤ 5 % dropped frames with glass on | Opaque fallbacks on low-end Android (still the desktop's light-mode treatment), shimmer as an opacity pulse |

## 14.3 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The host dispatcher refactor breaks the desktop's remote features | Medium | High | M0 is a no-behaviour-change PR. The `server.test.ts` contract is unchanged. The cross-version compatibility test ([13 §13.7](13-testing-and-release.md#137-compatibility-matrix)) |
| OS firewalls block the direct listener | High | Low | The relay fallback, `doctor`, and the desktop's firewall fix button |
| iOS background limits make the app feel stale | Medium | Medium | Push plus the extension; fast foreground verify; cached paint |
| A bug in the custom crypto implementation | Low | High | A standard Noise pattern; official vectors on both engines; an external security review of `@monocode/channel` before v1 |
| Relay abuse or cost growth | Medium | Medium | Limits (§7.6); direct preferred; per-room push limits; alerts |
| Dependency on Expo Push | Low | Medium | Tickets carry raw device tokens, so the provider can be switched (§7.5) |
| Large transcripts on low-end phones | Medium | Medium | Windowing, truncation, the native transcript's exact layout and recycling ([15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview)) |
| The two native transcript implementations drift apart | Medium | Medium | One `RowSpec` contract; shared fixtures; golden and screenshot tests on both platforms; one owner reviews both |
| Native transcript features lag React conveniences (text selection, accessibility, find) | Medium | Medium | Specified up front in §15.4; accessibility checklist is an exit criterion of T |
| Smoothness regresses as features land | High | High | §15.3 coding rules; benchmark gates on PRs touching hot paths; the nightly device run |
| App Store review rejection ("requires external server") | Medium | Medium | Demo host, review notes, video |
| Upstream doesn't accept part of the work, or changes the host underneath it | Medium | High | Build on upstream's shipped host (D13); small PRs; language-neutral channel; the personal track runs on fork builds meanwhile |
| The phone drifts from the desktop's design | High | Medium | `@monocode/design` single-sources tokens; the parity test; parity reviews in M2, M3 and M7; the deviations list in [11 §11.1](11-design-and-ux.md#111-design-parity-rules) |
| Personal-account limits (iOS ad-hoc device cap, Expo build quotas) | Low | Low | TestFlight internal testing; local builds with `eas build --local` |
| Scope creep into desktop parity | High | Medium | [01 §1.3](01-product.md#13-non-goals-for-v1) non-goals; a later list (§14.5) |

## 14.4 Decisions and open questions

**Decided on 2026-10-04** (recorded as D12-D16 in the [README](README.md#decisions)):

1. **Accounts.** The maintainer owns the Apple Developer and Expo accounts for now
   and builds MonoCode Dev for local workflows. The app is planned as MonoCode's
   official agent app, and an official publisher can take over through the publisher
   config ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)).
2. **Upstream.** Build on upstream's shipped remote host. The fork's Rust daemon plan
   is superseded.
3. **Relay default.** Off until someone opts in.
4. **Full access from the phone.** Allowed, with a confirmation.
5. **App names.** "MonoCode" (official) and "MonoCode Dev" (personal track).

**Still open:**

1. **Telemetry.** This spec ships none. Confirm that diagnostics stay local and
   manual. *Before M7.*
2. **Official publisher.** Who publishes the official app and runs `usemono.dev`
   services: upstream's maintainers, or the maintainer with upstream's blessing?
   *Before M8.*
3. **Android distribution for the personal track.** EAS internal APKs need no Play
   account. Decide whether a Play internal-testing track is wanted. *Before M3.*
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
- F-Droid / no-Google builds with UnifiedPush.
