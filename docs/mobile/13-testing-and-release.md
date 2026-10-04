# 13. Testing and release

## 13.1 Strategy

| Layer | What it proves | Tooling | Runs in |
|---|---|---|---|
| Shared packages | Session model, sync apply, truncation, diff parsing, Noise, records, offers, push crypto | Vitest (`packages/**/*.test.ts`) | `npm test`, CI on every PR |
| Host | Channel server, pairing, watch, commands, attention, push, migrations, HTTP compatibility | Vitest (`host/vitest.config.ts`), fake providers | `npm run test:host`, CI on Linux, macOS, Windows |
| Relay service | Room claims, routing, buffering, limits, push gateway | `@cloudflare/vitest-pool-workers` (workerd) | CI |
| Cross-component | A real host and relay plus a headless channel client acting as a phone | Node test harness in `packages/channel/e2e` | CI (Linux) |
| Mobile units | Stores, outbox, race logic, row model, markdown renderer, composer rules | Jest (`jest-expo`), React Native Testing Library | CI |
| Mobile end-to-end | Real app on simulators and emulators against the demo host and a real host | Maestro flows | CI (Android emulator on Linux; iOS simulator on macOS), nightly |
| Performance | §15.5 budgets: transcript flings while streaming, lists, sheets, keyboard, startup | XCTest metrics and a display-link fling benchmark (iOS), Jetpack Macrobenchmark and JankStats (Android), the demo host's benchmark scenarios | Nightly on physical reference devices; on demand for hot-path PRs ([15 §15.6](15-performance.md#156-measurement-and-gates)) |
| Native transcript | Row layout and painting on both platforms | Shared fixtures; golden display-list tests; screenshot tests at 3 widths × 2 type scales; streaming-equals-final | CI (simulators and emulators) |
| Manual QA | Devices, networks, push, OS permissions, store builds | Checklists (§13.4) | Before each beta and release |

## 13.2 Automated tests

### Shared packages

- **`@monocode/channel/noise`.**
  - The cacophony test vectors for `Noise_IK_25519_ChaChaPoly_SHA256`. Every vector
    must pass on Node, and on Hermes through a Jest run with the Hermes engine, as a
    smoke test.
  - Plus negative tests: a tampered message 1 or 2, the wrong prologue, a reused
    nonce.
- **`record.ts`:**
  - fragmentation at boundary sizes (0, 1, 65,513, 65,514, 16 MiB);
  - interleaving across message ids;
  - FIN handling, reserved flag bits, oversize messages, too many partial messages;
  - deflate round trip and a deflate bomb that must be cut at the limit.
- **`offer.ts`:** round trip, every validation rule in [04 §4.2](04-pairing.md#42-the-offer),
  and fuzzed inputs.
- **`push.ts`:** cross-implementation vectors. Node seals, Hermes opens; Hermes
  seals, Node opens. The CryptoKit check runs in an XCTest target of the extension
  (S2), in CI on macOS.
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
  - an unregistered token in storage;
  - the Expo stub returning each error type;
  - the receipts alarm.

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

### Mobile

- **Jest:**
  - the race scheduler, with fake transports and timers;
  - the connection state machine;
  - the outbox: ordering, `dependsOn`, expiry, error classes, rewriting ids after
    create;
  - WatchManager reference counting and linger;
  - the row builder against fixture transcripts (every block kind);
  - markdown renderer snapshots;
  - the composer rules: busy, queue, plan, attachments, `/compact`;
  - question reply building;
  - pairing state machine resume.
- **Maestro flows (demo host):**
  - onboarding → demo;
  - open an Agents item → approve;
  - answer a question;
  - send a follow-up while running (queue);
  - start a new session with a worktree;
  - open changes and a diff;
  - app lock;
  - offline banner (toggled by the demo host).
- **Maestro flows (real host, nightly):**
  - pairing through a test hook that approves through `/lifecycle`;
  - direct connect;
  - send and receive.

## 13.3 Network and fault testing

- **Toxiproxy** between a simulator and a local host: added latency (50, 300 and
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
| Phones | iPhone (current and previous iOS, including a 120 Hz ProMotion model and an iOS 26 device for Liquid Glass and the bottom accessory), iPhone SE (small screen), iPad (split view), Pixel (current Android), Samsung Galaxy (One UI battery management), a low-end Android (≤ 4 GB RAM) |
| Hosts | macOS (This computer, via desktop), Linux server (SSH-installed), Windows 11 (SSH-installed), host started by CLI only |
| Networks | Same Wi-Fi; different Wi-Fi with relay; cellular with relay; cellular with Tailscale; corporate Wi-Fi with client isolation (direct fails, relay works); IPv6-only cellular (NAT64) |
| Transitions | Wi-Fi → cellular mid-stream; airplane mode on and off; host sleeps and wakes; host reboot mid-turn (interrupted plus push); relay turned off mid-session; host updated mid-session |
| Pairing | From the desktop; from the CLI; QR via the OS camera (universal link) with the app installed and not installed; paste link; expired code; deny; re-pair the same phone; two phones; phone killed while waiting for approval |
| Notifications | Locked phone: approval and question arrive with content (full) and without (minimal); tap routes; Allow action with Face ID; finished suppressed while watching on the desktop; Android killed app (force-stopped vs swiped away); Do Not Disturb and Focus; notifications disabled at OS level |
| Security | Revoke from the desktop while the phone is connected; app lock timing; app switcher privacy overlay; host key rotation; backup and restore of the phone (keys absent, must re-pair) |
| Accessibility | VoiceOver and TalkBack through Agents, a session, an approval and the question sheet; largest Dynamic Type; Reduce Motion |

## 13.5 Publishers and build tracks

The app is planned as MonoCode's official agent app (D12), but today it is built
under the maintainer's own accounts for local workflows (D14). Two **tracks** keep
these apart. They are separate apps that can be installed side by side, and each
pairs with hosts as its own device.

| | Personal track (now) | Official track (later) |
|---|---|---|
| App name | MonoCode Dev | MonoCode |
| Purpose | The maintainer's daily use and development | Public App Store and Play release |
| Apple team | Maintainer's Apple Developer account | The official publisher's team |
| Expo / EAS | Maintainer's Expo account, project `monocode-mobile-dev` | The official publisher's Expo organisation |
| iOS bundle ids | `com.monocode.mobile.dev`, NSE `com.monocode.mobile.dev.NotificationService` | `com.monocode.mobile`, NSE `com.monocode.mobile.NotificationService` |
| App group / keychain group | `group.com.monocode.mobile.dev` / `<team>.com.monocode.mobile.dev.shared` | `group.com.monocode.mobile` / `<team>.com.monocode.mobile.shared` |
| Android package | `com.monocode.mobile.dev` | `com.monocode.mobile` |
| URL scheme | `monocode-dev` | `monocode` |
| Universal / App Links | None by default. A domain the maintainer controls can be added | `usemono.dev/pair` |
| Push | APNs key from the maintainer's team and an FCM project, uploaded to EAS. A personal gateway deployment holds the maintainer's Expo access token | Official credentials and gateway |
| Relay | A personal deployment of `services/relay` on the maintainer's Cloudflare account, or no relay (direct and Tailscale only) | `relay.usemono.dev` |
| Distribution | iOS: EAS internal distribution (registered devices) and TestFlight internal testing. Android: EAS internal APK; no Play account required | App Store and Google Play |

**Publisher config.** Every value in that table lives in one file per track,
`apps/mobile/publisher/<track>.ts`. `app.config.ts` selects it with
`MONOCODE_PUBLISHER=personal|official`. No other file names a team, domain or
credential.

```ts
type PublisherConfig = {
  track: "personal" | "official";
  appName: string;
  ios: { bundleId: string; teamId: string; appGroup: string; keychainGroup: string;
         nseBundleId: string };
  android: { package: string; googleServicesFile: string };
  eas: { owner: string; projectId: string };
  scheme: string;
  linkDomains: string[];                       // universal / App Link domains
  pushGateway: { url: string; keys: { id: string; public: string }[] };
  defaultRelayUrl?: string;                    // suggested when a host has none
  privacyPolicyUrl?: string;
  supportUrl?: string;
};
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
own app records and credentials, fills `publisher/official.ts`, deploys the relay and
gateway under `usemono.dev`, and ships. The personal app stays installed as the
development variant, as Paseo does with its debug app. Re-registering the personal
bundle ids under another team, or transferring app records, is not needed.

**Host packages on the personal track.** The desktop downloads host packages from the
release matching its version. Today that is upstream's GitHub releases. Until the host
changes in [09](09-host-changes.md) ship in an upstream release, personal desktop
builds point `MONOCODE_RELEASE_BASE` at the maintainer's fork releases, or use
`MONOCODE_HOST_ARCHIVE` with a locally packaged host
([10 §10.2](10-desktop-changes.md#102-this-computer-the-local-host)).

## 13.6 Build and release pipeline

| Item | Plan |
|---|---|
| EAS project | One per track (§13.5). Credentials (APNs key, FCM service account, Expo access token for the gateway) are managed in EAS and Worker secrets, never in the repository |
| Profiles (`eas.json`) | `development` (dev client, personal track, internal distribution); `personal` (release build, personal track, internal distribution and TestFlight internal); `preview` (release build, official identifiers, internal, staging relay and gateway); `production` (official track, stores) |
| Versioning | The app has its own semver (`apps/mobile/package.json`), independent of the desktop. `buildNumber`/`versionCode` are derived from the version (`major*1_000_000 + minor*1_000 + patch`, with a ×100 sub-build for betas), not EAS remote counters, so source builds are reproducible |
| CI | `.github/workflows/mobile.yml`: lint, typecheck, Jest, Expo prebuild check, and Maestro on an Android emulator on PRs touching `apps/mobile` or `packages/*`. Nightly: iOS simulator Maestro and real-host flows |
| Beta (official track) | Tag `mobile-v1.2.0-beta.N` → EAS build `production` → TestFlight external group "MonoCode Beta" and Play Console internal or closed testing |
| Release (official track) | Tag `mobile-v1.2.0` → EAS build and submit → staged rollout (Play 10 % → 50 % → 100 % over 3 days; App Store phased release) |
| Over-the-air updates | `expo-updates` is **not** used in v1. Every change ships as a store build, which avoids JS/native mismatches with the extension and crypto modules. It can be reconsidered later for JS-only fixes |
| Relay and gateway | Official: tag `relay-v*` → `wrangler deploy --env production`, after the staging canary passes ([07 §7.8](07-relay-and-push-service.md#78-operations)). Personal: `wrangler deploy --env personal` from the maintainer's machine |
| Personal builds | `eas build --profile personal` from the maintainer's machine or a manual workflow run. No tags, no store submission |
| Host | Ships with upstream desktop releases, unchanged process (`release.yml` builds host packages). On the personal track, see §13.5 |

## 13.7 Compatibility matrix

The app and hosts update independently. The rules ([06 §6.12](06-channel-protocol.md#612-versioning-and-compatibility)):

| App \ host | Host without channel (≤ 0.7.x) | Host with channel 1, older capabilities | Host with channel 1, current |
|---|---|---|---|
| App 1.x | Blocked: "Update the host" | Works; optional features hidden per capability | Full |

- **Required host version.** The first host release with channel 1 and the required
  capabilities becomes the minimum. The app's store description and the pairing error
  name that version.
- **CI check.** A compatibility test runs the current app's channel client against
  the host package from the previous desktop release.

## 13.8 Compliance

- **Export compliance.**
  - The app implements its own encryption (Noise, ChaCha20-Poly1305) for user data in
    transit. That is not covered by the OS-provided HTTPS exemption.
  - Expected classification: mass-market (EAR 5D992.c). That means
    `ITSAppUsesNonExemptEncryption = true`, the App Store Connect encryption
    questionnaire, and an annual self-classification report to BIS.
  - **This must be confirmed by the publisher before the first store submission.**
    Personal-track builds that never go to TestFlight external testing or the stores
    don't need it, but TestFlight internal testing still asks the encryption question.
- **Privacy labels (App Store) and Data safety (Play).**
  - The app collects no data for the developer. Content goes only to the user's own
    hosts.
  - The relay and gateway operator processes IP addresses and push tokens to operate
    the service. They are not linked to identity and are not used for tracking.
  - A privacy policy page (`usemono.dev/privacy`) describes the relay and push
    gateway data ([07 §7.7](07-relay-and-push-service.md#77-state-kept-by-the-service)).
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
- [ ] Spikes S1 to S8 closed with the decisions recorded in [14](14-roadmap.md).
- [ ] Security review of [03](03-identity-and-crypto.md) against the implementation,
      including a dependency audit and checks that secrets are absent from logs.
- [ ] `publisher/official.ts` is complete, and the official relay and gateway are on production with alerts, and a staging canary has been
      green for 7 days.
- [ ] A host release with channel 1 is published, and the desktop's "This computer"
      setup is verified on macOS, Linux and Windows.
- [ ] The privacy policy, support page and pairing landing page (`/pair`, including
      the "app not installed" state) are live, and AASA and assetlinks validate.
- [ ] Export compliance is filed.
- [ ] Store listing: screenshots (from the demo host), description, keywords, support
      URL.
