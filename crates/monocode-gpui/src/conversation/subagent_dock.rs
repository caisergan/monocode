//! SubagentDock.tsx: the delegated runs of the turn, docked on the composer the
//! way the usage limit notice is: a tab of the same shape, so a glance down
//! shows who is still working without scrolling back to where they started. A
//! click opens a run's sheet.
use super::*;
use crate::{reveal::Tween, shell::live_agents::live_elapsed, transcript::mascot::subagent_face};
use gpui::Task;
use monocode_core::{
    context::format_tokens,
    tool::tasks::{RunState, Subagent, token_totals, visible_subagents},
};
use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Duration};

/// Chips that fit beside the totals before the rest fold into "+N".
const CHIP_LIMIT: usize = 3;
/// How long finished runs stay up once the turn is over.
const LINGER: Duration = Duration::from_millis(2_000);
/// Hovering this long over a chip opens its peek.
const PEEK_DELAY: Duration = Duration::from_millis(280);
const CARD_HEIGHT: f32 = 32.;
/// The card's rise and fold: `.subagent-dock`'s grid row transition.
const FOLD_MS: f32 = 260.;
const FOLD_EASE: (f32, f32, f32, f32) = (0.22, 1., 0.36, 1.);
/// `.subagent-chip`: a run joining the card settles in beside the others.
const CHIP_MS: f32 = 220.;
/// `.subagent-mark`: a finished run's tick fades in where its time was.
const MARK_MS: f32 = 240.;
/// The "N agents working" label. Tauri's `@[52rem]` query drops it 48 px under
/// its widest card; native's column is narrower, so the same 48 px is measured
/// from here instead of copying 832, which no native card ever reaches.
const LABEL_MIN_WIDTH: f32 = 748.;

pub(crate) fn failed_color() -> gpui::Hsla {
    gpui::rgb(0xf87171).into()
}

#[derive(Default)]
pub(super) struct Dock {
    /// The runs to draw, held a little past the end of the turn so the last
    /// tick lands before the card folds away, then kept through the fold.
    held: Rc<Vec<Subagent>>,
    ended_at: Option<Instant>,
    fold: Option<Tween>,
    wake: Option<Task<()>>,
    chips: RefCell<HashMap<String, ChipMotion>>,
    slots: RefCell<HashMap<String, AnchorSlot>>,
    tokens_slot: AnchorSlot,
    peek: Option<String>,
    peek_wait: Option<Task<()>>,
    tokens_hovered: bool,
    /// What the sidebar last showed, so it only redraws for a change it shows.
    signature: u64,
}

struct ChipMotion {
    joined: Instant,
    state: RunState,
    settled: Option<Instant>,
}

/// The time while it runs, or how it ended. Shared with the sidebar's tree.
pub(crate) fn run_mark(agent: &Subagent, live: bool, opacity: f32) -> Option<AnyElement> {
    match agent.state(live) {
        RunState::Running => {
            let agent = agent.clone();
            agent.elapsed_ms(monocode_core::time::now_ms(), true)?;
            let id = SharedString::from(format!("subagent-clock-{}", agent.id));
            Some(
                crate::pulse::looping(
                    id,
                    Duration::from_millis(1_000),
                    crate::pulse::Rate::Low,
                    move |_| {
                        div()
                            .flex_shrink_0()
                            .text_size(px(11.))
                            .font_features(crate::right_panel::tabular())
                            .text_color(content(0.40))
                            .children(
                                agent
                                    .elapsed_ms(monocode_core::time::now_ms(), true)
                                    .map(live_elapsed),
                            )
                    },
                )
                .into_any_element(),
            )
        }
        RunState::Failed => Some(
            icon("alert-circle", 12.)
                .text_color(failed_color())
                .opacity(opacity)
                .into_any_element(),
        ),
        RunState::Stopped => Some(
            div()
                .flex_shrink_0()
                .text_size(px(11.))
                .text_color(content(0.35))
                .opacity(opacity)
                .child("stopped")
                .into_any_element(),
        ),
        RunState::Done => Some(
            icon("check", 12.)
                .text_color(content(0.40))
                .opacity(opacity)
                .into_any_element(),
        ),
    }
}

impl Conversation {
    /// The latest turn's subagents.
    pub(crate) fn subagents(&self, cx: &gpui::App) -> Rc<Vec<Subagent>> {
        self.transcript.read(cx).subagents()
    }

    /// Moves the card toward where the turn stands. Returns whether it draws.
    fn step_subagent_dock(&mut self, cx: &mut Context<Self>) -> bool {
        let runs = if self.settings.mono.is_some() {
            Rc::new(Vec::new())
        } else {
            self.subagents(cx)
        };
        let live = self.busy;
        let now = Instant::now();
        let reduced = cx.reduce_motion();
        // An open sheet stands on the card, so the card stays while it is open.
        let active = !runs.is_empty() && (live || self.subagent_sheet_open());
        let dock = &mut self.subagent_dock;
        let fold = dock.fold.unwrap_or_else(|| Tween::settled(0., now));
        if active {
            dock.ended_at = None;
            dock.wake = None;
            dock.held = runs;
            dock.fold = Some(fold.toward(1., FOLD_MS, FOLD_EASE, reduced, now));
        } else if !dock.held.is_empty() {
            let ended = *dock.ended_at.get_or_insert(now);
            // A new turn has begun without runs of its own: fold straight away.
            // A turn that is over shows its runs as they ended for a moment first.
            let linger = if live { Duration::ZERO } else { LINGER };
            if !live && !runs.is_empty() {
                dock.held = runs;
            }
            let waited = now.saturating_duration_since(ended);
            if waited >= linger {
                let fold = fold.toward(0., FOLD_MS, FOLD_EASE, reduced, now);
                dock.fold = Some(fold);
                if fold.done(now) && fold.value(now) <= 0. {
                    dock.held = Rc::new(Vec::new());
                    dock.ended_at = None;
                    dock.fold = None;
                    dock.chips.borrow_mut().clear();
                    dock.peek = None;
                    dock.tokens_hovered = false;
                }
            } else if dock.wake.is_none() {
                dock.wake = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(linger - waited).await;
                    let _ = this.update(cx, |this, cx| {
                        this.subagent_dock.wake = None;
                        cx.notify();
                    });
                }));
            }
        }
        !self.subagent_dock.held.is_empty()
    }

    /// Tell the sidebar when something it shows about the runs has changed.
    pub(super) fn note_subagents_changed(&mut self, cx: &mut Context<Self>) {
        use std::hash::{Hash, Hasher};
        let live = self.busy;
        let mut hasher = std::hash::DefaultHasher::new();
        for agent in self.subagents(cx).iter() {
            agent.id.hash(&mut hasher);
            agent.run.display_name().hash(&mut hasher);
            (agent.state(live) as u8).hash(&mut hasher);
        }
        self.subagent_sheet_run().hash(&mut hasher);
        live.hash(&mut hasher);
        let signature = hasher.finish();
        if signature != self.subagent_dock.signature {
            self.subagent_dock.signature = signature;
            cx.emit(SubagentsChanged);
        }
    }

    pub(super) fn subagent_dock(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let shown = self.step_subagent_dock(cx);
        self.step_subagent_sheet(window, cx);
        if !shown {
            return None;
        }
        let now = Instant::now();
        let live = self.busy;
        let agents = self.subagent_dock.held.clone();
        let selected = self.subagent_sheet_run();
        let fold = self
            .subagent_dock
            .fold
            .unwrap_or_else(|| Tween::settled(1., now));
        if !fold.done(now) {
            window.request_animation_frame();
        }
        let open = fold.to > 0.;
        let attached = selected.is_some() && open;
        let (visible, hidden) = visible_subagents(&agents, live, CHIP_LIMIT, selected.as_deref());
        let working = agents
            .iter()
            .filter(|agent| agent.state(live) == RunState::Running)
            .count();
        let totals = token_totals(&agents);
        let label = if working > 0 {
            format!(
                "{working} {} working",
                if working == 1 { "agent" } else { "agents" }
            )
        } else if agents.len() == 1 {
            "Agent done".to_owned()
        } else {
            "Agents done".to_owned()
        };
        let width = self
            .composer_anchor
            .get()
            .map_or(0., |bounds| f32::from(bounds.size.width) - 16.);
        let chips: Vec<AnyElement> = visible
            .iter()
            .map(|&ix| {
                let agent = &agents[ix];
                self.subagent_chip(
                    agent,
                    live,
                    selected.as_deref() == Some(&agent.id),
                    now,
                    window,
                    cx,
                )
            })
            .collect();
        let more = (!hidden.is_empty()).then(|| {
            let first = agents[hidden[0]].id.clone();
            let names = hidden
                .iter()
                .map(|&ix| agents[ix].run.display_name())
                .collect::<Vec<_>>()
                .join("\n");
            div()
                .id("subagent-more")
                .debug_selector(|| "subagent-more".into())
                .role(Role::Button)
                .aria_label(format!("{} more agents", hidden.len()))
                .tooltip(move |_, cx| {
                    cx.new(|_| crate::transcript::tasks::AgentBrief(names.clone()))
                        .into()
                })
                .h(px(24.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .rounded(px(6.))
                .px(px(6.))
                .font_features(crate::right_panel::tabular())
                .cursor_pointer()
                .hover(|s| s.bg(content(0.1)).text_color(content(1.)))
                .child(format!("+{}", hidden.len()))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.toggle_subagent_sheet(&first, cx);
                }))
        });
        let dot = dock_dot(working > 0);
        let card = div()
            .id("subagent-dock")
            .debug_selector(|| "subagent-dock".into())
            .role(Role::Region)
            .aria_label("Subagents")
            .relative()
            .h(px(CARD_HEIGHT))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .when(attached, |d| d.rounded_t(px(0.)))
            .when(!attached, |d| d.rounded_t(px(10.)))
            .border_1()
            .border_b_0()
            .border_color(content(0.1))
            .bg(content(0.05))
            .pr(px(8.))
            .pl(px(10.))
            .text_size(px(12.))
            .child(dot)
            .when(width >= LABEL_MIN_WIDTH, |d| {
                d.child(
                    div()
                        .debug_selector(|| "subagent-dock-label".into())
                        .mx(px(4.))
                        .flex_shrink_0()
                        .text_color(content(0.85))
                        .child(label.clone()),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .children(chips)
                    .children(more),
            )
            .when_some(totals, |d, totals| d.child(self.dock_tokens(totals, cx)));
        let value = fold.value(now).clamp(0., 1.);
        let opacity = if open { (value * 1.3).min(1.) } else { value };
        Some(
            div()
                .px(px(8.))
                .text_color(content(0.55))
                .child(
                    div()
                        .h(px(CARD_HEIGHT * value))
                        .overflow_hidden()
                        .opacity(opacity)
                        .child(card),
                )
                .children(self.subagent_peek(&agents, live, cx))
                .into_any_element(),
        )
    }

    fn subagent_chip(
        &self,
        agent: &Subagent,
        live: bool,
        selected: bool,
        now: Instant,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let state = agent.state(live);
        let name = agent.run.display_name();
        let reduced = cx.reduce_motion();
        let (join, mark) = {
            let mut chips = self.subagent_dock.chips.borrow_mut();
            let chip = chips.entry(agent.id.clone()).or_insert(ChipMotion {
                joined: now,
                state,
                settled: None,
            });
            if chip.state != state {
                chip.state = state;
                chip.settled = Some(now);
            }
            let join = (now.saturating_duration_since(chip.joined).as_secs_f32() * 1000. / CHIP_MS)
                .min(1.);
            let mark = chip.settled.map_or(1., |at| {
                (now.saturating_duration_since(at).as_secs_f32() * 1000. / MARK_MS).min(1.)
            });
            if reduced { (1., 1.) } else { (join, mark) }
        };
        if join < 1. || mark < 1. {
            window.request_animation_frame();
        }
        let eased = crate::reveal::bezier(join, 0.22, 1., 0.36, 1.);
        let slot = self
            .subagent_dock
            .slots
            .borrow_mut()
            .entry(agent.id.clone())
            .or_default()
            .clone();
        let group = SharedString::from(format!("subagent-chip-{}", agent.id));
        let toggle = agent.id.clone();
        let hover = agent.id.clone();
        let selector = agent.id.clone();
        div()
            .id(group.clone())
            .debug_selector(move || format!("subagent-chip-{selector}"))
            .role(Role::Button)
            .aria_label(format!("{name}, {}. Open its work", state.label()))
            .aria_selected(selected)
            .group(group.clone())
            .relative()
            .top(px(3. * (1. - eased)))
            .opacity(eased)
            .h(px(24.))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(6.))
            .px(px(6.))
            .cursor_pointer()
            .hover(|s| s.bg(content(0.1)).text_color(content(1.)))
            .when(selected, |d| d.bg(content(0.1)).text_color(content(1.)))
            .child(slot.probe())
            .child(subagent_face(&name, state, 14.))
            .child(
                div()
                    .min_w_0()
                    .max_w(px(208.))
                    .truncate()
                    .text_color(match state {
                        RunState::Failed => failed_color(),
                        RunState::Running => content(0.8),
                        _ => content(0.5),
                    })
                    .group_hover(group, move |s| {
                        if matches!(state, RunState::Failed | RunState::Running) {
                            s
                        } else {
                            s.text_color(content(0.8))
                        }
                    })
                    .child(name),
            )
            // `.subagent-mark`'s ease-out.
            .children(run_mark(
                agent,
                live,
                crate::reveal::bezier(mark, 0., 0., 0.58, 1.),
            ))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.subagent_dock.peek = None;
                this.subagent_dock.peek_wait = None;
                this.toggle_subagent_sheet(&toggle, cx);
            }))
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                let dock = &mut this.subagent_dock;
                dock.peek_wait = None;
                if !*hovered {
                    if dock.peek.take().is_some() {
                        cx.notify();
                    }
                    return;
                }
                let id = hover.clone();
                dock.peek_wait = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(PEEK_DELAY).await;
                    let _ = this.update(cx, |this, cx| {
                        this.subagent_dock.peek = Some(id);
                        this.subagent_dock.peek_wait = None;
                        cx.notify();
                    });
                }));
            }))
            .into_any_element()
    }

    /// A look at the run without opening it: what it is, what it is on, its cost.
    fn subagent_peek(
        &self,
        agents: &[Subagent],
        live: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = self.subagent_dock.peek.as_deref()?;
        let agent = agents.iter().find(|agent| agent.id == id)?;
        let slot = self.subagent_dock.slots.borrow().get(id)?.clone();
        let provider = Kind::parse(&self.summary.provider).unwrap_or(Kind::Codex);
        let kind = agent.kind(provider);
        let usage = agent.run.usage.as_ref();
        let latest = (agent.state(live) == RunState::Running)
            .then(|| agent.latest_tool())
            .flatten();
        let owner = cx.weak_entity();
        Some(
            popover(
                SharedString::from(format!("subagent-peek-{id}")),
                Anchor::Slot(slot),
            )
            .side(Side::Top)
            .align(Align::Start)
            .max_width(352.)
            .allow_outside_press()
            .on_dismiss(move |_, cx| {
                let _ = owner.update(cx, |this, cx| {
                    this.subagent_dock.peek = None;
                    cx.notify();
                });
            })
            .child(
                div()
                    .debug_selector(|| "subagent-peek".into())
                    .px(px(10.))
                    .py(px(8.))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(content(1.))
                            .child(agent.run.display_name()),
                    )
                    .when(!kind.is_empty(), |d| {
                        d.child(
                            div()
                                .truncate()
                                .text_size(px(11.))
                                .line_height(px(16.))
                                .text_color(content(0.5))
                                .child(kind),
                        )
                    })
                    .when_some(latest, |d, latest| {
                        d.child(
                            div()
                                .mt(px(6.))
                                .flex()
                                .gap(px(3.))
                                .text_size(px(11.))
                                .line_height(px(16.))
                                .text_color(content(0.7))
                                .child(div().flex_shrink_0().text_color(content(0.4)).child("Now"))
                                .child(div().min_w_0().truncate().child(latest.to_owned())),
                        )
                    })
                    .when_some(usage, |d, usage| {
                        let context = usage.context_used.map(|used| {
                            match usage.context_window.filter(|window| *window > 0) {
                                Some(window) => format!(
                                    "{}% context",
                                    (used as f64 / window as f64 * 100.).round() as u64
                                ),
                                None => format!("{} in context", format_tokens(used)),
                            }
                        });
                        d.child(
                            div()
                                .mt(px(6.))
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .text_size(px(11.))
                                .line_height(px(16.))
                                .font_features(crate::right_panel::tabular())
                                .text_color(content(0.5))
                                .child(format!("↑{}", format_tokens(usage.uncached)))
                                .child(format!("↓{}", format_tokens(usage.output)))
                                .children(context),
                        )
                    }),
            )
            .into_any_element(),
        )
    }

    /// What the turn's runs have spent between them, beside the chips.
    fn dock_tokens(&self, totals: (u64, u64, u64), cx: &mut Context<Self>) -> AnyElement {
        let (uncached, cached, output) = totals;
        let detail = format!(
            "{} uncached · {} cached · {} output",
            format_tokens(uncached),
            format_tokens(cached),
            format_tokens(output)
        );
        let slot = self.subagent_dock.tokens_slot.clone();
        div()
            .id("subagent-dock-tokens")
            .debug_selector(|| "subagent-dock-tokens".into())
            .role(Role::Image)
            .aria_label(format!("Subagent tokens: {detail}"))
            .relative()
            .ml(px(4.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(11.))
            .line_height(px(16.))
            .font_features(crate::right_panel::tabular())
            .text_color(content(0.45))
            .child(slot.probe())
            .child(format!("↑{}", format_tokens(uncached)))
            .child(format!("↓{}", format_tokens(output)))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.subagent_dock.tokens_hovered = *hovered;
                cx.notify();
            }))
            .when(self.subagent_dock.tokens_hovered, |d| {
                d.child(
                    popover("subagent-dock-tokens-tip", Anchor::Slot(slot.clone()))
                        .side(Side::Top)
                        .align(Align::End)
                        .max_width(420.)
                        .allow_outside_press()
                        .child(
                            div()
                                .px(px(10.))
                                .py(px(6.))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .line_height(px(16.))
                                        .text_color(content(1.))
                                        .child("Subagent tokens"),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .line_height(px(16.))
                                        .text_color(content(0.5))
                                        .child(detail),
                                ),
                        ),
                )
            })
            .into_any_element()
    }
}

/// The accent dot, glowing and breathing while anything works.
fn dock_dot(working: bool) -> AnyElement {
    if !working {
        return div()
            .size(px(6.))
            .flex_shrink_0()
            .rounded_full()
            .bg(content(0.25))
            .into_any_element();
    }
    crate::pulse::looping(
        "subagent-dock-dot",
        Duration::from_millis(2_000),
        crate::pulse::Rate::Low,
        |phase| {
            // Tailwind's animate-pulse: 1 → .5 → 1.
            let breath = 0.75 + 0.25 * (phase * std::f32::consts::TAU).cos();
            let accent = accent_color();
            div()
                .size(px(6.))
                .flex_shrink_0()
                .rounded_full()
                .bg(accent.opacity(breath))
                .shadow(vec![
                    gpui::BoxShadow::new(px(0.), px(0.), accent.opacity(breath))
                        .blur_radius(px(8.)),
                ])
        },
    )
    .into_any_element()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use gpui::{TestAppContext, VisualTestContext};
    use monocode_core::{
        store::Store,
        tool::{
            ToolCall, ToolState,
            tasks::{AgentRun, AgentUsage, Panel},
        },
        transcript::Row,
    };

    pub(in crate::conversation) fn row(role: &str, text: String) -> Row {
        Row {
            role: role.into(),
            text,
            first: true,
            sent_at: None,
        }
    }

    pub(in crate::conversation) fn agent(id: &str, state: ToolState) -> Row {
        let mut call = ToolCall::new(id, "Task");
        call.state = state;
        call.panel = Some(Panel::Agent(Box::new(AgentRun {
            brief: format!("Review {id}"),
            agent_type: Some("general-purpose".into()),
            task_id: Some(format!("task-{id}")),
            started_at: Some(monocode_core::time::now_ms() - 5_000),
            usage: Some(AgentUsage {
                uncached: 1_000,
                cache_read: 2_000,
                output: 500,
                context_used: Some(3_000),
                context_window: Some(200_000),
                ..AgentUsage::default()
            }),
            ..AgentRun::default()
        })));
        row("tool", serde_json::to_string(&call).unwrap())
    }

    pub(in crate::conversation) fn open(
        rows: Vec<Row>,
        busy: bool,
        cx: &mut TestAppContext,
    ) -> gpui::WindowHandle<Conversation> {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let summary = store.create("claude", "/tmp").unwrap();
        cx.update(|cx| {
            input::bind(cx);
            cx.set_reduce_motion(true);
            cx.open_window(Default::default(), |_, cx| {
                cx.new(|cx| {
                    let mut view =
                        Conversation::new(summary, Arc::new(std::sync::Mutex::new(store)), cx);
                    view.loaded = true;
                    view.summary.has_messages = true;
                    view.busy = busy;
                    view.transcript.update(cx, |t, cx| t.patch(0, rows, cx));
                    view
                })
            })
            .unwrap()
        })
    }

    pub(in crate::conversation) fn redraw(visual: &mut VisualTestContext) {
        visual.refresh().unwrap();
        visual.update(|_, _| {});
    }

    #[gpui::test]
    fn the_card_shows_each_run_of_the_working_turn(cx: &mut TestAppContext) {
        let window = open(
            vec![
                row("user", "Go".into()),
                agent("a", ToolState::Running),
                agent("b", ToolState::Completed),
            ],
            true,
            cx,
        );
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        redraw(visual);
        redraw(visual);
        assert!(visual.debug_bounds("subagent-dock").is_some());
        assert!(visual.debug_bounds("subagent-chip-a").is_some());
        assert!(visual.debug_bounds("subagent-chip-b").is_some());
        assert!(visual.debug_bounds("subagent-dock-tokens").is_some());
        assert!(visual.debug_bounds("subagent-more").is_none());
    }

    #[gpui::test]
    fn the_label_shows_in_a_full_width_card_and_gives_way_in_a_narrow_one(cx: &mut TestAppContext) {
        let window = open(
            vec![row("user", "Go".into()), agent("a", ToolState::Running)],
            true,
            cx,
        );
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        visual.simulate_resize(gpui::size(px(1280.), px(800.)));
        redraw(visual);
        redraw(visual);
        assert!(visual.debug_bounds("subagent-dock-label").is_some());
        visual.simulate_resize(gpui::size(px(700.), px(800.)));
        redraw(visual);
        redraw(visual);
        assert!(visual.debug_bounds("subagent-dock-label").is_none());
    }

    #[gpui::test]
    fn an_idle_session_has_no_card(cx: &mut TestAppContext) {
        let window = open(
            vec![row("user", "Go".into()), agent("a", ToolState::Completed)],
            false,
            cx,
        );
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        redraw(visual);
        assert!(visual.debug_bounds("subagent-dock").is_none());
    }

    #[gpui::test]
    fn more_runs_than_fit_fold_into_a_count_keeping_those_still_working(cx: &mut TestAppContext) {
        let window = open(
            vec![
                row("user", "Go".into()),
                agent("a", ToolState::Completed),
                agent("b", ToolState::Running),
                agent("c", ToolState::Running),
                agent("d", ToolState::Running),
            ],
            true,
            cx,
        );
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        redraw(visual);
        redraw(visual);
        assert!(visual.debug_bounds("subagent-more").is_some());
        assert!(visual.debug_bounds("subagent-chip-a").is_none());
        assert!(visual.debug_bounds("subagent-chip-d").is_some());
    }

    #[gpui::test]
    fn a_chip_opens_its_sheet_esc_closes_it_and_another_chip_switches_run(cx: &mut TestAppContext) {
        let window = open(
            vec![
                row("user", "Go".into()),
                agent("a", ToolState::Running),
                agent("b", ToolState::Running),
            ],
            true,
            cx,
        );
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        redraw(visual);
        redraw(visual);
        let chip = visual.debug_bounds("subagent-chip-a").unwrap();
        visual.simulate_click(chip.center(), Default::default());
        redraw(visual);
        redraw(visual);
        assert!(visual.debug_bounds("subagent-sheet").is_some());
        window
            .update(visual, |view, _, _| {
                assert_eq!(view.subagent_sheet_run().as_deref(), Some("a"));
            })
            .unwrap();

        let chip = visual.debug_bounds("subagent-chip-b").unwrap();
        visual.simulate_click(chip.center(), Default::default());
        redraw(visual);
        window
            .update(visual, |view, _, _| {
                assert_eq!(view.subagent_sheet_run().as_deref(), Some("b"));
            })
            .unwrap();

        let chip = visual.debug_bounds("subagent-chip-b").unwrap();
        visual.simulate_click(chip.center(), Default::default());
        redraw(visual);
        redraw(visual);
        assert!(visual.debug_bounds("subagent-sheet").is_none());
    }

    #[gpui::test]
    fn the_card_lingers_with_how_runs_ended_then_folds_away(cx: &mut TestAppContext) {
        let window = open(
            vec![row("user", "Go".into()), agent("a", ToolState::Running)],
            true,
            cx,
        );
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        redraw(visual);
        redraw(visual);
        window
            .update(visual, |view, _, cx| {
                view.busy = false;
                cx.notify();
            })
            .unwrap();
        redraw(visual);
        assert!(visual.debug_bounds("subagent-dock").is_some(), "it lingers");
        visual
            .executor()
            .advance_clock(LINGER + Duration::from_millis(10));
        visual.run_until_parked();
        window
            .update(visual, |view, _, _| {
                // The test clock doesn't move Instant; the turn's end stands in.
                view.subagent_dock.ended_at =
                    Some(Instant::now() - LINGER - Duration::from_millis(10));
            })
            .unwrap();
        redraw(visual);
        redraw(visual);
        assert!(visual.debug_bounds("subagent-dock").is_none());
    }
}
