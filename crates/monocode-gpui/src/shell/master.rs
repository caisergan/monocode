//! Master's engine: the `master.*` actions of the Master session. Every
//! action is checked against Master's configuration and the plan the user
//! started (`monocode_core::master`). The sessions it drives are watched with
//! the orchestrator's observer, and Master is woken with one update turn once
//! it is idle. Tasks, updates and the activity log are saved as one settings
//! row, so they survive a restart. See `docs/native/master.md`.
use super::*;
use monocode_core::{
    agent::{AccessMode, Decision},
    app_access as app,
    files::path_key,
    master::{self as m, Activity, Facts, SessionFact, StepStatus, Target, TaskState, Update},
    mono::bridge::Call,
    orchestration::{self as orch, Event, EventKind, Watch},
};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Default)]
pub(super) struct Master {
    pub(super) config: m::Config,
    pub(super) state: m::State,
    /// Each driven session's state between observations.
    watches: HashMap<i64, Watch>,
    waits: Vec<(u64, Call)>,
    next_wait: u64,
    retrying: bool,
    /// Steps whose session is still being created: (task, step).
    starting: HashSet<(String, String)>,
}
impl Master {
    /// The saved configuration and state. No turn survives a restart, so
    /// steps that were working read as stopped and nothing reruns.
    pub(super) fn load(store: &Database) -> Self {
        let Ok(store) = locked(store) else {
            return Self::default();
        };
        let read = |key| store.setting(key).ok().flatten();
        let config = read(m::CONFIG_KEY)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let mut state: m::State = read(m::STATE_KEY)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        state.after_restart();
        Self {
            config,
            state,
            ..Self::default()
        }
    }
}

impl Shell {
    pub(super) fn is_master_session(&self, id: i64) -> bool {
        self.master.config.session == Some(id)
    }
    /// The Master chat that may call `master.*` now.
    fn master_caller(&self, id: i64) -> bool {
        self.master.config.enabled && self.is_master_session(id)
    }
    /// Make `id` Master's chat and save the configuration (the Master page
    /// calls this once it is set up). Master runs only on providers whose
    /// launch keeps it to reading and its own tool.
    #[expect(dead_code, reason = "called by the Master page, step 2")]
    pub(crate) fn configure_master(
        &mut self,
        config: m::Config,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let provider = config
            .session
            .and_then(|id| self.session_summaries.get(&id))
            .map_or(config.harness.as_str(), |s| s.provider.as_str());
        if !m::supported_harness(&config.harness) || !m::supported_harness(provider) {
            return Err("Master runs on Pi or Claude Code".into());
        }
        let previous = self.master.config.session;
        self.master.config = config;
        for id in [previous, self.master.config.session].into_iter().flatten() {
            let master = self.is_master_session(id);
            if let Some(view) = self.sessions.get(&id) {
                view.update(cx, |v, _| v.master = master);
            }
        }
        self.save_master_config(cx);
        self.master_start_queued(cx);
        self.deliver_master_updates(cx);
        Ok(())
    }
    #[expect(dead_code, reason = "called by the Master page, step 2")]
    fn save_master_config(&self, cx: &mut Context<Self>) {
        let store = self.store.clone();
        let raw = serde_json::to_string(&self.master.config).unwrap_or_default();
        cx.background_executor()
            .spawn(async move {
                let _ = locked(&store).and_then(|s| s.save_setting(m::CONFIG_KEY, &raw));
            })
            .detach();
    }
    fn save_master(&self, cx: &mut Context<Self>) {
        let store = self.store.clone();
        let raw = serde_json::to_string(&self.master.state).unwrap_or_default();
        cx.background_executor()
            .spawn(async move {
                let _ = locked(&store).and_then(|s| s.save_setting(m::STATE_KEY, &raw));
            })
            .detach();
        cx.notify();
    }
    fn master_record(
        &mut self,
        action: impl Into<String>,
        task: Option<&str>,
        session: Option<i64>,
        note: Option<String>,
    ) {
        let project = session
            .and_then(|id| self.session_summaries.get(&id))
            .map(|s| s.cwd.clone());
        self.master.state.record(Activity {
            at: monocode_core::time::now_ms(),
            action: action.into(),
            task: task.map(str::to_owned),
            project,
            session,
            note,
        });
    }

    /// What the plan checks see of the app. Hidden sessions stay in the list
    /// because they still write in their checkouts.
    fn master_facts(&self, cx: &App) -> Facts {
        let config = &self.master.config;
        let monos = self.monos.as_ref().map(|m| m.read(cx));
        let sessions = self
            .session_summaries
            .keys()
            .map(|&id| {
                let metadata = self.session_metadata(id, cx);
                let summary = metadata.summary;
                let worktree = match metadata.live {
                    Some(view) => view.settings.worktree_cwd.clone(),
                    None => self.session_worktrees.get(&id).cloned().flatten(),
                };
                SessionFact {
                    id,
                    project: summary.cwd.clone(),
                    title: metadata.display_title(),
                    harness: summary.provider.clone(),
                    worktree,
                    busy: metadata.busy,
                    hidden: summary.archived
                        || summary.cwd == "~"
                        || !config.includes(&summary.cwd)
                        || config.hidden.contains(&id)
                        || config.session == Some(id)
                        || self.orchestration_worker(id)
                        || monos.is_some_and(|m| m.is_mono_session(id)),
                }
            })
            .collect();
        let projects = self
            .workspace
            .projects
            .iter()
            .filter(|p| p.as_str() != "~" && config.includes(p))
            .cloned()
            .collect();
        Facts { projects, sessions }
    }
    fn master_session_id(&self, input: &Value, facts: &Facts) -> Result<i64, String> {
        let id = match &input["sessionId"] {
            Value::String(id) => locked(&self.store)?.resolve_session_id(id)?,
            value => value.as_i64().ok_or("Provide sessionId")?,
        };
        facts.session(id).map(|s| s.id)
    }
    /// The task and step an action names.
    fn master_step(&self, input: &Value) -> Result<(usize, usize), String> {
        let task = self
            .master
            .state
            .task(input["task"].as_str().unwrap_or_default())?;
        let step = m::step_id(input).ok_or("Provide step")?;
        Ok((task, self.master.state.tasks[task].step(&step)?))
    }

    pub(super) fn authorize_master_call(&self, call: &Call) -> Result<(), String> {
        m::validate(&call.action, &call.input)?;
        if !self.master_caller(call.session) {
            return Err("Only Master can use master actions.".into());
        }
        Ok(())
    }
    pub(super) fn dispatch_master_call(&mut self, call: Call, cx: &mut Context<Self>) {
        let input = call.input.clone();
        let result = match call.action.as_str() {
            "master.help" => Ok(json!({"help": m::HELP})),
            "master.projects" => Ok(self.master_projects(cx)),
            "master.sessions" => self.master_sessions(&input, cx),
            "master.search" => return self.master_search(call, cx),
            "master.read" => return self.master_read(call, cx),
            "master.wait" => return self.master_wait(call, cx),
            "master.tasks" => Ok(self.master_tasks()),
            "master.plan" => self.master_plan(&input, cx),
            "master.change" => self.master_change(&input, cx),
            "master.start" => self.master_start(&input, cx),
            "master.message" => self.master_message(&input, cx),
            "master.approve" => self.master_approve(&input, cx),
            "master.answer" => self.master_answer(&input, cx),
            "master.stop" => self.master_stop(&input, cx),
            "master.done" => self.master_done(&input, cx),
            "master.finish" => self.master_finish(&input, cx),
            _ => Err("Unknown Master action. Run master.help".into()),
        };
        self.finish_app_call(call, result, cx);
    }

    // ---- Reading ----

    fn master_projects(&self, cx: &App) -> Value {
        let facts = self.master_facts(cx);
        json!({"projects": facts.projects.iter().map(|project| {
            let sessions = facts.sessions.iter().filter(|s| !s.hidden && path_key(&s.project) == path_key(project)).count();
            json!({"project": project, "name": monocode_core::search::project_name(project), "sessions": sessions})
        }).collect::<Vec<_>>()})
    }
    fn master_sessions(&self, input: &Value, cx: &App) -> Result<Value, String> {
        let facts = self.master_facts(cx);
        let project = input["project"]
            .as_str()
            .map(|p| facts.project(p))
            .transpose()?;
        let query = input["query"].as_str().map(str::to_lowercase);
        let mut rows: Vec<(u64, Value)> = facts
            .sessions
            .iter()
            .filter(|s| !s.hidden)
            .filter(|s| {
                project
                    .as_ref()
                    .is_none_or(|p| path_key(p) == path_key(&s.project))
            })
            .filter(|s| {
                query
                    .as_ref()
                    .is_none_or(|q| s.title.to_lowercase().contains(q))
            })
            .map(|s| {
                let updated = self.session_metadata(s.id, cx).summary.updated_at;
                let live = self.sessions.get(&s.id).map(|v| v.read(cx));
                let mut value = json!({
                    "sessionId": s.id,
                    "title": s.title,
                    "project": s.project,
                    "harness": s.harness,
                    "busy": s.busy,
                    "updatedAt": updated,
                });
                match &s.worktree {
                    Some(tree) => value["worktree"] = json!(tree),
                    None => value["mainCheckout"] = json!(true),
                }
                if let Some(model) = live.and_then(|v| v.settings.model.clone()).or_else(|| {
                    self.session_details
                        .get(&s.id)
                        .and_then(|d| d.model.clone())
                }) {
                    value["model"] = json!(model);
                }
                if let Some(view) = live {
                    value["access"] = json!(view.settings.access.id());
                }
                if let Some((t, st)) = self.master.state.step_of(s.id) {
                    let task = &self.master.state.tasks[t];
                    value["task"] = json!(task.id);
                    value["step"] = json!(task.steps[st].id);
                }
                (updated, value)
            })
            .collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.0));
        let total = rows.len();
        let offset = input["offset"].as_u64().unwrap_or(0) as usize;
        let limit = input["limit"].as_u64().unwrap_or(20) as usize;
        Ok(json!({
            "total": total,
            "sessions": rows.into_iter().skip(offset).take(limit).map(|(_, v)| v).collect::<Vec<_>>(),
        }))
    }
    fn master_search(&mut self, call: Call, cx: &mut Context<Self>) {
        let facts = self.master_facts(cx);
        let project = match call.input["project"]
            .as_str()
            .map(|p| facts.project(p))
            .transpose()
        {
            Ok(project) => project,
            Err(e) => return self.finish_app_call(call, Err(e), cx),
        };
        let visible: HashMap<i64, (String, String)> = facts
            .sessions
            .iter()
            .filter(|s| !s.hidden)
            .filter(|s| {
                project
                    .as_ref()
                    .is_none_or(|p| path_key(p) == path_key(&s.project))
            })
            .map(|s| (s.id, (s.project.clone(), s.title.clone())))
            .collect();
        let query = call.input["query"].as_str().unwrap_or_default().to_owned();
        let limit = call.input["limit"].as_u64().unwrap_or(20) as usize;
        let store = self.store.clone();
        let work = cx.background_executor().spawn(async move {
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            // A separate reader keeps the app's store free while it searches.
            let reader = locked(&store)?.search_reader()?;
            let (hits, truncated) = match &reader {
                Some(reader) => reader.search_sessions(&query, cancel)?,
                None => locked(&store)?.search_sessions(&query, cancel)?,
            };
            let mut found: Vec<Value> = Vec::new();
            for hit in hits {
                let session = match hit.target {
                    monocode_core::search::Target::Conversation(id) => id,
                    monocode_core::search::Target::Message { session, .. } => session,
                    _ => continue,
                };
                let Some((project, title)) = visible.get(&session) else {
                    continue;
                };
                found.push(json!({"sessionId": session, "project": project, "title": title, "match": monocode_core::response::limit(&hit.meta, 300), "updatedAt": hit.updated_at}));
                if found.len() >= limit {
                    break;
                }
            }
            Ok(json!({"results": found, "truncated": truncated || found.len() >= limit}))
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| this.finish_app_call(call, result, cx));
        })
        .detach();
    }
    fn master_read(&mut self, call: Call, cx: &mut Context<Self>) {
        let facts = self.master_facts(cx);
        let id = match self.master_session_id(&call.input, &facts) {
            Ok(id) => id,
            Err(e) => return self.finish_app_call(call, Err(e), cx),
        };
        let view = self.sessions.get(&id).cloned();
        let chat = view.as_ref().map(|v| v.read(cx));
        let observation = chat.map(|c| c.agent_observation(cx)).unwrap_or_default();
        let state = orch::classify(&observation);
        let mode = match call.input["view"].as_str().unwrap_or("auto") {
            "auto" if matches!(state, orch::State::Working | orch::State::Blocked) => "activity",
            "auto" => "last",
            other => other,
        };
        // Reading a settled step's final message is hearing about its turn.
        if mode == "last" && state.settled() {
            self.master
                .state
                .mailbox
                .retain(|u| u.session != id || u.kind == "blocked" || u.kind == "decided");
        }
        let draft = chat.is_some_and(|c| c.has_saved_draft());
        let live = chat.and_then(|c| c.agent_rows(cx).map(|rows| (c.agent_steers(cx), rows)));
        let mut head = json!({"sessionId": id, "state": state.id(), "view": mode});
        if let Some(fact) = facts.sessions.iter().find(|s| s.id == id) {
            head["title"] = json!(fact.title);
            head["project"] = json!(fact.project);
        }
        if !observation.requests.is_empty() {
            head["needsInput"] = json!(
                observation
                    .requests
                    .iter()
                    .map(|r| r.json())
                    .collect::<Vec<_>>()
            );
        }
        if let Some(error) = &observation.error {
            head["error"] = json!(monocode_core::response::limit(error, 2_000));
        }
        let work = self.read_session_work(
            id,
            live,
            call.input.clone(),
            head,
            (observation.busy, draft),
            cx,
        );
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| this.finish_app_call(call, result, cx));
        })
        .detach();
    }
    fn master_tasks(&self) -> Value {
        let tasks = &self.master.state.tasks;
        // Open tasks and the ten newest finished ones.
        let finished = tasks.iter().filter(|t| !t.state.open()).count();
        json!({
            "paused": self.master.config.paused,
            "tasks": tasks
                .iter()
                .filter({
                    let mut skip = finished.saturating_sub(10);
                    move |t| t.state.open() || if skip > 0 { skip -= 1; false } else { true }
                })
                .map(m::Task::json)
                .collect::<Vec<_>>(),
        })
    }

    // ---- Planning ----

    fn master_plan(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        if self
            .master
            .state
            .tasks
            .iter()
            .filter(|t| t.state == TaskState::Proposed)
            .count()
            >= 3
        {
            return Err("Three plans already wait for the user; wait for their decision".into());
        }
        let facts = self.master_facts(cx);
        let now = monocode_core::time::now_ms();
        let mut task = m::parse_plan(input, &self.master.config, &facts, String::new(), now)?;
        task.id = self.master.state.new_task_id();
        let value = task.json();
        let note = format!("{} steps, {} access", task.steps.len(), task.access.label());
        self.master_record("Proposed a plan", Some(&task.id), None, Some(note));
        self.master.state.tasks.push(task);
        self.save_master(cx);
        Ok(
            json!({"task": value, "note": "The user now sees this plan and starts, changes or declines it. Nothing runs until then: end your turn."}),
        )
    }
    fn master_change(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        let ix = self
            .master
            .state
            .task(input["task"].as_str().unwrap_or_default())?;
        let facts = self.master_facts(cx);
        let task = &self.master.state.tasks[ix];
        if task.state != TaskState::Running {
            return Err(format!("Task {} is {}", task.id, task.state.id()));
        }
        if task.change.is_some() {
            return Err("A change to this task already waits for the user".into());
        }
        let access = match input["access"].as_str() {
            None => None,
            Some(id) => {
                let access =
                    m::plan_access(id).ok_or("access is supervised, auto or full-access")?;
                if m::rank(access) <= m::rank(task.access) {
                    return Err(format!("The plan already allows {}", task.access.label()));
                }
                Some(access)
            }
        };
        let steps = if input.get("steps").is_some() {
            m::parse_steps(
                input,
                &self.master.config,
                &facts,
                access.unwrap_or(task.access),
                task.steps.len() + 1,
                &task.steps,
            )?
        } else {
            Vec::new()
        };
        let reason = app::text(input, "reason", 2_000)?;
        let id = task.id.clone();
        let change = m::Change {
            reason: reason.clone(),
            steps,
            access,
            at: monocode_core::time::now_ms(),
        };
        let value = json!({
            "task": id,
            "steps": change.steps.iter().map(m::Step::json).collect::<Vec<_>>(),
            "access": access.map(AccessMode::id),
            "note": "The user decides this change. The rest of the plan keeps running; you hear their decision in an update.",
        });
        self.master.state.tasks[ix].change = Some(change);
        self.master_record("Proposed a plan change", Some(&id), None, Some(reason));
        self.save_master(cx);
        Ok(value)
    }

    // ---- The user's decisions ----

    /// The user starts a proposed plan: steps without `after` start now.
    #[expect(dead_code, reason = "called by the Master page, step 2")]
    pub(crate) fn master_start_plan(
        &mut self,
        task: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let ix = self.master.state.task(task)?;
        let task = &mut self.master.state.tasks[ix];
        if task.state != TaskState::Proposed {
            return Err(format!("Task {} is {}", task.id, task.state.id()));
        }
        task.state = TaskState::Running;
        task.started_at = Some(monocode_core::time::now_ms());
        for step in task.steps.iter_mut().filter(|s| s.after.is_empty()) {
            step.status = StepStatus::Queued;
        }
        let (id, note) = (task.id.clone(), format!("{} steps", task.steps.len()));
        self.master_record("You started the plan", Some(&id), None, Some(note));
        self.master_start_queued(cx);
        self.save_master(cx);
        Ok(())
    }
    #[expect(dead_code, reason = "called by the Master page, step 2")]
    pub(crate) fn master_decline_plan(
        &mut self,
        task: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let ix = self.master.state.task(task)?;
        let task = &mut self.master.state.tasks[ix];
        if task.state != TaskState::Proposed {
            return Err(format!("Task {} is {}", task.id, task.state.id()));
        }
        task.state = TaskState::Cancelled;
        task.finished_at = Some(monocode_core::time::now_ms());
        let id = task.id.clone();
        self.master_record("You declined the plan", Some(&id), None, None);
        self.save_master(cx);
        Ok(())
    }
    /// The user adds a proposed change to its plan, or declines it.
    #[expect(dead_code, reason = "called by the Master page, step 2")]
    pub(crate) fn master_decide_change(
        &mut self,
        task: &str,
        accept: bool,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let ix = self.master.state.task(task)?;
        let task = &mut self.master.state.tasks[ix];
        let change = task
            .change
            .take()
            .ok_or("This task has no pending change")?;
        let text = if accept {
            if let Some(access) = change.access {
                task.access = access;
            }
            for mut step in change.steps {
                if step.after.is_empty() {
                    step.status = StepStatus::Queued;
                }
                task.steps.push(step);
            }
            "The user added your change to the plan; its steps without after are starting."
        } else {
            "The user declined your change. Work around it within the plan, or report it in master.finish."
        };
        let update = Update::decided(task, text.into(), monocode_core::time::now_ms());
        let id = task.id.clone();
        self.master.state.push_update(update);
        self.master_record(
            if accept {
                "You added the change"
            } else {
                "You declined the change"
            },
            Some(&id),
            None,
            None,
        );
        self.master_start_queued(cx);
        self.save_master(cx);
        self.deliver_master_updates(cx);
        Ok(())
    }
    /// Pause Master: no new messages for any task; running turns finish and
    /// updates wait. Resuming delivers them and starts queued steps.
    #[expect(dead_code, reason = "called by the Master page, step 2")]
    pub(crate) fn master_set_paused(&mut self, paused: bool, cx: &mut Context<Self>) {
        self.master.config.paused = paused;
        self.save_master_config(cx);
        self.master_record(
            if paused {
                "You paused Master"
            } else {
                "You resumed Master"
            },
            None,
            None,
            None,
        );
        self.save_master(cx);
        if !paused {
            self.master.state.updates = 0;
            self.master_start_queued(cx);
            self.deliver_master_updates(cx);
        }
    }
    /// The user gives a step they took over back to Master.
    #[expect(dead_code, reason = "called by the Master page, step 2")]
    pub(crate) fn master_hand_back(
        &mut self,
        task: &str,
        step: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let (t, s) = self.master_step(&json!({"task": task, "step": step}))?;
        let step = &mut self.master.state.tasks[t].steps[s];
        if step.status != StepStatus::Yours {
            return Err("Master already drives this step".into());
        }
        step.status = StepStatus::Idle;
        step.note = None;
        let session = step.session;
        let task = &self.master.state.tasks[t];
        let update = Update {
            task: task.id.clone(),
            step: task.steps[s].id.clone(),
            session: session.unwrap_or_default(),
            project: task.steps[s].project.clone(),
            kind: "finished".into(),
            report: "The user handed this step back after working in it. Read it before going on."
                .into(),
            at: monocode_core::time::now_ms(),
            ..Update::default()
        };
        self.master.state.push_update(update);
        self.save_master(cx);
        self.deliver_master_updates(cx);
        Ok(())
    }

    // ---- Driving ----

    fn master_start(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        let (t, s) = self.master_step(input)?;
        if let Some(reason) = self.master.state.tasks[t].blocked_start(s) {
            return Err(reason);
        }
        self.master.state.tasks[t].steps[s].status = StepStatus::Queued;
        self.master_start_queued(cx);
        self.save_master(cx);
        Ok(self.master.state.tasks[t].steps[s].json())
    }
    /// Start every queued step that may run now: within the session limit,
    /// with its checkout free, and while Master is not paused.
    pub(super) fn master_start_queued(&mut self, cx: &mut Context<Self>) {
        if self.master.config.paused || !self.master.config.enabled {
            return;
        }
        let facts = self.master_facts(cx);
        let mut live = self.master.state.live_steps();
        let mut starts = Vec::new();
        let mut notes = Vec::new();
        for (t, task) in self.master.state.tasks.iter().enumerate() {
            for (s, step) in task.steps.iter().enumerate() {
                if step.status != StepStatus::Queued
                    || self
                        .master
                        .starting
                        .contains(&(task.id.clone(), step.id.clone()))
                    || task.blocked_start(s).is_some()
                {
                    continue;
                }
                if live >= self.master.config.max_sessions {
                    notes.push((
                        t,
                        s,
                        format!("Waits for a free session: {live} are working for Master"),
                    ));
                    continue;
                }
                if step.target == Target::Message {
                    let Some(source) = step.source.and_then(|id| facts.session(id).ok()) else {
                        notes.push((t, s, "Its session is gone or hidden from Master".into()));
                        continue;
                    };
                    // The session's own queue holds Master's message behind
                    // the user's turn; another session in its checkout waits.
                    if let Some(writer) = facts.writer(source.checkout(), Some(source.id)) {
                        notes.push((
                            t,
                            s,
                            format!("Waits: {} is working in its checkout", writer.title),
                        ));
                        continue;
                    }
                }
                live += 1;
                starts.push((t, s));
            }
        }
        for (t, s, note) in notes {
            self.master.state.tasks[t].steps[s].note = Some(note);
        }
        for (t, s) in starts {
            self.master.state.tasks[t].steps[s].note = None;
            self.master_start_step(t, s, cx);
        }
    }
    fn master_start_step(&mut self, t: usize, s: usize, cx: &mut Context<Self>) {
        let task = self.master.state.tasks[t].clone();
        let step = task.steps[s].clone();
        let sender = m::sender(&task.id, &step.id);
        if step.target == Target::Message {
            let session = step.source.unwrap_or_default();
            let result = self
                .ensure_session(session, cx)
                .ok_or_else(|| "Session not found".to_owned())
                .and_then(|view| {
                    view.update(cx, |v, cx| {
                        v.driven_message(
                            step.prompt.clone(),
                            false,
                            Some(sender),
                            Some(step.access),
                            cx,
                        )
                    })
                });
            let worktree = self.session_worktrees.get(&session).cloned().flatten();
            let step = &mut self.master.state.tasks[t].steps[s];
            match result {
                Ok(_) => {
                    step.session = Some(session);
                    step.checkout = worktree;
                    step.status = StepStatus::Starting;
                    self.master.watches.insert(
                        session,
                        Watch::new(orch::State::Starting, monocode_core::time::now_ms()),
                    );
                    self.master_record(
                        "Messaged a session",
                        Some(&task.id),
                        Some(session),
                        Some(format!("step {}", s + 1)),
                    );
                }
                Err(error) => {
                    step.status = StepStatus::Failed;
                    step.note = Some(error);
                }
            }
            self.save_master(cx);
            return;
        }
        self.master_create_session(task, step, cx);
    }
    /// A new worktree session for a step, or one that continues the step's
    /// source session with its recap.
    fn master_create_session(&mut self, task: m::Task, step: m::Step, cx: &mut Context<Self>) {
        let Some(master) = self.master.config.session else {
            return;
        };
        let Some(kind) = Kind::parse(&step.harness) else {
            return self.master_step_failed(&task.id, &step.id, "Unknown harness".into(), cx);
        };
        self.master
            .starting
            .insert((task.id.clone(), step.id.clone()));
        let account = crate::accounts::get(cx)
            .map(|center| center.read(cx).selected(kind, &step.project))
            .unwrap_or_default();
        // A continuation carries its source's recap, read from the open chat
        // when it is loaded.
        let source = (step.target == Target::Continue)
            .then_some(step.source)
            .flatten()
            .map(|id| {
                let metadata = self.session_metadata(id, cx);
                let live = self
                    .sessions
                    .get(&id)
                    .map(|view| view.read(cx).transcript.read(cx).history_rows().to_vec());
                (
                    id,
                    metadata.summary.provider.clone(),
                    metadata.display_title(),
                    live,
                )
            });
        let request = format!("master-{}-{}", task.id, step.id);
        let fingerprint = app::fingerprint("master.start", &json!([task.id, step.id]));
        let store = self.store.clone();
        let (task_id, step_id) = (task.id.clone(), step.id.clone());
        let work = cx.background_executor().spawn(async move {
            let mut launch = json!({"prompt": step.prompt, "harness": kind.id(), "runtimeMode": step.access.id()});
            if let Some(model) = &step.model {
                launch["model"] = json!(model);
            }
            if let Some(effort) = &step.effort {
                launch["effort"] = json!(effort);
            }
            let models = monocode_core::catalog::models_for(kind, &account)
                .or_else(|_| monocode_core::catalog::cached_models_for(kind, &account).ok_or(()))
                .unwrap_or_default();
            let settings = monocode_core::agent::Settings {
                account,
                ..Default::default()
            };
            let mut settings = app::launch_settings_for(&launch, kind.id(), settings, kind, &models, true)?;
            settings.revision = 0;
            let mut store = locked(&store)?;
            let (mut summary, fresh) =
                store.create_app_session(master, &request, &fingerprint, kind.id(), &step.project)?;
            let mut branch = None;
            if fresh {
                let tree = monocode_core::git::create_project_worktree(
                    std::path::Path::new(&step.project),
                    &format!("mc/master-{}-{}-{}", task.id, step.id, summary.id),
                    Some("HEAD"),
                    false,
                );
                let tree = match tree {
                    Ok(tree) => tree,
                    Err(error) => {
                        let _ = store.delete(summary.id);
                        return Err(format!("Could not create the step's worktree: {error}"));
                    }
                };
                settings.worktree_cwd = Some(tree.path);
                branch = tree.branch;
                if let Some((id, provider, title, live)) = source {
                    let rows = match live {
                        Some(rows) => rows,
                        None => store.load(id)?.rows,
                    };
                    let earlier = store.continued_from(id).ok().flatten().map(|e| e.brief);
                    settings.handoff = Some(monocode_core::agent::Handoff {
                        from: provider,
                        brief: monocode_core::response::continuation(&rows, earlier.as_deref()),
                        continued: Some(monocode_core::agent::ContinuedChat {
                            session: id,
                            title,
                            fork: None,
                        }),
                    });
                }
                store.title(summary.id, &step.title)?;
                summary.title = step.title.clone();
                store.configure_agent(summary.id, kind.id(), &settings)?;
            }
            Ok((summary, settings, fresh, branch))
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                this.master
                    .starting
                    .remove(&(task_id.clone(), step_id.clone()));
                let (summary, settings, fresh, branch) = match result {
                    Ok(created) => created,
                    Err(error) => return this.master_step_failed(&task_id, &step_id, error, cx),
                };
                let id = summary.id;
                let checkout = settings.worktree_cwd.clone();
                if fresh {
                    this.sidebar_hidden_sessions.remove(&id);
                    this.session_worktrees.insert(id, checkout.clone());
                    this.add(summary, cx);
                }
                let Ok((t, s)) = this.master_step(&json!({"task": task_id, "step": step_id}))
                else {
                    return;
                };
                let prompt = m::step_prompt(
                    &this.master.state.tasks[t],
                    &this.master.state.tasks[t].steps[s],
                    checkout.as_deref().unwrap_or_default(),
                    branch.as_deref(),
                );
                let sender = m::sender(&task_id, &step_id);
                let sent = this.sessions.get(&id).cloned().map(|view| {
                    view.update(cx, |v, cx| {
                        if fresh {
                            v.install_transfer(settings, None, cx);
                        }
                        v.driven_message(prompt, false, Some(sender), None, cx)
                    })
                });
                let step = &mut this.master.state.tasks[t].steps[s];
                step.session = Some(id);
                step.checkout = checkout;
                step.branch = branch;
                match sent {
                    Some(Ok(_)) => {
                        step.status = StepStatus::Starting;
                        this.master.watches.insert(
                            id,
                            Watch::new(orch::State::Starting, monocode_core::time::now_ms()),
                        );
                        let action =
                            if this.master.state.tasks[t].steps[s].target == Target::Continue {
                                "Continued a session in a new worktree"
                            } else {
                                "Started a session"
                            };
                        this.master_record(
                            action,
                            Some(&task_id),
                            Some(id),
                            Some(format!("step {step_id}")),
                        );
                    }
                    Some(Err(error)) => {
                        step.status = StepStatus::Failed;
                        step.note = Some(error);
                    }
                    None => {
                        step.status = StepStatus::Failed;
                        step.note = Some("The step's session did not open".into());
                    }
                }
                this.persist(cx);
                this.save_master(cx);
            });
        })
        .detach();
    }
    fn master_step_failed(
        &mut self,
        task: &str,
        step: &str,
        error: String,
        cx: &mut Context<Self>,
    ) {
        let Ok((t, s)) = self.master_step(&json!({"task": task, "step": step})) else {
            return;
        };
        let step = &mut self.master.state.tasks[t].steps[s];
        step.status = StepStatus::Failed;
        step.note = Some(error.clone());
        let task = &self.master.state.tasks[t];
        let update = Update {
            task: task.id.clone(),
            step: task.steps[s].id.clone(),
            project: task.steps[s].project.clone(),
            kind: "failed".into(),
            error: Some(error),
            at: monocode_core::time::now_ms(),
            ..Update::default()
        };
        self.master.state.push_update(update);
        self.save_master(cx);
        self.deliver_master_updates(cx);
    }
    fn master_message(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        if self.master.config.paused {
            return Err("Master is paused; nothing new is sent until the user resumes it".into());
        }
        let (t, s) = self.master_step(input)?;
        let task = &self.master.state.tasks[t];
        let step = &task.steps[s];
        if task.state != TaskState::Running {
            return Err(format!("Task {} is {}", task.id, task.state.id()));
        }
        let session = step
            .session
            .ok_or_else(|| format!("Step {} has not started; use master.start", step.id))?;
        if step.status == StepStatus::Yours {
            return Err(format!(
                "The user took over step {}; wait until they hand it back",
                step.id
            ));
        }
        let facts = self.master_facts(cx);
        let checkout = facts
            .sessions
            .iter()
            .find(|f| f.id == session)
            .map(|f| f.checkout().to_owned())
            .ok_or("The step's session is gone")?;
        if let Some(writer) = facts.writer(&checkout, Some(session)) {
            return Err(format!(
                "{} is working in this step's checkout; one session writes in a checkout at a time. Try again after it finishes",
                writer.title
            ));
        }
        let sender = m::sender(&task.id, &step.id);
        let (access, task_id, step_id) = (step.access, task.id.clone(), step.id.clone());
        let view = self
            .ensure_session(session, cx)
            .ok_or("Session not found")?;
        // Master steers only a turn it started; the user's turn goes first.
        let own = view.read(cx).turn_sender.as_deref() == Some(sender.as_str());
        let steer = own && input["mode"].as_str() != Some("queue");
        let prompt = app::prompt(input)?;
        let delivery = view.update(cx, |v, cx| {
            v.driven_message(prompt, steer, Some(sender), Some(access), cx)
        })?;
        if delivery == crate::conversation::agents::Delivery::Turn {
            self.master.state.tasks[t].steps[s].status = StepStatus::Starting;
            self.master.watches.insert(
                session,
                Watch::new(orch::State::Starting, monocode_core::time::now_ms()),
            );
        }
        self.master_record(
            "Messaged a session",
            Some(&task_id),
            Some(session),
            Some(format!("step {step_id}, {}", delivery.id())),
        );
        self.save_master(cx);
        Ok(
            json!({"task": task_id, "step": step_id, "sessionId": session, "delivered": delivery.id()}),
        )
    }
    fn master_driven(
        &mut self,
        input: &Value,
        cx: &mut Context<Self>,
    ) -> Result<(usize, usize, i64, Entity<Conversation>), String> {
        let (t, s) = self.master_step(input)?;
        let step = &self.master.state.tasks[t].steps[s];
        let session = step
            .session
            .ok_or_else(|| format!("Step {} has not started", step.id))?;
        let view = self
            .ensure_session(session, cx)
            .ok_or("Session not found")?;
        Ok((t, s, session, view))
    }
    fn master_approve(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        let (t, s, session, view) = self.master_driven(input, cx)?;
        let allow = input["decision"] == "allow";
        let given = input["requestId"].as_str();
        let observation = view.read(cx).agent_observation(cx);
        let request = observation
            .requests
            .iter()
            .filter(|r| r.kind == "approval")
            .find(|r| given.is_none_or(|g| orch::names_request(&r.id, g)))
            .ok_or("No approval is pending in this step's session")?;
        let project = &self.master.state.tasks[t].steps[s].project;
        if allow && !m::safe(&self.master.config, project, &request.detail) {
            return Err("This request is not on the user's safe list, so it is theirs to decide. Tell them what it is and what you suggest.".into());
        }
        let detail = monocode_core::response::limit(&request.detail, 200);
        let decision = if allow {
            Decision::Allow
        } else {
            Decision::Deny
        };
        let id = view.update(cx, |v, cx| v.agent_approve(given, decision, cx))?;
        let task = self.master.state.tasks[t].id.clone();
        self.master_record(
            if allow {
                format!("Allowed {detail}")
            } else {
                format!("Denied {detail}")
            },
            Some(&task),
            Some(session),
            allow.then(|| "safe list".to_owned()),
        );
        self.save_master(cx);
        Ok(json!({"sessionId": session, "requestId": id, "decided": input["decision"]}))
    }
    fn master_answer(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        let (t, _, session, view) = self.master_driven(input, cx)?;
        let answers = if input["skip"] == true {
            None
        } else {
            Some(
                serde_json::from_value::<Vec<Vec<String>>>(input["answers"].clone())
                    .map_err(|e| e.to_string())?,
            )
        };
        let skipped = answers.is_none();
        let id = view.update(cx, |v, cx| {
            v.agent_answer(input["requestId"].as_str(), answers, cx)
        })?;
        let task = self.master.state.tasks[t].id.clone();
        self.master_record(
            if skipped {
                "Skipped a question"
            } else {
                "Answered a question"
            },
            Some(&task),
            Some(session),
            None,
        );
        self.save_master(cx);
        Ok(json!({"sessionId": session, "requestId": id, "answered": !skipped}))
    }
    fn master_stop(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        let t = self
            .master
            .state
            .task(input["task"].as_str().unwrap_or_default())?;
        let only = m::step_id(input);
        let task = self.master.state.tasks[t].clone();
        let mut stopped = Vec::new();
        for step in task
            .steps
            .iter()
            .filter(|s| only.as_ref().is_none_or(|id| &s.id == id))
        {
            if let Some(session) = step.session.filter(|_| step.status.live()) {
                let Some(view) = self.ensure_session(session, cx) else {
                    continue;
                };
                // The user's own turn is theirs to stop.
                if view.read(cx).turn_sender.as_deref()
                    != Some(m::sender(&task.id, &step.id).as_str())
                {
                    continue;
                }
                if let Some(watch) = self.master.watches.get_mut(&session) {
                    watch.quiet_stop = true;
                }
                view.update(cx, |v, cx| v.stop_app_session(cx));
                stopped.push(step.id.clone());
            } else if step.status == StepStatus::Queued
                && let Ok(s) = self.master.state.tasks[t].step(&step.id)
            {
                self.master.state.tasks[t].steps[s].status = StepStatus::Planned;
            }
        }
        self.master_record(
            "Stopped steps",
            Some(&task.id),
            None,
            Some(stopped.join(", ")),
        );
        self.save_master(cx);
        Ok(json!({"task": task.id, "stopped": stopped}))
    }
    fn master_done(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        let (t, s) = self.master_step(input)?;
        let step = &mut self.master.state.tasks[t].steps[s];
        if step.status.live() || matches!(step.status, StepStatus::Planned | StepStatus::Queued) {
            return Err(format!(
                "Step {} is {}; it can be done once its session finished",
                step.id,
                step.status.id()
            ));
        }
        if step.status == StepStatus::Yours {
            return Err(format!(
                "The user took over step {}; they mark it done",
                step.id
            ));
        }
        step.status = StepStatus::Done;
        step.note = input["note"].as_str().map(str::to_owned);
        let (id, session) = (step.id.clone(), step.session);
        let task = self.master.state.tasks[t].id.clone();
        self.master_record(
            "Marked a step done",
            Some(&task),
            session,
            Some(format!("step {id}")),
        );
        self.master_start_queued(cx);
        self.save_master(cx);
        Ok(self.master.state.tasks[t].steps[s].json())
    }
    fn master_finish(&mut self, input: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        let t = self
            .master
            .state
            .task(input["task"].as_str().unwrap_or_default())?;
        let task = &mut self.master.state.tasks[t];
        if task.state != TaskState::Running {
            return Err(format!("Task {} is {}", task.id, task.state.id()));
        }
        if let Some(step) = task.steps.iter().find(|s| s.status.live()) {
            return Err(format!(
                "Step {} is still {}; stop it or wait for it",
                step.id,
                step.status.id()
            ));
        }
        task.state = TaskState::Done;
        task.report = Some(app::text(input, "report", 240_000)?);
        task.finished_at = Some(monocode_core::time::now_ms());
        for step in task
            .steps
            .iter_mut()
            .filter(|s| s.status == StepStatus::Queued)
        {
            step.status = StepStatus::Planned;
        }
        let id = task.id.clone();
        self.master.state.mailbox.retain(|u| u.task != id);
        self.master_record("Finished the task", Some(&id), None, None);
        self.save_master(cx);
        Ok(json!({"task": id, "state": "done"}))
    }

    // ---- Watching ----

    /// Every session change: advance a driven step and tell Master, start
    /// steps a freed checkout was holding, or deliver waiting updates.
    pub(super) fn master_session_changed(&mut self, id: i64, cx: &mut Context<Self>) {
        if !self.master.config.enabled {
            return;
        }
        if let Some((t, s)) = self.master.state.step_of(id) {
            self.observe_step(t, s, id, cx);
        }
        if self
            .master
            .state
            .tasks
            .iter()
            .any(|t| t.steps.iter().any(|s| s.status == StepStatus::Queued))
            && !self.session_metadata(id, cx).busy
        {
            self.master_start_queued(cx);
        }
        if self.is_master_session(id) || !self.master.state.mailbox.is_empty() {
            self.deliver_master_updates(cx);
        }
    }
    fn observe_step(&mut self, t: usize, s: usize, session: i64, cx: &mut Context<Self>) {
        let Some(view) = self.sessions.get(&session).cloned() else {
            return;
        };
        let task = &self.master.state.tasks[t];
        let step = &task.steps[s];
        if matches!(
            step.status,
            StepStatus::Done | StepStatus::Yours | StepStatus::Planned | StepStatus::Queued
        ) {
            return;
        }
        let chat = view.read(cx);
        let observation = chat.agent_observation(cx);
        let sender = m::sender(&task.id, &step.id);
        let own = chat.turn_sender.as_deref() == Some(sender.as_str());
        if observation.busy && !own {
            // Master's message waits behind the user's turn.
            if step.status == StepStatus::Starting {
                return;
            }
            // The user wrote to the step's session: it is theirs now.
            let task_id = task.id.clone();
            let step = &mut self.master.state.tasks[t].steps[s];
            step.status = StepStatus::Yours;
            step.note = Some("You took over. Master is waiting.".into());
            self.master.watches.remove(&session);
            self.master_record("You took over a step", Some(&task_id), Some(session), None);
            self.save_master(cx);
            return;
        }
        let rows = chat.agent_rows(cx).unwrap_or_default();
        let steers = chat.agent_steers(cx);
        let now = monocode_core::time::now_ms();
        let watch = self
            .master
            .watches
            .entry(session)
            .or_insert_with(|| Watch::new(orch::classify(&observation), now));
        let kinds = orch::observe(watch, &observation, now);
        let status = StepStatus::from_state(watch.state);
        let changed = self.master.state.tasks[t].steps[s].status != status;
        self.master.state.tasks[t].steps[s].status = status;
        if kinds.is_empty() {
            if changed {
                self.save_master(cx);
            }
            return;
        }
        let report = orch::final_message(&rows, &steers);
        let elapsed = orch::turn_started_at(&rows, &steers).map(|at| now.saturating_sub(at));
        for kind in kinds {
            let settled = !matches!(kind, EventKind::Blocked(_));
            let safe = match &kind {
                EventKind::Blocked(request) => {
                    request.kind == "approval"
                        && m::safe(
                            &self.master.config,
                            &self.master.state.tasks[t].steps[s].project,
                            &request.detail,
                        )
                }
                _ => false,
            };
            let event = Event {
                session,
                name: String::new(),
                report: if settled {
                    report.clone()
                } else {
                    String::new()
                },
                elapsed: settled.then_some(elapsed).flatten(),
                kind,
                at: now,
            };
            let task = &self.master.state.tasks[t];
            let update = Update::new(task, &task.steps[s], &event, safe);
            self.master.state.push_update(update);
        }
        self.save_master(cx);
        self.answer_master_waits(cx);
        self.deliver_master_updates(cx);
    }
    /// Drop "needs input" updates whose request was decided meanwhile.
    fn drop_answered_master(&mut self, cx: &App) {
        let keep: Vec<bool> = self
            .master
            .state
            .mailbox
            .iter()
            .map(|update| match &update.ask {
                Some(ask) => self.sessions.get(&update.session).is_none_or(|view| {
                    view.read(cx)
                        .agent_observation(cx)
                        .requests
                        .iter()
                        .any(|r| r.id == ask.id)
                }),
                None => true,
            })
            .collect();
        let mut keep = keep.into_iter();
        self.master
            .state
            .mailbox
            .retain(|_| keep.next().unwrap_or(true));
    }
    /// Send Master its waiting updates as one internal turn once it is idle.
    pub(super) fn deliver_master_updates(&mut self, cx: &mut Context<Self>) {
        self.drop_answered_master(cx);
        if self.master.state.mailbox.is_empty()
            || self.master.config.paused
            || !self.master.config.enabled
        {
            return;
        }
        let session = self.master.config.session;
        let Some(view) = session.and_then(|id| self.ensure_session(id, cx)) else {
            return;
        };
        let chat = view.read(cx);
        // The user writing to Master resets its automatic update budget.
        if chat
            .agent_rows(cx)
            .and_then(|rows| {
                rows.iter()
                    .rev()
                    .find(|r| r.first && r.is_prompt())
                    .map(|r| r.role == "user")
            })
            .unwrap_or(false)
        {
            self.master.state.updates = 0;
        }
        let ready = chat.available_for_managed_run(cx)
            && chat.settings.usage_limit.is_none()
            && self.master.waits.is_empty();
        let max = self.master.config.max_updates;
        if !ready || self.master.state.updates >= max {
            if !self.master.retrying && self.master.state.updates < max {
                self.master.retrying = true;
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(3)).await;
                    let _ = this.update(cx, |this, cx| {
                        this.master.retrying = false;
                        this.deliver_master_updates(cx);
                    });
                })
                .detach();
            }
            return;
        }
        let updates = std::mem::take(&mut self.master.state.mailbox);
        self.master.state.updates += 1;
        let last = self.master.state.updates >= max;
        let text = m::wake_message(&updates, &self.master.state.tasks, last);
        view.update(cx, |v, cx| v.send_coordinator_report(text, cx));
        self.save_master(cx);
    }
    fn master_wait(&mut self, call: Call, cx: &mut Context<Self>) {
        let timeout = call.input["timeoutSeconds"].as_u64().unwrap_or(30);
        let id = self.master.next_wait;
        self.master.next_wait += 1;
        self.master.waits.push((id, call));
        self.answer_master_waits(cx);
        if !self.master.waits.iter().any(|(wait, _)| *wait == id) {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(timeout))
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Some(ix) = this.master.waits.iter().position(|(wait, _)| *wait == id) {
                    let (_, call) = this.master.waits.remove(ix);
                    this.finish_app_call(call, Ok(json!({"matched": false, "updates": []})), cx);
                    this.deliver_master_updates(cx);
                }
            });
        })
        .detach();
    }
    fn answer_master_waits(&mut self, cx: &mut Context<Self>) {
        self.drop_answered_master(cx);
        if self.master.waits.is_empty() || self.master.state.mailbox.is_empty() {
            return;
        }
        let updates = std::mem::take(&mut self.master.state.mailbox);
        let value = json!({"matched": true, "updates": updates.iter().map(|u| u.json(8_000)).collect::<Vec<_>>()});
        for (_, call) in std::mem::take(&mut self.master.waits) {
            self.finish_app_call(call, Ok(value.clone()), cx);
        }
        self.save_master(cx);
    }
    /// A deleted session leaves Master's tasks: its step reads failed.
    pub(super) fn master_session_forgotten(&mut self, id: i64, cx: &mut Context<Self>) {
        self.master.watches.remove(&id);
        let Some((t, s)) = self.master.state.step_of(id) else {
            return;
        };
        let step = &mut self.master.state.tasks[t].steps[s];
        if step.status != StepStatus::Done {
            step.status = StepStatus::Failed;
            step.note = Some("Its session was deleted".into());
        }
        self.master.state.mailbox.retain(|u| u.session != id);
        self.save_master(cx);
    }
}
