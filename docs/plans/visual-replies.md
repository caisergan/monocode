# Visual replies: agent-built pages inline in the transcript

Branch `feat/visual-replies`, worktree `.worktrees/visual-replies`, cut from `origin/dev` at `82d400e`.
Rev 2, written 2026-10-09. Decisions agreed with the owner 2026-10-09. Status: spec only, nothing
implemented.

This document is written for the agent that implements the feature. It sets the design, the order of
work and the tests. The **Blueprints** section has code to start from: most of it is ported from T3 Code
and adapted to MonoCode's structure. Treat blueprints as a strong starting point, not as finished code:
compile, test and fix them against the real files. When a blueprint and the code disagree, the code
wins and this document gets corrected under "As built".

## Goal

An agent can answer with a page instead of only text: a chart, a benchmark table, a diagram, an image
collage, or a **UI mock of a mobile or web design**. It writes one self-contained HTML file and publishes
it. MonoCode shows the page inline in the transcript, where the agent published it (normally just above
its final prose), on the transcript's own background and in the user's theme. The page should read as
part of the reply, not as a box embedded in it.

What a user can do once Phase 1 ships:

- Ask any session "show the results as a chart" and get a live chart in the reply.
- Ask "mock three treatments of the settings screen for iOS and the web version" and get real-size
  phone and browser mocks side by side, scaled to fit the transcript, each with a caption.
- Expand a page to a full-window viewer and switch it between phone, tablet and desktop widths, to check
  a responsive web design. Copy its source or save it as an `.html` file.
- Switch light/dark or change the theme hue and see open pages follow without reloading.
- Reopen the session days later and still see the page, even if the files it showed have moved.

Mobile has two meanings here, and both are in scope:

1. **Mocks of mobile designs** (iOS, Android, tablet screens) rendered on the desktop. Phase 1.
2. **Reading visuals in MonoCode's own iOS app** (`feat/ios-native-design`). Phase 3. Phase 1 already
   prepares for it: the page bootstrap also talks to a native WebKit bridge, and the iOS app decodes
   unknown block roles safely, so a `visual` block does not break it in the meantime.

## Reference: how T3 Code does it

T3 Code shipped this as "Visual replies". Upstream: `pingdotgg/t3code`, user doc
`docs/user/html-renders.md`. A clone used for this spec is at `/tmp/t3research/t3code` (commit
`a4c9494b`); re-clone if it is gone.

| Piece | T3 Code | File in T3 |
|---|---|---|
| Agent interface | Two MCP tools on T3's own MCP server, given to every provider: `html_preview` and `html_render` | `apps/server/src/mcp/toolkits/html/tools.ts` |
| Self-check | `html_preview` loads the page in a headless Chrome that T3 downloads itself (about 120 MB). It returns a PNG, `contentHeight`, and console output | `apps/server/src/htmlRender/headlessChrome.ts` |
| Publish | `html_render({html, title, height})` injects a bootstrap into `<head>`, inlines local images as data URIs, stores the page as a thread attachment, and measures its height at 9 widths | `apps/server/src/htmlRender/HtmlRender.ts` |
| Theme | About 35 CSS variables. They arrive in the URL fragment before first paint, and later changes arrive by `postMessage` | `packages/shared/src/htmlRender.ts` |
| Bridge | JSON-RPC over `postMessage` in the MCP Apps format: `size-changed`, `open-link`, `host-context-changed` | same file |
| Client | `<iframe sandbox="allow-scripts allow-forms" loading="lazy">`, never `allow-same-origin`. The server also sends a CSP `sandbox` header | `apps/web/src/components/files/BrowserDocumentFrame.tsx`, `apps/web/src/components/chat/HtmlRenderFrame.tsx` |
| Mobile client | A React Native WebView with the same bootstrap. Theme changes are injected with `window.postMessage` | `apps/mobile/src/features/threads/HtmlRenderWebView.tsx` |
| Prompting | One line in the system prompt, plus a layout guide in the tool description: no page background, fluid width, fixed chart heights, no `100vh`. The tool result says "don't restate the page" | `apps/server/src/provider/T3OrchestrationInstructions.ts`, `HTML_RENDER_LAYOUT_GUIDE` |

Two things in T3 matter more than they look:

- **The layout guide** is why T3 pages look like part of the reply. We port it nearly word for word
  (see the guide in Blueprint B13).
- **The preview loop** (screenshot, read console, fix, publish) is why the pages come out right. We ship
  without it first and add it in Phase 2. Until then agents can check pages with their own tools.

T3 has no special support for device mocks. The mobile mocks in Theo's posts are plain HTML the model
drew. We add a small mock kit (Blueprint B5) so that phone and browser mocks look consistent and fit any
reader width.

## What exists today

Paths and line numbers are from this branch at `82d400e`.

### Agent → app channel (our equivalent of T3's MCP server)

- **The CLI.** The agent runs `<monocode exe> app ACTION --json … | --input FILE|-`. The help text is
  in `src-tauri/src/control_cli.rs`: usage at `:154`, artifact actions at `:276`, the action whitelist
  `APP_ACTIONS: [&str; 36]` at `:114` (checked at `:541`).
- **Size cap.** CLI input is capped at 256 KiB (`read_capped`, `control_cli.rs:513`), and so is each
  request on the control socket (`control.rs:224`). A page with inlined images cannot go through
  `--json`, so **the page travels by file path**.
- **Request flow.** `serve` (`control.rs:217`) checks the token with
  `request_grant(host, namespace, token)` (`control.rs:162`). That function **does not see the
  action**. The request then goes to the window as a `monocode-control-request` event. `App.tsx:10965`
  handles it:
  - It rejects inbox-ask sessions, orchestration workers and leads (`App.tsx:10977`).
  - It deduplicates by request id (`appReceipts`).
  - It calls `handleAgentApp` (`agentApp.ts:1081`). Every action has a field whitelist at `:225–:265`.
- **Access.**
  - Every session gets an app token at turn start (`prepare_app_grant`, `control.rs:45`), except
    orchestration leads (they hold a control grant) and workers. Those two never get an app token.
  - The token only passes while the turn is active, and only when `app_allowed` is set
    (`control.rs:175`).
  - `app_allowed` is set for `/operator` threads and Monos (`App.tsx:7154`, `control.rs:431`).
  - The env vars are set on the provider process in `configure_child` (`control.rs:464`, called from
    `harness.rs:872`).
- **Advertising.**
  - The CLI is advertised by appending a `<monocode_app>` block to the text sent to the harness on
    `/operator` turns. It includes the exe path from `app_cli_path` (`App.tsx:8188`).
  - Monos get `<artifact_rules>` from `monoFiles.ts:342`.
  - There is **no system-prompt channel**: adapters only take the message text.

### Artifacts (closest feature, but a different lifetime)

- `artifacts.write` saves a Markdown "document" to a shared library (`src-tauri/src/artifacts.rs`,
  `src/features/artifacts/`). Only Monos and habit runs can use it (`agentApp.ts:980`).
- The card is recorded on the turn's **user** block as `artifactCards` (`App.tsx:11377`,
  `session.ts:376`). It renders only after the turn settles (`AgentTranscript.tsx:1368`).
- `ArtifactPanel` is mounted only for the Mono view (`App.tsx:13389`). The floating Mono chat has its own
  `ArtifactSheet` (`FloatingMonoChat.tsx:510`). **Ordinary sessions have no artifact panel.**

### Generated images: the precedent to copy

Generated images are exactly the shape visuals need:

- A provider event `image.generated` (`core/types.ts:36`) is applied by `applyHarnessEvent`
  (`core/apply.ts:65`). `appendImage` adds a `role: "image"` block **at the current end of the stream**
  (`apply.ts:776`). The block therefore sits right where the work happened.
- `isActivityBlock` (`transcriptActivity.ts:148`) returns false for `image`, so the block is its own
  transcript item rather than part of a foldable work group.
- `sanitizeBlock` (`sessionStore.ts:948`) **copies only known fields**, and has an explicit `image`
  branch (`:960`). A new field that is not added there is dropped on save.
- Rust `session_delete` (`session_store.rs:540`) deletes image files after it deletes the session
  record.
- Events for a session can be injected from anywhere with `harnessEvents.enqueue(sessionId, event)`
  (`App.tsx:1612`, `:1723`). The queue applies them with `applyHarnessEvents` in arrival order, after the
  turn's own `tool.started` event.

### Sandboxed HTML serving (already solved once)

- `monocode-preview://` serves local HTML to the in-app browser (`src-tauri/src/browser_preview.rs`,
  registered at `lib.rs:236`):
  - Every response carries a CSP `sandbox` without `allow-same-origin`. The page gets an opaque origin,
    and the IPC handler rejects `Origin: null`.
  - Requests with a non-null `Origin` are refused (`cross_origin`, `browser_preview.rs:117`).
- **Windows webviews reach custom schemes as `http://<scheme>.localhost`.** `browserPreviewUrl`
  (`src/platform/tauri/browserPreview.ts:17`) builds both forms.
- The app CSP allows frames from `monocode-preview: monocode-remote: http: https:`
  (`tauri.conf.json:31–32`). It has `script-src 'self'`, which rules out `<iframe srcdoc>`: a srcdoc
  document inherits the parent's CSP and its inline scripts would be blocked. **Pages must be served
  from their own scheme with their own CSP.**

### Transcript

- `AgentTranscript.tsx` groups each turn into items (`groupTurnItems`, `transcriptActivity.ts:473`):
  - Work and status rows become foldable `activity` items.
  - Every other block is its own item.
  - `foldableWork` (`:1116`) folds work plus prose commentary and stops at any other item: "A plan, a task
    list or a call waiting on approval stays where the agent put it."
- The transcript column is `max-w-4xl` (896px, `AgentTranscript.tsx:1468`) with `px-4` per turn row, so
  the reply column is about **864px** wide. It is narrower in split panes and in the floating Mono chat.
- Off-screen turns already use `content-visibility` placeholders, and `useTurnScrollAnchor`
  (`AgentTranscript.tsx:2814`) keeps the reader's place when turns above them change height.
- `monocodeToolCall.ts` gives app CLI calls readable labels.
- `AgentMarkdown` renders mermaid. That stays; visuals are for everything mermaid cannot do.

### Theme

- Tokens live in `src/styles/index.css`:
  - `--color-background-base`, `--color-content`, `--color-accent`, `--color-stroke`
  - `--color-diff-add`, `--color-diff-del`
  - `--font-sans`, `--font-mono`
- The colors are computed from `--theme-hue`, `--theme-saturation` and lightness variables, which
  `appearance.ts` sets as inline styles on `<html>` (`:298`). Light mode is the `html.theme-light`
  class (`appearance.ts:365`), which also fires `SCHEME_CHANGE_EVENT`.
- Many tokens are `color-mix()` expressions over the app's own variables, so a frame cannot use them as
  they are. They must be resolved to concrete colors first.
- Chats can have background images or vibrancy (`chat_background.rs`). A page must stay transparent.

### Mobile app

- On `feat/ios-native-design`, `BlockRole` is an open enum (`MonoWire/Open.swift:37`), so an unknown
  `"visual"` role decodes safely as "not known".
- The iOS app does not render generated images yet either. It has no WebKit view.

## Decisions

All decisions are agreed (2026-10-09). The owner chose the recommended option for rows 2, 3 and 6.
Each of those rows still notes what would change if it were reversed later.

| # | Decision |
|---|----------|
| 1 | **A separate `visuals.*` namespace, not an `html` artifact kind.** Artifacts are a global library (listed, read, revised across sessions, Mono-only). Visuals belong to one transcript and share its lifetime. "Save as artifact" can bridge the two later (Phase 3). |
| 2 | **Every ordinary session and every Mono can publish** (agreed). This means a new exception in `request_grant` for exactly `visuals.render` and `visuals.preview` during the caller's own active turn. Orchestration leads and workers have no app token, so they are out in v1 (Phase 3). Habit runs are not persisted, so they get a clear error in v1. *If reversed to operator-only:* drop the `request_grant` exception and the per-session guidance block. |
| 3 | **Pages live per session** (agreed) in `<app data>/visuals/<sessionId>/`, are kept on archive, and are deleted by `session_delete`. *If reversed to a library:* store under `visuals/_library/`, and skip the delete hook. |
| 4 | **The agent passes the page as a file path.** `visuals.render {"path":"/abs/page.html","title":"…"}`. Rust reads the file and stores a copy. This avoids the 256 KiB cap and keeps the HTML out of the visible tool call. |
| 5 | **A new `monocode-visual://` scheme** (on Windows, `http://monocode-visual.localhost`), modeled on `browser_preview.rs`. The CSP is `sandbox allow-scripts allow-forms` and the iframe sandbox is `allow-scripts allow-forms`. `allow-forms` stays on purpose: without it, a form's `submit` event never fires, so filter UIs break. `form-action 'none'` stops real submissions. No popups, modals or top navigation. |
| 6 | **Network policy** (agreed). Pages may load scripts, styles, fonts and images over `https:` (CDN chart libraries, web fonts). They get `connect-src 'none'`, so no `fetch`, XHR or WebSocket, plus `Referrer-Policy: no-referrer`, so CDNs never see session ids. Residual risk: a page can still leak data through an image URL. We accept that, as T3 does. *If reversed to offline-only:* drop `https:` from the CSP. |
| 7 | **A visual is a transcript block** (`role: "visual"`), appended through `harnessEvents.enqueue` exactly like a generated image. It lands right after the `visuals.render` tool call and before the prose that follows. It shows while the turn is still live. Rev 1 tried to place visuals by timestamp; that is impossible because blocks have no timestamps. |
| 8 | **The bootstrap is injected when the page is served, not stored with it.** Publish records where it goes, in a sidecar `<id>.json`. Old pages therefore pick up later fixes to the bootstrap, the theme bridge and the mock kit. |
| 9 | **Links never navigate the frame.** The bootstrap asks the host to open `http(s)` links. The host opens one with `openUrl` only while the frame has focus and the user has just interacted (T3's rule). |
| 10 | **The agent guidance is short and the details are on demand.** A ~90-token `<monocode_visuals>` block goes with the first turn of each provider conversation. The full guide (layout, theme variables, mock kit) is printed by `app visuals.guide`, which the CLI answers locally. |
| 11 | **The self-check (`visuals.preview`) is Phase 2.** It uses a hidden app window with the platform's own WebKit snapshot, rather than downloading Chrome. |
| 12 | **The mock kit ships in Phase 1.** It provides device frames (iPhone, Android, iPad, browser) and a "stage" that scales a row of mocks to the reader's width. The expanded viewer has phone, tablet and desktop width presets. This is the "mobile and web designs" requirement. |
| 13 | **A Settings toggle ships in the MVP** (agreed 2026-10-09). Settings → Chat → "Visual replies", on by default. When it is off, agents are not told about visuals and `visuals.render` answers that the feature is turned off, so the agent replies in text. Pages already in conversations stay visible: they are part of the transcript. See B15. |

## Architecture

```
agent shell ──> monocode app visuals.render {"path","title"} ──TCP──> control.rs serve()
                                                                 request_grant(app, "visuals.render")
                                                                 ↓ event "monocode-control-request"
App.tsx listener ──> handleAgentApp ──> handleVisuals (agentApp.ts)
                                         ├─ invoke("visuals_publish") ──> visual_pages.rs:
                                         │      read file, inline images, find bootstrap spot,
                                         │      write visuals/<session>/<id>.html + <id>.json
                                         └─ host.publishVisual → harnessEvents.enqueue(
                                                {type:"visual.published", visual})
                                                ↓ applyHarnessEvent → role:"visual" block
AgentTranscript → TranscriptBlock → <VisualFrame> → <iframe src="monocode-visual://localhost/<session>/<id>.html?v=<rev>#mc-theme=…">
                                                ↓ scheme handler (visual_pages.rs) adds the bootstrap
page bootstrap ⇄ host via postMessage: mc-visual:size / open-link / error  ←  mc-visual:theme / fit
```

## Design

### Agent interface

```
app visuals.guide
  → prints the full guide (B13). Answered by the CLI itself; no app connection needed.

app visuals.render {"path":"/abs/out/bench.html","title":"Typecheck benchmarks"}
  optional: "height": 80–2000   initial box before the page reports its size (default 360)
            "maxHeight": 80–2000  cap; taller content scrolls inside the frame (for long tables)
  → {"id":"vis-<requestId>","title":"…",
     "message":"Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say."}

app visuals.render {"id":"vis-…","path":"/abs/out/bench.html"}
  → replaces that page in this session, wherever it is in the transcript; title optional

app visuals.preview {"path":"/abs/out/bench.html","width":390,"appearance":"light"}     (Phase 2)
  → {"png":"/tmp/…/preview-1.png","contentHeight":612,"console":[{"level":"error","text":"…"}],
     "missingImages":[]}
```

Rules enforced by Rust:

- `path` must be absolute, end in `.html` or `.htm`, be UTF-8, and be at most 2 MiB.
- **Local images are inlined.** A quoted string, or an unquoted CSS `url(…)`, that is exactly an image
  path gets inlined. The path can be absolute (`/x.png`, `C:\x.png`) or explicitly relative to the HTML
  file (`./x.png`, `../x.png`).
  - The file bytes must really be an image. This is T3's magic-byte check, so a renamed or symlinked
    secret is never inlined.
  - Limits: 10 MiB per image, 25 MiB per page after inlining.
  - Missing or non-image files fail the publish with their paths listed.
- `title` is 1–200 characters after trimming.
- The id is `vis-<requestId>`. The CLI generates request ids, and App-level `appReceipts` already makes
  a retry with the same id return the same result. A publish with an existing id updates the block in
  place.

### Access

- `request_grant(host, namespace, action, token)` gains the `action` argument. For `app`, it allows
  exactly `TURN_SCOPED_APP_ACTIONS` (`visuals.render`, `visuals.preview`) when the caller's turn is
  active in its window, even without `app_allowed`. Everything else keeps today's rule. See B1.
- `visuals.guide` never reaches the socket.
- `handleVisuals` refuses four cases with clear messages:
  - the Settings toggle is off: "Visual replies are turned off in MonoCode settings. Answer in text."
  - habit runs: "not available in habit runs yet"
  - remote sessions, where `cwd` starts with `remote://`: "not available in remote sessions yet"
  - any session the App-level gate already refuses (inbox asks, workers, leads)

### Storage and serving

- Files: `<app data>/visuals/<sessionId>/<visualId>.html` holds the page with images inlined, without
  the bootstrap. `<visualId>.json` is `PageMeta`, which includes where the bootstrap goes.
- Writes are atomic (temp file then rename). The HTML is written before the meta, so a crash leaves at
  worst an unreferenced HTML file inside the session folder, which goes away with the session.
- `session_delete` calls `visual_pages::delete_session_pages(&app, &session_id)` after deleting the
  record, next to the image cleanup. There is no fork or duplicate in MonoCode (verified), so nothing
  else copies pages.
- Blocks dropped by edit-and-resend, retry or checkpoint revert leave their files in the session folder
  until the session is deleted. That is cheap, and it keeps undo safe.
- **Serving** (`monocode-visual` scheme):
  - The URL is `/<sessionId>/<visualId>.html?v=<revision>`. The query is ignored; it only busts the
    frame when a page is replaced.
  - The handler refuses a non-null `Origin` with 403 (same rule as `browser_preview`), validates both
    ids, and assembles page + bootstrap.
  - Headers: `text/html; charset=utf-8`, the CSP from Decision 6, `Cache-Control: no-store`,
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
  - A missing page is served as a small themed page that says "This page is no longer available".
    That way the frame still sizes itself, and no error event is needed (iframes don't fire `error` for
    a 404).
- **CSP of the app:** add `monocode-visual:` to `frame-src` in both `csp` and `devCsp`. `http:` already
  covers the Windows form.

### The bootstrap and the bridge

The bootstrap is three assets compiled into the binary with `include_str!`. They live in
`src-tauri/src/visual_pages/` and are inserted at the recorded offset, in this order:

1. `<meta charset>` and `<meta name="viewport">`, if the page has none.
2. `<style id="mc-visual-theme">`: the default theme (dark, with a `prefers-color-scheme: light` block).
   The script rewrites it when the theme arrives.
3. `<style id="mc-visual-base">`: the base stylesheet and the mock kit. It is never rewritten.
4. `<script>`: the bridge.

The bridge protocol is our own small dialect, kept compatible in spirit with MCP Apps so a second
dialect can be added for real MCP Apps in Phase 3:

| Direction | Message | Meaning |
|---|---|---|
| host → page | URL fragment `#mc-theme=<json>` | theme before first paint; the script strips the fragment |
| host → page | `{type:"mc-visual:theme", theme}` | live theme change; also re-sent on `load` to cover a change during loading |
| host → page | `{type:"mc-visual:fit", enabled}` | viewer's "fit mocks to width" toggle |
| page → host | `{type:"mc-visual:size", height}` | content height, measured as T3 measures it |
| page → host | `{type:"mc-visual:open-link", url}` | the reader clicked an `http(s)` link |
| page → host | `{type:"mc-visual:error", text}` | first uncaught error or `console.error`; the frame shows a small "Page error" pill |
| page → host | `{type:"mc-visual:console", level, text}` | only with `#mc-probe=1` (Phase 2 preview) |

Delivery: from a frame, `window.parent.postMessage(message, "*")`. When
`window.webkit.messageHandlers.mcVisual` exists (the future iOS WKWebView), messages go there instead,
so the same bootstrap works on iOS.

The host ignores messages whose `event.source` is not its own frame's `contentWindow`. The frame's origin
is opaque, so the check is on `source`, not `origin`.

### Theme variables

`useVisualTheme()` (B7) resolves the variables from the app's computed styles. It keeps a module-level
snapshot that is recomputed when `<html>`'s `class` or `style` attribute changes (MutationObserver) or
when `SCHEME_CHANGE_EVENT` fires.

| Variable | Source |
|---|---|
| `--background` | `--color-background-base` (for mocks that must paint; pages leave html/body transparent) |
| `--foreground` | `--color-content` |
| `--muted-foreground` | content at 55% |
| `--card` | content at 5% |
| `--border` | `--color-stroke` |
| `--accent`, `--accent-foreground` | `--color-accent`, and black or white by luminance |
| `--success`, `--destructive` | `--color-diff-add`, `--color-diff-del` |
| `--warning` | fixed `#f59e0b` dark / `#d97706` light |
| `--code-background` | content at 6% |
| `--chart-1` … `--chart-6` | accent first, then T3's fixed categorical set for the appearance |
| `--font-sans`, `--font-mono` | the app's font stacks |
| `--radius` | `10px` |

### Transcript block and placement

- `Block` gains `visual?: VisualMeta`, and `BlockRole` gains `"visual"`.
  `VisualMeta = { id, sessionId, title, height, maxHeight?, revision, heights? }`.
- A new `HarnessEvent` `{type:"visual.published"; visual}` is applied by `upsertVisual` (B8). If a block
  with that visual id exists, it replaces the meta and bumps `revision`. Otherwise it appends a block,
  the same way `appendImage` does.
- **Placement falls out of event order.** The provider emits `tool.started` for the shell call before
  running it, and the CLI request arrives during the call. So the `visual.published` event lands after
  the tool block and before the agent's next prose.
- **Folding.** `isActivityBlock` is false for `visual`, so the block is its own item, and `foldableWork`
  stops at it. If the agent publishes last (the guidance says so), the work above folds and the visual
  sits between the fold line and the final prose, as in T3's screenshot. If it publishes mid-turn, work
  before the visual stays unfolded. That is acceptable for v1; a test pins it.
- **Every site that special-cases `role === "image"` needs a decision for `visual`:**

  | Site | What to do for `visual` |
  |---|---|
  | `session.ts:46` (BlockRole) | add the role |
  | `apply.ts:65` | add the event |
  | `sessionStore.ts:960` | sanitize the meta; drop the block if it is invalid |
  | `AgentTranscript.tsx:2065` | render `VisualFrame` |
  | `AgentTranscript.tsx:3138` | inline render inside an activity segment: not needed, but check that the block never ends up there |
  | `transcriptFind.ts:28` | include the title |
  | `appSearch.ts:459` | index the title |
  | `btw.ts:311` | give side conversations `[Visual: <title>]` |
  | Copy turn (`AgentTranscript.copy.test.ts`) | `[Visual: <title>]` |
  | `sessionRemoval.ts:156` and `App.tsx:4713`, `:4839` | no change; Rust deletes the folder |
  | `host/engine.ts` | no change; it shares `applyHarnessEvent` |
  | iOS `BlockRoleTag.known` | no change until Phase 3 |

### Frame and viewer

**`VisualFrame`** (B10) is a port of T3's `HtmlRenderFrame` plus `HtmlRenderDocument`:

- It reserves `height` before load, then fits the reported content height. It uses `maxHeight` as a cap
  when given, clamped to 80–2000, and observes its own width.
- `loading="lazy"`. The transcript's `content-visibility` placeholders and `useTurnScrollAnchor` already
  handle off-screen turns and turns above the reader changing size. **Do not add custom unmounting**: it
  would also throw away the state of interactive pages.
- To avoid a white flash, the iframe gets `color-scheme: light` until it loads, then the page's
  appearance. This is T3's fix: a frame whose color scheme differs from its document's paints an opaque
  canvas.
- **Runaway guard.** A page using `100vh` can grow with its frame. After 8 increases within one second,
  the frame stops growing until the page reports a smaller height.
- Hover toolbar at the top right: **Expand**, **Copy source** (disabled over 1 MiB, with a tooltip),
  **Save as…**.
- Remount with `key={id + ":" + revision}` so a replaced page reloads.

**`VisualViewer`** (B11) is a full-window overlay, rendered through `createPortal` to `document.body`. It
works in the main window and in the floating Mono chat window alike, following the pattern of
`ArtifactSheet` in `FloatingMonoChat.tsx`.

- Header: title, a width control (**Fit** / **Phone 390** / **Tablet 820** / **Desktop 1280**), a
  **Fit mocks** toggle (sends `mc-visual:fit`), Copy source, Save as…, and Close. Escape also closes it.
- Body: a scroll area with the iframe centered at the chosen width, at the page's full reported height
  (no 2000 cap here).
- **Save as** uses `save()` from `@tauri-apps/plugin-dialog` (`dialog:default` already allows it),
  then `invoke("visuals_export", …)`. That writes the page **with** the bootstrap, so the saved file
  works on its own and follows the OS appearance.

### Mobile and web design mocks

The kit is plain CSS in `bootstrap.css` plus one function in the bridge script (B4, B5). The agent
writes:

```html
<div class="mc-stage"><div>
  <figure class="mc-device" data-device="iphone" data-appearance="light">
    <div class="mc-screen"> … the screen, in the product's own design … </div>
    <figcaption>A · Current</figcaption>
  </figure>
  <figure class="mc-device" data-device="iphone" data-appearance="light">
    <div class="mc-screen" data-scroll> … </div>
    <figcaption>B · Grouped list</figcaption>
  </figure>
  <figure class="mc-device" data-device="browser">
    <div class="mc-screen" data-url="app.example.com/settings"> … </div>
    <figcaption>Web</figcaption>
  </figure>
</div></div>
```

- **Devices** (real CSS pixels):

  | `data-device` | Screen | Frame |
  |---|---|---|
  | `iphone` | 393×852 | Dynamic Island, home indicator, 55px corners |
  | `android` | 412×915 | punch-hole camera, 34px corners |
  | `ipad` | 820×1180 | |
  | `browser` | width `--mc-width` (default 1280), height `--mc-height` (default auto, at least 720) | a toolbar with traffic lights and the `data-url` text |

- **The stage** lays its child row out at real size, side by side and without wrapping. The bridge
  script then sets CSS `zoom` on it to fit the frame's width. `zoom` (unlike `transform`) also shrinks the
  layout height, so the frame height stays right. The viewer's **Fit mocks** toggle turns scaling off to
  see 100%.
- **Inside a screen the mocked product's design rules**, not MonoCode's theme. The kit gives each
  screen `isolation: isolate` and a white or black canvas per `data-appearance`, plus:
  - `--mc-safe-top` and `--mc-safe-bottom` (iPhone 59/34, Android 24/16, iPad 24/20);
  - **iOS system colors** that follow `data-appearance`: `--ios-tint`, `--ios-label`,
    `--ios-secondary-label`, `--ios-system-background`, `--ios-grouped-background`,
    `--ios-secondary-grouped-background`, `--ios-separator`, `--ios-fill`;
  - **Material 3 basics** on Android: `--md-primary`, `--md-on-primary`, `--md-surface`,
    `--md-on-surface`, `--md-surface-container`, `--md-outline`.

  The guide tells agents to read the real project's colors, fonts and spacing first, when the mock is of
  this project.
- **Phone screens have a fixed height** and clip like a real screen. `data-scroll` lets the reader scroll
  inside one.
- **Responsive web pages** don't need the kit: the agent writes a fluid page, and the reader checks it at
  each width in the viewer.

### Agent guidance

- **The prompt block** (B13, `visualRepliesContext(cli)`). It is appended to the text sent to the
  harness, built where `<monocode_app>` is built (`App.tsx:8188`).
  - It is sent only while the Settings toggle is on (B15).
  - It is sent when the turn starts a new provider conversation (`current.providerSessionId` unset
    before sending), or when no earlier user block in the session carries `visualsHint`. The user block
    it goes with gets `visualsHint: true`, which is persisted. The second condition is what reaches
    sessions created before the feature shipped, or while the toggle was off.
  - Monos get it inside `monoTurn` context.
  - It stays under ~120 tokens; a test measures it.
- **The full guide** is static text in `control_cli.rs` (`VISUALS_GUIDE`), printed by
  `app visuals.guide`. It contains:
  - page rules
  - T3's layout guide with our numbers
  - the theme variables
  - the mock kit
  - replacing a page
  - limits
- `<artifact_rules>` drops "other kinds are not yet available" and points to visuals for anything
  visual.

### Security summary

Same threat model as `monocode-preview` (agent-written, possibly prompt-injected HTML):

- opaque origin, with no `allow-same-origin` in either the iframe or the CSP
- the IPC handler rejects `Origin: null`; the invoke key is only in the main frame
- requests with a foreign `Origin` are refused
- `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`, `no-referrer`
- links go to the system browser only on a real, recent user action in that frame
- no popups and no top navigation

Residual risks: image-URL beacons, and CPU burn by a busy page (no "stop page" control in v1).

## Blueprints

Each blueprint names its target file. Ported pieces point at the T3 source they come from.

### B1. `src-tauri/src/control.rs`: let visuals through without `/operator`

```rust
/// App actions any session may call during its own active turn, without
/// /operator access: they only add to the caller's own transcript.
const TURN_SCOPED_APP_ACTIONS: [&str; 2] = ["visuals.render", "visuals.preview"];

fn request_grant(host: &Inner, namespace: &str, action: &str, token: &str) -> Result<Grant, String> {
    let grant = match namespace {
        "control" => host.grants.values().find(|grant| grant.token == token),
        "app" => host.app_grants.values().find(|grant| grant.token == token),
        _ => return Err("Unknown control namespace".into()),
    }
    .cloned()
    .ok_or("Connection revoked or unauthorized")?;
    if namespace == "app" {
        let turn_scoped = TURN_SCOPED_APP_ACTIONS.contains(&action);
        let allowed = host.active.get(&grant.session).is_some_and(|turn| {
            turn.window == grant.window && (turn.app_allowed || turn_scoped)
        });
        if host.grants.contains_key(&grant.session)
            || host.workers.contains_key(&grant.session)
            || !allowed
        {
            return Err(APP_TURN_INACTIVE.into());
        }
    }
    Ok(grant)
}

// serve(): request_grant(&host, &request.namespace, &request.action, &request.token)?
```

Update every existing call in the tests module (`control.rs:636` onward), then add:

```rust
#[test]
fn visual_actions_need_an_active_turn_but_not_operator_access() {
    let mut inner = Inner::default();
    inner.app_grants.insert("ordinary".into(), Grant {
        window: "main".into(), session: "ordinary".into(), cwd: "/repo".into(), token: "t".into(),
    });
    inner.active.insert("ordinary".into(), ActiveTurn {
        window: "main".into(), cwd: "/repo".into(), app_allowed: false,
    });
    assert!(request_grant(&inner, "app", "visuals.render", "t").is_ok());
    assert!(matches!(request_grant(&inner, "app", "sessions.list", "t"),
        Err(error) if error == APP_TURN_INACTIVE));
    assert!(request_grant(&inner, "app", "visuals.renderX", "t").is_err());
    inner.active.remove("ordinary");
    assert!(request_grant(&inner, "app", "visuals.render", "t").is_err());
}
```

### B2. `src-tauri/src/control_cli.rs`: actions, help, local guide

- Add `"visuals.render"` and `"visuals.preview"` to `APP_ACTIONS`, and change the array length from 36
  to 38.
- Answer `visuals.guide` before the whitelist check at `:541`: print `VISUALS_GUIDE` (the text in B13)
  and exit 0, without reading credentials or contacting the app.
- Help text, after the `artifacts.*` lines:

```text
  visuals.guide  Print how to build pages that look right in MonoCode (layout,
                  theme variables, phone/browser mock kit). Read it before your
                  first page.
  visuals.render {"path":"/abs/page.html","title":"Benchmarks"}
                  Show a self-contained HTML page in this thread above your
                  reply. Optional "height" (first paint, 80-2000) and
                  "maxHeight" (cap; taller content scrolls). Pass "id" from an
                  earlier result to replace that page. Local image paths are
                  inlined. Reply without describing the page.
```

- Test: `app_help()` lists both actions, and `visuals.guide` works with no endpoint in the environment.

### B3. `src-tauri/src/visual_pages.rs`: store and serve pages

```rust
//! Agent-built pages ("visual replies"). An agent writes one self-contained
//! HTML file and publishes it with `app visuals.render`; MonoCode stores a copy
//! under `<app data>/visuals/<session>/<visual>.html`, local images inlined,
//! and serves it to the transcript from `monocode-visual://`.
//!
//! Same isolation as `browser_preview`: every response carries a CSP `sandbox`
//! without `allow-same-origin`, so the page has an opaque origin whose
//! `Origin: null` the IPC handler rejects. The bootstrap (theme, size, links,
//! mock kit) is added when serving, so old pages get later fixes.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::session_store::{now_millis, validate_id};

pub const SCHEME: &str = "monocode-visual";
const DIR: &str = "visuals";
const MIB: usize = 1024 * 1024;
const MAX_SOURCE_BYTES: usize = 2 * MIB;
const MAX_IMAGE_BYTES: usize = 10 * MIB;
const MAX_PAGE_BYTES: usize = 25 * MIB;
const MAX_TITLE_CHARS: usize = 200;

/// Decision 6. `allow-forms` keeps submit handlers working; `form-action`
/// stops real submissions.
const CSP: &str = "sandbox allow-scripts allow-forms; default-src 'none'; \
script-src 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'unsafe-inline' https:; \
img-src data: blob: https:; font-src data: https:; media-src data: blob:; worker-src blob:; \
connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";

const THEME_CSS: &str = include_str!("visual_pages/theme.css");
const BASE_CSS: &str = include_str!("visual_pages/bootstrap.css");
const BRIDGE_JS: &str = include_str!("visual_pages/bootstrap.js");
const MISSING_PAGE: &str = "<!doctype html><p style=\"margin:0;padding:12px 0;color:var(--muted-foreground)\">This page is no longer available.</p>";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Wrap {
    /// Insert right after `<head …>`.
    None,
    /// No `<head>`: insert `<head>…</head>` after `<html …>` or the doctype.
    Head,
    /// A fragment: prefix `<!doctype html><head>…</head>`.
    Document,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageMeta {
    version: u8,
    title: String,
    created_at: i64,
    insert_at: usize,
    wrap: Wrap,
    add_charset: bool,
    add_viewport: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishInput {
    session_id: String,
    visual_id: String,
    path: String,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    title: String,
    bytes: usize,
}

#[tauri::command(async)]
pub fn visuals_publish(app: AppHandle, input: PublishInput) -> Result<Published, String> {
    validate_id(&input.session_id, "session")?;
    validate_id(&input.visual_id, "visual")?;
    let title = clean_title(&input.title)?;
    let source_path = PathBuf::from(&input.path);
    let source = read_source(&source_path)?;
    let base = source_path.parent().unwrap_or_else(|| Path::new("/"));
    let inlined = inline_local_images(&source, base)?;
    if !inlined.missing.is_empty() {
        return Err(format!(
            "These local images could not be read as images: {}. Use paths to existing image files, or remove them.",
            inlined.missing.join(", ")
        ));
    }
    let insertion = bootstrap_insertion(&inlined.html);
    let meta = PageMeta {
        version: 1,
        title: title.clone(),
        created_at: now_millis(),
        insert_at: insertion.at,
        wrap: insertion.wrap,
        add_charset: insertion.add_charset,
        add_viewport: insertion.add_viewport,
    };
    let dir = visuals_root(&app)?.join(&input.session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(format!("{}.html", input.visual_id)), inlined.html.as_bytes())?;
    let meta_json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(format!("{}.json", input.visual_id)), &meta_json)?;
    Ok(Published { title, bytes: inlined.html.len() })
}

/// The stored page without the bootstrap, for "Copy source".
#[tauri::command(async)]
pub fn visuals_source(app: AppHandle, session_id: String, visual_id: String) -> Result<String, String> {
    let (page, _) = load(&app, &session_id, &visual_id).map_err(|_| "Page not found".to_string())?;
    Ok(page)
}

/// The page with its bootstrap, so a saved file works on its own and follows the OS appearance.
#[tauri::command(async)]
pub fn visuals_export(app: AppHandle, session_id: String, visual_id: String, destination: String) -> Result<(), String> {
    let (page, meta) = load(&app, &session_id, &visual_id).map_err(|_| "Page not found".to_string())?;
    std::fs::write(destination, with_bootstrap(&page, &meta)).map_err(|e| e.to_string())
}

/// Called by `session_store::session_delete` after the record is gone.
pub(crate) fn delete_session_pages<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    if validate_id(session_id, "session").is_err() {
        return;
    }
    let Ok(root) = visuals_root(app) else { return };
    match std::fs::remove_dir_all(root.join(session_id)) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => eprintln!("Visual page cleanup will need a retry: {error}"),
    }
}

fn visuals_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(DIR))
}

fn clean_title(title: &str) -> Result<String, String> {
    let title: String = title.trim().chars().take(MAX_TITLE_CHARS).collect();
    if title.is_empty() {
        return Err("title is required".into());
    }
    Ok(title)
}

fn read_source(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    let extension = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("html" | "htm")) {
        return Err("path must be an .html file".into());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("The page is over 2 MiB before images are inlined. Move bulky data out or trim it.".into());
    }
    String::from_utf8(bytes).map_err(|_| "The page must be UTF-8 text".into())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn load<R: Runtime>(app: &AppHandle<R>, session_id: &str, visual_id: &str) -> Result<(String, PageMeta), StatusCode> {
    validate_id(session_id, "session").map_err(|_| StatusCode::BAD_REQUEST)?;
    validate_id(visual_id, "visual").map_err(|_| StatusCode::BAD_REQUEST)?;
    let dir = visuals_root(app).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.join(session_id);
    let meta: PageMeta = std::fs::read(dir.join(format!("{visual_id}.json")))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .ok_or(StatusCode::NOT_FOUND)?;
    let page = std::fs::read_to_string(dir.join(format!("{visual_id}.html"))).map_err(|_| StatusCode::NOT_FOUND)?;
    if meta.insert_at > page.len() || !page.is_char_boundary(meta.insert_at) {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Ok((page, meta))
}

// ---- Serving ---------------------------------------------------------------

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let origin = request.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_owned);
        responder.respond(respond(&app, request.uri().path(), origin.as_deref()));
    });
}

fn respond<R: Runtime>(app: &AppHandle<R>, url_path: &str, origin: Option<&str>) -> Response<Vec<u8>> {
    // A framed page sends `null` and a navigation sends none; anything else is
    // another document trying to read pages (browser_preview::cross_origin).
    if origin.is_some_and(|origin| origin != "null") {
        return plain(StatusCode::FORBIDDEN);
    }
    let Some((session_id, visual_id)) = parse_page_path(url_path) else {
        return plain(StatusCode::BAD_REQUEST);
    };
    match load(app, &session_id, &visual_id) {
        Ok((page, meta)) => page_response(StatusCode::OK, with_bootstrap(&page, &meta)),
        Err(StatusCode::NOT_FOUND) => {
            let meta = PageMeta { version: 1, title: String::new(), created_at: 0, insert_at: 15, wrap: Wrap::Head, add_charset: true, add_viewport: true };
            page_response(StatusCode::NOT_FOUND, with_bootstrap(MISSING_PAGE, &meta))
        }
        Err(status) => plain(status),
    }
}

/// `/<session>/<visual>.html` with ids validated by the caller.
fn parse_page_path(url_path: &str) -> Option<(String, String)> {
    let (session_id, file) = url_path.strip_prefix('/')?.split_once('/')?;
    let visual_id = file.strip_suffix(".html")?;
    (!session_id.is_empty() && !visual_id.is_empty() && !visual_id.contains('/'))
        .then(|| (session_id.to_string(), visual_id.to_string()))
}

pub(crate) fn with_bootstrap(page: &str, meta: &PageMeta) -> String {
    let mut markup = String::with_capacity(THEME_CSS.len() + BASE_CSS.len() + BRIDGE_JS.len() + 256);
    if meta.add_charset {
        markup.push_str(r#"<meta charset="utf-8">"#);
    }
    if meta.add_viewport {
        markup.push_str(r#"<meta name="viewport" content="width=device-width, initial-scale=1">"#);
    }
    markup.push_str(r#"<style id="mc-visual-theme">"#);
    markup.push_str(THEME_CSS);
    markup.push_str(r#"</style><style id="mc-visual-base">"#);
    markup.push_str(BASE_CSS);
    markup.push_str("</style><script>");
    markup.push_str(BRIDGE_JS);
    markup.push_str("</script>");
    let (open, close) = match meta.wrap {
        Wrap::None => ("", ""),
        Wrap::Head => ("<head>", "</head>"),
        Wrap::Document => ("<!doctype html><head>", "</head>"),
    };
    let (before, after) = page.split_at(meta.insert_at);
    [before, open, &markup, close, after].concat()
}

fn page_response(status: StatusCode, body: String) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .body(body.into_bytes())
        .unwrap()
}

fn plain(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; sandbox")
        .body(status.canonical_reason().unwrap_or("Error").as_bytes().to_vec())
        .unwrap()
}
```

In the missing-page branch of `respond`, `insert_at: 15` is the length of `<!doctype html>`. Compute
it with `bootstrap_insertion(MISSING_PAGE)` instead of hard-coding it.

**Bootstrap insertion.** This is a port of T3's `injectHtmlRenderBootstrap` and `blankNonMarkup`
(`packages/shared/src/htmlRender.ts:362–415`). It runs on the stored page, after images are inlined, so
the offset is final.

```rust
struct Insertion {
    at: usize,
    wrap: Wrap,
    add_charset: bool,
    add_viewport: bool,
}

fn bootstrap_insertion(html: &str) -> Insertion {
    let scan = blank_non_markup(html);
    let add_charset = !has_meta(&scan[..scan.len().min(4096)], |attrs| contains(attrs, b"charset"));
    let add_viewport = !has_meta(&scan, |attrs| attr_starts(attrs, b"name", b"viewport"));
    let (at, wrap) = if let Some(end) = open_tag_end(&scan, b"head") {
        (end, Wrap::None)
    } else if let Some(end) = open_tag_end(&scan, b"html") {
        (end, Wrap::Head)
    } else if let Some(end) = doctype_end(&scan) {
        (end, Wrap::Head)
    } else {
        (0, Wrap::Document)
    };
    Insertion { at, wrap, add_charset, add_viewport }
}

/// Lowercased copy of `html`, the same length, with comments, raw-text
/// elements and template contents turned into spaces, so tags written inside
/// them never match and offsets still line up with `html`.
fn blank_non_markup(html: &str) -> Vec<u8> {
    const RAW: [&[u8]; 9] = [b"script", b"style", b"textarea", b"title", b"xmp", b"iframe", b"noembed", b"noframes", b"noscript"];
    let lower = html.as_bytes().to_ascii_lowercase();
    let mut out = lower.clone();
    let mut at = 0;
    while at < lower.len() {
        if lower[at] != b'<' {
            at += 1;
            continue;
        }
        let rest = &lower[at + 1..];
        let end = if rest.starts_with(b"!--") {
            find(&lower, b"-->", at + 4).map_or(lower.len(), |i| i + 3)
        } else if tag_at(rest, b"plaintext") {
            lower.len()
        } else if tag_at(rest, b"template") {
            template_end(&lower, at)
        } else if let Some(tag) = RAW.iter().find(|tag| tag_at(rest, tag)) {
            let close = [b"</".as_slice(), tag].concat();
            find(&lower, &close, at + 1)
                .and_then(|i| find(&lower, b">", i))
                .map_or(lower.len(), |i| i + 1)
        } else {
            at += 1;
            continue;
        };
        out[at..end].fill(b' ');
        at = end;
    }
    out
}

/// `<name` followed by whitespace, `>` or `/`, so `<header>` is not `<head>`.
fn tag_at(rest: &[u8], name: &[u8]) -> bool {
    rest.starts_with(name)
        && matches!(rest.get(name.len()), Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'>' | b'/') | None)
}

/// End of a balanced `<template>…</template>`, nesting included.
fn template_end(lower: &[u8], start: usize) -> usize {
    let mut depth = 0usize;
    let mut at = start;
    while let Some(i) = find(lower, b"<", at) {
        let rest = &lower[i + 1..];
        if tag_at(rest, b"template") {
            depth += 1;
        } else if rest.starts_with(b"/template") {
            depth -= 1;
            if depth == 0 {
                return find(lower, b">", i).map_or(lower.len(), |gt| gt + 1);
            }
        }
        at = i + 1;
    }
    lower.len()
}

fn open_tag_end(scan: &[u8], name: &[u8]) -> Option<usize> {
    let mut at = 0;
    while let Some(i) = find(scan, b"<", at) {
        if tag_at(&scan[i + 1..], name) {
            return find(scan, b">", i).map(|gt| gt + 1);
        }
        at = i + 1;
    }
    None
}

fn doctype_end(scan: &[u8]) -> Option<usize> {
    let start = scan.iter().position(|b| !b.is_ascii_whitespace())?;
    scan[start..].starts_with(b"<!doctype").then(|| find(scan, b">", start).map(|i| i + 1)).flatten()
}

fn has_meta(scan: &[u8], test: impl Fn(&[u8]) -> bool) -> bool {
    let mut at = 0;
    while let Some(i) = find(scan, b"<meta", at) {
        let end = find(scan, b">", i).unwrap_or(scan.len());
        if tag_at(&scan[i + 1..], b"meta") && test(&scan[i + 5..end]) {
            return true;
        }
        at = i + 5;
    }
    false
}

/// `name = "viewport"` with optional spaces and quotes, as T3's regex allows.
fn attr_starts(attrs: &[u8], name: &[u8], value: &[u8]) -> bool {
    let mut at = 0;
    while let Some(i) = find(attrs, name, at) {
        let mut j = i + name.len();
        while attrs.get(j).is_some_and(u8::is_ascii_whitespace) { j += 1; }
        if attrs.get(j) == Some(&b'=') {
            j += 1;
            while attrs.get(j).is_some_and(u8::is_ascii_whitespace) { j += 1; }
            if matches!(attrs.get(j), Some(b'"' | b'\'')) { j += 1; }
            if attrs[j..].starts_with(value) {
                return true;
            }
        }
        at = i + 1;
    }
    false
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle, 0).is_some()
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}
```

**Local images.** This is a port of T3's `LOCAL_IMAGE_PATTERN`, `inlineLocalImages` and `isImageBytes`
(`apps/server/src/htmlRender/HtmlRender.ts:120–318`). It is written as a scanner because the regex
crate has no backreferences, and it adds `./` and `../` relative to the page.

```rust
const IMAGE_TYPES: [(&str, &str); 9] = [
    ("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("gif", "image/gif"),
    ("webp", "image/webp"), ("avif", "image/avif"), ("svg", "image/svg+xml"),
    ("bmp", "image/bmp"), ("ico", "image/x-icon"),
];

struct ImageRef {
    start: usize,
    end: usize,
    path: String,
}

struct Inlined {
    html: String,
    missing: Vec<String>,
}

fn image_mime(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    IMAGE_TYPES.iter().find(|(e, _)| *e == extension).map(|(_, mime)| *mime)
}

/// Absolute (`/a.png`, `C:\a.png`) or page-relative (`./a.png`, `../a.png`);
/// never `//host`, URLs, `data:` or bare names.
fn is_local_image(text: &str) -> bool {
    let b = text.as_bytes();
    let rooted = (b.first() == Some(&b'/') && b.get(1) != Some(&b'/'))
        || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
        || text.starts_with("./")
        || text.starts_with("../");
    rooted && image_mime(text).is_some()
}

/// Whole quoted strings ("…", '…', `…`) and unquoted CSS url(…) values.
fn find_local_images(html: &str) -> Vec<ImageRef> {
    let bytes = html.as_bytes();
    let mut refs = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if matches!(byte, b'"' | b'\'' | b'`') {
            let start = at + 1;
            let limit = (start + 2049).min(bytes.len());
            if let Some(len) = bytes[start..limit].iter().position(|&b| b == byte || b == b'\n' || b == b'\r') {
                let end = start + len;
                if bytes[end] == byte && is_local_image(&html[start..end]) {
                    refs.push(ImageRef { start, end, path: html[start..end].to_string() });
                    at = end + 1;
                    continue;
                }
            }
        } else if bytes.len() - at >= 4 && bytes[at..at + 4].eq_ignore_ascii_case(b"url(") {
            let mut start = at + 4;
            while bytes.get(start).is_some_and(u8::is_ascii_whitespace) { start += 1; }
            let limit = (start + 2049).min(bytes.len());
            if let Some(len) = bytes[start..limit].iter().position(|&b| b == b')' || b.is_ascii_whitespace() || matches!(b, b'"' | b'\'' | b'`' | b'(')) {
                let end = start + len;
                if end > start && is_local_image(&html[start..end]) {
                    refs.push(ImageRef { start, end, path: html[start..end].to_string() });
                    at = end;
                    continue;
                }
            }
        }
        at += 1;
    }
    refs
}

/// Inside a JS string a Windows path's backslashes are escaped.
fn file_path(reference: &str, base: &Path) -> PathBuf {
    let drive = reference.as_bytes().get(1) == Some(&b':');
    let unescaped = if drive { reference.replace("\\\\", "\\") } else { reference.to_string() };
    if unescaped.starts_with("./") || unescaped.starts_with("../") {
        base.join(unescaped)
    } else {
        PathBuf::from(unescaped)
    }
}

/// `Ok(None)` for a missing file or one that is not an image, whatever it is named.
fn read_image(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let Ok(file) = std::fs::File::open(path) else { return Ok(None) };
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("{} is over 10 MiB; each local image must be at most 10 MiB.", path.display()));
    }
    Ok(is_image_bytes(&bytes).then_some(bytes))
}

fn inline_local_images(html: &str, base: &Path) -> Result<Inlined, String> {
    let refs = find_local_images(html);
    let mut uris: HashMap<&str, Option<String>> = HashMap::new();
    for reference in &refs {
        if uris.contains_key(reference.path.as_str()) {
            continue;
        }
        let uri = read_image(&file_path(&reference.path, base))?.map(|bytes| {
            format!(
                "data:{};base64,{}",
                image_mime(&reference.path).unwrap_or("application/octet-stream"),
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        });
        uris.insert(&reference.path, uri);
    }
    let page_bytes = refs.iter().fold(html.len(), |total, r| match uris.get(r.path.as_str()) {
        Some(Some(uri)) => total + uri.len() - (r.end - r.start),
        _ => total,
    });
    if page_bytes > MAX_PAGE_BYTES {
        return Err("With its images inlined the page is over 25 MiB. Use smaller images.".into());
    }
    let mut out = String::with_capacity(page_bytes);
    let mut cursor = 0;
    for reference in &refs {
        if let Some(Some(uri)) = uris.get(reference.path.as_str()) {
            out.push_str(&html[cursor..reference.start]);
            out.push_str(uri);
            cursor = reference.end;
        }
    }
    out.push_str(&html[cursor..]);
    let mut missing: Vec<String> = uris.iter().filter(|(_, uri)| uri.is_none()).map(|(p, _)| p.to_string()).collect();
    missing.sort();
    Ok(Inlined { html: out, missing })
}

fn is_image_bytes(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(12)];
    head.starts_with(b"\x89PNG")
        || head.starts_with(b"\xff\xd8\xff")
        || head.starts_with(b"GIF8")
        || head.starts_with(b"\0\0\x01\0")
        || (head.starts_with(b"BM") && head.get(6..10) == Some(&b"\0\0\0\0"[..]))
        || (head.starts_with(b"RIFF") && head.get(8..12) == Some(&b"WEBP"[..]))
        || [b"ftypavif", b"ftypavis", b"ftypmif1"].iter().any(|tag| head.get(4..12) == Some(&tag[..]))
        || has_svg_root(&String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]))
}
```

- `has_svg_root` and `after_doctype`: port T3's `hasSvgRoot` and `afterDoctype` (`HtmlRender.ts:196–232`)
  one to one, using `str::find` and `get(..9).is_some_and(|s| s.eq_ignore_ascii_case("<!doctype"))` so a
  multibyte character never panics a slice.
- Tests to port from T3 (`packages/shared/src/htmlRender.test.ts:21–76` and
  `apps/server/src/htmlRender/HtmlRender.test.ts:60–170`):
  - the bootstrap comes before the page's own `<style>` in `<head>`
  - fragments get `<!doctype html><head>`, and existing charset/viewport metas are not duplicated
  - head and viewport inside each raw-text tag (`textarea`, `title`, `xmp`, `iframe`, `noembed`,
    `noframes`, `noscript`, `plaintext`) and inside nested `<template>` do not count
  - tags inside comments and scripts are ignored
  - local images are inlined, while URLs, `data:` and bare relative names are left alone
  - an SVG behind processing instructions and a doctype subset is inlined
  - every unreadable image is listed
- Tests of our own:
  - `./` and `../` are resolved against the page's folder
  - a symlink named `.png` that points at a text file is not inlined
  - `C:\\x.png` inside a JS string is unescaped
  - the 2 MiB and 25 MiB limits hold
  - `parse_page_path` rejects `..`, extra segments and invalid ids
  - responses carry the CSP, `no-store` and `no-referrer`
  - a foreign `Origin` gets 403
  - a missing page gets 404 with the themed body
  - `BRIDGE_JS` contains no `</script`

**Wiring:**

- `lib.rs`: `mod visual_pages;`.
- Register the scheme next to `browser_preview` (`lib.rs:236`):
  `.register_asynchronous_uri_scheme_protocol(visual_pages::SCHEME, visual_pages::handle)`.
- Add `visuals_publish`, `visuals_source` and `visuals_export` to the invoke handler.
- `session_store.rs:540`: after `delete_session(&conn, …)` and `drop(conn)`, call
  `crate::visual_pages::delete_session_pages(&app, &session_id);`.
- `tauri.conf.json:31–32`: add `monocode-visual:` to `frame-src` in `csp` and `devCsp`.

### B4. `src-tauri/src/visual_pages/bootstrap.js`: the bridge inside every page

This is a port of T3's `BOOTSTRAP_SCRIPT` (`packages/shared/src/htmlRender.ts:305–306`), made readable,
with our message names, the native iOS bridge and stage fitting. Keep it ES5-safe and free of
`</script`.

```js
(function () {
  "use strict";
  var themeStyle = document.getElementById("mc-visual-theme");
  if (!themeStyle) return;
  var native =
    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mcVisual;
  var framed = window.parent !== window;
  var probing = /[#&]mc-probe=1(?:&|$)/.test(location.hash);
  var fitEnabled = true;

  function post(message) {
    if (native) native.postMessage(message);
    else if (framed) window.parent.postMessage(message, "*");
  }

  // ---- Theme ----------------------------------------------------------------
  function applyTheme(theme) {
    if (!theme || typeof theme !== "object" || !theme.variables || typeof theme.variables !== "object") return;
    var appearance = theme.appearance === "light" ? "light" : "dark";
    var css = ":root{color-scheme:" + appearance + ";";
    for (var key in theme.variables) {
      if (/^--[a-z0-9-]+$/.test(key)) {
        css += key + ":" + String(theme.variables[key]).replace(/[;{}<>]/g, "") + ";";
      }
    }
    // Rewrite our own <style> so a page's later :root rules still win.
    themeStyle.textContent = css + "}";
    document.documentElement.setAttribute("data-mc-appearance", appearance);
  }
  try {
    var match = /[#&]mc-theme=([^&]*)/.exec(location.hash);
    if (match) {
      applyTheme(JSON.parse(decodeURIComponent(match[1])));
      // Drop the fragment so a page's own hash routing never sees it.
      history.replaceState(history.state, "", location.pathname + location.search);
    }
  } catch (error) {}

  window.addEventListener("message", function (event) {
    // Framed: only the host. Native (iOS): the app injects window.postMessage, so source is this window.
    if (event.source !== window.parent && event.source !== window) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "mc-visual:theme") applyTheme(data.theme);
    if (data.type === "mc-visual:fit") {
      fitEnabled = data.enabled !== false;
      fitStages();
    }
  });

  // ---- Links leave for the system browser -----------------------------------
  document.addEventListener(
    "click",
    function (event) {
      if (!event.isTrusted) return;
      var path = event.composedPath ? event.composedPath() : [];
      var link = null;
      for (var i = 0; i < path.length; i++) {
        if (path[i] && path[i].matches && path[i].matches("a[href]")) { link = path[i]; break; }
      }
      if (!link) return;
      var url;
      try { url = new URL(link.getAttribute("href"), document.baseURI); } catch (error) { return; }
      if (!/^https?:$/.test(url.protocol)) return;
      // Same-document anchors stay in the page (Windows serves pages over http).
      if (url.href.split("#")[0] === location.href.split("#")[0]) return;
      event.preventDefault();
      post({ type: "mc-visual:open-link", url: url.href });
    },
    true
  );

  // ---- Errors and (when probing) console ------------------------------------
  var reportedError = false;
  function reportError(text) {
    if (reportedError && !probing) return;
    reportedError = true;
    post({ type: "mc-visual:error", text: String(text).slice(0, 500) });
  }
  window.addEventListener("error", function (event) { reportError(event.message || "Script error"); });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    reportError((reason && reason.message) || reason);
  });
  ["log", "info", "warn", "error"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      var text = Array.prototype.map.call(arguments, String).join(" ").slice(0, 2000);
      if (level === "error") reportError(text);
      if (probing) post({ type: "mc-visual:console", level: level === "warn" ? "warning" : level, text: text });
      return original.apply(console, arguments);
    };
  });

  // ---- Stage fitting (mock kit) ---------------------------------------------
  // A stage lays its row out at real size; zoom (not transform) shrinks the
  // layout too, so the reported height matches what the reader sees.
  function fitStages() {
    var stages = document.querySelectorAll(".mc-stage");
    for (var i = 0; i < stages.length; i++) {
      var row = stages[i].firstElementChild;
      if (!row) continue;
      row.style.zoom = "1";
      var natural = row.scrollWidth;
      var available = stages[i].clientWidth;
      var scale = fitEnabled && natural > available ? available / natural : 1;
      row.style.zoom = String(Math.floor(scale * 1000) / 1000);
      stages[i].setAttribute("data-mc-scaled", scale < 1 ? "true" : "false");
    }
  }
  window.addEventListener("resize", fitStages);

  // ---- Height (same measure as T3 and the Phase 2 probe) ----------------------
  if (framed || native) {
    var last = -1;
    var report = function () {
      var root = document.documentElement;
      var height = Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      post({ type: "mc-visual:size", height: height });
    };
    var observer = window.ResizeObserver ? new ResizeObserver(report) : null;
    if (observer) observer.observe(document.documentElement);
    document.addEventListener("DOMContentLoaded", function () {
      if (observer && document.body) observer.observe(document.body);
      fitStages();
      report();
    });
    window.addEventListener("load", function () { fitStages(); report(); });
  } else {
    document.addEventListener("DOMContentLoaded", fitStages);
  }
})();
```

A vitest imports this file with `?raw` and asserts it contains every message type constant from
`visualBridge.ts`, so the two sides cannot drift.

### B5. `theme.css` and `bootstrap.css`: default theme, base rules, mock kit

`theme.css` holds the default variables. Use MonoCode's default dark palette, and a
`@media (prefers-color-scheme: light)` block with the light palette. Fill in the colors by running
`resolveVisualTheme()` (B7) once in each appearance and pasting the output. They are only used when no
theme arrives: a saved file opened in a browser, or the probe.

`bootstrap.css`:

```css
/* Base: the page is part of the reply, on the transcript's own background. */
html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}
html::-webkit-scrollbar{display:none}
body{margin:0}
code,kbd,pre,samp{font-family:var(--font-mono)}

/* Mock kit: stage */
.mc-stage{overflow:hidden;padding:4px 0 8px}
.mc-stage>*{display:flex;flex-wrap:nowrap;align-items:flex-start;gap:32px;width:max-content}
.mc-device{margin:0;flex:none;display:flex;flex-direction:column;align-items:center;gap:12px}
.mc-device>figcaption{font-size:12px;line-height:1.4;color:var(--muted-foreground);text-align:center;max-width:100%}

/* Mock kit: screens. Inside a screen the mocked product's design rules. */
.mc-screen{position:relative;box-sizing:border-box;overflow:hidden;isolation:isolate;background:#fff;color:#000}
.mc-device[data-appearance=dark] .mc-screen{background:#000;color:#fff}
.mc-screen[data-scroll]{overflow-y:auto;scrollbar-width:none}

.mc-device[data-device=iphone] .mc-screen{width:393px;height:852px;border-radius:55px;box-shadow:0 0 0 11px #0b0b0d,0 0 0 12px #3a3a3c,0 24px 60px rgb(0 0 0/.35);font-family:-apple-system,"SF Pro Text","SF Pro",system-ui,sans-serif;--mc-safe-top:59px;--mc-safe-bottom:34px}
.mc-device[data-device=iphone] .mc-screen::before{content:"";position:absolute;z-index:100;top:11px;left:50%;width:126px;height:37px;margin-left:-63px;border-radius:20px;background:#000}
.mc-device[data-device=iphone] .mc-screen::after{content:"";position:absolute;z-index:100;bottom:8px;left:50%;width:134px;height:5px;margin-left:-67px;border-radius:3px;background:currentColor;opacity:.85}

.mc-device[data-device=android] .mc-screen{width:412px;height:915px;border-radius:34px;box-shadow:0 0 0 10px #101012,0 0 0 11px #3a3a3c,0 24px 60px rgb(0 0 0/.35);font-family:Roboto,"Google Sans",system-ui,sans-serif;--mc-safe-top:24px;--mc-safe-bottom:16px}
.mc-device[data-device=android] .mc-screen::before{content:"";position:absolute;z-index:100;top:12px;left:50%;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#000}

.mc-device[data-device=ipad] .mc-screen{width:820px;height:1180px;border-radius:24px;box-shadow:0 0 0 14px #0b0b0d,0 0 0 15px #3a3a3c,0 24px 60px rgb(0 0 0/.3);font-family:-apple-system,"SF Pro Text",system-ui,sans-serif;--mc-safe-top:24px;--mc-safe-bottom:20px}

.mc-device[data-device=browser] .mc-screen{width:var(--mc-width,1280px);height:var(--mc-height,auto);min-height:720px;padding-top:40px;border-radius:12px;box-shadow:0 0 0 1px var(--border),0 24px 60px rgb(0 0 0/.25)}
.mc-device[data-device=browser] .mc-screen::before{content:attr(data-url);position:absolute;inset:0 0 auto;height:40px;display:flex;align-items:center;justify-content:center;font:12px/1 var(--font-sans);color:#6b6b70;background:radial-gradient(circle at 18px 20px,#ff5f57 5px,transparent 6px),radial-gradient(circle at 36px 20px,#febc2e 5px,transparent 6px),radial-gradient(circle at 54px 20px,#28c840 5px,transparent 6px),#ececee;border-bottom:1px solid rgb(0 0 0/.08)}
.mc-device[data-device=browser][data-appearance=dark] .mc-screen::before{background-color:#2b2b2e;color:#a1a1a6;border-bottom-color:rgb(255 255 255/.08)}

/* iOS system colors (light, then dark) */
.mc-device[data-device=iphone],.mc-device[data-device=ipad]{--ios-tint:#007aff;--ios-label:#000;--ios-secondary-label:rgb(60 60 67/.6);--ios-system-background:#fff;--ios-grouped-background:#f2f2f7;--ios-secondary-grouped-background:#fff;--ios-separator:rgb(60 60 67/.29);--ios-fill:rgb(120 120 128/.2)}
.mc-device[data-device=iphone][data-appearance=dark],.mc-device[data-device=ipad][data-appearance=dark]{--ios-tint:#0a84ff;--ios-label:#fff;--ios-secondary-label:rgb(235 235 245/.6);--ios-system-background:#000;--ios-grouped-background:#000;--ios-secondary-grouped-background:#1c1c1e;--ios-separator:rgb(84 84 88/.65);--ios-fill:rgb(120 120 128/.36)}

/* Material 3 basics (light, then dark) */
.mc-device[data-device=android]{--md-primary:#6750a4;--md-on-primary:#fff;--md-surface:#fef7ff;--md-on-surface:#1d1b20;--md-surface-container:#f3edf7;--md-outline:#79747e}
.mc-device[data-device=android][data-appearance=dark]{--md-primary:#d0bcff;--md-on-primary:#381e72;--md-surface:#141218;--md-on-surface:#e6e0e9;--md-surface-container:#211f26;--md-outline:#938f99}
```

In the expanded viewer with fitting off, the stage scrolls horizontally: add
`.mc-stage[data-mc-scaled=false]{overflow-x:auto}`.

### B6. `src/features/visuals/model/visualBridge.ts`: shared types and helpers

```ts
import { IS_WIN } from "../../../platform/tauri/platform";

export const VISUAL_MIN_HEIGHT = 80;
export const VISUAL_MAX_HEIGHT = 2000;
export const VISUAL_DEFAULT_HEIGHT = 360;
/** `max-w-4xl` (896px) minus the turn row's `px-4`. Agents design for this width. */
export const VISUAL_COLUMN_WIDTH = 864;
export const VISUAL_VIEWER_WIDTHS = [
  { label: "Fit", width: undefined },
  { label: "Phone", width: 390 },
  { label: "Tablet", width: 820 },
  { label: "Desktop", width: 1280 },
] as const;

export const MESSAGE = {
  theme: "mc-visual:theme",
  fit: "mc-visual:fit",
  size: "mc-visual:size",
  openLink: "mc-visual:open-link",
  error: "mc-visual:error",
  console: "mc-visual:console",
} as const;

export type VisualMeta = {
  /** `vis-<requestId>`; also the file name. */
  id: string;
  /** The session folder that holds the file. */
  sessionId: string;
  title: string;
  /** Box reserved before the page reports its height. */
  height: number;
  /** The agent asked for a scrolling frame no taller than this. */
  maxHeight?: number;
  /** Bumped when the agent replaces the page; part of the URL and the React key. */
  revision: number;
  /** `[width, height]` measured by the Phase 2 probe, ascending by width. */
  heights?: [number, number][];
};

export type VisualTheme = {
  appearance: "light" | "dark";
  variables: Record<string, string>;
};

export type VisualPageMessage =
  | { type: typeof MESSAGE.size; height: number }
  | { type: typeof MESSAGE.openLink; url: string }
  | { type: typeof MESSAGE.error; text: string };

export function clampVisualHeight(height: number): number {
  return Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.round(height)));
}

/** Windows webviews reach custom schemes as `http://<scheme>.localhost` (see browserPreviewUrl). */
export function visualUrl(visual: Pick<VisualMeta, "sessionId" | "id" | "revision">, windows = IS_WIN): string {
  const origin = windows ? "http://monocode-visual.localhost" : "monocode-visual://localhost";
  return `${origin}/${encodeURIComponent(visual.sessionId)}/${encodeURIComponent(visual.id)}.html?v=${visual.revision}`;
}

export function visualThemeFragment(theme: VisualTheme): string {
  return `#mc-theme=${encodeURIComponent(JSON.stringify(theme))}`;
}

export function readVisualMessage(data: unknown): VisualPageMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message.type === MESSAGE.size) {
    const height = message.height;
    return typeof height === "number" && Number.isFinite(height) && height > 0
      ? { type: MESSAGE.size, height }
      : undefined;
  }
  if (message.type === MESSAGE.openLink) {
    return typeof message.url === "string" && /^https?:\/\//i.test(message.url)
      ? { type: MESSAGE.openLink, url: message.url }
      : undefined;
  }
  if (message.type === MESSAGE.error) {
    return typeof message.text === "string" ? { type: MESSAGE.error, text: message.text.slice(0, 500) } : undefined;
  }
  return undefined;
}

// Port of T3's measuredHeight: the taller of the nearest measured widths on each side.
function measuredHeight(heights: [number, number][], width: number): number {
  const above = heights.findIndex(([measured]) => measured >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height at a width. The page's own report wins once it arrives;
 * before that, the probe's measurement for this width, else the agent's hint.
 * `maxHeight` caps it when the agent asked for a scrolling frame.
 */
export function visualFrameHeight(visual: VisualMeta, width: number, contentHeight?: number): number {
  const expected =
    contentHeight ??
    (visual.heights?.length ? measuredHeight(visual.heights, width) : visual.height);
  return clampVisualHeight(Math.min(visual.maxHeight ?? VISUAL_MAX_HEIGHT, expected));
}

export function visualFileName(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}
```

Tests:

- `readVisualMessage` rejects other types, non-http links, and non-finite or negative heights.
- `visualFrameHeight`: content height wins, `maxHeight` caps it, and it clamps at 80 and 2000.
- `visualFrameHeight` with `heights` takes the taller of the two neighbors. Port T3's tests at
  `packages/shared/src/htmlRender.test.ts:193–230`.
- `visualUrl` gives both platform forms.
- `bootstrap.js?raw` contains every `MESSAGE` value.

### B7. `src/features/visuals/model/useVisualTheme.ts`: resolved theme for frames

```ts
import { useSyncExternalStore } from "react";
import { SCHEME_CHANGE_EVENT } from "../../settings/model/appearance";
import type { VisualTheme } from "./visualBridge";

const COLORS: [variable: string, value: string][] = [
  ["--background", "var(--color-background-base)"],
  ["--foreground", "var(--color-content)"],
  ["--muted-foreground", "color-mix(in srgb, var(--color-content) 55%, transparent)"],
  ["--card", "color-mix(in srgb, var(--color-content) 5%, transparent)"],
  ["--border", "var(--color-stroke)"],
  ["--accent", "var(--color-accent)"],
  ["--success", "var(--color-diff-add)"],
  ["--destructive", "var(--color-diff-del)"],
  ["--code-background", "color-mix(in srgb, var(--color-content) 6%, transparent)"],
];
// T3's categorical series after the accent (packages/shared/src/htmlRender.ts FIXED_COLORS).
const CHART = {
  dark: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
  light: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
};

/** Reads concrete colors: frames cannot see the app's variables or its color-mix() inputs. */
export function resolveVisualTheme(): VisualTheme {
  const root = document.documentElement;
  const appearance = root.classList.contains("theme-light") ? "light" : "dark";
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  const variables: Record<string, string> = {};
  for (const [name, value] of COLORS) {
    probe.style.color = value;
    variables[name] = getComputedStyle(probe).color;
  }
  probe.remove();
  const style = getComputedStyle(root);
  variables["--accent-foreground"] = readableOn(variables["--accent"]!);
  variables["--warning"] = appearance === "light" ? "#d97706" : "#f59e0b";
  variables["--chart-1"] = variables["--accent"]!;
  CHART[appearance].forEach((color, index) => (variables[`--chart-${index + 2}`] = color));
  variables["--font-sans"] = style.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif";
  variables["--font-mono"] = style.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
  variables["--radius"] = "10px";
  return { appearance, variables };
}

/** Black or white, whichever reads better on `color` (any CSS color the engine computed). */
function readableOn(color: string): string {
  const rgb = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  const scale = color.startsWith("color(") ? 255 : 1; // color(srgb r g b) is 0–1
  const [r, g, b] = rgb.map((v) => (v * scale) / 255);
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return luminance > 0.55 ? "#000000" : "#ffffff";
}

let snapshot: VisualTheme | undefined;
let key = "";
const listeners = new Set<() => void>();

function refresh() {
  const next = resolveVisualTheme();
  const nextKey = JSON.stringify(next);
  if (nextKey === key) return;
  key = nextKey;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener(SCHEME_CHANGE_EVENT, refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      window.removeEventListener(SCHEME_CHANGE_EVENT, refresh);
    }
  };
}
let observer: MutationObserver | undefined;

/** The app theme as handed to visual pages. Stable until a value changes. */
export function useVisualTheme(): VisualTheme {
  return useSyncExternalStore(subscribe, () => {
    if (!snapshot) refresh();
    return snapshot!;
  });
}
```

- Check that `SCHEME_CHANGE_EVENT` is exported from `appearance.ts`; export it if not.
- The `--font-sans` stack in `index.css` is defined in `@theme`. Confirm in the spike that
  `getPropertyValue` returns it on `:root`.
- Test: the theme changes when `theme-light` toggles, and the snapshot object is stable when nothing
  changes. Without the stable snapshot, `useSyncExternalStore` loops.

### B8. Session model: role, event, persistence

`src/features/sessions/model/session.ts`:

```ts
export type BlockRole = | "user" | "assistant" | "image" | "visual" | "reasoning" | /* … */ "handoff";
// in Block:
  /** An agent-built page shown inline; the HTML lives in the app data folder. */
  visual?: import("../../visuals/model/visualBridge").VisualMeta;
```

`src/integrations/harness/core/types.ts`:

```ts
  /** An agent published (or replaced) a page with `app visuals.render`. Never sent by providers. */
  | { type: "visual.published"; visual: import("../../../features/visuals/model/visualBridge").VisualMeta }
```

`src/integrations/harness/core/apply.ts`:

```ts
    case "visual.published":
      return upsertVisual(session, event.visual);

/** A replaced page keeps its place in the transcript; a new one lands where the work is. */
function upsertVisual(session: Session, visual: VisualMeta): Session {
  const index = session.blocks.findIndex(
    (block) => block.role === "visual" && block.visual?.id === visual.id,
  );
  if (index >= 0) {
    const blocks = session.blocks.slice();
    blocks[index] = { ...blocks[index]!, text: visual.title, visual };
    return { ...session, blocks };
  }
  return appendBlock(session, { id: crypto.randomUUID(), role: "visual", text: visual.title, visual });
}
```

`src/features/sessions/data/sessionStore.ts`, in `sanitizeBlock` next to the image branch (`:960`):

```ts
  const visual = sanitizeVisual(block.visual);
  if (block.role === "visual" && !visual) return null;
  if (visual) next.visual = visual;

function sanitizeVisual(value: unknown): VisualMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" || !/^vis-[A-Za-z0-9_-]{1,160}$/.test(v.id) ||
    typeof v.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(v.sessionId) ||
    typeof v.title !== "string" || !v.title.trim() ||
    typeof v.height !== "number" || !Number.isFinite(v.height)
  )
    return undefined;
  const heights = Array.isArray(v.heights)
    ? v.heights.filter(
        (pair): pair is [number, number] =>
          Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === "number" && Number.isFinite(n)),
      ).slice(0, 24)
    : undefined;
  return {
    id: v.id,
    sessionId: v.sessionId,
    title: v.title.slice(0, 200),
    height: clampVisualHeight(v.height),
    revision: typeof v.revision === "number" && Number.isInteger(v.revision) && v.revision > 0 ? v.revision : 1,
    ...(typeof v.maxHeight === "number" && Number.isFinite(v.maxHeight) ? { maxHeight: clampVisualHeight(v.maxHeight) } : {}),
    ...(heights?.length ? { heights } : {}),
  };
}
```

Tests:

- `apply`: a visual after a running tool lands after it. A second publish with the same id updates in
  place and bumps the revision. An open assistant stream is sealed, as with images.
- `groupTurnItems`: a visual is a `block` item.
- `foldableWork`: the fold stops at a visual, and work → visual → prose folds only the work above.
- `sessionStore`: the visual survives a save and load. A malformed visual drops the block.

### B9. Agent-app handler and App wiring

`src/features/agent-app/model/agentApp.ts`:

```ts
// FIELDS
  ["visuals.render", ["id", "path", "title", "height", "maxHeight"]],
  ["visuals.preview", ["path", "width", "appearance"]],

// AgentAppHost
  /** Stores a page and shows it in the caller's live turn. */
  publishVisual?(sourceSessionId: string, input: VisualPublishInput): Promise<VisualMeta>;
  /** Settings → Chat → Visual replies; read on every call so a change applies at once. */
  visualRepliesEnabled?(): boolean;

export type VisualPublishInput = {
  id: string;
  replace: boolean;
  path: string;
  title?: string;
  height?: number;
  maxHeight?: number;
};

function optionalHeight(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 80 || (value as number) > 2000)
    throw new Error(`${name} must be an integer from 80 to 2000`);
  return value as number;
}

async function handleVisuals(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  if (host.visualRepliesEnabled?.() === false)
    throw new Error("Visual replies are turned off in MonoCode settings. Answer in text.");
  if (host.isHabitRun?.(source.id)) throw new Error("Visual replies are not available in habit runs yet");
  if (source.cwd.startsWith(REMOTE_PATH_PREFIX))
    throw new Error("Visual replies are not available in remote sessions yet");
  if (action === "visuals.preview")
    throw new Error("visuals.preview is not available yet. Check the page yourself, then publish it with visuals.render");
  if (!host.publishVisual) throw new Error("Visual replies are unavailable");
  const replaceId = optionalString(input.id, "id", 160);
  if (replaceId && !/^vis-[A-Za-z0-9_-]+$/.test(replaceId)) throw new Error("Invalid visual id");
  if (!replaceId && !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error("Invalid request ID");
  const title = input.title === undefined ? undefined : requiredString(input.title, "title", 200);
  if (!replaceId && title === undefined) throw new Error("title is required");
  const visual = await host.publishVisual(source.id, {
    id: replaceId ?? `vis-${requestId}`,
    replace: !!replaceId,
    path: requiredString(input.path, "path", 4096),
    title,
    height: optionalHeight(input.height, "height"),
    maxHeight: optionalHeight(input.maxHeight, "maxHeight"),
  });
  return {
    id: visual.id,
    title: visual.title,
    message:
      "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
  };
}

// handleAgentApp, next to the other prefixes:
  if (action.startsWith("visuals.")) return handleVisuals(source, requestId, action, input, host);
```

`src/app/App.tsx`, in the host object next to `postArtifact` (`:11377`):

```ts
publishVisual: async (sessionId, input) => {
  const session = sessionsRef.current.find((entry) => entry.id === sessionId);
  if (!session) throw new Error("The session is no longer open");
  const previous = session.blocks.find((block) => block.role === "visual" && block.visual?.id === input.id)?.visual;
  if (input.replace && !previous) throw new Error("No page with that id in this session");
  const published = await invoke<{ title: string }>("visuals_publish", {
    input: { sessionId, visualId: input.id, path: input.path, title: input.title ?? previous!.title },
  });
  const visual: VisualMeta = {
    id: input.id,
    sessionId,
    title: published.title,
    height: clampVisualHeight(input.height ?? previous?.height ?? VISUAL_DEFAULT_HEIGHT),
    revision: (previous?.revision ?? 0) + 1,
    ...((input.maxHeight ?? previous?.maxHeight) !== undefined
      ? { maxHeight: clampVisualHeight((input.maxHeight ?? previous!.maxHeight)!) }
      : {}),
  };
  // Same queue as the turn's own events, so it lands after the running tool call.
  enqueueHarnessEvent(sessionId, { type: "visual.published", visual });
  return visual;
},
```

Also:

- `monocodeToolCall.ts`: add the labels `"visuals.render": "Publish a visual"`,
  `"visuals.preview": "Preview a visual"` and `"visuals.guide": "Read the visuals guide"`.
- In the App host object, `visualRepliesEnabled: loadVisualRepliesEnabled` (B15).
- Tests:
  - field whitelist
  - the toggle off refuses with the "turned off" message, before any file is read
  - a habit run is refused
  - a remote session is refused
  - a create needs a title
  - a replace with an unknown id fails
  - the id is `vis-<requestId>`
  - the returned message is exactly the T3-style instruction

### B10. `src/features/visuals/ui/VisualFrame.tsx`: the inline frame

This is a port of T3's `HtmlRenderFrame` (`apps/web/src/components/chat/HtmlRenderFrame.tsx`) and
`HtmlRenderDocument` (`apps/web/src/components/files/BrowserDocumentFrame.tsx:69–137`).

```tsx
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MESSAGE, VISUAL_COLUMN_WIDTH, readVisualMessage, visualFrameHeight, visualThemeFragment,
  visualUrl, type VisualMeta,
} from "../model/visualBridge";
import { useVisualTheme } from "../model/useVisualTheme";
import { VisualToolbar } from "./VisualToolbar";

/**
 * An agent's page inline in the transcript, on the transcript's own
 * background. It holds the agent's height until the page reports its own, so
 * nothing below jumps more than once. Remount with key={id:revision}.
 */
export function VisualFrame({ visual, onExpand }: { visual: VisualMeta; onExpand: (visual: VisualMeta) => void }) {
  const theme = useVisualTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(VISUAL_COLUMN_WIDTH);
  const [contentHeight, setContentHeight] = useState<number>();
  const [loaded, setLoaded] = useState(false);
  const [pageError, setPageError] = useState<string>();
  // The first URL is kept for the frame's life: a new src would reload the page.
  const [src] = useState(() => `${visualUrl(visual)}${visualThemeFragment(theme)}`);
  const growth = useRef<number[]>([]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const postTheme = () =>
    frameRef.current?.contentWindow?.postMessage({ type: MESSAGE.theme, theme }, "*");
  useEffect(postTheme, [theme]);

  // From the commit that inserts the frame: a fast page posts its first height
  // before a passive effect would run.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = readVisualMessage(event.data);
      if (!message) return;
      if (message.type === MESSAGE.size) {
        setContentHeight((current) => {
          // Runaway guard: a 100vh page grows with its frame. Stop growing after
          // 8 increases in a second, until the page reports a smaller height.
          const now = performance.now();
          if (current !== undefined && message.height > current) {
            growth.current = [...growth.current.filter((at) => now - at < 1000), now];
            if (growth.current.length > 8) return current;
          } else growth.current = [];
          return message.height;
        });
      } else if (message.type === MESSAGE.error) {
        setPageError((current) => current ?? message.text);
      } else if (
        // Open only from the reader's own recent action in this frame.
        document.activeElement === frame &&
        navigator.userActivation?.isActive !== false
      ) {
        void openUrl(message.url).catch(() => undefined);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const height = visualFrameHeight(visual, width, contentHeight);
  return (
    <div className="px-4 py-1" data-visual={visual.id}>
      <div ref={boxRef} className="group/visual relative w-full" style={{ height }}>
        <iframe
          ref={frameRef}
          src={src}
          title={visual.title}
          // Never allow-same-origin: the opaque origin keeps the page out of the app.
          sandbox="allow-scripts allow-forms"
          loading="lazy"
          onLoad={() => {
            setLoaded(true);
            postTheme(); // covers a theme change that landed while loading
          }}
          className="block size-full border-0 bg-transparent"
          // A frame whose color scheme differs from its document's paints an
          // opaque canvas; the blank start document is light, the page is not.
          style={{ colorScheme: loaded ? theme.appearance : "light" }}
        />
        <VisualToolbar visual={visual} onExpand={onExpand} />
        {pageError ? (
          <span
            title={pageError}
            className="absolute bottom-2 end-2 rounded-full bg-content/10 px-2 py-0.5 font-sans text-[11px] text-content/60"
          >
            Page error
          </span>
        ) : null}
      </div>
    </div>
  );
}
```

- `VisualToolbar` holds the hover buttons: Expand, Copy source, Save as…. Style it like other transcript
  hover controls (`opacity-0 group-hover/visual:opacity-100 focus-within:opacity-100`), and use the
  icon set in `src/shared/ui/icons`.
- **Copy source:** `invoke("visuals_source")` then `copyMessage(...)` from
  `platform/tauri/clipboard`.
- **Save as:**
  `save({ defaultPath: visualFileName(title), filters: [{ name: "HTML", extensions: ["html"] }] })`,
  then `invoke("visuals_export", { sessionId, visualId, destination })`.
- In `AgentTranscript.tsx`, in `TranscriptBlock` next to the image branch (`:2065`):

  ```tsx
  if (block.role === "visual") {
    return block.visual ? (
      <VisualFrame key={`${block.visual.id}:${block.visual.revision}`} visual={block.visual} onExpand={openVisual} />
    ) : null;
  }
  ```

  `openVisual` sets local state that renders `<VisualViewer>`. Keep that state inside
  `AgentTranscript`, so the floating Mono chat gets the viewer for free.

### B11. `src/features/visuals/ui/VisualViewer.tsx`: expand, widths, fit toggle

```tsx
export function VisualViewer({ visual, onClose }: { visual: VisualMeta; onClose: () => void }) {
  const theme = useVisualTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [preset, setPreset] = useState<(typeof VISUAL_VIEWER_WIDTHS)[number]>(VISUAL_VIEWER_WIDTHS[0]);
  const [fitMocks, setFitMocks] = useState(true);
  const [contentHeight, setContentHeight] = useState(visual.height);
  const [src] = useState(() => `${visualUrl(visual)}${visualThemeFragment(theme)}`);
  // Escape in capture, so it closes the viewer before it can stop a reply (as ArtifactSheet does).
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onClose]);
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: MESSAGE.fit, enabled: fitMocks }, "*");
  }, [fitMocks]);
  // Same message listener as VisualFrame (size, link, error), minus the 2000 cap.
  return createPortal(
    <div role="dialog" aria-modal aria-label={visual.title} className="fixed inset-0 z-50 flex flex-col bg-background-base/95 backdrop-blur">
      <header className="flex items-center gap-3 border-b border-stroke px-4 py-2">
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-content">{visual.title}</span>
        {/* segmented control over VISUAL_VIEWER_WIDTHS, a "Fit mocks" switch, Copy, Save, Close */}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <iframe
          ref={frameRef}
          src={src}
          title={visual.title}
          sandbox="allow-scripts allow-forms"
          className="mx-auto block border-0"
          style={{ width: preset.width ?? "100%", height: contentHeight, colorScheme: theme.appearance }}
        />
      </div>
    </div>,
    document.body,
  );
}
```

- Post the theme on `load` and on changes, as `VisualFrame` does.
- After `onLoad`, re-send the fit message.
- Test: Escape closes, the width presets change the frame width, and fit sends `mc-visual:fit`.

### B12. Transcript checklist sites

Apply the "Every site that special-cases `role === "image"`" table under Transcript block and
placement. Each change is one or two lines; add one test per site where a test file exists.

### B13. Guidance texts

`src/features/visuals/model/visualGuidance.ts`, appended where `<monocode_app>` is built
(`App.tsx:8188`):

```ts
/** About 90 tokens; sent with a provider conversation's first turn. */
export function visualRepliesContext(cli: string): string {
  return `<monocode_visuals>\nWhen a chart, table, diagram, image collage or a UI mock (mobile or web) would say more than prose, write one self-contained HTML file and publish it before your final reply: ${cli} visuals.render --json '{"path":"/abs/page.html","title":"Short name"}'. MonoCode shows it in this thread above your reply, so don't announce or restate it; add only what it doesn't say. Run ${cli} visuals.guide once before your first page.\n</monocode_visuals>`;
}
```

- Send it when all of these hold:
  - `loadVisualRepliesEnabled()` is true (B15)
  - the turn is not a raw native command
  - either `!current.providerSessionId` (a new provider conversation), or no user block in
    `current.blocks` has `visualsHint`
- Mark the user block submitted with it `visualsHint: true`, and add that field to `sanitizeBlock`
  next to `monocode` (`sessionStore.ts`). Otherwise it is lost on save and the block is re-sent after
  every restart.
- For Monos, put it into `appContext` before `monoTurn(…)`.
- Tests:
  - the text is under 120 tokens (count roughly with `text.split(/\s+/).length < 90`)
  - it is added on the first turn, after a provider reset, and on the first turn of an older session
    without `visualsHint`
  - it is not added on later turns, nor when the toggle is off

`VISUALS_GUIDE` in `control_cli.rs`. This is the layout part of T3's `HTML_RENDER_LAYOUT_GUIDE` and
`HTML_RENDER_THEME_GUIDE`, adapted, plus the mock kit:

```text
Visual replies: a self-contained HTML page shown in this thread above your reply.

Publish: app visuals.render {"path":"/abs/page.html","title":"Short name"}
  Write one HTML file with inline <style> and <script>. Libraries over https
  (charts, fonts) load; fetch/XHR do not, so embed your data in the page.
  Image paths written as absolute paths or ./relative to the page (src, CSS
  url(), or a JS string) are embedded automatically, so the page keeps working
  after the files move. Max 2 MiB of HTML, 10 MiB per image, 25 MiB total.
  Replace a page: {"id":"<id from the result>","path":"..."}.
  "maxHeight" caps the frame; taller content scrolls inside it.

Layout. The frame is borderless on the thread's own background, as wide as the
reply column (about 860px at most; 360px in narrow panes and the floating Mono
chat), and its left edge lines up with your reply text.
  - Leave html, body and the outermost element without a background color.
  - Use fluid widths and no horizontal padding on the outermost element; no
    outer card, border or title banner: the page is part of your reply.
  - A box that needs its own background gets at least 16px padding on every
    side and var(--radius) corners.
  - Give charts fixed pixel heights, not heights that scale with width.
  - Let content set the height. Never use 100vh or height:100% on html/body.

Theme. These CSS variables are set on :root and follow the user's theme and
light/dark mode live: --background --foreground --muted-foreground --card
--border --accent --accent-foreground --success --destructive --warning
--code-background --chart-1 ... --chart-6 --font-sans --font-mono --radius.
The base stylesheet already sets html color/font from them.

UI mocks (mobile and web). Put mocks in a stage; it lays them out side by side
at real size and scales the row to fit the reader's width:
  <div class="mc-stage"><div>
    <figure class="mc-device" data-device="iphone" data-appearance="light">
      <div class="mc-screen">...</div><figcaption>A · Current</figcaption>
    </figure>
    <figure class="mc-device" data-device="browser">
      <div class="mc-screen" data-url="example.com/settings">...</div>
      <figcaption>Web</figcaption>
    </figure>
  </div></div>
  data-device: iphone (393x852), android (412x915), ipad (820x1180), browser
  (--mc-width default 1280). data-appearance: light or dark for the mocked app.
  Inside .mc-screen use the mocked product's own design: read its colors,
  fonts and spacing from this project when it is this project's UI. Helpers:
  --mc-safe-top/--mc-safe-bottom; iOS --ios-tint --ios-label
  --ios-secondary-label --ios-system-background --ios-grouped-background
  --ios-secondary-grouped-background --ios-separator --ios-fill; Android
  --md-primary --md-on-primary --md-surface --md-on-surface
  --md-surface-container --md-outline. Phone screens clip like real screens;
  add data-scroll to a .mc-screen to make it scroll. For several treatments,
  put them in one stage with a caption each. A responsive web page needs no
  kit: make it fluid; the reader can switch the expanded view between phone,
  tablet and desktop widths.

Reply. The reader already sees the page; do not describe or restate it.
```

### B14. Phase 2 sketch: `visuals.preview` and measured heights

- **The probe page.** Add a Vite entry `visual-probe.html` → `src/features/visuals/probe/main.ts`.
  It reads `src`, `width` and `appearance` from its URL, and renders one iframe at that width with
  `#mc-probe=1` plus a theme fragment. It collects `mc-visual:size`, `mc-visual:console` and
  `mc-visual:error`.
- **Settling.** The page has settled once `load` has fired and the size has not changed for 500 ms
  (10 s at most). The probe then calls
  `invoke("visuals_probe_report", { probeId, contentHeight, console })`.
- **Rust, `visuals_preview(path, width, appearance)`:**
  1. Stage the page with the same publish pipeline into `visuals/_probe/<uuid>.html`, keeping missing
     images as a list instead of an error.
  2. Open a hidden `WebviewWindow` labelled `visual-probe-<uuid>`, at `width` × 900.
  3. Wait for the report.
  4. Resize to `width` × min(contentHeight, 4000).
  5. Snapshot:
     - macOS: `WKWebView takeSnapshotWithConfiguration:completionHandler:` via `with_webview`.
       This needs the `objc2-web-kit` crate.
     - Windows: WebView2 `CapturePreview`.
     - Linux: no PNG.
  6. Write the PNG to `$TMPDIR/monocode-visuals/<session>/preview-<n>.png`, close the window, delete
     the staged page, and return the result.
- **Capabilities.** Add `visual-probe-*` windows to a capability that allows only
  `visuals_probe_report`.
- **Measured heights.** After a publish, run the probe at 360/520/728/864/1000 in the background, then
  `enqueueHarnessEvent(sessionId, {type:"visual.published", visual:{...visual, heights}})`. This uses
  the same id, so it updates in place and bumps the revision. Skip the measurement when the session has
  more than 3 probes queued.
- **Spike questions:**
  - Does `takeSnapshot` work on a hidden window, or must it be visible off-screen?
  - Does `zoom` in the stage measure the same in the probe?
  - How long does one probe take cold, and warm?

### B15. Settings toggle: Settings → Chat → "Visual replies" (Phase 1)

This follows the existing boolean settings: localStorage flags read synchronously where they are used,
such as `loadResumeAfterUsageLimit` (`settings.ts:638`). The flag is the same for every window, because
they share the app origin.

`src/features/settings/model/settings.ts`:

```ts
const VISUAL_REPLIES_KEY = "monocode.visualReplies";

export const VISUAL_REPLIES_DEFAULT = true;

/** Agents may answer with pages (charts, diagrams, UI mocks) shown in the conversation. */
export function loadVisualRepliesEnabled(): boolean {
  return readFlag(VISUAL_REPLIES_KEY) ?? VISUAL_REPLIES_DEFAULT;
}

export function saveVisualRepliesEnabled(value: boolean) {
  writeFlag(VISUAL_REPLIES_KEY, value);
}

// SETTINGS_INDEX, next to "resume-after-usage-limit":
  {
    id: "visual-replies",
    section: "chat",
    label: "Visual replies",
    keywords: "chart graph diagram table mock mockup design html page visualization preview iphone web",
  },
```

`src/features/settings/ui/SettingsView.tsx`, in the Chat section. Follow the "Usage limits" group at
`:1108`:

```tsx
const [visualReplies, setVisualReplies] = useState(loadVisualRepliesEnabled);
const onVisualReplies = (on: boolean) => {
  setVisualReplies(on);
  saveVisualRepliesEnabled(on);
};

<Group
  title="Visual replies"
  description="Pages agents build into their answers: charts, tables, diagrams and mobile or web mocks."
>
  <Row
    id="visual-replies"
    label="Visual replies"
    description="Let agents answer with a page shown in the conversation. When off, agents aren't told about it and can't publish pages; pages already in conversations stay visible."
  >
    <Toggle label="Visual replies" on={visualReplies} onChange={onVisualReplies} />
  </Row>
</Group>
```

What the flag gates:

| Place | When off |
|---|---|
| `visualRepliesContext` (B13) | not appended |
| `handleVisuals` (B9) | refuses: "Visual replies are turned off in MonoCode settings. Answer in text." |
| `VisualFrame` and `VisualViewer` | unchanged: existing pages keep rendering |
| `app visuals.guide` | unchanged: it is local text and harmless |

Turning the toggle back on reaches running conversations through the `visualsHint` rule in B13: the
next turn of a session whose user blocks carry no hint gets the block.

Tests:

- the flag defaults to on and round-trips through save and load
- the Settings search finds "chart" and "mockup"
- with the flag off, no context is added and `visuals.render` is refused

## Roadmap

Each step ends green:

- `npm test` and `npx tsc --noEmit`
- `cargo test` (run it with `GIT_CONFIG_GLOBAL` pointed at an empty file, per the local hooks note)
- `cargo fmt --check` on touched files

Run `npm ci` in this worktree before the first push. Commit subjects describe the change, never the
phase or step.

### Phase 0: spike (half a day, throwaway commit)

0. Prove the risky platform bits and write the results under "As built":
   - A `monocode-visual://` iframe inside the transcript runs inline scripts under the CSP.
   - It is transparent over a chat background image in both appearances.
   - Its `postMessage` reaches the parent with a matching `event.source`.
   - `openUrl` works from a frame click.
   - `loading="lazy"` works inside a `content-visibility` turn.
   - The same works on Windows (WebView2 via `http://monocode-visual.localhost`).
   - CSS `zoom` in a stage changes `scrollHeight` in WKWebView and WebView2.
   - **Codex:** `MONOCODE_APP_TOKEN` reaches the shell. Codex's `shell_environment_policy` may drop
     `*TOKEN*` variables by default. Check what `/operator` does today and reuse it.
   - `getComputedStyle(root).getPropertyValue("--font-sans")` returns the stack.

### Phase 1: MVP (one PR into `dev`)

1. **Storage and serving.** Add `visual_pages.rs` (B3), the three assets (B4, B5), the scheme
   registration, the CSP `frame-src` entry, the `session_delete` hook and the Rust tests.
   *Done when* `cargo test visual_pages` passes and a hand-placed page under `visuals/` renders in a
   test iframe with the theme.
2. **Access and CLI.** `request_grant` gets the action (B1). `APP_ACTIONS`, the help text and the local
   `visuals.guide` go in (B2). *Done when* the B1 test passes and the guide prints with no endpoint
   set.
3. **Session model.** The role, the event, `upsertVisual`, `sanitizeVisual` and the B8 tests.
4. **Handler and wiring.** `handleVisuals`, `publishVisual`, the tool-call labels and the B9 tests.
   *Done when* an agent's `app visuals.render` in an ordinary session (no `/operator`) adds a visual
   block in the right place and it survives an app restart.
5. **Frame and theme.** `visualBridge.ts`, `useVisualTheme`, `VisualFrame`, `VisualToolbar`, the
   transcript branch, and the checklist sites (B6, B7, B10, B12). *Done when* the page fits its height,
   follows a live theme switch, opens links in the browser, and the floating Mono chat shows it too.
6. **Viewer.** `VisualViewer` (B11) with the width presets, the fit toggle, Copy source and Save as.
7. **Mock kit and guidance.**
   - Add the kit to `bootstrap.css`, and the stage fitting already in B4.
   - Add `VISUALS_GUIDE`, `visualRepliesContext`, and the `<artifact_rules>` wording.
   - *Done when*, in a fresh Claude Code session and a fresh Codex session, "mock 3 treatments of this
     settings screen for iOS and a web version" produces fitted phone and browser mocks without the user
     mentioning visuals.
8. **Settings toggle** (B15): the flag, the Settings row, the gate in `handleVisuals`, the gate on the
   guidance, and the `visualsHint` field in `sanitizeBlock`. *Done when*:
   - turning it off stops new pages and the guidance, while old pages still show
   - turning it on again makes the next turn of an existing session carry the guidance
9. **Manual QA in the built app**, then write "As built":
   - ask for a chart, a table, a diagram, an image collage, and a phone plus web mock
   - turn Visual replies off, ask for a chart (text answer), then turn it back on
   - toggle the theme
   - expand at each width
   - save, then reopen the saved file in a browser
   - restart the app
   - delete the session and confirm its folder is gone
   - a page with `100vh`
   - a page with a broken script (the error pill)
   - a link click
   - a `--json` with a missing image (the agent gets the path list)

### Phase 2: agent self-check

10. The probe spike (B14 questions), then `visuals.preview`, then background height measurement. Update
    the guide: "preview at 864 and at 390, fix, then render".

### Phase 3: reach

11. **MonoCode iOS app** (on `feat/ios-native-design`):
    - Add `"visual"` to `BlockRoleTag.known`.
    - Add a `VisualView`: a `WKWebView` that loads the page HTML with the bootstrap, with
      `userContentController.add(_, name: "mcVisual")` for size, links and errors.
      `window.postMessage({type:"mc-visual:theme",…})` sends the theme.
    - Add a host command that returns a session's visual page. Decide where the host reads the
      `visuals/` folder from, because the host and the desktop app may not share a data dir.
12. **Remote sessions:** `visuals.render` reads the file through `remote::read_host_file` instead of
    the local file system.
13. **Orchestration leads and workers:** give them the visuals actions through their control token
    (control namespace), or a narrow visuals-only app token.
14. **"Save as artifact":** add an `html` artifact kind, and let `ArtifactContent` render it with
    `VisualFrame`.
15. **MCP Apps:** add the JSON-RPC dialect of the bridge (`ui/notifications/size-changed`,
    `ui/open-link`, `ui/notifications/host-context-changed`) for MCP servers that return UI
    resources, as T3 does for Codex.

## Risks

- **Codex env filtering** could hide the token from the shell. Phase 0 checks it; the fix is whatever
  `/operator` already does.
- **Guidance cost.** The block is ~90 tokens per provider conversation, and the details are on demand.
  If agents skip `visuals.guide`, pages will look worse, not break. Users who don't want the feature
  turn it off in Settings, which removes the cost.
- **Compaction** can drop the guidance from a long conversation. The agent can still run `--help` or
  `visuals.guide`. If this proves common, resend the block after a compaction event.
- **Prompt-injected pages.** See the security summary. The residual risks are beacons and CPU burn.
- **Layout loops** from `100vh`: the guide forbids it, the 2000 clamp holds, and the runaway guard stops
  growth.
- **Scroll jumps** when a page resizes above the reader: `useTurnScrollAnchor` already handles turns
  above the viewport changing height. Phase 0 confirms it with a frame.
- **Huge pages.** A 25 MiB page in a frame is slow to load. `loading="lazy"` and `content-visibility`
  help, and the limit is the backstop.

## Open questions for the owner

None. Decisions 2, 3, 6 and 13 were agreed on 2026-10-09.

## Future ideas (not planned)

Ideas the owner wants recorded, with no work scheduled:

- **Visuals in habit-run reports.** Habit runs cannot publish today, because their sessions are not
  persisted (B9 refuses them). If they are allowed later, a visual from a habit run could travel with
  the run's report into the Mono chat. Artifact cards already work this way: they "accompany the final
  report only if it is posted" (`monoFiles.ts:342`). The page file would then need to move or be
  copied from the habit run's session folder to the Mono chat's folder, since the run's folder is not
  kept.

## Changes from rev 1

Rev 1 was checked line by line against the code; these were wrong or missing:

1. **Placement by `createdAt`** could not work: blocks have no timestamps. Replaced by a `visual` block
   appended through the harness event queue, following generated images.
2. **"Visuals on the assistant block"**: artifact cards actually live on the *user* block. Moot now,
   since visuals are their own blocks.
3. **Persistence gap:** `sanitizeBlock` copies only known fields, so a new field would have been
   silently dropped on save. B8 adds `sanitizeVisual`.
4. **`request_grant` cannot see the action**, so "an exception for `visuals.*`" needed a signature
   change. B1 adds it, with tests.
5. **Leads and workers** never get an app token, and the App-level gate refuses them. Rev 1 implied all
   sessions; v1 now states they are out.
6. **No fork or duplicate exists** in MonoCode. The copy-on-fork step and the orphan sweep are removed.
   The cleanup is one call in `session_delete`.
7. **`ArtifactPanel` is Mono-only**, so "expand to the side panel" had no home in ordinary sessions. It
   is now a portal viewer that works in both windows.
8. **Windows** reaches custom schemes as `http://<scheme>.localhost`. Rev 1 missed it.
9. **Column width** is about 864px, not 720px.
10. **Custom off-screen unmounting** fought the existing `content-visibility` and scroll-anchor
    machinery, and lost interactive state. Replaced by `loading="lazy"`.
11. **Height semantics** were contradictory (initial size vs cap). Now `height` is the initial box and
    `maxHeight` is the optional cap.
12. **Theme race:** a change between mount and load was lost. The theme is now re-sent on `load`.
13. **Bootstrap duplicated** in Rust and TS. Now one JS asset, injected at serve time and checked against
    the TS constants by a test.
14. **A 404 in an iframe fires no `error` event**, so rev 1's failure state could not trigger. Missing
    pages are now a themed 404 page.
15. **`allow-forms` with `form-action 'none'`** looked redundant. It is kept on purpose so submit
    handlers run.
16. **Missing `Referrer-Policy`** would have leaked session ids to CDNs.
17. **Habit runs** are not persisted, and **remote sessions** read files on another machine. Both now
    get explicit errors.
18. **The guidance** was a ~220-token block on every session. It is now ~90 tokens plus an on-demand
    `visuals.guide`.
19. **Mobile and web mocks** were not covered. Added the mock kit, the viewer width presets, the iOS
    WebKit bridge in the bootstrap, and the iOS app step.

## As built

(Empty. The implementing agent records deviations, spike results and manual QA here.)
