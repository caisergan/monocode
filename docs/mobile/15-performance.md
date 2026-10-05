# 15. Performance and smoothness

Smoothness is a product requirement, not polish (D18). The app must feel as fluid as
the best native apps everywhere: lists, navigation, sheets, keyboard, startup, and
above all a streaming transcript. The reference bar is zeron's iOS app
(`github.com/zeronsh/zeron`, `docs/mobile-rewrite.md`). It reports zero hitches while
flinging through 3,300 rows during streaming, measured on a simulator.

The app is **native** (D19):
- Swift, with SwiftUI for screens.
- The system's own navigation, tabs, sheets, menus and Liquid Glass.
- One custom UIKit view, the **transcript**, which lays out and paints rows itself.
  The file and diff viewers use it too.

SwiftUI never sits between a streamed token and a painted frame.

## 15.1 Principles

1. **The main thread only handles input, lays out visible views, and paints.**
   Decryption, decoding, sync apply, row building, highlighting and text measurement
   run off it. Animations are Core Animation or SwiftUI animations, which the render
   server runs, never main-thread timers.
2. **Sizes are known before anything is shown.** Transcript rows are measured
   exactly, off the main thread, before display. List rows have fixed layouts per
   Dynamic Type size. Nothing self-sizes on screen, and no estimate is corrected while
   scrolling.
3. **Incremental everywhere.** One changed entry means one rebuilt row:
   - unchanged entries keep identity (`applySessionSync` keeps unchanged blocks
     equal, and the row builder reuses their rows by id and version);
   - only the streaming tail block is re-parsed and re-measured;
   - only the visible rows that changed are repainted.
4. **At most one update per surface per display frame.** Streamed deltas are
   coalesced to the next frame before they reach the view.
5. **Native chrome and gestures.** The navigation stack, tab bar, sheets, context
   menus, back gestures and glass are the system's components. They run in UIKit and
   the render server, and cost the app nothing per frame.
6. **Streaming bypasses SwiftUI.** Channel → sync engine → row builder → transcript
   view. SwiftUI renders the screen around the transcript, not the transcript.
7. **Cached first paint.** Every screen paints from the local cache before any
   network work. Spinners are a last resort.
8. **Measured, with gates.** Budgets (§15.5) are checked by automated benchmarks on
   real devices (§15.6). A regression fails the gate like a failing test.

## 15.2 Architecture by surface

| Surface | Implementation | Why |
|---|---|---|
| Navigation stack, back swipe, titles | SwiftUI `NavigationStack` (UINavigationController underneath). Liquid Glass bars and buttons | System transitions and gesture physics |
| Tab bar | SwiftUI `TabView`: `.tabBarMinimizeBehavior(.onScrollDown)`, a `.tabViewBottomAccessory` "New session · N working" ([11 §11.10](11-design-and-ux.md#1110-navigation)). iPad: the sidebar-adaptable style | System tab bar, Liquid Glass, native accessory placement |
| Sheets (model, access, add to message, filters, working copy, session info) | `.sheet` with `.presentationDetents` | Native presentation and drag; Liquid Glass sheets |
| Long-press menus | `.contextMenu(menuItems:preview:)` (UIContextMenuInteraction) | Instant and platform-correct |
| Dialogs | `.alert` and `.confirmationDialog` for simple confirms; a sheet for the rest | |
| Glass surfaces (composer, jump-to-latest, approval banner, toast) | `.glassEffect` with `GlassEffectContainer` where surfaces sit together; the opaque fallback under Reduce Transparency | The render server draws the refraction |
| **Transcript** | `MonoTranscriptView` (§15.4) | The surface that decides whether the app feels smooth |
| Diff viewer and file viewer | The same engine in document mode: rows are diff lines or source lines | Long files fling smoothly; one engine to optimise |
| Lists (Agents, Project sessions, Projects, Settings, Explorer, Changes) | SwiftUI `List` with fixed-layout MonoCode rows per Dynamic Type size (spike S19; fallback `UICollectionView` with `UIHostingConfiguration`) | Cell reuse without measurement corrections |
| Live list details (braille spinner, shimmer, mascot hop, relative times) | One shared `TimelineView` ticker for spinners and mascots; shimmer as a moving gradient mask animated by the render server. Relative times update once a minute, batched | No per-row timers |
| Keyboard and composer | The composer in `.safeAreaBar(edge: .bottom)` follows the keyboard, including interactive dismissal; the transcript's bottom inset follows inside UIKit (spike S20; fallback: a UIKit session controller pinned to `keyboardLayoutGuide`) | The composer and transcript move with the keyboard, never behind it |
| Images | ImageIO: decoded off the main thread, downsampled to display size, bounded memory cache | |
| Startup | No work before the first frame beyond opening the database; the cached Agents screen read on a background reader; the launch screen held until the first cached frame | Under 1 s to a real screen |
| Off-main work | Per host, the `HostRuntime` actor decrypts (CryptoKit), inflates (`Compression`) and decodes (`JSONDecoder`). The row builder and highlighter run on background tasks. Large snapshots are decoded in chunks | The main thread stays free to answer touches within a frame |
| Theme and Dynamic Type changes | Tokens recomputed once. The transcript gets one `setTheme` or `setTypeScale` call and re-lays out off the main thread, swapping visible rows when ready | No visible reflow stutter |
| Refresh rate | `CADisableMinimumFrameDurationOnPhone = YES`, so ProMotion devices animate at 120 Hz | |

## 15.3 Coding rules

These are enforced by `check.sh` where possible, and by review otherwise.

- UI types are `@MainActor`. Nothing that parses, decrypts, measures or highlights runs
  on the main actor.
- No `Timer` or `DispatchQueue.main.asyncAfter` drives an animation. Use SwiftUI
  animations, `TimelineView`, Core Animation, or a `CADisplayLink` inside the
  transcript.
- No state writes in scroll, gesture or keyboard callbacks except the ones the gesture
  itself needs.
- No `GeometryReader`-driven sizing in list rows. Heights come from tokens and the
  Dynamic Type size.
- Views read only the store properties they show. Nothing streaming, meaning session
  deltas and timers, flows through `@Observable` state for the transcript. It goes
  through the transcript's op API.
- Images always have explicit sizes.
- Every new screen gets a benchmark scenario (§15.6) before it ships.

## 15.4 The native transcript (`MonoTranscriptView`)

### Responsibilities

```
Background (row builder task)                  Transcript view (layout queue → main thread)
─────────────────────────────                  ────────────────────────────────────────────
session window (sync engine)
  → groupTurns / groupTurnItems (MonoWire)
  → Markdown block parse (tail only when streaming)
  → highlighted runs for code (MonoHighlight)
  → [RowSpec] with ids and versions
  → ops: insert / update / remove / move      → layout queue: measure each changed row with
    (coalesced to one batch per display          CoreText at the viewport width, build its
     frame, handed to the view in process)       display model, update prefix sums
                                               → main thread: the scroll view realises rows in
                                                 [y0 − overscan, y1 + overscan], paints with
                                                 the same CoreText objects it measured with
  ← callbacks: action, link, long press,      ← hit testing, gestures, Core Animation
    visible range, at-bottom, need-older
```

**Text engine.** CoreText, the platform's own.
- This deliberately differs from zeron, which measures in Rust with a bundled font.
- MonoCode uses the **system font** for design parity
  ([11 §11.3](11-design-and-ux.md#113-typography)). A Rust shaper cannot faithfully
  measure SF Pro's optical sizes and tracking.
- Measuring and painting with the same CoreText objects removes any chance of the
  measured layout and the painted layout disagreeing about line breaks.

### Row specification (Swift types in MonoTranscript)

```swift
struct RowSpec: Sendable, Equatable {
  var id: String              // stable: blockId, blockId#n for markdown blocks, synthetic ids for fold lines
  var version: Int            // bumps on any content change; the view re-measures only on change
  var kind: RowKind           // userBubble, draftBubble, markdown, codeBlock, table, foldLine, phaseHeader,
                              // trailRow, thinkingRow, diffCard, planCard, taskList, subagentRow,
                              // approvalControls, notice, divider, turnFooter, attachments, loadOlder, spacer
  var indent: Int = 0         // trail depth (rail drawing)
  var rail: Rail?             // spine, branch, last
  var runs: [TextRun] = []    // styled text: text, style: StyleId, link?, fileRef?, highlight?, chip?
                              // chip = an inline rounded chip (inline code, file chips), with an optional icon
  var boxes: [BoxSpec] = []   // code/table/bubble/card boxes with nested runs
  var actions: [ActionSpec] = []   // buttons: id, label, variant, enabled
  var images: [ImageSpec] = []     // cached file URL, width, height
  var anim: RowAnim?          // shimmer, pulse, spinner, mascot, stepEnter, veilFrom (UTF-16 offset of new text)
  var a11y: A11ySpec          // label, traits
}
```

The prototype's row kinds (markdown, user bubble, code block, trail, thinking, fold,
approval controls, notice, turn footer, load older, spacer) port first in R0. The
rest land with the screens that need them.

- **Inline chips.** Inline code and file chips are drawn inside the text flow, as in
  [11 §11.16](11-design-and-ux.md#1116-transcript-rendering-rules):
  - a rounded `fill.chip` background behind the run's glyph range, with the chip's
    horizontal padding counted in line layout (a CoreText run delegate);
  - an optional 16 pt icon as an inline attachment before the text.
  - Chips never split across lines; a chip wider than the line truncates in the
    middle.
  - Hit testing returns the run's `fileRef`.
- **`StyleId`** maps to token-derived text styles (prose, bold, inline code, link,
  heading levels, mono, caption tiers, status colours). The styles are set once with
  `setTheme`, so rows carry ids, not colours.

### View API (Swift)

| Call | Purpose |
|---|---|
| `reset(rows:anchor:)` | Replace all rows, for example when opening a session. Anchor `.bottom` or `.row(id, offset)` |
| `apply(_ ops:)` | Batched `insert`, `update`, `remove`, `move` ops for one frame |
| `setTheme(_:)` | Colours, text styles, radii and motion tokens from MonoDesign |
| `setTypeScale(_:)` | Dynamic Type changes |
| `setFollowTail(_:)` / `scroll(to:animated:)` | Bottom anchoring and jump to latest |
| `setHighlights(_:current:)` | Find in conversation and in the viewers |
| `setBottomSpacer(_:)` | Prompt anchoring (viewport minus the last turn's height, computed in the view) |

| Callback (`TranscriptViewDelegate`) | Payload |
|---|---|
| `didTapAction` | row id and action id: Allow, Deny, Build, Open, Show more, fold toggle, copy, retry |
| `didTapLink` | row id and href or file ref |
| `menuForLongPress` | row id and run index; returns the `UIMenu` for the context menu |
| `visibleRangeChanged` | first and last row ids, used for prefetch and seen tracking |
| `atBottomChanged` | `Bool`, which drives the jump-to-latest button |
| `needsOlder` | Reached the top; the session store calls `sessions.blocks` |

### Behaviour

- **Streaming.**
  1. The sync engine applies a delta.
  2. The row builder rebuilds only the affected rows.
  3. Ops are coalesced to the next `CADisplayLink` tick and applied once per frame.
  4. The tail row is re-measured on the layout queue, and the new display model swaps
     in while the old one keeps painting.
  5. Newly streamed text fades in on a veil layer split at the exact glyph offset
     (`veilFrom`). This is the desktop's word fade, implemented natively.
- **Follow-tail and anchoring.** The desktop rules apply: within 16 pt counts as
  pinned, and any upward scroll un-pins. Prepending older turns keeps the anchor row at
  the same screen position. Because heights are exact, nothing jumps.
- **Animations, in Core Animation with the token values:**
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
  created sub-scroll views. Vertical flings win the gesture by default.
- **Hit testing and gestures.**
  - Taps on links, file chips and buttons are resolved from the display model's hit
    rectangles.
  - A long press opens a context menu with Copy text, Copy turn, Share and Select
    text.
  - Select text opens a selectable text view with that block's text.
- **Accessibility.** One accessibility element per row, plus a rotor for headings,
  links and buttons. Rows carry their `a11y` label. The transcript announces the
  finished reply once, at the end of the turn.
- **Images.** Attachment thumbnails come from cached files. They are decoded and
  downsampled on a background queue.
- **Memory.**
  - Display models outside three screens of the viewport are dropped. Measurements
    stay, as they are small.
  - The layout cache is keyed by `(rowId, version, width, typeScale, themeRevision)`.
- **Icons in rows.** Activity kind icons and chevrons are SF Symbols (M12). File-type
  icons, harness marks and mascots come from the asset catalog that
  `build-native-assets.mjs` fills from `packages/brand` and the desktop's Material
  Icon Theme set, resolved by the same name and extension rules as the desktop's
  `FileTypeIcon`.
- **Hosting.** The session screen hosts the view through a
  `UIViewControllerRepresentable`, which runs edge to edge and passes the controller's
  safe-area insets to the transcript. It scrolls under the glass bars and gets the
  scroll-edge effect: checked in R0 on the simulator
  ([16 §16.6.4](16-ios-native-design.md#1664-session-screen)). A `.safeAreaBar`'s
  height is not in the controller's safe area and is passed explicitly. The fallback,
  a UIKit session controller, stays named for the device run.

### Testing the transcript

- **Shared fixtures.** One set of transcripts covers every block kind, long markdown,
  huge code blocks and streaming sequences. The prototype's
  `src/transcript/fixtures.ts` is the starting set.
  - They feed golden tests: row count, order, kinds and hit-rect structure.
  - They also feed snapshot tests at three widths and two type scales.
- **Streaming equals final.** Streaming a fixture token by token must produce the
  same final layout as laying out the completed text at once (zeron's equivalent
  check).
- **Benchmarks:** §15.6.

## 15.5 Budgets

Reference devices: iPhone 13 (60 Hz) and iPhone 15 Pro (120 Hz), both on iOS 26 or
later. Until the 120 Hz device exists, the iPhone 13 and the iPhone 17 simulator are
measured ([13 §13.4](13-testing-and-release.md#134-manual-qa-matrix)).

Hitch ratio is Apple's measure: milliseconds of hitch per second of scrolling.

| Scenario | Budget |
|---|---|
| Fling through a 1,000-turn transcript, idle | 0 hitches |
| Same, while a turn streams (90 chars/s plus 5 tool events/s) | 0 hitches |
| Off-main work per streamed delta (decrypt, inflate, decode, apply, row build) | ≤ 2 ms p95 |
| Main-thread work per streamed delta (applying ops, swapping the tail row) | ≤ 1 ms p95 |
| Re-layout of the streaming tail row | ≤ 1 ms |
| Cold layout of a 1,000-turn window (background) | ≤ 60 ms; the first visible screen within 16 ms of the visible rows being measured |
| Tap a session → push transition starts | Within 1 frame |
| Tap a session → cached transcript content | ≤ 150 ms |
| Fling the Agents list with 500 sessions | 0 hitches |
| Sheet open and close, tab switches, back swipe | 0 dropped frames |
| Keyboard open and close with composer and transcript following | 0 dropped frames |
| Cold start to cached Agents | ≤ 1.0 s |
| Warm resume to an interactive screen | ≤ 300 ms |
| Memory after opening 3 large sessions | ≤ 300 MB |

## 15.6 Measurement and gates

- **Debug overlay.** A hitch meter in debug builds shows frame-time percentiles from
  `CADisplayLink`, plus main-thread busy time. Debug → Transcript Lab runs the
  fixtures. Both follow zeron's `-lab` and `-bench` idea.
- **Benchmark scenarios** run against the demo host
  ([12 §12.13](12-mobile-engineering.md#1213-demo-host)):
  - `big` (120 turns), `huge` (1,000 turns) and `stream` (fast reply plus tool events);
  - list-500, sheets, keyboard, cold-start and resume.
- **Harness:** XCTest performance tests with
  `XCTOSSignpostMetric.scrollingAndDecelerationMetric`, `XCTApplicationLaunchMetric`
  and `XCTMemoryMetric`, plus the Lab's display-link fling benchmark, which writes
  `Documents/benchmarks/latest.json`. `os_signpost` intervals mark decode, apply, row
  build, layout and paint, so Instruments shows where a frame went.
- **When they run.**
  - Nightly on physical reference devices: a self-hosted Mac with an attached iPhone.
  - On demand for changes that touch `Packages/MonoTranscript`, list rows, navigation
    or the sync engine. Those changes attach the benchmark JSON.
- **Gates.**
  - A budget miss blocks the milestone.
  - A regression of more than 10 % against the last nightly blocks the change.
- **Release check.** The [13 §13.9](13-testing-and-release.md#139-release-readiness-checklist-v1)
  checklist includes every row of §15.5 on every reference device.
