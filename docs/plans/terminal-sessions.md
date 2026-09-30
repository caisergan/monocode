# Terminal sessions: run a session in the agent's own CLI

Branch `feat/terminal-profiles`, worktree `.worktrees/terminal-profiles`.
Written 2026-09-30. Nothing is implemented yet.

## Goal

A MonoCode session can run in one of two surfaces:

- **Chat** (today): MonoCode drives the agent over its protocol and renders its own transcript.
- **Terminal** (new): the session's pane is a terminal running the agent's real CLI (`claude`, `codex`),
  like Paseo's session tabs.

It is the same session either way. It has one sidebar row, one title, one provider conversation, and one
transcript in MonoCode's history. You can start a session in the terminal, or move an existing session
between the two surfaces.

## Decisions (agreed 2026-09-30)

| # | Decision |
|---|----------|
| 1 | Terminal sessions **do** appear in MonoCode's chat history. The CLI's transcript file is read back into the session's blocks. |
| 2 | v1 supports **Claude Code and Codex** only. Other providers keep chat only. |
| 3 | **No user-defined profiles.** There is no Settings UI for custom commands, args or env. The launch command is built in, per provider. |

"Profile" in the branch name means the built-in per-provider launch recipe. It is not a user-facing concept.

## What exists today

Paths and line numbers are from `main` at `6ffc995`, unless marked **[import]**, which means
`fix/import-filter-menu-layer` at `5b31eed`.

**Terminals**
- `src-tauri/src/pty.rs`: `pty_spawn(id, cwd, cols, rows)` always runs `default_shell()` (`:472`). It
  cannot run a given command. A second spawn with the same id kills the first (`:139`).
- `src/platform/tauri/pty.ts`: `spawnPty`, `writePty`, `resizePty`, `getPtyStatus`, `killPty`. Output that
  arrives while no view is subscribed is buffered for replay, up to 256 KB (`:24`).
- `src/features/terminal/ui/TerminalView.tsx`: props are `{ id, cwd, active, onMetaChange }`. It spawns on
  mount (`:246`) and **kills the PTY on unmount** (`:366`).
- Terminal tabs are `FilePaneTab` with `terminal: true` (`src/features/workspace/model/layout.ts:77`).
  `terminalClose.ts` confirms closing a terminal whose foreground process is not the shell.

**Sessions**
- `Session` (`src/features/sessions/model/session.ts:391`) has `harness`, `model`, `modelSettings`,
  `runtimeMode`, `providerSessionId`, `providerAccountId`, `cwd`, `worktreeCwd`, `blocks`.
- A workspace leaf renders `SessionPane` (`src/features/workspace/ui/PaneTree.tsx:459`).
- Persistence is `session_upsert` / `SessionUpsert` (`src-tauri/src/session_store.rs:98`). New columns are
  added with `ensure_session_column` (`:616`).

**Chat launch, which the terminal launch must mirror**
- Claude: args come from `claudeProtocol.ts:251-288`. A new conversation passes `--session-id <uuid>`; a
  resumed one passes `--resume <id>`. `runtimeModeToPermission` (`:111`) maps the runtime mode.
- Codex: runs `codex app-server` and calls `thread/start` or `thread/resume` (`codex.ts:520-588`).
  Approval and sandbox settings per runtime mode are in `codexProtocol.ts:60-95`.
- Accounts: `apply_provider_account` (`src-tauri/src/harness.rs:665`) sets `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME`.
- Binaries: `resolve_claude()` (`harness.rs:1780`), `resolve_codex()` (`:1719`),
  `resolve_configured_harness_binary` (`:1667`), and `gui_search_path()` (`:2051`) for a GUI-safe `PATH`.
- Stopping a chat child: `stopHarnessSession` (`src/integrations/harness/core/registry.ts:340`).

**Reading CLI transcripts [import]**: not on `main` yet
- `src-tauri/src/agent_sessions/{mod,claude,pi}.rs`: `agent_list_sessions`, `agent_read_session`. Claude
  transcripts are found under `~/.claude/projects/<encoded cwd>/<id>.jsonl`.
- `src/integrations/harness/core/transcriptImport.ts`: `TranscriptReplay` replays transcript records through
  the same `HarnessEvent`s the live adapter emits.
- `src/integrations/harness/providers/claude/claudeImport.ts`: `claudeTranscriptToSession`.
- Three gaps matter here:
  1. There is no Codex reader. `IMPORTABLE_HARNESSES` is `claude`, `pi`, `omp`.
  2. Only the default config directory is scanned, not named account profiles (`mod.rs:6-8`).
  3. Replayed blocks get random ids (`transcriptImport.ts:126`, `apply.ts`), so replaying twice gives
     different ids.

**Installed CLIs checked on this machine**: `claude` 2.1.285 and `codex-cli` 0.157.1.
- `claude` accepts `--resume`, `--session-id`, `--model`, `--effort`, `--permission-mode`, `--name`.
- `codex resume [SESSION_ID]` exists. `codex` accepts `-m`, `-s`, `-a`, `-C`.
- Codex saves `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`. The first record is
  `session_meta` with `id`, `session_id` and `cwd`. Later records are `turn_context`, `response_item`
  (`message`, `reasoning`, …) and `event_msg` (`task_started`, `task_complete`, `token_count`, …).

## Base branch

Decision 1 needs the transcript reader, which only exists on `fix/import-filter-menu-layer`. That branch
sits directly on current `main`; this branch is 61 commits behind `main` with no commits of its own.

**Plan: reset this branch onto `fix/import-filter-menu-layer` and stack on it.** If the import work lands on
`main` first, rebase onto `main` instead. Steps 1 to 5 do not touch import code, so they could be split
into their own PR against `main` if the import branch is slow to merge.

## Design

### 1. Data model

```ts
// session.ts
export type SessionSurface = "chat" | "terminal";

export type Session = {
  …
  /** Where the session runs. Absent means "chat". */
  surface?: SessionSurface;
  /** Transcript records already turned into blocks while in the terminal. */
  terminalSync?: { afterRecord?: string; syncedSize: number };
};
```

- Add `surface TEXT` and `terminal_sync TEXT` columns with `ensure_session_column`, and the matching fields
  on `SessionUpsert`, `SessionRecord` and `SessionSummary`. The sidebar needs `surface` from the summary.
- No change to `FilePaneTab` or the workspace snapshot. The leaf is still the session id, and the session
  decides how it renders.

### 2. Launch

TypeScript builds the args, because the runtime-mode mappings already live there and are tested there.
Rust picks the binary, so the webview never names an executable.

```rust
// pty.rs
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyLaunch {
    harness: String,                      // "claude" | "codex", anything else is rejected
    args: Vec<String>,
    provider_account_id: Option<String>,
}
pub fn pty_spawn(…, launch: Option<PtyLaunch>) -> Result<(), String>
```

- `launch: None` keeps today's behaviour exactly.
- With a launch, the binary comes from the same resolver the chat path uses, including the user's
  configured binary override. The account env is applied the way `apply_provider_account` does it. `TERM`,
  `PATH`, `setsid` and the kill path stay shared with the shell branch, on both `spawn_unix` and
  `spawn_windows`.
- If the CLI is missing, return the same "not found, install it" message the chat path shows.

New file `src/integrations/harness/core/terminalLaunch.ts`, with one builder per provider:

| | New conversation | Resume |
|---|---|---|
| Claude | `--session-id <uuid>`, where MonoCode makes the uuid and stores it as `providerSessionId` before spawning | `--resume <providerSessionId>` |
| Codex | no id argument; the id is found afterwards (see 5) | `resume <providerSessionId>` |

Both add the model, the effort where the provider has one, and the runtime mode:
- Claude: `--permission-mode` from `runtimeModeToPermission`.
- Codex: `-a` and `-s` from the table in `codexProtocol.ts`.

Not passed: the chat path's `--settings` JSON (MonoCode's hooks and approval plumbing). In the terminal the
CLI asks for approvals itself.

To verify in step 2: that `codex resume` takes `-m`, `-s` and `-a`, and that the thread id MonoCode gets
from `thread/start` is the id `codex resume` expects.

### 3. PTY lifetime

The agent must keep running when its tab is not on screen, so the PTY belongs to the session and not to the
view.

- PTY id is `session:<sessionId>`, so a remounted view finds the same PTY.
- `TerminalView` gets `launch?: PtyLaunch` and `persistent?: boolean`. When persistent:
  - on mount, attach if the PTY is alive (`pty_status`), replay the buffer, then nudge a resize so the TUI
    redraws; spawn only if it is not alive;
  - on unmount, unsubscribe but do not kill.
- The PTY is killed when: the session's tab is closed, the session is archived or deleted, the surface is
  switched to chat, or the app quits (`PtyHost::kill_all` already does this). Closing a tab with a live
  agent asks first, reusing `confirmCloseTerminal`.
- After an app restart nothing is running. A terminal session spawns again with its resume args **only when
  its pane first becomes visible**, so startup does not launch every CLI at once.
- When the CLI exits, the pane shows `[process exited]` with two actions: **Restart** and **Open as chat**.
  It does not drop to a shell.

### 4. One driver at a time

A provider conversation must never have the chat child and the terminal CLI writing to it together.

- **Chat → terminal**: refused while `session.busy`, with a "Stop and open in terminal" option. Otherwise
  call `stopHarnessSession`, record the sync cursor (see 5), set `surface: "terminal"`, and spawn.
- **Terminal → chat**: if the PTY is alive, confirm, then kill it, run a final sync, and set
  `surface: "chat"`. The next chat turn resumes through `providerSessionId`, the way an imported session
  does today.
- A session with `workspaceMode: "worktree"` that has not created its worktree yet creates it before the
  first spawn, through the same path the first chat turn uses. The spawn cwd is `sessionWorkCwd(session)`.

### 5. Transcript sync

**Reading**
- Extend `agent_read_session` to take an optional `providerAccountId` and read from that account's
  directory, closing gap 2.
- Add `agent_session_stat(harness, cwd, sessionId, providerAccountId)` returning `{ size, modifiedAt }`, so
  polling does not parse the file.
- Add `src-tauri/src/agent_sessions/codex.rs` (find by id under `sessions/**`, slim records, summary) and
  `src/integrations/harness/providers/codex/codexImport.ts` (replay through `TranscriptReplay`). This also
  lets the import sheet list Codex sessions, by adding `codex` to `IMPORTABLE_HARNESSES`.

**Finding a new Codex conversation's id**
- After spawning `codex` with no id, look for a rollout file created after the spawn time whose
  `session_meta.cwd` is the session's cwd, and store its id as `providerSessionId`. Retry for a short
  while, since the file appears with the first prompt. Until it is found, the session has no history and a
  restart starts a fresh conversation.

**Merging into the session**
- Blocks that existed when the session moved to the terminal are left alone. They hold things a transcript
  replay cannot rebuild, such as checkpoints and plan blocks.
- `terminalSync.afterRecord` is the id of the last transcript record at that moment. Each sync replays only
  the records after it and replaces the blocks after the frozen prefix.
- If that record is no longer in the active chain (the user rewound inside the CLI), replay the whole
  transcript and replace all blocks.
- A session that started in the terminal has no prefix, so its blocks are the full replay.
- Replayed block ids become deterministic, derived from the record id, closing gap 3. Without this every
  sync would remount the transcript.
- The title is taken from the transcript only while `canReplaceSessionTitle` allows it.

**When**
- While the PTY is alive: check `agent_session_stat` every 5 s and read only when the size changed.
- Always on PTY exit, on switching to chat, and once at startup for sessions saved with
  `surface: "terminal"`.
- Every sync ends in `upsertSession`, so search and history work without extra code.

### 6. UI

- **Pane**: `SessionPane` renders a new `SessionTerminal` (a thin wrapper around `TerminalView`) instead of
  the transcript and composer when `surface === "terminal"`. The session header stays.
- **Starting one**: an "Open in terminal" action on the empty session, shown only when the chosen provider
  is Claude or Codex. It creates the session and spawns the CLI with no first prompt.
- **Switching**: "Open in Terminal" / "Open as Chat" in the session menu and the command palette, plus an
  entry in the keybinding table (`src/features/settings/model/settings.ts:944`).
- **Marking**: a terminal glyph before the title on the tab and the sidebar row, as in the Paseo screenshot.
- **Unavailable in the terminal surface**: composer, message queue, handoff, second opinion, plan build,
  and checkpoint revert. Edits made by the CLI are not captured in MonoCode checkpoints, so the per-session
  changes view does not include them. Source control still shows them.

## Steps

Each step builds and passes tests on its own.

0. **Base.** Reset the branch onto `fix/import-filter-menu-layer`. Run `npm ci` (this worktree has no
   `node_modules`, and the pre-push hook needs it).
1. **PTY launch.** `PtyLaunch` in `pty.rs` for unix and windows; `spawnPty(…, launch?)` in `pty.ts`.
   Rust tests: unknown harness rejected, account env applied, `None` unchanged.
2. **Launch builders.** `terminalLaunch.ts` with tests in the style of `claudeProtocol.test.ts`: new vs
   resume, each runtime mode, model and effort. Settle the two Codex checks from Design 2.
3. **Model and storage.** `surface` and `terminalSync` on `Session`, the columns, upsert and read, and the
   summary field. Migration test: an old row reads back as chat.
4. **Session terminal.** `persistent` and `launch` on `TerminalView`; `SessionTerminal`; the `SessionPane`
   branch; spawn on first visibility; kill points; exit actions.
5. **Switching.** Chat ↔ terminal with the busy guard, stop, confirm and worktree preparation.
6. **Claude sync.** Account-aware read, `agent_session_stat`, deterministic block ids, prefix merge,
   triggers.
7. **Codex.** `codex.rs`, `codexImport.ts`, id discovery, sync. Add Codex to the import sheet.
8. **UI.** Entry points, glyphs, keybinding, hiding what does not apply.
9. **Finish.** Windows pass, `CHANGELOG.md`, README mention.

Steps 1 to 5 give a usable terminal session without history. Steps 6 and 7 deliver decision 1.

## Tests and checks

- `npm run check:web` (vitest and `tsc --noEmit`) and `npm run check:rust` (fmt, clippy, tests).
- New unit tests: launch builders; `surface` round trip; prefix merge, including the rewound-transcript
  fallback and stable ids across two syncs; Codex record replay from a fixture; Codex id discovery picking
  the right file among several.
- Tests that spawn git must strip `GIT_*` from the environment, or the pre-push hook makes them commit into
  the real repository.
- By hand, in the running app, for Claude and then Codex:
  1. Start a session in the terminal, send a prompt, and see it appear in history and search.
  2. Switch workspace tabs and come back: the agent is still running and the screen is intact.
  3. Quit and reopen: the session resumes the same conversation when its tab is shown.
  4. Switch to chat and send a turn, then switch back to the terminal: the same conversation continues both
     ways, and earlier chat blocks are unchanged.
  5. Repeat 1 with a named provider account.
  6. Close the tab while the agent is working: a confirmation appears.

## Not in v1

- User-defined profiles (decision 3).
- Providers other than Claude and Codex.
- A busy indicator, "needs input" state, or finish notification for terminal sessions.
- Sending a prompt into the terminal from MonoCode's composer.
- MonoCode checkpoints and per-session diffs for edits made in the terminal.

## Risks

- **Transcript formats are private to each CLI** and can change with a CLI update. The readers should skip
  records they do not understand rather than fail the sync.
- **Large transcripts.** `agent_read_session` refuses files over its size limit. A long terminal session
  could pass it; sync then stops updating and must say so in the pane, not fail silently.
- **Codex id discovery can pick the wrong file** if two Codex sessions start in the same folder at the same
  moment. Matching on spawn time and cwd makes this unlikely; preferring the file that is not already bound
  to another MonoCode session removes most of what is left.
- **Two writers.** Nothing stops a user from resuming the same conversation in an outside terminal while
  MonoCode has it open. That is already true for chat sessions and is not addressed here.
