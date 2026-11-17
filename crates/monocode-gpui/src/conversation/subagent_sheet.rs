//! SubagentSheet.tsx: one delegated run, opened from its chip or its row in
//! the sidebar: who it is, what it costs, how full its window is, and either
//! the conversation it is having or the trail of what it did. It takes the
//! chat's place above the composer, which stays where it was: what is written
//! there while a run is open goes to the main chat with a note to pass it on,
//! since no provider lets the app address a subagent itself.
use super::*;
use crate::{reveal::Tween, shell::live_agents::live_elapsed, transcript::mascot::subagent_face};
use gpui::{Bounds, Corners, Edges, Pixels, Task, point, size};
use monocode_core::{
    context::format_tokens,
    tool::{
        subagent_transcript::SubagentTranscript,
        tasks::{RunState, Subagent},
    },
    transcript::Row,
};
use std::{collections::HashMap, time::Duration};

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

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum SheetView {
    /// The run's own conversation: its brief, what it thought, called and said.
    #[default]
    Chat,
    /// The trail of its steps, as its row in the transcript unfolds it.
    Activity,
}

/// The run's conversation, read again while it is still going.
/// A run's rows in sizes: how many the reader has and their bytes, the
/// stream's own trail, the messages sent from the sheet, the model's name,
/// when the run began and whether it still runs.
type BuiltFrom = (usize, usize, usize, usize, usize, Option<u64>, bool);

struct ContextReader {
    path: String,
    /// False until the first read lands.
    loaded: bool,
    failed: bool,
    rows: Vec<Row>,
    _task: Task<()>,
}

/// A message the user wrote to a run from its sheet. The main chat is what
/// received it; here it is shown where it was written, after the rows the run
/// had by then. It lasts as long as the window: the main chat keeps the record.
struct Sent {
    after: usize,
    row: Row,
}

struct OpenRun {
    id: String,
    /// The run as last seen, kept drawn while the sheet folds.
    agent: Subagent,
    view: SheetView,
    trail: Entity<TranscriptView>,
    trail_source: String,
    /// The conversation as drawn: the run's rows with the user's own among them.
    chat: Entity<TranscriptView>,
    chat_rows: Vec<Row>,
    /// What the chat was last built from, in sizes: the same again means the
    /// same rows, and nothing to copy or compare.
    built_from: Option<BuiltFrom>,
    /// How many of the rows drawn are the run's own.
    own_rows: usize,
    context: Option<ContextReader>,
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
    sent: HashMap<String, Vec<Sent>>,
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

    /// The run a message written now is meant for: its name, and the id its
    /// provider knows it by.
    pub(super) fn subagent_relay_target(&self) -> Option<(String, String)> {
        if !self.subagent_sheet.open {
            return None;
        }
        let run = self.subagent_sheet.run.as_ref()?;
        let agent = &run.agent.run;
        Some((
            agent.display_name(),
            agent.task_id.clone().unwrap_or_else(|| run.id.clone()),
        ))
    }

    /// Show a message written to the open run in its own conversation.
    pub(super) fn note_sent_to_subagent(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(run) = self.subagent_sheet.run.as_ref() else {
            return;
        };
        let sent = self.subagent_sheet.sent.entry(run.id.clone()).or_default();
        sent.push(Sent {
            after: run.own_rows,
            row: Row {
                role: "user".into(),
                text: text.trim().to_owned(),
                first: true,
                sent_at: Some(monocode_core::time::now_ms()),
            },
        });
        cx.notify();
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
        let Some(agent) = self
            .session_subagents(cx)
            .iter()
            .find(|a| a.id == id)
            .cloned()
        else {
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
            let chat = cx.new(|_| chat_view_entity());
            self.subagent_sheet.run = Some(OpenRun {
                id: id.to_owned(),
                agent,
                view,
                trail,
                trail_source: String::new(),
                chat,
                chat_rows: Vec::new(),
                built_from: None,
                own_rows: 0,
                context: None,
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

    /// Whether the open run can still be running. Only a run of the turn in
    /// progress can: one from an earlier turn whose row was saved mid-run
    /// would read as running again each time a new prompt starts.
    fn sheet_run_live(&self, cx: &gpui::App) -> bool {
        self.busy
            && self
                .subagent_sheet
                .run
                .as_ref()
                .is_some_and(|run| self.subagents(cx).iter().any(|agent| agent.id == run.id))
    }

    /// Follows the open run: its trail, the context reader, and the rise or fold.
    pub(super) fn step_subagent_sheet(&mut self, window: &Window, cx: &mut Context<Self>) {
        let now = Instant::now();
        let reduced = cx.reduce_motion();
        let live = self.sheet_run_live(cx);
        // A run the transcript no longer holds has nothing left to show.
        // Every turn's runs are gathered only for an open sheet: with none,
        // each streamed row would copy them all for nothing.
        if self.subagent_sheet.open {
            let runs = self.session_subagents(cx);
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
        let sheet = &mut self.subagent_sheet;
        let Some(run) = sheet.run.as_mut() else {
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
            .filter(|_| can_read && run.view == SheetView::Chat);
        if let Some(path) = path
            && run
                .context
                .as_ref()
                .is_none_or(|context| context.path != path)
        {
            run.context = Some(start_context_reader(path, run.id.clone(), cx));
        }
        // This runs on every frame the sheet is open, and the main chat's
        // stream makes many: a run whose rows are the size they were is not
        // read, copied and compared again.
        let read_rows = run
            .context
            .as_ref()
            .filter(|context| context.loaded && !context.failed && !context.rows.is_empty())
            .map(|context| &context.rows);
        let built_from = (
            read_rows.map_or(0, Vec::len),
            read_rows.map_or(0, |rows| rows.iter().map(|row| row.text.len()).sum()),
            run.agent.source.len(),
            sheet.sent.get(&run.id).map_or(0, Vec::len),
            run.agent.run.model.as_ref().map_or(0, String::len),
            run.agent.run.started_at,
            running,
        );
        if run.built_from == Some(built_from) {
            return;
        }
        run.built_from = Some(built_from);
        // What the provider's transcript has, or failing that what the stream
        // brought of the run, with the user's own messages where they fell.
        let read = run
            .context
            .as_ref()
            .filter(|context| context.loaded && !context.failed && !context.rows.is_empty())
            .map(|context| context.rows.clone());
        let mut rows = read.unwrap_or_else(|| run_rows(&run.agent));
        // The brief opens the run's one turn, so it carries the run's own
        // start, not the moment the sheet was opened.
        let started_at = run.agent.run.started_at;
        if let Some(brief) = rows.first_mut().filter(|row| row.role == "user") {
            brief.sent_at = started_at.or(brief.sent_at);
        }
        run.own_rows = rows.len();
        for (earlier, sent) in sheet.sent.get(&run.id).into_iter().flatten().enumerate() {
            rows.insert((sent.after + earlier).min(rows.len()), sent.row.clone());
        }
        let model = run.agent.run.model.clone().unwrap_or_default();
        let from = rows
            .iter()
            .zip(&run.chat_rows)
            .take_while(|(new, old)| new == old)
            .count();
        // A patch never shortens a view: fewer rows than before start it over.
        let from = if rows.len() < run.chat_rows.len() {
            run.chat = cx.new(|_| chat_view_entity());
            0
        } else {
            from
        };
        let patch = rows[from..].to_vec();
        run.chat_rows = rows;
        run.chat.update(cx, |chat, cx| {
            chat.streaming(running, cx);
            chat.patch(from, patch, cx);
            chat.identity(&provider, &model);
            chat.turn_started_at(started_at);
        });
    }

    pub(super) fn subagent_sheet(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.subagent_sheet.run.as_ref()?;
        let now = Instant::now();
        let live = self.sheet_run_live(cx);
        let progress = self
            .subagent_sheet
            .fold
            .map_or(1., |fold| fold.value(now).clamp(0., 1.));
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
                "subagent-tab-chat",
                "Chat",
                view == SheetView::Chat,
                cx.listener(|this, _, _, cx| this.set_sheet_view(SheetView::Chat, cx)),
            ))
            .child(sheet_tab(
                "subagent-tab-activity",
                "Activity",
                view == SheetView::Activity,
                cx.listener(|this, _, _, cx| this.set_sheet_view(SheetView::Activity, cx)),
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
            SheetView::Chat => chat_view(run, can_read),
            SheetView::Activity => activity_view(run),
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
            .child(
                div()
                    .id("subagent-back-to-parent")
                    .group("subagent-back-to-parent")
                    .debug_selector(|| "subagent-back-to-parent".into())
                    .role(Role::Button)
                    .aria_label("Back to the main chat")
                    .tooltip(sheet_tip("Back to the main chat (Esc)"))
                    .h(px(24.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .rounded(px(6.))
                    .pl(px(4.))
                    .pr(px(8.))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .text_color(content(0.6))
                    .hover(|s| s.bg(content(0.1)).text_color(content(1.)))
                    .child(
                        icon("chevron-left", 14.)
                            .text_color(content(0.6))
                            .group_hover("subagent-back-to-parent", |s| s.text_color(content(1.))),
                    )
                    .child("Main chat")
                    .on_click(cx.listener(|this, _, _, cx| this.close_subagent_sheet(cx))),
            )
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

/// The whole pane above the composer: an open run takes the chat's place, so
/// its conversation has the room the chat had.
fn sheet_bounds(overlay: Bounds<Pixels>, stand: Bounds<Pixels>) -> Bounds<Pixels> {
    Bounds::new(
        overlay.origin,
        size(
            overlay.size.width,
            (stand.top() - overlay.top()).max(px(0.)),
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

/// A view for a run's conversation: narrow as a side question's, with what the
/// run thought and called left open rather than folded behind its reply.
fn chat_view_entity() -> TranscriptView {
    let mut chat = TranscriptView::new();
    chat.side_question();
    chat.unfold_work();
    chat
}

/// The run's conversation when its provider keeps no transcript to read: the
/// brief, the steps the stream brought, and the report it handed back.
fn run_rows(agent: &Subagent) -> Vec<Row> {
    let row = |role: &str, text: &str, sent_at: Option<u64>| Row {
        role: role.into(),
        text: text.to_owned(),
        first: true,
        sent_at,
    };
    let run = &agent.run;
    let mut rows = Vec::new();
    let brief = run
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .unwrap_or(run.brief.trim());
    if !brief.is_empty() {
        rows.push(row("user", brief, run.started_at));
    }
    for step in &run.steps {
        match step.kind.as_str() {
            "thinking" => {
                let thought = if step.text.trim().is_empty() {
                    step.detail.trim()
                } else {
                    step.text.trim()
                };
                if !thought.is_empty() {
                    rows.push(row("reasoning", thought, None));
                }
            }
            "tool" => {
                if let Ok(call) = serde_json::to_string(&step.to_tool_call()) {
                    rows.push(row("tool", &call, None));
                }
            }
            _ => {}
        }
    }
    if let Some(report) = run.response.as_deref().map(str::trim)
        && !report.is_empty()
    {
        rows.push(row("assistant", report, run.ended_at));
    }
    rows
}

/// Everything in the run's window: the brief its parent wrote, then its own
/// conversation, read from the provider's transcript where there is one.
fn chat_view(run: &OpenRun, can_read: bool) -> AnyElement {
    let path = run.agent.run.transcript_path.as_ref();
    let reading = path.is_some()
        && can_read
        && run
            .context
            .as_ref()
            .is_none_or(|context| !context.loaded && !context.failed);
    if run.chat_rows.is_empty() {
        return div()
            .px(px(16.))
            .pt(px(4.))
            .pb(px(16.))
            .child(div().py(px(8.)).child(sheet_note(if reading {
                "Reading the agent's conversation…"
            } else {
                "Waiting for the agent's first step…"
            })))
            .into_any_element();
    }
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .child(
            div().flex_1().min_h_0().child(
                run.chat
                    .clone()
                    .cached(gpui::StyleRefinement::default().size_full()),
            ),
        )
        .child(
            div()
                .flex_shrink_0()
                .border_t_1()
                .border_color(content(0.08))
                .px(px(16.))
                .py(px(8.))
                .child(sheet_note(if path.is_some() && !can_read {
                    "The agent's full conversation stays on the machine it ran on. \
                     What you write below goes to the main chat, which passes it on."
                } else {
                    "What you write below goes to the main chat, which passes it on \
                     to this agent."
                })),
        )
        .into_any_element()
}

fn start_context_reader(
    path: String,
    run_id: String,
    cx: &mut Context<Conversation>,
) -> ContextReader {
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
                    let live = this.sheet_run_live(cx);
                    let Some(run) = this
                        .subagent_sheet
                        .run
                        .as_mut()
                        .filter(|run| run.id == run_id)
                    else {
                        return false;
                    };
                    let running = run.agent.state(live) == RunState::Running;
                    let Some(context) = run.context.as_mut() else {
                        return false;
                    };
                    if failed && !context.loaded {
                        context.failed = !running;
                    }
                    // The sheet draws them on its next step.
                    if !failed && (changed || first) {
                        context.loaded = context.loaded || !rows.is_empty();
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
        rows: Vec::new(),
        _task: task,
    }
}

/// What the main chat is sent when the user writes to a run from its sheet.
/// No provider lets the app address a subagent itself: its parent can, by
/// resuming or messaging the run it started, so the message goes there with
/// whose it is.
pub(super) fn relay(name: &str, id: &str, message: &str) -> String {
    format!(
        "[Message for the subagent \"{name}\" ({id}). The user wrote it while reading that \
         subagent's work: pass it on to that subagent if it can still be reached, and carry it \
         out yourself in its place if it cannot.]\n\n{message}"
    )
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
    fn a_run_opens_on_its_conversation_with_what_was_written_to_it(cx: &mut gpui::TestAppContext) {
        use super::super::subagent_dock::tests::{agent, open, redraw, row};
        use monocode_core::tool::ToolState;
        let window = open(
            vec![
                row("user", "Go".into()),
                agent("old", ToolState::Completed),
                row("assistant", "Done.".into()),
                row("user", "Again".into()),
                agent("a", ToolState::Running),
            ],
            true,
            cx,
        );
        let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
        redraw(visual);
        window
            .update(visual, |view, _, cx| {
                // The card above the composer has the turn's runs; a sheet
                // opens any run the session has had.
                assert_eq!(view.subagents(cx).len(), 1);
                assert_eq!(view.session_subagents(cx).len(), 2);
                view.open_subagent_sheet("old", cx);
                assert_eq!(view.subagent_sheet_run().as_deref(), Some("old"));
                view.open_subagent_sheet("a", cx);
            })
            .unwrap();
        redraw(visual);
        window
            .update(visual, |view, _, cx| {
                let run = view.subagent_sheet.run.as_ref().unwrap();
                assert!(run.view == SheetView::Chat);
                let roles: Vec<_> = run.chat_rows.iter().map(|row| row.role.as_str()).collect();
                assert_eq!(roles, ["user"], "the brief, until the run does something");
                let (name, id) = view.subagent_relay_target().unwrap();
                assert_eq!(id, "task-a", "the id its provider knows it by");
                view.note_sent_to_subagent("  Skip the tests  ", cx);
                view.note_sent_to_subagent("And the docs", cx);
                assert!(relay(&name, &id, "Skip the tests").ends_with("\n\nSkip the tests"));
            })
            .unwrap();
        redraw(visual);
        window
            .update(visual, |view, _, cx| {
                let run = view.subagent_sheet.run.as_ref().unwrap();
                let texts: Vec<_> = run
                    .chat_rows
                    .iter()
                    .skip(1)
                    .map(|row| row.text.as_str())
                    .collect();
                assert_eq!(texts, ["Skip the tests", "And the docs"]);
                // Closed, a message is the main chat's own again.
                view.close_subagent_sheet(cx);
                assert!(view.subagent_relay_target().is_none());
            })
            .unwrap();
    }

    #[test]
    fn a_run_without_a_transcript_reads_as_brief_steps_and_report() {
        use monocode_core::tool::{
            ToolState,
            tasks::{AgentRun, AgentStep},
        };
        let agent = Subagent {
            id: "a".into(),
            run: AgentRun {
                brief: "Audit".into(),
                prompt: Some("Audit the **provider**".into()),
                steps: vec![
                    AgentStep {
                        id: "t".into(),
                        kind: "thinking".into(),
                        text: "Reading first".into(),
                        ..AgentStep::default()
                    },
                    AgentStep {
                        id: "c".into(),
                        kind: "tool".into(),
                        text: "Read acp.rs".into(),
                        state: Some(ToolState::Completed),
                        ..AgentStep::default()
                    },
                ],
                response: Some("All sound.".into()),
                ..AgentRun::default()
            },
            running: false,
            tool_state: ToolState::Completed,
            source: String::new(),
        };
        let rows = run_rows(&agent);
        let roles: Vec<_> = rows.iter().map(|row| row.role.as_str()).collect();
        assert_eq!(roles, ["user", "reasoning", "tool", "assistant"]);
        assert_eq!(
            rows[0].text, "Audit the **provider**",
            "the whole brief, not its label"
        );
        assert_eq!(rows[3].text, "All sound.");
    }

    #[test]
    fn the_sheet_takes_the_pane_above_the_composer() {
        let overlay = Bounds::new(point(px(0.), px(0.)), size(px(1200.), px(900.)));
        let stand = Bounds::new(point(px(100.), px(700.)), size(px(800.), px(200.)));
        let sheet = sheet_bounds(overlay, stand);
        assert_eq!((sheet.left(), sheet.top()), (px(0.), px(0.)));
        assert_eq!(sheet.size.width, px(1200.));
        assert_eq!(
            sheet.bottom(),
            px(700.),
            "it stops where the composer starts"
        );
        let above = Bounds::new(point(px(0.), px(0.)), size(px(1200.), px(100.)));
        assert_eq!(sheet_bounds(overlay, above).size.height, px(0.));
    }

    #[test]
    fn a_message_for_a_run_tells_the_main_chat_whose_it_is() {
        let sent = relay("Audit the provider", "task-7", "Skip the tests");
        assert!(sent.contains("\"Audit the provider\""));
        assert!(sent.contains("task-7"));
        assert!(sent.ends_with("\n\nSkip the tests"));
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
