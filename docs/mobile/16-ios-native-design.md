# 16. iOS native design plan

Status: **proposal**, 2026-10-05, on branch `feat/ios-native-design` (worktree
`.worktrees/ios-native-design`), created from `feat/mobile-app` at `b286412`. The host
Origin fix is still uncommitted on `feat/mobile-app` and is not on this branch. Read after [11](11-design-and-ux.md),
[12](12-mobile-engineering.md) and [15](15-performance.md).

This document plans how the app that exists today becomes an iOS-native MonoCode:
the platform's chrome everywhere (D18) around MonoCode's content (D12). It is written
against the installed toolchain and names only APIs that exist in
`apps/mobile/node_modules` as of the baseline:

| Piece | Version | Relevance |
|---|---|---|
| Expo SDK / Expo Router | 57.0.26 / 57.0.24 | `NativeTabs` with `BottomAccessory` and `minimizeBehavior`; `Stack.Screen.Title large`, `Stack.Header`, `Stack.SearchBar`, `Stack.Toolbar` (left, right, bottom), `Link.Preview` and `Link.Menu` |
| react-native-screens | 4.26 | Form sheets: `sheetAllowedDetents` (fractions or `fitToContents`), `sheetGrabberVisible`, `sheetLargestUndimmedDetentIndex`, `sheetInitialDetentIndex`; `headerLargeTitle`, `headerSearchBarOptions`, `headerBlurEffect`, `headerTransparent`; search bar `placement` up to `integrated` |
| expo-glass-effect | 57.0.4 | `GlassView` (`glassEffectStyle`, `tintColor`, `isInteractive`, `colorScheme`), `GlassContainer`, `isLiquidGlassAvailable()` |
| expo-blur, expo-symbols, expo-haptics | 57.x | Pre-26 materials, SF Symbols with `animationSpec`, haptics |
| @expo/ui | 57.0.21 | SwiftUI `BottomSheet` (`fitToContents`), `ContextMenu` with `Trigger`, `Preview`, `Items`; a fallback, not the default |
| react-native-reanimated / gesture-handler | 4.5 / 2.32 | UI-thread motion; `react-native-gesture-handler/ReanimatedSwipeable` |
| Xcode | 27.0 | The app builds against an iOS 26-era SDK, so Liquid Glass applies on iOS 26+ automatically. `UIDesignRequiresCompatibility` is not set and must stay unset |
| Deployment target | iOS 16.4 | Custom sheet detents, `NativeTabs` and `Link.Preview` all work from 16.4 |

Not installed, and this plan adds it: `react-native-keyboard-controller` (native;
needs a new dev build). Not installed, and this plan drops it from the iOS story:
Hugeicons (§16.3, M12).

Test tiers:

| Tier | Where it runs today | Bars, tab bar, sheets | Glass surfaces |
|---|---|---|---|
| iOS 26+ | iPhone 17 simulator (iOS 26) | Liquid Glass, by the system | `GlassView` |
| iOS 16.4 to 18 | iPhone 13, iOS 18.7 | System bars with their translucent blur | `expo-blur` with the 11 §11.4 values |
| Reduce Transparency on | Either | System | Opaque tokens |

Android is out of scope here. Nothing below removes an Android path; every iOS-only
component is chosen behind a `Platform.OS === "ios"` branch or a capability check.

## 16.1 The rule: native chrome, MonoCode content

**Chrome is the platform's.** Tab bar, navigation bars and large titles, search bars,
bottom toolbars, pull-down and context menus, action sheets, alerts, form sheets and
their detents, push and sheet transitions, the back swipe, scroll-edge effects, glass
materials, keyboard tracking, haptics and SF Symbols. The system draws them, the
system animates them, and MonoCode only tints them (`accent` for the tab selection and
bar buttons).

**Content is MonoCode's.** Session cards, project rows, the composer box and its
chips, buttons, the segmented control, notice bars, settings `Group` cards, the
transcript and the viewers keep the desktop's anatomy, tokens, radii, type scale and
copy from `@monocode/design`. They sit inside native chrome and scroll under it.

**What is not changed by this plan.** The native transcript, the FlashList viewers,
the outbox, sync, pairing crypto, the demo host, and every string.

## 16.2 Audit: what the app does today

| Surface | Today (baseline) | Native target | Gap |
|---|---|---|---|
| Tab bar | `NativeTabs`, SF Symbols, `tintColor` accent, Agents badge | Same, plus `minimizeBehavior="onScrollDown"`, the iOS 26 bottom accessory ("＋ New session · N working"), `sidebarAdaptable` on iPad | Small |
| Tab screen headers | No navigation bar. A JS `Title` (28 pt text in a `SafeAreaView`) and a JS "＋" glyph | Each tab owns a native stack with a large title that collapses on scroll, a `plus` toolbar button, and a native search bar where the spec has one | Medium (route restructure) |
| Search | JS `SearchField` (Projects, Project sessions, Explorer, model sheet) | `Stack.SearchBar` in the navigation bar, `hideWhenScrolling` | Small per screen |
| Project screen | Custom `headerTitle` view, JS "＋", JS `Segmented`, `ToggleChip` for Archived | Keep the title view and the MonoCode segmented control; `plus` and a filter `Stack.Toolbar.Menu` with checkmark items; sessions search in the bar | Small |
| Session ⋯ menu | `Stack.Toolbar.Menu` with Explorer and Changes | Same mechanism with the full 11 §11.15 list, destructive Delete, submenus | Small |
| Composer pickers (model, access, add) | RN `Modal presentationStyle="pageSheet"` with a custom "MODEL · Done" header, full height | Native form sheets with detents (`fitToContents` for Access and Add, `[0.5, 1]` for Model), grabber, a native header with a close button | Medium (state moves to a store) |
| New session pickers (place, workspace, branch) | The same `Sheet` modal | The same form sheets | Medium |
| Long question form | The same `Sheet` modal | A form sheet route | Small |
| Tool and attachment sheets | Form sheet routes, detents `[0.5, 1]` and `[0.75, 1]`, grabber, no header | Keep; add `sheetLargestUndimmedDetentIndex: 0` for the tool sheet so the transcript stays scrollable at half height | Tiny |
| Action sheets | `ActionSheetIOS` (Projects ＋ and row long press, Changes rows) | Keep for the ＋ and for Changes rows; replace row long presses with context menus | Small |
| Context menus | None on session cards; action sheet on project rows | `Link.Menu` on project rows; `Link.Menu` plus `Link.Preview` on session cards | Medium |
| Swipe actions | None | `ReanimatedSwipeable`: Archive, Pin or Unpin, Mark seen | Medium |
| Approval banner | Opaque `t.base` card, `Animated` + `PanResponder` | Glass card (`GlassView` or blur), gesture-handler pan on the UI thread, `ease.pop` entrance | Small |
| Toast | Opaque pill | Glass pill | Tiny |
| Jump to latest | Not built (the Swift view already emits `onAtBottomChange`) | A 32 pt interactive glass square above the composer, with the "Waiting for approval" variant | Small |
| Composer material | Opaque `fill.composer` | `GlassView` on iOS 26, blur 8 before, opaque under Reduce Transparency; MonoCode border and radius on top | Small |
| Keyboard | `KeyboardAvoidingView` with a hard-coded `insets.top + 44` offset; the composer does not follow interactive dismissal | `react-native-keyboard-controller` sticky composer; the transcript's bottom inset follows the keyboard inside Swift | Medium |
| File and diff toolbars | A JS 44 pt `Toolbar` under the header | `Stack.Toolbar placement="bottom"` (glass on iOS 26); Find as a `Stack.SearchBar`; Wrap and Preview as checkmark menu items | Small |
| Explorer | In-place breadcrumbs inside the Project segment | Folders push native screens (the Files pattern); "Go to File" is the search bar | Medium |
| Settings | One screen of ad-hoc `Card`s | Large title, grouped list, pushed pages with MonoCode `Group` cards, Machine details | Medium |
| Pairing | One modal screen whose stages are JS state; "✓" is a text glyph | Keep the modal and the stage machine; native titles per stage, a Cancel bar button, an SF Symbol bounce on success | Small |
| Icons | SF Symbols through `expo-symbols` everywhere (the spec said Hugeicons) | SF Symbols, recorded as deviation M12 | Decision |
| Glass | `expo-glass-effect` and `expo-blur` installed, unused | One `Surface` primitive used by every floating surface | Small |
| Dynamic Type | `TYPE` is fixed; `transcriptTheme(t, scale)` has an unused scale | `fontScale` clamped at 1.6× feeds the tokens, the row-height functions and the transcript | Small |
| Reduce Transparency and Reduce Motion | Not read | Read once; gate materials and the M9 motions | Tiny |
| Haptics | Approve, Build, pairing | A small map (§16.4.11) | Tiny |
| App icon | `assets/expo.icon` (Icon Composer bundle) | Keep; verify the layered icon renders on iOS 26 | Verify |

## 16.3 Decisions this plan proposes

These extend the deviations table in [11 §11.1](11-design-and-ux.md#111-design-parity-rules).

| # | Deviation | Reason |
|---|---|---|
| M12 | **SF Symbols** for all chrome and content glyphs on iOS, instead of Hugeicons. Harness and brand marks stay MonoCode's (SVG or `xcasset` template images). Mascots stay pixel sprites | `NativeTabs`, `Stack.Toolbar`, `Link.Menu` and native menus take SF Symbol names, not vectors. The app already uses `expo-symbols` everywhere; mixing families would look wrong. Hugeicons is not installed |
| M13 | **Native large titles** on Agents, Projects and Settings, in the system's title font, not the 28/600 JS title. Pushed screens keep inline titles | Large titles collapse under scroll and host the search bar; they are the strongest iOS signal a list screen can give |
| M14 | **Pickers are native form sheets** with detents; "Add to message" fits its contents. Rows inside stay MonoCode `SheetRow`s | Detents, grabber, drag to dismiss and Liquid Glass come free; the RN `Modal` has none of them |
| M15 | **Long press on a session card opens a native context menu with a preview** of the session; project rows get a menu without preview. This supersedes the "context menus become action sheets" line for iOS. Action sheets remain for the Projects ＋ and for Changes rows | UIContextMenu is the iOS idiom for "actions on a row"; a preview is how iOS shows "peek" |
| M16 | **Pushed screens cover the tab bar.** Each tab owns a stack only for its header; Project, Session, Explorer, Changes and the viewers stay in the root stack as today | Keeps one copy of every route. The session screen needs the whole bottom edge for the composer anyway. Keeping the tab bar on Project screens would need shared route groups; deferred (§16.8) |

Material rules, as 11 §11.4 already states, made concrete:

- Bars and the tab bar get **no** `backgroundColor`, `blurEffect` or `shadowColor` on
  iOS 26, so they stay Liquid Glass. Before iOS 26 they get `Stack.Header
  blurEffect="systemChromeMaterialDark"` (or `Light`) over the system bar.
- `GlassView` is never tinted on bars. It is tinted only when interactive and small
  (the jump button, the accessory's spinner pill), and never with the accent at more
  than 20 % alpha.
- Every glass surface has an opaque sibling: `t.base` with a `stroke` hairline.

## 16.4 Design by surface

### 16.4.1 Tab bar and bottom accessory

```tsx
<NativeTabs tintColor={t.accent} minimizeBehavior="onScrollDown" sidebarAdaptable>
  <NativeTabs.BottomAccessory>
    <Accessory />
  </NativeTabs.BottomAccessory>
  <NativeTabs.Trigger name="(agents)">…</NativeTabs.Trigger>
  <NativeTabs.Trigger name="(projects)">…</NativeTabs.Trigger>
  <NativeTabs.Trigger name="(settings)">…</NativeTabs.Trigger>
</NativeTabs>
```

- The accessory renders only on iOS 26; UIKit gives it the glass capsule, so the
  content draws no background of its own. `NativeTabs.BottomAccessory.usePlacement()`
  returns `"regular"` (tab bar expanded) or `"inline"` (minimised, the accessory sits
  beside the tab bar):
  - regular: left, `plus` + "New session" (row type 15/500); right, the braille
    spinner in `accent` + "N working" (13 pt), or "Nothing running" (13 pt α .45).
  - inline: only the spinner and the count.
- Tapping "New session" pushes `/new`. Tapping the count switches to Agents.
- Before iOS 26 there is no accessory; the ＋ stays in each navigation bar.
- Tab icons stay SF Symbols with `default` and `selected` variants. The badge stays.

### 16.4.2 Tab screens: nested stacks, large titles, search

Route groups keep every URL as it is (`/`, `/projects`, `/settings`):

```
src/app/(tabs)/_layout.tsx                 NativeTabs, triggers (agents) (projects) (settings)
src/app/(tabs)/(agents)/_layout.tsx        <Stack>
src/app/(tabs)/(agents)/index.tsx          "/"           Agents
src/app/(tabs)/(projects)/_layout.tsx      <Stack>
src/app/(tabs)/(projects)/projects.tsx     "/projects"
src/app/(tabs)/(settings)/_layout.tsx      <Stack>
src/app/(tabs)/(settings)/settings.tsx     "/settings"
src/app/(tabs)/(settings)/settings/…       "/settings/machines", "/settings/machines/[env]", "/settings/appearance", "/settings/security", "/settings/about"
```

Each tab's stack shares the root stack's `screenOptions` (`contentStyle` base colour)
through one `stackScreenOptions(t)` helper, and sets the pre-26 bar material there.
A screen then declares its chrome as children, the Expo Router way:

```tsx
export default function Agents() {
  return (
    <>
      <Stack.Screen>
        <Stack.Screen.Title large>Agents</Stack.Screen.Title>
      </Stack.Screen>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="plus" accessibilityLabel="New session" onPress={() => router.push("/new")} />
      </Stack.Toolbar>
      <SectionList contentInsetAdjustmentBehavior="automatic" … />
    </>
  );
}
```

The `options` form (`headerLargeTitle`, `headerSearchBarOptions`) is the fallback if
a child component misbehaves; both are in the installed types.

- **Agents.** Large title "Agents"; `plus` at right. The "Updating…" line and the host
  notices stay as `NoticeBar`s under the bar. Sections and cards unchanged. The list
  uses `contentInsetAdjustmentBehavior="automatic"` so it scrolls under the large
  title and the tab bar.
- **Projects.** Large title "Projects"; `Stack.SearchBar placeholder="Search projects..."
  hideWhenScrolling` drives `query`; `plus` opens the existing action sheet. The
  machine chips from 11 §11.12 (All, then one per machine) can wait.
- **Settings.** Large title "Settings"; no search.
- The JS `Title` component and the `SafeAreaView edges={["top"]}` wrappers go away on
  these three screens.
- Tapping the selected tab again scrolls its list to the top and pops its stack. Both
  are `NativeTabs` defaults.

### 16.4.3 Session screen

- **Header.** The custom title view (title 17/600 over the 12 pt subline) stays; it is
  the right shape for "title + model · machine" and renders fine in a glass bar. On
  iOS 26 the header becomes `Stack.Header transparent` and the transcript gets
  `topInset={useHeaderHeight()}` (from `expo-router/react-navigation`) so rows scroll
  under the glass. Before iOS 26 the header stays opaque and `topInset` stays 0.
- **The ⋯ menu** keeps `Stack.Toolbar.Menu` and grows to the 11 §11.15 list as the
  host allows: Session info (opens the info form sheet), Explorer, Changes, Rename,
  Pin or Unpin (`isOn`), Archive, Mute notifications (`isOn`), Compact context, a
  "Copy session ID" submenu (nested `Stack.Toolbar.Menu`), then Delete with
  `destructive`. Items the host can't do are `hidden`, as today.
- **Composer.** The box becomes a `Surface` (§16.4.11): `GlassView` on iOS 26 with no
  tint, blur 8 before, opaque under Reduce Transparency; MonoCode's `r.md` radius, the
  α .10 border and α .20 focus border on top. Chips, the top bar and the send button
  are unchanged.
- **Keyboard.** The composer sits in a `KeyboardStickyView` from
  `react-native-keyboard-controller`, so it tracks the keyboard frame by frame and
  follows interactive dismissal (the transcript already sets
  `keyboardDismissMode = .interactive`). The transcript's bottom inset follows the
  keyboard natively: `MonoTranscriptView` observes
  `UIResponder.keyboardWillChangeFrameNotification` and animates `contentInset.bottom`
  with the notification's duration and curve. No JS per frame. The `insets.top + 44`
  offset goes away.
- **Jump to latest.** A 32 pt interactive `Surface` square with `chevron.down`,
  centred 12 pt above the composer, shown when `onAtBottomChange` reports `false`;
  tapping calls `scrollToBottom(true)`. With an undecided approval below the fold it
  widens to the amber-dotted "Waiting for approval" pill (M6). Entrance and exit are
  `ease.pop` 170 ms on the UI thread.
- **Question form.** The inline form stays. The "tall" case opens
  `/m/[env]/s/[sessionId]/question` as a form sheet (`sheetAllowedDetents: [0.6, 1]`,
  grabber) with the same content.
- **Tool and attachment sheets.** Keep. The tool sheet adds
  `sheetLargestUndimmedDetentIndex: 0`, so at half height the transcript behind it is
  still scrollable, the Messages pattern. Each gets a native header with the title and
  a `xmark` close button (`Stack.Toolbar placement="right"`), because iOS 26 sheets
  have no implicit close affordance besides the grabber.

### 16.4.4 Pickers and other sheets

Every picker becomes a form sheet route under `src/app/sheets/`, and the state it edits
moves into a small Zustand store (`src/compose/sheetStore.ts`) keyed by `draftKey`:

| Route | Detents | Content |
|---|---|---|
| `/sheets/model?draftKey=` | `[0.5, 1]`, initial 0 | The model's settings rows, then "Model" → the model list with `Stack.SearchBar placeholder="Search models"` and the provider strip |
| `/sheets/access?draftKey=` | `fitToContents` | The four access rows; Full access confirms with the existing alert (D16) |
| `/sheets/add?draftKey=` | `fitToContents` | Camera, Photo library, Plan mode, Draft |
| `/sheets/place?draftKey=` | `[0.6, 1]` | Machines, projects, "Open folder on a machine…" |
| `/sheets/workspace?draftKey=` | `fitToContents` | Current checkout, worktrees, New worktree |
| `/sheets/branch?draftKey=` | `[0.6, 1]` | Branches with `Stack.SearchBar` |
| `/m/[env]/s/[sessionId]/info` | `[0.6, 1]` | Session info (11 §11.15) |

- Each has `sheetGrabberVisible`, a native header with the sheet's title and an
  `xmark` close button. The custom uppercase "MODEL · Done" header goes away.
- Rows stay `SheetRow`, `SheetSwitch` and `SheetCaption` (MonoCode content).
- Selection haptic (`Haptics.selectionAsync()`) on every pick.
- `ui/sheet.tsx`'s `Sheet` (the RN `Modal`) is deleted once the last caller moves.
- **Fallback.** If route-based sheets prove awkward for the composer's per-instance
  state, `@expo/ui`'s SwiftUI `BottomSheet` (`fitToContents`) can host the same React
  children in place. Decide in spike S14.

### 16.4.5 Cards: context menus with preview, swipe actions

**Session cards** (Agents, Project) wrap in a `Link`:

```tsx
<Link href={{ pathname: "/m/[env]/s/[sessionId]", params }} asChild>
  <Link.Trigger>
    <SessionCard … />
  </Link.Trigger>
  <Link.Preview />
  <Link.Menu>
    <Link.MenuAction title="Pin" icon="pin" isOn={card.pinned} onPress={…} />
    <Link.MenuAction title="Rename" icon="pencil" onPress={…} />
    <Link.Menu title="Copy session ID" icon="doc.on.doc">
      <Link.MenuAction title="Harness session ID" onPress={…} />
      <Link.MenuAction title="MonoCode session ID" onPress={…} />
    </Link.Menu>
    <Link.MenuAction title="Mute notifications" icon="bell.slash" isOn={muted} onPress={…} />
    <Link.MenuAction title="Archive" icon="archivebox" onPress={…} />
    <Link.MenuAction title="Delete" icon="trash" destructive disabled={running} onPress={confirmDelete} />
  </Link.Menu>
</Link>
```

- `Link.Preview` with no children renders the destination route itself, which opens
  the session window (sync, native transcript) for the peek. Spike S15 measures that
  on the simulator with a 1,000-turn session. If it is too heavy, the preview gets
  explicit children: the card's title, the last assistant line and the status, in a
  fixed 320 × 200 pt MonoCode card.
- Items that need host methods the baseline lacks (Rename, Archive, Delete, Mute) are
  listed with `hidden` until their commands exist; the menu ships with Pin, Copy
  session ID and the hidden flags.
- **Swipe actions** through `ReanimatedSwipeable`: left reveals Archive (fill
  `status.danger` α .20, label `red-300`); right reveals Pin or Unpin and Mark seen
  (fill `sel.strong`). A light impact fires when the action threshold is crossed.
  FlashList recycling and the swipeable are validated in S15 too.
- **Project rows** get `Link.Menu` without a preview: Pin or Unpin (`isOn`), New
  session, Copy path. The long-press action sheet goes away.

### 16.4.6 Project screen, Explorer, Changes

- **Header.** Title view unchanged. Right side: `plus` and a filter
  `Stack.Toolbar.Menu icon="line.3.horizontal.decrease"` with the 11 §11.14 filter
  items as `isOn` actions in `inline` groups: Archived; Status (Working, Needs
  approval, Done); Time (All time, Today, Last 7 days, Last 30 days); Provider; Clear
  filters. The `ToggleChip` goes away. Only Archived is wired at the baseline; the
  rest are `hidden` until `sessions.page` takes those filters.
- **Search.** "Search conversations..." moves into the bar as `Stack.SearchBar` with
  `hideWhenScrolling`, shown only while the Sessions segment is active.
- **Segmented control.** Stays MonoCode's JS control (identity). Selection haptic
  added. A native `UISegmentedControl` in the title (through `@expo/ui` `Picker
  variant="segmented"` inside a `Host`) is a later option, not planned.
- **Explorer.** The segment shows the root listing. Tapping a folder pushes
  `/m/[env]/explorer?path=…` (the route exists) with the folder name as the title and
  the parent's name on the back button (`headerBackButtonDisplayMode: "default"`).
  Breadcrumbs go away; the back stack is the breadcrumb. "Go to File" becomes the
  bar's `Stack.SearchBar` on both the segment and the pushed screens. Pull to refresh
  stays (native `UIRefreshControl` through FlashList).
- **Changes.** Unchanged, except the per-row action sheet keeps `ActionSheetIOS`
  (stage, unstage, open) and the row gets a `Link.Menu` later if wanted. The commit
  chevron stays.

### 16.4.7 File and diff viewers

- The JS `Toolbar` under the header is replaced by `Stack.Toolbar` with the default
  bottom placement (a glass bar on iOS 26, a translucent toolbar before):
  - **File:** a `Stack.Toolbar.Menu icon="textformat"` with `isOn` items Wrap and
    Preview (Preview hidden for non-Markdown), a `Spacer`, then
    `Stack.Toolbar.Button icon="magnifyingglass"` that opens Find.
  - **Diff:** `chevron.left` Prev and `chevron.right` Next buttons, a `Spacer`, and
    the Wrap menu.
- **Find** becomes `Stack.SearchBar placeholder="Find in file" placement="inline"`;
  the "n of m" counter and the previous and next arrows become `Stack.Toolbar.Button`s
  that appear while the search bar is active. The custom find row goes away.
- **Share.** `square.and.arrow.up` at the right of the header shares the file text or
  the diff as text through `Share.share` (no new dependency).
- `ui/toolbar.tsx` keeps `HeaderTitle` and loses `Toolbar` and `ToolButton`.

### 16.4.8 Settings and machine details

- Large title "Settings", then MonoCode `Group` cards (11 §11.21) as a grouped list
  that pushes pages inside the Settings stack:
  - **App:** Machines, Appearance, Security, Privacy.
  - **Agents:** Chat, Notifications.
  - **About:** Version, Licences, Diagnostics, Demo.
- Each page: inline title, page heading (22/600) and description, `Group` cards,
  `Row`s, native `Switch`. The current single-screen cards become the Machines page.
- **Machine details** (`/settings/machines/[env]`): the 11 §11.21 groups. Remove keeps
  the native alert.
- Rows that open a choice (Lock after, App lock) use a `Stack.Toolbar.Menu` style
  pull-down on the row value, or a `fitToContents` form sheet when the list has
  descriptions.
- SwiftUI `Form` or inset-grouped `List` from `@expo/ui` is not used: it would replace
  MonoCode's `Group` card with Apple's, which 11 §11.1 rule 2 forbids.

### 16.4.9 Pairing and onboarding

- The modal and the stage machine stay. Each stage sets its own `Stack.Screen`
  title ("Pair a computer", "Scan code", "Connect to {host}?", "Connecting…",
  "Confirm", "Paired") and a Cancel `Stack.Toolbar.Button variant="plain"` at left.
- The scanner stage sets `Stack.Header transparent` so the camera fills the sheet.
- The "✓" text becomes `SymbolView name="checkmark.circle.fill"` with
  `animationSpec={{ effect: { type: "bounce" } }}`, tinted `status.done`, next to the
  existing success haptic. The "Connecting…" ghost button becomes a `ProgressView`-like
  `ActivityIndicator` row with the copy from 11 §11.11.
- The Welcome empty state on Agents is unchanged.

### 16.4.10 Floating surfaces: approval banner, toast

- **Approval banner.** The card becomes a `Surface` (glass on iOS 26, blur 24 before)
  with the dashed α .20 border and `shadow-xl`. The pan gesture moves to
  `react-native-gesture-handler` `Gesture.Pan()` with Reanimated shared values, so the
  drag and the spring-back run on the UI thread. Entrance stays translateY −8, scale
  .98, 180 ms `ease.pop`; under Reduce Motion it is a 120 ms fade (M9).
- **Toast.** The pill becomes a `Surface` with blur 12. Nothing else changes.

### 16.4.11 Materials, motion, accessibility, haptics

- **`Surface`** (`src/ui/Surface.tsx`): props `kind: "composer" | "banner" | "pill" |
  "button"`, `interactive`. It picks the material from `useMaterial()`:
  `"glass"` when `isLiquidGlassAvailable()` and Reduce Transparency is off;
  `"blur"` on iOS before 26 with Reduce Transparency off; `"opaque"` otherwise and on
  Android. Blur intensities and fills come from 11 §11.4. The component owns the
  radius, border and shadow so callers never stack their own backgrounds on glass.
- **`useMaterial()` and `useReducedMotion()`** read `AccessibilityInfo`
  (`isReduceTransparencyEnabled`, `isReduceMotionEnabled`) once and subscribe to
  their change events; Reanimated's `useReducedMotion` is used for worklets.
- **Dynamic Type.** `useTokens()` gains `t.type`, the `TYPE` table scaled by
  `Math.min(useWindowDimensions().fontScale, 1.6)`. `sessionCardHeight`, the Projects
  row heights and the Explorer and Changes row heights take `t.type` instead of
  `TYPE`; the transcript gets `transcriptTheme(t, scale)` with the same factor.
- **Motion.** Everything new animates with Reanimated on the UI thread using the
  `MOTION` tokens; no `Animated` or `PanResponder` remains after N4.
- **Haptics map** (`src/ui/haptics.ts`): selection on segmented and picker changes;
  light impact on chip toggles and swipe thresholds; medium impact on Allow, Deny and
  Build (exists); success on paired and on commit; warning on a failed send, failed
  commit or pairing failure. Nothing on scroll or streaming.

### 16.4.12 Icons

- All chrome icons are SF Symbol names typed through `expo-symbols`'s `SFSymbol`
  (M12). The `Icon` component stays the one in-content wrapper.
- Harness marks (Claude, Codex, …) are drawn as `xcasset` template images when they
  appear in native chrome (a menu or toolbar), and as SVG elsewhere.
- Hugeicons is removed from 12 §12.1 for iOS. Android can still choose it later.

## 16.5 Work plan

Seven slices, each small enough for one orchestration card, in dependency order.
Every slice ends with `tsc`, `expo lint`, the app's vitest suites, and a run on the
iPhone 17 simulator (iOS 26) plus the iPhone 13 (iOS 18.7) for the pre-26 tier.
Workers never run the simulator themselves; the owner does.

| Slice | Scope | Touches | New native deps | Size |
|---|---|---|---|---|
| **N1 Native headers and tab bar** | Route groups and per-tab stacks (§16.4.2); large titles; `plus` toolbar buttons; `Stack.SearchBar` on Projects; list insets; `minimizeBehavior`; the iOS 26 bottom accessory; `sidebarAdaptable`; delete `Title` | `src/app/(tabs)/**`, `src/app/_layout.tsx`, `ui/components.tsx`, `pair.tsx` (`dismissTo("/")` unchanged) | None | M |
| **N2 Sheets and menus** | Form sheet routes and `sheetStore` for every picker (§16.4.4); native sheet headers; the full session ⋯ menu; the Project filter menu; project row `Link.Menu`; Projects search in the bar; delete `ui/sheet.tsx`'s `Sheet` | `src/app/sheets/*`, `compose/*`, `new.tsx`, `(projects)/projects.tsx`, `m/[env]/p/[projectId].tsx`, `m/[env]/s/[sessionId].tsx` | None | L |
| **N3 Cards** | `Link.Preview` + `Link.Menu` on session cards; `ReanimatedSwipeable` actions; haptics map | `ui/SessionCard.tsx`, both card lists, `ui/haptics.ts` | None | M |
| **N4 Materials and floating surfaces** | `Surface`, `useMaterial`, `useReducedMotion`; composer glass; approval banner and toast on gesture-handler + Reanimated; jump to latest; pre-26 bar blur; Reduce Transparency fallbacks | `ui/Surface.tsx`, `ui/material.ts`, `compose/Composer.tsx`, `ui/ApprovalBanner.tsx`, `ui/toast.tsx`, session screen | None | M |
| **N5 Keyboard** | `react-native-keyboard-controller`; sticky composer; Swift keyboard inset in `MonoTranscriptView`; `headerTransparent` + `topInset` on iOS 26; remove `KeyboardAvoidingView` offsets | `_layout.tsx` (provider), session and new screens, `modules/transcript/ios/MonoTranscriptView.swift` | **Yes**, new dev build | M |
| **N6 Viewers and Explorer** | Bottom toolbars; Find as a search bar; Share; pushed folders; "Go to File" in the bar; delete `Toolbar` | `m/[env]/file.tsx`, `m/[env]/diff.tsx`, `m/[env]/explorer.tsx`, `workspace/ExplorerPane.tsx`, `ui/toolbar.tsx` | None | M |
| **N7 Settings, pairing, Dynamic Type** | Settings pages and Machine details; pairing titles and symbol effect; `t.type` scaling through the row-height functions and the transcript | `(settings)/**`, `pair.tsx`, `ui/theme.ts`, `ui/SessionCard.tsx`, list rows | None | M |

Acceptance, per slice:

- **N1.** Agents, Projects and Settings show native large titles that collapse on
  scroll; the lists scroll under the title and the tab bar; the Projects search bar
  hides on scroll and filters; the tab bar minimises on scroll down on the iOS 26
  simulator and shows "＋ New session · N working"; tapping a tab again scrolls to the
  top; `/`, `/projects`, `/settings` and every deep link still resolve; the iPhone 13
  shows classic translucent bars.
- **N2.** Every picker opens as a native sheet with the stated detents and a grabber;
  swiping down dismisses; the Access and Add sheets fit their contents; the session
  ⋯ menu shows Delete in red and the submenu; no RN `Modal` remains in `src/`.
- **N3.** Long-pressing a session card shows a preview and the menu; releasing on the
  preview opens the session; swiping reveals the actions with the threshold haptic;
  FlashList recycling leaves no stale swipe state after a scroll.
- **N4.** On the iOS 26 simulator the composer, banner, toast and jump button are
  glass with content legible through them; on the iPhone 13 they are blur; with
  Reduce Transparency on they are opaque; no `Animated` or `PanResponder` import
  remains.
- **N5.** Opening the keyboard moves the composer and the transcript together without
  a jump; dragging the transcript down dismisses the keyboard with the composer
  following the finger; the transcript's last row is never hidden under the composer;
  the S11 benchmark numbers are unchanged.
- **N6.** The file and diff toolbars are native bottom bars; Find uses the bar's
  search field with a working counter; folders push with the parent name on the back
  button; the back swipe walks up the tree.
- **N7.** Settings pushes pages; Machine details shows the 11 §11.21 groups; the
  pairing modal shows a title per stage and a bouncing check on success; at the
  largest accessibility text size cards grow instead of truncating.

## 16.6 Spikes and risks

| # | Question | How to answer it | If it fails |
|---|---|---|---|
| S14 | Can the composer's per-instance state live in a store cleanly enough for route-based sheets, or is `@expo/ui` `BottomSheet` the better host? | Build the Access sheet both ways in N2's first day | Use `BottomSheet` for composer pickers, routes for the rest |
| S15 | `Link.Preview` rendering the session route: memory and open time with a 1,000-turn session; `ReanimatedSwipeable` inside FlashList recycling | Simulator run with the transcript lab fixture, `Documents/benchmarks/latest.json` unchanged | Preview with explicit light children; swipeable keyed by row id with state reset on recycle |
| S16 | `react-native-keyboard-controller` with Expo Router form sheets and the native transcript's own inset animation: no double offset, no fight during interactive dismissal | N5 on both tiers | Keep `KeyboardAvoidingView` with `useHeaderHeight()` for the offset and accept no interactive follow |
| S17 | The bottom accessory's glass capsule is provided by UIKit, and `usePlacement()` flips to `inline` when minimised | N1 on the iOS 26 simulator | Render the accessory in a `GlassView` of its own |

Other risks:

- **Experimental APIs.** `Stack.Toolbar` is marked experimental; `NativeTabs` is
  imported from `unstable-native-tabs`; `Link.Preview` is new. Pin `expo-router` at
  `57.0.24` and wrap each in one adapter (`ui/chrome/*`) so churn stays in one place.
- **Glass legibility over the dark base.** `GlassView` over `#171717` content can
  read as muddy. Test `colorScheme="dark"` and the `regular` versus `clear` styles on
  real screenshots before N4 lands; keep the opaque fallback one flag away.
- **No iOS 26 device.** The iPhone 13 cannot show Liquid Glass, so every glass
  decision is validated on the simulator only until a 26+ device exists. Record it in
  13 §13.2's QA matrix.
- **Route restructure.** N1 moves files; typed routes regenerate. Deep links and
  `router.dismissTo("/")` must be rechecked, and the demo host's pushes too.
- **Spec drift.** Each slice updates the documents in §16.7 in the same change.

## 16.7 Spec changes to make as slices land

- [11 §11.1](11-design-and-ux.md#111-design-parity-rules): add M12 to M16 to the
  deviations table; amend the "Context menus → action sheets" row.
- [11 §11.7](11-design-and-ux.md#117-iconography-brand-and-mascots): SF Symbols on iOS.
- [11 §11.10](11-design-and-ux.md#1110-navigation): route groups per tab; pushes
  cover the tab bar; sheet routes under `/sheets/*`.
- [11 §11.14](11-design-and-ux.md#1114-project-screen-and-session-list) and
  [§11.20](11-design-and-ux.md#1120-explorer-and-changes): filter menu, pushed
  folders, bar search.
- [12 §12.1](12-mobile-engineering.md#121-stack): keyboard-controller added; Hugeicons
  and the "maintained library or Expo UI" line resolved to Expo Router menus.
- [14 §14.1](14-roadmap.md#141-milestones): N1 to N7 as M7's content; S14 to S17 in
  [§14.2](14-roadmap.md#142-m0-spikes); the "As built" table after each slice.
- [15 §15.2](15-performance.md#152-architecture-by-surface): no change in intent;
  note the Swift keyboard inset binding as built.

## 16.8 Decisions for the owner

1. **M12, SF Symbols** instead of Hugeicons on iOS. Recommended: yes.
2. **M16, pushed screens cover the tab bar** for now. Recommended: yes; revisit
   shared route groups after N7 if the Project screen wants the tab bar.
3. **Session card preview** (`Link.Preview` of the real session). Recommended: yes if
   S15 passes; otherwise a light custom preview.
4. **Route-based sheets** versus `@expo/ui` `BottomSheet` for the composer pickers.
   Recommended: routes, decided by S14.
5. **Add `react-native-keyboard-controller`** (a native dependency, so a new dev
   build). Recommended: yes; it is already in 12 §12.1.
6. **Settings stays on MonoCode `Group` cards**, not SwiftUI `Form`. Recommended: yes.
