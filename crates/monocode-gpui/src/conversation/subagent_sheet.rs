//! SubagentSheet.tsx: one delegated run, opened from its chip: who it is, what
//! it costs, how full its window is, and either the trail of what it did or the
//! conversation it is having. It stands on the subagent card, whose chips
//! switch between runs, so the composer stays where it was and the turn can be
//! steered meanwhile.
use super::*;
use crate::{
    markdown::{self, MarkdownRow, Part, Tone},
    markdown_model,
    reveal::Tween,
    shell::live_agents::live_elapsed,
    transcript::mascot::subagent_face,
};
use gpui::{Bounds, Corners, Edges, Pixels, Task, point, size};
use monocode_core::{
    context::format_tokens,
    tool::{
        subagent_transcript::SubagentTranscript,
        tasks::{RunState, Subagent},
    },
    transcript::Row,
};
use std::time::Duration;

const OPEN_MS: f32 = 320.;
const OPEN_EASE: (f32, f32, f32, f32) = (0.22, 1., 0.36, 1.);
const CLOSE_MS: f32 = 200.;
const CLOSE_EASE: (f32, f32, f32, f32) = (0.4, 0., 0.2, 1.);
/// `.subagent-sheet-body`: a run or view switched in arrives with a short lift.
const BODY_MS: f32 = 220.;
const BODY_DELAY_MS: f32 = 60.;
const BODY_RISE: f32 = 6.;
/// How long "Stopping…" waits for the run to end before allowing a retry.
const STOP_RETRY: Duration = Duration::from_millis(8_000);
/// How often an open running run's own conversation is read again.
const CONVERSATION_POLL: Duration = Duration::from_millis(1_500);
const RADIUS: f32 = 10.;
/// The sheet's `px-3.5` inside the composer's column.
const SHEET_INSET: f32 = 14.;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum SheetView {
    #[default]
    Activity,
    Context,
}

/// The run's conversation, read again while it is still going.
struct ContextReader {
    path: String,
    /// False until the first read lands.
    loaded: bool,
    failed: bool,
    view: Entity<TranscriptView>,
    /// Rows last shown, to patch from the first that changed.
    rows: Vec<Row>,
    _task: Task<()>,
}

struct OpenRun {
    id: String,
    /// The run as last seen, kept drawn while the sheet folds.
    agent: Subagent,
    view: SheetView,
    trail: Entity<TranscriptView>,
    trail_source: String,
    context: Option<ContextReader>,
    /// The brief as markdown, parsed once for each text.
    brief: std::cell::RefCell<Option<(String, std::rc::Rc<Vec<MarkdownRow>>)>>,
    shown_at: Instant,
    stopping: Option<Instant>,
    wake: Option<Task<()>>,
}

#[derive(Default)]
pub(super) struct SubagentSheet {
    run: Option<OpenRun>,
    open: bool,
    fold: Option<Tween>,
    overlay: AnchorSlot,
}

impl Conversation {
    pub(crate) fn subagent_sheet_run(&self) -> Option<String> {
        let sheet = &self.subagent_sheet;
        sheet
            .open
            .then(|| sheet.run.as_ref().map(|run| run.id.clone()))
            .flatten()
    }

    pub(super) fn subagent_sheet_open(&self) -> bool {
        self.subagent_sheet.open && self.subagent_sheet.run.is_some()
    }

    pub(crate) fn close_subagent_sheet(&mut self, cx: &mut Context<Self>) {
        if !self.subagent_sheet.open {
            return;
        }
        self.subagent_sheet.open = false;
        self.note_subagents_changed(cx);
        cx.notify();
    }

    /// A session no pane shows has no open sheet, and nothing to fold it in view.
    pub(crate) fn drop_subagent_sheet(&mut self, cx: &mut Context<Self>) {
        if self.subagent_sheet.run.is_none() {
            return;
        }
        self.subagent_sheet = SubagentSheet::default();
        self.note_subagents_changed(cx);
    }

    /// Opens a run, as the sidebar's tree does. A run already open stays.
    pub(crate) fn open_subagent_sheet(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(agent) = self.subagents(cx).iter().find(|a| a.id == id).cloned() else {
            return;
        };
        self.subagent_sheet.open = true;
        if self
            .subagent_sheet
            .run
            .as_ref()
            .is_none_or(|run| run.id != id)
        {
            let view = self
                .subagent_sheet
                .run
                .as_ref()
                .map_or(SheetView::default(), |run| run.view);
            let trail = cx.new(|_| {
                let mut trail = TranscriptView::new();
                trail.agent_trail();
                trail
            });
            self.subagent_sheet.run = Some(OpenRun {
                id: id.to_owned(),
                agent,
                view,
                trail,
                trail_source: String::new(),
                context: None,
                brief: Default::default(),
                shown_at: Instant::now(),
                stopping: None,
                wake: None,
            });
        }
        self.note_subagents_changed(cx);
        cx.notify();
    }

    /// A chip opens its run, or folds it again when it is the one open.
    pub(super) fn toggle_subagent_sheet(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.subagent_sheet_run().as_deref() == Some(id) {
            self.close_subagent_sheet(cx);
        } else {
            self.open_subagent_sheet(id, cx);
        }
    }

    fn can_stop_subagents(&self) -> bool {
        !self.is_remote() && Kind::parse(&self.summary.provider) == Some(Kind::Claude)
    }

    fn stop_subagent(&mut self, cx: &mut Context<Self>) {
        let Some(run) = self.subagent_sheet.run.as_mut() else {
            return;
        };
        let Some(controls) = &self.controls else {
            return;
        };
        let _ = controls.send(Control {
            id: run.id.clone(),
            decision: Decision::StopAgent,
        });
        run.stopping = Some(Instant::now());
        // A stop the provider never acts on gives the button back after a while.
        run.wake = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(STOP_RETRY).await;
            let _ = this.update(cx, |this, cx| {
                if let Some(run) = this.subagent_sheet.run.as_mut() {
                    run.stopping = None;
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn set_sheet_view(&mut self, view: SheetView, cx: &mut Context<Self>) {
        if let Some(run) = self.subagent_sheet.run.as_mut()
            && run.view != view
        {
            run.view = view;
            run.shown_at = Instant::now();
        }
        cx.notify();
    }

    /// Follows the open run: its trail, the context reader, and the rise or fold.
    pub(super) fn step_subagent_sheet(&mut self, window: &Window, cx: &mut Context<Self>) {
        let now = Instant::now();
        let reduced = cx.reduce_motion();
        let live = self.busy;
        let runs = self.subagents(cx);
        // A run of an earlier turn is no longer on the card to stand on.
        if self.subagent_sheet.open {
            let found = self
                .subagent_sheet
                .run
                .as_ref()
                .and_then(|run| runs.iter().find(|agent| agent.id == run.id));
            match (found.cloned(), self.subagent_sheet.run.as_mut()) {
                (Some(agent), Some(run)) => run.agent = agent,
                _ => self.subagent_sheet.open = false,
            }
        }
        let open = self.subagent_sheet.open;
        let fold = self
            .subagent_sheet
            .fold
            .unwrap_or_else(|| Tween::settled(0., now))
            .toward(
                if open && self.subagent_sheet.run.is_some() {
                    1.
                } else {
                    0.
                },
                if open { OPEN_MS } else { CLOSE_MS },
                if open { OPEN_EASE } else { CLOSE_EASE },
                reduced,
                now,
            );
        self.subagent_sheet.fold = Some(fold);
        if !fold.done(now) {
            window.request_animation_frame();
        } else if !open && fold.to <= 0. {
            self.subagent_sheet.run = None;
            self.subagent_sheet.fold = None;
            return;
        }
        let can_read = !self.is_remote();
        let provider = self.summary.provider.clone();
        let Some(run) = self.subagent_sheet.run.as_mut() else {
            return;
        };
        let running = run.agent.state(live) == RunState::Running;
        if run.agent.state(live) != RunState::Running {
            run.stopping = None;
        }
        // The trail is one tool row, updated in place as the stream brings steps.
        if run.trail_source != run.agent.source {
            run.trail_source = run.agent.source.clone();
            let row = Row {
                role: "tool".into(),
                text: run.agent.source.clone(),
                first: true,
                sent_at: None,
            };
            run.trail.update(cx, |trail, cx| {
                trail.streaming(running, cx);
                trail.patch(0, vec![row], cx);
            });
        } else {
            run.trail
                .update(cx, |trail, cx| trail.streaming(running, cx));
        }
        // The conversation is only read once it is asked for.
        let path = run
            .agent
            .run
            .transcript_path
            .clone()
            .filter(|_| can_read && run.view == SheetView::Context);
        if let Some(path) = path
            && run
                .context
                .as_ref()
                .is_none_or(|context| context.path != path)
        {
            run.context = Some(start_context_reader(path, run.id.clone(), provider, cx));
        }
    }

    pub(super) fn subagent_sheet(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.subagent_sheet.run.as_ref()?;
        let now = Instant::now();
        let live = self.busy;
        let progress = self
            .subagent_sheet
            .fold
            .map_or(1., |fold| fold.value(now).clamp(0., 1.));
        let open = self.subagent_sheet.open;
        let overlay_slot = self.subagent_sheet.overlay.clone();
        let content_root = self.subagent_sheet_content(live, now, window, cx);
        let probe = overlay_slot.layout_probe();
        let (overlay, stand) = (overlay_slot.get(), self.composer_anchor.get());
        let mut root = div().absolute().inset_0().child(probe);
        let geometry = overlay
            .zip(stand)
            .map(|(overlay, stand)| sheet_bounds(overlay, stand));
        match (overlay, geometry) {
            (Some(overlay), Some(sheet)) => {
                // The pane above the composer: pressing it folds the sheet away.
                let backdrop = sheet.bottom() - overlay.top();
                root = root.when(open, |d| {
                    d.child(
                        div()
                            .id("subagent-sheet-backdrop")
                            .absolute()
                            .top_0()
                            .left_0()
                            .right_0()
                            .h(backdrop)
                            .occlude()
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|this, _, _, cx| this.close_subagent_sheet(cx)),
                            ),
                    )
                });
                // Rises out of the card below it and sinks back in: only the
                // clip's top edge moves, so nothing slides inside the sheet.
                let height = sheet.size.height * progress;
                let clip = Bounds::new(
                    point(sheet.left(), sheet.bottom() - height),
                    size(sheet.size.width, height),
                );
                let opacity = if progress >= 1. {
                    1.
                } else {
                    0.4 + 0.6 * progress
                };
                let at = clip.origin - overlay.origin;
                root = root
                    .child(
                        div().absolute().inset_0().opacity(opacity).child(
                            canvas(
                                |_, _, _| {},
                                move |_, _, window, _| paint_sheet_glass(clip, window),
                            )
                            .size_full(),
                        ),
                    )
                    .child(
                        div()
                            .absolute()
                            .left(at.x)
                            .top(at.y)
                            .w(clip.size.width)
                            .h(clip.size.height)
                            .overflow_hidden()
                            .opacity(opacity)
                            .occlude()
                            .child(
                                div()
                                    .absolute()
                                    .left_0()
                                    .bottom_0()
                                    .w(sheet.size.width)
                                    .h(sheet.size.height)
                                    .child(content_root),
                            ),
                    );
            }
            // The first frame, before the overlay has been measured.
            _ => {
                window.request_animation_frame();
            }
        }
        Some(root.into_any_element())
    }

    fn subagent_sheet_content(
        &mut self,
        live: bool,
        now: Instant,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let can_stop = self.can_stop_subagents() && self.controls.is_some();
        let provider = Kind::parse(&self.summary.provider).unwrap_or(Kind::Codex);
        let can_read = !self.is_remote();
        let Some(run) = self.subagent_sheet.run.as_ref() else {
            return div().into_any_element();
        };
        let agent = run.agent.clone();
        let state = agent.state(live);
        let view = run.view;
        let stopping = run
            .stopping
            .is_some_and(|at| now.saturating_duration_since(at) < STOP_RETRY);
        let header = self.sheet_header(&agent, state, provider, can_stop, stopping, cx);
        let tabs = div()
            .id("subagent-tabs")
            .role(Role::TabList)
            .aria_label("Subagent views")
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .px(px(16.))
            .pt(px(10.))
            .pb(px(4.))
            .child(sheet_tab(
                "subagent-tab-activity",
                "Activity",
                view == SheetView::Activity,
                cx.listener(|this, _, _, cx| this.set_sheet_view(SheetView::Activity, cx)),
            ))
            .child(sheet_tab(
                "subagent-tab-context",
                "Context",
                view == SheetView::Context,
                cx.listener(|this, _, _, cx| this.set_sheet_view(SheetView::Context, cx)),
            ));
        let body_t = ((now.saturating_duration_since(run.shown_at).as_secs_f32() * 1000.
            - BODY_DELAY_MS)
            / BODY_MS)
            .clamp(0., 1.);
        let body_t = if cx.reduce_motion() { 1. } else { body_t };
        if body_t < 1. {
            window.request_animation_frame();
        }
        let eased = crate::reveal::bezier(body_t, 0.22, 1., 0.36, 1.);
        let body = match view {
            SheetView::Activity => activity_view(run),
            SheetView::Context => context_view(run, can_read),
        };
        div()
            .id("subagent-sheet")
            .debug_selector(|| "subagent-sheet".into())
            .role(Role::Dialog)
            .aria_label(format!("Subagent: {}", agent.run.display_name()))
            .size_full()
            .flex()
            .flex_col()
            .text_size(px(14.))
            .text_color(content(1.))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(header)
            .child(sheet_stats(&agent))
            .child(tabs)
            .child(
                div()
                    .relative()
                    .top(px(BODY_RISE * (1. - eased)))
                    .opacity(eased)
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .child(body),
            )
            .into_any_element()
    }

    fn sheet_header(
        &self,
        agent: &Subagent,
        state: RunState,
        provider: Kind,
        can_stop: bool,
        stopping: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let name = agent.run.display_name();
        let tools = agent
            .run
            .usage
            .as_ref()
            .and_then(|usage| usage.tool_uses)
            .or_else(|| {
                let count = agent
                    .run
                    .steps
                    .iter()
                    .filter(|step| step.kind == "tool")
                    .count();
                (count > 0).then_some(count as u64)
            });
        let kind = agent.kind(provider);
        let meta_agent = agent.clone();
        let meta = crate::pulse::looping(
            SharedString::from(format!("subagent-sheet-meta-{}", agent.id)),
            Duration::from_millis(1_000),
            crate::pulse::Rate::Low,
            move |_| {
                let elapsed = meta_agent
                    .elapsed_ms(monocode_core::time::now_ms(), state == RunState::Running);
                let meta = [
                    (!kind.is_empty()).then(|| kind.clone()),
                    Some(status_phrase(state, elapsed)),
                    tools.filter(|tools| *tools > 0).map(|tools| {
                        format!(
                            "{tools} {}",
                            if tools == 1 {
                                "tool call"
                            } else {
                                "tool calls"
                            }
                        )
                    }),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
                div()
                    .truncate()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .font_features(crate::right_panel::tabular())
                    .text_color(content(0.45))
                    .child(meta)
            },
        );
        div()
            .flex_shrink_0()
            .flex()
            .items_start()
            .gap(px(10.))
            .border_b_1()
            .border_color(content(0.08))
            .px(px(16.))
            .pt(px(14.))
            .pb(px(12.))
            .child(div().mt(px(2.)).child(subagent_face(&name, state, 16.)))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(14.))
                            .line_height(px(20.))
                            .text_color(if state == RunState::Failed {
                                super::subagent_dock::failed_color()
                            } else {
                                content(1.)
                            })
                            .child(name),
                    )
                    .child(meta),
            )
            // Stopping goes by the run's task. A run without one of its own,
            // like an agent a workflow started, can't be stopped by itself.
            .when(
                can_stop && agent.can_stop(true) && state == RunState::Running,
                |d| {
                    d.child(
                        div()
                            .id("subagent-stop")
                            .group("subagent-stop")
                            .debug_selector(|| "subagent-stop".into())
                            .role(Role::Button)
                            .aria_label("Stop this agent; the rest of the turn keeps going")
                            .tooltip(sheet_tip(
                                "Stop this agent; the rest of the turn keeps going",
                            ))
                            .h(px(24.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded(px(6.))
                            .px(px(6.))
                            .text_size(px(12.))
                            .text_color(content(0.6))
                            .when(stopping, |d| d.opacity(0.5))
                            .when(!stopping, |d| {
                                d.cursor_pointer()
                                    .hover(|s| s.bg(content(0.1)).text_color(content(1.)))
                                    .on_click(cx.listener(|this, _, _, cx| this.stop_subagent(cx)))
                            })
                            .child(
                                div()
                                    .size(px(8.))
                                    .rounded(px(1.))
                                    .bg(content(0.6))
                                    .when(!stopping, |d| {
                                        d.group_hover("subagent-stop", |s| s.bg(content(1.)))
                                    }),
                            )
                            .child(if stopping { "Stopping…" } else { "Stop" }),
                    )
                },
            )
            .child(
                div()
                    .id("subagent-sheet-close")
                    .group("subagent-sheet-close")
                    .debug_selector(|| "subagent-sheet-close".into())
                    .role(Role::Button)
                    .aria_label("Close")
                    .tooltip(sheet_tip("Close (Esc)"))
                    .size(px(24.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_color(content(0.45))
                    .hover(|s| s.bg(content(0.1)).text_color(content(1.)))
                    .child(
                        icon("x", 14.)
                            .text_color(content(0.45))
                            .group_hover("subagent-sheet-close", |s| s.text_color(content(1.))),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.close_subagent_sheet(cx))),
            )
            .into_any_element()
    }
}

/// `.subagent-sheet`: `top: clamp(2.5rem, 16%, 11rem)`, standing on the card.
/// Its `px-3.5` makes it a little narrower than the card's `px-2`.
fn sheet_bounds(overlay: Bounds<Pixels>, stand: Bounds<Pixels>) -> Bounds<Pixels> {
    let bottom = stand.top();
    let height = f32::from(bottom - overlay.top()).max(0.);
    let top = overlay.top() + px((height * 0.16).clamp(40., 176.));
    Bounds::new(
        point(stand.left() + px(SHEET_INSET), top),
        size(
            stand.size.width - px(2. * SHEET_INSET),
            (bottom - top).max(px(0.)),
        ),
    )
}

/// `.subagent-sheet-glass`: glass, a 10% rule on three sides, squared at the base.
fn paint_sheet_glass(clip: Bounds<Pixels>, window: &mut Window) {
    let corners = Corners {
        top_left: px(RADIUS),
        top_right: px(RADIUS),
        bottom_right: px(0.),
        bottom_left: px(0.),
    };
    window.paint_drop_shadows(clip, corners, &crate::popover::shadow());
    crate::popover::paint_glass(clip, corners, crate::popover::glass_tint(), window);
    window.paint_quad(
        gpui::fill(clip, gpui::transparent_black())
            .corner_radii(corners)
            .border_widths(Edges {
                top: px(1.),
                right: px(1.),
                bottom: px(0.),
                left: px(1.),
            })
            .border_color(content(0.1)),
    );
}

fn sheet_tab(
    id: &'static str,
    label: &'static str,
    selected: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .role(Role::Tab)
        .aria_label(label)
        .aria_selected(selected)
        .h(px(28.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .px(px(10.))
        .text_size(px(12.))
        .cursor_pointer()
        .when(selected, |d| d.bg(content(0.1)).text_color(content(1.)))
        .when(!selected, |d| {
            d.text_color(content(0.5))
                .hover(|s| s.bg(content(0.05)).text_color(content(0.8)))
        })
        .child(label)
        .on_click(on_click)
}

/// Tokens in, tokens out, what the cache served, and how full the window is.
fn sheet_stats(agent: &Subagent) -> AnyElement {
    let Some(usage) = agent.run.usage.as_ref() else {
        return div()
            .flex_shrink_0()
            .border_b_1()
            .border_color(content(0.08))
            .px(px(16.))
            .py(px(10.))
            .text_size(px(12.))
            .text_color(content(0.4))
            .child("No token counts from this agent yet.")
            .into_any_element();
    };
    let provider_window = usage.context_window;
    let ratio = usage
        .context_used
        .zip(provider_window.filter(|window| *window > 0))
        .map(|(used, window)| (used as f32 / window as f32).clamp(0., 1.));
    let context = match usage.context_used {
        Some(used) => div()
            .flex()
            .items_center()
            .gap(px(6.))
            .children(ratio.map(crate::context_meter::ring))
            .child(
                div()
                    .flex()
                    .gap(px(3.))
                    .child(format_tokens(used))
                    .when_some(provider_window, |d, window| {
                        d.child(
                            div()
                                .text_color(content(0.4))
                                .child(format!("/ {}", format_tokens(window))),
                        )
                    }),
            )
            .into_any_element(),
        None => div().text_color(content(0.4)).child("–").into_any_element(),
    };
    div()
        .flex_shrink_0()
        .flex()
        .gap(px(12.))
        .border_b_1()
        .border_color(content(0.08))
        .px(px(16.))
        .py(px(10.))
        .child(sheet_stat(
            "Input",
            Some("Prompt tokens not read from the cache"),
            format!("↑ {}", format_tokens(usage.uncached)).into_any_element(),
        ))
        .child(sheet_stat(
            "Output",
            None,
            format!("↓ {}", format_tokens(usage.output)).into_any_element(),
        ))
        .child(sheet_stat(
            "Cached",
            Some("Prompt tokens served from the cache"),
            format_tokens(usage.cache_read).into_any_element(),
        ))
        .child(sheet_stat(
            "Context",
            Some("Tokens in the agent's window now"),
            context,
        ))
        .into_any_element()
}

fn sheet_tip(text: &'static str) -> impl Fn(&mut Window, &mut gpui::App) -> gpui::AnyView {
    move |_, cx| {
        cx.new(|_| crate::transcript::tasks::AgentBrief(text.to_owned()))
            .into()
    }
}

fn sheet_stat(
    label: &'static str,
    title: Option<&'static str>,
    value: AnyElement,
) -> impl IntoElement {
    div()
        .id(label)
        .flex_1()
        .min_w_0()
        .when_some(title, |d, title| d.tooltip(sheet_tip(title)))
        .child(
            div()
                .text_size(px(11.))
                .line_height(px(16.))
                .text_color(content(0.4))
                .child(label),
        )
        .child(
            div()
                .truncate()
                .text_size(px(13.))
                .line_height(px(20.))
                .font_features(crate::right_panel::tabular())
                .text_color(content(0.85))
                .child(value),
        )
}

fn sheet_note(text: &'static str) -> impl IntoElement {
    div()
        .text_size(px(12.))
        .text_color(content(0.4))
        .child(text)
}

/// The run's trail, kept at its newest step while it works unless the reader
/// has scrolled back to look at something earlier.
fn activity_view(run: &OpenRun) -> AnyElement {
    let empty = run.agent.run.steps.is_empty()
        && run.agent.tool_state == monocode_core::tool::ToolState::Running;
    if empty {
        return div()
            .px(px(16.))
            .pt(px(4.))
            .pb(px(16.))
            .child(
                div()
                    .py(px(8.))
                    .child(sheet_note("Waiting for the agent's first step…")),
            )
            .into_any_element();
    }
    div()
        .flex_1()
        .min_h_0()
        .child(
            run.trail
                .clone()
                .cached(gpui::StyleRefinement::default().size_full()),
        )
        .into_any_element()
}

/// Everything in the run's window: the brief its parent wrote, then its own
/// conversation, read from the provider's transcript. Without a readable
/// transcript the brief is what there is.
fn context_view(run: &OpenRun, can_read: bool) -> AnyElement {
    if let Some(context) = run
        .context
        .as_ref()
        .filter(|context| context.loaded && !context.failed)
    {
        return div()
            .flex_1()
            .min_h_0()
            .child(
                context
                    .view
                    .clone()
                    .cached(gpui::StyleRefinement::default().size_full()),
            )
            .into_any_element();
    }
    let path = run.agent.run.transcript_path.as_ref();
    let reading =
        path.is_some() && can_read && run.context.as_ref().is_none_or(|context| !context.failed);
    let prompt = run
        .agent
        .run
        .prompt
        .clone()
        .filter(|prompt| !prompt.trim().is_empty())
        .or_else(|| Some(run.agent.run.brief.clone()).filter(|brief| !brief.trim().is_empty()));
    div()
        .id("subagent-brief")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px(px(16.))
        .pt(px(4.))
        .pb(px(16.))
        .when_some(prompt, |d, prompt| {
            d.child(
                div()
                    .pb(px(4.))
                    .text_size(px(11.))
                    .text_color(content(0.4))
                    .child("Brief"),
            )
            .child(
                div()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(content(0.08))
                    .bg(content(0.03))
                    .px(px(12.))
                    .py(px(8.))
                    .child(brief_markdown(run, prompt)),
            )
        })
        .child(div().pt(px(12.)).child(sheet_note(if reading {
            "Reading the agent's conversation…"
        } else if path.is_some() && !can_read {
            "The agent's full conversation stays on the machine it ran on."
        } else {
            "This agent's provider doesn't share its full conversation."
        })))
        .into_any_element()
}

/// AgentMarkdown: the brief as the parent wrote it, lists and code included.
fn brief_markdown(run: &OpenRun, text: String) -> AnyElement {
    let rows = {
        let mut brief = run.brief.borrow_mut();
        match brief.as_ref() {
            Some((parsed, rows)) if *parsed == text => rows.clone(),
            _ => {
                let rows: std::rc::Rc<Vec<MarkdownRow>> = std::rc::Rc::new(
                    markdown_model::parse_full(&text)
                        .blocks
                        .iter()
                        .flat_map(|block| markdown::rows(&block.block))
                        .collect(),
                );
                *brief = Some((text, rows.clone()));
                rows
            }
        }
    };
    let now = Instant::now();
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .children(rows.iter().enumerate().map(|(at, row)| {
            let id: SharedString = format!("subagent-brief-row-{at}").into();
            let body = match &row.part {
                Part::Code { fence, lines } => div()
                    .id(id.clone())
                    .overflow_x_scroll()
                    .rounded_lg()
                    .border_1()
                    .border_color(content(0.1))
                    .bg(content(0.03))
                    .py_2()
                    .child(markdown::code_lines(fence, lines.clone(), None, "", false))
                    .into_any_element(),
                _ => markdown::body(row, id, Tone::Normal, None, now),
            };
            div()
                .pt(px(if at == 0 { 0. } else { row.gap }))
                .flex()
                .min_w_0()
                .gap_2()
                // The box already insets it, so a top-level list starts there.
                .pl(px(row.indent.saturating_sub(1) as f32 * 16.))
                .when(row.quote > 0, |d| {
                    d.border_l_2().border_color(content(0.15)).pl_3()
                })
                .when_some(row.marker.clone(), |d, marker| {
                    d.child(
                        div()
                            .w_4()
                            .flex_shrink_0()
                            .text_color(content(0.7))
                            .text_size(px(14.))
                            .line_height(px(24.))
                            .child(marker),
                    )
                })
                .child(div().min_w_0().flex_1().child(body))
        }))
        .into_any_element()
}

fn start_context_reader(
    path: String,
    run_id: String,
    provider: String,
    cx: &mut Context<Conversation>,
) -> ContextReader {
    let view = cx.new(|_| {
        let mut view = TranscriptView::new();
        view.side_question();
        view
    });
    let reader_path = path.clone();
    let task = cx.spawn(async move |this, cx| {
        let mut reader = SubagentTranscript::conversation(reader_path);
        let mut first = true;
        loop {
            let (back, read, rows) = cx
                .background_spawn(async move {
                    let read = reader.read();
                    let rows = reader.rows();
                    (reader, read, rows)
                })
                .await;
            reader = back;
            let failed = read.is_err();
            let changed = read.unwrap_or(false);
            let keep_going = this
                .update(cx, |this, cx| {
                    let live = this.busy;
                    let Some(run) = this
                        .subagent_sheet
                        .run
                        .as_mut()
                        .filter(|run| run.id == run_id)
                    else {
                        return false;
                    };
                    let running = run.agent.state(live) == RunState::Running;
                    let started_at = run.agent.run.started_at;
                    let model = run.agent.run.model.clone().unwrap_or_default();
                    let provider = provider.clone();
                    let Some(context) = run.context.as_mut() else {
                        return false;
                    };
                    if failed && !context.loaded {
                        context.failed = !running;
                    }
                    if !failed && (changed || first) {
                        let mut rows = rows;
                        // The brief opens the run's one turn, so it carries the
                        // run's own start, not the moment the sheet was opened.
                        if let Some(brief) = rows.first_mut().filter(|row| row.role == "user") {
                            brief.sent_at = started_at.or(brief.sent_at);
                        }
                        let from = rows
                            .iter()
                            .zip(&context.rows)
                            .take_while(|(new, old)| new == old)
                            .count();
                        context.loaded = context.loaded || !rows.is_empty();
                        if from < rows.len() {
                            let patch = rows[from..].to_vec();
                            context.view.update(cx, |view, cx| {
                                view.streaming(running, cx);
                                view.patch(from, patch, cx);
                                view.identity(&provider, &model);
                                view.turn_started_at(started_at);
                            });
                        } else {
                            context.view.update(cx, |view, cx| {
                                view.streaming(running, cx);
                                view.turn_started_at(started_at);
                            });
                        }
                        context.rows = rows;
                    }
                    cx.notify();
                    running || (failed && !context.failed)
                })
                .unwrap_or(false);
            first = false;
            if !keep_going {
                return;
            }
            cx.background_executor().timer(CONVERSATION_POLL).await;
        }
    });
    ContextReader {
        path,
        loaded: false,
        failed: false,
        view,
        rows: Vec::new(),
        _task: task,
    }
}

fn status_phrase(state: RunState, elapsed: Option<u64>) -> String {
    let time = elapsed.map(live_elapsed);
    let (word, joined) = match state {
        RunState::Running => ("Working", "Working"),
        RunState::Failed => ("Failed", "Failed after"),
        RunState::Stopped => ("Stopped", "Stopped after"),
        RunState::Done => ("Finished", "Finished in"),
    };
    time.map_or_else(|| word.to_owned(), |time| format!("{joined} {time}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    fn a_brief_without_a_transcript_reads_as_markdown(cx: &mut gpui::TestAppContext) {
        use super::super::subagent_dock::tests::{agent, open, redraw, row};
        use monocode_core::tool::ToolState;
        let window = open(
            vec![row("user", "Go".into()), agent("a", ToolState::Running)],
            true,
            cx,
        );
        let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
        redraw(visual);
        window
            .update(visual, |view, _, cx| {
                view.open_subagent_sheet("a", cx);
                view.set_sheet_view(SheetView::Context, cx);
                let run = view.subagent_sheet.run.as_mut().unwrap();
                run.agent.run.prompt = Some("Then **report**:\n\n- what ran\n- how long".into());
                let rows = {
                    let prompt = run.agent.run.prompt.clone().unwrap();
                    let _ = brief_markdown(run, prompt);
                    run.brief.borrow().as_ref().unwrap().1.clone()
                };
                assert_eq!(rows.len(), 3, "a paragraph and two list items");
                assert_eq!(rows.iter().filter(|row| row.marker.is_some()).count(), 2);
            })
            .unwrap();
    }

    #[test]
    fn the_sheet_stands_on_the_card_as_tall_as_a_side_question() {
        let overlay = Bounds::new(point(px(0.), px(0.)), size(px(1200.), px(900.)));
        let stand = Bounds::new(point(px(100.), px(700.)), size(px(800.), px(200.)));
        let sheet = sheet_bounds(overlay, stand);
        assert_eq!(sheet.left(), px(114.));
        assert_eq!(sheet.size.width, px(772.));
        assert_eq!(sheet.bottom(), px(700.));
        assert_eq!(sheet.top(), px(112.), "16% of the pane above the composer");
        let short = Bounds::new(point(px(0.), px(0.)), size(px(1200.), px(300.)));
        let stand = Bounds::new(point(px(100.), px(200.)), size(px(800.), px(100.)));
        assert_eq!(sheet_bounds(short, stand).top(), px(40.), "clamped");
    }

    #[test]
    fn status_reads_as_where_the_run_stands() {
        assert_eq!(status_phrase(RunState::Running, Some(5_000)), "Working 5s");
        assert_eq!(status_phrase(RunState::Running, None), "Working");
        assert_eq!(
            status_phrase(RunState::Done, Some(65_000)),
            "Finished in 1m 5s"
        );
        assert_eq!(
            status_phrase(RunState::Failed, Some(2_000)),
            "Failed after 2s"
        );
        assert_eq!(status_phrase(RunState::Stopped, None), "Stopped");
    }
}
