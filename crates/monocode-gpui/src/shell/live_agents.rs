//! LiveAgentsPreview.tsx: the sidebar's card of working sessions across every
//! project, with a folded Done section of recently finished ones.
use super::*;

/// LiveAgentsPreview shows for a single chat in flight, too.
const LIVE_AGENT_MIN: usize = 1;
const LIVE_AGENT_CAP: usize = 4;
// Tailwind amber-400 and emerald-400.
const AMBER: u32 = 0xfbbf24;
const EMERALD: u32 = 0x34d399;

struct LiveAgent {
    id: i64,
    cwd: String,
    provider: String,
    title: String,
    activity: String,
    started_at: Option<u64>,
    needs_approval: bool,
}

/// A recently finished turn in the card's Done section.
struct DoneAgent {
    id: i64,
    cwd: String,
    provider: String,
    title: String,
    finished_at: u64,
    duration_ms: Option<u64>,
    unseen: bool,
}

/// liveAgents.ts's formatLiveElapsed.
fn live_elapsed(ms: u64) -> String {
    let seconds = ((ms + 500) / 1000).max(1);
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let (minutes, rest) = (seconds / 60, seconds % 60);
    if minutes < 60 {
        return if rest > 0 {
            format!("{minutes}m {rest}s")
        } else {
            format!("{minutes}m")
        };
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest > 0 {
        format!("{hours}h {rest}m")
    } else {
        format!("{hours}h")
    }
}

/// Milliseconds until `live_elapsed` shows something else for a run this old:
/// labels count seconds for the first hour and minutes after that.
fn next_label_change(ms: u64) -> u64 {
    // live_elapsed rounds to the nearest second.
    let shown = ms + 500;
    let step = if shown >= 3_600_000 { 60_000 } else { 1_000 };
    step - shown % step
}

/// Milliseconds until `time::relative` moves on to the next minute.
fn next_age_change(ms: u64) -> u64 {
    60_000 - (ms + 500) % 60_000
}

impl Shell {
    fn live_agents(&self, cx: &App) -> Vec<LiveAgent> {
        let mut agents: Vec<_> = self
            .order
            .iter()
            .filter_map(|id| {
                let view = self.sessions.get(id)?.read(cx);
                if view.summary.archived || !view.responding() {
                    return None;
                }
                let (tool, started_at, _) = view.transcript.read(cx).live_turn(&view.summary.cwd);
                let needs_approval = view.needs_approval();
                Some(LiveAgent {
                    id: *id,
                    cwd: view.summary.cwd.clone(),
                    provider: view.summary.provider.clone(),
                    title: view.display_title(),
                    activity: if needs_approval {
                        "Need approval".into()
                    } else {
                        tool.unwrap_or_else(|| "Working".into())
                    },
                    started_at,
                    needs_approval,
                })
            })
            .collect();
        // compareLiveAgents: approvals first, then oldest first.
        agents.sort_by_key(|a| (!a.needs_approval, a.started_at.unwrap_or(u64::MAX)));
        agents
    }

    /// Finished turns, newest first. A chat that started another turn is
    /// back under Working, and archived or deleted chats drop out.
    fn done_agents(&self, cx: &App) -> Vec<DoneAgent> {
        self.workspace
            .recent_done
            .iter()
            .filter(|turn| {
                (self.sessions.contains_key(&turn.id)
                    || self.session_summaries.contains_key(&turn.id))
                    && !self.deleting.contains(&turn.id)
            })
            .filter_map(|turn| {
                let session = self.session_metadata(turn.id, cx);
                if session.summary.archived || session.busy || session.responding() {
                    return None;
                }
                Some(DoneAgent {
                    id: turn.id,
                    cwd: session.summary.cwd.clone(),
                    provider: session.summary.provider.clone(),
                    title: session.display_title(),
                    finished_at: turn.finished_at,
                    duration_ms: turn.duration_ms,
                    unseen: self.unseen_finished.contains(&turn.id),
                })
            })
            .collect()
    }

    pub(super) fn live_agents_preview(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let visible =
            self.workspace.preferences.working_agents && self.workspace.sidebar_activity_visible;
        let (agents, done) = if visible {
            (self.live_agents(cx), self.done_agents(cx))
        } else {
            (Vec::new(), Vec::new())
        };
        let working = agents.len() >= LIVE_AGENT_MIN;
        let shown = working || !done.is_empty();
        let done_open = self.workspace.sidebar_done_open && !done.is_empty();
        self.live_marks
            .retain(|id, _| working && agents.iter().any(|a| a.id == *id));
        let ticking = (working && agents.iter().any(|a| a.started_at.is_some())) || done_open;
        let now = monocode_core::time::now_ms();
        let done_ages = done
            .iter()
            .filter(|_| done_open)
            .map(|d| next_age_change(now.saturating_sub(d.finished_at)));
        self.live_next_change = agents
            .iter()
            .filter_map(|a| a.started_at)
            .map(|at| next_label_change(now.saturating_sub(at)))
            .chain(done_ages)
            .min()
            .unwrap_or(1000);
        if !ticking {
            self.live_tick = None;
        } else if self.live_tick.is_none() {
            self.live_tick = Some(cx.spawn(async move |this, cx| {
                loop {
                    let Ok(wait) = this.update(cx, |this, _| this.live_next_change) else {
                        break;
                    };
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(wait.max(50)))
                        .await;
                    // The card only matters while someone is looking at the app.
                    let result = this.update(cx, |this, cx| {
                        if crate::pulse::app_active(cx) {
                            this.notify_sidebar(cx);
                        }
                    });
                    if result.is_err() {
                        break;
                    }
                }
            }));
        }
        if !working {
            self.live_agents_expanded = false;
        }
        if !shown {
            return None;
        }
        let count = agents.len();
        let finished = done.len();
        let mut label = vec![];
        if working {
            label.push(format!(
                "{count} working agent{}",
                if count == 1 { "" } else { "s" }
            ));
        }
        if finished > 0 {
            label.push(format!("{finished} done"));
        }
        let working_section = working.then(|| self.live_agents_section(agents, now, cx));
        let done_section = (finished > 0).then(|| self.done_section(done, done_open, now, cx));
        Some(
            div()
                .id("live-agents")
                .debug_selector(|| "sidebar-activity-card".into())
                .role(Role::Group)
                .aria_label(label.join(", "))
                .flex_shrink_0()
                .px_2()
                .when(self.workspace.boxy_layout(), |d| d.pb_2())
                .child(
                    div()
                        .overflow_hidden()
                        .rounded_lg()
                        .bg(content(0.05))
                        .children(working_section)
                        .when(working && finished > 0, |d| {
                            d.child(div().mx(px(14.)).h_px().bg(content(0.06)))
                        })
                        .children(done_section),
                )
                .into_any(),
        )
    }

    fn live_agents_section(
        &mut self,
        agents: Vec<LiveAgent>,
        now: u64,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let count = agents.len();
        let extra = count.saturating_sub(LIVE_AGENT_CAP);
        let expanded = self.live_agents_expanded;
        let cards: Vec<_> = agents
            .into_iter()
            .take(if expanded { count } else { LIVE_AGENT_CAP })
            .map(|agent| self.live_agent_card(agent, now, cx))
            .collect();
        div()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px(px(14.))
                    .py_1p5()
                    .child(
                        div()
                            .size(px(6.))
                            .flex_shrink_0()
                            .rounded_full()
                            .bg(accent_color())
                            .shadow(vec![
                                BoxShadow::new(px(0.), px(0.), accent_color()).blur_radius(px(8.)),
                            ]),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.))
                            .text_color(content(0.5))
                            .child("Working"),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(content(0.4))
                            .child(count.to_string()),
                    ),
            )
            .child(
                div()
                    .id("live-agents-list")
                    .flex()
                    .flex_col()
                    .gap_px()
                    .px_1()
                    .when(extra == 0, |d| d.pb_1())
                    .when(expanded, |d| d.max_h(px(360.)).overflow_y_scroll())
                    .children(cards),
            )
            .when(extra > 0, |d| {
                d.child(
                    div()
                        .id("live-agents-more")
                        .group("live-agents-more")
                        .role(Role::Button)
                        .aria_expanded(expanded)
                        .cursor_pointer()
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .px_2()
                        .py_1p5()
                        .text_size(px(11.))
                        .text_color(content(0.5))
                        .hover(|s| s.bg(content(0.08)).text_color(content(1.)))
                        .child(
                            icon(
                                if expanded {
                                    "chevron-up"
                                } else {
                                    "chevron-down"
                                },
                                12.,
                            )
                            .text_color(content(0.5))
                            .group_hover("live-agents-more", |s| s.text_color(content(1.))),
                        )
                        .child(if expanded {
                            "Show less".to_owned()
                        } else {
                            format!("{extra} more")
                        })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.live_agents_expanded = !this.live_agents_expanded;
                            this.notify_sidebar(cx);
                        })),
                )
            })
    }

    /// The Done section: a folded header that still says how many replies
    /// arrived unseen, and the finished chats beneath it once opened.
    fn done_section(
        &mut self,
        done: Vec<DoneAgent>,
        open: bool,
        now: u64,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let count = done.len();
        let unseen = done.iter().filter(|d| d.unseen).count();
        let rows: Vec<_> = if open {
            done.into_iter()
                .map(|agent| self.done_agent_row(agent, now, cx))
                .collect()
        } else {
            Vec::new()
        };
        let mut label = format!("Done, {count} finished");
        if unseen > 0 {
            label.push_str(&format!(", {unseen} new"));
        }
        div()
            .child(
                div()
                    .id("sidebar-done-toggle")
                    .debug_selector(|| "sidebar-done-toggle".into())
                    .group("sidebar-done-toggle")
                    .role(Role::Button)
                    .aria_label(label)
                    .aria_expanded(open)
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px(px(14.))
                    .py_1p5()
                    .hover(|s| s.bg(content(0.04)))
                    .child(
                        div()
                            .size(px(6.))
                            .flex_shrink_0()
                            .rounded_full()
                            .bg(if unseen > 0 {
                                rgb(EMERALD).into()
                            } else {
                                content(0.25)
                            }),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.))
                            .text_color(content(0.5))
                            .group_hover("sidebar-done-toggle", |s| s.text_color(content(0.8)))
                            .child("Done"),
                    )
                    .when(unseen > 0 && !open, |d| {
                        d.child(
                            div()
                                .flex_shrink_0()
                                .px_1p5()
                                .rounded_full()
                                .bg(rgba((EMERALD << 8) | 0x24))
                                .text_size(px(10.))
                                .line_height(px(16.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(rgb(EMERALD))
                                .child(format!("{unseen} new")),
                        )
                    })
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(content(0.4))
                            .child(count.to_string()),
                    )
                    .child(
                        icon(if open { "chevron-up" } else { "chevron-down" }, 12.)
                            .flex_shrink_0()
                            .text_color(content(0.4))
                            .group_hover("sidebar-done-toggle", |s| s.text_color(content(1.))),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.workspace.sidebar_done_open = !this.workspace.sidebar_done_open;
                        this.save_state(cx);
                        this.notify_sidebar(cx);
                    })),
            )
            .when(open, |d| {
                d.child(
                    div()
                        .id("sidebar-done-list")
                        .flex()
                        .flex_col()
                        .gap_px()
                        .px_1()
                        .max_h(px(280.))
                        .overflow_y_scroll()
                        .children(rows),
                )
                .child(
                    div()
                        .id("sidebar-done-clear")
                        .debug_selector(|| "sidebar-done-clear".into())
                        .role(Role::Button)
                        .aria_label("Clear done list")
                        .cursor_pointer()
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .px_2()
                        .py_1p5()
                        .text_size(px(11.))
                        .text_color(content(0.4))
                        .hover(|s| s.bg(content(0.08)).text_color(content(1.)))
                        .child("Clear")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.workspace.recent_done.clear();
                            this.save_state(cx);
                            this.notify_sidebar(cx);
                        })),
                )
            })
    }

    fn done_agent_row(&mut self, agent: DoneAgent, now: u64, cx: &mut Context<Self>) -> AnyElement {
        let id = agent.id;
        let project = self.project_label(&agent.cwd);
        let age = monocode_core::time::relative(agent.finished_at, now);
        let duration = agent.duration_ms.map(live_elapsed);
        let selected = self.selected_sessions.contains(&id)
            || (self.workspace.active == Some(id) && !self.mono_active(cx));
        let label = [
            Some(agent.title.clone()),
            Some(project.clone()),
            agent.unseen.then(|| "New reply".to_owned()),
            Some(if age == "now" {
                "Finished just now".to_owned()
            } else {
                format!("Finished {age} ago")
            }),
            duration.as_ref().map(|d| format!("ran {d}")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ");
        div()
            .id(("done-agent", id as usize))
            .debug_selector(move || format!("done-agent-{id}"))
            .role(Role::Button)
            .aria_label(label)
            .cursor_pointer()
            .w_full()
            .flex()
            .flex_col()
            .rounded_md()
            .px_2()
            .py_1p5()
            .when(selected, |d| d.bg(content(0.1)))
            .when(!selected, |d| d.hover(|s| s.bg(content(0.08))))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(self.project_mark(&agent.cwd, 8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .font_weight(if agent.unseen {
                                FontWeight::SEMIBOLD
                            } else {
                                FontWeight::MEDIUM
                            })
                            .text_color(content(if agent.unseen { 1. } else { 0.75 }))
                            .child(agent.title),
                    )
                    .when(agent.unseen, |d| {
                        d.child(
                            div()
                                .size(px(6.))
                                .flex_shrink_0()
                                .rounded_full()
                                .bg(rgb(EMERALD)),
                        )
                    })
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(11.))
                            .text_color(content(0.4))
                            .child(age),
                    ),
            )
            .child(
                div()
                    .mt_1()
                    .pl_4()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .text_size(px(11.))
                    .line_height(px(14.))
                    .text_color(content(0.45))
                    .child(provider_icon(&agent.provider, 12.))
                    .child(div().flex_1().min_w_0().truncate().child(project))
                    .children(duration.map(|duration| {
                        div()
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .gap_1()
                            .child(icon("check", 11.).text_color(rgb(EMERALD)))
                            .child(duration)
                    })),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_from_activity(id, window, cx);
            }))
            .into_any()
    }

    fn open_from_activity(&mut self, id: i64, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_sessions.clear();
        self.selection_anchor = Some(id);
        self.open(id, window, cx);
        self.invalidate_chrome(cx);
        cx.notify();
    }

    fn live_agent_card(
        &mut self,
        agent: LiveAgent,
        now: u64,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = agent.id;
        let project = self.project_label(&agent.cwd);
        let elapsed = agent
            .started_at
            .map(|at| live_elapsed(now.saturating_sub(at)));
        let selected = self.selected_sessions.contains(&id)
            || (self.workspace.active == Some(id) && !self.mono_active(cx));
        let status: AnyElement = if agent.needs_approval {
            icon("alert-circle", 12.)
                .text_color(rgb(AMBER))
                .into_any_element()
        } else {
            let provider = agent.provider.clone();
            let mark = self
                .live_marks
                .entry(id)
                .or_insert_with(|| {
                    cx.new(|cx| {
                        let mut mark = SessionMark::tab(provider.clone());
                        mark.set(&provider, MarkState::Working, cx);
                        mark
                    })
                })
                .clone();
            div()
                .size(px(12.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .child(mark)
                .into_any_element()
        };
        let label = [
            Some(agent.title.clone()),
            Some(project.clone()),
            Some(agent.activity.clone()),
            elapsed.clone(),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
        div()
            .id(("live-agent", id as usize))
            .debug_selector(move || format!("live-agent-{id}"))
            .role(Role::Button)
            .aria_label(label)
            .cursor_pointer()
            .w_full()
            .flex()
            .flex_col()
            .rounded_md()
            .px_2()
            .py_1p5()
            .when(selected, |d| d.bg(content(0.1)))
            .when(!selected, |d| d.hover(|s| s.bg(content(0.08))))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(self.project_mark(&agent.cwd, 8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(content(1.))
                            .child(agent.title),
                    ),
            )
            .child(
                div()
                    .mt_1()
                    .pl_4()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .text_size(px(11.))
                    .line_height(px(14.))
                    .text_color(if agent.needs_approval {
                        rgb(AMBER).into()
                    } else {
                        content(0.5)
                    })
                    .child(status)
                    .child(div().min_w_0().truncate().child(agent.activity)),
            )
            .child(
                div()
                    .mt_1()
                    .pl_4()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .text_size(px(11.))
                    .line_height(px(14.))
                    .text_color(content(0.45))
                    .child(provider_icon(&agent.provider, 12.))
                    .child(div().flex_1().min_w_0().truncate().child(project))
                    .children(elapsed.map(|elapsed| div().flex_shrink_0().child(elapsed))),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_from_activity(id, window, cx);
            }))
            .into_any()
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use gpui::{TestAppContext, WindowHandle};

    fn selector(name: String) -> &'static str {
        Box::leak(name.into_boxed_str())
    }

    fn set_busy(
        window: WindowHandle<Shell>,
        id: i64,
        busy: bool,
        visual: &mut gpui::VisualTestContext,
    ) {
        window
            .update(visual, |shell, _, cx| {
                shell.sessions[&id].update(cx, |session, cx| {
                    session.busy = busy;
                    cx.emit(SessionChanged);
                });
            })
            .unwrap();
        visual.run_until_parked();
    }

    #[gpui::test]
    fn done_section_starts_folded_lists_newest_first_and_survives_restart(cx: &mut TestAppContext) {
        let (window, a, b) = super::super::tests::window(cx);
        let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
        assert!(visual.debug_bounds("sidebar-activity-card").is_none());
        for id in [a, b] {
            set_busy(window, id, true, visual);
            set_busy(window, id, false, visual);
        }
        window
            .update(visual, |shell, _, _| {
                let order: Vec<_> = shell.workspace.recent_done.iter().map(|t| t.id).collect();
                assert_eq!(order, vec![b, a], "the latest finish comes first");
                assert!(!shell.workspace.sidebar_done_open);
            })
            .unwrap();
        assert!(
            visual.debug_bounds("sidebar-activity-card").is_some(),
            "finished chats keep the card on screen"
        );
        assert!(visual.debug_bounds("sidebar-done-toggle").is_some());
        assert!(
            visual
                .debug_bounds(selector(format!("done-agent-{a}")))
                .is_none(),
            "the Done list is folded by default"
        );

        let toggle = visual.debug_bounds("sidebar-done-toggle").unwrap();
        visual.simulate_click(toggle.center(), Default::default());
        visual.run_until_parked();
        let first = visual
            .debug_bounds(selector(format!("done-agent-{b}")))
            .unwrap();
        let second = visual
            .debug_bounds(selector(format!("done-agent-{a}")))
            .unwrap();
        assert!(first.top() < second.top());
        window
            .update(visual, |shell, _, _| {
                assert!(shell.workspace.sidebar_done_open);
                let saved = shell.latest_state.lock().unwrap().clone();
                let known = [(a, String::new()), (b, String::new())];
                let restored = Workspace::restore(Some(&saved), &known, "/work/monocode");
                assert!(restored.sidebar_done_open);
                assert_eq!(restored.recent_done, shell.workspace.recent_done);
                let restored = Workspace::restore(Some(&saved), &known[..1], "/work/monocode");
                assert_eq!(
                    restored
                        .recent_done
                        .iter()
                        .map(|t| t.id)
                        .collect::<Vec<_>>(),
                    vec![a],
                    "deleted chats drop out on restore"
                );
            })
            .unwrap();

        set_busy(window, a, true, visual);
        assert!(
            visual
                .debug_bounds(selector(format!("done-agent-{a}")))
                .is_none(),
            "a chat working again moves back under Working"
        );
        assert!(
            visual
                .debug_bounds(selector(format!("live-agent-{a}")))
                .is_some()
        );
        set_busy(window, a, false, visual);
        let first = visual
            .debug_bounds(selector(format!("done-agent-{a}")))
            .unwrap();
        let second = visual
            .debug_bounds(selector(format!("done-agent-{b}")))
            .unwrap();
        assert!(first.top() < second.top(), "its new finish is the latest");

        let clear = visual.debug_bounds("sidebar-done-clear").unwrap();
        visual.simulate_click(clear.center(), Default::default());
        visual.run_until_parked();
        window
            .update(visual, |shell, _, _| {
                assert!(shell.workspace.recent_done.is_empty());
            })
            .unwrap();
        assert!(visual.debug_bounds("sidebar-activity-card").is_none());
    }
}
