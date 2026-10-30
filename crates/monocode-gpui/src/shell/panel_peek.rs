// The right panel's peek, the sidebar's mirror: in the inset layout a closed
// right panel slides out over the workspace while the pointer rests on the
// window's right edge or on the panel toggle, and puts itself away once the
// pointer leaves it.
use super::{
    Shell,
    sidebar_peek::{PEEK_CLOSE_DELAY, PEEK_DRIFT, PEEK_EDGE, PEEK_INSET, SidebarPeek},
};
use crate::theme::*;
use gpui::{
    AnyElement, Context, DispatchPhase, Focusable, MouseDownEvent, MouseMoveEvent, Pixels, Point,
    StyleRefinement, Window, canvas, div, prelude::*, px,
};
use std::time::Instant;

impl Shell {
    /// Only the inset layout's closed right panel peeks, and only where it
    /// could open.
    fn panel_peek_available(&self, cx: &gpui::App) -> bool {
        !self.workspace.boxy_layout()
            && !self.workspace.right_panel_open
            && self.right_slide.is_none()
            && self.right_panel.is_some()
            && self.settings.is_none()
            && self.app_search.is_none()
            && !self.app_view_open()
            && (self.mono_active(cx) || self.git.read(cx).available())
    }

    pub(super) fn panel_peek_open(&self) -> bool {
        self.panel_peek.as_ref().is_some_and(|peek| peek.open)
    }

    pub(super) fn set_panel_peek(
        &mut self,
        open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.panel_peek_close = None;
        if open && !self.panel_peek_available(cx) {
            return;
        }
        let current = match &self.panel_peek {
            Some(peek) if peek.open == open => return,
            Some(peek) => peek.at(Instant::now()).0,
            None if !open => return,
            None => 0.,
        };
        if open {
            self.set_peek(false, cx);
        } else if self
            .right_panel
            .as_ref()
            .is_some_and(|panel| panel.focus_handle(cx).contains_focused(window, cx))
        {
            self.focus_active(window, cx);
        }
        self.panel_peek = Some(SidebarPeek::new(open, current, cx.reduce_motion()));
        self.panel_peek_animating = true;
        self.sync_right_panel(cx);
        cx.notify();
    }

    /// Drops the peek at once, as when the panel opens or the layout changes.
    pub(super) fn drop_panel_peek(&mut self, cx: &mut Context<Self>) {
        self.panel_peek_close = None;
        self.panel_peek_animating = false;
        if self.panel_peek.take().is_some() {
            self.sync_right_panel(cx);
        }
    }

    pub(super) fn hover_panel_peek_toggle(
        &mut self,
        hovered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !hovered {
            self.panel_peek_toggle_spent = false;
        } else if !self.panel_peek_toggle_spent {
            self.set_panel_peek(true, window, cx);
        }
    }

    fn schedule_panel_peek_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel_peek_close.is_some() {
            return;
        }
        self.panel_peek_close = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(PEEK_CLOSE_DELAY).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.panel_peek_close = None;
                this.set_panel_peek(false, window, cx);
            });
        }));
    }

    fn panel_peek_contains(&self, position: Point<Pixels>) -> bool {
        let (x, y) = (position.x.as_f32(), position.y.as_f32());
        let right = self.viewport_width - PEEK_INSET;
        x <= right
            && x >= right - self.right_panel_width()
            && y >= TITLE_BAR_HEIGHT
            && y <= self.viewport_height - PEEK_INSET
    }

    /// The panel, the toggle or a menu opened from either keeps the peek out.
    fn panel_peek_held(&self, position: Point<Pixels>) -> bool {
        self.panel_peek_toggle_bounds
            .get()
            .is_some_and(|bounds| bounds.contains(&position))
            || self.panel_peek_contains(position)
            || self.menu.is_some()
    }

    fn panel_peek_pointer(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let edge = event.position.x.as_f32() >= self.viewport_width - PEEK_EDGE
            && event.position.y.as_f32() > TITLE_BAR_HEIGHT;
        if edge && event.pressed_button.is_none() {
            self.set_panel_peek(true, window, cx);
            return;
        }
        if !self.panel_peek_open() {
            return;
        }
        if self.panel_peek_held(event.position) || event.pressed_button.is_some() {
            self.panel_peek_close = None;
        } else {
            self.schedule_panel_peek_close(window, cx);
        }
    }

    /// A click anywhere else puts the panel away at once.
    fn panel_peek_press(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.panel_peek_open() && !self.panel_peek_held(event.position) {
            self.set_panel_peek(false, window, cx);
        }
    }

    /// Watches the pointer across the whole window, ahead of any view that
    /// would stop its events, while the right panel can peek.
    pub(super) fn panel_peek_watch(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.panel_peek_available(cx) {
            if self.panel_peek.is_some() {
                self.drop_panel_peek(cx);
            }
            return None;
        }
        let progress = match &self.panel_peek {
            Some(peek) => {
                let (progress, done) = peek.at(Instant::now());
                if done {
                    self.panel_peek_animating = false;
                    if !peek.open {
                        self.panel_peek = None;
                        self.sync_right_panel(cx);
                    }
                } else {
                    window.request_animation_frame();
                }
                progress
            }
            None => 0.,
        };
        let shell = cx.entity().downgrade();
        let watch = canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let moves = shell.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ =
                            moves.update(cx, |this, cx| this.panel_peek_pointer(event, window, cx));
                    }
                });
                let presses = shell.clone();
                window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ =
                            presses.update(cx, |this, cx| this.panel_peek_press(event, window, cx));
                    }
                });
            },
        )
        .absolute()
        .size_0()
        .into_any_element();
        if self.panel_peek.is_none() {
            return Some(watch);
        }
        let panel = self.panel_peek_panel(progress, window, cx);
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(watch)
                .child(self.peek_backdrop(progress, cx))
                .child(panel)
                .into_any_element(),
        )
    }

    /// The panel's tabs live in the title bar while it is open; peeking,
    /// they head the card instead.
    fn panel_peek_panel(
        &mut self,
        progress: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let width = self.right_panel_width();
        let header = if let Some(monos) = self.monos.clone().filter(|m| m.read(cx).active.is_some())
        {
            let expand = width >= 312. + self.window_controls;
            monos.update(cx, |m, cx| m.overview_controls(expand, window, cx))
        } else {
            let tabs = self.right_panel.as_ref().unwrap().read(cx).tabs.clone();
            let tabs_width = self.project_tabs_width(cx);
            if self.panel_peek_animating {
                div()
                    .w(px(tabs_width))
                    .h(px(TITLE_BAR_HEIGHT))
                    .child(tabs)
                    .into_any_element()
            } else {
                tabs.cached(
                    StyleRefinement::default()
                        .w(px(tabs_width))
                        .h(px(TITLE_BAR_HEIGHT)),
                )
                .into_any_element()
            }
        };
        let panel = self.right_panel.clone().unwrap();
        let content = self.right_panel_content(panel, !self.panel_peek_animating, window, cx);
        let contents = div()
            .size_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(TITLE_BAR_HEIGHT))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .pl(px(super::CORNER_TABS_LEAD))
                    .pr(px(6.))
                    .child(header),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .border_t_1()
                    .border_color(crate::right_panel::stroke())
                    .child(content),
            )
            .into_any_element();
        self.peek_card(
            "right-panel-peek",
            self.panel_peek_open(),
            progress,
            contents,
            window,
        )
        .right(px(PEEK_INSET - PEEK_DRIFT * (1. - progress)))
        .w(px(width))
    }
}
