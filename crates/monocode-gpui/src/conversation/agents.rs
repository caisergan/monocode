//! What an orchestrator's `agents.*` actions need from one of its agents:
//! its state, its rows, and the message, approval and answer paths the user's
//! own composer and cards use.
use super::*;
use monocode_core::orchestration::{Observation, Request, names_request, public_request_id};
use serde_json::{Value, json};

/// How `agent_message` handed a prompt to the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    /// Started the agent's next turn.
    Turn,
    /// Added to the running turn.
    Steer,
    /// Held until the running turn ends.
    Queued,
}
impl Delivery {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Delivery::Turn => "turn",
            Delivery::Steer => "steer",
            Delivery::Queued => "queued",
        }
    }
}

impl Conversation {
    /// The orchestration view of this session right now.
    pub(crate) fn agent_observation(&self, cx: &gpui::App) -> Observation {
        let queued = !self.follow_ups.state.paused && !self.follow_ups.state.messages.is_empty();
        let requests = self
            .approvals
            .iter()
            .map(|approval| Request {
                id: public_request_id(&approval.id),
                kind: "approval",
                title: approval.title.clone(),
                detail: approval.detail.clone(),
                items: Value::Null,
                remember: approval.can_remember,
            })
            .chain(self.questions.iter().map(|(card, _)| {
                let question = card.read(cx).request();
                Request {
                    id: public_request_id(&question.id),
                    remember: false,
                    kind: "question",
                    title: question.title.clone(),
                    detail: String::new(),
                    items: question
                        .items
                        .iter()
                        .map(|item| {
                            json!({
                                "prompt": item.prompt,
                                "multiple": item.multiple,
                                "allowCustom": item.allow_custom,
                                "options": item.options.iter().map(|o| &o.label).collect::<Vec<_>>(),
                            })
                        })
                        .collect(),
                }
            }))
            .collect();
        // A failed turn ends on an error row; a stopped one does not.
        let error = (!self.busy)
            .then(|| {
                let rows = self.transcript.read(cx).source_rows();
                let turn = rows.iter().rposition(|r| r.is_prompt() && r.first)?;
                let at = rows[turn..]
                    .iter()
                    .rposition(|r| r.role == "error" && r.first)?;
                Some(
                    rows[turn + at..]
                        .iter()
                        .take_while(|r| r.role == "error")
                        .map(|r| r.text.as_str())
                        .collect::<String>(),
                )
            })
            .flatten();
        Observation {
            busy: self.busy
                || self.stopping
                || self.preparing_worktree
                || queued
                || self.follow_ups.sending.is_some(),
            requests,
            usage_limited: self.settings.usage_limit.is_some(),
            stopped: self.notification_cancelled,
            error,
            held: self.follow_ups.state.paused && !self.follow_ups.state.messages.is_empty(),
        }
    }
    /// The loaded rows, or `None` while the history must be restored first.
    pub(crate) fn agent_rows(&self, cx: &gpui::App) -> Option<Vec<monocode_core::transcript::Row>> {
        (self.history_ready() && !self.needs_history_restore())
            .then(|| self.transcript.read(cx).source_rows().to_vec())
    }
    pub(crate) fn agent_branch(&self) -> Option<String> {
        self.branch.clone()
    }
    /// What the agent runs on: its effort, access policy and, once its
    /// provider reported it, the concrete model behind an alias.
    pub(crate) fn agent_launch(&self) -> Value {
        let mut value = json!({"runtimeMode": self.settings.access.id()});
        if let Some(effort) = &self.settings.effort {
            value["effort"] = json!(effort);
        }
        if let Some(resolved) = self
            .resolved_model
            .as_ref()
            .filter(|id| self.model.as_ref() != Some(*id))
        {
            value["resolvedModel"] = json!(resolved);
        }
        value
    }
    /// Messages held after a stop or a failure; they run once resumed.
    pub(crate) fn agent_held_messages(&self) -> (usize, bool) {
        (
            self.follow_ups.state.messages.len(),
            self.follow_ups.state.paused,
        )
    }
    /// Give the agent `prompt`: its next turn when idle, otherwise a steer or a
    /// queued message. Every path goes through the agent's message queue, as
    /// the user's own follow-ups do, so the user's composer and saved draft
    /// are never touched and an evicted history is restored first.
    pub(crate) fn agent_message(
        &mut self,
        prompt: String,
        steer: bool,
        cx: &mut Context<Self>,
    ) -> Result<Delivery, String> {
        if self.needs_approval() {
            return Err("The agent is waiting on an approval or a question; decide it first with agents.approve or agents.answer.".into());
        }
        if self.settings.usage_limit.is_some() {
            return Err("The agent stopped at a provider usage limit; wait for the reset or start another agent.".into());
        }
        if self.settings.worktree_removed {
            return Err("The agent's checkout was removed; close it and start a new agent.".into());
        }
        let running = self.busy
            || self.stopping
            || self.preparing_worktree
            || self.follow_ups.sending.is_some()
            || (!self.follow_ups.state.paused && !self.follow_ups.state.messages.is_empty());
        if !running && !self.history_ready() {
            // An idle agent's saved queue may not be in memory yet, and saving
            // now would replace it. Deliver once its history is back.
            self.defer_history_action(
                move |this, cx| {
                    let _ = this.agent_message(prompt, steer, cx);
                },
                cx,
            );
            self.load(cx);
            return Ok(Delivery::Turn);
        }
        let mut message = self.message(prompt, Vec::new(), None, cx);
        let delivery = if !running {
            // Held messages after a stop stay held; this one runs now.
            self.follow_ups.requested = Some(message.id.clone());
            Delivery::Turn
        } else if steer && message.can_steer() && self.turn_takes_steer() {
            message.steer = true;
            Delivery::Steer
        } else {
            Delivery::Queued
        };
        self.follow_ups.motion.insert(
            &message.id,
            self.follow_ups.state.messages.is_empty(),
            !cx.reduce_motion(),
        );
        self.follow_ups.state.messages.push(message);
        self.save_follow_ups(cx);
        cx.emit(SessionChanged);
        Ok(delivery)
    }
    /// The pending approval `request_id`, or the only one.
    pub(crate) fn agent_approve(
        &mut self,
        request_id: Option<&str>,
        decision: Decision,
        cx: &mut Context<Self>,
    ) -> Result<String, String> {
        // The user can decide the same request in the agent's chat or from an
        // approval toast, so a request may be gone by the time the lead acts.
        let approval = match request_id {
            Some(given) => self
                .approvals
                .iter()
                .find(|approval| names_request(&approval.id, given))
                .ok_or("That approval is no longer pending: it was decided already (the user can also decide it in the agent's chat), or the requestId is wrong. Run agents.read for the agent's state")?,
            None => match self.approvals.len() {
                1 => &self.approvals[0],
                0 => return Err("The agent has no pending approval; it may have been decided already. Run agents.read for the agent's state".into()),
                _ => return Err("The agent has several approvals; pass requestId".into()),
            },
        };
        if matches!(decision, Decision::Session) && !approval.can_remember {
            return Err("This approval cannot be allowed for the session; use allow".into());
        }
        let id = approval.id.clone();
        if self.decide_notification_request(&id, decision, cx) {
            Ok(public_request_id(&id))
        } else {
            Err(self.status.clone())
        }
    }
    /// Answer the agent's current question, as its question card would.
    pub(crate) fn agent_answer(
        &mut self,
        request_id: Option<&str>,
        answers: Option<Vec<Vec<String>>>,
        cx: &mut Context<Self>,
    ) -> Result<String, String> {
        let (card, _) = self
            .questions
            .front()
            .ok_or("The agent has no pending question")?;
        let question = card.read(cx).request().clone();
        if request_id.is_some_and(|given| !names_request(&question.id, given)) {
            return Err(format!(
                "Answer the agent's current question first (requestId {})",
                public_request_id(&question.id)
            ));
        }
        if let Some(answers) = &answers {
            if answers.len() != question.items.len() {
                return Err(format!(
                    "Provide one answer list per question item ({} items)",
                    question.items.len()
                ));
            }
            for (item, chosen) in question.items.iter().zip(answers) {
                if !item.multiple && chosen.len() > 1 {
                    return Err(format!("\"{}\" takes one answer", item.prompt));
                }
                if !item.allow_custom
                    && chosen
                        .iter()
                        .any(|c| !item.options.iter().any(|o| &o.label == c))
                {
                    return Err(format!(
                        "\"{}\" takes one of its option labels",
                        item.prompt
                    ));
                }
            }
        }
        self.resolve_question(&question.id, answers, cx)?;
        Ok(public_request_id(&question.id))
    }
    /// The question card's reply path: send the answer (or a skip) and drop
    /// the card. Only the front question can be answered.
    pub(crate) fn resolve_question(
        &mut self,
        id: &str,
        answers: Option<Vec<Vec<String>>>,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if self
            .questions
            .front()
            .is_none_or(|(card, _)| card.read(cx).id() != id)
        {
            return Err("That question is no longer pending".into());
        }
        let before = self.needs_approval();
        let decision = answers.map_or(Decision::Deny, Decision::Answer);
        if self.controls.as_ref().is_none_or(|controls| {
            controls
                .send(Control {
                    id: id.to_owned(),
                    decision,
                })
                .is_err()
        }) {
            self.status = "The provider is no longer waiting for this answer".into();
            cx.notify();
            return Err(self.status.clone());
        }
        if let Some((card, _)) = self.questions.pop_front() {
            self.question_overlay.release(card, cx);
        }
        self.status = if !self.approvals.is_empty() {
            "Waiting for approval"
        } else if !self.questions.is_empty() {
            "Waiting for your answer"
        } else {
            "Working…"
        }
        .into();
        if before != self.needs_approval() {
            cx.emit(SessionChanged);
        }
        cx.notify();
        Ok(())
    }
}

#[cfg(test)]
impl Conversation {
    /// A provider waiting on `approval`; the receiver sees the decision.
    pub(crate) fn test_wait_for_approval(
        &mut self,
        approval: Approval,
        cx: &mut Context<Self>,
    ) -> std::sync::mpsc::Receiver<Control> {
        let (controls, decisions) = std::sync::mpsc::channel();
        self.controls = Some(controls);
        self.busy = true;
        self.approvals.push_back(approval);
        cx.emit(SessionChanged);
        decisions
    }
    /// The provider reports the end of a turn the test drove by hand.
    pub(crate) fn test_end_turn(&mut self, cx: &mut Context<Self>) {
        self.busy = false;
        self.stopping = false;
        self.approvals.clear();
        self.controls = None;
        self.status = "Ready".into();
        cx.emit(SessionChanged);
    }
}
