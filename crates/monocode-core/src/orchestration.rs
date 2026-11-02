//! Herdr-style orchestration. A lead session runs other agents as ordinary
//! sessions through the `agents.*` app actions: it starts them, reads what
//! they are doing, prompts or steers them, decides their approvals, and is
//! woken when their work settles. The lead stays a normal conversation the
//! user can talk to at any time; nothing here schedules work on its own.
use crate::{tool::ToolCall, transcript::Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// What the sidebar shows of a lead's agents, kept after they stop so the lead
/// still lists them. Also the durable roster: worker names live here.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Summary {
    pub tasks: Vec<SummaryTask>,
    /// An agent is working or waiting on input.
    pub live: bool,
}
impl Summary {
    /// The agents a lead still addresses, as the sidebar lists them.
    pub fn open_agents(&self) -> Summary {
        Summary {
            tasks: self.tasks.iter().filter(|t| t.open()).cloned().collect(),
            live: self.live,
        }
    }
    /// No agent's turn survives an app restart: a saved run reads as stopped
    /// until each agent is seen again.
    pub fn after_restart(mut self) -> Summary {
        self.live = false;
        for task in &mut self.tasks {
            if matches!(task.status.as_str(), "running" | "queued") {
                task.status = "stopped".into();
            }
        }
        self
    }
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SummaryTask {
    pub session: Option<i64>,
    /// The lead's handle for this agent; empty for runs saved before names.
    pub name: String,
    pub title: String,
    pub provider: String,
    pub model: Option<String>,
    /// running, completed, blocked, failed, stopped, closed or queued.
    pub status: String,
}
impl SummaryTask {
    /// orchestrationTaskLabel, given whether the agent needs input.
    pub fn label(&self, summary: &Summary, needs_input: bool) -> &'static str {
        if needs_input {
            return "Needs input";
        }
        if !summary.live && matches!(self.status.as_str(), "running" | "queued") {
            return "Saved";
        }
        match self.status.as_str() {
            "queued" => "Queued",
            "running" => "Working",
            "completed" => "Done",
            "failed" => "Failed",
            "blocked" => "Needs review",
            "stopped" => "Stopped",
            "closed" => "Closed",
            _ => "Queued",
        }
    }
    /// Whether the lead still addresses this agent by its name.
    pub fn open(&self) -> bool {
        self.status != "closed"
    }
}

/// Agent names follow herdr: a lowercase letter, then up to 31 lowercase
/// letters, digits, `-` or `_`.
pub fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && name.len() <= 32
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Launched, but its first turn has not been seen yet.
    Starting,
    Working,
    /// Waiting on an approval or a question.
    Blocked,
    Idle,
    Stopped,
    Failed,
    UsageLimited,
}
impl State {
    pub const ALL: [State; 7] = [
        State::Starting,
        State::Working,
        State::Blocked,
        State::Idle,
        State::Stopped,
        State::Failed,
        State::UsageLimited,
    ];
    pub fn id(self) -> &'static str {
        match self {
            State::Starting => "starting",
            State::Working => "working",
            State::Blocked => "blocked",
            State::Idle => "idle",
            State::Stopped => "stopped",
            State::Failed => "failed",
            State::UsageLimited => "usageLimited",
        }
    }
    pub fn parse(id: &str) -> Option<State> {
        State::ALL.into_iter().find(|state| state.id() == id)
    }
    /// The agent is not working and will not continue on its own.
    pub fn settled(self) -> bool {
        matches!(
            self,
            State::Idle | State::Stopped | State::Failed | State::UsageLimited
        )
    }
    /// The status the sidebar's Summary stores for this state.
    pub fn summary_status(self) -> &'static str {
        match self {
            State::Starting => "queued",
            State::Working | State::Blocked => "running",
            State::Idle => "completed",
            State::Stopped => "stopped",
            State::Failed | State::UsageLimited => "failed",
        }
    }
}

/// An approval or question an agent is waiting on.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: String,
    /// approval or question.
    pub kind: &'static str,
    pub title: String,
    /// The command or change awaiting approval.
    pub detail: String,
    /// Question items: `[{prompt, multiple, allowCustom, options:[label]}]`.
    pub items: Value,
    /// An approval that can be allowed for the rest of the agent's session.
    pub remember: bool,
}
impl Request {
    pub fn json(&self) -> Value {
        let mut value = json!({"requestId":self.id,"kind":self.kind,"title":self.title});
        if !self.detail.is_empty() {
            value["detail"] = json!(crate::response::limit(&self.detail, 2_000));
        }
        if self.kind == "question" {
            value["items"] = self.items.clone();
        } else {
            value["decisions"] = if self.remember {
                json!(["allow", "session", "deny"])
            } else {
                json!(["allow", "deny"])
            };
        }
        value
    }
}

/// Providers key requests by their wire id, JSON-encoded (`"\"abc\""` for a
/// string). Agents see and send the plain id.
pub fn public_request_id(id: &str) -> String {
    match serde_json::from_str::<Value>(id) {
        Ok(Value::String(plain)) => plain,
        _ => id.to_owned(),
    }
}
/// Whether `given` names the request `id`, in either form.
pub fn names_request(id: &str, given: &str) -> bool {
    id == given || public_request_id(id) == given
}

/// What MonoCode can see of an agent's session right now.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Observation {
    /// Running a turn, stopping, preparing its checkout, or holding queued
    /// messages that will run on their own.
    pub busy: bool,
    pub requests: Vec<Request>,
    pub usage_limited: bool,
    /// The last turn was stopped.
    pub stopped: bool,
    /// The last turn's error.
    pub error: Option<String>,
    /// Messages wait in a paused queue: a launch stopped before it began.
    pub held: bool,
}
pub fn classify(observation: &Observation) -> State {
    if !observation.requests.is_empty() {
        State::Blocked
    } else if observation.busy {
        State::Working
    } else if observation.usage_limited {
        State::UsageLimited
    } else if observation.error.is_some() {
        State::Failed
    } else if observation.stopped {
        State::Stopped
    } else {
        State::Idle
    }
}

/// Something the lead should hear about.
#[derive(Clone, Debug, PartialEq)]
pub enum EventKind {
    /// A turn ended normally.
    Finished,
    Stopped,
    Failed(String),
    UsageLimited,
    Blocked(Request),
}
impl EventKind {
    /// The state this event left the agent in, for `agents.wait {until}`.
    pub fn state(&self) -> State {
        match self {
            EventKind::Finished => State::Idle,
            EventKind::Stopped => State::Stopped,
            EventKind::Failed(_) => State::Failed,
            EventKind::UsageLimited => State::UsageLimited,
            EventKind::Blocked(_) => State::Blocked,
        }
    }
}

/// An agent's state between observations.
#[derive(Clone, Debug, PartialEq)]
pub struct Watch {
    pub state: State,
    /// Requests already reported, so each is announced once.
    pub announced: Vec<String>,
    /// When the current state began (ms).
    pub since: u64,
    /// The lead stopped this agent itself; its stop is not news.
    pub quiet_stop: bool,
}
impl Watch {
    pub fn new(state: State, at: u64) -> Self {
        Self {
            state,
            announced: Vec::new(),
            since: at,
            quiet_stop: false,
        }
    }
}

/// Advance `watch` to `observation` and return what the lead should hear.
/// A launch that has not begun yet stays `Starting`; a turn that ends reports
/// once; each new approval or question reports once.
pub fn observe(watch: &mut Watch, observation: &Observation, at: u64) -> Vec<EventKind> {
    let mut state = classify(observation);
    let mut events = Vec::new();
    // A queued launch looks idle until its first turn begins, unless it was
    // stopped before then.
    if watch.state == State::Starting && state == State::Idle {
        state = if observation.held {
            State::Stopped
        } else {
            State::Starting
        };
    }
    let pending: Vec<&str> = observation.requests.iter().map(|r| r.id.as_str()).collect();
    watch.announced.retain(|id| pending.contains(&id.as_str()));
    for request in &observation.requests {
        if !watch.announced.contains(&request.id) {
            watch.announced.push(request.id.clone());
            events.push(EventKind::Blocked(request.clone()));
        }
    }
    if state != watch.state {
        let was_running = matches!(
            watch.state,
            State::Starting | State::Working | State::Blocked
        );
        if state.settled() && (was_running || state != State::Idle) {
            let quiet = std::mem::take(&mut watch.quiet_stop);
            match state {
                State::Idle => events.push(EventKind::Finished),
                State::Stopped if !quiet => events.push(EventKind::Stopped),
                State::Failed if !quiet => events.push(EventKind::Failed(
                    observation.error.clone().unwrap_or_default(),
                )),
                State::UsageLimited => events.push(EventKind::UsageLimited),
                _ => {}
            }
        }
        watch.state = state;
        watch.since = at;
    }
    events
}

/// An event waiting for the lead.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub session: i64,
    pub name: String,
    pub kind: EventKind,
    pub at: u64,
    /// The agent's final message, for settled turns.
    pub report: String,
    /// How long the turn ran, when known (ms).
    pub elapsed: Option<u64>,
}
impl Event {
    pub fn json(&self, report_chars: usize) -> Value {
        let mut value = json!({
            "name": self.name,
            "sessionId": self.session,
            "event": match &self.kind {
                EventKind::Finished => "finished",
                EventKind::Stopped => "stopped",
                EventKind::Failed(_) => "failed",
                EventKind::UsageLimited => "usageLimited",
                EventKind::Blocked(_) => "blocked",
            },
            "state": self.kind.state().id(),
            "at": self.at,
        });
        if let Some(elapsed) = self.elapsed {
            value["elapsedSeconds"] = json!(elapsed / 1_000);
        }
        match &self.kind {
            EventKind::Failed(error) => {
                value["error"] = json!(crate::response::limit(error, 2_000))
            }
            EventKind::Blocked(request) => value["needsInput"] = request.json(),
            _ => {}
        }
        if !self.report.is_empty() {
            value["finalMessage"] = json!(tail(&self.report, report_chars));
            value["finalMessageTruncated"] = json!(self.report.chars().count() > report_chars);
        }
        value
    }
}

/// Opens every wake-up turn; the transcript draws such turns as a marker.
pub const UPDATE_TAG: &str = "[Orchestration update]";

/// "api finished · docs needs input": one clause per event, in order.
fn event_summary(events: &[Event]) -> String {
    let mut clauses: Vec<String> = Vec::new();
    for event in events {
        let clause = format!(
            "{} {}",
            event.name,
            match &event.kind {
                EventKind::Finished => "finished",
                EventKind::Stopped => "stopped",
                EventKind::Failed(_) => "failed",
                EventKind::UsageLimited => "hit a usage limit",
                EventKind::Blocked(_) => "needs input",
            }
        );
        if !clauses.contains(&clause) {
            clauses.push(clause);
        }
    }
    clauses.join(" · ")
}

/// A wake-up turn's summary line and the rest of its text, or `None` for any
/// other internal message.
pub fn update_parts(text: &str) -> Option<(String, String)> {
    let rest = text.trim_start().strip_prefix(UPDATE_TAG)?;
    let (summary, detail) = rest.split_once('\n').unwrap_or((rest, ""));
    Some((summary.trim().to_owned(), detail.trim().to_owned()))
}

/// The wake-up turn a lead receives when its agents' work changes. Its first
/// line is the tag and a summary of the events.
/// `last`: the final automatic update before the user writes again.
pub fn wake_message(events: &[Event], roster: &[(String, State)], last: bool) -> String {
    let mut out = format!("{UPDATE_TAG} {}\n", event_summary(events));
    for event in events {
        let elapsed = event
            .elapsed
            .map(|ms| format!(", {}", duration(ms)))
            .unwrap_or_default();
        let line = match &event.kind {
            EventKind::Finished => format!("{} finished its turn{elapsed}.", event.name),
            EventKind::Stopped => format!("{} was stopped{elapsed}.", event.name),
            EventKind::Failed(error) => format!(
                "{} failed{elapsed}: {}",
                event.name,
                crate::response::limit(error.trim(), 600)
            ),
            EventKind::UsageLimited => {
                format!("{} stopped at a provider usage limit{elapsed}.", event.name)
            }
            EventKind::Blocked(request) => {
                let mut line = format!(
                    "{} needs input: {} \"{}\" (requestId {}).",
                    event.name, request.kind, request.title, request.id
                );
                if !request.detail.is_empty() {
                    line.push_str(&format!(
                        "\n  {}",
                        crate::response::limit(request.detail.trim(), 600).replace('\n', "\n  ")
                    ));
                }
                if request.kind == "question" {
                    line.push_str(&format!("\n  Items: {}", request.items));
                }
                line.push_str(if request.kind == "question" {
                    "\n  Answer with agents.answer, or ask the user."
                } else {
                    "\n  Decide with agents.approve, or ask the user."
                });
                line
            }
        };
        out.push_str(&format!("- {line}\n"));
        if !event.report.is_empty() {
            let shown = tail(&event.report, 3_000);
            out.push_str(&format!(
                "  Final message{}:\n  {}\n",
                if shown.len() < event.report.len() {
                    " (end; agents.read {\"name\":\"…\",\"view\":\"last\"} has all of it)"
                } else {
                    ""
                },
                shown.trim().replace('\n', "\n  ")
            ));
        }
    }
    if !roster.is_empty() {
        out.push_str("\nAgents: ");
        out.push_str(
            &roster
                .iter()
                .map(|(name, state)| format!("{name} {}", state.id()))
                .collect::<Vec<_>>()
                .join(", "),
        );
        out.push('\n');
    }
    out.push_str("\nHandle this as the orchestrator: review and integrate finished work, decide blocked requests, give idle agents their next task or close them, and tell the user what changed. Use agents.read for more detail. Do not poll; the next update arrives on its own.");
    if last {
        out.push_str("\n\nThis is the last automatic update until the user writes to you. Tell the user that agent updates are paused until they reply; agents.list and agents.wait still work meanwhile.");
    }
    out
}

fn duration(ms: u64) -> String {
    let seconds = ms / 1_000;
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3_600 {
        format!("{}m {}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {}m", seconds / 3_600, seconds % 3_600 / 60)
    }
}

/// The last `count` characters, cut at a character boundary.
pub fn tail(text: &str, count: usize) -> String {
    let total = text.chars().count();
    if total <= count {
        text.to_owned()
    } else {
        format!("…{}", text.chars().skip(total - count).collect::<String>())
    }
}

/// Rows joined into transcript blocks: continuation rows belong to the row
/// that began their block.
fn blocks(rows: &[Row]) -> Vec<(&str, String, Option<u64>)> {
    let mut blocks: Vec<(&str, String, Option<u64>)> = Vec::new();
    for row in rows {
        match blocks.last_mut() {
            Some(block) if !row.first && block.0 == row.role => block.1.push_str(&row.text),
            _ => blocks.push((row.role.as_str(), row.text.clone(), row.sent_at)),
        }
    }
    blocks
}
fn last_prompt(blocks: &[(&str, String, Option<u64>)]) -> usize {
    blocks
        .iter()
        .rposition(|(role, _, _)| matches!(*role, "user" | "mono-system"))
        .unwrap_or(0)
}

/// The agent's final message in its latest turn: the replies after its last
/// tool call, or its last reply when it ended on a tool.
pub fn final_message(rows: &[Row]) -> String {
    let blocks = blocks(rows);
    let turn = &blocks[last_prompt(&blocks)..];
    let after_tools = turn
        .iter()
        .rposition(|(role, _, _)| *role == "tool")
        .map_or(0, |ix| ix + 1);
    let text = |range: &[(&str, String, Option<u64>)]| {
        range
            .iter()
            .filter(|(role, _, _)| matches!(*role, "assistant" | "error"))
            .map(|(_, text, _)| text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let reply = text(&turn[after_tools.min(turn.len())..]);
    if !reply.is_empty() {
        return reply;
    }
    turn.iter()
        .rev()
        .find(|(role, text, _)| *role == "assistant" && !text.trim().is_empty())
        .map(|(_, text, _)| text.trim().to_owned())
        .unwrap_or_default()
}

/// When the latest turn began (ms), from its prompt row.
pub fn turn_started_at(rows: &[Row]) -> Option<u64> {
    let blocks = blocks(rows);
    blocks.get(last_prompt(&blocks)).and_then(|block| block.2)
}

/// What an agent is doing in its latest turn: its prompt, the steps it took,
/// and its latest words.
pub fn activity(rows: &[Row], max_chars: usize) -> Value {
    let blocks = blocks(rows);
    let start = last_prompt(&blocks);
    let turn = &blocks[start..];
    let prompt = turn
        .first()
        .filter(|(role, _, _)| matches!(*role, "user" | "mono-system"))
        .map(|(_, text, _)| crate::response::limit(text.trim(), 600))
        .unwrap_or_default();
    let mut steps = Vec::new();
    let mut last_output = None;
    let mut edited: Vec<String> = Vec::new();
    for (role, text, _) in turn {
        if *role != "tool" {
            continue;
        }
        let Ok(tool) = serde_json::from_str::<ToolCall>(text) else {
            continue;
        };
        let (action, target) = tool.summary();
        // The display summary keeps a command's first line only.
        let target = match serde_json::from_str::<Value>(&tool.input_detail()) {
            Ok(input) if action == "Run" => input["command"]
                .as_str()
                .map(crate::tool::shell_command)
                .filter(|command| !command.trim().is_empty())
                .map(|command| crate::response::limit(command.trim(), 400))
                .unwrap_or(target),
            _ => target,
        };
        if matches!(action.as_str(), "Edit" | "Write")
            && !target.is_empty()
            && !edited.contains(&target)
        {
            edited.push(target.clone());
        }
        let state = match tool.state {
            crate::tool::ToolState::Running => "running",
            crate::tool::ToolState::Completed => "done",
            crate::tool::ToolState::Failed => "failed",
            crate::tool::ToolState::Cancelled => "cancelled",
        };
        last_output = (!tool.output.trim().is_empty()).then(|| tail(tool.output.trim(), 600));
        steps.push(json!({
            "action": action,
            "target": crate::response::limit(&target, 400),
            "state": state,
        }));
    }
    let earlier = steps.len().saturating_sub(25);
    let latest = turn
        .iter()
        .rev()
        .find(|(role, text, _)| *role == "assistant" && !text.trim().is_empty())
        .map(|(_, text, _)| text.trim().to_owned())
        .unwrap_or_default();
    let mut value = json!({
        "prompt": prompt,
        "steps": steps.split_off(earlier),
        "latestText": tail(&latest, max_chars),
        "latestTextTruncated": latest.chars().count() > max_chars,
        "editedFiles": edited,
    });
    if earlier > 0 {
        value["earlierSteps"] = json!(earlier);
    }
    if let Some(started) = turn.first().and_then(|block| block.2) {
        value["turnStartedAt"] = json!(started);
    }
    if let Some(output) = last_output {
        value["lastToolOutput"] = json!(output);
    }
    value
}

/// Reject misspelled fields and wrong types before any agent action runs.
pub fn validate(action: &str, input: &Value) -> Result<(), String> {
    let fields = match action {
        "agents.list" => "",
        "agents.start" => "name prompt title harness model modelSettings effort runtimeMode workspace base checkout reveal",
        "agents.read" => "name view maxChars before limit",
        "agents.prompt" => "name prompt mode",
        "agents.wait" => "names until timeoutSeconds",
        "agents.approve" => "name requestId decision",
        "agents.answer" => "name requestId answers skip",
        "agents.stop" | "agents.close" | "agents.open" => "name",
        _ => return Err("Unknown agents action. Run app help agents".into()),
    };
    let object = input.as_object().ok_or("Input must be an object")?;
    for (key, value) in object {
        if !fields.split_whitespace().any(|f| f == key) {
            return Err(format!("{action} does not take {key}"));
        }
        let ok = match key.as_str() {
            "reveal" | "skip" => value.is_boolean(),
            "maxChars" | "limit" | "timeoutSeconds" => value.as_u64().is_some(),
            "before" => value.is_string() || value.as_u64().is_some(),
            "modelSettings" => value
                .as_object()
                .is_some_and(|values| values.values().all(Value::is_string)),
            "names" | "until" => value
                .as_array()
                .is_some_and(|a| a.len() <= 32 && a.iter().all(Value::is_string)),
            "answers" => value.as_array().is_some_and(|items| {
                items.len() <= 16
                    && items.iter().all(|item| {
                        item.as_array()
                            .is_some_and(|a| a.len() <= 16 && a.iter().all(Value::is_string))
                    })
            }),
            _ => value.is_string(),
        };
        if !ok {
            return Err(format!("{key} has the wrong type; run app help agents"));
        }
    }
    if fields.split_whitespace().any(|f| f == "name") {
        let name = input["name"].as_str().ok_or("Provide name")?;
        if !valid_name(name) {
            return Err("name must be a lowercase letter, then up to 31 lowercase letters, digits, '-' or '_'".into());
        }
    }
    if let Some(names) = input["names"].as_array() {
        if names
            .iter()
            .any(|n| n.as_str().is_none_or(|n| !valid_name(n)))
        {
            return Err("names must be agent names".into());
        }
    }
    if let Some(until) = input["until"].as_array() {
        if until
            .iter()
            .any(|s| s.as_str().and_then(State::parse).is_none())
        {
            return Err("until takes blocked, idle, stopped, failed or usageLimited".into());
        }
    }
    let one_of = |key: &str, allowed: &[&str]| match input.get(key) {
        Some(value) if !value.as_str().is_some_and(|v| allowed.contains(&v)) => {
            Err(format!("{key} must be one of: {}", allowed.join(", ")))
        }
        _ => Ok(()),
    };
    one_of("view", &["auto", "activity", "last", "history"])?;
    one_of("mode", &["auto", "steer", "queue"])?;
    one_of("workspace", &["worktree", "shared"])?;
    one_of("decision", &["allow", "session", "deny"])?;
    one_of(
        "runtimeMode",
        &[
            "read-only",
            "supervised",
            "auto-accept-edits",
            "auto",
            "full-access",
        ],
    )?;
    if matches!(action, "agents.start" | "agents.prompt")
        && input["prompt"]
            .as_str()
            .is_none_or(|p| p.trim().is_empty() || p.len() > 240_000)
    {
        return Err("Provide prompt (up to 240,000 bytes)".into());
    }
    if action == "agents.approve" && input.get("decision").is_none() {
        return Err("Provide decision: allow, session or deny".into());
    }
    if action == "agents.answer" && input.get("answers").is_some() == (input["skip"] == true) {
        return Err("Provide answers, or skip: true".into());
    }
    if input
        .get("timeoutSeconds")
        .is_some_and(|t| t.as_u64() > Some(MAX_WAIT_SECONDS))
    {
        return Err(format!("timeoutSeconds must be at most {MAX_WAIT_SECONDS}"));
    }
    if input
        .get("maxChars")
        .is_some_and(|m| !(200..=20_000).contains(&m.as_u64().unwrap_or(0)))
    {
        return Err("maxChars must be 200 to 20,000".into());
    }
    if input.get("base").is_some() && input["workspace"] == "shared" {
        return Err("base needs workspace worktree".into());
    }
    if input.get("checkout").is_some()
        && (input.get("base").is_some() || input["workspace"] == "shared")
    {
        return Err("checkout cannot be combined with base or workspace shared".into());
    }
    Ok(())
}

/// The app bridge answers within 60 seconds; leave room for the reply.
pub const MAX_WAIT_SECONDS: u64 = 45;

/// Read-only agent actions; the rest keep durable receipts.
pub fn reads(action: &str) -> bool {
    matches!(action, "agents.list" | "agents.read" | "agents.wait")
}

pub const HELP: &str = r#"MonoCode agents (orchestrator threads only)
Usage: CLI app ACTION --json '{...}'
Every agent is a separate MonoCode chat session the user can open and talk to. Names: a lowercase letter, then up to 31 lowercase letters, digits, '-' or '_'.

agents.start {name, prompt, title?, harness?, model?, effort?, modelSettings?, runtimeMode?, workspace?, base?, checkout?, reveal?}
  Start an agent on prompt. workspace "worktree" (default) gives it its own git worktree and branch from base (default: your checkout's HEAD); "shared" runs it in your checkout; checkout reuses an existing worktree path (worktrees.list). harness is claude, codex, ….
  model: an alias or ID from models.list (an alias's resolvesTo names the model it runs today), or for claude and codex any model ID their CLI takes, such as claude-haiku-4-5 or claude-opus-4-6[1m]. effort: claude takes low, medium, high, xhigh, max, ultrathink or ultracode; codex takes none, minimal, low, medium, high or xhigh. Without effort, a model from models.list runs at the default it shows there, and any other model at its CLI's default. modelSettings takes other values from models.list.
  runtimeMode: read-only, supervised (asks before changes), auto-accept-edits, auto or full-access. The agent inherits your model with its effort, your access policy and your account unless you set them. reveal opens it in a tab.
agents.list {}
  Every agent: name, sessionId, state, since, checkout, branch, harness, model (resolvedModel once an alias resolved), effort, runtimeMode, pending input, queued messages.
agents.read {name, view?, maxChars?, before?, limit?}
  view "activity": what it is doing in its latest turn (prompt, tool steps, latest text, last tool output). "last": its final message and the files it edited. "history": earlier exchanges (before/limit page back). "auto" (default): activity while working or blocked, otherwise last.
agents.prompt {name, prompt, mode?}
  Idle, stopped or failed agent: starts its next turn. Working agent: mode "steer" (default when the provider supports it) adds the message to the running turn; "queue" runs it after the turn. Blocked agents refuse; decide the request first.
agents.wait {names?, until?, timeoutSeconds?}
  Returns the agents' unreported events (finished, stopped, failed, usageLimited, blocked), waiting up to timeoutSeconds (default 30, max 45) for the first one. until filters by resulting state: idle, blocked, stopped, failed, usageLimited. Returned events are not sent again as a wake-up. matched:false means it timed out.
agents.approve {name, requestId?, decision}
  decision allow, session (allow for the rest of its session) or deny; needsInput lists the decisions each request takes. requestId defaults to its only pending approval. The user can decide a request too, in the agent's chat; it is then no longer pending.
agents.answer {name, requestId?, answers | skip:true}
  answers: one array of chosen option labels or free text per question item.
agents.stop {name}
  Stop its running turn and hold its queued messages.
agents.open {name}
  Open its chat in a tab for the user, for example when you ask them to look at it.
agents.close {name}
  Stop it and archive its session. Its worktree and branch stay; remove them with git when merged.

States: starting, working, blocked (needsInput), idle, stopped, failed (error), usageLimited.
Wake-ups: when an agent finishes a turn, stops, fails, hits a usage limit or needs input, MonoCode sends you an [Orchestration update] turn once you are idle. You do not need to wait or poll.
Also available: models.list, worktrees.list, worktrees.create, sessions.* for the user's other sessions (run app help).
The CLI returns {ok,result,requestId}. Retry an uncertain mutation with the same --request-id and identical input.
"#;

/// The lead's instructions. `full` on the turn that turned Orchestrator on;
/// later turns get a reminder, since the full text stays in its history.
pub fn lead_context(cli: &str, full: bool) -> String {
    if !full {
        return format!("<monocode_orchestration>\nYou are this thread's orchestrator. Drive your agents with `{cli} app ACTION --json JSON` (reference: `{cli} app help agents`). MonoCode sends [Orchestration update] turns when they finish, stop, fail or need input; never poll. Never push, open PRs or deploy without the user's explicit OK.\n</monocode_orchestration>");
    }
    format!(
        r#"<monocode_orchestration>
MonoCode adds this context, not the user. You are this thread's orchestrator. You plan the work, start agents, brief them, watch them, review and integrate what they produce, run the tests, and keep the user informed. You do not write feature code yourself, except small integration fixes or when the user asks. The user can talk to you at any time, also while agents work.

Each agent is a separate MonoCode chat session. Drive them with `{cli} app ACTION --json JSON` (full reference: `{cli} app help agents`). App credentials are in your environment; never print them.
- agents.start {{name, prompt, title?, harness?, model?, effort?, runtimeMode?, workspace?}}: own git worktree and branch from your HEAD by default, so commit what it needs first; inherits your model and access policy unless you set them. model and effort go to the agent's CLI as given: an alias from models.list or a full model ID such as claude-haiku-4-5, and a level such as high.
- agents.list {{}} and agents.read {{name, view?}}: states, and what an agent is doing right now (view activity) or its final report (view last).
- agents.prompt {{name, prompt, mode?}}: next task for an idle agent; steer or queue a note to a working one.
- agents.approve / agents.answer: decide an agent's approval or question. agents.stop / agents.close. agents.open shows an agent's chat to the user.
- agents.wait {{names?, timeoutSeconds?}}: block up to 45 s for the next event; use it only when you have nothing else to do and expect news within a minute.

How to run the work:
1. Agree on scope with the user, and on how many agents run at once (default 3).
2. Split the work into small tasks (10 to 40 minutes each). Run tasks that edit the same files one after another; shared files get small additive edits only. Put backend work before the client that needs it.
3. Brief each agent so it never has to ask: the goal and why, what to read first, numbered deliverables with exact behaviour and edge cases, what is out of scope, the folders other agents own ("do not touch"), the tests to write and the full test commands. A new worktree has no installed dependencies and no ignored files such as `.env`; say how to set it up. Tell it to commit on its branch and to end with a report whose first line is `STATUS: DONE` or `STATUS: BLOCKED`, followed by the commit SHA, tests run with results, decisions made and follow-ups.
4. After starting agents, tell the user in a few lines what started and why, then end your turn. MonoCode wakes you with an [Orchestration update] when an agent finishes a turn, stops, fails, hits a usage limit or needs input. Do not poll or sleep.
5. On every completion: read the report, review the risky parts of its commit (`git -C <checkout> show <sha>`), cherry-pick it onto your checkout (the integration branch; resolve conflicts by reading both sides), run the full tests, and fix integration breaks with a small commit. Tell running agents about breaks that affect them (agents.prompt). Then give the free agent its next task in the same checkout (rebase or reset its branch onto your new HEAD first if it needs your latest work) or close it, and start the next task so the agreed number stays busy. Never stack several unreviewed commits.
6. Blocked agents: approve routine requests within the user's access policy; deny destructive or out-of-scope ones; ask the user when unsure. A failed or usage-limited agent: read it, then retry, reassign or report.
7. Keep the user informed after each completion: what landed, test results, decisions they need to make, what is running. Record their decisions in the briefs so they are never reopened.
8. Never push, open PRs, deploy, or remove branches and worktrees you did not create, without the user's explicit OK. When the user says stop: start nothing new, let running agents finish, integrate and test, then report the final state.
</monocode_orchestration>"#
    )
}

/// The first turn of an agent: who it works for, where, and how to finish.
pub fn worker_prompt(name: &str, checkout: &str, branch: Option<&str>, prompt: &str) -> String {
    let place = match branch {
        Some(branch) => format!("{checkout} (branch {branch})"),
        None => checkout.to_owned(),
    };
    format!(
        "You are agent `{name}`, started by an orchestrator session in MonoCode. Your checkout is {place}. Other agents may work in parallel in their own checkouts; touch only what your task needs. Do not push, open pull requests or deploy. The orchestrator reads your final message as your report.\n\n{prompt}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> Request {
        Request {
            id: id.into(),
            kind: "approval",
            title: "Run command".into(),
            detail: "npm install".into(),
            items: Value::Null,
            remember: true,
        }
    }
    fn row(role: &str, text: &str, first: bool) -> Row {
        Row {
            role: role.into(),
            text: text.into(),
            first,
            sent_at: first.then_some(1_000),
        }
    }

    #[test]
    fn a_restarted_run_reads_as_stopped_and_the_rail_skips_closed_agents() {
        let task = |name: &str, status: &str| SummaryTask {
            session: Some(1),
            name: name.into(),
            status: status.into(),
            ..Default::default()
        };
        let summary = Summary {
            tasks: vec![
                task("a", "running"),
                task("b", "completed"),
                task("c", "closed"),
                task("d", "queued"),
            ],
            live: true,
        };
        let open = summary.open_agents();
        assert_eq!(
            open.tasks
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "d"]
        );
        let restarted = summary.after_restart();
        assert!(!restarted.live);
        assert_eq!(
            restarted
                .tasks
                .iter()
                .map(|t| t.status.as_str())
                .collect::<Vec<_>>(),
            ["stopped", "completed", "closed", "stopped"]
        );
    }

    #[test]
    fn names_follow_herdr() {
        assert!(valid_name("api"));
        assert!(valid_name("a1-b_c"));
        assert!(!valid_name("Api"));
        assert!(!valid_name("1api"));
        assert!(!valid_name(""));
        assert!(!valid_name(&"a".repeat(33)));
        assert!(valid_name(&"a".repeat(32)));
    }

    #[test]
    fn a_launch_reports_once_when_its_turn_ends() {
        let mut watch = Watch::new(State::Starting, 0);
        // The launch is queued but has not begun.
        assert!(observe(&mut watch, &Observation::default(), 1).is_empty());
        assert_eq!(watch.state, State::Starting);
        let working = Observation {
            busy: true,
            ..Default::default()
        };
        assert!(observe(&mut watch, &working, 2).is_empty());
        assert_eq!(watch.state, State::Working);
        assert_eq!(
            observe(&mut watch, &Observation::default(), 3),
            vec![EventKind::Finished]
        );
        assert_eq!((watch.state, watch.since), (State::Idle, 3));
        // Unchanged observations are not news.
        assert!(observe(&mut watch, &Observation::default(), 4).is_empty());
    }

    #[test]
    fn each_request_reports_once_and_the_turn_still_reports_its_end() {
        let mut watch = Watch::new(State::Working, 0);
        let blocked = Observation {
            busy: true,
            requests: vec![request("a")],
            ..Default::default()
        };
        assert_eq!(
            observe(&mut watch, &blocked, 1),
            vec![EventKind::Blocked(request("a"))]
        );
        assert!(observe(&mut watch, &blocked, 2).is_empty());
        let more = Observation {
            busy: true,
            requests: vec![request("a"), request("b")],
            ..Default::default()
        };
        assert_eq!(
            observe(&mut watch, &more, 3),
            vec![EventKind::Blocked(request("b"))]
        );
        assert_eq!(
            observe(&mut watch, &Observation::default(), 4),
            vec![EventKind::Finished]
        );
        assert!(watch.announced.is_empty());
    }

    #[test]
    fn stops_failures_and_limits_report_unless_the_lead_stopped_it() {
        let working = Observation {
            busy: true,
            ..Default::default()
        };
        let stopped = Observation {
            stopped: true,
            ..Default::default()
        };
        let mut watch = Watch::new(State::Working, 0);
        assert_eq!(observe(&mut watch, &stopped, 1), vec![EventKind::Stopped]);
        observe(&mut watch, &working, 2);
        watch.quiet_stop = true;
        assert!(observe(&mut watch, &stopped, 3).is_empty());
        assert!(!watch.quiet_stop);
        observe(&mut watch, &working, 4);
        let failed = Observation {
            error: Some("boom".into()),
            ..Default::default()
        };
        assert_eq!(
            observe(&mut watch, &failed, 5),
            vec![EventKind::Failed("boom".into())]
        );
        observe(&mut watch, &working, 6);
        let limited = Observation {
            usage_limited: true,
            ..Default::default()
        };
        assert_eq!(
            observe(&mut watch, &limited, 7),
            vec![EventKind::UsageLimited]
        );
        // A launch that fails before it starts still reports.
        let mut watch = Watch::new(State::Starting, 0);
        assert_eq!(
            observe(&mut watch, &failed, 1),
            vec![EventKind::Failed("boom".into())]
        );
        // One stopped before it began is stopped, not starting forever.
        let mut watch = Watch::new(State::Starting, 0);
        let held = Observation {
            held: true,
            ..Default::default()
        };
        assert_eq!(observe(&mut watch, &held, 1), vec![EventKind::Stopped]);
        assert_eq!(watch.state, State::Stopped);
    }

    #[test]
    fn final_message_is_the_reply_after_the_last_tool() {
        let tool = serde_json::to_string(&ToolCall::new("t1", "Bash")).unwrap();
        let rows = vec![
            row("user", "Old task", true),
            row("assistant", "Old answer", true),
            row("user", "Fix the bug", true),
            row("assistant", "Let me look.", true),
            row("tool", &tool, true),
            row("assistant", "STATUS: DONE\n", true),
            row("assistant", "commit abc", false),
        ];
        assert_eq!(final_message(&rows), "STATUS: DONE\ncommit abc");
        assert_eq!(turn_started_at(&rows), Some(1_000));
        // Ending on a tool falls back to the last reply.
        assert_eq!(final_message(&rows[..5]), "Let me look.");
    }

    #[test]
    fn activity_lists_the_latest_turns_steps_and_words() {
        let mut edit = ToolCall::new("t1", "Edit");
        edit.input =
            json!({"file_path":"src/lib.rs","old_string":"a","new_string":"b"}).to_string();
        edit.state = crate::tool::ToolState::Completed;
        let mut run = ToolCall::new("t2", "Bash");
        run.input = json!({"command":"cargo test"}).to_string();
        run.output = "running 3 tests".into();
        let rows = vec![
            row("user", "Earlier", true),
            row(
                "tool",
                &serde_json::to_string(&ToolCall::new("t0", "Read")).unwrap(),
                true,
            ),
            row("user", "Add pagination", true),
            row("tool", &serde_json::to_string(&edit).unwrap(), true),
            row("assistant", "Edited; now testing.", true),
            row("tool", &serde_json::to_string(&run).unwrap(), true),
        ];
        let value = activity(&rows, 4_000);
        assert_eq!(value["prompt"], "Add pagination");
        assert_eq!(value["steps"].as_array().unwrap().len(), 2);
        assert_eq!(value["steps"][0]["state"], "done");
        assert_eq!(value["steps"][1]["state"], "running");
        assert_eq!(value["latestText"], "Edited; now testing.");
        assert_eq!(value["lastToolOutput"], "running 3 tests");
        assert_eq!(value["editedFiles"], json!(["src/lib.rs"]));
        assert_eq!(value["turnStartedAt"], 1_000);

        // A multi-line command shows whole, not just its first line.
        let mut script = ToolCall::new("t3", "Bash");
        script.input = json!({"command":"python3 -I -c '\nprint(2 + 2)\n'"}).to_string();
        let rows = vec![
            row("user", "Check", true),
            row("tool", &serde_json::to_string(&script).unwrap(), true),
        ];
        let value = activity(&rows, 4_000);
        assert_eq!(value["steps"][0]["action"], "Run");
        assert_eq!(
            value["steps"][0]["target"],
            "python3 -I -c '\nprint(2 + 2)\n'"
        );
    }

    #[test]
    fn requests_show_plain_ids_and_the_decisions_they_take() {
        // Claude's request_id arrives JSON-encoded in the provider's key.
        assert_eq!(public_request_id("\"29cb8d74-c6fd\""), "29cb8d74-c6fd");
        assert_eq!(public_request_id("7"), "7");
        assert_eq!(public_request_id("plain"), "plain");
        assert!(names_request("\"29cb8d74-c6fd\"", "29cb8d74-c6fd"));
        assert!(names_request("\"29cb8d74-c6fd\"", "\"29cb8d74-c6fd\""));
        assert!(!names_request("\"29cb8d74-c6fd\"", "29cb8d74"));

        let mut approval = request("r1");
        assert_eq!(
            approval.json()["decisions"],
            json!(["allow", "session", "deny"])
        );
        approval.remember = false;
        assert_eq!(approval.json()["decisions"], json!(["allow", "deny"]));
        approval.kind = "question";
        assert!(approval.json().get("decisions").is_none());
    }

    #[test]
    fn validation_rejects_bad_input_before_any_action() {
        assert!(validate("agents.start", &json!({"name":"api","prompt":"Do it"})).is_ok());
        assert!(validate("agents.start", &json!({"name":"Api","prompt":"Do it"})).is_err());
        assert!(validate("agents.start", &json!({"name":"api"})).is_err());
        assert!(validate(
            "agents.start",
            &json!({"name":"api","prompt":"x","force":true})
        )
        .is_err());
        assert!(validate(
            "agents.start",
            &json!({"name":"api","prompt":"x","workspace":"shared","base":"main"})
        )
        .is_err());
        assert!(validate("agents.wait", &json!({"timeoutSeconds":46})).is_err());
        assert!(validate("agents.wait", &json!({"names":["api"],"until":["idle"]})).is_ok());
        assert!(validate("agents.wait", &json!({"until":["done"]})).is_err());
        assert!(validate("agents.approve", &json!({"name":"api"})).is_err());
        assert!(validate("agents.approve", &json!({"name":"api","decision":"maybe"})).is_err());
        assert!(validate("agents.answer", &json!({"name":"api","answers":[["A"]]})).is_ok());
        assert!(validate("agents.answer", &json!({"name":"api"})).is_err());
        assert!(validate("agents.answer", &json!({"name":"api","skip":true})).is_ok());
        assert!(validate("agents.read", &json!({"name":"api","maxChars":100})).is_err());
        assert!(validate("agents.list", &json!({})).is_ok());
        assert!(validate("agents.open", &json!({"name":"api"})).is_ok());
        assert!(validate("agents.launch", &json!({})).is_err());
    }

    #[test]
    fn wake_message_names_each_event_and_the_roster() {
        let events = vec![
            Event {
                session: 7,
                name: "api".into(),
                kind: EventKind::Finished,
                at: 0,
                report: "STATUS: DONE".into(),
                elapsed: Some(125_000),
            },
            Event {
                session: 8,
                name: "web".into(),
                kind: EventKind::Blocked(request("r1")),
                at: 0,
                report: String::new(),
                elapsed: None,
            },
        ];
        let text = wake_message(
            &events,
            &[("api".into(), State::Idle), ("web".into(), State::Blocked)],
            false,
        );
        assert!(!text.contains("last automatic update"));
        assert!(wake_message(&events, &[], true).contains("last automatic update"));
        assert!(text.starts_with("[Orchestration update] api finished · web needs input\n"));
        let (summary, detail) = update_parts(&text).unwrap();
        assert_eq!(summary, "api finished · web needs input");
        assert!(detail.starts_with("- api finished its turn"));
        assert_eq!(update_parts("[Delegated work completed]\nAll done"), None);
        assert!(text.contains("api finished its turn, 2m 5s."));
        assert!(text.contains("STATUS: DONE"));
        assert!(text.contains("web needs input: approval \"Run command\" (requestId r1)"));
        assert!(text.contains("npm install"));
        assert!(text.contains("Agents: api idle, web blocked"));
        let json = events[1].json(100);
        assert_eq!(json["needsInput"]["requestId"], "r1");
        assert_eq!(json["state"], "blocked");
    }
}
