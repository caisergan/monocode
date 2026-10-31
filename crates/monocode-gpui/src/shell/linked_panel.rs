//! LinkedWorkItemPanel.tsx: a GitHub issue or pull request in a sheet beside
//! the chat. The Changes panel's pull requests open one for the project; a
//! session's linked-work badge or activity card opens one for that session,
//! shown while the session is. The sheet takes its width up front and slides
//! in on its own, so the chat reflows once instead of on every frame.
use super::*;
use crate::inbox::{self, Inbox};
use gpui::{Animation, AnimationExt, EntityId};
use monocode_core::{inbox::Item, session_groups::WorkItem};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) const MIN_WIDTH: f32 = 360.;
pub(super) const DEFAULT_WIDTH: f32 = 520.;
/// LinkedWorkItemPanel's `max-[950px]`: narrower windows float the sheet.
const OVERLAY_BELOW: f32 = 950.;
const SLIDE: Duration = Duration::from_millis(260);
const REVEAL_DELAY: f32 = 90.;
const REVEAL: f32 = 240.;

/// cubic-bezier(0.22, 1, 0.36, 1), the sheet's slide and reveal curve.
fn ease_out_quint(t: f32) -> f32 {
    1. - (1. - t).powi(5)
}

#[derive(Default)]
pub(super) struct LinkedPanels {
    /// The Changes panel's pull request, shown over any session's panel.
    project: Option<Entity<Inbox>>,
    /// Each session's linked issue or PR, shown while that session is.
    sessions: HashMap<i64, Entity<Inbox>>,
    /// The width the user dragged to, kept for this run like the original.
    width: Option<f32>,
    resize: Option<(Pixels, f32)>,
    /// A sheet sliding in, and a sheet whose contents fade in, by panel.
    slide: Option<(EntityId, u64)>,
    reveal: Option<(EntityId, u64)>,
    motion: u64,
    /// What each panel last showed, so new contents reveal once.
    shown: HashMap<EntityId, (String, bool)>,
    subscriptions: HashMap<EntityId, Vec<Subscription>>,
}

impl Shell {
    /// GitPullRequests' row click: the project's pull request beside the chat.
    pub(super) fn open_project_pull_request(
        &mut self,
        item: Item,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.reveal_main_area(window, cx);
        match self.linked.project.clone() {
            Some(panel) => panel.update(cx, |panel, cx| panel.set_linked_item(item, cx)),
            None => {
                let cwd = PathBuf::from(&item.project_path);
                let panel = self.new_linked_panel(cwd, item, window, cx);
                self.linked.project = Some(panel);
            }
        }
        cx.notify();
    }

    /// onOpenLinkedWorkItem: a session's linked issue or PR, opening the
    /// session too. Remote projects have no local `gh`, so they go to GitHub.
    pub(super) fn open_linked_work_item(
        &mut self,
        session: i64,
        work: WorkItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let cwd = self
            .sessions
            .get(&session)
            .map(|view| view.read(cx).summary.cwd.clone())
            .or_else(|| self.session_summaries.get(&session).map(|s| s.cwd.clone()))
            .unwrap_or_else(|| self.workspace.project.clone());
        if monocode_core::files::remote::is_remote(Path::new(&cwd)) {
            cx.open_url(&work.url);
            return;
        }
        let item = Item {
            provider: "github".into(),
            kind: work.kind.clone(),
            repo: work.repo.clone(),
            number: work.number as i64,
            url: work.url.clone(),
            project_path: cwd.clone(),
            ..Default::default()
        };
        self.close_project_panel(cx);
        self.reveal_main_area(window, cx);
        self.open(session, window, cx);
        let live: HashSet<i64> = self
            .sessions
            .keys()
            .chain(self.session_summaries.keys())
            .copied()
            .collect();
        let gone: Vec<i64> = self
            .linked
            .sessions
            .keys()
            .filter(|id| !live.contains(id))
            .copied()
            .collect();
        for id in gone {
            if let Some(panel) = self.linked.sessions.remove(&id) {
                self.forget_linked_panel(&panel);
            }
        }
        match self.linked.sessions.get(&session).cloned() {
            Some(panel) => panel.update(cx, |panel, cx| panel.set_linked_item(item, cx)),
            None => {
                let panel = self.new_linked_panel(PathBuf::from(cwd), item, window, cx);
                self.linked.sessions.insert(session, panel);
            }
        }
        cx.notify();
    }

    /// The newest link a session carries, or the one a menu row names.
    pub(super) fn open_session_work_item(
        &mut self,
        session: i64,
        url: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(item) = self
            .sessions
            .get(&session)
            .map(|view| view.read(cx).summary.work_item.clone())
            .or_else(|| {
                self.session_summaries
                    .get(&session)
                    .map(|s| s.work_item.clone())
            })
            .flatten()
        else {
            return;
        };
        let link = match url {
            Some(url) => item.links().into_iter().find(|link| link.url == url),
            None => item.links().into_iter().next(),
        };
        if let Some(link) = link {
            self.open_linked_work_item(session, link, window, cx);
        }
    }

    /// The panel goes beside a chat or Mono, so app views and settings close.
    fn reveal_main_area(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings.is_some() {
            self.close_settings(window, cx);
        }
        if self.app_search.is_some() {
            self.close_search_tab(window, cx);
        }
        if self.active_app_view.is_some() {
            self.close_app_view(window, cx);
        }
    }

    fn new_linked_panel(
        &mut self,
        cwd: PathBuf,
        item: Item,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<Inbox> {
        let store = self.store.clone();
        let panel = cx.new(|cx| Inbox::linked(store, cwd, item, cx));
        let id = panel.entity_id();
        let events = cx.subscribe_in(
            &panel,
            window,
            move |this, panel, event: &inbox::Event, window, cx| match event {
                inbox::Event::Close => this.close_linked_panel_entity(panel, cx),
                inbox::Event::Expand(item) => {
                    let item = item.as_ref().clone();
                    this.close_linked_panel_entity(panel, cx);
                    this.open_inbox_item(item, window, cx);
                }
                inbox::Event::OpenSession(id) => {
                    this.close_linked_panel_entity(panel, cx);
                    this.open(*id, window, cx);
                }
                inbox::Event::StartSession { .. } | inbox::Event::ItemsChanged(_) => {}
            },
        );
        let changes = cx.observe(&panel, |this, panel, cx| {
            let shown = {
                let panel = panel.read(cx);
                (
                    panel
                        .linked_item()
                        .map(|item| item.key())
                        .unwrap_or_default(),
                    panel.linked_shown(),
                )
            };
            let id = panel.entity_id();
            if this.linked.shown.get(&id) != Some(&shown) {
                let first = this.linked.shown.insert(id, shown).is_none();
                if !first {
                    this.play_linked_motion(id, false, cx);
                }
            }
            cx.notify();
        });
        self.linked.subscriptions.insert(id, vec![events, changes]);
        self.play_linked_motion(id, true, cx);
        panel
    }

    /// The sheet slides in once as it opens; its contents fade in whenever
    /// they change, as LinkedWorkItemPanel keys them by item and state.
    fn play_linked_motion(&mut self, id: EntityId, slide: bool, cx: &mut Context<Self>) {
        if cx.reduce_motion() {
            return;
        }
        self.linked.motion += 1;
        let key = (id, self.linked.motion);
        if slide {
            self.linked.slide = Some(key);
        }
        self.linked.reveal = Some(key);
        let total = Duration::from_millis((REVEAL_DELAY + REVEAL) as u64).max(SLIDE);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(total).await;
            let _ = this.update(cx, |this, cx| {
                if this.linked.slide == Some(key) {
                    this.linked.slide = None;
                }
                if this.linked.reveal == Some(key) {
                    this.linked.reveal = None;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn forget_linked_panel(&mut self, panel: &Entity<Inbox>) {
        let id = panel.entity_id();
        self.linked.subscriptions.remove(&id);
        self.linked.shown.remove(&id);
    }

    fn close_project_panel(&mut self, cx: &mut Context<Self>) {
        if let Some(panel) = self.linked.project.take() {
            self.forget_linked_panel(&panel);
            cx.notify();
        }
    }

    fn close_linked_panel_entity(&mut self, panel: &Entity<Inbox>, cx: &mut Context<Self>) {
        if self.linked.project.as_ref() == Some(panel) {
            self.close_project_panel(cx);
            return;
        }
        let session = self
            .linked
            .sessions
            .iter()
            .find(|(_, open)| *open == panel)
            .map(|(id, _)| *id);
        if let Some(id) = session
            && let Some(panel) = self.linked.sessions.remove(&id)
        {
            self.forget_linked_panel(&panel);
            cx.notify();
        }
    }

    /// The panel on screen: the project's pull request, else the newest
    /// panel among the sessions in the focused tab. App views cover it.
    pub(super) fn visible_linked_panel(&self) -> Option<Entity<Inbox>> {
        if self.active_app_view.is_some() || self.settings.is_some() || self.app_search.is_some() {
            return None;
        }
        if let Some(panel) = &self.linked.project {
            return Some(panel.clone());
        }
        let pane = self.workspace.active?;
        let focused = self.workspace.session_for_pane(pane);
        if let Some(panel) = self.linked.sessions.get(&focused) {
            return Some(panel.clone());
        }
        let tab = self.workspace.tab_of(pane).unwrap_or(pane);
        self.workspace
            .layout(tab)
            .leaves()
            .into_iter()
            .map(|leaf| self.workspace.session_for_pane(leaf.id))
            .filter_map(|id| self.linked.sessions.get(&id))
            .max_by_key(|panel| panel.entity_id())
            .cloned()
    }

    /// Escape anywhere closes the panel on screen, unless its own menu or
    /// confirmation is open or the shell has a menu up.
    pub(super) fn escape_linked_panel(&mut self, cx: &mut Context<Self>) -> bool {
        if self.menu.is_some() {
            return false;
        }
        let Some(panel) = self.visible_linked_panel() else {
            return false;
        };
        if panel.read(cx).has_overlay() {
            return false;
        }
        self.close_linked_panel_entity(&panel, cx);
        true
    }

    fn linked_panel_width(&self, window: &Window) -> f32 {
        let viewport = window.viewport_size().width.as_f32();
        let max = (viewport * 0.65).round().max(MIN_WIDTH);
        self.linked
            .width
            .unwrap_or(DEFAULT_WIDTH)
            .clamp(MIN_WIDTH, max)
    }

    /// LinkedWorkItemPanel's aside: the reserved width, the sheet with its
    /// close button, and the drag edge that resizes it.
    pub(super) fn linked_panel_frame(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let panel = self.visible_linked_panel()?;
        let id = panel.entity_id();
        let width = self.linked_panel_width(window);
        let narrow = window.viewport_size().width.as_f32() < OVERLAY_BELOW;
        let sliding = self.linked.slide.is_some_and(|(panel, _)| panel == id);
        let label = panel
            .read(cx)
            .linked_item()
            .map(|item| {
                format!(
                    "{} #{}",
                    if item.kind == "pr" {
                        "pull request"
                    } else {
                        "issue"
                    },
                    item.number
                )
            })
            .unwrap_or_else(|| "work item".into());
        let close_label = if label.starts_with("issue") {
            "Close issue panel"
        } else {
            "Close pull request panel"
        };
        let contents = div()
            .id("linked-panel-contents")
            .relative()
            .size_full()
            .min_w_0()
            .child(panel.clone());
        let contents = match self.linked.reveal.filter(|(panel, _)| *panel == id) {
            Some((_, motion)) => {
                let total = REVEAL_DELAY + REVEAL;
                contents
                    .with_animation(
                        ("linked-panel-reveal", motion as usize),
                        Animation::new(Duration::from_millis(total as u64)),
                        move |el, t| {
                            let t = ((t * total - REVEAL_DELAY) / REVEAL).clamp(0., 1.);
                            let t = ease_out_quint(t);
                            el.opacity(t).left(px(12. * (1. - t)))
                        },
                    )
                    .into_any_element()
            }
            None => contents.into_any_element(),
        };
        let sheet = div()
            .id("linked-panel-sheet")
            .debug_selector(|| "linked-panel-sheet".into())
            .absolute()
            .top_0()
            .bottom_0()
            .left_0()
            .w(px(width))
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(crate::right_panel::stroke())
            .when(narrow, |d| d.bg(floating_fill()))
            .child(div().flex_1().min_h_0().min_w_0().child(contents))
            .child(
                div().absolute().top(px(5.)).right(px(8.)).child(
                    icon_button("linked-panel-close", close_label, "panel-left")
                        .size(px(26.))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(panel) = this.visible_linked_panel() {
                                this.close_linked_panel_entity(&panel, cx);
                            }
                        })),
                ),
            );
        let sheet = match self.linked.slide.filter(|(panel, _)| *panel == id) {
            Some((_, motion)) => sheet
                .with_animation(
                    ("linked-panel-slide", motion as usize),
                    Animation::new(SLIDE).with_easing(ease_out_quint),
                    move |el, t| el.left(px(width * (1. - t))),
                )
                .into_any_element(),
            None => sheet.into_any_element(),
        };
        let dragging = self.linked.resize.is_some();
        Some(
            div()
                .id("linked-work-panel")
                .debug_selector(|| "linked-work-panel".into())
                .role(Role::Complementary)
                .aria_label(format!("Linked {label}"))
                .relative()
                .h_full()
                .flex_shrink_0()
                .w(px(width))
                .when(narrow, |d| {
                    d.absolute().top_0().bottom_0().right_0().shadow_2xl()
                })
                .when(sliding, |d| d.overflow_hidden())
                .child(sheet)
                .child(
                    div()
                        .id("linked-panel-resize")
                        .debug_selector(|| "linked-panel-resize".into())
                        .role(Role::Splitter)
                        .aria_label(format!("Resize linked {label} panel"))
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(-4.))
                        .w(px(8.))
                        .cursor(CursorStyle::ResizeLeftRight)
                        .map(|d| {
                            if dragging {
                                d.bg(content(0.15))
                            } else {
                                d.hover(|s| s.bg(content(0.1)))
                            }
                        })
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                                this.linked.resize = Some((event.position.x, width));
                                cx.stop_propagation();
                                cx.notify();
                            }),
                        )
                        .on_click(cx.listener(|this, event: &gpui::ClickEvent, _, cx| {
                            if event.click_count() == 2 {
                                this.linked.resize = None;
                                this.linked.width = None;
                                cx.notify();
                            }
                        })),
                )
                .when(dragging, |d| d.child(self.linked_resize_watch(cx)))
                .into_any_element(),
        )
    }

    /// A drag keeps resizing over chats and panes that handle their own moves.
    fn linked_resize_watch(&self, cx: &Context<Self>) -> AnyElement {
        let shell = cx.entity().downgrade();
        canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let moves = shell.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                    if phase != DispatchPhase::Capture {
                        return;
                    }
                    let viewport = window.viewport_size().width.as_f32();
                    let _ = moves.update(cx, |this, cx| {
                        let Some((start, width)) = this.linked.resize else {
                            return;
                        };
                        if event.pressed_button != Some(MouseButton::Left) {
                            this.linked.resize = None;
                        } else {
                            let max = (viewport * 0.65).round().max(MIN_WIDTH);
                            let next = width - (event.position.x - start).as_f32();
                            this.linked.width = Some(next.round().clamp(MIN_WIDTH, max));
                        }
                        cx.stop_propagation();
                        cx.notify();
                    });
                });
                let release = shell.clone();
                window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture && event.button == MouseButton::Left {
                        let _ = release.update(cx, |this, cx| {
                            if this.linked.resize.take().is_some() {
                                cx.notify();
                            }
                        });
                    }
                });
            },
        )
        .absolute()
        .size_0()
        .into_any_element()
    }
}
