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
- The first lead turn carries the full instructions
  (`orchestration::lead_context`); later turns carry a short reminder.
- Agents appear on the lead's rail in the sidebar, not in the session list.
  Each can be opened and talked to directly. The rail's Stop stops the
  agent's turn like its own Stop button; the lead hears about it. Closed
  agents leave the rail. Deleting an agent's session closes it for its lead.
- Two agents never share a worktree: `checkout` refuses a path another open
  agent works in. Parallel `agents.start` calls cannot take the same name.
- Agents get no app access of their own, so they cannot start agents.

## Commands

The lead runs `<monocode-gpui> app ACTION --json JSON`. `app help agents`
prints the reference (`orchestration::HELP`).

| Action | Does |
|---|---|
| `agents.start {name, prompt, title?, harness?, model?, effort?, modelSettings?, runtimeMode?, workspace?, base?, checkout?, reveal?}` | New session. Default `workspace: "worktree"` creates branch `mc/agent-<name>-<id>` from the lead's HEAD (or `base`); `"shared"` uses the lead's checkout; `checkout` reuses a listed worktree. Inherits the lead's provider, model (with its effort), access policy and account unless set. Like a herdr pane's `claude --model ID --effort LEVEL`, `model` and `effort` go to a Claude or Codex agent's CLI as given (`app_access::launch_settings_for` with `direct`): any model ID, listed in `models.list` or not (`claude-haiku-4-5`, `claude-opus-4-6[1m]`), and any effort level that CLI takes. The catalog only supplies defaults: a listed model without `effort` runs at the default `models.list` shows. Other harnesses still take only listed models. |
| `agents.list {}` | Name, state, since, checkout, branch, harness, model (and `resolvedModel` once an alias resolved), effort, runtimeMode, pending input with the decisions each request takes, queued or held messages. |
| `agents.read {name, view?}` | `activity`: the latest turn's prompt, tool steps, latest text and last tool output. `last`: the final message and edited files. `history`: earlier exchanges. `auto` picks activity while working. |
| `agents.prompt {name, prompt, mode?}` | Idle agent: next turn. Working agent: steer (default) or queue. Blocked agents refuse. It goes through the agent's message queue, so a draft the user is writing in that agent's composer is never touched. |
| `agents.wait {names?, until?, timeoutSeconds?}` | Returns unreported events, waiting up to 45 s for one. Returned events are not sent again as a wake-up. |
| `agents.approve {name, requestId?, decision}` / `agents.answer {name, requestId?, answers \| skip}` | Decide an agent's approval or question through the same path as its cards. Request ids are the plain provider ids; the user can decide the same request in the agent's chat or an approval toast, and a request decided there is no longer pending. |
| `agents.stop {name}` / `agents.close {name}` | Stop the turn and hold queued messages; close also archives the session. Worktrees stay. |
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
- Each Claude turn that starts a new CLI process waits for the user's MCP
  servers to connect, so an MCP server that times out delays every agent start
  and every wake-up by its timeout (30 s by default).
- New worktrees have no installed dependencies or ignored files; the lead's
  briefs have to say how to set them up.
