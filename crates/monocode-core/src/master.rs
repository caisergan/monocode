//! Master: one agent that directs sessions across every local project. It
//! reads sessions, proposes a plan the user starts, then messages or starts
//! the sessions that do the work and reads what they report. Every rule about
//! what it may do lives here, so MonoCode, not the model, keeps it inside the
//! plan the user approved. See `docs/native/master.md`.
use crate::{agent::AccessMode, files::path_key, orchestration as orch};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(test)]
mod tests;

/// Settings rows; Master needs no tables of its own.
pub const CONFIG_KEY: &str = "master.config";
pub const STATE_KEY: &str = "master.state";
/// Opens every wake-up turn, so the transcript can draw it as a marker.
pub const UPDATE_TAG: &str = "[Master update]";
pub const MAX_STEPS: usize = 12;
/// The app bridge answers within 60 seconds; leave room for the reply.
pub const MAX_WAIT_SECONDS: u64 = 45;
const MAX_ACTIVITY: usize = 1_000;
const MAX_MAILBOX: usize = 128;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    /// Master's own chat.
    pub session: Option<i64>,
    pub harness: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Project paths Master cannot see. New projects are included.
    pub excluded: Vec<String>,
    /// Sessions the user hid from Master ("Hide from Master").
    pub hidden: Vec<i64>,
    /// Models a step may run on; the first for a harness is its default.
    /// Empty allows any model.
    pub models: Vec<AllowedModel>,
    /// The access a new plan proposes.
    pub access: AccessMode,
    pub safe_list: Vec<SafeCommand>,
    /// Sessions working for Master at once, over all tasks.
    pub max_sessions: usize,
    /// Automatic updates between two messages from the user.
    pub max_updates: u32,
    pub paused: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            session: None,
            harness: "pi".into(),
            model: None,
            effort: None,
            excluded: Vec::new(),
            hidden: Vec::new(),
            models: Vec::new(),
            access: AccessMode::Auto,
            safe_list: Vec::new(),
            max_sessions: 6,
            max_updates: 60,
            paused: false,
        }
    }
}
impl Config {
    pub fn includes(&self, project: &str) -> bool {
        !project.starts_with("remote://")
            && !self
                .excluded
                .iter()
                .any(|p| path_key(p) == path_key(project))
    }
    /// The model a step runs on: the one asked for when the list allows it,
    /// otherwise the list's first model for that harness.
    pub fn step_model(&self, harness: &str, model: Option<&str>) -> Result<Option<String>, String> {
        let listed: Vec<&AllowedModel> = self
            .models
            .iter()
            .filter(|m| m.harness == harness)
            .collect();
        if self.models.is_empty() {
            return Ok(model.map(str::to_owned));
        }
        match model {
            None => listed
                .first()
                .map(|m| Some(m.model.clone()))
                .ok_or_else(|| {
                    format!(
                        "No {harness} model is on Master's list; use one of: {}",
                        self.model_names()
                    )
                }),
            Some(model) if listed.iter().any(|m| m.model == model) => Ok(Some(model.to_owned())),
            Some(model) => Err(format!(
                "{harness} model {model} is not on Master's list; use one of: {}",
                self.model_names()
            )),
        }
    }
    fn model_names(&self) -> String {
        self.models
            .iter()
            .map(|m| format!("{} {}", m.harness, m.model))
            .collect::<Vec<_>>()
            .join(", ")
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AllowedModel {
    pub harness: String,
    pub model: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafeCommand {
    pub project: String,
    pub command: String,
}

/// Access ordered from least to most: a step may not exceed its plan's.
pub fn rank(access: AccessMode) -> u8 {
    match access {
        AccessMode::ReadOnly => 0,
        AccessMode::Supervised => 1,
        AccessMode::AutoAcceptEdits => 2,
        AccessMode::Auto => 3,
        AccessMode::FullAccess => 4,
    }
}
/// The levels a plan offers.
pub fn plan_access(id: &str) -> Option<AccessMode> {
    match id {
        "supervised" => Some(AccessMode::Supervised),
        "auto" => Some(AccessMode::Auto),
        "full-access" => Some(AccessMode::FullAccess),
        _ => None,
    }
}
/// Pi has no approvals: its sessions never ask, whatever the access.
pub fn never_asks(harness: &str) -> bool {
    matches!(harness, "pi" | "omp")
}

// ---- Tasks and plans ----

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    /// Waiting for the user to start the plan.
    #[default]
    Proposed,
    Running,
    Done,
    /// The user declined the plan before it started.
    Cancelled,
    Stopped,
}
impl TaskState {
    pub fn id(self) -> &'static str {
        match self {
            TaskState::Proposed => "proposed",
            TaskState::Running => "running",
            TaskState::Done => "done",
            TaskState::Cancelled => "cancelled",
            TaskState::Stopped => "stopped",
        }
    }
    pub fn open(self) -> bool {
        matches!(self, TaskState::Proposed | TaskState::Running)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Target {
    /// A new session in a new worktree.
    #[default]
    New,
    /// A follow-up to an existing session.
    Message,
    /// A new worktree session that continues an existing one with its recap.
    Continue,
}
impl Target {
    pub fn id(self) -> &'static str {
        match self {
            Target::New => "new",
            Target::Message => "message",
            Target::Continue => "continue",
        }
    }
    fn parse(id: &str) -> Option<Target> {
        [Target::New, Target::Message, Target::Continue]
            .into_iter()
            .find(|t| t.id() == id)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    /// Not started; waits for the plan, its `after` steps or master.start.
    #[default]
    Planned,
    /// Asked to start; waits for its checkout or a free session slot.
    Queued,
    Starting,
    Working,
    Blocked,
    /// Its session finished a turn; Master reviews it.
    Idle,
    Done,
    Failed,
    Stopped,
    UsageLimited,
    /// The user took the session over; Master waits.
    Yours,
}
impl StepStatus {
    pub fn id(self) -> &'static str {
        match self {
            StepStatus::Planned => "planned",
            StepStatus::Queued => "queued",
            StepStatus::Starting => "starting",
            StepStatus::Working => "working",
            StepStatus::Blocked => "blocked",
            StepStatus::Idle => "idle",
            StepStatus::Done => "done",
            StepStatus::Failed => "failed",
            StepStatus::Stopped => "stopped",
            StepStatus::UsageLimited => "usageLimited",
            StepStatus::Yours => "yours",
        }
    }
    /// A session is working for this step.
    pub fn live(self) -> bool {
        matches!(
            self,
            StepStatus::Starting | StepStatus::Working | StepStatus::Blocked
        )
    }
    /// Steps that name this one in `after` may start.
    pub fn settled(self) -> bool {
        matches!(self, StepStatus::Idle | StepStatus::Done)
    }
    pub fn from_state(state: orch::State) -> StepStatus {
        match state {
            orch::State::Starting => StepStatus::Starting,
            orch::State::Working => StepStatus::Working,
            orch::State::Blocked => StepStatus::Blocked,
            orch::State::Idle => StepStatus::Idle,
            orch::State::Stopped => StepStatus::Stopped,
            orch::State::Failed => StepStatus::Failed,
            orch::State::UsageLimited => StepStatus::UsageLimited,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Step {
    /// "1", "2", … in plan order; a plan change continues the count.
    pub id: String,
    pub title: String,
    pub project: String,
    pub target: Target,
    /// The session messaged or continued.
    pub source: Option<i64>,
    pub prompt: String,
    pub harness: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: AccessMode,
    /// Steps that must be idle or done before this one starts.
    pub after: Vec<String>,
    /// The user chose to message a session in its main checkout.
    pub main_checkout: bool,
    /// The session doing the step, once started.
    pub session: Option<i64>,
    pub checkout: Option<String>,
    pub branch: Option<String>,
    pub status: StepStatus,
    /// Why it waits, or how it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}
impl Step {
    pub fn never_asks(&self) -> bool {
        never_asks(&self.harness)
    }
    pub fn json(&self) -> Value {
        let mut value = json!({
            "step": self.id,
            "title": self.title,
            "project": self.project,
            "target": self.target.id(),
            "harness": self.harness,
            "access": self.access.id(),
            "status": self.status.id(),
        });
        for (key, field) in [
            ("model", &self.model),
            ("effort", &self.effort),
            ("checkout", &self.checkout),
            ("branch", &self.branch),
            ("note", &self.note),
        ] {
            if let Some(text) = field {
                value[key] = json!(text);
            }
        }
        if let Some(source) = self.source {
            value["sourceSessionId"] = json!(source);
        }
        if let Some(session) = self.session {
            value["sessionId"] = json!(session);
        }
        if !self.after.is_empty() {
            value["after"] = json!(self.after);
        }
        if self.never_asks() {
            value["neverAsks"] = json!(true);
        }
        if self.main_checkout {
            value["mainCheckout"] = json!(true);
        }
        value
    }
}

/// A change Master proposed to a running plan, waiting for the user.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Change {
    pub reason: String,
    pub steps: Vec<Step>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<AccessMode>,
    pub at: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub state: TaskState,
    pub access: AccessMode,
    pub steps: Vec<Step>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<Change>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    /// An app restart cut its sessions' turns; nothing reran by itself.
    pub restarted: bool,
}
impl Task {
    pub fn step(&self, id: &str) -> Result<usize, String> {
        self.steps
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| format!("Task {} has no step {id}", self.id))
    }
    /// Why step `ix` cannot start yet, or None when it can.
    pub fn blocked_start(&self, ix: usize) -> Option<String> {
        let step = &self.steps[ix];
        if self.state != TaskState::Running {
            return Some(format!("Task {} is {}", self.id, self.state.id()));
        }
        if !matches!(step.status, StepStatus::Planned | StepStatus::Queued) {
            return Some(format!(
                "Step {} already ran ({}); use master.message to give its session more work",
                step.id,
                step.status.id()
            ));
        }
        let waiting: Vec<&str> = step
            .after
            .iter()
            .filter(|id| {
                self.steps
                    .iter()
                    .find(|s| &&s.id == id)
                    .is_some_and(|s| !s.status.settled())
            })
            .map(String::as_str)
            .collect();
        (!waiting.is_empty())
            .then(|| format!("Step {} waits for step {}", step.id, waiting.join(" and ")))
    }
    /// One line per step, for wake-ups and master.tasks.
    pub fn json(&self) -> Value {
        let mut value = json!({
            "task": self.id,
            "title": self.title,
            "state": self.state.id(),
            "access": self.access.id(),
            "steps": self.steps.iter().map(Step::json).collect::<Vec<_>>(),
        });
        if let Some(change) = &self.change {
            value["pendingChange"] = json!({
                "reason": change.reason,
                "steps": change.steps.iter().map(Step::json).collect::<Vec<_>>(),
                "access": change.access.map(AccessMode::id),
            });
        }
        if let Some(report) = &self.report {
            value["report"] = json!(crate::response::limit(report, 2_000));
        }
        if self.restarted {
            value["restarted"] = json!(true);
        }
        value
    }
}

/// What the plan checks need to know about the app. The shell fills it.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    /// Local projects Master may address (excluded ones already left out).
    pub projects: Vec<String>,
    pub sessions: Vec<SessionFact>,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionFact {
    pub id: i64,
    pub project: String,
    pub title: String,
    pub harness: String,
    /// Its own worktree; None when it works in the main checkout.
    pub worktree: Option<String>,
    /// Running a turn, stopping, or preparing its checkout.
    pub busy: bool,
    /// Never shown to Master: an excluded project, a Mono, an agent of a
    /// lead, or Master itself.
    pub hidden: bool,
}
impl SessionFact {
    pub fn checkout(&self) -> &str {
        self.worktree.as_deref().unwrap_or(&self.project)
    }
}
impl Facts {
    pub fn session(&self, id: i64) -> Result<&SessionFact, String> {
        self.sessions
            .iter()
            .find(|s| s.id == id && !s.hidden)
            .ok_or_else(|| format!("Session {id} is not one Master can see"))
    }
    /// A project by path or by its folder name.
    pub fn project(&self, given: &str) -> Result<String, String> {
        if let Some(path) = self
            .projects
            .iter()
            .find(|p| path_key(p) == path_key(given))
        {
            return Ok(path.clone());
        }
        let named: Vec<&String> = self
            .projects
            .iter()
            .filter(|p| crate::search::project_name(p) == given)
            .collect();
        match named.as_slice() {
            [one] => Ok((*one).clone()),
            [] => Err(format!(
                "{given} is not a project Master can see; run master.projects"
            )),
            _ => Err(format!("Several projects are named {given}; pass its path")),
        }
    }
    /// Another busy session writing in `checkout`.
    pub fn writer(&self, checkout: &str, except: Option<i64>) -> Option<&SessionFact> {
        self.sessions.iter().find(|s| {
            s.busy && Some(s.id) != except && path_key(s.checkout()) == path_key(checkout)
        })
    }
}

/// A plan from `master.plan` or the steps of `master.change`, checked
/// against the configuration and the app. `first` numbers the steps;
/// `cap` is the plan's access.
pub fn parse_steps(
    input: &Value,
    config: &Config,
    facts: &Facts,
    cap: AccessMode,
    first: usize,
    earlier: &[Step],
) -> Result<Vec<Step>, String> {
    let given = input["steps"].as_array().ok_or("Provide steps")?;
    if given.is_empty() || earlier.len() + given.len() > MAX_STEPS {
        return Err(format!("A plan has 1 to {MAX_STEPS} steps"));
    }
    let mut steps: Vec<Step> = Vec::new();
    for (offset, raw) in given.iter().enumerate() {
        let number = first + offset;
        let fail = |e: String| format!("Step {number}: {e}");
        let text = |key: &str, max: usize| -> Result<Option<String>, String> {
            match raw.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) if !s.trim().is_empty() && s.len() <= max => {
                    Ok(Some(s.trim().to_owned()))
                }
                Some(_) => Err(fail(format!("{key} must be text up to {max} bytes"))),
            }
        };
        let object = raw
            .as_object()
            .ok_or_else(|| fail("must be an object".into()))?;
        for key in object.keys() {
            if !"title project target sessionId prompt harness model effort access after"
                .split_whitespace()
                .any(|f| f == key)
            {
                return Err(fail(format!("does not take {key}")));
            }
        }
        let title = text("title", 160)?.ok_or_else(|| fail("Provide title".into()))?;
        let prompt = text("prompt", 240_000)?.ok_or_else(|| fail("Provide prompt".into()))?;
        let project = facts
            .project(&text("project", 4_096)?.ok_or_else(|| fail("Provide project".into()))?)
            .map_err(fail)?;
        let target = match text("target", 16)? {
            None => Target::New,
            Some(id) => Target::parse(&id)
                .ok_or_else(|| fail("target is new, message or continue".into()))?,
        };
        let source = match raw.get("sessionId") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_i64()
                    .ok_or_else(|| fail("sessionId must be a session ID".into()))?,
            ),
        };
        let mut harness = text("harness", 32)?;
        match (target, source) {
            (Target::New, Some(_)) => {
                return Err(fail("target new takes no sessionId".into()));
            }
            (Target::New, None) => {}
            (_, None) => return Err(fail(format!("target {} needs sessionId", target.id()))),
            (_, Some(id)) => {
                let session = facts.session(id).map_err(fail)?;
                if path_key(&session.project) != path_key(&project) {
                    return Err(fail(format!(
                        "session {id} is in {}, not {project}",
                        session.project
                    )));
                }
                if target == Target::Message && session.worktree.is_none() {
                    return Err(fail(format!(
                        "session {id} works in the main checkout of {project}; use target continue to carry it on in a new worktree session"
                    )));
                }
                if target == Target::Message {
                    // A follow-up runs on the session's own provider.
                    harness = Some(session.harness.clone());
                }
            }
        }
        let harness = harness.unwrap_or_else(|| {
            config
                .models
                .first()
                .map(|m| m.harness.clone())
                .unwrap_or_else(|| "claude".into())
        });
        let model = if target == Target::Message {
            text("model", 200)?
        } else {
            config
                .step_model(&harness, text("model", 200)?.as_deref())
                .map_err(fail)?
        };
        let access = match text("access", 32)? {
            None => cap,
            Some(id) => AccessMode::from_id(&id),
        };
        if rank(access) > rank(cap) {
            return Err(fail(format!(
                "access {} is above the plan's {}",
                access.id(),
                cap.id()
            )));
        }
        let after = match raw.get("after") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item {
                    Value::String(s) => Ok(s.clone()),
                    Value::Number(n) => Ok(n.to_string()),
                    _ => Err(fail("after lists step numbers".into())),
                })
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err(fail("after lists step numbers".into())),
        };
        for id in &after {
            // Only earlier steps, so a plan never waits on itself.
            let known = earlier.iter().any(|s| &s.id == id)
                || id.parse::<usize>().is_ok_and(|n| n >= first && n < number);
            if !known {
                return Err(fail(format!(
                    "after names step {id}, which does not come before it"
                )));
            }
        }
        steps.push(Step {
            id: number.to_string(),
            title,
            project,
            target,
            source,
            prompt,
            harness,
            model,
            effort: text("effort", 32)?,
            access,
            after,
            ..Step::default()
        });
    }
    // Two steps that would write in one checkout at the same time.
    for (ix, step) in steps.iter().enumerate() {
        if step.target != Target::Message {
            continue;
        }
        if let Some(other) = steps[..ix].iter().chain(earlier.iter()).find(|s| {
            s.target == Target::Message && s.source == step.source && !step.after.contains(&s.id)
        }) {
            return Err(format!(
                "Steps {} and {} both message session {}; one writer per checkout, so make one wait for the other with after",
                other.id,
                step.id,
                step.source.unwrap_or_default()
            ));
        }
    }
    Ok(steps)
}

/// A proposed task from `master.plan`.
pub fn parse_plan(
    input: &Value,
    config: &Config,
    facts: &Facts,
    id: String,
    now: u64,
) -> Result<Task, String> {
    let title = input["title"]
        .as_str()
        .filter(|t| !t.trim().is_empty() && t.len() <= 160)
        .ok_or("Provide title (up to 160 bytes)")?
        .trim()
        .to_owned();
    let access = match input["access"].as_str() {
        None => config.access,
        Some(id) => plan_access(id).ok_or("access is supervised, auto or full-access")?,
    };
    let steps = parse_steps(input, config, facts, access, 1, &[])?;
    Ok(Task {
        id,
        title,
        state: TaskState::Proposed,
        access,
        steps,
        created_at: now,
        ..Task::default()
    })
}

// ---- Approvals ----

/// A command that runs more than one thing, or redirects, always asks.
pub fn chained(command: &str) -> bool {
    ["&&", "||", ";", "|", "`", "$(", "\n", ">", "<", "&"]
        .iter()
        .any(|token| command.contains(token))
}
/// Commands that can never be on the safe list: they leave this machine,
/// delete, publish or deploy.
pub fn never_safe(command: &str) -> Option<&'static str> {
    let words: Vec<String> = command
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c| c == '"' || c == '\'')
                .to_ascii_lowercase()
        })
        .collect();
    let has = |w: &str| words.iter().any(|word| word == w);
    if has("push") || has("publish") || has("release") {
        Some("it publishes or pushes")
    } else if has("deploy") || words.iter().any(|w| w.starts_with("deploy")) {
        Some("it deploys")
    } else if ["rm", "rmdir", "delete", "unlink", "clean", "prune", "drop"]
        .iter()
        .any(|w| has(w))
        || words.iter().any(|w| {
            w == "--hard" || (w.starts_with("-d") && words.first().is_some_and(|f| f == "git"))
        })
    {
        Some("it deletes")
    } else if [
        "ssh",
        "scp",
        "rsync",
        "curl",
        "wget",
        "nc",
        "sftp",
        "ftp",
        "kubectl",
        "helm",
        "terraform",
        "aws",
        "gcloud",
        "az",
        "flyctl",
        "vercel",
        "netlify",
        "heroku",
    ]
    .iter()
    .any(|w| has(w))
    {
        Some("it reaches another machine")
    } else if has("sudo") {
        Some("it runs as root")
    } else {
        None
    }
}
/// Whether `command` may be added to the safe list.
pub fn can_add_safe(command: &str) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() || command.len() > 400 {
        return Err("A safe command is 1 to 400 bytes".into());
    }
    if chained(command) {
        return Err("A safe command runs one thing: no &&, ;, pipes or redirects".into());
    }
    if let Some(reason) = never_safe(command) {
        return Err(format!(
            "This command can never be on the safe list: {reason}"
        ));
    }
    Ok(())
}
/// Master may allow `command` in `project`: an exact entry for that project.
pub fn safe(config: &Config, project: &str, command: &str) -> bool {
    let command = command.trim();
    can_add_safe(command).is_ok()
        && config.safe_list.iter().any(|entry| {
            path_key(&entry.project) == path_key(project) && entry.command.trim() == command
        })
}

// ---- Updates ----

/// A request a driven session waits on, as Master hears about it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Ask {
    pub id: String,
    /// approval or question.
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub items: Value,
    /// On the safe list: Master may allow it.
    pub safe: bool,
}
impl Ask {
    pub fn from_request(request: &orch::Request, safe: bool) -> Ask {
        Ask {
            id: request.id.clone(),
            kind: request.kind.into(),
            title: request.title.clone(),
            detail: request.detail.clone(),
            items: request.items.clone(),
            safe,
        }
    }
}

/// Something Master should hear about one of its steps.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Update {
    pub task: String,
    pub step: String,
    pub session: i64,
    pub project: String,
    /// finished, stopped, failed, usageLimited, blocked, or decided: the
    /// user decided a plan change (`report` says how).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<Ask>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub report: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed: Option<u64>,
    pub at: u64,
}
impl Update {
    pub fn new(task: &Task, step: &Step, event: &orch::Event, safe: bool) -> Update {
        let (kind, error, ask) = match &event.kind {
            orch::EventKind::Finished => ("finished", None, None),
            orch::EventKind::Stopped => ("stopped", None, None),
            orch::EventKind::Failed(error) => ("failed", Some(error.clone()), None),
            orch::EventKind::UsageLimited => ("usageLimited", None, None),
            orch::EventKind::Blocked(request) => {
                ("blocked", None, Some(Ask::from_request(request, safe)))
            }
        };
        Update {
            task: task.id.clone(),
            step: step.id.clone(),
            session: event.session,
            project: step.project.clone(),
            kind: kind.into(),
            error,
            ask,
            report: event.report.clone(),
            elapsed: event.elapsed,
            at: event.at,
        }
    }
    pub fn json(&self, report_chars: usize) -> Value {
        let mut value = json!({
            "task": self.task,
            "step": self.step,
            "sessionId": self.session,
            "project": self.project,
            "event": self.kind,
            "at": self.at,
        });
        if let Some(elapsed) = self.elapsed {
            value["elapsedSeconds"] = json!(elapsed / 1_000);
        }
        if let Some(error) = &self.error {
            value["error"] = json!(crate::response::limit(error, 2_000));
        }
        if let Some(ask) = &self.ask {
            value["needsInput"] = json!({
                "requestId": orch::public_request_id(&ask.id),
                "kind": ask.kind,
                "title": ask.title,
                "detail": crate::response::limit(&ask.detail, 2_000),
                "items": ask.items,
                "masterMayAllow": ask.safe,
            });
        }
        if !self.report.is_empty() {
            value["finalMessage"] = json!(orch::tail(&self.report, report_chars));
        }
        value
    }
    /// The user's decision on a plan change, for Master's next turn.
    pub fn decided(task: &Task, text: String, at: u64) -> Update {
        Update {
            task: task.id.clone(),
            kind: "decided".into(),
            report: text,
            at,
            ..Update::default()
        }
    }
    fn clause(&self) -> String {
        if self.kind == "decided" {
            return format!("task {} has the user's decision", self.task);
        }
        format!(
            "{} {}",
            crate::search::project_name(&self.project),
            match self.kind.as_str() {
                "finished" => "finished",
                "stopped" => "stopped",
                "failed" => "failed",
                "usageLimited" => "hit a usage limit",
                _ => "needs input",
            }
        )
    }
}

/// The wake-up turn Master receives when its steps' work changes. Its first
/// line is the tag and one clause per update. `last`: the final automatic
/// update before the user writes again.
pub fn wake_message(updates: &[Update], tasks: &[Task], last: bool) -> String {
    let mut clauses: Vec<String> = Vec::new();
    for update in updates {
        let clause = update.clause();
        if !clauses.contains(&clause) {
            clauses.push(clause);
        }
    }
    let mut out = format!("{UPDATE_TAG} {}\n", clauses.join(" · "));
    for update in updates {
        if update.kind == "decided" {
            out.push_str(&format!("- Task {}: {}\n", update.task, update.report));
            continue;
        }
        let task = tasks.iter().find(|t| t.id == update.task);
        let step = task.and_then(|t| t.steps.iter().find(|s| s.id == update.step));
        let place = format!(
            "Task {} step {} ({}{})",
            update.task,
            update.step,
            crate::search::project_name(&update.project),
            step.map(|s| format!(", {}", s.title)).unwrap_or_default()
        );
        let elapsed = update
            .elapsed
            .map(|ms| format!(", {}s", ms / 1_000))
            .unwrap_or_default();
        let line = match update.kind.as_str() {
            "finished" => format!("{place} finished its turn{elapsed}."),
            "stopped" => format!("{place} was stopped{elapsed}."),
            "failed" => format!(
                "{place} failed{elapsed}: {}",
                crate::response::limit(update.error.as_deref().unwrap_or("").trim(), 600)
            ),
            "usageLimited" => format!("{place} stopped at a provider usage limit{elapsed}."),
            _ => {
                let ask = update.ask.clone().unwrap_or_default();
                let mut line = format!(
                    "{place} needs input: {} \"{}\" (requestId {}).",
                    ask.kind,
                    ask.title,
                    orch::public_request_id(&ask.id)
                );
                if !ask.detail.is_empty() {
                    line.push_str(&format!(
                        "\n  {}",
                        crate::response::limit(ask.detail.trim(), 600).replace('\n', "\n  ")
                    ));
                }
                line.push_str(if ask.kind == "question" {
                    "\n  Answer with master.answer if the plan already settles it; otherwise tell the user."
                } else if ask.safe {
                    "\n  It is on the safe list: you may allow it with master.approve."
                } else {
                    "\n  It is not on the safe list, so it is the user's to decide. Say what it is and whether you would allow it."
                });
                line
            }
        };
        out.push_str(&format!("- {line}\n"));
        if !update.report.is_empty() {
            out.push_str(&format!(
                "  Final message:\n  {}\n",
                orch::tail(&update.report, 3_000)
                    .trim()
                    .replace('\n', "\n  ")
            ));
        }
    }
    let open: Vec<&Task> = tasks.iter().filter(|t| t.state.open()).collect();
    for task in open {
        out.push_str(&format!(
            "\nTask {} \"{}\": {}",
            task.id,
            task.title,
            task.steps
                .iter()
                .map(|s| format!("{} {}", s.id, s.status.id()))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    out.push_str("\n\nRead finished work (master.read; view last), check the diff and the test output it reports, then send it back with master.message, start the next steps with master.start, mark steps done with master.done, or end the task with master.finish. Tell the user only what changed for them. Do not poll; the next update arrives on its own.");
    if last {
        out.push_str("\n\nThis is the last automatic update until the user writes to you. Tell the user that Master is paused until they reply.");
    }
    out
}

// ---- Saved state ----

/// What Master did, recorded by MonoCode rather than told by the model.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Activity {
    pub at: u64,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub tasks: Vec<Task>,
    /// Updates Master has not heard yet, oldest first.
    pub mailbox: Vec<Update>,
    pub activity: Vec<Activity>,
    pub next_task: u64,
    /// Automatic updates since the user last wrote to Master.
    pub updates: u32,
}
impl State {
    pub fn new_task_id(&mut self) -> String {
        self.next_task += 1;
        format!("t{}", self.next_task)
    }
    pub fn task(&self, id: &str) -> Result<usize, String> {
        self.tasks
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| format!("No task {id}; run master.tasks"))
    }
    /// The open task and step a session works for.
    pub fn step_of(&self, session: i64) -> Option<(usize, usize)> {
        self.tasks.iter().enumerate().rev().find_map(|(t, task)| {
            task.state
                .open()
                .then(|| task.steps.iter().position(|s| s.session == Some(session)))
                .flatten()
                .map(|s| (t, s))
        })
    }
    /// Live steps over all tasks, against `Config::max_sessions`.
    pub fn live_steps(&self) -> usize {
        self.tasks
            .iter()
            .filter(|t| t.state == TaskState::Running)
            .flat_map(|t| &t.steps)
            .filter(|s| s.status.live())
            .count()
    }
    pub fn record(&mut self, activity: Activity) {
        self.activity.push(activity);
        if self.activity.len() > MAX_ACTIVITY {
            let excess = self.activity.len() - MAX_ACTIVITY;
            self.activity.drain(..excess);
        }
    }
    pub fn push_update(&mut self, update: Update) {
        self.mailbox.push(update);
        if self.mailbox.len() > MAX_MAILBOX {
            let excess = self.mailbox.len() - MAX_MAILBOX;
            self.mailbox.drain(..excess);
        }
    }
    /// No turn survives an app restart: live steps read as stopped, and their
    /// tasks wait for the user. Returns how many turns were cut.
    pub fn after_restart(&mut self) -> usize {
        let mut cut = 0;
        for task in self
            .tasks
            .iter_mut()
            .filter(|t| t.state == TaskState::Running)
        {
            for step in &mut task.steps {
                if step.status.live() {
                    step.status = StepStatus::Stopped;
                    step.note = Some("MonoCode restarted in the middle of its turn".into());
                    task.restarted = true;
                    cut += 1;
                }
            }
        }
        cut
    }
}

// ---- Actions ----

/// Reject misspelled fields and wrong types before any Master action runs.
pub fn validate(action: &str, input: &Value) -> Result<(), String> {
    let fields = match action {
        "master.projects" | "master.tasks" | "master.help" => "",
        "master.sessions" => "project query limit offset",
        "master.search" => "query project limit",
        "master.read" => "sessionId view before limit maxChars",
        "master.plan" => "title access steps",
        "master.change" => "task reason steps access",
        "master.start" => "task step",
        "master.message" => "task step prompt mode",
        "master.wait" => "timeoutSeconds",
        "master.approve" => "task step requestId decision",
        "master.answer" => "task step requestId answers skip",
        "master.stop" => "task step",
        "master.done" => "task step note",
        "master.finish" => "task report",
        _ => return Err("Unknown Master action. Run master.help".into()),
    };
    let object = input.as_object().ok_or("Input must be an object")?;
    for (key, value) in object {
        if !fields.split_whitespace().any(|f| f == key) {
            return Err(format!("{action} does not take {key}"));
        }
        let ok = match key.as_str() {
            "skip" => value.is_boolean(),
            "limit" | "offset" | "maxChars" | "timeoutSeconds" => value.as_u64().is_some(),
            "sessionId" => value.as_i64().is_some() || value.is_string(),
            "before" => value.is_string() || value.as_u64().is_some(),
            "step" => value.is_string() || value.as_u64().is_some(),
            "steps" => value.is_array(),
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
            return Err(format!("{key} has the wrong type; run master.help"));
        }
    }
    let required = |key: &str| -> Result<(), String> {
        match input.get(key) {
            Some(Value::String(s)) if s.trim().is_empty() => Err(format!("Provide {key}")),
            Some(_) => Ok(()),
            None => Err(format!("Provide {key}")),
        }
    };
    match action {
        "master.search" => required("query")?,
        "master.read" => required("sessionId")?,
        "master.plan" => {
            required("title")?;
            required("steps")?;
        }
        "master.change" => {
            required("task")?;
            required("reason")?;
            if input.get("steps").is_none() && input.get("access").is_none() {
                return Err("A plan change adds steps, raises access, or both".into());
            }
        }
        "master.start" | "master.stop" => required("task")?,
        "master.message" => {
            required("task")?;
            required("step")?;
            required("prompt")?;
        }
        "master.approve" => {
            required("task")?;
            required("step")?;
            required("decision")?;
        }
        "master.answer" => {
            required("task")?;
            required("step")?;
            if input.get("answers").is_some() == (input["skip"] == true) {
                return Err("Provide answers, or skip: true".into());
            }
        }
        "master.done" => {
            required("task")?;
            required("step")?;
        }
        "master.finish" => {
            required("task")?;
            required("report")?;
        }
        _ => {}
    }
    if action == "master.start" && input.get("step").is_none() {
        return Err("Provide step".into());
    }
    let one_of = |key: &str, allowed: &[&str]| match input.get(key) {
        Some(value) if !value.as_str().is_some_and(|v| allowed.contains(&v)) => {
            Err(format!("{key} must be one of: {}", allowed.join(", ")))
        }
        _ => Ok(()),
    };
    one_of("view", &["auto", "activity", "last", "history"])?;
    one_of("mode", &["auto", "steer", "queue"])?;
    one_of("decision", &["allow", "deny"])?;
    one_of("access", &["supervised", "auto", "full-access"])?;
    if input
        .get("timeoutSeconds")
        .is_some_and(|t| t.as_u64() > Some(MAX_WAIT_SECONDS))
    {
        return Err(format!("timeoutSeconds must be at most {MAX_WAIT_SECONDS}"));
    }
    if input
        .get("limit")
        .is_some_and(|l| !(1..=50).contains(&l.as_u64().unwrap_or(0)))
    {
        return Err("limit must be 1 to 50".into());
    }
    if input
        .get("maxChars")
        .is_some_and(|m| !(200..=20_000).contains(&m.as_u64().unwrap_or(0)))
    {
        return Err("maxChars must be 200 to 20,000".into());
    }
    for key in ["prompt", "report"] {
        if input[key].as_str().is_some_and(|p| p.len() > 240_000) {
            return Err(format!("{key} is limited to 240,000 bytes"));
        }
    }
    Ok(())
}
/// Actions that change nothing, so they need no durable receipt.
pub fn reads(action: &str) -> bool {
    matches!(
        action,
        "master.projects"
            | "master.sessions"
            | "master.search"
            | "master.read"
            | "master.tasks"
            | "master.wait"
            | "master.help"
    )
}
/// A step number given as text or a number.
pub fn step_id(input: &Value) -> Option<String> {
    match &input["step"] {
        Value::String(s) => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub const HELP: &str = r#"MonoCode Master
You direct the user's sessions across their projects. You can read and plan; the sessions do the work. You never edit files yourself.
Call each action with its JSON input. Projects take a path or a folder name.

master.projects {}
  Projects you can see, with their session counts.
master.sessions {project?, query?, limit?, offset?}
  Sessions newest first: title, project, checkout (main or its worktree), branch, busy, harness, model, and the task driving it. query filters titles.
master.search {query, project?, limit?}
  Search message text across sessions. Use it to find sessions that already know the subject.
master.read {sessionId, view?, before?, limit?, maxChars?}
  view "activity": the latest turn's prompt, steps and latest text. "last": the final message and edited files. "history": earlier exchanges (before/limit page back). "auto" (default) picks activity while it works.
master.plan {title, access?, steps:[{title, project, target, sessionId?, prompt, harness?, model?, effort?, access?, after?}]}
  Propose a plan. Nothing runs until the user starts it. access: supervised, auto (default) or full-access; a step may not exceed it. target "message": a follow-up to sessionId, only for a session in its own worktree. "continue": a new worktree session that carries sessionId on with its recap; use it for sessions in the main checkout. "new": a new session in a new worktree. prompt is exactly what the session gets: the goal, what to read, how to test, and to commit on its branch and end with a short report. after lists earlier step numbers this one waits for. Steps without after start when the user starts the plan.
master.change {task, reason, steps?, access?}
  Ask the user to add steps, another project, or a higher access to a running task. Until they decide, nothing beyond the plan runs.
master.start {task, step}
  Start a step whose after steps are idle or done. It waits while another session works in its checkout.
master.message {task, step, prompt, mode?}
  Give a step's session more work, or send its work back with the reason. It waits behind the user's turn; mode "steer" adds it to a turn you started.
master.approve {task, step, requestId?, decision}
  decision allow (only for requests on the user's safe list) or deny.
master.answer {task, step, requestId?, answers | skip:true}
  Answer a session's question when the plan already settles it. answers: one array of chosen labels or free text per question item.
master.stop {task, step?}
  Stop a step's turn, or every step of the task.
master.done {task, step, note?}
  Mark a step done after you checked its diff and its test output.
master.finish {task, report}
  End the task: what changed where, what you checked, and what is left to the user.
master.tasks {}
  Every task with its steps and their states.
master.wait {timeoutSeconds?}
  Waits up to 45 s for an update. MonoCode wakes you with a [Master update] turn anyway, so you rarely need it.

Rules MonoCode enforces: you only reach projects the user included; nothing starts outside an approved plan; a step never runs above its plan's access; one session writes in a checkout at a time; your messages never interrupt the user's turn or touch their draft. Never push, open pull requests or deploy: the user does that from the report.
"#;

/// Master's own instructions: `full` on its first turn, a reminder later.
pub fn context(full: bool) -> String {
    if !full {
        return "<monocode_master>\nYou are Master. Read with master.sessions, master.search and master.read, propose with master.plan, and drive started plans with master.start, master.message and master.done. MonoCode sends [Master update] turns; never poll. Never edit, push, open PRs or deploy.\n</monocode_master>".into();
    }
    format!(
        r#"<monocode_master>
MonoCode adds this context, not the user. You are Master: you direct the user's MonoCode sessions across their projects. You read sessions and files, plan, and send work to sessions; the sessions edit, test and commit. You never edit files and have no shell.

How to work:
1. Read before planning: search sessions that already know the subject (master.search), read the useful ones (master.read), and read the files that matter. Say what you looked at.
2. Propose one plan (master.plan) and end your turn. Prefer sessions that already have the context. A session in its own worktree gets a message; one in the main checkout is continued in a new worktree session (target continue). Write each step's prompt so the session never has to ask: the goal, what to read, exact changes, how to test, and to commit on its branch and end with a report of the commit, the tests and anything left open. Name the access each step needs; the user starts the plan.
3. While it runs, MonoCode wakes you with [Master update] turns when a session finishes, stops, fails or asks. Read finished work and its diff before calling a step done (master.done). If it is wrong, send it back with the reason (master.message). After two failed attempts, ask the user.
4. Requests: allow only what the update says is on the safe list; everything else is the user's, so say what it is and what you suggest. Answer questions your plan already settles; ask the user about anything that changes the goal.
5. Anything beyond the plan (another project, a new session, a higher access) is a plan change (master.change), never a workaround.
6. End with master.finish: what changed in each project, what you checked, and what is left to the user. Commits only: never push, open pull requests or deploy.
7. Write to the user only when something changed for them. Keep it short.

Reference:
{HELP}
</monocode_master>"#
    )
}

/// The first turn of a session Master starts for a step.
pub fn step_prompt(task: &Task, step: &Step, checkout: &str, branch: Option<&str>) -> String {
    let place = match branch {
        Some(branch) => format!("{checkout} (branch {branch})"),
        None => checkout.to_owned(),
    };
    format!(
        "MonoCode's Master started this session for step {} of the task \"{}\". Your checkout is {place}. Other sessions may work in parallel in their own checkouts; touch only what this step needs. Commit on your branch. Do not push, open pull requests or deploy. Master reads your final message as your report.\n\n{}",
        step.id, task.title, step.prompt
    )
}

/// Pi's `monocode` tool, written to the temp folder under a name that
/// changes with its content and loaded with `-e`. None when it cannot be
/// written; Master then runs with read tools only.
pub fn pi_extension() -> Option<std::path::PathBuf> {
    let source = include_str!("master/pi_extension.ts")
        .replace("__MONOCODE_HELP__", &serde_json::to_string(HELP).ok()?);
    let hash = crate::mono::files::content_hash(&source);
    let path = std::env::temp_dir().join(format!(
        "monocode-master-{}.ts",
        &hash[..hash.len().min(16)]
    ));
    if !path.is_file() {
        let partial = path.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&partial, &source).ok()?;
        std::fs::rename(&partial, &path).ok()?;
    }
    Some(path)
}
/// Master's tools on Pi: read tools and MonoCode's, no shell and no edits.
pub const PI_TOOLS: &str = "read,grep,find,ls,monocode";
/// Claude Code's built-in tools for Master; its MonoCode tool comes from the
/// `monocode_app` MCP server, and no other MCP server is loaded.
pub const CLAUDE_TOOLS: &str = "Read,Glob,Grep";
/// Providers whose launch keeps Master to reading and its own tool. Others
/// would hand it a shell, so they are refused until they have a route.
pub fn supported_harness(harness: &str) -> bool {
    matches!(harness, "pi" | "claude")
}

/// The sender recorded on a message and its turn: `master:<task>:<step>`.
pub fn sender(task: &str, step: &str) -> String {
    format!("master:{task}:{step}")
}
/// Whether a turn's sender is Master.
pub fn from_master(sender: Option<&str>) -> bool {
    sender.is_some_and(|s| s.starts_with("master:"))
}
