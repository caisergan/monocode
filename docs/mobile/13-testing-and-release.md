# 13. Testing and release

## 13.1 Strategy

| Layer | What it proves | Tooling | Runs in |
|---|---|---|---|
| Shared packages | Session model, sync apply, truncation, diff parsing, Noise, records, offers, push crypto | Vitest (`packages/**/*.test.ts`) | `npm test`, CI on every PR |
| Host | Channel server, pairing, watch, commands, attention, push, migrations, HTTP compatibility | Vitest (`host/vitest.config.ts`), fake providers | `npm run test:host`, CI on Linux, macOS, Windows |
| Relay service | Room claims, routing, buffering, limits, push gateway | `@cloudflare/vitest-pool-workers` (workerd) | CI |
| Cross-component | A real host and relay plus a headless channel client acting as a phone | Node test harness in `packages/channel/e2e` | CI (Linux) |
| Swift packages | MonoChannel, MonoWire, MonoStore, MonoSync, MonoHighlight, MonoDemo: crypto vectors, golden fixtures, sync, outbox, cache, race logic | Swift Testing, `swift test` on macOS (no simulator) | CI (macOS) on every change to `apps/ios` or `packages/*` |
| Swift client interop | The Swift client against a real `monocode-host` | `swift test --filter Interop` ([16 §16.5](16-ios-native-design.md#165-keeping-the-swift-client-compatible-with-the-host)) | CI (macOS) |
| App and transcript | Row building, transcript layout and painting, screens against the demo host | XCTest and XCUITest on the iPhone 17 simulator; golden display-list and snapshot tests | CI (macOS), nightly |
| Performance | §15.5 budgets: transcript flings while streaming, lists, sheets, keyboard, startup | XCTest metrics, the Lab's fling benchmark, the demo host's benchmark scenarios | Nightly on physical reference devices; on demand for hot-path changes ([15 §15.6](15-performance.md#156-measurement-and-gates)) |
| Manual QA | Devices, networks, push, OS permissions, store builds | Checklists (§13.4) | Before each beta and release |

## 13.2 Automated tests

### Shared packages

- **`@monocode/channel/noise`.**
  - The cacophony test vectors for `Noise_IK_25519_ChaChaPoly_SHA256`, plus the snow
    vectors.
  - Plus negative tests: a tampered message 1 or 2, the wrong prologue, a reused
    nonce.
- **`record.ts`:**
  - fragmentation at boundary sizes (0, 1, 65,513, 65,514, 16 MiB);
  - interleaving across message ids;
  - FIN handling, reserved flag bits, oversize messages, too many partial messages;
  - deflate round trip and a deflate bomb that must be cut at the limit.
- **`offer.ts`:** round trip, every validation rule in [04 §4.2](04-pairing.md#42-the-offer),
  and fuzzed inputs.
- **`push.ts`:** cross-implementation vectors. Node seals and CryptoKit opens;
  CryptoKit seals a ticket and Node opens it. The CryptoKit side runs in MonoChannel's
  tests.
- **`@monocode/core`:**
  - the moved model tests (about 70 files) run unchanged;
  - `truncateBlock`, `plainTextPreview`, the unified-diff parser;
  - windowed `applySessionSync` cases.

### Host

The full list is in [09 §9.12](09-host-changes.md#912-tests).
The **property test** for watch and sync is the most important:

- It generates random sequences of harness events through `applyHarnessEvent` and
  engine commands:
  - streaming deltas, tool updates, approvals, questions, settles;
  - title updates, deletes, queued dispatches.
- It runs them against a host with two simulated channels:
  - one that stays connected;
  - one that disconnects at random points and reconnects with its last applied
    revision.
- It asserts that both clients' windows always equal `store.sync(window)` of the final
  state, that no delta ever fails to apply, and that no `session.sync` arrives with a
  base the client doesn't hold.

### Relay service

- Room claim:
  - first claim;
  - same key;
  - different key (4403);
  - bad signature (4401);
  - stale timestamp;
  - replacement (4409).
- Phone with no host (4404 after 3 s).
- Buffering before attach, and overflow (4413).
- Host not answering (4504).
- Frame size (1009), text frame (1003).
- Per-room limits.
- Push gateway:
  - signature;
  - nonce replay;
  - ticket opened with the wrong room;
  - a topic outside `APNS_TOPICS`;
  - an unregistered token in storage;
  - an APNs stub returning each response in [07 §7.5](07-relay-and-push-service.md#75-push-gateway);
  - JWT refresh after `ExpiredProviderToken`.

### Cross-component (CI, Linux)

1. Build the host package and start it in a temporary data directory with fake
   providers.
2. Start the relay in workerd locally.
3. A headless client from `@monocode/channel`:
   1. pairs through the relay, approving through `/lifecycle`;
   2. reconnects directly;
   3. drives a fake turn that requests approval;
   4. approves;
   5. checks the transcript;
   6. kills the direct listener mid-stream (firewall simulation);
   7. checks the reconnect through the relay and catch-up with no lost blocks;
   8. gets revoked, and checks `bye device_revoked` and the next handshake error.
4. A push stub server asserts that the right sealed payloads arrive, and that none
   arrive while the client reports presence on that session.

### Swift packages (CI, macOS)

`apps/ios/scripts/check.sh` runs `swift test` in every package, then the app's
XCTest targets.

- **MonoChannel:** the cacophony and snow vectors; the negative Noise tests; records
  at the boundary sizes and the deflate bomb; offers and links; proofs and
  confirmation codes; push open and ticket seal against the TypeScript fixtures.
- **MonoWire:** decode, re-encode and compare every golden wire fixture;
  `applySessionSync` before and after cases; turn and step grouping; question replies;
  tolerant decoding of unknown fields and enum cases.
- **MonoSync:**
  - the race scheduler, with fake transports and a test clock;
  - the connection state machine;
  - the outbox: ordering, `dependsOn`, expiry, error classes, rewriting ids after
    create, `mutate` retries. The prototype's 458-line engine suite ports case by case;
  - WatchManager reference counting and linger;
  - paging, older pages, attachments and uploads;
  - the pairing state machine and its resume.
- **MonoStore:** migrations from every version, eviction, the tables kept on reset,
  the Keychain wrapper against a test keychain.
- **MonoTranscript** (simulator): the row builder against fixture transcripts (every
  block kind), Markdown parser fixtures, golden display lists, streaming equals final,
  snapshot tests at three widths and two type scales.
- **Interop:** the Swift client against a real host, as in
  [16 §16.5](16-ios-native-design.md#165-keeping-the-swift-client-compatible-with-the-host).
- **Fixture and token drift:** CI reruns `gen-fixtures.mjs` and
  `gen-design-tokens.mjs` and fails if the output differs from what is committed.

### XCUITest flows (demo host, CI)

- onboarding → demo;
- open an Agents item → approve;
- answer a question;
- send a follow-up while running (queue);
- start a new session with a worktree;
- open changes and a diff; commit;
- app lock;
- offline banner (toggled by the demo host).

### XCUITest flows (real host, nightly)

- pairing through a test hook that approves through `/lifecycle`;
- direct connect;
- send and receive.

## 13.3 Network and fault testing

- **Toxiproxy** between the simulator and a local host: added latency (50, 300 and
  1,000 ms), bandwidth caps (256 kbit/s), random connection resets, and half-open
  connections where packets are dropped but no FIN is sent. Assertions:
  - no lost or duplicated commands (outbox and receipts);
  - transcript convergence;
  - reconnect times within the [05](05-connectivity.md) targets.
- **Relay fault injection** in workerd tests: delayed data-socket attach, a dropped
  control socket mid-session, rejected claims.
- **Clock skew:** phone clock ±10 min. Offer expiry warnings and question countdowns
  must use host time.

## 13.4 Manual QA matrix

| Dimension | Cases |
|---|---|
| Phones | iPhone 13 on iOS 26 (60 Hz, the owner's device); a current iPhone with ProMotion (120 Hz); iPhone SE (small screen); iPad (split view). All on iOS 26 or later, plus the newest iOS release. Until more devices exist, the iPhone 17 simulator (iOS 27) stands in for the others |
| Hosts | macOS (This computer, via desktop), Linux server (SSH-installed), Windows 11 (SSH-installed), host started by CLI only |
| Networks | Same Wi-Fi; different Wi-Fi with relay; cellular with relay; cellular with Tailscale; corporate Wi-Fi with client isolation (direct fails, relay works); IPv6-only cellular (NAT64) |
| Transitions | Wi-Fi → cellular mid-stream; airplane mode on and off; host sleeps and wakes; host reboot mid-turn (interrupted plus push); relay turned off mid-session; host updated mid-session |
| Pairing | From the desktop; from the CLI; QR via the OS camera (universal link) with the app installed and not installed; paste link; expired code; deny; re-pair the same phone; two phones; phone killed while waiting for approval |
| Notifications | Locked phone: approval and question arrive with content (full) and without (minimal); tap routes; Allow action with Face ID; finished suppressed while watching on the desktop; Do Not Disturb and Focus; notifications disabled at OS level |
| Security | Revoke from the desktop while the phone is connected; app lock timing; app switcher privacy overlay; host key rotation; backup and restore of the phone (keys absent, must re-pair) |
| Accessibility | VoiceOver through Agents, a session, an approval and the question sheet; largest Dynamic Type; Reduce Motion; Reduce Transparency (opaque fallbacks) |

## 13.5 Publishers and build tracks

The app is planned as MonoCode's official agent app (D12), but today it is built
under the maintainer's own Apple Developer account for local workflows (D14). Two
**tracks** keep these apart. They are separate apps that can be installed side by
side, and each pairs with hosts as its own device.

| | Personal track (now) | Official track (later) |
|---|---|---|
| App name | MonoCode Dev | MonoCode |
| Purpose | The maintainer's daily use and development | Public App Store release |
| Apple team | Maintainer's Apple Developer account | The official publisher's team |
| iOS bundle ids | `com.monocode.mobile.dev`, extension `com.monocode.mobile.dev.NotificationService` | `com.monocode.mobile`, extension `com.monocode.mobile.NotificationService` |
| App group / keychain group | `group.com.monocode.mobile.dev` / `<team>.com.monocode.mobile.dev.shared` | `group.com.monocode.mobile` / `<team>.com.monocode.mobile.shared` |
| URL scheme | `monocode-dev` | `monocode` |
| Universal links | None by default. A domain the maintainer controls can be added | `usemono.dev/pair` |
| Push | An APNs key from the maintainer's team, held by a personal gateway deployment | Official credentials and gateway |
| Relay | A personal deployment of `services/relay` on the maintainer's Cloudflare account, or no relay (direct and Tailscale only) | `relay.usemono.dev` |
| Distribution | Development builds on the maintainer's registered devices, and TestFlight internal testing | App Store |

**Publisher config.** Every value in that table lives in one xcconfig file per track,
`apps/ios/Config/Personal.xcconfig` and `Official.xcconfig`. The build configuration
selects it. Values reach the code through `Info.plist` keys, and the entitlements file
uses the same variables. No Swift file names a team, domain or credential.

```
// Config/Personal.xcconfig
MC_TRACK = personal
MC_APP_NAME = MonoCode Dev
PRODUCT_BUNDLE_IDENTIFIER = com.monocode.mobile.dev
DEVELOPMENT_TEAM = <team id>
MC_APP_GROUP = group.com.monocode.mobile.dev
MC_KEYCHAIN_GROUP = $(AppIdentifierPrefix)com.monocode.mobile.dev.shared
MC_URL_SCHEME = monocode-dev
MC_LINK_DOMAINS =                                  // universal-link domains, space separated
MC_PUSH_GATEWAY_URL = https:/$()/<personal gateway>
MC_PUSH_GATEWAY_KEYS = <id>:<base64url public> …   // compiled into the app
MC_DEFAULT_RELAY_URL =                             // suggested when a host has none
MC_PRIVACY_POLICY_URL =
MC_SUPPORT_URL =
```

**What this means for hosts.**
- A host has no single push gateway. Each phone tells the host which gateway serves
  its notifications when it registers
  ([08 §8.6](08-notifications.md#86-push-targets-and-registration)). One host can
  then notify a MonoCode Dev phone and a MonoCode phone at the same time.
- The relay is a host setting (`relay.url`) and works with either app, since it is
  protocol-only.
- The pairing link base is a host setting (`pairing.linkBase`, default
  `https://usemono.dev/pair`). On the personal track it is set to
  `monocode-dev://pair`, so that the OS camera opens MonoCode Dev. Both apps' in-app
  scanners accept any MonoCode pairing link, since the offer itself is self-contained
  ([04 §4.2](04-pairing.md#42-the-offer)).

**Moving to the official track.** No code changes. The official publisher creates its
own app records and credentials, fills `Official.xcconfig`, deploys the relay and
gateway under `usemono.dev`, and ships. The personal app stays installed as the
development variant. Re-registering the personal bundle ids under another team, or
transferring app records, is not needed.

**Host packages on the personal track.** The desktop downloads host packages from the
release matching its version. Today that is upstream's GitHub releases. Until the host
changes in [09](09-host-changes.md) ship in an upstream release, personal desktop
builds point `MONOCODE_RELEASE_BASE` at the maintainer's fork releases, or use
`MONOCODE_HOST_ARCHIVE` with a locally packaged host
([10 §10.2](10-desktop-changes.md#102-this-computer-the-local-host)).

## 13.6 Build and release pipeline

| Item | Plan |
|---|---|
| Signing | Automatic signing per track. Credentials (signing, the APNs key for the gateway, the App Store Connect API key) live in the Apple account, the CI keychain and Worker secrets, never in the repository |
| Configurations | `Debug-Personal` (development, personal track), `Release-Personal` (personal track, TestFlight internal), `Release-Staging` (official identifiers, staging relay and gateway), `Release-Official` (App Store) |
| Versioning | The app has its own semver in `Shared.xcconfig` (`MARKETING_VERSION`), independent of the desktop. `CURRENT_PROJECT_VERSION` is derived from it (`major*1_000_000 + minor*1_000 + patch`, with a ×100 sub-build for betas), so source builds are reproducible |
| CI | `.github/workflows/ios.yml` on a macOS runner, for changes touching `apps/ios` or `packages/*`: `check.sh` (`swift test` for every package, then `xcodebuild test` on the simulator), the fixture and token drift check, and XCUITest flows against the demo host. Nightly: real-host flows and the device benchmarks |
| Beta (official track) | Tag `ios-v1.2.0-beta.N` → `xcodebuild archive` → `-exportArchive` with the `upload` destination → TestFlight external group "MonoCode Beta" |
| Release (official track) | Tag `ios-v1.2.0` → the same archive and upload → App Store phased release |
| Over-the-air updates | None. Every change ships as a build |
| Relay and gateway | Official: tag `relay-v*` → `wrangler deploy --env production`, after the staging canary passes ([07 §7.8](07-relay-and-push-service.md#78-operations)). Personal: `wrangler deploy --env personal` from the maintainer's machine |
| Personal builds | `xcodebuild` from the maintainer's machine: a development build installed with `xcrun devicectl device install app`, or an archive uploaded to TestFlight internal testing. No tags, no store submission |
| Host | Ships with upstream desktop releases, unchanged process (`release.yml` builds host packages). On the personal track, see §13.5 |

## 13.7 Compatibility matrix

The app and hosts update independently. The rules ([06 §6.12](06-channel-protocol.md#612-versioning-and-compatibility)):

| App \ host | Host without channel (≤ 0.7.x) | Host with channel 1, older capabilities | Host with channel 1, current |
|---|---|---|---|
| App 1.x | Blocked: "Update the host" | Works; optional features hidden per capability | Full |

- **Required host version.** The first host release with channel 1 and the required
  capabilities becomes the minimum. The app's store description and the pairing error
  name that version.
- **CI check.** The interop test also runs the Swift client against the host package
  from the previous desktop release.

## 13.8 Compliance

- **Export compliance.**
  - The app implements its own encryption protocol (Noise over CryptoKit primitives)
    for user data in transit. That is not covered by the OS-provided HTTPS exemption.
  - Expected classification: mass-market (EAR 5D992.c). That means
    `ITSAppUsesNonExemptEncryption = true`, the App Store Connect encryption
    questionnaire, and an annual self-classification report to BIS.
  - **This must be confirmed by the publisher before the first store submission.**
    Personal-track builds that never go to TestFlight external testing or the store
    don't need it, but TestFlight internal testing still asks the encryption question.
- **Privacy labels (App Store).**
  - The app collects no data for the developer. Content goes only to the user's own
    hosts.
  - The relay and gateway operator processes IP addresses and push tokens to operate
    the service. They are not linked to identity and are not used for tracking.
  - A privacy policy page (`usemono.dev/privacy`) describes the relay and push
    gateway data ([07 §7.7](07-relay-and-push-service.md#77-state-kept-by-the-service)).
  - The app ships a privacy manifest (`PrivacyInfo.xcprivacy`) declaring the
    required-reason APIs it uses (for example `UserDefaults` and file timestamps).
- **App Review notes:**
  - The app controls software on the reviewer's own computer.
  - A built-in **demo machine** (Welcome → Try the demo) shows every feature without
    setup.
  - Include a short video of pairing with a real host.
- **Open-source licences.** The app bundles the licence texts of its dependencies
  (Settings → About → Licences), generated at build time.

## 13.9 Release readiness checklist (v1)

- [ ] All [success metrics](01-product.md#18-success-metrics) measured on the QA matrix.
- [ ] Every [15 §15.5](15-performance.md#155-budgets) budget passes on every reference device, from the nightly benchmark run.
- [ ] Open spikes closed with the decisions recorded in [14](14-roadmap.md) (S2, S4, S5, S8, S11, S18 to S23).
- [ ] Security review of [03](03-identity-and-crypto.md) against both implementations
      (`@monocode/channel` and MonoChannel), including a dependency audit and checks
      that secrets are absent from logs.
- [ ] `Official.xcconfig` is complete, and the official relay and gateway are on
      production with alerts, and a staging canary has been green for 7 days.
- [ ] A host release with channel 1 is published, and the desktop's "This computer"
      setup is verified on macOS, Linux and Windows.
- [ ] The privacy policy, support page and pairing landing page (`/pair`, including
      the "app not installed" state) are live, and the AASA file validates.
- [ ] Export compliance is filed.
- [ ] Store listing: screenshots (from the demo host), description, keywords, support
      URL.
