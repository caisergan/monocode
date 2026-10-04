# 15. Performance and smoothness

Smoothness is a product requirement, not polish (D18). The app must feel as fluid as
a native app everywhere: lists, navigation, sheets, keyboard, startup, and above all a
streaming transcript. The reference bar is zeron's iOS app (`github.com/zeronsh/zeron`,
`docs/mobile-rewrite.md`). It reports zero hitches while flinging through 3,300 rows
during streaming, measured on a simulator.

The approach is a **hybrid** (D17):
- Expo and React Native for the app shell.
- The platform's own navigation, tabs, sheets and glass.
- One native component, the **transcript**, which lays out and paints rows itself.

React never sits between a streamed token and a painted frame.

## 15.1 Principles

1. **The UI thread only paints, scrolls and animates.** No JavaScript runs on a
   frame's critical path. Animations run on the UI thread (Reanimated worklets or
   native code), never on JS timers.
2. **Sizes are known before anything is shown.** Transcript rows are measured
   exactly, off the main thread, before display. List rows have deterministic heights.
   Nothing self-sizes on screen, and no estimate is corrected while scrolling.
3. **Incremental everywhere.** One changed entry means one rebuilt row:
   - unchanged entries keep identity (`applySessionSync` keeps unchanged blocks
     pointer-equal);
   - only the streaming tail block is re-parsed and re-measured;
   - only the visible rows that changed are repainted.
4. **At most one update per surface per display frame.** Streamed deltas are
   coalesced to the next frame before they reach native code.
5. **Native chrome and gestures.** The navigation stack, tab bar, sheets, context
   menus, back gestures and glass are the platform's components. They run in the
   render server or native code and cost nothing on the JS thread.
6. **Streaming bypasses React.** Channel → sync engine → row builder → native
   transcript. React renders the screen around the transcript, not the transcript.
7. **Cached first paint.** Every screen paints from the local cache before any
   network work. Spinners are a last resort.
8. **Measured, with gates.** Budgets (§15.5) are checked by automated benchmarks on
   real devices (§15.6). A regression fails the gate like a failing test.

## 15.2 Architecture by surface

| Surface | Implementation | Why |
|---|---|---|
| Navigation stack, back swipe, titles | Expo Router on `react-native-screens` native stack (UINavigationController / Android fragments). iOS 26 gets Liquid Glass bars and buttons automatically | Native transitions and gesture physics; zero JS per frame |
| Tab bar | Expo Router `NativeTabs` (UITabBarController / Material bottom navigation). iOS 26: `minimizeBehavior: "onScrollDown"` and a `BottomAccessory` "New session · N working" ([11 §11.10](11-design-and-ux.md#1110-navigation)). iPad: `sidebarAdaptable` | System tab bar, Liquid Glass, native accessory placement |
| Sheets (model, access, add to message, filters, working copy, session info) | `react-native-screens` form sheets with detents (`medium`, `large`, `fitToContents`) | Native presentation and drag; Liquid Glass sheets on iOS 26 |
| Long-press menus | Native context menus (UIMenu with preview on iOS; Android popup menu) | Instant, platform-correct, no JS animation |
| Dialogs | Native alerts for simple confirms; a native modal screen for the rest | |
| Glass surfaces (composer, jump-to-latest, approval banner, floating buttons) | `expo-glass-effect` `GlassView` / `GlassContainer` on iOS 26 (render-server refraction); `expo-blur` before iOS 26; opaque tokens on low-end Android | No blur stacks redrawn from JS |
| **Transcript** | `MonoTranscriptView` native module (§15.4) | The surface that decides whether the app feels smooth |
| Diff viewer and file viewer | The same native engine in document mode: rows are diff lines or source lines | Long files fling smoothly; one engine to optimise |
| Lists (Agents, Project sessions, Projects, Settings, Explorer, Changes) | FlashList v2 with deterministic row heights computed from the type scale and font scale; pure row components; per-row data subscriptions | Recycling without measurement corrections |
| Live list details (braille spinner, shimmer, mascot hop, relative times) | UI-thread animations: spinner glyph layers cycle opacity on the UI thread; shimmer is a Reanimated gradient under a mask. Relative times re-render once a minute, batched | No React renders per spinner frame |
| Keyboard and composer | `react-native-keyboard-controller` (frame-by-frame keyboard tracking on the UI thread, interactive dismissal). The native transcript receives the keyboard inset directly through a native-to-native binding. The composer is a native `TextInput` that grows without JS measuring | The composer and transcript move with the keyboard, never behind it |
| Images | `expo-image`: decoded off the main thread, downsampled to display size, bounded memory cache | |
| Startup | Hermes bytecode; route modules loaded lazily; the cached Agents screen read with `expo-sqlite`'s async API; the native splash held until the first cached frame | Under 1 s to a real screen |
| JS thread | Transport crypto in native code (`react-native-quick-crypto`: X25519, ChaCha20-Poly1305), `fflate` for inflate, Hermes' native JSON parse. Snapshot parsing chunked across frames. Shiki highlighting in idle slices or a `react-native-worklets` background runtime (spike S13) | The JS thread stays free to answer touches within a frame |
| Theme and Dynamic Type changes | Tokens recomputed once. The transcript gets one `setTheme` or `setTypeScale` op and re-lays out off the main thread, swapping visible rows when ready | No visible reflow stutter |
| Refresh rate | iOS: `CADisableMinimumFrameDurationOnPhone = YES` so ProMotion devices animate at 120 Hz. Android: the system's high refresh rate; no forced frame-rate caps | |

## 15.3 Coding rules

These are enforced by lint where possible, and by review otherwise.

- No React Native `Animated`, no `LayoutAnimation`. Use Reanimated, or native code
  inside modules.
- No `setState` in scroll, gesture or keyboard handlers. Use shared values.
- No `onLayout`-driven sizing in list rows. Heights come from tokens.
- Components never subscribe to a whole store. Use narrow selectors only (React
  Compiler stays on).
- Nothing streaming, meaning session deltas and timers, flows through React state
  for the transcript. It goes through the transcript bridge.
- Images always have explicit sizes.
- Every new screen gets a benchmark scenario (§15.6) before it ships.

## 15.4 The native transcript (`MonoTranscriptView`)

### Responsibilities

```
TypeScript (JS thread)                         Native (layout thread → UI thread)
──────────────────────                         ──────────────────────────────────
session window (sync engine)
  → groupTurns / groupTurnItems (core)
  → remark block parse (tail only when streaming)
  → Shiki token runs for code
  → RowSpec[] with ids and versions
  → ops: insert / update / remove / move      → layout: measure each changed row with the
    (coalesced to one batch per frame,           platform text engine at the viewport width,
     sent over JSI)                              build its display model, update prefix sums
                                               → UI thread: scroll view realises rows in
                                                 [y0 − overscan, y1 + overscan], paints with
                                                 the same text-engine objects it measured with
  ← events: action, link, long press,         ← hit testing, gestures, native animations
    visible range, at-bottom, need-older
```

**Text engine.** Each platform uses its own engine: TextKit 2 / CoreText on iOS, and
`StaticLayout` / `Layout` on Android.
- This deliberately differs from zeron, which measures in Rust with a bundled font.
- MonoCode uses the **system font** for design parity
  ([11 §11.3](11-design-and-ux.md#113-typography)). A Rust shaper cannot faithfully
  measure SF Pro's optical sizes and tracking.
- Measuring and painting with the same platform objects removes any chance of the
  measured layout and the painted layout disagreeing about line breaks.
- It also keeps the Rust toolchain out of mobile builds.
- The cost is two implementations, iOS and Android, behind one shared row
  specification.

### Row specification (shared TypeScript types, `apps/mobile/modules/transcript/src/spec.ts`)

```ts
type RowSpec = {
  id: string;                 // stable: blockId, blockId#n for markdown blocks, synthetic ids for fold lines
  version: number;            // bumps on any content change; native re-measures only on change
  kind:
    | "userBubble" | "draftBubble" | "markdown" | "codeBlock" | "table" | "foldLine"
    | "phaseHeader" | "trailRow" | "thinkingRow" | "diffCard" | "planCard" | "taskList"
    | "subagentRow" | "approvalControls" | "notice" | "divider" | "turnFooter"
    | "attachments" | "loadOlder" | "spacer";
  indent?: number;            // trail depth (rail drawing)
  rail?: { spine: boolean; branch: boolean; last: boolean };
  runs?: TextRun[];           // styled text: { text, style: StyleId, link?, fileRef?, highlight?, chip? }
                              // chip = { icon?: IconId }: an inline rounded chip (inline code, file chips)
  blocks?: BoxSpec[];         // code/table/bubble/card boxes with nested runs
  actions?: ActionSpec[];     // buttons: { id, label, variant, enabled }
  images?: ImageSpec[];       // { uri (cached file), width, height }
  anim?: { shimmer?: boolean; pulse?: boolean; spinner?: boolean; mascot?: MascotSpec;
           stepEnter?: boolean; veilFrom?: number };   // veilFrom = UTF-16 offset of newly streamed text
  a11y: { label: string; traits?: string[] };
};
```

- **Inline chips.** Inline code and file chips are drawn inside the text flow, as in
  `11-design-and-ux.md` §11.16:
  - a rounded `fill.chip` background behind the run's glyph range, with the chip's
    horizontal padding counted in line layout;
  - an optional 16 pt icon as an inline attachment before the text.
  - iOS uses a TextKit 2 text attachment plus custom background rendering for the
    rounded range. Android uses a `ReplacementSpan` that draws the background and
    icon and reports its width.
  - Chips never split across lines; a chip wider than the line truncates in the
    middle.
  - Hit testing returns the run's `fileRef`.
- **`StyleId`** maps to token-derived text styles (prose, bold, inline code, link,
  heading levels, mono, caption tiers, status colours). The styles are sent once with
  `setTheme`, so rows carry ids, not colours.

### Bridge API (Expo module, JSI)

| Call | Purpose |
|---|---|
| `reset(viewId, rows, anchor)` | Replace all rows, for example when opening a session. Anchor `bottom` or `{rowId, offset}` |
| `apply(viewId, ops)` | Batched `insert`, `update`, `remove`, `move` ops for one frame |
| `setTheme(viewId, tokens, styles, motion)` | Colours, text styles, radii and motion tokens from `@monocode/design` |
| `setTypeScale(viewId, scale)` | Dynamic Type or font scale changes |
| `setFollowTail(viewId, on)` / `scrollTo(viewId, target, animated)` | Bottom anchoring and jump-to-latest |
| `setHighlights(viewId, matches, current)` | Find in conversation |
| `setBottomSpacer(viewId, mode)` | Prompt anchoring (viewport minus the last turn's height, computed natively) |

| Event | Payload |
|---|---|
| `onAction` | `{rowId, actionId}`: Allow, Deny, Build, Open, Show more, fold toggle, copy, retry |
| `onLink` | `{rowId, href \| fileRef}` |
| `onLongPress` | `{rowId, runIndex}`, which opens the native context menu |
| `onVisibleRange` | `{first, last}` row ids, used for prefetch and seen tracking |
| `onAtBottomChange` | `boolean`, which drives the jump-to-latest button |
| `onNeedOlder` | Reached the top; JS calls `sessions.blocks` |

### Behaviour

- **Streaming.**
  1. The sync engine applies a delta.
  2. The row builder rebuilds only the affected rows.
  3. Ops are coalesced with `requestAnimationFrame` and sent once per frame.
  4. Natively, the tail row is re-measured on the layout thread, and the new display
     model swaps in while the old one keeps painting.
  5. Newly streamed text fades in on a veil layer split at the exact glyph offset
     (`veilFrom`). This is the desktop's word fade, implemented natively.
- **Follow-tail and anchoring.** The desktop rules apply: within 16 pt counts as
  pinned, and any upward scroll un-pins. Prepending older turns keeps the anchor row at
  the same screen position. Because heights are exact, nothing jumps.
- **Animations, implemented natively with the token values:**
  - fold open and close (340 ms, `ease.out`);
  - step entrance (slot, spine, branch, rise, with the queue pacing of 480 → 160 ms);
  - shimmer;
  - thinking pulse;
  - braille spinner;
  - mascot hop;
  - copy-to-check morph;
  - the Plan burst on the user bubble.

  All of them respect Reduce Motion
  ([11 §11.6](11-design-and-ux.md#116-motion)).
- **Nested horizontal scrolling.** Code blocks and tables scroll sideways with lazily
  created native sub-scroll views. Vertical flings win the gesture by default.
- **Hit testing and gestures.**
  - Taps on links, file chips and buttons are resolved natively from the display
    model's hit rectangles.
  - A long press opens a native context menu with Copy text, Copy turn, Share and
    Select text.
  - Select text opens a native selectable text view with that block's text.
- **Accessibility.**
  - iOS: one accessibility element per row, plus a rotor for headings, links and
    buttons. Android: an `AccessibilityNodeProvider`.
  - Rows carry their `a11y.label`. The transcript announces the finished reply once,
    at the end of the turn.
- **Images.** Attachment thumbnails come from cached file URIs. They are decoded and
  downsampled on a background queue.
- **Memory.**
  - Display models outside three screens of the viewport are dropped. Measurements
    stay, as they are small.
  - The layout cache is keyed by `(rowId, version, width, typeScale, themeRevision)`.
- **Icons in rows.** Activity kind icons, chevrons, file-type icons, harness logos
  and mascots come from `packages/brand` and the Hugeicons alias table. The
  file-type icons are the desktop's Material Icon Theme set (`react-material-icon-theme`),
  resolved by the same name and extension rules as the desktop's `FileTypeIcon`. They
  are converted at build time to native vector assets: PDF/SVG in the iOS asset catalog,
  VectorDrawable on Android (`scripts/build-native-assets`).

### Testing the transcript

- **Shared fixtures.** One set of transcripts covers every block kind, long markdown,
  huge code blocks and streaming sequences.
  - They feed golden tests on both platforms: row count, order, kinds and hit-rect
    structure.
  - They also feed screenshot tests at three widths and two type scales.
- **Streaming equals final.** Streaming a fixture token by token must produce the
  same final layout as laying out the completed text at once (zeron's equivalent
  check).
- **Benchmarks:** §15.6.

## 15.5 Budgets

Reference devices:
- iPhone 13 (60 Hz) and iPhone 15 Pro (120 Hz);
- Pixel 7 (90 Hz);
- low-end Android, Galaxy A15 class.

Hitch ratio is Apple's measure: milliseconds of hitch per second of scrolling.

| Scenario | Reference devices | Low-end Android |
|---|---|---|
| Fling through a 1,000-turn transcript, idle | 0 hitches | ≤ 2 ms/s |
| Same, while a turn streams (90 chars/s plus 5 tool events/s) | 0 hitches | ≤ 3 ms/s |
| JS work per streamed delta (apply + row build + op batch) | ≤ 2 ms p95 | ≤ 5 ms p95 |
| Native re-layout of the streaming tail row | ≤ 1 ms | ≤ 3 ms |
| Cold layout of a 1,000-turn window (background) | ≤ 60 ms; the first visible screen within 16 ms of the visible rows being measured | ≤ 200 ms |
| Tap a session → push transition starts | Within 1 frame | Within 2 frames |
| Tap a session → cached transcript content | ≤ 150 ms | ≤ 350 ms |
| Fling the Agents list with 500 sessions | 0 hitches | ≤ 2 ms/s |
| Sheet open and close, tab switches, back swipe | 0 dropped frames | ≤ 1 dropped frame |
| Keyboard open and close with composer and transcript following | 0 dropped frames | ≤ 1 dropped frame |
| Cold start to cached Agents | ≤ 1.0 s | ≤ 2.0 s |
| Warm resume to an interactive screen | ≤ 300 ms | ≤ 600 ms |
| Memory after opening 3 large sessions | ≤ 300 MB | ≤ 250 MB |

## 15.6 Measurement and gates

- **Development overlay.** A hitch meter in development builds shows frame-time
  percentiles from `CADisplayLink` (iOS) and `Choreographer` (Android), plus JS-thread
  busy time. A transcript lab screen runs the fixtures. Both follow zeron's `-lab`
  and `-bench` idea.
- **Benchmark scenarios** run against the demo host
  ([12 §12.13](12-mobile-engineering.md#1213-demo-host)):
  - `big` (120 turns), `huge` (1,000 turns) and `stream` (fast reply plus tool events);
  - list-500, sheets, keyboard, cold-start and resume.
- **iOS harness:** XCTest performance tests with
  `XCTOSSignpostMetric.scrollingAndDecelerationMetric`, plus a display-link fling
  benchmark that writes JSON results.
- **Android harness:** Jetpack Macrobenchmark with `FrameTimingMetric` and
  `StartupTimingMetric`, plus JankStats in debug builds.
- **When they run.**
  - Nightly on physical reference devices: a self-hosted Mac with an attached iPhone,
    and Android devices locally or in Firebase Test Lab.
  - On demand for PRs that touch `modules/transcript`, list rows, navigation or the
    sync engine. Those PRs attach the benchmark JSON.
- **Gates.**
  - A budget miss blocks the milestone.
  - A regression of more than 10 % against the last nightly blocks the PR.
- **Release check.** The [13 §13.9](13-testing-and-release.md#139-release-readiness-checklist-v1)
  checklist includes every row of §15.5 on every reference device.
