//! SubagentDock: the running turn's subagents, on the composer. The card
//! counts the ones still working; opening it lists each with the step it is
//! on.
use super::*;
use monocode_core::tool::tasks::Subagent;

impl Conversation {
    /// The latest turn's subagents.
    pub(crate) fn subagents(&self, cx: &gpui::App) -> Vec<Subagent> {
        monocode_core::tool::tasks::subagents(self.transcript.read(cx).history_rows())
    }
    /// The latest turn's subagents still at work.
    pub(crate) fn running_subagents(&self, cx: &gpui::App) -> Vec<Subagent> {
        let mut agents = self.subagents(cx);
        agents.retain(|agent| agent.running);
        agents
    }
    pub(super) fn subagent_dock(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.busy {
            return None;
        }
        let agents = self.subagents(cx);
        let running = agents.iter().filter(|agent| agent.running).count();
        if running == 0 {
            return None;
        }
        let open = self.subagents_open;
        let rows = agents.into_iter().enumerate().map(|(ix, agent)| {
            let kind = agent
                .run
                .agent_type
                .clone()
                .or(agent.run.model.clone())
                .unwrap_or_default();
            div()
                .id(("subagent", ix))
                .px_3()
                .py_1()
                .flex()
                .items_center()
                .gap_2()
                .text_size(px(12.))
                .child(
                    div()
                        .flex_shrink_0()
                        .size(px(6.))
                        .rounded_full()
                        .bg(if agent.running {
                            accent_color()
                        } else {
                            content(0.25)
                        }),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .truncate()
                                .text_color(content(0.9))
                                .child(agent.run.title().to_owned()),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(11.))
                                .text_color(content(0.45))
                                .child(
                                    [
                                        kind,
                                        agent.latest().map(str::to_owned).unwrap_or_else(|| {
                                            if agent.running { "Starting…" } else { "Done" }.into()
                                        }),
                                    ]
                                    .into_iter()
                                    .filter(|part| !part.is_empty())
                                    .collect::<Vec<_>>()
                                    .join(" · "),
                                ),
                        ),
                )
        });
        Some(
            div()
                .id("subagent-dock")
                .debug_selector(|| "subagent-dock".into())
                .role(Role::Region)
                .aria_label("Subagents")
                .mb(px(6.))
                .rounded(px(10.))
                .bg(content(0.05))
                .flex()
                .flex_col()
                .child(
                    div()
                        .id("subagent-dock-toggle")
                        .role(Role::Button)
                        .aria_expanded(open)
                        .px_3()
                        .py(px(7.))
                        .flex()
                        .items_center()
                        .gap_2()
                        .cursor_pointer()
                        .text_size(px(12.))
                        .text_color(content(0.75))
                        .child(icon("bot", 14.))
                        .child(div().flex_1().child(format!(
                            "{running} subagent{} running",
                            if running == 1 { "" } else { "s" }
                        )))
                        .child(icon(if open { "chevron-down" } else { "chevron-up" }, 12.))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.subagents_open = !this.subagents_open;
                            cx.notify();
                        })),
                )
                .when(open, |d| {
                    d.child(
                        div()
                            .id("subagent-dock-list")
                            .max_h(px(220.))
                            .overflow_y_scroll()
                            .pb_1()
                            .children(rows),
                    )
                })
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monocode_core::{tool::ToolCall, transcript::Row};

    #[gpui::test]
    fn the_dock_counts_the_running_turns_subagents(cx: &mut gpui::TestAppContext) {
        let store = Arc::new(std::sync::Mutex::new(
            monocode_core::store::Store::open(Path::new(":memory:")).unwrap(),
        ));
        let summary = locked(&store).unwrap().create("claude", "/tmp").unwrap();
        let view = cx.new(|cx| Conversation::new(summary, store.clone(), cx));
        let row = |role: &str, text: String| Row {
            role: role.into(),
            text,
            first: true,
            sent_at: None,
        };
        let agent = |id: &str, state| {
            let mut call = ToolCall::new(id, "Task");
            call.input = serde_json::json!({"description": "Review the diff"}).to_string();
            call.state = state;
            row("tool", serde_json::to_string(&call).unwrap())
        };
        view.update(cx, |v, cx| {
            let rows = vec![
                row("user", "Go".into()),
                agent("a", monocode_core::tool::ToolState::Running),
                agent("b", monocode_core::tool::ToolState::Completed),
            ];
            v.transcript.update(cx, |t, cx| t.patch(0, rows, cx));
            assert!(
                v.subagent_dock(cx).is_none(),
                "only a running turn shows it"
            );
            v.busy = true;
            assert_eq!(v.running_subagents(cx).len(), 1);
            assert_eq!(v.subagents(cx).len(), 2);
            assert!(v.subagent_dock(cx).is_some());
        });
    }
}
