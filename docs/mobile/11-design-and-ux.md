# 11. Design language and UX

The phone app is MonoCode, not a companion with its own look (D12). This document
translates the desktop's design language into a mobile one, then specifies every
screen in it.

Values come from the desktop source at v0.7.0, mainly:
- `src/styles/index.css`;
- `src/features/settings/model/appearance.ts`;
- the session and shell components cited inline.

When the desktop changes, this document follows (§11.1).

## 11.1 Design parity rules

1. **The desktop is the source of truth.** Colours, type ratios, radii, borders,
   icons, motion curves, status vocabulary and copy are copied, not reinterpreted.
   Tokens are single-sourced in `@monocode/design` (§11.9). A test fails when they
   drift from `src/styles/index.css`.
2. **Change layout, density and input, not identity.** A phone gets bigger hit
   targets, one column, sheets instead of popovers, and gestures instead of hover.
   It does not get new colours, new shapes, a different icon family or different
   words.
3. **Every deviation is written down.** The table below lists them. A deviation
   needs a phone-specific reason.
4. **Remote-first.** The phone is always in the desktop's "remote session" case
   (`RemoteSession.tsx`). Features the desktop hides for remote projects are hidden
   here too.

**Desktop to mobile translation**

| Desktop | Mobile | Kept exactly |
|---|---|---|
| Project rail | **Projects** tab: one list with the rail's sections | Section labels, project row anatomy, mascots and logos, busy shimmer, diff stats |
| Session sidebar (Sessions / Explorer / Changes) | **Project** screen with a segmented control of the same three names | Session card anatomy, status slot, search placeholder, filter menu contents |
| LiveAgentsPreview "Working" card | **Agents** tab, the cross-machine home | "Working", "Need approval", "Done" vocabulary and colours |
| Title tabs and split panes | One session per screen, a push stack | Harness status glyphs (braille spinner, teal done check) on list rows |
| Hover-revealed actions | Visible buttons, swipe actions, long-press menus | Action sets and order |
| Context menus (`ExplorerMenu`) | Action sheets | Item copy, order, separators, danger styling |
| Popovers, selects, pickers | Bottom sheets; anchored popovers only on iPad | Glass frame, row styles, entry curve |
| Modals and confirm dialogs | Centred dialogs, the same two types | Backdrop, panel, entry motion, button styles |
| Approval toasts | In-app approval banner, plus push | Dashed glass card, Allow/Deny buttons |
| Settings rail + pages | Grouped list, then pages of `Group` cards | Primitives, group names, copy |
| Quick composer | The model for the New session composer | 16/24 prompt, one-row chips, single Start |
| Native window glass | The platform's own chrome: Liquid Glass bars, tab bar, sheets and `GlassView` surfaces on iOS 26; translucent system bars before iOS 26; Material 3 surfaces on Android. All are tinted with MonoCode tokens | MonoCode tint, accent and dark default |
| `cuelume` sounds | Pre-rendered cue files plus haptics | Cue names, volume, default on |

**Recorded deviations**

| # | Deviation | Reason |
|---|---|---|
| M1 | Type sizes +1 to +2 pt over desktop px (§11.3) | Phones are held closer but render at lower angular resolution; 10-11 px desktop captions are below comfortable phone legibility |
| M2 | Hit targets ≥ 44 × 44 pt by padding, not by enlarging glyphs | Touch accuracy |
| M3 | Bottom tab bar (Agents, Projects, Settings), the platform's native tab bar | No rail on a phone; thumb reach |
| M4 | Error notices get a red `AlertCircle` icon (desktop renders them as plain muted text) | A phone user often arrives from a "Turn failed" push and must find the error at a glance |
| M5 | An explicit offline banner (desktop has none) | Phones lose connectivity routinely |
| M6 | The jump-to-latest button shows "Waiting for approval" when an approval is below the fold | No hover; approvals must be discoverable without scrolling the whole turn |
| M7 | Enter inserts a newline; sending uses the button (hardware keyboards keep desktop Enter/Shift+Enter) | Software keyboards |
| M8 | Gesture-driven transitions (back swipe, sheet drag) use the platform's spring physics; everything else uses the desktop's bezier timings | Velocity hand-off from a finger needs springs |
| M9 | Reduced motion also gates shimmer, mascot hops and the approval banner entrance, which the desktop leaves ungated | Platform accessibility expectations |
| M10 | An onboarding and pairing flow (the desktop has none) | A phone starts with no machines |
| M11 | Navigation bars, tab bar, sheets, context menus and back gestures are the platform's native components (Liquid Glass on iOS 26, Material 3 on Android), styled with MonoCode tokens, instead of drawn copies of the desktop's glass | Smoothness (D18): native chrome costs no JS time and gets platform gestures and transitions for free ([15 §15.2](15-performance.md#152-architecture-by-surface)) |

## 11.2 Color

### Model

Exactly the desktop's (`index.css:25-116`, `appearance.ts`).

- **One tint drives everything.** `hue` (0-360, default 240) and `saturation` (0-100 %,
  default 0) are shared by both themes. Then:
  - `base = hsl(hue, sat, L_bg)`, with `L_bg` = dark lightness (0-30 %, default 9 %) in
    dark and 97 % in light.
  - `content = hsl(hue, sat, L_c)`, with `L_c` = 92 % (dark) or 18 % (light).
- **Everything else is `content` at an alpha.** React Native has no `color-mix`, so
  `@monocode/design` computes rgba values from `content` and the alpha.
- **Accent** is `hsl(211 92% 62%)` = `#459bf7` in both themes. It is used for focus,
  toggles, links in light mode, "working" status, the selected-session tint (15 %),
  drop targets and the caret.
- **User accent** (optional, default none) recolours only the send button and user
  bubbles, as on the desktop: "Used for the composer send button and your message
  bubbles."
  - Presets: Blue `#4da3f5`, Violet `#8b5cf6`, Pink `#ec4899`, Red `#ef4444`, Orange
    `#f59e0b`, Green `#10b981`. Default clears it.
  - Text on the accent is `#000` when its WCAG relative luminance is above 0.179,
    otherwise `#fff`.

### Resolved tokens at the default tint

| Token | Dark | Light | Use |
|---|---|---|---|
| `bg.base` | `#171717` | `#f7f7f7` | Screens |
| `content` | `#ebebeb` | `#2e2e2e` | Primary text and the base of every alpha |
| `stroke` | content α .07 | α .07 | Hairlines, section dividers |
| `border.subtle` | α .05 | α .05 | Settings row dividers |
| `border.default` | α .10 | α .10 | Cards, sheets, composer |
| `border.focus` | α .20 | α .20 | Focused composer |
| `fill.composer` | α .03 | opaque `bg.base` + shadow | Composer, question form, queue card |
| `fill.hover` | α .05 | α .05 | Pressed rows |
| `fill.code` | α .06 | α .06 | Code, table, diff card, tool chip |
| `fill.chip` | α .08 | α .08 | Inline code, small buttons |
| `fill.bubble` | α .10 | α .10 | User bubble, secondary buttons |
| `sel.subtle` / `sel` / `sel.strong` / `sel.hover` / `sel.emphasis` | α .08 / .10 / .12 / .15 / .20 | α .05 / .06 / .07 / .10 / .14 | Active rows and chips, pressed states |
| Text tiers | α .90 .85 .80 .75 .70 .65 .55 .50 .45 .40 .35 .30 .25 | same | Most used: /50, /45, /40, /70, /80 |
| `primary` (no user accent) | `#fff` on `#000` text | `content` with `bg.base` text | Send, Allow, Continue, Build |
| `primary.disabled` | white α .30, text black α .40 | content α .25, text base α .75 | |
| `link` | `#7dd3fc` (inline links `sky-400` `#38bdf8` at α .90, pressed `sky-300`) | `#0863c4` | |
| `status.attention` | amber-400 `#fbbf24` | amber-700 `#b45309` | Need approval, needs input, usage limits |
| `status.working` | accent | accent | Working spinner |
| `status.done` | emerald-400 `#34d399` | emerald-700 `#047857` | Done, online, added |
| `status.danger` | red-400 `#f87171` | red-400 / red-500 | Errors, failed rows, delete |
| `danger.button` | `red-500` α .20, text `red-300` `#fca5a5` | same | Destructive dialog button |
| `done.check` (tabs) | teal-400 `#2dd4bf` | teal-400 | Finished-unseen glyph |
| `diff.add` / `diff.del` | rows emerald-500 α .15, gutter α .25, numbers emerald-300 / rose equivalents | same | Full diff view |
| `preview.add` / `preview.del` | `teal-800` α .20, bar teal-400 / `rose-800` α .20, bar rose-400 | same | Diff card (FilePreview) |
| `mode.plan` | text `yellow-200` α .90, pill `yellow-300` α .12 | `yellow-700` | Plan pill |
| `mode.draft` | text content α .70, dashed border α .25, fill α .05 | same | Draft pill and bubble |
| `skill` / `mention` | `#e8c547` / `#38bdf8` | `#a07c10` / `#0284c7` | Slash commands in the composer |
| `scrim` | black α .40 | black α .40 | Dialog backdrop |

**Project colours** (`tabGroups.ts`) are nine values, index 0 neutral:
`hsl(210 8% 58%)`, `hsl(211 92% 62%)`, `hsl(12 80% 58%)`, `hsl(45 90% 55%)`,
`hsl(142 55% 50%)`, `hsl(330 70% 62%)`, `hsl(280 55% 62%)`, `hsl(175 55% 48%)`,
`hsl(25 85% 58%)`.
- A project's colour is hashed from its id, as `tabGroupColor` does. The phone
  hashes the host project id the same way.
- On the phone, a host's colour is its label colour, chosen at pairing from indices 1
  to 8.

**Syntax highlighting.** Shiki `github-dark` / `github-light`, the transcript's themes
(`codeHighlightPlugin.ts`).

### Theme settings on the phone

**Settings → Appearance** mirrors the desktop rows:
- **Theme:** System, Dark (default), Light.
- **Accent color:** Default plus the 6 presets plus a custom picker.
- **Hue**, **Saturation** and **Dark-mode lightness**, as sliders with the same
  ranges.

**Copying a computer's look.** When pairing from the desktop, the offer can carry
that desktop's appearance ([04 §4.2](04-pairing.md#42-the-offer), field `ui`). On the
first pairing the phone asks: "Use the same look as MacBook? Theme, tint and accent".
Answering Use or Keep mine is offered once. "Copy appearance from a computer…" in
Appearance repeats it for any machine paired from a desktop.

## 11.3 Typography

**Families.** The system sans (SF Pro, Roboto) and the system mono (SF Mono/Menlo,
`monospace` on Android). There are no webfonts, as on the desktop.

**Weights.** 400 body, 500 labels and buttons, 600 titles and headings.

**Scale (M1).** Desktop ratios are kept, with sizes raised by 1 to 2 pt and nothing
below 11 pt. All sizes scale with Dynamic Type or the Android font scale, clamped
0.85 to 1.6.

| Role | Desktop | Mobile (size / line height) | Examples |
|---|---|---|---|
| Caption | 10 px | 11 / 14 | Tags, line numbers, Settings section labels (uppercase, tracking 0.08 em) |
| Meta | 11 px | 12 / 16 | Session card model line, status slot, branch line, chips |
| Secondary | 12 px | 13 / 18 | Descriptions, tool detail, table cells, code labels |
| Row | 13 px | 15 / 20 | Session titles (600), menu rows, project names, question prompt (500) |
| Prose | 14 / 24 px | 16 / 25 | Assistant markdown, user bubble, fold lines, tool-row verbs |
| Composer | 14 / 22 px (quick composer 16 / 24) | 16 / 24 | Composer input; matches the quick composer |
| Code | 12 px mono | 13 / 19 mono | Code blocks, diffs (diff text 12 / 18) |
| Inline code | 0.8 em mono | 0.85 em | Chips inside prose |
| Tool target chip | 13 px mono | 14 / 20 mono | File names in trail rows |
| Screen title | (window title) | 17 / 22, 600 | Navigation bars |
| Page heading | 20 px, 600 (Settings) | 22 / 28, 600 | Settings pages, Machine details |
| Empty-session heading | 18 px | 20 / 26, 500 | "What should we work on in {project}?" |
| Markdown h1 / h2 / h3 / h4 | 22 / 18 / 20 / 18 px, 600 | 22 / 19 / 18 / 17, 600 | The phone fixes the desktop's h3 > h2 inversion |

**Text colour tiers.** These follow the desktop exactly:
- prose paragraphs `content` α .78; bold and italic full `content`;
- reasoning α .48;
- secondary α .50 and α .45;
- faint α .40 and α .35.

## 11.4 Shape, materials and elevation

**Radii.** These are the desktop's values exactly.

| Token | Value | Use |
|---|---|---|
| `r.xs` | 4 | Tool chips, small tags |
| `r.sm` | 6 | Rows, session cards, chips, icon buttons, segmented options |
| `r.md` | 8 | Composer, menu rows, buttons |
| `r.block` | 10 | Code, table and diff cards, task list, queue and usage tabs |
| `r.lg` | 12 | User bubble, plan card, settings group cards, popovers, banners |
| `r.xl` | 16 | Dialogs and the top corners of bottom sheets |
| `r.full` | pill | Toggles, single-line user bubbles, count pills |

**Borders.** Always 1 pt hairlines from the content alpha ladder.
- **Dashed borders** keep the desktop meanings:
  - draft (content α .30);
  - needs approval (session card α .30);
  - approval banner (α .20).
- **Diff bars** are 2 pt.

**Materials** (M11). On iOS 26, glass is system Liquid Glass (`expo-glass-effect`,
native bars and sheets). Before iOS 26 it is `expo-blur` with the values below. Android
and low-end devices get opaque token colours. Every surface falls back to opaque when
the OS has Reduce Transparency on.

| Surface | Dark | Light |
|---|---|---|
| Tab bar, navigation bars | iOS 26: system Liquid Glass, tinted with `accent` for selection. Earlier iOS: system bars with "sidebar glass" colours (`base` mixed 90 % with black at 85 % opacity). Android: Material 3 surfaces with `bg.base` | iOS 26: system glass. Elsewhere: opaque `bg.base` with a `stroke` hairline |
| Bottom sheets, dialogs | Native form sheets and alerts. iOS 26 Liquid Glass sheets; earlier: `bg.base` α .55 over blur 24, border content α .07 | Opaque `bg.base`, border content α .07 |
| iPad popovers | Content α .02 over blur 24, border α .10 | Opaque `bg.base` |
| Composer | MonoCode's box (`r.md`, border α .10, focus α .20). Material: `GlassView` on iOS 26, content α .03 over blur 8 earlier, opaque `fill.composer` on Android | Opaque `bg.base`, shadows `0 6 24 content α .09` + `0 2 6 content α .06` |
| Approval banner | Content α .10 over blur 24, dashed border α .20 | Same |
| Jump-to-latest | Content α .10 over blur 12, border α .15 | Same |

**Elevation.** Borders and translucency, not shadows, as on the desktop. Shadows are
used only for:
- popovers and banners (`shadow-xl`: 0 20 25 −5 black α .10 + 0 8 10 −6 black α .10);
- dialogs and sheets (`shadow-2xl`: 0 25 50 −12 black α .25);
- the light-theme composer.

**Pressed state.** Scale 0.97 plus `sel.hover`, matching the desktop's
`active:scale-[0.97]`. Disabled is opacity .40.

## 11.5 Spacing, density and touch

- **Grid.** 4 pt. The common gaps are the desktop's: 8, 6, 12, 10, 4.
- **Screen gutters.** 16 pt, the desktop's `px-4` transcript gutter.
- **Hit targets (M2).** At least 44 × 44 pt. The visual size of a desktop control
  stays and the pressable area grows outward:
  - A 26-pt composer chip keeps a 26-pt pill inside a 44-pt hit area.
  - Trail rows keep their visual rhythm (desktop rows are about 28 px) but get 44-pt
    hit slop.
- **Row heights:**
  - menu and action-sheet rows 48;
  - settings rows 52 or more;
  - project rows 52;
  - session cards about 88 (the desktop card's three rows at mobile type sizes);
  - compact session cards 64.
- **Content width.** Fluid on phones. On tablets the transcript and composer column
  cap at 896 pt (`max-w-4xl`), as on the desktop. User bubbles cap at 85 % of the
  column, or 576 pt on tablets. The left dead zone in chat layout is 40 pt (desktop
  56 px).

## 11.6 Motion

Motions outside the transcript run on the UI thread with Reanimated. Transcript
motions run inside the native transcript with the same values
([15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview)). No
animation is driven by JavaScript timers.

**Curves and durations.** These are the desktop's (`index.css:75-79` and component
CSS), implemented with Reanimated `withTiming` and `Easing.bezier`.

| Token | Value | Use |
|---|---|---|
| `ease.out` | `(0.22, 1, 0.36, 1)` | Default for state changes, folds, slides, docking |
| `ease.pop` | `(0.16, 1, 0.3, 1)` | Sheet and popover entrances, dialogs, step reveals |
| `ease.insert` | `(0.32, 0.72, 0, 1)` | List insertion |
| `ease.inOut` | `(0.4, 0, 0.2, 1)` | Sheens, sheet close |
| `dur.feedback` | 120 ms | Colour and opacity feedback |
| `dur.reorder` | 160 ms | Reorder, backdrop fade |
| `dur.pop` | 170 ms | Popover and menu entrance: opacity 0→1, scale .94→1, 8 pt from the anchor side |
| `dur.dialog` | 200 ms | Dialog: opacity, translateY 8 → 0, scale .98 → 1 |
| `dur.slide` | 260 ms | Push transitions (non-gesture), panel slides |
| `dur.fold` | 340 ms | Fold open and close |
| `dur.insert` | 380 ms siblings + 220 ms fade | New session card insertion |
| `dur.dock` | 480 ms | Composer docking after the first send |

**Signature motions to port.** They come from the desktop, in priority order. P0 lands
with the screen that uses it; P1 by M7; P2 is optional polish.

| Motion | Desktop source | Mobile implementation | Priority |
|---|---|---|---|
| Braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80 ms per frame | `TerminalSpinner.tsx` | Text frames on a JS interval shared by all spinners | P0 |
| Shimmer text for live titles ("Working for 12s", "Thinking…", busy project names), periods 1-2 s | `Shimmer.tsx` | `MaskedView` + moving `LinearGradient` (base content α .40, band full content) | P0 |
| Fold open/close, 340 ms | `zen-fold-*` | Height + opacity on the UI thread | P0 |
| Step entrance: slot opens, spine grows, branch draws, row rises 10 pt and fades; pace 480 ms calm down to 160 ms under backlog | `useStepQueue`, `zen-step-*` | Reanimated sequence per row; same queue rules | P0 |
| Thinking pulse: opacity .35 ↔ .9 over 1.8 s | `zen-thinking-pulse` | Repeating timing | P0 |
| Word fade while streaming: each new word 0 → 1 over 320 ms, pacing max(90 chars/s, backlog / 0.22 s) | `wordFade.tsx` | Release text at the same pace. The newly released tail renders as a separate span whose colour alpha animates 0 → .78. At most one animated tail per message | P1 |
| Session insertion: siblings slide down 380 ms, new card fades 220 ms, only for sessions created < 15 s ago | `Sidebar.tsx:3006-3074` | List item layout animation with `ease.insert` | P1 |
| Title particle sweep: an 18 pt soft edge sweeps the new title in over 1,100 ms; the old title dissolves into 1.8 pt particles over about 850 ms | `ParticleText.tsx` | Skia canvas; crossfade fallback | P1 |
| Mascot hop: 2-frame swap with a 1 pt lift every 460 ms while busy | `mascot-*` | Frame swap on the shared ticker | P0 |
| Prompt rise after send (560 ms) and turn reveal (320 ms) | `AgentTranscript.tsx` | Same values; only for the turn just sent | P1 |
| Composer dock on first send, 480 ms | `useComposerDockMotion.ts` | Shared-element style translate | P1 |
| Plan burst on sending a Plan-mode message: 2-6 numbered dots rise and become checks, yellow `#fde047` | `PlanStepsBurst.tsx` | Reanimated views clipped to the bubble | P1 |
| Copy icon → check morph, 260 ms | `index.css:1625-1657` | SVG stroke-dash animation | P1 |
| Codex effort tile glow for Ultra and Max in the effort sheet (tones `#a855f7`, `#f4b942`) | `ModelPicker.css` | Skia grid, 16 × 3 tiles, static under reduced motion | P2 |
| Composer runner mascot (patrols the composer edge while a turn runs; setting "Composer mascot") | `ComposerRunner.tsx` | Reanimated sprite; off by default on phones to save battery | P2 |

- **Not ported:** pane entry (no splits), tab open/close (no tab strip), the arcade grid
  game, the Astra and Opus model welcomes, `/operator` sparkles and orchestrator
  constellations. The last two are features hosts don't offer.
- **Reduced motion (M9).** Every row above falls back to an instant change or a short
  crossfade, including shimmer (static α .70 text), mascot hops (rest frame) and the
  banner entrance.

## 11.7 Iconography, brand and mascots

**Icons.** Hugeicons (`@hugeicons/core-free-icons`), the desktop's set, with stroke
1.75 by default.
- `@monocode/design` exports the desktop's alias table from `src/shared/ui/icons.tsx`.
  For example `Check` = `Tick02Icon`, `X` = `Cancel01Icon`, `ChevronDown` =
  `ArrowDown01Icon`, `GitBranch`, `Terminal`, `PenLine`, `Search`, `Bot`, `Wrench`,
  `Lock`, `Shield`, `AiIdea`, `CircleDashed`. Both apps then name icons the same way.
- Rendering uses Hugeicons' React Native package if it covers the free set, else a
  small `react-native-svg` renderer over the same icon data **(spike S9)**.
- Sizes: 16 pt inline (desktop 14), 18 pt in rows, 22 pt in bars. The custom
  `FoldVertical`/`UnfoldVertical` paths are copied.

**Activity kind icons.** Edit `PenLine`, research `Search`, run `Terminal`, agent
`Bot`, other `Wrench`, note `Minus`, all at content α .45. They follow
`AgentTranscript.tsx:2761-2779`.

**Provider logos.**
- The ten SVGs in `src/assets/providers/` move to `packages/brand` and are shared.
  The view box is `-4 -4 37 37`.
- Monochrome providers (cursor, grok, opencode, pi, fx, hermes) follow the text colour.
- Hermes renders as a mask at 72 %, as in `HarnessIcon.tsx`.

**File-type icons.** The desktop's full `react-material-icon-theme` set and its
name/extension rules, so any file that gets an icon on the desktop gets the same icon
on the phone.
- A build step (`scripts/build-native-assets`) exports every icon as native vector
  data (SVG path data in one compact bundle, rendered by the transcript and React
  alike).
- It is loaded lazily after first paint, as on the desktop.
- Unknown names fall back to the generic file icon, as on the desktop.

These icons appear in inline file chips in prose, trail-row file chips, code-block
headers, diff cards, Explorer, Changes and attachment chips.

**App icon and launch.**
- The desktop icon is a black squircle with a ring of eight grey pixel squares fading
  from white to dark around a `>_` prompt (`src-tauri/icons`). The phone uses the same
  artwork.
- The launch screen is `bg.base` with the icon centred at 72 pt, like the desktop's
  boot splash.
- **Pixel ring loader.** The ring from the icon, eight squares whose brightness
  rotates once per 960 ms. It is the full-screen loading indicator (first connect,
  long loads). Inline busy states use the braille spinner, as on the desktop.

**Mascots.** The ten 8 × 8 pixel sprites (invader, ghost, robot, cat, skull, crab,
mushroom, rocket, dino, frog; `projectMascots.ts`), rendered crisp with project
colours.
- They appear in project rows (16 pt) and subagent rows (16 pt, hashed by agent name),
  hopping while busy.
- The empty-project illustration is the desktop's pixel "terminal at a prompt" at
  content α .25 (`SessionsEmpty`).

## 11.8 Sound and haptics

The desktop's `cuelume` cues (`sounds.ts`) synthesise audio with Web Audio, which
React Native lacks.
- A script (`apps/mobile/scripts/export-cues.mjs`) renders the six cues to short audio
  files once, with `OfflineAudioContext` in a headless browser.
- The app plays them with `expo-audio` at volume 0.55, in the ambient category so the
  silent switch mutes them.
- Sounds are on by default, as on the desktop.

| Cue | Desktop trigger | Phone trigger | Haptic |
|---|---|---|---|
| `success` (turnFinished) | Turn finished with no OS banner | A watched session finishes while visible | Success |
| `bloom` (inboxUnseen) | New inbox item | Unused in v1 | n/a |
| `toggle` (switch) | Settings toggle | Settings toggles | Selection |
| `scan` (copy) | Copy | Copy message / code / session id | Light impact |
| `arrival` (updateAvailable) | App update | Host update available on a machine | none |
| none | n/a | Approval or question arrives in the open session | Warning |
| none | n/a | Send, Allow, Deny, pairing approved | Light impact / Success |

Settings → General has **Sounds** and **Haptics**, both on by default.

## 11.9 Components

`@monocode/design` (new package) holds tokens and the alias tables:
- `palette({hue, saturation, darkLightness, scheme, userAccent})` → resolved tokens;
- radii, spacing, durations and easings;
- accent presets, project colours, mode and status colours, diff colours;
- icon aliases and harness metadata.

A parity test parses `src/styles/index.css` and `appearance.ts` and compares every
shared value. The desktop may later generate its CSS variables from the package.

The mobile component library (`apps/mobile/src/ui`), each mirroring a desktop
component:

| Component | Desktop counterpart | Notes |
|---|---|---|
| `Text`, `Icon`, `HarnessIcon`, `FileTypeIcon`, `ProjectMascot` | same names | |
| `BrailleSpinner`, `Shimmer`, `PixelRingLoader` | `TerminalSpinner`, `Shimmer`, boot splash | |
| `Chip` | composer chips (`h-6.5 rounded-md bg-selection`, 11 px) | 28 pt visual, 44 pt hit |
| `PrimaryAction` | `.primary-action` | White/black or content, or the user accent |
| `Button` (primary, secondary, ghost, danger, accent) | `bg-content` / `bg-content/10` / text / `bg-red-500/20 text-red-300` / `bg-accent text-white` (quick composer Start) | |
| `Toggle`, `Segmented`, `Select`, `Slider`, `Group`, `Row` | Settings primitives (`SettingsView.tsx:3927-4383`) | Rows stack label over control below 560 pt, except switch rows, as on the desktop |
| `SessionCard`, `ProjectRow`, `MachineRow`, `FolderHeader` | `SessionCard`, project card, Connections row | |
| `FoldLine`, `ActivityRail`, `PhaseGroup`, `ToolRow`, `FileChip`, `ThinkingRow` | `WorkFoldLine`, zen rail, `ActivityPhaseGroup`, `ActivityToolRow` | Transcript-only: implemented as native row kinds in `MonoTranscriptView`, not React components. The same applies to `Markdown`, `CodeBlock`, `MarkdownTable`, `InlineCode`, `UserBubble`, `DraftBubble`, `DiffCard`, `UnifiedDiff`, `PlanCard`, `TaskList`, `SubagentRow`, `TurnFooter`, `HairlineDivider` and `ApprovalControls` |
| `Markdown`, `CodeBlock`, `MarkdownTable`, `InlineCode` | `AgentMarkdown` + Streamdown styles | |
| `UserBubble`, `DraftBubble`, `AttachmentChip` | `UserMessageBlock`, `AttachmentChip` | |
| `DiffCard`, `UnifiedDiff` | `FilePreview`, `UnifiedDiffView` | |
| `PlanCard`, `TaskList`, `SubagentRow`, `TurnFooter`, `HairlineDivider` | `PlanPreview`, `TaskListPreview`, `SubagentRow`, `TurnDuration`, handoff/interjection dividers | |
| `ApprovalControls`, `ApprovalBanner`, `QuestionForm` | `ApprovalControls`, `ApprovalToasts`, `QuestionForm` | |
| `Composer`, `ModePill`, `QueueCard`, `UsageLimitTab`, `ContextRing` | `Composer`, mode pills, `MessageQueue`, `UsageLimitNotice`, `ContextMeter` | |
| `Sheet`, `ContextMenu`, `Dialog`, `ConfirmDialog` | `Popover`, `ExplorerMenu`, `Modal`, confirm dialogs | Native form sheets with detents, native context menus (UIMenu / Android popup), native alerts and modal screens (M11). The contents use MonoCode rows and tokens |
| `NoticeBar`, `Banner` | `RemoteSession.tsx` notice bar | |
| `EmptyState`, `DotGrid` | `SessionsEmpty`, `EmptySession` background | |

## 11.10 Navigation

Expo Router, typed routes. `env` is the host `environmentId`.

```
/                                   → /onboarding if no machines, else /(tabs)/agents
/onboarding, /pair                  first run and pairing (also handles pairing links)
/(tabs)/agents                      Agents (home)
/(tabs)/projects                    Projects
/(tabs)/settings                    Settings
/m/[env]                            Machine details
/m/[env]/p/[projectId]              Project: Sessions | Explorer | Changes
/m/[env]/s/[sessionId]              Session
/m/[env]/s/[sessionId]/info         Session info sheet
/m/[env]/file?path=&cwd=            File viewer
/m/[env]/diff?path=&cwd=&staged=    Diff viewer
/new?env=&projectId=                New session (empty session screen)
/settings/*                         Settings pages
```

**Tab bar (M3).** Three items:
- **Agents** (badge: count of sessions needing input);
- **Projects**;
- **Settings**.

It is the native tab bar (Expo Router `NativeTabs`; M11):
- On iOS 26 it is Liquid Glass, minimises while scrolling down, and carries a
  **bottom accessory**: "＋ New session" on the left and "N working" with the accent
  braille spinner on the right. That is the desktop's "New session (⌘T)" button and
  its "Working" card in one control.
- Before iOS 26 and on Android, the + lives in the navigation bar instead.
- Tab icons are Hugeicons exported as native vector assets. The selection tint is
  `accent`.
- iPad uses the adaptable sidebar (`sidebarAdaptable`).

**New session.** Agents and Projects have a **+** in the navigation bar, the desktop's
"New session (⌘T)" button. The Project screen's + preselects that project.

**Tablets** (width ≥ 768 pt) use a split layout, the closest thing to the desktop
shell. The sidebar column (320 pt) holds Agents or the Project screen; the session
fills the rest.

**Deep links** use `<scheme>://m/<env>/s/<sid>?focus=approval:<req>`, and pairing
links go to `/pair`.

## 11.11 Onboarding and pairing

The desktop has no onboarding (deviation M10), so these screens use its empty-session composition: a
centred heading over the dot grid, with one primary action.

| Screen | Content | Actions |
|---|---|---|
| Welcome | App icon (72 pt), heading "Your agents, wherever you are." (20 pt 500), body "Approve, answer and start coding agents on your computers." (13 pt content α .45) | **Pair with a computer** (primary), **Try the demo** (ghost) |
| How to pair | "On your computer, open MonoCode → Settings → Mobile → Pair a phone. On a server, run `monocode-host pair --mobile`." The command sits in an inline-code chip with a Copy button | **Scan code** (primary), **Paste link** (secondary) |
| Scanner | Full-bleed camera, a 240 pt square frame with `r.lg` corners in content α .70, torch toggle | Cancel |
| Review | Heading "Connect to {host}?". A `Group` card with rows: Fingerprint (mono 13 pt), Reachable through ("Local network · Tailscale · Relay"), Phone name (text field). Description under the card: "This phone will be able to run agents and read files on {host} with the same access as its user account." | **Connect** |
| Local network (iOS) | "To connect directly when you're on the same Wi-Fi as {host}, MonoCode needs access to your local network." | **Continue** |
| Connecting | Pixel ring loader, "Connecting to {host}…", then "Trying the relay…" after 5 s | Cancel |
| Confirm | The code in mono 34 pt, tracking 0.08 em, grouped `482 913`. "Check that {host} shows the same code, then allow the connection there." A countdown 2:00 in caption style | Cancel |
| Paired | A check that draws with the copy morph. "{host} is ready." A colour row (8 project-colour swatches) and, when the offer carried `ui`, the "Use the same look" question (§11.2) | **Continue** |
| Notifications | "Get notified when an agent needs approval, has a question, or finishes." | **Turn on notifications**, **Not now** |

**Try the demo** opens an in-app demo machine ([12 §12.13](12-mobile-engineering.md#1213-demo-host)).
A `Demo` tag (caption, `fill.chip`) marks it everywhere. It can be removed from
Settings → Machines.

## 11.12 Agents (home)

This is the cross-machine version of the desktop's "Working" card
(`LiveAgentsPreview.tsx`). Data comes from `inbox.list` on every connected machine,
merged. The protocol method keeps that name; the screen does not.

**Navigation bar.** Title "Agents" and a **+** (New session). Below it, machine filter
chips (All, then one per machine with its status dot) when two or more machines are
paired.

**Sections.** Section labels follow the desktop rail (13 pt content α .50, `px-4`).
Empty sections are hidden.

1. **Need approval.** Attention `approval` or `question`. The label reads "Needs
   input" when only questions are present.
2. **Working.** Running sessions. The label has the desktop's pulsing accent dot with
   its glow (`0 0 8 accent`).
3. **Problems.** Attention `error`, `interrupted` or `usage_limit`.
4. **Done.** Finished and not yet seen on this phone.
5. **Recent.** Everything else from the last 7 days. The first 50 show, then
   "Show N more", as the desktop's chats list does.

**Rows** are full **session cards** (§11.14), with the project and machine name added
to the branch line ("my-app · mac-mini · ⑂ fix/auth"). Running rows show the last
assistant line under the title (`lastText`, 13 pt α .45, one line). Rows needing
approval show the request ("Approve: Run npm test").

**Gestures.**
- Swipe left: Archive.
- Swipe right: Mark as seen or Mark as unseen.
- Long press: the session action sheet (§11.14).
- There is no swipe-to-approve. Approvals need their context.

**Banners**, stacked at the top, each a `NoticeBar` with one action:
- "{machine} is offline · last seen 12 min ago." [Details]
- "{machine} needs a host update to work with this app." [How to update]
- "This phone was removed from {machine}." [Pair again]

**Empty states:**
- No machines: the onboarding card.
- Nothing active: the pixel terminal illustration, "Nothing needs your attention"
  (the desktop's inbox wording), and a ghost button **Start a session**.

## 11.13 Projects

The phone's version of the desktop project rail (`ProjectRail.tsx`).

**Navigation bar.** Title "Projects", a **+** that opens an action sheet with "Open
folder on a machine…" (the desktop's wording), and a Search field ("Search
projects..."), matching the rail's search row.

**Sections:**
- **Pinned:** projects pinned on this phone. Pins are stored on the phone, as the
  desktop stores its own.
- **Projects:** grouped by machine when two or more machines exist. Each group header
  is a `MachineRow`: the machine label, a status dot (emerald online, content α .35
  offline, amber connecting), and the transport glyph (none for direct, a relay glyph
  for relay). The header opens Machine details.

**Project row** (52 pt), from the rail's project card:
- The leading 16 pt slot holds the project mascot in its colour (logos are
  desktop-local, so the mascot is the default). It hops while any session runs.
- The name is 15 pt 500 and shimmers while busy.
- At right: `+N` emerald and `−N` red (12 pt semibold, tabular) from `git.index` when
  cached.
- Selected (iPad) is `sel.strong`; otherwise rows are at opacity .65 with full opacity
  when pressed, as on the desktop.

**Long press** opens: Pin / Unpin, Open folder on machine (Explorer), New session,
Copy path.

**Empty:** "No projects yet" with the "Open folder on a machine…" button.

**Open folder on a machine…** follows `AddRemoteProjectDialog.tsx`:
1. Pick the machine.
2. Browse with `projects.browse`, with breadcrumbs. The rows are folder icon and name.
   A path field reads "Type an absolute path".
3. **Open**.

## 11.14 Project screen and session list

The phone's version of the desktop session sidebar (`Sidebar.tsx`).

**Navigation bar:**
- The title is the **working-copy switcher** (`SidebarWorktreeSwitcher`): the focused
  branch, or "Workspace", with `ChevronsUpDown`. Tapping opens a sheet with the same
  rows:
  - "{main branch}" with "Project folder · all sessions";
  - one row per worktree with branch and path, an open-session count, and a busy dot.
- Selecting a row filters the list, exactly as on the desktop.
- The right side holds **+** (New session in this project and working copy).

**Segmented control:** **Sessions**, **Explorer**, **Changes**, the desktop sidebar
tabs. Changes shows `+N −N` instead of the word when there are changes.

**Sessions toolbar:**
- A search field with the placeholder "Search conversations...".
- A filter button that opens the desktop filter menu as a sheet:
  - Archived;
  - Status: Working, Needs approval, Done;
  - Time: All time, Today, Last 7 days, Last 30 days;
  - Provider (one row per harness);
  - Clear filters.

**List.** A Pinned group first (if any), then the rest, newest first
(`compareSessionSummaries`), paged 50 at a time (`sessions.page`). Folders and
reminders are desktop-local and not shown.

**Session card**, the desktop anatomy at mobile sizes (about 88 pt):

```
┌ r.sm, px 12, py 10, border 1pt (transparent unless dashed) ──────────────┐
│ [harness 16] Claude Opus 4.6 (12 α.50)            ⚠ Need approval (12)   │
│ 📌 Fix flaky auth test (15 / 600, one line)                              │
│ ⑂ monocode/fix-auth (12 α.45)                     +478 −2   [#123]       │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Status slot** (12 pt, tabular, 14 pt icon), with the desktop's priority and
  wording:
  - amber `CircleAlert` + "Need approval" ("Needs input" for questions);
  - accent braille spinner + "Working..." (ASCII dots, verbatim);
  - emerald `Check` + "Done" while unseen;
  - `CircleDashed` + "Draft";
  - otherwise the relative time ("now", "5m", "2h 10m", "3d", "Oct 3").
- **Card states:**
  - selected on iPad: `sel`;
  - needs approval: `content α .20` fill with a dashed α .30 border;
  - draft: dashed α .25;
  - default text α .80;
  - pressed: `fill.hover`.
- The `#N` linked work item badge is an accent 12 pt label with a PR or issue icon. It
  is informational on the phone and opens the GitHub URL.
- A **title change** plays the particle sweep (§11.6). A **new session** plays the
  insertion motion.
- **Swipe left:** Archive. **Swipe right:** Pin / Unpin.
- **Long press:** the desktop session menu, minus local-only items:
  1. Pin / Unpin
  2. Rename
  3. Copy session ID ▸ Harness session ID, MonoCode session ID
  4. Mute notifications (phone only)
  5. Archive / Unarchive
  6. Delete (danger)

  Delete confirms: "Delete session?" / "“{title}” will be permanently deleted."
  [Cancel] [Delete session]. It is disabled while running.

**Empty and error states** use desktop copy:
- "Sessions you start will show up here", with the pixel terminal illustration.
- "No matching sessions".
- "No sessions match these filters".
- "Couldn’t load sessions".

## 11.15 Session screen

```
┌──────────────────────────────────────────────────┐
│ ‹  Fix flaky auth test                    ⋯      │  nav bar (glass), title 17/600 with particle sweep
│    Claude Opus 4.6 · my-app · mac-mini           │  subline 12 α.45 (+ "· relay" when relayed)
├──────────────────────────────────────────────────┤
│ Waiting for the host to confirm your request. Retry │  NoticeBar (only when needed)
├──────────────────────────────────────────────────┤
│                      ┌────────────────────────┐  │
│                      │ The auth test fails…   │  │  user bubble (chat layout)
│                      └────────────────────────┘  │
│  ⌄ Claude Opus worked for 1m 12s                 │  fold line
│  The failure comes from a race in…               │  prose
│  ┌ src/auth/session.ts            +12 −3 ┐       │  diff card
│  │ …                                     │       │
│  └───────────────────────────────────────┘       │
│  · ⓒ worked for 1m 12s · 3:42 PM   ⧉  ▦          │  turn footer
│                 [ ⌄ ]                             │  jump to latest
├──────────────────────────────────────────────────┤
│ [Question form | Usage limit tab | Queue card]    │  above the composer, as on desktop
│ ┌ composer ────────────────────────────────────┐ │
│ │ ⑂ Current checkout · main              ◔     │ │  top bar (hidden while typing)
│ │ Ask, build, / for commands...               │ │
│ │ [+] [Plan ×] [◆ Opus 4.6 · High ⌄] [🔒 ⌄]  [↑]│ │
│ └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Navigation bar:**
- The title is tappable to rename.
- The subline shows the model name, project and machine, plus "· relay" when
  relayed.
- There is no status chip. The fold line and the Stop button carry state, as on the
  desktop.

**The ⋯ menu:** Session info; Explorer; Changes; Rename; Pin; Archive; Mute
notifications; Compact context; Copy session ID ▸; Delete.

**Session info sheet:** working copy and branch, model and settings, permission mode,
context usage (the `ContextMeter` ring plus "N% of context used" in `formatTokens`),
usage limit, created and updated times, provider session id, machine and transport.

**Notice bar.** The desktop's remote notice bar (`RemoteSession.tsx:1273-1295`): 12 pt
content α .65 on a `stroke` bottom border, one action. States and copy are the
desktop's:
- "Waiting for the host to confirm your request." [Retry]
- "Couldn’t send the message on {machine}." [Try again]
- "Couldn’t load models from {machine}." [Retry]
- `{error}` [Dismiss]
- Plus the phone's offline state (M5): "{machine} is offline. Messages you send will
  go out when it's back."

**Scrolling and anchoring:**
- The transcript opens at the live tail.
- Pinned-to-bottom uses the desktop rule: within 16 pt counts as pinned, and any
  upward scroll un-pins.
- "Prompt anchoring", a desktop setting that defaults on: after a send, the new
  prompt sits at the top and the answer grows beneath. It uses a footer spacer equal
  to the viewport minus the last turn's height.
- **Jump to latest:** a 32 pt glass square with `ChevronDown`, centred above the
  composer. With an undecided approval below the fold it widens to an amber-dotted
  "Waiting for approval" (M6).
- Older turns load at the top with the desktop's "Load earlier messages" button
  (13 pt α .60 on `fill.chip`), which also triggers automatically when the person
  scrolls to it.

**Freshness.** While cached content waits for the first sync, the subline appends
"· Updating…" in shimmer.

## 11.16 Transcript rendering rules

Grouping uses the shared core (`groupTurns`, `groupTurnItems`, `buildActivityPhases`,
`foldableWork`, `workSummaryLine`, `toolCallState`, `resolveToolCallDisplay`). The
phone implements only the views, with the desktop's anatomy.

Everything in this section is drawn by the native transcript (`MonoTranscriptView`,
[15 §15.4](15-performance.md#154-the-native-transcript-monotranscriptview)). The rules
below are its visual specification. Each block kind maps to one or more `RowSpec`
kinds. Motions listed here run natively with the §11.6 values.

**Layout.**
- Chat layout is the default: user bubbles right-aligned with a 40 pt left dead zone.
- "Full width" is an option in Settings → Chat. It gives full-width bordered bubbles
  with `r.md`.
- Assistant prose is never boxed.

| Block | Rendering |
|---|---|
| `user` | Bubble `fill.bubble` (or user accent α .24 with α .30 border), `r.lg`, `r.full` when a single line of plain text. Padding 12 / 8. 16 / 25 text, clamped to 4 lines with "Show more" / "Show less" (13 pt α .60). Attachments above the text: 44 pt image thumbnails (`r.md`), file chips (`fill.bubble`, 12 pt name). Under the bubble, always visible (the desktop's touch layout): Copy and Edit icon buttons (α .40), then the time (13 pt α .40). Pending outbox states replace the time: "Sending…", "Waiting for {machine}", or "Not sent · Retry · Discard" |
| `user` + `draft` | Dashed α .30 border, fill α .04. Footer under a dashed α .20 divider: `CircleDashed` "Draft", then Remove (ghost) and Send ↑ (primary) |
| `assistant` | Markdown at 16 / 25, paragraphs content α .78, bold and italic full. Gaps: 16 between blocks, 8 before a list after a paragraph. Lists indented 24, items padded 4. Blockquote: 4 pt left border α .20, inset 16, italic. Rules: 1 pt α .10 with 24 margin. Links `sky-400` α .90 with no underline at rest. Workspace file links open the file viewer. Inline code: `fill.chip`, `r.sm`, mono 0.85 em, at least 24 pt tall. **File chips:** inline code that the desktop's `inlineFileName` rule treats as a file (no spaces, ≤ 240 chars, a 1-12 char extension or a known extensionless name such as `Makefile`, optional `:line[:col]` or `#Lstart-Lend`) gets a 16 pt Material Icon Theme file-type icon before the text, as on the desktop (`AgentMarkdown.tsx`). Tapping opens the file viewer at that line; long press offers Copy path Remote `http(s)` images are not loaded (the desktop drops them too); `data:` images render |
| Code block | `r.block`, border α .10, fill α .06, 16 margin. Header 40 pt: file-type icon, the language or path (mono 13 / 500 α .65; a path opens the file), Copy (24 pt, copy → check morph). Body: horizontal scroll, mono 13 / 19, line numbers optional (Settings → Chat, default off on phones; desktop on). Shiki github themes |
| Table | The code-block card; cells 8 / 10 padding at 13 pt; header 600; row dividers α .05; horizontal scroll |
| Reasoning | Never its own row. A trail **Thinking row**: one line of `proseSummary(text)` or "Thinking" at α .50, pulsing while streaming. Tap expands the reasoning markdown at α .48 |
| Tool (in a trail) | **Trail row:** the verb in sans (Read, Edit, Ran…) at α .50, then a **file chip** (`fill.code`, `r.xs`, file icon, mono 14 α .70, truncated) that opens the file or the diff. Shell and other unparsable labels: one mono 14 line at α .65. **No spinner or status icon**; the live phase header shimmers instead. Failed: verb and target red-400, a trailing red X, tap shows the error detail (mono 13 red-400 α .80). Tap on a non-file row opens the tool sheet (title, preview, detail, "Load full output" when truncated) |
| Edit awaiting approval | A standalone **diff card** (FilePreview): `r.block`, border α .10, fill α .06. Header: file icon, mono 13 / 500 path, `+N −M` (12 pt semibold emerald / red). Up to 6 preview lines: a 2 pt bar (teal-400 / rose-400), number column mono 11 α .35, `+` / `−` gutter, text mono 12 / 18; added rows `teal-800` α .20, deleted rows `rose-800` α .20, context α .70. Then the approval controls |
| Other tool awaiting approval | The tool row, forced open in its group, followed by the approval controls. The fold line reads "Waiting for approval" and its clock pauses |
| Subagent (`agentRun`) | **Subagent row:** the mascot hashed by name (content α .70 while running, α .45 done, red-400 failed, hopping while running), the name (16 pt, shimmer while running), and at right the model plus "N steps" or "N steps, M failed" (13 pt α .40), then a chevron. Tap expands its own trail and report. Live: pinned outside the fold. Settled: inside the fold, except failures |
| `tasks` | **Task list card:** `r.block`, border α .10, fill α .035. Header: "Tasks" (mono 13 / 500 α .85) and a pill "N of M" or "Complete" (mono 11, `r.full`, fill α .07). Rows 13.5 / 20: completed = emerald circle with check, text α .40 struck; in progress = spinning loader sky-300, α .85; cancelled = Minus, α .35 struck; pending = empty circle α .25, α .60 |
| `plan` | **Plan card:** `r.lg`, border α .10, fill α .07, padding 12 / 10. `AiIdea` icon (α .40; `CircleDashed` while streaming), title 15 / 500 α .90, summary 13 / 18 α .50 clamped to 3 lines. Footer at right: **Open** (secondary; full-screen plan reader) and **Build** (primary, Play icon; "Building…", "Built" disabled). Build sends `send {intent:"build", planBlockId, text: buildPlanPrompt(plan.text)}`. Shown when the host has `sessions.plan` and the session is idle |
| `image` (generated) | A file chip "Generated image · name · size". Generated images aren't served by hosts yet |
| `system` (plain, status) | Folds into the trail as a status row (α .50) |
| `system` + `notice:"error"` | The desktop's notice row (mono 14 α .50, 16 / 8 padding) with a leading red-400 `AlertCircle` (M4) |
| `system` + interrupt, or host restart/stop text | The same notice row with an amber `AlertCircle` |
| `system` + `interjection` | **Hairline divider:** two 1 pt α .12 lines flanking the label (Advisor / Notice / custom, 13 pt α .55) and severity (Blocker red-400, Concern amber-400, Nit α .55). The body below at 14 / 21 α .70, clamped to 2 lines with "Show more" |
| Local-only kinds (`handoff`, `secondOpinion`, `btwThreads`, `noteCard`, `orchestration`, `ciContext`) | Not produced by hosts. If present, a plain notice row with `text` |
| Unknown role | A notice row with `text` and "Update MonoCode to see this content" |

**Fold line** (`WorkFoldLine`). One row (16 pt, α .50) at the start of a turn's work,
with the desktop wording:
- **Live:** shimmer "{model} working for 12s", "Waiting for approval" or "Waiting for
  answers".
- **Settled:** "{model} worked for 1m 12s", or the summary ("Read 3 files · Edited 2
  files · Ran a command").
- **Phone adaptation:** the leading slot always shows a chevron (α .45, rotating
  90°), because there is no hover to reveal it. Tap folds or unfolds.

**Activity trail.**
- The desktop rail geometry: a 1 pt spine (content α .14 mixed opaque over
  `bg.base`), 8 × 8 quarter-curve branches, rows inset 20 pt.
- Phase group headers: a 16 pt kind icon, then the title (the agent's introducing
  line, or the work summary), shimmering while live.
- The live group shows its newest steps in a scroll window of
  `min(280 pt, 45 % of the screen)`, pinned to the newest step.
- Steps enter with the step-entrance motion (§11.6).

**`InitialThinking`.** "Thinking…" at 16 pt α .50, shimmering, before the first
token.

**Turn footer** (settled turns with a duration), 14 pt α .40:
- Copy response (copy → check), then Metrics (opens a sheet: "Cache hit 87% · Output
  42 tok/s" and "12k input · 1.2k output · 9.8k cached").
- Then a 3 pt dot, the harness icon and "worked for 1m 12s" (when the fold line isn't
  already showing it), a dot, and the completion time at α .35.

**Hairline dividers** (handoff and interjection): `px-4 py-5`, two α .12 lines and a
centred 13 pt α .55 label.

**Long press on a message:** Copy text; Copy turn (`turnCopyText`); Share; Select
text. Selecting text opens a selectable text view, since React Native text selection
inside virtualised lists is unreliable.

## 11.17 Composer

The desktop composer's anatomy (`Composer.tsx`), with the quick composer's type size.

**Container.**
- `r.md`, border α .10, focus α .20, `fill.composer` with blur 8, 8 pt side margins
  over the safe area.
- Edit mode (not in v1) would use the dashed accent border.

**Stacked above the box,** in the desktop's order, each attached as a tab (`r.block`
top corners, no bottom border):
1. **Question form** (§11.18).
2. **Usage limit tab:** amber-400 α .25 border, α .10 fill, height 36.
   - `Gauge` amber, "Usage limit reached" (α .85), "Resets in 2h 10m" or "Limit has
     reset".
   - At right, a dismiss X. **Resume** appears when the host supports it; the
     desktop's "Resume at reset" is local-only, so it is hidden.
3. **Queue card:** "Queued (2)".
   - Each row (min 44 pt): `ListEnd` icon, text α .80 truncated or "N attachments",
     then **Steer**, **Edit** and **Remove** buttons.
   - When paused: `Pause` icon, "Queue paused because you interrupted" and **Resume**.

**Top bar.** The desktop's identity row: `Folder` or `FolderTree` icon, "Current
checkout" or "Worktree", then the branch with `GitBranch` (mono 12 α .55), and the
context ring at right.
- It is shown while the keyboard is closed and hidden while typing, to give the input
  room.
- Tapping the ring opens a sheet with the usage numbers and **Compact now**, which is
  `/compact`.

**Input.**
- 16 / 24 sans, grows to 6 lines then scrolls. The placeholder is the desktop's, minus
  local-only parts: "Ask, build, / for commands...".
- A leading `/plan` or `/draft` is coloured in its mode colour by an overlay text
  layer, as on the desktop, and plays the 900 ms mode shimmer once.
- Typing `/` at the start opens the **slash picker** docked above the composer, with
  48 pt rows. Commands and descriptions are verbatim from the desktop:
  - `/plan`: "Create a reviewable implementation plan before changing files."
    (with `sessions.plan`);
  - `/draft`: "Save this message without starting the agent." (with
    `sessions.draft`);
  - `/compact`: "Summarize older conversation context to free space."

  Name 15 pt in the skill colour, description 13 pt α .50. Empty: "No matching
  commands or skills".

**Chip row** (horizontal scroll, 26-pt visual chips in 44-pt hit areas). Left to
right:
1. **+** (`sel` fill, Plus icon at stroke 1.5). It opens the **Add to message** sheet:
   - caption "ADD TO MESSAGE";
   - rows with icon, 15 pt label and 13 pt α .45 hint:
     - **Upload file**: "Attach files or images". It continues to Camera / Photo
       library / Files. Disabled with "Update this machine’s host to attach files"
       when unsupported.
     - **Plan mode** (`AiIdea` yellow-300 α .80): "Review a plan before building".
     - **Draft** (`CircleDashed`): "Save this message without starting the agent".
2. **Mode pill**, when Plan or Draft is on: the desktop pill styles (`mode.plan` /
   `mode.draft`) with an X.
3. **Model chip:** harness icon, model name and effort label at α .50, chevron. It
   opens the **model sheet**:
   - **Settings section** first, in the desktop order (fast, effort, reasoning,
     reasoning effort, service tier, thinking, variant, context). Selects open a
     sub-list with check marks. Toggles are switches (the desktop's root-menu switch
     style). Ultra and Max Codex efforts get the tile glow (P2).
   - **Model** row: opens the model list with search ("Search models"), a
     horizontal provider strip (Favorites star, then provider icons), and rows with
     the name, a favourite star (always visible) and a check on the current model.
     Empty states use desktop copy: "No favorite models", "No matching models",
     "Loading Codex models…".
   - The provider is fixed once the session has started (`allowedModelHarnesses`).
   - Changes apply as `configure` when idle. While running: "Changes apply to the
     next turn."
4. **Access chip:** the mode icon (Lock, Pencil, Sparkles, or Shield in amber-400 α
   .90) plus its label. It opens the **access sheet** in the quick composer's
   permissions layout (`QuickPermissions.tsx`: 16 pt icon, 15 pt 500 label, 13 pt α
   .45 hint, accent check):

   | Mode | Hint |
   |---|---|
   | Supervised | Ask before commands and file changes. |
   | Auto-accept edits | Auto-approve edits, ask before other actions. |
   | Auto | An AI reviewer can approve or deny actions. |
   | Full access | Allow commands, edits, and supported MCP confirmations in non-plan turns without prompts. |

   Choosing Full access asks for confirmation (D16): "Allow full access? The agent
   will run commands and edit files without asking." [Cancel] [Allow full access].
   While running: "Access changes apply to the next turn. Stop and resend to apply them
   now."
5. **Send / Stop** (`PrimaryAction`, 32 pt visual square, `r.sm`, `ArrowUp` at
   stroke 2.25):
   - empty and idle: disabled;
   - text and idle: Send;
   - running and empty: **Stop** (a filled square);
   - running with text: Send, which queues when the host has `sessions.queue` (the
     desktop's "Follow-up behavior: Queue").
   - Label "Save draft" in Draft mode.

**Keyboard.** The composer rides the keyboard (`react-native-keyboard-controller`).
Return inserts a newline (M7). Hardware keyboards get desktop behaviour: Enter sends,
Shift+Enter inserts a newline, ⌘. opens the model sheet.

**Attachments.**
- Chips render above the input, like the desktop: 44 pt image thumbnails with a 20 pt
  remove button, and file chips.
- Upload progress shows as a ring on the chip.
- Limits are 20 files of 20 MiB each. Images are normalised to JPEG 2,048 px unless
  "Send original" is on ([12 §12.10](12-mobile-engineering.md#1210-attachment-pipeline)).

## 11.18 Approvals and questions

**Inline approval controls** (`ApprovalControls`) sit under the tool row or diff card:
- **Allow** is primary (`content` fill, `bg.base` text);
- **Deny** is secondary (`fill.bubble`, text α .70);
- both are 36 pt tall with 13 pt / 500 labels, side by side, Allow on the right.
- They disappear when decided. "Sending…" replaces them while the outbox entry is
  pending.

**Confirmation.** Optional, in Settings → Security → "Confirm approvals with Face ID":
Off (default), For commands and edits, or Always.

**Approval banner** (the desktop's approval toast) for a session that isn't on
screen:
- A dashed α .20 glass card, `r.lg`, at the top with 12 pt side margins, entering with
  translateY −8 and scale .98 over 180 ms.
- Body: harness icon, session title (15 / 600), amber `CircleAlert` "Approval" or
  "Question" (12 pt), the label (14 / 21 α .70, 3 lines), and the harness name (12 pt
  α .40).
- For approvals, a footer with Allow and Deny. Tapping the body opens the session.
- It stays until resolved or swiped away.

**Question form** (`QuestionForm`). Above the composer, like the desktop, never as a
modal:
- **Card:** `r.md`, border α .10, `fill.composer`, 12 / 10 padding.
- **Header:** `MessageSquare` α .45, the header or title ("Question" fallback), "N of
  M" for several questions, and **Skip**.
- **Prompt:** 15 / 500. "Select all that apply" (12 pt α .40) for multi-select.
- **Options:** rows (min 48 pt) with a 16 pt indicator, round for single and `r.xs`
  square for multi, filled `content` with a check when selected. Label 14 pt and
  description 13 pt α .50.
  - Unselected: border α .10. Selected: border α .35 and `sel`.
  - An **Other** row reveals a text field ("Type your answer").
- **Footer:** "Optional question", or "Continues without an answer in 14s" (12 pt α
  .40, host-clock countdown), and **Continue** (primary; it submits on the last
  question).
- **Long forms.** If the form would cover more than 60 % of the screen, it becomes a
  sheet with the same content. Any interaction tells the host to keep it open, as on
  the desktop.

## 11.19 New session

This is the desktop's empty session (`EmptySession.tsx`) combined with the quick
composer.
- A static dot-grid background (6 pt cells, 1 pt dots at content α .06).
- The heading **"What should we work on in {project}?"** (20 / 26, 500), or "What
  should we work on?" with no project chosen.
- The composer centred beneath, whose top bar holds the pickers:
  - **Machine and project** (the `CwdPicker` analogue): "{project} · {machine}". It
    opens a sheet of machines then projects, plus "Open folder on a machine…".
  - **Workspace:** "Current checkout" or "New worktree", the desktop labels. Existing
    worktrees are listed under Current checkout when the project has them.
  - **Branch:** the base branch for a new worktree, or the current branch, shown
    read-only.
- The chip row: +, model chip (all installed providers selectable), access chip,
  Send.
- The input placeholder is "Ask, build, / for commands...". The quick composer's
  wording, "Start a {Harness} session in {project}…", is used when the keyboard opens
  on an empty prompt.

**Starting.**
- Send dispatches one `create` with `initial` and `worktree` when the host supports
  `sessions.createWithPrompt`. Otherwise it sends the chained commands
  ([06 §6.9](06-channel-protocol.md#69-commands)).
- The composer docks to the bottom over 480 ms (§11.6), and the screen becomes the
  session.
- A Plan-mode first message plays the Plan burst.

**Remembered choices** (last machine, project, model and access) are stored per
machine and project.

## 11.20 Explorer and Changes

Both are segments of the Project screen and are also reachable from a session's ⋯
menu, where they are scoped to the session's working copy.

**Explorer.**
- A directory list (`files.list`) with breadcrumbs. Rows are 44 pt: file-type icon and
  name (15 pt), folders first.
- **Go to file** search uses the palette's placeholder, "Go to File".
- **File viewer** (`files.read`, 1 MiB text):
  - mono 13 / 19, Shiki highlighting, line numbers;
  - wrap toggle and a find bar ("Find in file", counter "n of m");
  - Markdown files offer **Preview**.
  - Oversized or binary files: "This file can't be shown on the phone."

**Changes.** The desktop Changes panel.
- **Header:** "Changes" with `+N −M`, and the branch with `GitBranch`.
- **Commit area:** message field (placeholder "Message"), and a **Commit** button with
  a chevron that opens "Commit and push".
  - Commit and push are disabled while a session in the project runs; the host also
    enforces this.
  - Both use idempotency keys ([06 §6.8](06-channel-protocol.md#68-idempotency-and-retries)).
- **List:** "CHANGES" caption with a count pill. Rows: file-type icon, name (15 pt),
  directory (13 pt α .45), status letter at right (M amber, A or U emerald, D red, R
  accent), from `git.index`.
- **Diff viewer** (`git.fileDiff`): the desktop unified diff, with rows 22 pt, hunk
  headers on `fill.hover`, mono 12 text, add and delete tints, Prev and Next file, and
  a wrap toggle.

## 11.21 Machines and settings

**Settings** follows the desktop structure: a grouped list, then pages built from
`Group` and `Row`.

| Group | Pages |
|---|---|
| App | General (Sounds, Haptics, Notifications), **Machines**, Appearance, Security, Privacy |
| Agents | Chat (Transcript layout: Chat / Full width; Anchor prompts to top; Code line numbers; Composer mascot), Notifications |
| About | Version, Licences, Privacy policy, Diagnostics, Demo |

Each page is laid out like the desktop:
- a page heading (22 / 600) with a description (13 pt α .45);
- `Group` cards: `r.lg`, border α .10, `fill.composer`;
- `Row`s with a 15 / 500 label, a 13 pt α .45 description, and the control;
- `Toggle`: 36 × 20 pill, accent when on, α .20 off, 16 pt white knob.

**Machines.** The phone's version of desktop Settings → Connections:
- Heading "Your machines", description "Agents run on your computers. MonoCode keeps
  working on them when your phone is away."
- A `Group` card of `MachineRow`s, each with:
  - icon (globe, or a phone badge for a desktop's "This computer");
  - the name (15 / 500);
  - the transport line ("Direct · Wi-Fi · 24 ms" or "Relay · 140 ms", 13 pt α .45);
  - the status (13 pt α .50), using the desktop's set: "Checking connection…",
    "Connected", "Connected · install a supported provider on the host", "Offline",
    "Update the host to use this app".
- The button **Pair a machine**.
- The empty state is the desktop's dashed box: "Pair a computer to get started."

**Machine details:**
- Header: the label (rename) and the colour.
- Groups:
  - **Connection:** status, transport, RTT, version, last seen, Test connection, Copy
    diagnostics.
  - **Notifications** ([08 §8.11](08-notifications.md#811-settings)).
  - **Providers:** installed, with catalog errors.
  - **This phone:** name, paired date, role.
  - **Advanced:** fingerprint, `environmentId`, endpoints, relay URL.
- **Remove** opens a confirm dialog modelled on the desktop's: "Remove {name} from
  this phone?" / "This phone loses access. The host keeps running and your sessions
  stay on it." [Cancel] [Remove from this phone].

**Security:** App lock (Off / Face ID / Passcode), Lock after (Immediately / 1 min /
5 min / 15 min), Confirm approvals with Face ID, Hide content in the app switcher.

**Privacy:** Compress traffic, Load remote images (off), default notification preview
for new machines.

## 11.22 Voice and copy

The desktop's voice is used as is. All user-facing strings live in
`apps/mobile/src/strings.ts`. Strings that exist on the desktop are copied verbatim;
the parity test lists them.

- **Sentence case** everywhere. Title Case appears only in OS-convention places.
- **No emoji.** Status uses icons and the braille spinner.
- **Punctuation.** Buttons and menu items have no trailing period; descriptions and
  explanations are full sentences. "…" (Unicode) after an item means more input
  follows ("Open folder on a machine…"). Existing desktop strings keep their exact
  characters, including ASCII "Working..." and the curly apostrophe in "Couldn’t load
  sessions".
- **Tone.** Plain, second person, calm. State what is true, then what to do: "Install
  it, or restart MonoCode if it is already installed."
- **Words:** machine (not server or host in UI, except "host update"), session,
  project, worktree, working copy, Plan, Build, Allow, Deny, Need approval, Working,
  Done, Draft, Supervised, Auto-accept edits, Auto, Full access, Steer, Queue.
- **New phone strings** follow the same rules and are reviewed against this section.
  Examples:
  - "Waiting for {machine}"
  - "Answered on another device"
  - "This request ended before your answer arrived."
  - "{machine} is offline · last seen 12 min ago."
  - "Update MonoCode to keep using {machine}."

## 11.23 States catalog

| Situation | Where | Copy |
|---|---|---|
| Reconnecting (> 3 s) | Session subline, machine row | "Reconnecting…" (shimmer) |
| Offline | Notice bar, Agents banner | "{machine} is offline · last seen 12 min ago." |
| Removed from the machine | Machine row, session | "This phone was removed from {machine}." [Pair again] [Remove] |
| Identity changed | Same | "Can’t verify {machine}. It was reinstalled or its identity changed." [Pair again] [Remove] |
| Host too old | Same | "{machine} needs a host update. Update it from MonoCode on your computer: Settings → Connections → Update Host." |
| App too old | Same | "Update MonoCode to keep using {machine}." |
| Command pending | Under the user bubble | "Waiting for {machine}" |
| Command expired | Under the user bubble | "Not sent. {machine} was unreachable." [Retry] [Discard] |
| Session busy, no queue support | Composer | "Wait for the agent to finish, or stop it." |
| Approval resolved elsewhere | Toast (12 pt, glass pill, 2 s) | "Answered on another device" |
| No providers on the machine | New session | "{Name} not found. Install it on {machine}, or restart the host if it is already installed." |
| Catalog error | Model sheet | "Couldn’t load models from {machine}." |
| Truncated output | Tool sheet | "Showing the last 10,000 characters." [Load full output] |
| Notifications off at OS level | Settings | "Permission needed" + [Open Settings] |
| Empty project | Session list | "Sessions you start will show up here" |
| Nothing active | Agents | "Nothing needs your attention" |

## 11.24 Accessibility

- **Screen readers.** Every row has a full label, for example "Fix flaky auth test,
  my-app on mac-mini, need approval: run npm test, 2 minutes ago". Status is announced
  in words, not only by colour or icon. Streaming text is announced at turn end, not
  per word.
- **Dynamic Type** up to the accessibility sizes (clamped at 1.6×). Cards grow in
  height instead of truncating status.
- **Contrast.** Text tiers below α .45 are never used for essential information. The
  status colours meet WCAG AA on both default themes, and every status also has an
  icon.
- **Reduced motion and reduced transparency** (M9; §11.4 materials).
- **Hardware keyboards and pointers** (iPad): desktop shortcuts where they make sense
  (⌘N new session, ⌘F find, ⌘. models, Enter to send), plus hover states from the
  desktop.
