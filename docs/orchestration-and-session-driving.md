# Orchestration and session driving

This document records the changes on branch `feat/session-driving` (October 2026). They cover two ways one agent controls others in MonoCode:

- **Operator** (`/operator`, the `monocode app` CLI): an agent drives other sessions in the same project.
- **Orchestrator** (`/orchestrator`, the `monocode control` CLI): a lead agent plans work, delegates it to workers in isolated checkouts, reviews it and integrates it.

The goal was to make both feel like [herdr](https://herdr.dev/docs/agent-automation/)'s small command set for driving agents: start, prompt and wait, read, answer when blocked. Herdr's mechanics were not copied. Herdr only sees a terminal, so it infers state from the screen and reads replies back as terminal text. MonoCode already has structured session state and transcripts, so it reports exact turn states and returns the agent's actual final message.

## Summary

| Area | Before | After |
|---|---|---|
| Waiting on another session (operator) | Not possible; the agent had to poll `busy` | `sessions.wait`, and `sessions.send` with `wait` |
| Session state (operator) | `busy: true/false` | `idle`, `working`, `blocked` (with `needsInput`), `usageLimited` |
| Approvals and questions (operator) | Hidden; only the user could answer | `sessions.respond` / `sessions.answer` for sessions the operator started |
| Redirecting a running session (operator) | Rejected as busy | `sessions.steer` |
| Reading results (operator) | 3 exchanges, 1,200 characters per message by default, 6,000 max | `sessions.read {turnId}` returns one turn's final message; up to 20,000 characters |
| Hearing about finished work (operator) | Not possible | `notify: true` wakes the operator when the turn settles |
| Addressing sessions (operator) | `app-<id>-<uuid>` IDs | Optional `name` on `sessions.start`, accepted wherever a session ID is |
| `review` of isolated workers (orchestrator) | Always failed: "no recoverable change checkpoint" | Works, including for edits made with shell commands |
| Write-scope enforcement (orchestrator) | Edit-tool events only; shell writes went unnoticed | Also checked against the worker's whole change when its turn ends |
| Cancelled dependency (orchestrator) | Dependents waited forever | Dependents are held as blocked with a reason |
| Cancelling an accepted task (orchestrator) | Allowed; its changes silently stayed in the lead's checkout | Refused with an explanation |
| Lead commits during a run (orchestrator) | Every later `review` failed with "branch moved" | Allowed; a worker commit is still refused |
| Lead edits to files a worker owns (orchestrator) | Found out at `review` | Reported as `warnings` in `list` and `wait` as soon as it happens |
| `delegate` options (orchestrator) | No effort or model settings | `effort` and `modelSettings`; `list` shows the allowed values |
| `wait` / `list` size (orchestrator) | Whole run, up to 20,000 characters of result per task, plus run history | Changed tasks only (with `since`), results cut to their last 2,000 characters, run history dropped |

## Operator: driving other sessions

### Session state

Every session the operator can see now reports one state:

- `idle`: ready for a prompt.
- `working`: running a turn, or holding queued follow-ups that will run on their own.
- `blocked`: waiting on an approval or a question. `needsInput` gives the request ID, a label, the command or detail, and any question options.
- `usageLimited`: stopped at a provider usage limit. `usageLimitResetsAt` gives the reset time when the provider reports it.

`sessions.list` and `sessions.read` include the state. Waits can also target one turn. A turn is finished once a later turn has started, even while that later turn is still running. Steering messages join the turn they were sent into rather than starting a new one.

### New and changed actions

| Action | Input | Behavior |
|---|---|---|
| `sessions.list` | `{}` | Adds `state` to each session, and `name` for sessions this operator named. |
| `sessions.read` | `{"sessionId","before","limit","maxChars"}` | Adds `state`, `needsInput` and `latestTurnId`. `maxChars` now allows 200 to 20,000 (default 1,200). |
| `sessions.read` | `{"sessionId","turnId","maxChars"}` | New mode: one turn's prompt and the agent's final message (default 8,000 characters). Replies that followed a steering message count toward that turn. |
| `sessions.send` | `{"sessionId","prompt","wait","notify"}` | Returns the new `turnId`. A `working` or `blocked` target is refused with what to do instead. `wait: true` (or `{"timeoutSeconds","until"}`, up to 20 seconds) returns once that turn settles, with its final message when it is idle. `notify: true` asks to be woken when the turn settles. |
| `sessions.wait` | `{"sessionId","turnId","until","timeoutSeconds"}` | New. Blocks until the session, or one turn, reaches a state in `until` (default `idle`, `blocked`, `usageLimited`), or until the timeout (0 to 25 seconds, default 20). `matched: false` means it timed out. A settled turn includes its final message. |
| `sessions.wait` | `{"sessionIds":[...],...}` | New. Waits on up to 8 sessions and returns when any of them reaches a state in `until`. |
| `sessions.steer` | `{"sessionId","prompt"}` | New. Guides a running turn without discarding its progress. Refused when the session is idle or blocked. |
| `sessions.respond` | `{"sessionId","requestId","decision"}` | New. Allows or denies an approval. |
| `sessions.answer` | `{"sessionId","requestId","answers"}` or `{"skip":true}` | New. Answers a question. |
| `sessions.start` | adds `"name"`, `"notify"` | `name` (a lowercase letter, then up to 31 lowercase letters, digits, `-` or `_`) gives the session the ID `app-<operator>-<name>`, so later calls can use the name. A name the operator already used is refused. `notify: true` wakes the operator when the launch turn settles. `besideSessionId` also accepts a name. |

`sessions.respond` and `sessions.answer` only work on sessions the operator itself started. Sessions the user started are answered by the user in MonoCode. A stale `requestId` is refused.

When a `sessionId` value looks like a name, MonoCode first looks for a session this operator named that way, and otherwise uses the value as an ID. This keeps short IDs working.

### Wake-ups (`notify`)

With `notify: true` on `sessions.start` or `sessions.send`, the operator can end its turn. When the watched turn finishes, gets blocked, stops at a usage limit, or its session closes, MonoCode starts a turn in the operator with the result. This is the same mechanism a lead uses to hear from its workers.

- Results are delivered only while the operator is idle: not busy, with no queued messages, draft, usage limit or pending provider switch.
- A blocked turn is reported once per request and stays watched until it ends.
- Each finished turn's final message is included, up to 3,000 characters, with a pointer to `sessions.read` for the rest.
- An operator gets at most 20 automatic wake-ups between two messages from the user. After that MonoCode stops and says so in the conversation.
- A wait that already saw a turn settle cancels that turn's wake-up, so the operator is not told twice.
- Wake-ups are skipped for sessions that lead an orchestration run and for checkouts an orchestrator controls. Wake-up turns are internal turns, which would otherwise skip that guard.
- An operator holds at most 32 watched turns; the oldest give way to new ones.

### Timing limits

The CLI waits up to 40 seconds for a reply and the app relay up to 35 seconds. `sessions.wait` is therefore capped at 25 seconds and the waiting part of `sessions.send` at 20 seconds. Longer work should use repeated waits or `notify`.

## Orchestrator: fixes and changes

### How worker changes are reviewed and integrated

This replaces the previous model, under which `review` always failed for isolated workers.

1. **Baseline.** On a worker's first turn, MonoCode records its checkout's starting state: the files the lead's uncommitted changes were seeded into it, at their seeded contents. Later turns keep that baseline. Previously this step was skipped for every orchestration session, so workers never had a baseline.
2. **Capture when a turn ends.** When a worker's turn completes, MonoCode records every change in its checkout since the baseline. That includes edits, new files and deletions made by shell commands (`sed -i`, heredocs, scripts), not just edits that came through edit tools. The checkout belongs to that worker alone, so its whole change is the worker's. Files ignored by git, such as `node_modules`, are not included.
   - A file that was unchanged at the baseline is compared against HEAD.
   - A file that was seeded is compared against its seeded contents.
   - Per-edit tracking is no longer used for orchestration sessions. It recorded a file's state at its first edit, which could replace the baseline and make a later review report a conflict that did not exist.
3. **Scope check.** The captured change is checked against the task's write scope. A worker that changed files outside it is held as `blocked` instead of `completed`, with the files listed. The existing live check on edit-tool events still stops a worker the moment an edit tool writes outside its scope.
4. **Capture failure.** If the change cannot be recorded, the task is held as `blocked` with the reason and the checkout path. This happens for a worker that started before this change (it has no baseline) and for more than 500 changed files. A change that touches a symbolic link or a file too large to snapshot is recorded, but `review` refuses it and keeps both checkouts, as before.
5. **Review.** `review` refreshes the capture, then applies the change to the lead's checkout. Before writing, each file in the lead's checkout must still match the worker's starting state; otherwise the review is refused and both sides are kept, as before.
6. **Commits.** The lead's branch may now move forward. A worker is integrated as long as the lead's history still contains the worker's starting commit, which allows commits by the lead between reviews. A commit made by the worker is still refused, so cleanup can never discard it. The same rule applies when worker checkouts are cleaned up.

### Other changes

- **Cancelled dependencies.** A queued task whose dependency was cancelled is held as `blocked` with an explanation, whether or not a worker slot is free, and the lead is told. Sending it the full assignment with `message`, or retrying it with `retry`, runs it without the cancelled dependency. Previously such a task waited forever, because a cancelled task is never accepted.
- **Cancelling accepted work.** `cancel` refuses a task that was already accepted, because its changes are already in the lead's checkout. Cancelling running or queued tasks is unchanged.
- **Lead edits.** When the lead edits a file that a started, unreviewed worker owns, `list` and `wait` include a `warnings` entry saying that worker's review will refuse the file. The warning disappears once that worker is accepted or cancelled.
- **`delegate` options.** `delegate` accepts `effort` and `modelSettings`, validated against the model's options. `list` shows each model's settings and allowed values.
- **Smaller `wait` and `list` responses.**
  - Both return a `revision` number.
  - `wait {"since": <revision>}` returns at once if anything changed after that revision, and then lists only the changed tasks plus tasks waiting on the lead, with `unchangedTasks` counting the rest.
  - Revisions start from the clock, so a revision the lead kept from before an app restart is older than every later change.
  - Results in `list` and `wait` are cut to their last 2,000 characters, with `resultTruncated: true`; `get` returns the full result.
  - Run history (`dispatches`) is no longer included.

## Instructions agents receive

- **Operator turn (`<monocode_app>`):** previously it told the agent not to wait for sessions it started. It now explains how to delegate and use the result: name the session, follow it with `sessions.wait` or `sessions.send` with `wait`, or pass `notify: true` and end the turn. It also says how to decide blocked requests and when to use `sessions.steer`.
- **Lead turn (`<monocode_orchestration>`):** it now says to pass the last `revision` as `since`, and that `list` and `wait` show the end of each result while `get` returns it in full.
- **CLI help (`monocode app --help`, `monocode control --help`):** documents every action above, the session states, names, timing limits, cancelled dependencies, the rule on cancelling accepted tasks, and lead-edit warnings.

## Files changed

| File | Change |
|---|---|
| `src/features/agent-app/model/agentApp.ts` | New operator actions, name resolution, state reporting, the wait loop, send-and-wait, `notify` registration |
| `src/features/agent-app/model/sessionState.ts` (new) | Session and turn states, turn lookup |
| `src/features/agent-app/model/sessionConversation.ts` | One-turn reader; read cap raised to 20,000 characters |
| `src/features/agent-app/model/operatorWatches.ts` (new) | Watched turns, wake-up notices and their text, seen-tracking, limits |
| `src/features/agent-app/model/changeFeed.ts` (new) | Revision counter that waits can block on |
| `src/features/notifications/model/approvalToast.ts` | Shared approval/question detail (`pendingInputForSession`) |
| `src/features/sessions/model/models.ts` | Shared validation for `effort` and model settings |
| `src/features/sessions/model/checkpoint.ts` | `captureWorkerCheckout`, `workerBaseIntact` |
| `src/features/orchestration/model/orchestration.ts` | Settle-time capture and scope check, cancelled dependencies, cancel guard, lead-edit warnings, `delegate` options, revisions and `since`, result previews |
| `src/app/App.tsx` | Worker baseline, host wiring for the new operator actions and worker capture, the shared steer function, wake-up delivery, prompt text |
| `src-tauri/src/checkpoint.rs` | Whole-checkout capture, HEAD-based baselines (including the execute bit), the lead-commit-tolerant base check |
| `src-tauri/src/lib.rs` | Registers the two new checkpoint commands |
| `src-tauri/src/control_cli.rs` | Help text and the operator action allowlist |

## Tests

New or extended:

- `src/features/agent-app/model/sessionDriving.test.ts` (new): states and turn states, names, refusals for working and blocked targets, retry of a started turn, send-and-wait, a submission that lands after acceptance, multi-session wait and timeouts, steer, respond and answer limited to the operator's own sessions, wake-up notices and seen-tracking, watch limits, the change feed.
- `src/features/orchestration/model/orchestration.test.ts`: cancelled dependency held, including while every worker slot is busy; `delegate` with `effort`; revision cursor and previews; whole-change scope check and capture failure; cancel refused after review; lead-edit warning.
- `src/features/agent-app/model/agentApp.test.ts`: fixture updated for the new host methods.
- `src-tauri/src/checkpoint.rs`: shell edits (change, delete, create, edit a seeded file, revert) captured and integrated; an executable file's baseline matches the lead's copy; integration survives a lead commit but refuses a worker commit.
- `src-tauri/src/control_cli.rs`: the operator action allowlist test covers the new actions.

At the time of writing, typecheck, the full web suite (4,565 tests), the Rust tests and clippy pass.

## Verification status

Everything above is covered by unit tests only. **The app has not been run end to end with these changes.** Recommended manual checks:

1. Start an orchestration with two workers. Have one edit a file with its edit tool and the other with a shell command (for example `sed -i`). `review` both and confirm the changes appear in the lead's checkout.
2. Have a worker write a file outside its scope with a shell command and confirm it ends `blocked` with that file named.
3. Commit in the lead's checkout between two reviews and confirm the second review still works.
4. In an `/operator` session, start a named session with `notify: true`, end the turn, and confirm the operator is woken with the result.

## Known limitations

- **Workers started before this change** have no baseline. Their tasks are held as `blocked` with their checkout path; integrate those by hand and cancel the task.
- **Keep in a worker's review panel** removes the file's baseline. A later review of that worker then compares the file against HEAD and may report a conflict. This fails safely.
- **Mode bits on HEAD-based baselines** are derived the way a checkout derives them (the app's umask, plus execute bits). If the lead's checkout was created with a different umask, a review can report a conflict on that file. This fails safely.
- **Watched turns for `notify`** are kept in memory and lost if the app restarts.
- **Lead-edit warnings** cover the lead's edit-tool writes, not its shell commands. They are also kept in memory only.
- **The 500-file capture limit** blocks very large worker changes from review; integrate those by hand.

## Not done

- **One command set for both modes.** Making `control` a policy layer (worktrees, write scopes, review, the dependency graph) on top of the operator commands. Until then a session that leads an orchestration run cannot use the operator commands.
- **`wait {taskId}` in `control`.** `since` narrows what `wait` returns, but `wait` still returns on any change in the run rather than on one task's turn.
- **Queueing on a busy session.** `sessions.send` to a busy session is refused; there is no `queue: true` option.
- **herdr's prompt stall check.** The operator side finds the new turn for up to 2 seconds and otherwise returns `turnId: null` with a note. The orchestrator's `message` and `steer` have no stall check because MonoCode already reports whether a turn was accepted.
