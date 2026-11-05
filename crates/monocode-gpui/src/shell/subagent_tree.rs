//! SubagentTree.tsx: a session's delegated runs, hanging off its card in the
//! sidebar the way files hang off a folder. Only the session in front unfolds
//! it: it shows while the session works and a moment after, as the dock does,
//! and stays while one of its runs is open or the user opened it from the
//! card's count. A row opens that run's sheet.
use super::*;
use crate::{
    conversation::subagent_dock::{failed_color, run_mark},
    popover::{Align, Anchor, AnchorSlot, Side, popover},
    reveal::{Disclosure, Tween},
    transcript::{mascot::subagent_face, tasks::AgentBrief},
};
use monocode_core::tool::tasks::{RunState, Subagent};
use std::{
    rc::Rc,
    time::{Duration, Instant},
};

/// How long finished runs stay up once the turn is over.
const LINGER: Duration = Duration::from_millis(2_000);
/// `.subagent-tree`'s grid row transition.
const FOLD_MS: f32 = 260.;
const FOLD_EASE: (f32, f32, f32, f32) = (0.22, 1., 0.36, 1.);
/// `.subagent-chip`: a run joining the tree settles in beside the others.
const ROW_MS: f32 = 220.;
const GUIDE: f32 = 0.14;
/// A row's centre from its top: half of `h-6`.
const ROW_MIDDLE: f32 = 12.;

/// How the user left a session's tree from the card's count.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Choice {
    Open,
    Folded,
}

struct Tree {
    choice: Option<Choice>,
    /// The runs to draw, held past the end of the turn and through the fold.
    held: Rc<Vec<Subagent>>,
    ended_at: Option<Instant>,
    fold: Tween,
    /// When each run joined, for the settle of its row.
    joined: HashMap<String, Instant>,
}

#[derive(Default)]
pub(super) struct SubagentTrees {
    trees: HashMap<i64, Tree>,
    frames: Option<gpui::Task<()>>,
    wake: Option<gpui::Task<()>>,
    hovered: Option<i64>,
    anchors: std::cell::RefCell<HashMap<i64, AnchorSlot>>,
}

/// How far along a row is in settling in, from 0 to 1.
fn row_settle(now: Instant, joined: Instant) -> f32 {
    (now.saturating_duration_since(joined).as_secs_f32() * 1000. / ROW_MS).min(1.)
}

impl Shell {
    fn subagents_of(&self, id: i64, cx: &App) -> Option<(Rc<Vec<Subagent>>, bool, Option<String>)> {
        let view = self.sessions.get(&id)?.read(cx);
        // A host's sessions carry the host's ids; a Mono has no card for them.
        if view.is_remote() || view.settings.mono.is_some() {
            return None;
        }
        Some((view.subagents(cx), view.busy, view.subagent_sheet_run()))
    }

    /// Only the session in front lists its runs; the rest keep their count.
    fn subagents_shown(&self, id: i64, busy: bool) -> bool {
        let choice = self
            .subagent_trees
            .trees
            .get(&id)
            .and_then(|tree| tree.choice);
        self.workspace.active == Some(id)
            && choice != Some(Choice::Folded)
            && (choice == Some(Choice::Open) || busy)
    }

    /// Moves each session's tree toward where its turn stands.
    pub(super) fn sync_subagent_trees(&mut self, ids: &[i64], cx: &mut Context<Self>) {
        let now = Instant::now();
        let reduced = cx.reduce_motion();
        let mut animating = false;
        let mut wake: Option<Duration> = None;
        for &id in ids {
            let Some((runs, live, open_run)) = self.subagents_of(id, cx) else {
                self.subagent_trees.trees.remove(&id);
                continue;
            };
            if runs.is_empty() && !self.subagent_trees.trees.contains_key(&id) {
                continue;
            }
            let active = self.workspace.active == Some(id);
            let tree = self.subagent_trees.trees.entry(id).or_insert_with(|| Tree {
                choice: None,
                held: Rc::new(Vec::new()),
                ended_at: None,
                fold: Tween::settled(0., now),
                joined: HashMap::new(),
            });
            let unfolded = tree.choice != Some(Choice::Folded);
            let pinned = tree.choice == Some(Choice::Open);
            let selected = active && open_run.is_some();
            let mut target = false;
            if !runs.is_empty() && (live || pinned || selected) {
                tree.ended_at = None;
                tree.held = runs;
                target = true;
            } else if !tree.held.is_empty() {
                let ended = *tree.ended_at.get_or_insert(now);
                let linger = if live { Duration::ZERO } else { LINGER };
                if !live && !runs.is_empty() {
                    tree.held = runs;
                }
                let waited = now.saturating_duration_since(ended);
                if waited < linger {
                    target = true;
                    let left = linger - waited;
                    wake = Some(wake.map_or(left, |at| at.min(left)));
                }
            }
            tree.fold = tree.fold.toward(
                if target && unfolded && active { 1. } else { 0. },
                FOLD_MS,
                FOLD_EASE,
                reduced,
                now,
            );
            if !tree.fold.done(now) {
                animating = true;
            } else if !target && tree.fold.to <= 0. {
                tree.held = Rc::new(Vec::new());
                tree.ended_at = None;
                tree.joined.clear();
            }
            for agent in tree.held.iter() {
                let joined = *tree.joined.entry(agent.id.clone()).or_insert(now);
                if !reduced && row_settle(now, joined) < 1. {
                    animating = true;
                }
            }
        }
        let listed: HashSet<i64> = ids.iter().copied().collect();
        self.subagent_trees
            .trees
            .retain(|id, _| listed.contains(id));
        if animating && self.subagent_trees.frames.is_none() {
            self.subagent_trees.frames = Some(cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let _ = this.update(cx, |this, cx| {
                    this.subagent_trees.frames = None;
                    this.notify_sidebar(cx);
                });
            }));
        }
        if let Some(left) = wake.filter(|_| self.subagent_trees.wake.is_none()) {
            self.subagent_trees.wake = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(left).await;
                let _ = this.update(cx, |this, cx| {
                    this.subagent_trees.wake = None;
                    this.notify_sidebar(cx);
                });
            }));
        }
    }

    /// The card's row with its runs unfolded under it.
    pub(super) fn with_subagent_tree(
        &self,
        id: i64,
        nested: bool,
        row: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(tree) = self.subagent_trees.trees.get(&id) else {
            return row;
        };
        let now = Instant::now();
        let progress = tree.fold.value(now).clamp(0., 1.);
        if progress <= 0. || tree.held.is_empty() {
            return row;
        }
        let held = tree.held.clone();
        let live = self.subagents_of(id, cx).is_some_and(|(_, live, _)| live);
        let open_run = self.subagents_of(id, cx).and_then(|(_, _, run)| run);
        let count = held.len();
        // The guide runs down from under the card's harness icon.
        let body = div()
            .ml(px(17.))
            .mr(px(5.))
            .pb(px(4.))
            .flex()
            .flex_col()
            .children(held.iter().enumerate().map(|(ix, agent)| {
                let selected = open_run.as_deref() == Some(agent.id.as_str());
                self.subagent_tree_row(id, agent, live, selected, ix + 1 == count, cx)
            }));
        let width =
            px((self.workspace.sidebar_width - 16. - 22. - if nested { 30. } else { 0. }).max(0.));
        let body = if progress >= 1. {
            body.into_any_element()
        } else {
            div()
                .w_full()
                .opacity(progress)
                .overflow_hidden()
                .child(Disclosure::new(body, width, progress))
                .into_any_element()
        };
        div()
            .flex()
            .flex_col()
            .child(row)
            .child(body)
            .into_any_element()
    }

    fn subagent_tree_row(
        &self,
        session: i64,
        agent: &Subagent,
        live: bool,
        selected: bool,
        last: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let settle = self
            .subagent_trees
            .trees
            .get(&session)
            .and_then(|tree| tree.joined.get(&agent.id))
            .filter(|_| !cx.reduce_motion())
            .map_or(1., |joined| row_settle(Instant::now(), *joined));
        let eased = crate::reveal::bezier(settle, 0.22, 1., 0.36, 1.);
        let state = agent.state(live);
        let name = agent.run.display_name();
        let provider = self
            .sessions
            .get(&session)
            .and_then(|view| monocode_core::provider::Kind::parse(&view.read(cx).summary.provider))
            .unwrap_or(monocode_core::provider::Kind::Codex);
        let kind = agent.kind(provider);
        let tip = [agent.run.display_brief(), kind]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let group = SharedString::from(format!("subagent-run-{}", agent.id));
        let run = agent.id.clone();
        let selector = agent.id.clone();
        let guide = content(GUIDE);
        div()
            .relative()
            .pl(px(8.))
            // The guide and elbow; the last row's guide turns the corner.
            .when(!last, |d| {
                d.child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .bottom_0()
                        .w(px(1.))
                        .bg(guide),
                )
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .top(px(ROW_MIDDLE))
                        .w(px(6.))
                        .h(px(1.))
                        .bg(guide),
                )
            })
            .when(last, |d| {
                d.child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .h(px(ROW_MIDDLE + 1.))
                        .w(px(6.))
                        .border_l_1()
                        .border_b_1()
                        .border_color(guide)
                        .rounded_bl(px(5.)),
                )
            })
            .child(
                div()
                    .id(group.clone())
                    .debug_selector(move || format!("subagent-run-{selector}"))
                    .role(Role::Button)
                    .aria_label(format!("{name}, {}. Open its work", state.label()))
                    .aria_selected(selected)
                    .tooltip(move |_, cx| cx.new(|_| AgentBrief(tip.clone())).into())
                    .group(group.clone())
                    // The guide and elbow stand still; only the row settles in.
                    .relative()
                    .top(px(3. * (1. - eased)))
                    .opacity(eased)
                    .h(px(24.))
                    .w_full()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(6.))
                    .px(px(6.))
                    .text_size(px(12.))
                    .cursor_pointer()
                    .when(selected, |d| d.bg(content(0.1)))
                    .when(!selected, |d| d.hover(|s| s.bg(content(0.05))))
                    .child(subagent_face(&name, state, 14.))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_color(match state {
                                RunState::Failed => failed_color(),
                                _ if selected => content(1.),
                                RunState::Running => content(0.8),
                                _ => content(0.5),
                            })
                            .group_hover(group, move |s| match state {
                                RunState::Failed => s,
                                RunState::Running => s.text_color(content(1.)),
                                _ if selected => s,
                                _ => s.text_color(content(0.8)),
                            })
                            .child(name),
                    )
                    .children(run_mark(agent, live, 1.))
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.open_subagent_from_tree(session, &run, selected, window, cx);
                    })),
            )
            .into_any_element()
    }

    fn open_subagent_from_tree(
        &mut self,
        session: i64,
        run: &str,
        selected: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(view) = self.sessions.get(&session).cloned() else {
            return;
        };
        view.update(cx, |view, cx| {
            if selected {
                view.close_subagent_sheet(cx);
            } else {
                view.open_subagent_sheet(run, cx);
            }
        });
        // A subagent row brings its session forward the way a plain click does.
        if self.workspace.active != Some(session) {
            self.activate_session(session, window, cx);
        }
        self.notify_sidebar(cx);
    }

    /// SessionCard's count of the runs its latest turn delegated, and the
    /// switch that unfolds the tree beneath it. The face hops while any of them
    /// works and gives way to a chevron under the pointer; while the tree is
    /// folded or the session is in the back, hovering lists the runs.
    pub(super) fn subagent_badge(&self, id: i64, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (runs, live, _) = self.subagents_of(id, cx)?;
        if runs.is_empty() {
            return None;
        }
        let count = runs.len();
        let working = runs
            .iter()
            .filter(|run| run.state(live) == RunState::Running)
            .count();
        let face = runs
            .iter()
            .find(|run| run.state(live) == RunState::Running)
            .unwrap_or(&runs[0]);
        let expanded = self.subagents_shown(id, live);
        let group = SharedString::from(format!("subagent-count-{id}"));
        let slot = self
            .subagent_trees
            .anchors
            .borrow_mut()
            .entry(id)
            .or_default()
            .clone();
        let hovered = self.subagent_trees.hovered == Some(id) && !expanded;
        let label = format!(
            "{count} {}{}",
            if count == 1 { "subagent" } else { "subagents" },
            if working > 0 {
                format!(", {working} running")
            } else {
                String::new()
            }
        );
        Some(
            div()
                .id(("subagents", id as usize))
                .debug_selector(move || format!("subagent-count-{id}"))
                .role(Role::Button)
                .aria_label(label)
                .aria_expanded(expanded)
                .group(group.clone())
                .relative()
                .h(px(20.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded(px(6.))
                .px(px(4.))
                .text_size(px(11.))
                .font_features(crate::right_panel::tabular())
                .cursor_pointer()
                .text_color(content(if working > 0 { 0.6 } else { 0.4 }))
                .hover(|s| s.bg(content(0.1)).text_color(content(1.)))
                .child(slot.probe())
                .child(
                    div()
                        .relative()
                        .size(px(12.))
                        .flex_shrink_0()
                        .child(div().group_hover(group.clone(), |s| s.opacity(0.)).child(
                            subagent_face(
                                &face.run.display_name(),
                                if working > 0 {
                                    RunState::Running
                                } else {
                                    RunState::Done
                                },
                                12.,
                            ),
                        ))
                        .child(
                            div()
                                .absolute()
                                .top_0()
                                .left_0()
                                .opacity(0.)
                                .group_hover(group, |s| s.opacity(1.))
                                .child(
                                    icon(
                                        if expanded {
                                            "chevron-down"
                                        } else {
                                            "chevron-right"
                                        },
                                        12.,
                                    )
                                    .text_color(content(1.)),
                                ),
                        ),
                )
                .child(count.to_string())
                .when(hovered, |d| {
                    d.child(self.subagent_list_popover(id, &runs, live, working, slot.clone()))
                })
                // The card takes the pointer on press for dragging; keep it off this.
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    this.subagent_trees.hovered = hovered.then_some(id);
                    this.notify_sidebar(cx);
                }))
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.subagent_trees.hovered = None;
                    this.toggle_subagent_tree(id, window, cx);
                }))
                .into_any_element(),
        )
    }

    fn toggle_subagent_tree(&mut self, id: i64, window: &mut Window, cx: &mut Context<Self>) {
        let live = self.subagents_of(id, cx).is_some_and(|(_, live, _)| live);
        let shown = self.subagents_shown(id, live);
        if let Some(tree) = self.subagent_trees.trees.get_mut(&id) {
            tree.choice = Some(if shown { Choice::Folded } else { Choice::Open });
        }
        // A session in the back comes forward to show its runs.
        if self.workspace.active != Some(id) {
            self.activate_session(id, window, cx);
        }
        self.notify_sidebar(cx);
    }

    fn subagent_list_popover(
        &self,
        id: i64,
        runs: &[Subagent],
        live: bool,
        working: usize,
        slot: AnchorSlot,
    ) -> AnyElement {
        popover(
            SharedString::from(format!("subagent-list-{id}")),
            Anchor::Slot(slot),
        )
        .side(Side::Right)
        .align(Align::End)
        .width(248.)
        .max_height(320.)
        .allow_outside_press()
        .child(
            div()
                .debug_selector(|| "subagent-list".into())
                .p(px(10.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(content(0.85))
                                .child("Subagents"),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(10.))
                                .font_features(crate::right_panel::tabular())
                                .text_color(content(0.45))
                                .child(if working > 0 {
                                    format!("{working} running")
                                } else {
                                    format!("{} finished", runs.len())
                                }),
                        ),
                )
                .child(
                    div()
                        .mt(px(6.))
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .children(runs.iter().map(|run| {
                            let state = run.state(live);
                            let name = run.run.display_name();
                            div()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .rounded(px(6.))
                                .px(px(4.))
                                .py(px(4.))
                                .child(subagent_face(&name, state, 14.))
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex_1()
                                        .truncate()
                                        .text_size(px(11.))
                                        .text_color(match state {
                                            RunState::Failed => failed_color(),
                                            RunState::Running => content(0.75),
                                            _ => content(0.5),
                                        })
                                        .child(name),
                                )
                                .when(state != RunState::Running, |d| {
                                    d.children(run_mark(run, live, 1.))
                                })
                        })),
                ),
        )
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, VisualTestContext};
    use monocode_core::{
        tool::{
            ToolCall, ToolState,
            tasks::{AgentRun, Panel},
        },
        transcript::Row,
    };

    fn rows() -> Vec<Row> {
        let row = |role: &str, text: String| Row {
            role: role.into(),
            text,
            first: true,
            sent_at: None,
        };
        let agent = |id: &str, state| {
            let mut call = ToolCall::new(id, "Agent");
            call.state = state;
            call.panel = Some(Panel::Agent(Box::new(AgentRun {
                brief: format!("Review {id}"),
                ..AgentRun::default()
            })));
            row("tool", serde_json::to_string(&call).unwrap())
        };
        vec![
            row("user", "Go".into()),
            agent("a", ToolState::Running),
            agent("b", ToolState::Completed),
        ]
    }

    /// Tree motion runs on the wall clock, as the window's frames do.
    fn settle(window: gpui::WindowHandle<Shell>, cx: &mut VisualTestContext) {
        for _ in 0..2 {
            std::thread::sleep(Duration::from_millis(FOLD_MS as u64 + 20));
            window
                .update(cx, |shell, _, cx| {
                    shell.invalidate_chrome(cx);
                    cx.notify();
                })
                .unwrap();
            cx.run_until_parked();
        }
    }

    #[gpui::test]
    fn a_working_sessions_runs_hang_off_its_card_and_open_their_sheet(cx: &mut TestAppContext) {
        let (window, _, id) = crate::shell::tests::window(cx);
        let cx = &mut VisualTestContext::from_window(window.into(), cx);
        window
            .update(cx, |shell, _, cx| {
                shell.sessions[&id].update(cx, |view, cx| {
                    view.summary.has_messages = true;
                    view.loaded = true;
                    view.busy = true;
                    view.transcript.update(cx, |t, cx| t.patch(0, rows(), cx));
                });
                shell.workspace.active = Some(id);
                shell.invalidate_chrome(cx);
            })
            .unwrap();
        settle(window, cx);
        assert!(
            cx.debug_bounds("subagent-run-a").is_some(),
            "the tree unfolds"
        );
        let count = Box::leak(format!("subagent-count-{id}").into_boxed_str());
        assert!(cx.debug_bounds(count).is_some(), "the card counts its runs");

        // A row opens the run's sheet, and pressing it again folds it.
        let row = cx.debug_bounds("subagent-run-a").unwrap();
        cx.simulate_click(row.center(), Default::default());
        cx.run_until_parked();
        window
            .read_with(cx, |shell, cx| {
                assert_eq!(
                    shell.sessions[&id].read(cx).subagent_sheet_run().as_deref(),
                    Some("a")
                );
            })
            .unwrap();
        settle(window, cx);
        let row = cx.debug_bounds("subagent-run-a").unwrap();
        cx.simulate_click(row.center(), Default::default());
        cx.run_until_parked();
        window
            .read_with(cx, |shell, cx| {
                assert_eq!(shell.sessions[&id].read(cx).subagent_sheet_run(), None);
            })
            .unwrap();

        // The count folds the tree away, and the tree stays folded.
        let toggle = cx.debug_bounds(count).unwrap();
        cx.simulate_click(toggle.center(), Default::default());
        cx.run_until_parked();
        settle(window, cx);
        assert!(
            cx.debug_bounds("subagent-run-a").is_none(),
            "folded by choice"
        );
        let toggle = cx.debug_bounds(count).unwrap();
        cx.simulate_click(toggle.center(), Default::default());
        cx.run_until_parked();
        settle(window, cx);
        assert!(
            cx.debug_bounds("subagent-run-a").is_some(),
            "unfolded again"
        );
    }
}
