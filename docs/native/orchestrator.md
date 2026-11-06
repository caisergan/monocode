# Orchestrator (native)

`/orchestrator` turns a thread into a lead that runs other agents the way the
[herdr](https://herdr.dev) orchestrator skill does: each agent is a separate
chat session, the lead drives them with a small command set, and MonoCode tells
the lead when their work changes. It replaces the earlier plan runner, which
asked for a JSON task plan up front and then ran a fixed task graph with file
scopes on its own.

## How it behaves

- The lead is an ordinary conversation. The user can write to it at any time;
  a message sent while it works steers or queues like any other follow-up.
- Sending a message with Orchestrator selected makes the thread a lead for
  good (`orchestrator_enabled`, like Operator's `operator_enabled`). It keeps
  Operator's app actions and its access policy; it is not read-only.
- Any other local thread can delegate too, mid-session, when the user asks it
  to. Each of its turns carries a short hint (`orchestration::delegation_hint`)
  that names `agents.start` and `app help agents`, and it may call `agents.*`,
  `models.list` and `worktrees.list` without Operator. Its first successful
  `agents.start` makes it a lead for good, as a sent `/orchestrator` would
  (`Conversation::become_lead`); that result carries a `lead` note
  (`orchestration::BECAME_LEAD`) so the turn knows wake-ups follow. Plan,
  read-only, remote and Mono turns get no hint.
- The composer's bottom bar shows Orchestrator (the mode's icon and tint,
  after the checkout and branch) while the mode is selected and for as long as
  the thread is a lead, also one that became a lead by delegating.
- The first lead turn carries the full instructions
  (`orchestration::lead_context`); later turns carry a short reminder. A
  thread that became a lead by delegating gets only the reminder: it keeps
  the role it had and hands out what the user asked for, rather than taking
  over the herdr workflow (plan, brief, integrate) by itself.
- Agents appear on the lead's rail in the sidebar, not in the session list.
  Each can be opened and talked to directly. The rail's Stop stops the
  agent's turn like its own Stop button; the lead hears about it. Deleting an
  agent's session closes it for its lead.
- A lead keeps its orchestrator mark (the `share` glyph, "Orchestrator, 1
  agent, 3 past") and its rail for good, also after every agent closed and
  across restarts: the roster is saved per lead. Closed agents fold under
  "N past agents" below the open ones. Each says how its work ended
  (`SummaryTask::outcome`, kept by `close`: Done, Failed or Stopped; runs
  saved before that say Closed) and still opens its archived chat, or reads
  Deleted when that chat is gone. The rail unfolds while the lead is in view,
  chosen or working, as before.
- Two agents never share a worktree: `checkout` refuses a path another open
  agent works in. Parallel `agents.start` calls cannot take the same name.
- Agents get no app access of their own, so they cannot start agents:
  `Shell::add` gives an agent's session no app credentials, and app calls from
  a session on any lead's roster are refused.

## Commands

The lead runs `<monocode-gpui> app ACTION --json JSON`. `app help agents`
prints the reference (`orchestration::HELP`).

| Action | Does |
|---|---|
| `agents.start {name, prompt, title?, harness?, model?, effort?, modelSettings?, runtimeMode?, workspace?, base?, checkout?, reveal?}` | New session. Default `workspace: "worktree"` creates branch `mc/agent-<name>-<id>` from the lead's HEAD (or `base`) in a worktree under `<repo>-worktrees/` beside the repository; `"shared"` uses the lead's checkout; `checkout` reuses a listed worktree. Inherits the lead's provider, model (with its effort), access policy and account unless set. Like a herdr pane's `claude --model ID --effort LEVEL`, `model` and `effort` go to a Claude or Codex agent's CLI as given (`app_access::launch_settings_for` with `direct`): any model ID, listed in `models.list` or not (`claude-haiku-4-5`, `claude-opus-4-6[1m]`), and any effort level that CLI takes. The catalog only supplies defaults: a listed model without `effort` runs at the default `models.list` shows, and so does the ID a listed alias resolves to (`claude-haiku-5-5` for `haiku`), which keeps its pinned ID. Other harnesses still take only listed models. |
| `agents.list {}` | Name, state, since, checkout, branch, harness, model (and `resolvedModel` once an alias resolved to another ID), effort, runtimeMode, `needsInput` with the decisions each request takes, `error`, `queuedMessages` or `heldMessages`. Fields without a value are left out. `closedAgents` counts closed agents and `closedAgentNames` lists those `agents.read` can still read. |
| `agents.read {name, view?}` | `activity`: the latest turn's prompt, tool steps, latest text and last tool output. `last`: the final message and edited files. `history`: earlier exchanges. `auto` picks activity while working. A message steered into a running turn is a `Steer` step of that turn, not a new turn (`orchestration::steer_prompts` reads the turn receipts' `joined_turn`), so the turn's prompt, start time and the wake-up's duration stay the original turn's. A closed agent stays readable from its saved transcript, with `state: "closed"` and `outcome`; an open agent with the same name wins, then the newest closed one. |
| `agents.prompt {name, prompt, mode?}` | Idle agent: next turn. Working agent: steer (default) or queue. Blocked agents refuse. It goes through the agent's message queue, so a draft the user is writing in that agent's composer is never touched. |
| `agents.wait {names?, until?, timeoutSeconds?}` | Returns unreported events, waiting up to 45 s for one. Returned events are not sent again as a wake-up. |
| `agents.approve {name, requestId?, decision}` / `agents.answer {name, requestId?, answers \| skip}` | Decide an agent's approval or question through the same path as its cards. Request ids are the plain provider ids; the user can decide the same request in the agent's chat or an approval toast, and a request decided there is no longer pending. `session` (the card's "Allow for this session") sends Claude back its own permission suggestions with every destination set to `session`, and `needsInput` lists them as `sessionAllows` (`Bash(python3 -c 'print(1)')`, `acceptEdits mode`). Claude suggests a Bash rule for that exact command or its prefix, so a different command asks again. Claude's suggestions target `localSettings`; sent as they came, they were saved in the project's `.claude/settings.local.json`, for a worktree in the main checkout's. Without a suggestion, a Claude request does not offer `session`. |
| `agents.stop {name}` / `agents.close {name}` | Stop the turn and hold queued messages; close also archives the session, which `agents.read` can still read. Worktrees stay. |
| `agents.open {name}` | Open the agent's chat in a tab for the user. |

States: `starting`, `working`, `blocked`, `idle`, `stopped`, `failed`,
`usageLimited`.

## Wake-ups

`Shell::orchestration_session_changed` observes each agent on every session
change (`orchestration::observe`). A turn that ends (finished, stopped, failed,
usage limit) or a new approval or question becomes an event in the lead's
mailbox. Once the lead is idle with an empty composer, MonoCode sends the
mailbox as one internal `[Orchestration update]` turn with each agent's final
message. The turn's first line is `[Orchestration update] api finished · docs
needs input`; the lead's chat draws it as a one-line "Update from agents"
marker that expands to the full text. A stop the lead asked for is not
reported, and neither is a request that was decided before the lead heard about it. Reading a settled agent with `agents.read` (view `last`) counts as
hearing about its turn, so that update is not sent again. A lead gets at most
60 automatic wake-ups between two messages from the user; the last one tells
it to say that updates are paused, and later updates wait until the user
writes to it.

## Limits

- Wake-ups, waits and agent states are kept in memory. After a restart the rail
  keeps its agents (the roster is the saved `orchestration::Summary`); agents
  that were running read as stopped, since no turn survives a restart, and
  events from before the restart are gone.
- Each `agents.*` call is a shell command in the lead. A Supervised lead asks
  the user before each one, which keeps the user in charge of what the lead
  approves for its agents; unattended runs need Auto or Full access.
- A lead can have 12 open agents.
- `models.list` shows what a moving alias runs today (`resolvesTo`, for
  example `haiku` → `claude-haiku-5-5`). Pass the full ID to pin a version.
- Claude Code holds the first turn of a new CLI process until every MCP server
  settles whenever a server arrives through `--mcp-config`, as MonoCode's
  visual server does; a terminal session does not wait. One hanging user
  server (an OData bridge whose host is down, a server that never lists its
  tools) then delayed every agent start and every lead wake-up by
  `MCP_TIMEOUT`, 30 s by default. MonoCode now sets `MCP_TIMEOUT=10000` for
  those launches unless the user set it (`provider::cap_claude_mcp_wait`).
- Lead wake-ups still start a new CLI process even when idle-agent reuse is
  on; the 2026-11-02 test run's eight lead turns all started cold. Why the
  parked process is not reused is not known yet.
- New worktrees have no installed dependencies or ignored files; the lead's
  briefs have to say how to set them up.
- A Codex thread that is not a lead yet runs without Operator's network
  allowance, so its sandbox may block the first `agents.start` until the user
  approves running it outside the sandbox. A lead has the allowance.
