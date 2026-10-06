# 16. Native iOS app (Swift)

Status: **plan**, rev 2, 2026-10-05; **R0 in progress** (simulator steps done
2026-10-06, see §16.7 "R0 deviations"), on branch `feat/ios-native-design` (worktree
`.worktrees/ios-native-design`), created from `feat/mobile-app` at `b286412`. Rev 1
(commit `8fc0ca6`) kept React Native and moved the app onto native iOS chrome. On
2026-10-05 the owner decided to rewrite the phone app as a native iOS app in Swift
instead (D19), and this revision replaces rev 1. Read after
[11](11-design-and-ux.md), [12](12-mobile-engineering.md) and
[15](15-performance.md).

This document plans how the phone app is rebuilt in Swift. It covers the platform
baseline, the architecture and package layout, a map from every part of the Expo app to
its Swift home, how the Swift client stays compatible with the TypeScript host, the
design of each surface in SwiftUI, milestones, spikes and risks. It names only
APIs that exist in the iOS 27 SDK shipped with Xcode 27.0
(`SwiftUI.swiftinterface`, `SwiftUICore.swiftinterface`, the UIKit and
BackgroundTasks headers), and states the iOS version each one needs.

## 16.1 Decision and scope

**D19.** The phone app is a native iOS app written in Swift: SwiftUI for screens and
chrome, UIKit where a budget needs it. The minimum is iOS 26. D19 supersedes D1 (Expo
and React Native for iOS and Android) and D17 (the hybrid architecture). Android is
out of v1.

**What changes:**

- **The phone client.** It is rebuilt as `apps/ios`. Every surface in `apps/mobile`
  gets a Swift equivalent (§16.4).
- **Push delivery.** The push gateway calls APNs directly, and Expo Push is gone
  ([07 §7.5](07-relay-and-push-service.md#75-push-gateway)). Nothing in `services/`
  exists yet, so this costs nothing to change.
- **Android.** It moves to "deferred". Its sections in the spec stay and are marked
  deferred. The protocol stays language-neutral (D13), so a later Kotlin app can
  implement it.

**What does not change:**

- **The host, the desktop and the protocol.** `host/`, the desktop app,
  `@monocode/channel` and `@monocode/core` as the host and desktop use them. The same
  goes for the channel protocol ([06](06-channel-protocol.md)), pairing
  ([04](04-pairing.md)), the connectivity rules ([05](05-connectivity.md)), the relay
  rooms ([07](07-relay-and-push-service.md)) and the notification policy
  ([08](08-notifications.md)).
- **What the phone does.** The design language and every screen and state
  ([11](11-design-and-ux.md)). The behaviour of sync, the outbox and the cache
  ([12](12-mobile-engineering.md)). The performance budgets
  ([15 §15.5](15-performance.md#155-budgets)). Every string.

**Owner decisions, 2026-10-05:**

| # | Decision |
|---|---|
| 1 | Minimum iOS 26. There is one material tier, Liquid Glass, and no blur fallbacks |
| 2 | Android is out of v1. Its sections are marked deferred, not deleted |
| 3 | The Expo app in `apps/mobile` is frozen at `b286412` as the reference implementation. No features land there. It is deleted in the change that reaches parity (R4, §16.7) |
| 4 | The coding agent may build and run the app on the iOS simulator for this work. Installs on the physical iPhone stay with the owner |

**How the Expo app is used until then.** It answers behaviour questions: what a
screen shows in each state, what a command sends, and how the outbox retries. Its unit
tests are the acceptance list for each Swift port (§16.4). It is not built or run as
part of this work.

## 16.2 Platform baseline

| Piece | Choice | Notes |
|---|---|---|
| Deployment target | iOS 26.0 | Every API below runs without `#available` checks. iPhone 11 and later run iOS 26. The owner's iPhone 13 updates from 18.7 before device testing |
| Toolchain | Xcode 27.0, iOS 27 SDK, Swift 6 language mode with complete strict concurrency | The installed simulator runtime is iOS 27.0 (iPhone 17, iPhone 17e). There is no iOS 26 runtime, so iOS 26 is covered on the iPhone 13. APIs newer than iOS 26 need `if #available(iOS 27, *)` and a fallback |
| UI | SwiftUI for screens, navigation, sheets, menus and glass. UIKit for the transcript and the viewers (§16.6.4), and where spikes S19 and S20 call for it | |
| State | Observation (`@Observable`), main-actor view models, one actor per host connection (§16.3) | |
| Devices | iPhone first. iPad (sidebar-adaptable tabs, split view) in R7 | |

**SwiftUI and UIKit APIs this plan uses**, checked in the iOS 27 SDK:

| API | Since | Used for |
|---|---|---|
| `TabView` with `Tab(_:systemImage:value:)`, `.badge` | 18 | The tab bar |
| `.tabBarMinimizeBehavior(.onScrollDown)` (`TabBarMinimizeBehavior`: `automatic`, `onScrollDown`, `onScrollUp`, `never`) | 26 | The tab bar minimises while a list scrolls down |
| `.tabViewBottomAccessory { }`, `@Environment(\.tabViewBottomAccessoryPlacement)` (`expanded`, `inline`) | 26 | "＋ New session · N working" |
| `NavigationStack(path:)`, `.navigationTitle`, `.toolbarTitleDisplayMode(.inlineLarge)` and `(.large)` | 16, 17 | A stack per tab, large titles |
| `.navigationSubtitle(_:)` | 26 | "model · machine" under a session's title |
| `.searchable(text:placement:prompt:)`, `.searchToolbarBehavior(.minimize)` | 15, 26 | Search in the bar |
| `.toolbar` with `ToolbarItem(placement: .bottomBar)`, `ToolbarSpacer`, `.toolbarVisibility(_:for:)` | 14, 26, 18 | Viewer toolbars, hiding the tab bar on the session screen |
| `.sheet` with `.presentationDetents` (`medium`, `large`, `fraction`, `height`), `.presentationBackgroundInteraction` | 16.4 | Pickers and the tool sheet |
| `.contextMenu(menuItems:preview:)` | 16 | Session card menus with a preview |
| `.swipeActions(edge:allowsFullSwipe:)` | 15 | Card actions; rows inside a `List` only |
| `.glassEffect(_:in:)`, `Glass` (`regular`, `clear`, `.tint(_:)`, `.interactive(_:)`), `GlassEffectContainer`, `.buttonStyle(.glass)` | 26 | Composer, approval banner, toast, jump to latest |
| `.safeAreaBar(edge:alignment:spacing:content:)`, `.scrollEdgeEffectStyle(_:for:)` (`automatic`, `hard`, `soft`) | 26 | The composer as a bar the transcript scrolls under |
| `.scrollDismissesKeyboard(.interactively)` | 16 | Keyboard dismissal by drag |
| `.sensoryFeedback(_:trigger:)` | 17 | Haptics |
| `.symbolEffect(_:options:value:)` | 17 | SF Symbol animation (pairing success) |
| `.refreshable` | 15 | Pull to refresh |
| UIKit `UIGlassEffect`, `UIScrollEdgeEffect` | 26 | Glass and edge effects inside the UIKit transcript |
| BackgroundTasks `BGContinuedProcessingTask` | 26 | Commit and push continues in the background, with system progress |

**Frameworks.** Apple frameworks come first. A third-party package needs a row here
with a reason.

| Need | Choice |
|---|---|
| Noise, records, push crypto | CryptoKit: `Curve25519.KeyAgreement`, `ChaChaPoly`, `SHA256`, `HMAC`, `HKDF` |
| Record compression (deflate-raw) | Apple `Compression` (`COMPRESSION_ZLIB` is raw deflate, RFC 1951), streaming, with the bounded-output rule of [03 §3.5](03-identity-and-crypto.md#35-record-layer) |
| WebSocket | `URLSessionWebSocketTask`. Network.framework `NWProtocolWebSocket` if spike S23 needs it |
| Network status | Network.framework `NWPathMonitor` |
| Cache | SQLite through GRDB, encrypted per spike S18 |
| Secrets | Keychain Services, with an access group shared with the notification extension |
| QR scanning | VisionKit `DataScannerViewController`, QR only |
| Photos and camera | PhotosUI `PhotosPicker`; the camera through `UIImagePickerController`; ImageIO to downsample and strip EXIF |
| Notifications | UserNotifications and a Notification Service Extension |
| Background work | `UIApplication.beginBackgroundTask`, `BGAppRefreshTask`, `BGContinuedProcessingTask` |
| App lock | LocalAuthentication |
| Sound | AVFoundation, playing the exported `cuelume` cue files |
| Markdown | A Swift port of the app's own block and inline parser (`src/transcript/markdown.ts`) |
| Code highlighting | Decided by spike S21 |

**Third-party packages (SwiftPM):** GRDB (and SQLCipher if S18 keeps encryption), and
the highlighter S21 picks. Nothing else in v1.

## 16.3 Architecture

### Repository layout

```
apps/ios/
  MonoCode.xcodeproj              # app and extension targets; folders are synchronized groups,
                                  #   so the project file holds no per-file lists
  Config/
    Shared.xcconfig
    Personal.xcconfig             # publisher values per track (13 §13.5)
    Official.xcconfig
  MonoCode/                       # the app target
    App/                          # MonoCodeApp, the root TabView, Router, deep links, scene phase
    Agents/  Projects/  Session/  Compose/  Workspace/  Settings/  Pairing/
    Debug/                        # Transcript Lab and the fling benchmark (debug builds only)
    Resources/                    # Assets.xcassets (app icon, harness marks, file-type icons,
                                  #   mascots), cue sounds, Localizable.xcstrings
  NotificationService/            # Notification Service Extension target (08 §8.7)
  Packages/
    MonoChannel/                  # Noise IK, records, envelope, offer and link codec, pairing
                                  #   proof and confirmation code, push open and ticket seal
    MonoWire/                     # Codable wire and session types, applySessionSync, turn and
                                  #   step grouping, question replies, summaries, windowing
    MonoStore/                    # SQLite cache and migrations, Keychain wrapper
    MonoSync/                     # HostRuntime, transports, race, watch, session windows,
                                  #   paging, attachments, outbox, workspace API
    MonoDesign/                   # Generated tokens (palette, type, radii, spacing, motion) and
                                  #   SwiftUI and UIKit helpers
    MonoTranscript/               # The transcript engine, layout, models and view (UIKit), the
                                  #   row builder, Markdown, document mode for the viewers
    MonoHighlight/                # Code highlighting (S21)
    MonoDemo/                     # The demo host
  MonoCodeUITests/                # UI tests (the MonoCodeUITests target)
  scripts/
    gen-design-tokens.mjs         # @monocode/design → MonoDesign/Sources/MonoDesign/Generated/Tokens.swift
    gen-fixtures.mjs              # TypeScript implementations → golden JSON fixtures (§16.5)
```

- **Dependencies point one way.** The app depends on MonoSync, MonoTranscript and
  MonoDemo. MonoSync uses MonoStore, MonoChannel and MonoWire. MonoTranscript uses
  MonoWire, MonoDesign and MonoHighlight. The extension links only MonoChannel and
  MonoStore's Keychain wrapper.
- **Tests run without a simulator where they can.** MonoChannel, MonoWire, MonoStore,
  MonoSync, MonoHighlight and MonoDemo build for macOS too, so `swift test` runs them on
  the Mac. MonoTranscript and MonoDesign's UIKit parts are tested on the simulator with
  `xcodebuild test`.
- **Publisher values** (bundle ids, team, app group, keychain group, scheme, link
  domains, gateway URL and keys) live in the xcconfig files and reach the code through
  `Info.plist` keys. No Swift file names a team, domain or credential
  ([13 §13.5](13-testing-and-release.md#135-publishers-and-build-tracks)). The
  personal track keeps `com.monocode.mobile.dev`, so a Swift build replaces the
  Expo dev build on a phone.

### Runtime

- **`HostRuntime` is an actor**, one per paired host. It owns the transport, the
  Noise cipher states, request matching, the watch set and the reconnect timers. Its
  state machine is unchanged from [12 §12.4](12-mobile-engineering.md#124-host-runtime).
- **Stores are `@Observable` and main-actor bound:** hosts, inbox, projects, one per
  open session, outbox and catalogs. They replace the Zustand stores, and runtimes feed
  them through `AsyncStream`s. Views read only the properties they show, so
  Observation re-renders only what changed.
- **The streaming path stays off the main thread.** The socket receives, then off the
  main actor: decrypt, inflate, JSON decode, `applySessionSync`, row build. The
  transcript then applies the resulting ops on the main thread at most once per display
  frame. SwiftUI never re-renders for a streamed token
  ([15 §15.1](15-performance.md#151-principles)).
- **Navigation lives in a `Router`** (`@Observable`): the selected tab, one
  `NavigationPath` per tab, and the presented sheet. Deep links and notification taps
  resolve into it (§16.6.2).

## 16.4 Porting map

From the Expo app at `b286412` to the Swift app.

| Expo app | Swift home | Notes |
|---|---|---|
| `packages/channel`: `noise`, `record`, `envelope`, `offer`, `pairing`, `session`, `client`, `socket` | MonoChannel | CryptoKit; the same vectors (§16.5) |
| `@monocode/core`: `wire`, `window`, `summary`, `session`, `transcript` | MonoWire | `session.ts` and `transcript.ts` re-export desktop model code: `src/features/sessions/model/session.ts`, `transcriptActivity.ts` and `userQuestion.ts`, and `src/features/connections/model/protocol.ts`. Their types become Codable models. `applySessionSync`, turn and step grouping, `sessionNeedsInput`, `hasPendingApproval` and the question helpers are ported as logic |
| `packages/design` | MonoDesign | Generated by `gen-design-tokens.mjs`. The TypeScript parity test against the desktop stays where it is |
| `src/hosts`: `runtime`, `connect`, `registry`, `pins`, `status`, `seen` | MonoSync | |
| `src/hosts/secrets.ts` | MonoStore (Keychain) | |
| `src/sync`: `sessionWindow`, `paging`, `older`, `projects`, `attachments`, `upload` | MonoSync | |
| `src/outbox`: `engine`, `policy`, `mutate`, `index` | MonoSync | The 458-line engine test suite ports case by case |
| `src/storage`: `schema`, `repo`, `cache`, `sql` | MonoStore | The same tables, starting again at schema version 1 (a new install) |
| `src/pairing/pair.ts` | MonoSync (pairing state machine) and the app's Pairing screens | |
| `src/transcript`: `rows`, `markdown`, `optimistic`, `fixtures` | MonoTranscript | `rows.ts` becomes the row builder and `markdown.ts` the parser. The fixtures feed the Lab and the tests |
| `modules/transcript/ios`: `TranscriptEngine`, `TranscriptLayout`, `TranscriptModels` | MonoTranscript | Carried over. They import CoreText, UIKit and QuartzCore only |
| `modules/transcript/ios`: `MonoTranscriptView`, `MonoTranscriptModule` | MonoTranscript | Rewritten: the `ExpoView` base becomes `UIView`, and the Expo props and events become a Swift API |
| `modules/transcript/src`: `spec.ts`, `diff.ts` | MonoTranscript | `RowSpec` becomes Swift types. There is no bridge, so no ops are serialised |
| `src/highlight` | MonoHighlight | S21 |
| `src/workspace`: `api`, `git`, `diff`, `find`, `lines`, `paths`, `status`, `store` | MonoSync (API, Git, Myers diff) and the app's Workspace screens | |
| `src/workspace`: `ExplorerPane`, `ChangesPane` | The app's Workspace screens | §16.6.6 |
| `src/compose`: `Composer`, `sheets`, `tabs`, `catalog`, `command`, `models`, `pick`, `prefs`, `queue`, `question` | The app's Compose screens | §16.6.5 |
| `src/ui`: `SessionCard`, `ApprovalBanner`, `toast`, `Segmented`, `FileTypeIcon`, `CodeLine`, `components`, `toolbar`, `sheet` | The app and MonoDesign | `sheet` and `toolbar` disappear into SwiftUI's own |
| `src/demo`: `demoHost`, `demoRepo` | MonoDemo | Answers RPCs in process, behind the same transport protocol as a real host (§16.5) |
| `src/app/*` (Expo Router routes) | The app's screens | §16.6 |
| `src/app/lab.tsx` | Debug → Transcript Lab | Runs S11 |

The Expo app's unit tests (`src/**/__tests__`, `modules/transcript/src/diff.test.ts`)
port to Swift Testing next to the code they cover. A Swift port is done when its
ported cases pass.

## 16.5 Keeping the Swift client compatible with the host

The TypeScript host stays the source of truth for the protocol. Three checks keep the
Swift client in step with it:

1. **Crypto vectors.** MonoChannel's tests run
   `packages/channel/src/vectors/cacophony-ik.json` and `snow-ik.json` against the
   CryptoKit Noise implementation. Negative tests from
   [13 §13.2](13-testing-and-release.md#132-automated-tests) are included: a tampered
   message 1 or 2, the wrong prologue, a reused nonce.
2. **Golden fixtures.** `apps/ios/scripts/gen-fixtures.mjs` runs the TypeScript
   implementations and writes JSON fixtures into the packages' test resources. The
   fixtures cover:
   - records at the boundary sizes, and compressed records;
   - offers and pairing links, proofs and confirmation codes;
   - envelopes for every method;
   - push seals and tickets;
   - `applySessionSync` before and after cases;
   - wire objects captured from the demo host and from a real host.

   Swift decodes each fixture, re-encodes it and compares. CI regenerates the fixtures
   and fails on a diff, so a TypeScript change without a matching Swift change fails a
   build.
3. **Interop test.** `swift test --filter Interop` in MonoSync does the following:
   1. builds the host (`npm run host:build`);
   2. starts `node build/host/monocode-host.mjs` in a temporary data directory with
      fake providers;
   3. pairs through a test hook that approves through `/lifecycle`;
   4. runs the Swift client through a handshake, a watch, a fake turn with an approval,
      sync deltas, outbox commands whose responses are dropped, and a revoke.

   It runs on the Mac, with no simulator.

**Decoding is tolerant.** Unknown fields are ignored, and unknown enum cases decode to
an `unknown` case. A newer host therefore doesn't break an older app
([06 §6.12](06-channel-protocol.md#612-versioning-and-compatibility)).

**The demo host** in MonoDemo implements the same `Transport` protocol as the direct
and relay transports, so the runtime, stores, outbox and screens are all real when it
runs. The demo transport skips Noise, as the Expo app's memory transport did. Its
fixtures come from `src/demo/demoHost.ts` and `demoRepo.ts`, converted to JSON by
`gen-fixtures.mjs`.

## 16.6 Design by surface

The rule from rev 1 still holds: **chrome is the platform's, content is MonoCode's.**
- **The system draws the chrome:** the tab bar, navigation bars and large titles,
  search fields, toolbars, menus, sheets and their detents, alerts, transitions, the
  back swipe, scroll-edge effects, Liquid Glass and the keyboard. MonoCode only tints
  the chrome with `accent`.
- **MonoCode draws the content:** cards, rows, the composer, chips, notices, `Group`
  cards, the transcript and the viewers. They keep the desktop's anatomy, tokens,
  radii, type scale and copy from `@monocode/design`
  ([11 §11.1](11-design-and-ux.md#111-design-parity-rules)).

Deviations M12 to M16 (§16.6.11) are recorded in 11 §11.1.

### 16.6.1 Tab bar and bottom accessory

```swift
TabView(selection: $router.tab) {
  Tab("Agents", systemImage: "bubble.left.and.text.bubble.right", value: .agents) {
    AgentsStack()
  }
  .badge(inbox.needsInput)
  Tab("Projects", systemImage: "folder", value: .projects) { ProjectsStack() }
  Tab("Settings", systemImage: "gearshape", value: .settings) { SettingsStack() }
}
.tint(tokens.accent)
.tabBarMinimizeBehavior(.onScrollDown)
.tabViewBottomAccessory { NewSessionAccessory() }
```

- **The accessory** reads `tabViewBottomAccessoryPlacement`:
  - `expanded`: on the left, `plus` and "New session" (15/500). On the right, the
    braille spinner in `accent` and "N working" (13 pt), or "Nothing running" (13 pt,
    α .45).
  - `inline` (the tab bar is minimised): only the spinner and the count.
- **Taps.** "New session" pushes New session onto the current tab's stack. The count
  switches to Agents.
- **The badge** on Agents counts sessions that need input, as today.

### 16.6.2 Navigation

- **Each tab owns a `NavigationStack(path:)`.** Project, Session, Explorer folders,
  Changes and the viewers push onto the stack of the tab that opened them.
- **The tab bar stays visible on pushed screens** (the iOS default). The one
  exception is the session screen, which hides it with
  `.toolbarVisibility(.hidden, for: .tabBar)` because the composer needs the bottom
  edge (M16).
- **Titles.** Agents and Projects use `.toolbarTitleDisplayMode(.inlineLarge)`, so the
  title sits on the bar's row, aligned with `plus` and the search button (owner,
  2026-10-06). Settings uses `.toolbarTitleDisplayMode(.large)`.
  Pushed screens use inline titles.
- **Modals.** Pairing is a `.sheet` at the large detent with its own stack. Everything
  else in §16.6.5 is a sheet with detents.
- **Deep links:**

| Link | Destination |
|---|---|
| `<scheme>://pair#o=…`, `https://<linkDomain>/pair#o=…` | The pairing sheet with that offer |
| A notification tap (approval, question, finished, failed) | The Agents tab with its path reset to that session |
| `<scheme>://m/<env>/s/<sessionId>` | The Agents tab, that session |

### 16.6.3 Agents, Projects and the session lists

- **Lists are SwiftUI `List`s** with `.listStyle(.plain)`. Each row is a MonoCode card:
  `.listRowBackground(Color.clear)`, token insets, and `.listRowSeparator(.hidden)`. A
  `List` gives cell reuse, `swipeActions`, context menus, `.refreshable` and
  `.searchable` together. Spike S19 checks the 500-card fling budget.
- **Agents.** Large title "Agents", and `plus` in the bar. The "Updating…" line and
  the host notices stay as `NoticeBar`s at the top of the list. The Working, Need
  approval and Done sections are unchanged
  ([11 §11.12](11-design-and-ux.md#1112-agents-home)).
- **Projects.** Large title "Projects", and `.searchable(prompt: "Search projects...")`
  with `.searchToolbarBehavior(.minimize)`. `plus` is a toolbar `Menu` holding the
  actions of today's action sheet.
- **Session card menu.** `.contextMenu(menuItems:preview:)` with these items:
  - Pin or Unpin;
  - Rename;
  - "Copy session ID" as a submenu with Harness session ID and MonoCode session ID;
  - Mute notifications;
  - Archive;
  - Delete (`role: .destructive`, disabled while running).

  Items whose host methods don't exist yet (Rename, Archive, Delete, Mute) stay hidden
  until the host lists the capability.
- **The preview** is a light card at a fixed 320 × 200 pt: the title, the last
  assistant line and the status. Building a live transcript for a peek would cost a
  sync; that stays a later option.
- **Swipe actions**, per [11 §11.12](11-design-and-ux.md#1112-agents-home) and
  [§11.14](11-design-and-ux.md#1114-project-screen-and-session-list):
  - Leading (swipe right): Mark seen or unseen on Agents, Pin or Unpin on the
    Project list (`sel.strong` tint).
  - Trailing (swipe left): Archive (`status.danger` tint), hidden until the host
    supports it.
- **Project rows** get a context menu without a preview: Pin or Unpin, New session,
  Copy path.

### 16.6.4 Session screen

- **Header.** `.navigationTitle(title)` and `.navigationSubtitle("model · machine")`.
  The ⋯ button is a toolbar `Menu` with the [11 §11.15](11-design-and-ux.md#1115-session-screen)
  list in this order:
  1. Session info
  2. Explorer
  3. Changes
  4. Rename
  5. Pin (a toggle)
  6. Archive
  7. Mute notifications (a toggle)
  8. Compact context
  9. "Copy session ID", as a submenu
  10. Delete, with the destructive role

  Items the host can't perform are hidden.
- **Transcript.** `MonoTranscriptView` is wrapped in a `UIViewControllerRepresentable`,
  so it scrolls under the glass navigation bar and gets the system's scroll-edge
  effect. **Checked in R0 on the iPhone 17 simulator (iOS 27), 2026-10-06: it does.**
  - The representable ignores the safe area and runs edge to edge. The hosting
    controller passes its `safeAreaInsets` to the transcript as top and bottom
    insets, so rows clear the bars at rest and pass under them while scrolling.
  - Rows under the navigation bar get the same soft edge blur as a plain SwiftUI
    `List` in the same stack, and rows under the bottom toolbar look the same as the
    `List`'s too (`screenshots/r0`, 03 to 07).
  - `setContentScrollView(_:for:)` is not what makes it work: with the call skipped,
    the effect is the same. The controller still registers the scroll view.
  - **SwiftUI bars don't reach UIKit's safe area.** The controller's `safeAreaInsets`
    include the navigation bar and the toolbar, but not a `.safeAreaBar`. The
    composer's height therefore has to be passed to the transcript explicitly, as the
    Lab does for its status card. S20 starts from this.
  - Not yet checked: the iPhone 13 on iOS 26 (R0's device run).
- **Composer.** It sits in `.safeAreaBar(edge: .bottom)`, so the transcript scrolls
  under it. The box is
  `.glassEffect(.regular, in: .rect(cornerRadius: tokens.radius.md))`, with
  MonoCode's α .10 border and α .20 focus border drawn on top. The chips, top bar and
  send button are unchanged.
- **Keyboard.** The composer follows the keyboard frame by frame, including
  interactive dismissal. The transcript's bottom inset follows with it, so the last
  row is never hidden. Spike S20 decides how: SwiftUI's keyboard safe area with
  `safeAreaBar`, or a UIKit session controller that pins a hosted composer to
  `keyboardLayoutGuide`.
- **Jump to latest.** A 32 pt circle with `chevron.down` and
  `.glassEffect(.regular.interactive(), in: .circle)`, centred 12 pt above the
  composer. It shows when the transcript reports that it isn't at the bottom. With an
  undecided approval below the fold it widens to the amber-dotted "Waiting for
  approval" pill (M6). It enters and leaves with `ease.pop`, 170 ms.
- **Approval banner.** A glass card with the dashed α .20 border and `shadow-xl`.
  - It is dragged with `DragGesture` and springs back (M8).
  - Entrance: translateY −8, scale .98, 180 ms `ease.pop`. Under Reduce Motion it is a
    120 ms fade (M9).
- **Toast.** A glass capsule.
- **Tool and attachment sheets.**
  - Detents: `.presentationDetents([.medium, .large])` for the tool sheet and
    `[.fraction(0.75), .large]` for the attachment sheet.
  - The tool sheet adds `.presentationBackgroundInteraction(.enabled(upThrough:
    .medium))`, so the transcript behind it still scrolls at half height.
  - Each has a title and an `xmark` close button.
- **Question form.** It stays inline. The tall case opens a sheet at
  `[.fraction(0.6), .large]` with the same content.

### 16.6.5 Composer pickers and other sheets

Every picker is a `.sheet` with detents, a drag indicator, and a `NavigationStack`
inside it for the title and an `xmark` close button. Each picker edits the composer's
`@Observable` draft directly. The rev-1 problem of moving composer state into a store
(S14) doesn't exist in SwiftUI.

| Sheet | Detents | Content |
|---|---|---|
| Model | `[.medium, .large]` | The model's settings rows, then "Model" → the model list with `.searchable(prompt: "Search models")` and the provider strip |
| Access | `.height(h)`, with `h` measured from the content | The four access rows. Full access confirms with the existing alert (D16) |
| Add to message | `.height(h)` | Camera, Photo library, Plan mode, Draft |
| Place (New session) | `[.fraction(0.6), .large]` | Machines, projects, "Open folder on a machine…" |
| Workspace (New session) | `.height(h)` | Current checkout, worktrees, New worktree |
| Branch (New session) | `[.fraction(0.6), .large]` | Branches, with `.searchable` |
| Session info | `[.fraction(0.6), .large]` | [11 §11.15](11-design-and-ux.md#1115-session-screen) |

- Rows stay MonoCode `SheetRow`, `SheetSwitch` and `SheetCaption` views.
- Every pick fires `.sensoryFeedback(.selection, trigger:)`.

### 16.6.6 Project screen, Explorer, Changes

- **Header.** The title view stays. On the right: `plus`, and a filter `Menu` with
  `line.3.horizontal.decrease`. The menu holds the [11 §11.14](11-design-and-ux.md#1114-project-screen-and-session-list)
  filters as toggles in sections:
  - Archived;
  - Status (Working, Needs approval, Done);
  - Time (All time, Today, Last 7 days, Last 30 days);
  - Provider;
  - Clear filters.

  Only Archived is wired today. The rest stay hidden until `sessions.page` takes those
  filters.
- **Segmented control.** It stays MonoCode's own (Sessions, Explorer, Changes), with a
  selection haptic.
- **Sessions search.** `.searchable(prompt: "Search conversations...")`, shown while
  the Sessions segment is active.
- **Explorer.**
  - The segment shows the root listing.
  - A folder pushes a screen whose title is the folder name, and whose back button
    shows the parent's name. The back stack is the breadcrumb, so the breadcrumb row
    goes away.
  - "Go to File" is `.searchable` on the root and on pushed folders.
  - `.refreshable` reloads the listing.
- **Changes.**
  - The header, the message field, and Commit with a chevron `Menu` (Commit, Commit
    and push) are unchanged.
  - Rows get a context menu (Stage, Unstage, Open) instead of the action sheet.
  - Commit and push runs as a `BGContinuedProcessingTask`, so it finishes if the app
    goes to the background within the host's 110 s.

### 16.6.7 File and diff viewers

- **Engine.** Both viewers use MonoTranscript in document mode, as
  [15 §15.2](15-performance.md#152-architecture-by-surface) planned. The Expo app's
  FlashList viewers were a recorded deviation, and that deviation ends here.
- **Bottom toolbar** (`ToolbarItemGroup(placement: .bottomBar)`):
  - File: a `textformat` `Menu` with Wrap and Preview toggles (Preview only for
    Markdown), `ToolbarSpacer`, then a `magnifyingglass` button that opens Find.
  - Diff: `chevron.left` Prev and `chevron.right` Next, `ToolbarSpacer`, and the Wrap
    menu.
- **Find** is `.searchable(text:isPresented:)`, presented on demand. While it is
  active, the "n of m" counter and the previous and next buttons replace the toolbar
  items.
- **Share.** `ShareLink` shares the file text or the diff as text.

### 16.6.8 Settings and machine details

- **The root.** Large title "Settings", then MonoCode `Group` cards
  ([11 §11.21](11-design-and-ux.md#1121-machines-and-settings)) in a `ScrollView`. Each group pushes
  pages within the Settings stack:
  - App: Machines, Appearance, Security, Privacy;
  - Agents: Chat, Notifications;
  - About: Version, Licences, Diagnostics, Demo.
- **Each page:** an inline title, a page heading (22/600) and description, `Group`
  cards, rows, and a native `Toggle` tinted `accent`.
- **Machine details** show the 11 §11.21 groups. Remove keeps the native alert.
- **Choices on a row** (Lock after, App lock) are a `Picker` with `.menu` style on the
  row's value. A choice whose options need descriptions is a `.height(h)` sheet.
- **SwiftUI `Form` styling is not used.** It would replace MonoCode's `Group` card
  with Apple's, which 11 §11.1 rule 2 forbids.

### 16.6.9 Pairing and onboarding

- **The stage machine is ported unchanged:** offer, scan, connect, confirm, done.
  - Each stage sets its own title: "Pair a computer", "Scan code", "Connect to
    {host}?", "Connecting…", "Confirm", "Paired".
  - Every stage has a Cancel button on the left.
- **The scanner stage** shows `DataScannerViewController`, recognising QR codes only,
  edge to edge under a transparent bar.
- **Success** is `Image(systemName: "checkmark.circle.fill")` with
  `.symbolEffect(.bounce)`, tinted `status.done`, with the success haptic.
- **The Welcome empty state** on Agents is unchanged.

### 16.6.10 Materials, motion, accessibility, haptics

- **Materials.**
  - System chrome is Liquid Glass with no custom backgrounds, blur or shadows.
  - MonoCode's floating surfaces use `.glassEffect`: the composer, banner, toast and
    jump button.
  - Glass is never tinted on bars. It is tinted only on small interactive surfaces,
    and never with more than 20 % `accent`.
- **Reduce Transparency.** Every glass surface has an opaque sibling: `t.base` with a
  `stroke` hairline. It is used when
  `@Environment(\.accessibilityReduceTransparency)` is on, or when the legibility check
  in R1 finds glass over `#171717` too muddy for that surface.
- **Motion.**
  - The `MOTION` tokens become `Animation.timingCurve(_:_:_:_:duration:)` with the
    desktop's bezier points.
  - Springs are used only where a gesture hands off (M8).
  - `@Environment(\.accessibilityReduceMotion)` gates the M9 motions.
- **Dynamic Type.** The type roles scale with `UIFontMetrics`, capped at 1.6×. Card and
  row layouts are fixed per size category, so a row never changes height while it
  scrolls. The transcript gets the same scale.
- **Haptics** through `.sensoryFeedback`:
  - `selection` on segments and picks;
  - `impact(weight: .light)` on chip toggles;
  - `impact(weight: .medium)` on Allow, Deny and Build;
  - `success` on pairing and commit;
  - `warning` on a failed send, a failed commit or a pairing failure;
  - nothing on scroll or streaming.

### 16.6.11 Icons and recorded deviations

- **Icons.** All chrome and content glyphs are SF Symbols. Harness marks and file-type
  icons are template or vector images in the asset catalog. Mascots stay pixel sprites.
- **Deviations recorded in 11 §11.1:**

| # | Deviation | Reason |
|---|---|---|
| M12 | SF Symbols for all chrome and content glyphs, instead of Hugeicons. Harness and brand marks and mascots stay MonoCode's | Tab items, toolbars and menus take SF Symbol names. Mixing two icon families would look wrong |
| M13 | Native large titles on Agents, Projects and Settings, in the system's title font, instead of a 28/600 title. Agents and Projects use the inline large title, on the same row as the bar's buttons (owner, 2026-10-06) | Native titles collapse on scroll. The inline form lines the title up with `plus` and search instead of leaving a row under them |
| M14 | Pickers are native sheets with detents. The rows inside stay MonoCode's | Detents, drag to dismiss and Liquid Glass come from the system |
| M15 | A long press on a session card opens a context menu with a preview. Project and Changes rows get context menus without one. Action sheets remain only for confirmations | UIContextMenu is the iOS idiom for actions on a row |
| M16 | Pushed screens keep the tab bar, except the session screen | The iOS default. The session screen needs the bottom edge for the composer |

## 16.7 Milestones

The host and desktop milestones in [14 §14.1](14-roadmap.md#141-milestones) and their
"As built" record stand. The phone milestones become R0 to R8. Sizes are relative (S,
M, L). Engineer-week estimates are written into 14 after R0, once the speed of the port
is known.

| Milestone | Scope | Exit criteria | Size |
|---|---|---|---|
| **R0 Skeleton and transcript** | The Xcode project with xcconfig tracks and package scaffolds. The token generator. MonoTranscript ported out of the Expo module. Debug → Transcript Lab with the fixtures. The fling benchmark writing `Documents/benchmarks/latest.json`. `scripts/check.sh` running `swift test` and `xcodebuild test` | Builds and runs on the iPhone 17 simulator (iOS 27) and the iPhone 13 (iOS 26). In the Lab, the hosted transcript scrolls under the glass navigation bar with the scroll-edge effect (§16.6.4). S11 is measured on the iPhone 13 (0 hitches flinging 1,000 turns while streaming; tail re-layout ≤ 1 ms), which answers the go/no-go the Expo app left open | M |
| **R1 Shell and read path** (UI first) | MonoWire (Codable read-path types, `applySessionSync`, windowing, summaries, turn and step grouping) checked against golden fixtures. MonoSync's read path: the `Transport` protocol, `HostRuntime`, `WatchManager` and the stores. MonoDemo answering the read path. The app shell (§16.6.1, §16.6.2), Agents, Projects, the Project screen and the session screen with the transcript fed by the Swift row builder, the tool sheet, and the composer as a layout placeholder. All of it on the demo host | Runs on the iPhone 17 simulator: Welcome → Try the demo → Agents, Projects, Project, and a session whose transcript comes from the Swift row builder, matching the TypeScript golden rows. S19 measured. Screenshots of every screen in dark and light. The ported paging tests pass | L |
| **R2 Channel, pairing and a real host** | MonoChannel with vectors and golden fixtures. Direct transport and race (S23). Keychain. Pairing screens and the scanner. The hosts table. Settings → Machines. The cache (S18) and persistence. The read path against a real host | Pairs with a CLI-started host on the LAN, lists its projects and survives a host restart. Revoke closes the channel. The interop test passes. Feature parity with the Expo app's M2 against a real host; the list and navigation budgets in 15 §15.5 pass | L |
| **R3 Write path** | The outbox, the composer, pickers, queue card and usage tab, approvals, the banner, the question form, New session with a worktree, drafts, the keyboard (S20) | Parity with the Expo app's M3. No lost or duplicated commands in fault runs. The keyboard budget passes | L |
| **R4 Workspace and parity** | Explorer, Changes, commit and push, the file and diff viewers in document mode, highlighting (S21) | Parity with the Expo app's M6. **`apps/mobile` is deleted in this change**, and 14's "As built" records it | M |
| **R5 Relay** | The client side of M4: the relay transport and the upgrade probe | 14 M4's exit criteria | M |
| **R6 Push** | The client side of M5: APNs registration, the extension, categories and actions, the badge. The gateway's APNs provider (S22) | 14 M5's exit criteria | M |
| **R7 Hardening** | M7: app lock, privacy overlay, iPad, accessibility, P1 motion, sounds, diagnostics, the QA matrix | 14 M7's exit criteria | L |
| **R8 Official publication** | M8 | 14 M8's exit criteria | S |

**Owner decision, 2026-10-06: UI first.** R1 and R2 swap, so the owner can see and
steer the design before the channel work. R1 builds the app shell and the read-path
screens on the demo host, with no channel, pairing or cache. R2 brings MonoChannel,
pairing, the real transports, the cache and a real host behind the same screens.

**Every milestone ends with:**
- `swift test` for the packages and `xcodebuild test` for the app and MonoTranscript;
- a run on the iPhone 17 simulator, with screenshots of each changed surface (the
  coding agent may do this);
- a run on the iPhone 13 (the owner does this);
- the spec updates for that milestone, in the same change.

### R0 deviations

Recorded as R0 is built; [14 "As built, R0"](14-roadmap.md#as-built-r0-2026-10-06-branch-featios-native-design)
has the detail.

| # | Deviation from this plan | Reason |
|---|---|---|
| R0-1 | MonoDesign carries the palette resolved at the default tint, for dark and light, not a Swift port of `palette()` for any hue, saturation and lightness. It has no spacing tokens | The custom tint is an Appearance setting that has no screen until R7; `@monocode/design` has no spacing tokens to generate |
| R0-2 | `MonoTranscriptView` still takes ops and the theme as JSON strings in the Expo app's `spec.ts` shape (`apply(_:)`, `setTheme(_:)`), parsed with `JSONSerialization` on the layout queue. `RowSpec` is not yet the Swift type of [15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview), and ops are serialised (§16.4 says they are not) | The fixtures and the Lab feed it JSON until the Swift row builder exists (R1, after the 2026-10-06 swap). The prototype's measurements also showed `JSONSerialization` faster than Codable for a 1,000-turn reset. **Resolved in R1** (step 4): `RowSpec`, `TranscriptOp` and `ThemeSpec` are Swift types passed in process; JSON is only how the fixtures are stored |
| R0-3 | The transcript fixtures live in MonoTranscript's own resources (`Sources/MonoTranscript/Resources/Fixtures`), not test resources, so they ship in every build that links the package (about 6 MB). The recorded stream is 30 s long and bound to the 1,000-turn base: it inserts after that fixture's last turn | The Lab loads them at run time. They move to a debug-only bundle before the first TestFlight build. 30 s covers the Lab's benchmark run (stream from 2 s, fling from 3.5 s to 13.5 s) at a third of the size of a full replay |
| R0-4 | The Lab cannot open folds or answer approvals, and its stream replays only on the 1,000-turn fixture. Scenarios run unattended through `<scheme>://lab?run=big\|huge\|huge-stream`, or the `-MCOpen <url>` launch argument, which skips the system's "open in" prompt | Without the Swift row builder (R1) there is nothing to rebuild rows from; the recording is bound to its base (R0-3). The launch argument lets `simctl` and UI tests drive the Lab |
| R0-5 | The R0 benchmark numbers come from the iPhone 17 simulator. Its display link runs at 60 Hz, and the Mac's CPU does the layout. They are not S11, which still needs the iPhone 13 on iOS 26 | The owner runs the device; the coding agent may only use the simulator (decision 4) |

### R1 deviations

Recorded as R1 is built; [14 "As built, R1"](14-roadmap.md#as-built-r1-2026-10-06-branch-featios-native-design)
has the detail.

| # | Deviation from this plan | Reason |
|---|---|---|
| R1-1 | The demo host starts two turns of its own once the app connects: "Profile the transcript scroll" streams an answer, settles and starts again every few seconds, and "Add pagination to /sessions" stops at an `npm test -- auth` approval. The Expo demo is still at rest until the phone sends a command. The Swift demo also answers `sessions.sync` as a request, which the Expo demo only pushed from `watch.set`; it follows 06 §6.7's host algorithm | Without the write path (R3) nothing would ever run, so Working, Need approval, the spinner and shimmer could not be reviewed. The turns copy the Expo demo's own `beginTurn` steps and timing |
| R1-2 | Wire enumerations (`BlockRole`, `SessionStatus`, `RuntimeMode`, attention kinds, preview kinds) are open string types (`Open<Tag>`) rather than Swift enums with an `unknown` case. An unknown value decodes, compares unequal to every known case, reports `isKnown == false` and re-encodes unchanged | Same tolerance as §16.5 asks for, and values a newer host sends round-trip instead of collapsing to one `unknown` |
| R1-3 | `HostRuntime` implements connect, `request`, the event stream, the debounced watch, reconnects with backoff and the 15 s offline wait. `verify`, ping and pong, presence, `scenePhaseChanged` and `pathChanged` are not built. In R1 frames are plain JSON envelopes: the phone sends a hello, the host answers with its welcome | They belong to the channel (MonoChannel, R2). The demo transport skips Noise anyway (§16.5) |
| R1-4 | The seen and project-pin stores live in memory, and there is no host registry: every launch starts at Welcome | Persistence is MonoStore's (R2) |
| R1-5 | Welcome shows "Pair with a computer" disabled. "New session" (the accessory, the bars' `plus`) pushes a placeholder page with the empty-session heading | Pairing is R2 and the composer R3; the entry points stay where the design puts them |
| R1-6 | The theme has no Appearance page: it is Dark, the default, unless the `-MCTheme light\|dark\|system` launch argument says otherwise. Type sizes are fixed at the 11 §11.3 scale, without Dynamic Type | Appearance settings and the Dynamic Type pass belong to R7 |
| R1-7 | The bottom accessory is hidden until a machine exists, with `tabViewBottomAccessory(isEnabled:)`, which needs iOS 26.1; on 26.0 it shows on Welcome too | Nothing to start or count before a machine is paired |
| R1-8 | The Project screen's title is the project name over "Workspace · {machine}" with the ChevronsUpDown glyph, but the working-copy sheet does not open | It needs `git.worktrees`, which the demo host does not answer in R1 |
| R1-9 | Session cards' context menu holds only "Copy session ID" (Harness session ID only when the host sends `providerSessionId`). Pin, Rename, Mute, Archive and Delete, the trailing Archive swipe and the Project list's Pin swipe are hidden; project rows lack "Open folder on machine" and `+N −N`, and Projects has no `plus`. The Project filter menu shows Status, Time and Provider disabled; Archived and Clear filters work | 16 §16.6.3's rule: items whose host methods the machine lacks stay hidden. The demo host answers neither `sessions.update`, `files.list`, `git.index` nor `projects.open`. The filter rows are local, but the brief wires only Archived in R1 |
| R1-10 | A card that needs approval fills with content α .04, as the Expo app's card does, not 11 §11.14's α .20 | α .20 under a dashed α .30 border reads as a selected row; the owner decides (R1 report) |
| R1-11 | The session screen's ⋯ menu lists Session info and "Copy session ID" only. Allow, Deny, Build, the draft row and image rows do nothing when tapped, and there is no attachment sheet. The transcript's per-row accessibility, long-press menu, find highlights and prompt anchoring (`setBottomSpacer`) are not built | The other menu items need host methods or the write path (R3); the attachment sheet needs `attachments.read` (R2). The view API items were not in the R0 prototype either (14 "As built, R0") and land with R3 and R7 |
| R1-12 | A chip never splits across lines, but one wider than the line still breaks inside; it is not truncated in the middle as 15 §15.4 says | Rare at phone widths (a path over about 30 characters); truncation needs a CoreText pass of its own |
| R1-13 | `ease.pop` (11 §11.6) is defined in the app, for the jump-to-latest button, not in MonoDesign | `@monocode/design` exports only `easeOut` and `tabEaseOut`; adding `ease.pop` there is a package change outside `apps/ios` |
| R1-14 | A file chip opens a plain file viewer: `files.read` text with line numbers, scrolled to the chip's line, with no highlighting, wrap, find or Markdown preview. The viewer hides the tab bar, as the session screen does | The owner asked for file chips to open the file on 2026-10-06; the full viewer is R4's document mode (11 §11.20). Opened from a chat, the tab bar coming back over a file would read as leaving the chat (an extension of M16) |
| R1-15 | A markdown table is laid out at the line's width and does not scroll sideways, unlike [12 §12.9](12-mobile-engineering.md#129-rendering) and [15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview) (and 11 §11.16's table row). Columns take their natural width and share any room left. When the table is wider than the line, the columns wider than an even share shrink, to at least 48 pt, and their cells wrap. The table is one `table` row whose cells are `RowSpec.cells`, not 15 §15.4's `boxes` | `MonoTranscriptView` has no nested horizontal scroll views yet: 15 §15.4's lazily created sub-scroll views are not built, and code block lines are still cut at the card's edge. A wrapped table reads whole at phone width without a sideways gesture |
| R1-16 | The app's markdown is not parsed by the Swift port of `markdown.ts` that 12 §12.9 names. `DesktopMarkdown` (`MarkdownFlavor.desktop`, the default) follows the desktop chat's rules: Streamdown with GFM, and `.agent-markdown`'s spacing. It adds `rule` and `table` row kinds, task list markers and strikethrough. The port, `Markdown` (`MarkdownFlavor.expo`), is kept only so the 48 `builder.json` goldens can check the builder's other rows against the TypeScript. The desktop flavour has no generated golden; its 8 tests are written by hand from `AgentMarkdown.tsx` and index.css. Its theme styles (`del`, `listMarker`, `tableCell`, `tableHeader`, and `quote` at prose colour) go beyond `transcriptTheme()`, so the theme parity test checks a subset. Both flavours re-parse a streaming reply's whole text on each delta (the builder rebuilds only the live turn); 12 §12.9 re-parses only the trailing block | The phone should show what the desktop shows (11 §11.16). The Expo parser draws tables as code lines and rules as blank space, and keeps soft line breaks as breaks. Streamdown is React, so gen-fixtures cannot run it for goldens |
| R1-17 | The demo's live session streams a fixed report before its six seeded replies: bold labels, a nested list, a table, a rule, struck text, an ordered list with task items and a bare URL. `gen-fixtures.mjs` writes it into `demo-state.json` (`SHOWCASE`); the TypeScript demo has no such reply | It shows the desktop markdown rules on the demo host, for review and for screenshot 22 |

## 16.8 Spikes

These extend [14 §14.2](14-roadmap.md#142-m0-spikes).

| # | Question | How to answer it | If it fails |
|---|---|---|---|
| S11 | Carried over: 0 hitches flinging 1,000 turns while streaming on the iPhone 13; tail re-layout ≤ 1 ms; streaming equals final | R0, Transcript Lab on the device | As in 14 §14.2: reduce the animated row kinds, or move layout to a shared core |
| S18 | Cache encryption: GRDB with SQLCipher through SwiftPM (build size, open time, migration speed), against plain SQLite under Data Protection `completeUntilFirstUserAuthentication` | R2, day one | Data Protection only. 03 §3.9 and 12 §12.6 are amended |
| S19 | A SwiftUI `List` of MonoCode cards with swipe actions and context menus: 0 hitches flinging 500 cards on the iPhone 13. **iPhone 17 simulator, 2026-10-06: 0 to 3 single-frame hitches per 10 s, usually 1 or 2, cold or warm; not yet passed**, see 14 "As built, R1" | R1 | A `UICollectionView` list layout in a representable, with the same cards hosted by `UIHostingConfiguration` |
| S20 | Keyboard: does the composer in `safeAreaBar` follow interactive dismissal frame by frame, with the UIKit transcript's bottom inset following, with no double offset? | R3, day one | A UIKit session controller: transcript plus a hosted composer pinned to `keyboardLayoutGuide` |
| S21 | Highlighting: tree-sitter (SwiftTreeSitter with the language grammars) against highlight.js in JavaScriptCore. A 400-line TypeScript file within 50 ms on the iPhone 13, with the desktop's `github-dark` and `github-light` colours | R4, day one | highlight.js in JavaScriptCore, which matches the Expo app's output |
| S22 | Can the Cloudflare Worker send to APNs directly (HTTP/2, ES256 token auth)? This replaces S5's Expo Push question | Before R6, with S5 | A small APNs forwarder outside Workers, called by the gateway |
| S23 | `URLSessionWebSocketTask` to `ws://` LAN, Tailscale `100.x` and `*.ts.net` addresses with `NSAllowsLocalNetworking`. When does the local network prompt fire? This takes over S4 for Swift | R2 | Network.framework `NWConnection` with `NWProtocolWebSocket` |

Spikes closed by D19: S1 (Hermes performance), S3 (Android background), S6 (Expo
workspaces), S9 (Hugeicons in React Native), S10 (Android glass), S12 (React Native
chrome), S13 (JS thread budget). Rev 1's S14 to S17 are withdrawn.

## 16.9 Risks

| Risk | Mitigation |
|---|---|
| The rewrite redoes work that is already built (M1 to M6 in the Expo app) | Only the client is rewritten. The ported tests are the acceptance criteria. The Expo app answers behaviour questions. R0 starts with the riskiest piece that carries over |
| The Swift client drifts from the TypeScript protocol | §16.5: vectors, golden fixtures regenerated in CI, the interop test, tolerant decoding |
| Two implementations of the channel crypto | Standard primitives (CryptoKit). Both implementations pass the same vectors. The external security review before v1 covers both ([13 §13.9](13-testing-and-release.md#139-release-readiness-checklist-v1)) |
| SwiftUI misses a budget (long lists, keyboard) | Spikes S19 and S20, each with a UIKit fallback named up front |
| Liquid Glass reads as muddy over the dark base | The opaque sibling is one flag away (§16.6.10). Legibility is checked on R1 screenshots |
| Only one physical device, and it needs iOS 26 | The iPhone 13 updates to iOS 26 before R0's device run. 120 Hz and small-screen checks wait for more devices ([13 §13.4](13-testing-and-release.md#134-manual-qa-matrix)) |
| Upstream doesn't take a Swift app | Host, desktop and package changes stay upstream-shaped (D13). The app is self-contained in `apps/ios` and runs on the personal track meanwhile |
| Two apps in one repository until R4 | `apps/mobile` is frozen and outside the root workspaces. Its CI job is removed at R4 |

## 16.10 Spec changes in this revision

This revision updates the other documents to match D19:

- [README](README.md): rev 4 status, D19, D1 and D17 marked superseded, the summary,
  and the reading order.
- [01](01-product.md): Android moves to the non-goals for v1. Release scope is iOS.
- [02](02-architecture.md): the component diagram, what changes where, and the
  repository layout (`apps/ios`).
- [03](03-identity-and-crypto.md): the Keychain, the CryptoKit implementation, push
  tickets with an APNs token, where secrets live.
- [04](04-pairing.md): the VisionKit scanner.
- [05](05-connectivity.md): Swift transports, `NWPathMonitor`, background work.
- [06](06-channel-protocol.md): two client implementations, kept in step by §16.5.
- [07](07-relay-and-push-service.md): direct APNs delivery, the gateway secrets.
- [08](08-notifications.md): the flow without Expo, the Swift extension, Android
  deferred.
- [11](11-design-and-ux.md): deviations M12 to M16, SF Symbols, materials on iOS 26,
  navigation.
- [12](12-mobile-engineering.md): rewritten as iOS engineering.
- [13](13-testing-and-release.md): Swift tests, the build pipeline without EAS, the
  publisher xcconfig, iOS 26 in the QA matrix.
- [14](14-roadmap.md): R0 to R8, spikes S18 to S23, the closed spikes, risks.
- [15](15-performance.md): fully native; the Swift streaming path; reference devices.
