//! Herdr-style orchestration. An Orchestrator thread (the lead) runs other
//! agents as ordinary sessions through the `agents.*` app actions. MonoCode
//! watches those sessions, keeps the lead's agent rail current, answers
//! `agents.wait`, and wakes the lead with an update turn once it is idle.
//! Nothing here plans or schedules work; the lead decides everything.
use super::*;
use crate::conversation::agents::Delivery;
use monocode_core::{
    agent::Decision,
    app_access as app,
    mono::bridge::Call,
    orchestration::{self as orch, Event, EventKind, State, Summary, SummaryTask, Watch},
};
use serde_json::{Value, json};
use std::time::Duration;

/// Automatic wake-ups between two messages from the user. Past this the lead
/// hears about its agents again after the user writes to it.
const MAX_WAKEUPS: u32 = 60;
/// Agents one lead may have open at once.
const MAX_AGENTS: usize = 12;

#[derive(Default)]
pub(super) struct Orchestrations {
    leads: HashMap<i64, Lead>,
    /// Each agent's state between observations, by session.
    watches: HashMap<i64, Watch>,
    /// Names whose agents.start is still creating its session and checkout.
    starting: HashSet<(i64, String)>,
    next_wait: u64,
}
#[derive(Default)]
struct Lead {
    /// Events the lead has not seen yet, oldest first.
    mailbox: Vec<Event>,
    /// Automatic wake-ups since the user last wrote to the lead.
    wakeups: u32,
    retrying: bool,
    waits: Vec<Wait>,
}
struct Wait {
    id: u64,
    call: Call,
    names: Vec<String>,
    until: Vec<State>,
}

impl Shell {
    /// The lead and roster index of an agent's session.
    fn agent_of(&self, session: i64) -> Option<(i64, usize)> {
        self.orchestration_summaries
            .iter()
            .find_map(|(lead, summary)| {
                summary
                    .tasks
                    .iter()
                    .position(|t| t.session == Some(session) && t.open())
                    .map(|ix| (*lead, ix))
            })
    }
    fn agent_named(&self, lead: i64, name: &str) -> Result<(usize, i64), String> {
        self.orchestration_summaries
            .get(&lead)
            .and_then(|summary| {
                summary
                    .tasks
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, t)| t.open() && t.name == name)
                    .and_then(|(ix, t)| Some((ix, t.session?)))
            })
            .ok_or_else(|| format!("No open agent is named {name}; run agents.list"))
    }
    fn agent_state(&self, session: i64, cx: &App) -> (State, u64) {
        if let Some(watch) = self.orchestrations.watches.get(&session) {
            return (watch.state, watch.since);
        }
        let state = self
            .sessions
            .get(&session)
            .map(|v| orch::classify(&v.read(cx).agent_observation(cx)))
            .unwrap_or(State::Idle);
        (state, 0)
    }
    fn roster(&self, lead: i64, cx: &App) -> Vec<(String, State)> {
        self.orchestration_summaries
            .get(&lead)
            .map(|summary| {
                summary
                    .tasks
                    .iter()
                    .filter(|t| t.open() && !t.name.is_empty())
                    .filter_map(|t| Some((t.name.clone(), self.agent_state(t.session?, cx).0)))
                    .collect()
            })
            .unwrap_or_default()
    }
    fn agent_states_json(&self, lead: i64, names: &[String], cx: &App) -> Value {
        json!(
            self.roster(lead, cx)
                .into_iter()
                .filter(|(name, _)| names.is_empty() || names.contains(name))
                .map(|(name, state)| json!({"name":name,"state":state.id()}))
                .collect::<Vec<_>>()
        )
    }

    /// Store the lead's roster and repaint its rail when it changed.
    fn save_summary(&mut self, lead: i64, mut summary: Summary, cx: &mut Context<Self>) {
        summary.live = summary
            .tasks
            .iter()
            .any(|t| t.open() && matches!(t.status.as_str(), "running" | "queued"));
        if self.orchestration_summaries.get(&lead) == Some(&summary) {
            return;
        }
        let store = self.store.clone();
        let saved = summary.clone();
        cx.background_executor()
            .spawn(async move {
                let _ = locked(&store).and_then(|s| s.save_orchestration_summary(lead, &saved));
            })
            .detach();
        self.orchestration_summaries.insert(lead, summary);
        self.invalidate_chrome(cx);
    }

    /// A deleted agent leaves its lead's roster; a deleted lead's run ends.
    /// Its agents stay as ordinary sessions.
    pub(super) fn orchestration_session_forgotten(&mut self, id: i64, cx: &mut Context<Self>) {
        if let Some((lead, ix)) = self.agent_of(id)
            && let Some(mut summary) = self.orchestration_summaries.get(&lead).cloned()
        {
            summary.tasks[ix].close();
            self.save_summary(lead, summary, cx);
            if let Some(entry) = self.orchestrations.leads.get_mut(&lead) {
                entry.mailbox.retain(|event| event.session != id);
            }
        }
        self.orchestrations.watches.remove(&id);
        if self.orchestration_summaries.remove(&id).is_some() {
            self.invalidate_chrome(cx);
        }
        // Pending waits answer with an error once their reply is dropped.
        self.orchestrations.leads.remove(&id);
    }

    /// Every session change: advance a watched agent and tell its lead, or
    /// deliver a lead's waiting updates once it is free.
    pub(super) fn orchestration_session_changed(&mut self, id: i64, cx: &mut Context<Self>) {
        if let Some((lead, ix)) = self.agent_of(id) {
            self.observe_agent(lead, ix, id, cx);
        }
        if self
            .orchestrations
            .leads
            .get(&id)
            .is_some_and(|lead| !lead.mailbox.is_empty())
        {
            self.deliver_agent_events(id, cx);
        }
    }
    fn observe_agent(&mut self, lead: i64, ix: usize, session: i64, cx: &mut Context<Self>) {
        let Some(view) = self.sessions.get(&session).cloned() else {
            return;
        };
        let observation = view.read(cx).agent_observation(cx);
        let now = monocode_core::time::now_ms();
        let watch = self
            .orchestrations
            .watches
            .entry(session)
            .or_insert_with(|| Watch::new(orch::classify(&observation), now));
        let kinds = orch::observe(watch, &observation, now);
        let state = watch.state;
        let Some(mut summary) = self.orchestration_summaries.get(&lead).cloned() else {
            return;
        };
        let name = summary.tasks[ix].name.clone();
        summary.tasks[ix].status = state.summary_status().into();
        self.save_summary(lead, summary, cx);
        if kinds.is_empty() {
            return;
        }
        let chat = view.read(cx);
        let rows = chat.agent_rows(cx).unwrap_or_default();
        let steers = chat.agent_steers(cx);
        let report = orch::final_message(&rows, &steers);
        let elapsed = orch::turn_started_at(&rows, &steers).map(|at| now.saturating_sub(at));
        let events = kinds.into_iter().map(|kind| {
            let settled = !matches!(kind, EventKind::Blocked(_));
            Event {
                session,
                name: name.clone(),
                report: if settled {
                    report.clone()
                } else {
                    String::new()
                },
                elapsed: settled.then_some(elapsed).flatten(),
                kind,
                at: now,
            }
        });
        let entry = self.orchestrations.leads.entry(lead).or_default();
        entry.mailbox.extend(events);
        // Keep the mailbox bounded if the lead stays away for long.
        if entry.mailbox.len() > 64 {
            let excess = entry.mailbox.len() - 64;
            entry.mailbox.drain(..excess);
        }
        self.answer_waits(lead, cx);
        self.deliver_agent_events(lead, cx);
    }

    /// Drop "needs input" events whose request was decided meanwhile, by the
    /// lead or by the user in the agent's chat or an approval toast.
    fn drop_answered(&mut self, lead: i64, cx: &App) {
        let Some(entry) = self.orchestrations.leads.get(&lead) else {
            return;
        };
        let pending: Vec<bool> = entry
            .mailbox
            .iter()
            .map(|event| match &event.kind {
                EventKind::Blocked(request) => {
                    self.sessions.get(&event.session).is_none_or(|view| {
                        view.read(cx)
                            .agent_observation(cx)
                            .requests
                            .iter()
                            .any(|r| r.id == request.id)
                    })
                }
                _ => true,
            })
            .collect();
        if pending.iter().all(|keep| *keep) {
            return;
        }
        if let Some(entry) = self.orchestrations.leads.get_mut(&lead) {
            let mut keep = pending.into_iter();
            entry.mailbox.retain(|_| keep.next().unwrap_or(true));
        }
    }

    /// Hand `agents.wait` callers the events they asked for; those events are
    /// then not sent again as a wake-up.
    fn answer_waits(&mut self, lead: i64, cx: &mut Context<Self>) {
        self.drop_answered(lead, cx);
        let Some(entry) = self.orchestrations.leads.get_mut(&lead) else {
            return;
        };
        let mut done = Vec::new();
        let mut kept = Vec::new();
        for wait in std::mem::take(&mut entry.waits) {
            let matches = |event: &Event| {
                (wait.names.is_empty() || wait.names.contains(&event.name))
                    && wait.until.contains(&event.kind.state())
            };
            if entry.mailbox.iter().any(matches) {
                let (taken, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut entry.mailbox)
                    .into_iter()
                    .partition(matches);
                entry.mailbox = rest;
                done.push((wait, taken));
            } else {
                kept.push(wait);
            }
        }
        entry.waits = kept;
        for (wait, events) in done {
            let agents = self.agent_states_json(lead, &wait.names, cx);
            let value = json!({
                "matched": true,
                "events": events.iter().map(|e| e.json(8_000)).collect::<Vec<_>>(),
                "agents": agents,
            });
            self.finish_app_call(wait.call, Ok(value), cx);
        }
    }

    /// Send the lead its waiting updates as one internal turn once it is idle.
    fn deliver_agent_events(&mut self, lead: i64, cx: &mut Context<Self>) {
        let Some(view) = self.ensure_session(lead, cx) else {
            return;
        };
        self.drop_answered(lead, cx);
        let Some(entry) = self.orchestrations.leads.get(&lead) else {
            return;
        };
        if entry.mailbox.is_empty() {
            return;
        }
        let chat = view.read(cx);
        if !chat.settings.orchestrator_enabled || chat.summary.archived {
            return;
        }
        // The user writing to the lead resets its automatic wake-up budget.
        let user_spoke_last = chat
            .agent_rows(cx)
            .and_then(|rows| {
                rows.iter()
                    .rev()
                    .find(|r| r.first && r.is_prompt())
                    .map(|r| r.role == "user")
            })
            .unwrap_or(false);
        // send_coordinator_report restores an evicted history before sending.
        let ready = chat.available_for_managed_run(cx)
            && chat.settings.usage_limit.is_none()
            && entry.waits.is_empty();
        let entry = self.orchestrations.leads.get_mut(&lead).unwrap();
        if user_spoke_last {
            entry.wakeups = 0;
        }
        if !ready || entry.wakeups >= MAX_WAKEUPS {
            // The lead is busy, the user is typing, or it is loading. Session
            // changes retry; a timer covers a composer cleared without one.
            if !entry.retrying && entry.wakeups < MAX_WAKEUPS {
                entry.retrying = true;
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(3)).await;
                    let _ = this.update(cx, |this, cx| {
                        if let Some(entry) = this.orchestrations.leads.get_mut(&lead) {
                            entry.retrying = false;
                        }
                        this.deliver_agent_events(lead, cx);
                    });
                })
                .detach();
            }
            return;
        }
        let events = std::mem::take(&mut entry.mailbox);
        entry.wakeups += 1;
        let last = entry.wakeups >= MAX_WAKEUPS;
        let text = orch::wake_message(&events, &self.roster(lead, cx), last);
        view.update(cx, |v, cx| v.send_coordinator_report(text, cx));
    }

    /// `agents.*`: only an Orchestrator thread drives agents, and only its own.
    pub(super) fn dispatch_agents_call(
        &mut self,
        call: Call,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let lead = call.session;
        let input = call.input.clone();
        let name = input["name"].as_str().unwrap_or_default().to_owned();
        let result: Result<Value, String> = match call.action.as_str() {
            "agents.start" => return self.start_agent(call, window, cx),
            "agents.wait" => return self.wait_for_agents(call, cx),
            "agents.read" => return self.read_agent(call, cx),
            "agents.list" => Ok(self.list_agents(lead, cx)),
            "agents.prompt" => self.agent_named(lead, &name).and_then(|(_, id)| {
                let view = self.ensure_session(id, cx).ok_or("Session not found")?;
                let steer = input["mode"].as_str() != Some("queue");
                let prompt = app::prompt(&input)?;
                let delivery = view.update(cx, |v, cx| v.agent_message(prompt, steer, cx))?;
                if delivery == Delivery::Turn
                    && let Some(watch) = self.orchestrations.watches.get_mut(&id)
                {
                    watch.quiet_stop = false;
                }
                Ok(json!({"name":name,"sessionId":id,"delivered":delivery.id()}))
            }),
            "agents.open" => self.agent_named(lead, &name).map(|(_, id)| {
                self.open(id, window, cx);
                json!({"name":name,"sessionId":id,"opened":true})
            }),
            "agents.stop" | "agents.close" => match self.agent_named(lead, &name) {
                Err(e) => Err(e),
                Ok((ix, id)) => {
                    if let Some(watch) = self.orchestrations.watches.get_mut(&id)
                        && !watch.state.settled()
                    {
                        watch.quiet_stop = true;
                    }
                    if let Some(view) = self.ensure_session(id, cx) {
                        view.update(cx, |v, cx| v.stop_app_session(cx));
                    }
                    if call.action == "agents.close" {
                        return self.close_agent(call, lead, ix, id, window, cx);
                    }
                    Ok(json!({"name":name,"sessionId":id,"stopped":true}))
                }
            },
            "agents.approve" => self.agent_named(lead, &name).and_then(|(_, id)| {
                let decision = match input["decision"].as_str() {
                    Some("allow") => Decision::Allow,
                    Some("session") => Decision::Session,
                    _ => Decision::Deny,
                };
                let view = self.ensure_session(id, cx).ok_or("Session not found")?;
                let request = view.update(cx, |v, cx| {
                    v.agent_approve(input["requestId"].as_str(), decision, cx)
                })?;
                Ok(json!({"name":name,"sessionId":id,"requestId":request,"decided":input["decision"]}))
            }),
            "agents.answer" => self.agent_named(lead, &name).and_then(|(_, id)| {
                let answers = if input["skip"] == true {
                    None
                } else {
                    Some(
                        serde_json::from_value::<Vec<Vec<String>>>(input["answers"].clone())
                            .map_err(|e| e.to_string())?,
                    )
                };
                let view = self.ensure_session(id, cx).ok_or("Session not found")?;
                let request = view.update(cx, |v, cx| {
                    v.agent_answer(input["requestId"].as_str(), answers, cx)
                })?;
                Ok(json!({"name":name,"sessionId":id,"requestId":request,"answered":input["skip"] != true}))
            }),
            _ => Err("Unknown agents action. Run app help agents".into()),
        };
        self.finish_app_call(call, result, cx);
    }

    fn list_agents(&mut self, lead: i64, cx: &mut Context<Self>) -> Value {
        self.drop_answered(lead, cx);
        let tasks = self
            .orchestration_summaries
            .get(&lead)
            .map(|s| s.tasks.clone())
            .unwrap_or_default();
        let unreported = self
            .orchestrations
            .leads
            .get(&lead)
            .map(|l| l.mailbox.len())
            .unwrap_or(0);
        let agents: Vec<Value> = tasks
            .iter()
            .filter(|t| t.open() && !t.name.is_empty())
            .filter_map(|task| {
                let id = task.session?;
                let (state, since) = self.agent_state(id, cx);
                let mut value = json!({
                    "name": task.name,
                    "sessionId": id,
                    "title": task.title,
                    "harness": task.provider,
                    "model": task.model,
                    "state": state.id(),
                });
                if since > 0 {
                    value["since"] = json!(since);
                }
                let project = self
                    .sessions
                    .get(&id)
                    .map(|v| v.read(cx).summary.cwd.clone())
                    .or_else(|| self.session_summaries.get(&id).map(|s| s.cwd.clone()))?;
                value["checkout"] = json!(
                    self.session_worktrees
                        .get(&id)
                        .cloned()
                        .flatten()
                        .unwrap_or(project)
                );
                if let Some(view) = self.sessions.get(&id) {
                    let chat = view.read(cx);
                    let observation = chat.agent_observation(cx);
                    if let Some(branch) = chat.agent_branch() {
                        value["branch"] = json!(branch);
                    }
                    if let Value::Object(launch) = chat.agent_launch() {
                        value.as_object_mut().unwrap().extend(launch);
                    }
                    if !observation.requests.is_empty() {
                        value["needsInput"] = json!(
                            observation
                                .requests
                                .iter()
                                .map(|r| r.json())
                                .collect::<Vec<_>>()
                        );
                    }
                    if let Some(error) = observation.error {
                        value["error"] = json!(monocode_core::response::limit(&error, 1_000));
                    }
                    let (messages, paused) = chat.agent_held_messages();
                    if messages > 0 {
                        value[if paused {
                            "heldMessages"
                        } else {
                            "queuedMessages"
                        }] = json!(messages);
                    }
                }
                Some(value)
            })
            .collect();
        let closed = tasks.iter().filter(|t| !t.open()).count();
        json!({"agents":agents,"closedAgents":closed,"unreportedEvents":unreported})
    }

    fn read_agent(&mut self, call: Call, cx: &mut Context<Self>) {
        let input = call.input.clone();
        let name = input["name"].as_str().unwrap_or_default().to_owned();
        let (id, view) = match self.agent_named(call.session, &name).and_then(|(_, id)| {
            self.ensure_session(id, cx)
                .map(|view| (id, view))
                .ok_or_else(|| "Session not found".to_owned())
        }) {
            Ok(found) => found,
            Err(e) => return self.finish_app_call(call, Err(e), cx),
        };
        let (state, since) = self.agent_state(id, cx);
        let requested = input["view"].as_str().unwrap_or("auto");
        let mode = match requested {
            "auto" if matches!(state, State::Working | State::Blocked | State::Starting) => {
                "activity"
            }
            "auto" => "last",
            other => other,
        }
        .to_owned();
        // Reading a settled agent's final message is hearing about its turn:
        // that turn's update is not sent again. Pending requests still are.
        self.drop_answered(call.session, cx);
        if mode == "last"
            && state.settled()
            && let Some(entry) = self.orchestrations.leads.get_mut(&call.session)
        {
            entry
                .mailbox
                .retain(|e| e.session != id || matches!(e.kind, EventKind::Blocked(_)));
        }
        let max_chars = input["maxChars"].as_u64().map(|n| n as usize);
        let chat = view.read(cx);
        let observation = chat.agent_observation(cx);
        let busy = observation.busy;
        let draft = chat.has_saved_draft();
        let live = chat
            .agent_rows(cx)
            .map(|rows| (chat.agent_steers(cx), rows));
        let mut head = json!({"name":name,"sessionId":id,"state":state.id(),"view":mode});
        if since > 0 {
            head["since"] = json!(since);
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
        let store = self.store.clone();
        let work = cx.background_executor().spawn(async move {
            if mode == "history" {
                let mut page = json!({});
                for key in ["before", "limit", "maxChars"] {
                    if let Some(value) = input.get(key) {
                        page[key] = value.clone();
                    }
                }
                let mut value = locked(&store)?.app_conversation(id, &page, busy, draft)?;
                for (key, field) in head.as_object().unwrap() {
                    value[key] = field.clone();
                }
                return Ok(value);
            }
            let (steers, rows) = match live {
                Some(live) => live,
                None => {
                    let store = locked(&store)?;
                    let rows = store.load(id)?.rows;
                    let turns = store.agent_settings(id)?.unwrap_or_default().turns;
                    (orch::steer_prompts(&rows, &turns), rows)
                }
            };
            let mut value = head;
            if mode == "activity" {
                value["activity"] = orch::activity(&rows, &steers, max_chars.unwrap_or(4_000));
            } else {
                let report = orch::final_message(&rows, &steers);
                let limit = max_chars.unwrap_or(12_000);
                value["finalMessageTruncated"] = json!(report.chars().count() > limit);
                value["finalMessage"] = json!(orch::tail(&report, limit));
                value["editedFiles"] = orch::activity(&rows, &steers, 0)["editedFiles"].clone();
                if let Some(at) = orch::turn_started_at(&rows, &steers) {
                    value["turnStartedAt"] = json!(at);
                }
            }
            Ok(value)
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| this.finish_app_call(call, result, cx));
        })
        .detach();
    }

    fn wait_for_agents(&mut self, call: Call, cx: &mut Context<Self>) {
        let lead = call.session;
        let names: Vec<String> = call.input["names"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|n| n.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        for name in &names {
            if let Err(e) = self.agent_named(lead, name) {
                return self.finish_app_call(call, Err(e), cx);
            }
        }
        let until: Vec<State> = call.input["until"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().and_then(State::parse))
                    .collect()
            })
            .unwrap_or_else(|| {
                vec![
                    State::Idle,
                    State::Blocked,
                    State::Stopped,
                    State::Failed,
                    State::UsageLimited,
                ]
            });
        let timeout = call.input["timeoutSeconds"].as_u64().unwrap_or(30);
        let id = self.orchestrations.next_wait;
        self.orchestrations.next_wait += 1;
        self.orchestrations
            .leads
            .entry(lead)
            .or_default()
            .waits
            .push(Wait {
                id,
                call,
                names: names.clone(),
                until,
            });
        self.answer_waits(lead, cx);
        if timeout == 0 {
            return self.expire_wait(lead, id, names, cx);
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(timeout))
                .await;
            let _ = this.update(cx, |this, cx| this.expire_wait(lead, id, names, cx));
        })
        .detach();
    }
    fn expire_wait(&mut self, lead: i64, id: u64, names: Vec<String>, cx: &mut Context<Self>) {
        let Some(entry) = self.orchestrations.leads.get_mut(&lead) else {
            return;
        };
        let Some(ix) = entry.waits.iter().position(|w| w.id == id) else {
            return;
        };
        let wait = entry.waits.remove(ix);
        let agents = self.agent_states_json(lead, &names, cx);
        self.finish_app_call(
            wait.call,
            Ok(json!({"matched":false,"events":[],"agents":agents})),
            cx,
        );
        // A wait held back wake-ups; deliver anything that arrived meanwhile.
        self.deliver_agent_events(lead, cx);
    }

    fn close_agent(
        &mut self,
        call: Call,
        lead: i64,
        ix: usize,
        id: i64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(mut summary) = self.orchestration_summaries.get(&lead).cloned() {
            summary.tasks[ix].close();
            self.save_summary(lead, summary, cx);
        }
        self.orchestrations.watches.remove(&id);
        if let Some(entry) = self.orchestrations.leads.get_mut(&lead) {
            entry.mailbox.retain(|event| event.session != id);
        }
        if let Some(summary) = self.session_summaries.get_mut(&id) {
            summary.archived = true;
        }
        if let Some(view) = self.sessions.get(&id) {
            view.update(cx, |v, _| v.summary.archived = true);
        }
        self.refresh_session_mark(id, cx);
        if self.workspace.tab_of(id).is_some() {
            self.close_pane(id, window, cx);
        }
        let name = call.input["name"].clone();
        let store = self.store.clone();
        let work = cx.background_executor().spawn(async move {
            locked(&store)?.set_archived(id, true)?;
            Ok(json!({"name":name,"sessionId":id,"closed":true}))
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                this.invalidate_chrome(cx);
                this.finish_app_call(call, result, cx)
            });
        })
        .detach();
    }

    fn start_agent(&mut self, call: Call, window: &mut Window, cx: &mut Context<Self>) {
        let lead = call.session;
        let input = call.input.clone();
        let name = input["name"].as_str().unwrap_or_default().to_owned();
        let open = self
            .orchestration_summaries
            .get(&lead)
            .map(|s| s.tasks.iter().filter(|t| t.open()).collect::<Vec<_>>())
            .unwrap_or_default();
        // Starts still creating their sessions count too: parallel calls
        // must not share a name or pass the limit together.
        let starting = self
            .orchestrations
            .starting
            .iter()
            .filter(|(l, _)| *l == lead)
            .count();
        let refused = if open.iter().any(|t| t.name == name)
            || self.orchestrations.starting.contains(&(lead, name.clone()))
        {
            Some(format!(
                "An open agent is already named {name}; pick another name or close it"
            ))
        } else if open.len() + starting >= MAX_AGENTS {
            Some(format!(
                "A lead can have {MAX_AGENTS} open agents; close finished ones first"
            ))
        } else if let Some(path) = input["checkout"].as_str()
            && let Some(other) = open.iter().find(|t| {
                t.session
                    .and_then(|id| self.session_worktrees.get(&id).cloned().flatten())
                    .is_some_and(|tree| {
                        monocode_core::files::path_key(&tree)
                            == monocode_core::files::path_key(path)
                    })
            })
        {
            Some(format!(
                "Agent {} already works in {path}; two agents must not share a worktree. Close it first, or prompt it instead",
                other.name
            ))
        } else {
            None
        };
        if let Some(error) = refused {
            return self.finish_app_call(call, Err(error), cx);
        }
        self.orchestrations.starting.insert((lead, name.clone()));
        let caller = self.sessions[&lead].read(cx);
        let project = caller.summary.cwd.clone();
        let provider = caller.summary.provider.clone();
        let inherited = caller.settings.clone();
        let lead_checkout = inherited
            .worktree_cwd
            .clone()
            .unwrap_or_else(|| project.clone());
        let parsed = (|| {
            // Without a harness the agent runs on the lead's own provider.
            let (kind, harness) = match input["harness"].as_str() {
                Some(id) => {
                    let kind = Kind::parse(id).ok_or("Unknown harness; run models.list")?;
                    (kind, kind.id().to_owned())
                }
                None => {
                    let kind = Kind::from_id(&provider);
                    (kind, kind.id().to_owned())
                }
            };
            let mut settings = inherited.clone();
            if harness != provider {
                settings.account = crate::accounts::get(cx)
                    .map(|center| center.read(cx).selected(kind, &project))
                    .unwrap_or_default();
            }
            Ok::<_, String>((kind, harness, settings))
        })();
        let (kind, harness, settings) = match parsed {
            Ok(parsed) => parsed,
            Err(e) => {
                self.orchestrations.starting.remove(&(lead, name));
                return self.finish_app_call(call, Err(e), cx);
            }
        };
        let request = call.request_id.clone();
        let fingerprint = app::fingerprint(&call.action, &input);
        let reveal = input["reveal"] == true;
        let store = self.store.clone();
        let agent = name.clone();
        let provider_id = harness.clone();
        #[cfg(test)]
        let lead_provider = provider.clone();
        let work = cx.background_executor().spawn(async move {
            let name = agent;
            let harness = provider_id;
            // launch_settings takes the sessions.start shape.
            let mut launch = json!({});
            for key in [
                "prompt",
                "harness",
                "model",
                "modelSettings",
                "effort",
                "runtimeMode",
            ] {
                if let Some(value) = input.get(key) {
                    launch[key] = value.clone();
                }
            }
            let cached = || {
                monocode_core::catalog::cached_models_for(kind, &settings.account)
                    .unwrap_or_default()
            };
            let models = if ["model", "modelSettings", "effort"]
                .iter()
                .any(|key| input.get(*key).is_some())
            {
                match monocode_core::catalog::models_for(kind, &settings.account) {
                    Ok(models) => models,
                    // These CLIs resolve a named model themselves; the catalog
                    // only adds defaults.
                    Err(_) if matches!(kind, Kind::Claude | Kind::Codex) => cached(),
                    Err(e) => return Err(e),
                }
            } else {
                cached()
            };
            let source = if harness == provider {
                kind.id()
            } else {
                provider.as_str()
            };
            let mut settings =
                app::launch_settings_for(&launch, source, settings, kind, &models, true)?;
            settings.revision = 0;
            let prompt = app::prompt(&input)?;
            let title = app::optional_text(&input, "title", 160)?.unwrap_or_else(|| {
                prompt
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or_default()
                    .chars()
                    .take(120)
                    .collect()
            });
            let title = format!("{name}: {}", title.trim());
            let mut store = locked(&store)?;
            let (mut summary, fresh) =
                store.create_app_session(lead, &request, &fingerprint, &harness, &project)?;
            let mut branch = None;
            if fresh {
                let checkout = (|| -> Result<(), String> {
                    if let Some(path) = input["checkout"].as_str() {
                        app::launch_checkout(
                            &json!({"worktreeCwd": path}),
                            &project,
                            summary.id,
                            &mut settings,
                        )?;
                        branch = monocode_core::git::worktrees(std::path::Path::new(&project))?
                            .into_iter()
                            .find(|w| settings.worktree_cwd.as_deref() == Some(w.path.as_str()))
                            .and_then(|w| w.branch);
                    } else if input["workspace"] == "shared" {
                        settings.worktree_cwd = inherited.worktree_cwd.clone();
                    } else {
                        let tree = monocode_core::git::create_project_worktree(
                            std::path::Path::new(&lead_checkout),
                            &format!("mc/agent-{name}-{}", summary.id),
                            Some(input["base"].as_str().unwrap_or("HEAD")),
                            false,
                        )
                        .map_err(|e| {
                            format!("Could not create the agent's worktree: {e}. Use workspace \"shared\" to run it in your checkout.")
                        })?;
                        settings.worktree_cwd = Some(tree.path);
                        branch = tree.branch;
                    }
                    Ok(())
                })();
                if let Err(error) = checkout {
                    let _ = store.delete(summary.id);
                    return Err(error);
                }
                let checkout = settings
                    .worktree_cwd
                    .clone()
                    .unwrap_or_else(|| project.clone());
                store.title(summary.id, &title)?;
                summary.title = title.clone();
                store.configure_agent(summary.id, &harness, &settings)?;
                store.prepare_app_prompt(
                    summary.id,
                    &request,
                    &orch::worker_prompt(&name, &checkout, branch.as_deref(), &prompt),
                )?;
                summary.has_messages = true;
            }
            Ok((summary, settings, fresh, branch, title))
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.orchestrations.starting.remove(&(lead, name.clone()));
                let result = result.map(|(summary, settings, fresh, branch, title)| {
                    let id = summary.id;
                    let checkout = settings.worktree_cwd.clone().unwrap_or_else(|| summary.cwd.clone());
                    let model = settings.model.clone();
                    let effort = settings.effort.clone();
                    let access = settings.access.id();
                    if fresh {
                        this.draft_sessions.insert(id);
                        this.sidebar_hidden_sessions.remove(&id);
                        this.session_worktrees.insert(id, settings.worktree_cwd.clone());
                        let mut roster = this.orchestration_summaries.get(&lead).cloned().unwrap_or_default();
                        roster.tasks.push(SummaryTask {
                            session: Some(id),
                            name: name.clone(),
                            title,
                            provider: harness.clone(),
                            model: model.clone(),
                            status: State::Starting.summary_status().into(),
                            outcome: None,
                        });
                        this.orchestrations
                            .watches
                            .insert(id, Watch::new(State::Starting, monocode_core::time::now_ms()));
                        this.save_summary(lead, roster, cx);
                        this.add(summary, cx);
                        if let Some(view) = this.sessions.get(&id) {
                            // Tests run agents of a fixture lead on the fixture
                            // provider, whose turns fail without a real CLI.
                            #[cfg(test)]
                            if lead_provider == "fixture" {
                                view.update(cx, |v, _| v.summary.provider = lead_provider.clone());
                            }
                            view.update(cx, |v, cx| v.install_app_launch(settings, true, cx));
                        }
                        if reveal {
                            this.open(id, window, cx);
                        }
                        this.persist(cx);
                    }
                    json!({"name":name,"sessionId":id,"checkout":checkout,"branch":branch,"harness":harness,"model":model,"effort":effort,"runtimeMode":access,"state":"starting"})
                });
                this.invalidate_chrome(cx);
                cx.notify();
                this.finish_app_call(call, result, cx);
            });
        })
        .detach();
        let _ = window;
    }
}

#[cfg(test)]
mod tests;
