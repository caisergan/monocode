# Master (native)

Master is one built-in agent that directs sessions in every local project. The
user gives it a task; it reads sessions, proposes a plan, and once the user
starts the plan it messages or starts the sessions that do the work, reads what
they report, and ends with commits and a report. It never edits files itself.

The clickable design is `docs/native/master-mock/index.html` (version 2, 31
screens; `build.py` rebuilds it from `screens.js` and `tpl.html` with the app's
own icons). This page records the decisions and how the engine works.

## Decisions

- One Master, not a Mono and not a slash command. It is off until set up.
- Runs on Pi (the default, with DeepSeek) or Claude Code, and has no shell
  and no edit tool on either. Pi gets a `monocode` tool from a bundled
  extension and only read tools (`--no-mcp -e <ext> --tools
  read,grep,find,ls,monocode`). Claude Code gets `--tools Read,Glob,Grep`,
  the `monocode_app` MCP server started as `app-mcp master` (the same `app`
  tool, describing Master's actions), `--strict-mcp-config` so none of the
  user's own MCP servers load, and those tools pre-allowed, so it never asks.
  Other providers would hand Master a shell, so MonoCode refuses to launch it
  there until they have a route.
- Reaches every local project except those the user excludes. Remote projects
  are not supported yet. Sessions in an excluded project cannot be listed,
  searched, read or messaged.
- Nothing runs before the user starts a plan. A plan lists steps; each step
  names its project, where it runs, its model and its access. MonoCode, not the
  model, refuses anything outside the approved plan: a new session, a new
  project or a higher access comes back as a plan change the user decides.
- Access per plan: Supervised, Auto (default) or Full access. Master's turns in
  a session run with the step's access, whatever the session's own setting;
  the user's own turns keep the session's setting. Pi sessions never ask, and
  the plan says so.
- Where a step runs: a session already in its own worktree is messaged. A
  session in the main checkout is continued in a new worktree session with the
  recap of the original (the default), so the user's checkout is never written
  by Master. Messaging a main-checkout session is a choice only the user can
  make on the plan card.
- One writer per checkout: a step waits while another session works in its
  checkout, the user's included.
- Master's messages go through the session's message queue: behind the user's
  turn and the user's own queued messages, never into the composer draft. It
  steers only turns it started.
- Master wakes only for sessions it drives: when one finishes, stops, fails,
  hits a usage limit or asks. Updates in a row fold into one turn. After 60
  updates without a message from the user, Master pauses.
- Approvals: a request matching the safe list (exact commands, per project,
  never chained) may be allowed by Master; everything else is the user's.
  Push, delete, deploy and commands that reach another machine can never be on
  the safe list. Questions the plan already settles may be answered by Master.
- Ends at commits and a report. Pushing and opening pull requests wait for the
  user's confirmation.
- Pause Master stops new messages for every task; running turns finish and
  updates are kept. Tasks, updates and the activity log survive a restart;
  after one, nothing reruns by itself.

## Engine (step 1)

Step 1 is the engine and the tool, without the Master page.

- `monocode-core/src/master.rs`: configuration, tasks and plans, the rules
  (project scope, plan checks, access cap, safe list, one writer per checkout),
  updates and the wake-up text, and the saved state. Pure logic with tests.
- `monocode-gpui/src/shell/master.rs`: the `master.*` actions for the Master
  session, observing driven sessions with `orchestration::observe`, delivering
  updates, and saving state.
- Messages carry a sender (`follow_up::Message::sender`) and may carry an
  access override; a turn's receipt (`agent::TurnInfo::sender`) keeps who
  started it, so Master knows whose turn is running and the transcript can
  label Master's messages.
- State is saved as two settings rows, `master.config` and `master.state`,
  instead of new tables, so no schema migration is needed.

### Actions

The Master session calls `master.ACTION` with a JSON input (Pi: the
`monocode` tool; others: the MCP `app` tool or `<cli> app ACTION --json`).
`master.help` (or `app help master`) prints the reference.

| Action | Does |
|---|---|
| `master.projects {}` | Included projects with their session counts. |
| `master.sessions {project?, query?, limit?, offset?}` | Sessions across included projects, newest first: title, project, checkout (main or its worktree), branch, busy, harness, model, access, and the task driving it. |
| `master.search {query, project?, limit?}` | Message text search across included projects, the app's session search. |
| `master.read {sessionId, view?, before?, limit?, maxChars?}` | A session's latest turn (`activity`), its final message (`last`) or earlier exchanges (`history`). |
| `master.plan {title, access?, steps}` | Propose a plan. Each step: `title, project, target (new, message or continue), sessionId?, prompt, harness?, model?, effort?, access?, after?`. Nothing runs until the user starts it. |
| `master.change {task, reason, steps?, access?}` | Propose a change to a running plan: more steps, another project or a higher access. The rest keeps running. |
| `master.start {task, step}` | Start a step of a started plan whose `after` steps are done. Steps without `after` start when the user starts the plan. |
| `master.message {task, step, prompt, mode?}` | Send the step's session a follow-up: queued behind the user's turn, or steered into a turn Master started. |
| `master.wait {timeoutSeconds?}` | Unreported updates, waiting up to 45 s for one. |
| `master.approve {task, step, requestId?, decision}` | Allow a request on the safe list, or deny one. |
| `master.answer {task, step, requestId?, answers \| skip}` | Answer a session's question. |
| `master.stop {task, step?}` | Stop a step's turn, or every step of the task. |
| `master.tasks {}` | Every task with its steps and their states. |
| `master.finish {task, report}` | End a task with its report. |
