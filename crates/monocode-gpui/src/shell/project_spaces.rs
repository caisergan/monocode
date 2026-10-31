//! The new layout's project spaces: five at a time on a track that slides
//! with a swipe, the wheel or the chevrons and settles on a whole space. A
//! space dragged sideways reorders the projects, as the original rail does.
use super::*;
use gpui::{ScrollDelta, ScrollWheelEvent, relative};
use std::time::{Duration, Instant};

/// Spaces in view at once.
const SHOWN: usize = 5;
/// A swipe settles on the nearest space once its events stop this long, so
/// momentum scrolling runs out before the snap.
const SETTLE_AFTER: Duration = Duration::from_millis(90);
/// How long the track glides to a resting space.
const GLIDE_SECS: f32 = 0.28;
/// A space dragged past either end of the strip slides it, in spaces a second.
const EDGE_SPEED: f32 = 6.;
/// Pointer travel before a press on a space becomes a drag.
const DRAG_THRESHOLD: f32 = 4.;

#[derive(Default)]
pub(super) struct SpacesStrip {
    /// The first space in view, fractional while the track moves.
    pos: f32,
    glide: Option<Glide>,
    /// Bumped by every swipe event; the pending settle runs only if it still
    /// matches.
    settle: u64,
    viewport: AnchorSlot,
    drag: Option<SpaceDrag>,
    /// Spaces sliding aside for a drag, or into place after a drop, in spaces.
    shifts: HashMap<String, TabShift>,
    skip_click: bool,
    /// The last frame of a drag held past an end, which slides the track.
    edge_tick: Option<Instant>,
}

struct Glide {
    from: f32,
    to: f32,
    start: Instant,
}
impl Glide {
    fn at(&self, now: Instant) -> (f32, bool) {
        let t = now.saturating_duration_since(self.start).as_secs_f32() / GLIDE_SECS;
        if t >= 1. {
            return (self.to, true);
        }
        let eased = crate::reveal::bezier(t, 0.32, 0.72, 0., 1.);
        (self.from + (self.to - self.from) * eased, false)
    }
}

struct SpaceDrag {
    path: String,
    from: usize,
    to: usize,
    origin_x: Pixels,
    /// The track's position at the press, so a track sliding under a held
    /// drag carries the space with the pointer.
    origin_pos: f32,
    pointer_x: Pixels,
    active: bool,
}

impl SpacesStrip {
    /// The space the track rests on, or is gliding to.
    fn target(&self) -> f32 {
        self.glide
            .as_ref()
            .map_or(self.pos.round(), |glide| glide.to)
    }
    fn slot_width(&self, count: usize) -> Option<f32> {
        let width = self.viewport.get()?.size.width.as_f32();
        (width > 0.).then(|| width / count.clamp(1, SHOWN) as f32)
    }
    fn shift(&self, path: &str, now: Instant) -> f32 {
        self.shifts.get(path).map_or(0., |shift| shift.at(now).0)
    }
}

impl Shell {
    fn spaces_last(&self) -> f32 {
        self.workspace.projects.len().saturating_sub(SHOWN) as f32
    }

    pub(super) fn spaces_animating(&self) -> bool {
        let now = Instant::now();
        self.spaces.glide.is_some()
            || self.spaces.edge_tick.is_some()
            || self.spaces.shifts.values().any(|shift| !shift.at(now).1)
    }

    fn redraw_spaces(&self, cx: &mut Context<Self>) {
        self.sidebar_frame.update(cx, |_, cx| cx.notify());
    }

    /// Glides the track so its first space is `to`.
    fn glide_spaces(&mut self, to: f32, cx: &mut Context<Self>) {
        let to = to.clamp(0., self.spaces_last());
        if cx.reduce_motion() {
            self.spaces.pos = to;
            self.spaces.glide = None;
        } else if (self.spaces.pos - to).abs() > f32::EPSILON {
            self.spaces.glide = Some(Glide {
                from: self.spaces.pos,
                to,
                start: Instant::now(),
            });
        } else {
            self.spaces.glide = None;
        }
        self.redraw_spaces(cx);
    }

    fn page_spaces(&mut self, step: f32, cx: &mut Context<Self>) {
        let to = self.spaces.target() + step;
        self.glide_spaces(to, cx);
    }

    /// Brings the project at `ix` into view, as switching projects does.
    pub(super) fn reveal_space(&mut self, ix: usize, cx: &mut Context<Self>) {
        let target = self.spaces.target();
        let ix = ix as f32;
        if ix < target {
            self.glide_spaces(ix, cx);
        } else if ix > target + (SHOWN - 1) as f32 {
            self.glide_spaces(ix - (SHOWN - 1) as f32, cx);
        }
    }

    fn scroll_spaces(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        cx.stop_propagation();
        let last = self.spaces_last();
        if last <= 0. || self.spaces.drag.as_ref().is_some_and(|drag| drag.active) {
            return;
        }
        // Either axis slides the strip, so a plain wheel browses it too.
        let dominant = |x: f32, y: f32| if x.abs() >= y.abs() { x } else { y };
        match event.delta {
            // A wheel notch steps one whole space.
            ScrollDelta::Lines(lines) => {
                let step = -dominant(lines.x, lines.y);
                if step != 0. {
                    self.page_spaces(step.signum(), cx);
                }
            }
            ScrollDelta::Pixels(delta) => {
                let Some(slot) = self.spaces.slot_width(self.workspace.projects.len()) else {
                    return;
                };
                let delta = dominant(delta.x.as_f32(), delta.y.as_f32());
                if delta == 0. {
                    return;
                }
                self.spaces.glide = None;
                self.spaces.pos = (self.spaces.pos - delta / slot).clamp(0., last);
                self.hovered_space = None;
                self.spaces.settle += 1;
                let settle = self.spaces.settle;
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(SETTLE_AFTER).await;
                    this.update(cx, |this, cx| {
                        if this.spaces.settle == settle && this.spaces.drag.is_none() {
                            let to = this.spaces.pos.round();
                            this.glide_spaces(to, cx);
                        }
                    })
                    .ok();
                })
                .detach();
                self.redraw_spaces(cx);
            }
        }
    }

    fn start_space_drag(
        &mut self,
        path: String,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Keep Escape on the workspace, so it can cancel the drag.
        window.focus(&self.focus, cx);
        self.spaces.skip_click = false;
        let Some(from) = self.workspace.projects.iter().position(|p| *p == path) else {
            return;
        };
        // A press stops the track where it is drawn.
        if let Some(glide) = self.spaces.glide.take() {
            self.spaces.pos = glide.at(Instant::now()).0;
        }
        self.spaces.settle += 1;
        self.spaces.drag = Some(SpaceDrag {
            path,
            from,
            to: from,
            origin_x: event.position.x,
            origin_pos: self.spaces.pos,
            pointer_x: event.position.x,
            active: false,
        });
    }

    pub(super) fn move_space_drag(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if self.spaces.drag.is_none() {
            return;
        }
        if event.pressed_button != Some(MouseButton::Left) {
            self.cancel_space_drag(cx);
            return;
        }
        let Some(drag) = &mut self.spaces.drag else {
            return;
        };
        drag.pointer_x = event.position.x;
        if !drag.active && (drag.pointer_x - drag.origin_x).abs() < px(DRAG_THRESHOLD) {
            return;
        }
        drag.active = true;
        self.spaces.skip_click = true;
        self.hovered_space = None;
        self.update_space_drag(cx);
        self.redraw_spaces(cx);
    }

    /// Where the dragged space is drawn, in spaces along the track.
    fn dragged_space_x(&self, drag: &SpaceDrag) -> f32 {
        let count = self.workspace.projects.len();
        let Some(slot) = self.spaces.slot_width(count) else {
            return drag.from as f32;
        };
        let x = drag.from as f32
            + (drag.pointer_x - drag.origin_x).as_f32() / slot
            + (self.spaces.pos - drag.origin_pos);
        let shown = count.min(SHOWN) as f32;
        x.clamp(self.spaces.pos, self.spaces.pos + shown - 1.)
            .clamp(0., count.saturating_sub(1) as f32)
    }

    /// Moves the drop slot under the dragged space and slides the spaces
    /// between it and the slot it left.
    fn update_space_drag(&mut self, cx: &mut Context<Self>) {
        let Some(drag) = self.spaces.drag.as_ref().filter(|drag| drag.active) else {
            return;
        };
        let to = self.dragged_space_x(drag).round() as usize;
        if to == drag.to {
            return;
        }
        let from = drag.from;
        let now = Instant::now();
        let reduce = cx.reduce_motion();
        for (ix, path) in self.workspace.projects.iter().enumerate() {
            if ix == from {
                continue;
            }
            let target = if from < to && (from + 1..=to).contains(&ix) {
                -1.
            } else if to < from && (to..from).contains(&ix) {
                1.
            } else {
                0.
            };
            let current = self.spaces.shift(path, now);
            if current == target && !self.spaces.shifts.contains_key(path) {
                continue;
            }
            self.spaces.shifts.insert(
                path.clone(),
                TabShift {
                    from: if reduce { target } else { current },
                    to: target,
                    start: now,
                },
            );
        }
        if let Some(drag) = &mut self.spaces.drag {
            drag.to = to;
        }
    }

    pub(super) fn finish_space_drag(&mut self, cx: &mut Context<Self>) {
        let Some(drag) = self.spaces.drag.take() else {
            return;
        };
        if !drag.active {
            return;
        }
        self.spaces.edge_tick = None;
        if self.workspace.projects.get(drag.from) != Some(&drag.path) {
            self.spaces.shifts.clear();
            self.redraw_spaces(cx);
            return;
        }
        let now = Instant::now();
        let dropped_at = self.dragged_space_x(&drag);
        let old = self.workspace.projects.clone();
        let moved = self.workspace.projects.remove(drag.from);
        self.workspace.projects.insert(drag.to, moved);
        // Everything glides from where it was drawn into its new slot.
        let mut shifts = HashMap::new();
        for (new_ix, path) in self.workspace.projects.iter().enumerate() {
            let drawn = if *path == drag.path {
                dropped_at
            } else {
                let old_ix = old.iter().position(|p| p == path).unwrap_or(new_ix);
                old_ix as f32 + self.spaces.shift(path, now)
            };
            let from = drawn - new_ix as f32;
            if from.abs() > 0.001 {
                shifts.insert(
                    path.clone(),
                    TabShift {
                        from,
                        to: 0.,
                        start: now,
                    },
                );
            }
        }
        self.spaces.shifts = if cx.reduce_motion() {
            HashMap::new()
        } else {
            shifts
        };
        let to = self.spaces.pos.round();
        self.glide_spaces(to, cx);
        self.persist(cx);
    }

    pub(super) fn cancel_space_drag(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(drag) = self.spaces.drag.take() else {
            return false;
        };
        if drag.active {
            self.spaces.edge_tick = None;
            let now = Instant::now();
            let dropped_at = self.dragged_space_x(&drag);
            let mut shifts = HashMap::new();
            for path in &self.workspace.projects {
                let from = if *path == drag.path {
                    dropped_at - drag.from as f32
                } else {
                    self.spaces.shift(path, now)
                };
                shifts.insert(
                    path.clone(),
                    TabShift {
                        from,
                        to: 0.,
                        start: now,
                    },
                );
            }
            self.spaces.shifts = if cx.reduce_motion() {
                HashMap::new()
            } else {
                shifts
            };
            self.spaces.skip_click = true;
            let to = self.spaces.pos.round();
            self.glide_spaces(to, cx);
        }
        true
    }

    /// Advances the glide, and slides the track while a drag is held past
    /// either end of it.
    fn tick_spaces(&mut self, now: Instant) {
        if let Some(glide) = &self.spaces.glide {
            let (pos, done) = glide.at(now);
            self.spaces.pos = pos;
            if done {
                self.spaces.glide = None;
            }
        }
        // Spaces held aside for a drag keep their shift after it lands.
        self.spaces
            .shifts
            .retain(|_, shift| shift.to != 0. || !shift.at(now).1);
        let last = self.spaces_last();
        self.spaces.pos = self.spaces.pos.clamp(0., last);
        let edge = self
            .spaces
            .drag
            .as_ref()
            .filter(|drag| drag.active)
            .and_then(|drag| {
                let slot = self.spaces.slot_width(self.workspace.projects.len())?;
                let reach = drag.from as f32
                    + (drag.pointer_x - drag.origin_x).as_f32() / slot
                    + (self.spaces.pos - drag.origin_pos);
                if reach < self.spaces.pos && self.spaces.pos > 0. {
                    Some(-1.)
                } else if reach > self.spaces.pos + (SHOWN - 1) as f32 && self.spaces.pos < last {
                    Some(1.)
                } else {
                    None
                }
            });
        match edge {
            Some(direction) => {
                if let Some(tick) = self.spaces.edge_tick {
                    let dt = now.saturating_duration_since(tick).as_secs_f32().min(0.05);
                    self.spaces.pos =
                        (self.spaces.pos + direction * EDGE_SPEED * dt).clamp(0., last);
                }
                self.spaces.edge_tick = Some(now);
            }
            None => self.spaces.edge_tick = None,
        }
    }

    pub(super) fn project_spaces(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let now = Instant::now();
        self.tick_spaces(now);
        if self.spaces.edge_tick.is_some() {
            // The track moved under the held space; pick its new slot.
            self.update_space_drag(cx);
        }
        if self
            .hovered_space
            .as_ref()
            .is_some_and(|hovered| !self.workspace.projects.contains(hovered))
        {
            self.hovered_space = None;
        }
        let count = self.workspace.projects.len();
        let shown = count.clamp(1, SHOWN) as f32;
        let pos = self.spaces.pos;
        let last = self.spaces_last();
        let target = self.spaces.target();
        let dragged = self
            .spaces
            .drag
            .as_ref()
            .filter(|drag| drag.active)
            .map(|drag| (drag.path.clone(), self.dragged_space_x(drag)));
        let mut spaces: Vec<_> = self
            .workspace
            .projects
            .iter()
            .enumerate()
            .filter_map(|(ix, path)| {
                let x = match &dragged {
                    Some((dragged, x)) if dragged == path => *x,
                    _ => ix as f32 + self.spaces.shift(path, now),
                };
                // One space either side, so a sliding track never shows a gap.
                (x > pos - 1. && x < pos + shown).then(|| (ix, path.clone(), x))
            })
            .collect();
        // The dragged space draws above the ones making room for it.
        if let Some((dragged, _)) = &dragged {
            spaces.sort_by_key(|(_, path, _)| path == dragged);
        }
        let prefs = &self.workspace.preferences;
        let shortcuts = ["Project: Previous", "Project: Next"]
            .into_iter()
            .filter_map(|command| crate::settings::command_shortcut(prefs, command))
            .collect::<Vec<_>>()
            .join(" / ");
        let tooltip = self
            .hovered_space
            .clone()
            .filter(|_| dragged.is_none())
            .map(|path| {
                popover(
                    "project-space-tooltip",
                    Anchor::Slot(self.space_anchor.clone()),
                )
                .side(Side::Top)
                .align(Align::Center)
                .gap(8.)
                .padding(8.)
                .without_animation()
                .allow_outside_press()
                .child(
                    div()
                        .id("project-space-tip")
                        .role(Role::Tooltip)
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .whitespace_nowrap()
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(content(1.))
                                .child(self.project_label(&path)),
                        )
                        .when(!shortcuts.is_empty(), |d| {
                            d.child(div().text_color(content(0.55)).child(shortcuts.clone()))
                        }),
                )
            });
        let dragging = dragged.is_some();
        div()
            .h(px(30.))
            .flex_shrink_0()
            .px_2()
            .pb_0p5()
            .flex()
            .items_center()
            .gap_1()
            .child(
                icon_button("previous-projects", "Previous projects", "chevron-left")
                    .size(px(20.))
                    .debug_selector(|| "previous-projects".into())
                    .opacity(if target <= 0. { 0.3 } else { 1. })
                    .on_click(cx.listener(|this, _, _, cx| this.page_spaces(-1., cx))),
            )
            .child(
                div()
                    .id("project-spaces")
                    .debug_selector(|| "project-spaces".into())
                    .flex_1()
                    .min_w_0()
                    // The slots' insets make the gaps; the outer ones sit under
                    // the chevrons' gap instead of adding to it.
                    .mx(px(-2.))
                    .h(px(20.))
                    .relative()
                    .overflow_hidden()
                    .child(self.spaces.viewport.layout_probe())
                    .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, cx| {
                        this.scroll_spaces(event, cx)
                    }))
                    .children(spaces.into_iter().map(|(ix, path, x)| {
                        let active = path == self.workspace.project;
                        let hovered = !dragging && self.hovered_space.as_ref() == Some(&path);
                        let lifted = dragged.as_ref().is_some_and(|(p, _)| *p == path);
                        div()
                            .absolute()
                            .top_0()
                            .h_full()
                            .left(relative((x - pos) / shown))
                            .w(relative(1. / shown))
                            .px(px(2.))
                            .child(
                                div()
                                    .id(("project-space", ix))
                                    .debug_selector(move || format!("project-space-{ix}"))
                                    .group("project-space")
                                    .role(Role::Tab)
                                    .aria_label(format!("Project {}", self.project_label(&path)))
                                    .aria_description(path.clone())
                                    .aria_selected(active)
                                    .cursor(if lifted {
                                        CursorStyle::ClosedHand
                                    } else {
                                        CursorStyle::PointingHand
                                    })
                                    .size_full()
                                    .rounded_md()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .opacity(if active || lifted { 1. } else { 0.45 })
                                    .when(active, |d| d.bg(content(0.1)))
                                    .when(lifted && !active, |d| d.bg(content(0.05)))
                                    .when(!dragging, |d| {
                                        d.hover(|s| {
                                            s.opacity(1.).bg(content(if active {
                                                0.1
                                            } else {
                                                0.05
                                            }))
                                        })
                                    })
                                    .child(self.project_mark(&path, 12.))
                                    .when(hovered, |d| d.child(self.space_anchor.probe()))
                                    .on_hover({
                                        let path = path.clone();
                                        cx.listener(move |this, hovered: &bool, _, cx| {
                                            if *hovered && this.spaces.drag.is_none() {
                                                this.hovered_space = Some(path.clone());
                                            } else if this.hovered_space.as_ref() == Some(&path) {
                                                this.hovered_space = None;
                                            } else {
                                                return;
                                            }
                                            this.invalidate_chrome(cx);
                                        })
                                    })
                                    .on_mouse_down(MouseButton::Left, {
                                        let path = path.clone();
                                        cx.listener(
                                            move |this, event: &MouseDownEvent, window, cx| {
                                                this.start_space_drag(
                                                    path.clone(),
                                                    event,
                                                    window,
                                                    cx,
                                                )
                                            },
                                        )
                                    })
                                    .on_mouse_down(MouseButton::Right, {
                                        let path = path.clone();
                                        cx.listener(
                                            move |this, event: &MouseDownEvent, window, cx| {
                                                let anchor = Anchor::Point(event.position);
                                                let target = MenuTarget::Project {
                                                    path: path.clone(),
                                                    rail: true,
                                                };
                                                this.open_menu(target, anchor, window, cx);
                                            },
                                        )
                                    })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        if std::mem::take(&mut this.spaces.skip_click) {
                                            return;
                                        }
                                        // The tip steps aside once a space is clicked.
                                        this.hovered_space = None;
                                        this.select_project(path.clone(), window, cx)
                                    })),
                            )
                    })),
            )
            .child(
                icon_button("more-projects", "More projects", "chevron-right")
                    .size(px(20.))
                    .debug_selector(|| "more-projects".into())
                    .opacity(if target >= last { 0.3 } else { 1. })
                    .on_click(cx.listener(|this, _, _, cx| this.page_spaces(1., cx))),
            )
            .children(tooltip)
            .into_any()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, TouchPhase, VisualTestContext, WindowHandle, point, size};

    const PROJECTS: [&str; 7] = ["/s/a", "/s/b", "/s/c", "/s/d", "/s/e", "/s/f", "/s/g"];

    fn strip(cx: &mut TestAppContext) -> (WindowHandle<Shell>, VisualTestContext) {
        cx.update(crate::shell::bind_keys);
        cx.update(|cx| cx.set_reduce_motion(true));
        let (window, _, _) = super::super::tests::window(cx);
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        visual.simulate_resize(size(px(1500.), px(900.)));
        window
            .update(&mut visual, |shell, _, cx| {
                shell.workspace.classic_layout = false;
                shell.workspace.sidebar_visible = true;
                shell.workspace.sidebar_width = 260.;
                shell.workspace.projects = PROJECTS.map(str::to_owned).to_vec();
                shell.workspace.project = "/s/d".into();
                shell.invalidate_chrome(cx);
                cx.notify();
            })
            .unwrap();
        visual.run_until_parked();
        visual.refresh().unwrap();
        (window, visual)
    }

    fn pos(window: WindowHandle<Shell>, visual: &mut VisualTestContext) -> f32 {
        window
            .read_with(visual, |shell, _| shell.spaces.pos)
            .unwrap()
    }

    #[gpui::test]
    fn dragging_a_space_sideways_reorders_the_projects(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        let a = visual.debug_bounds("project-space-0").unwrap();
        let c = visual.debug_bounds("project-space-2").unwrap();
        visual.simulate_mouse_down(a.center(), MouseButton::Left, Default::default());
        visual.simulate_mouse_move(c.center(), MouseButton::Left, Default::default());
        window
            .update(visual, |shell, _, _| {
                let drag = shell.spaces.drag.as_ref().expect("the press became a drag");
                assert!(drag.active);
                assert_eq!(drag.to, 2);
                assert_eq!(shell.spaces.shift("/s/b", Instant::now()), -1.);
                assert_eq!(shell.spaces.shift("/s/c", Instant::now()), -1.);
                assert_eq!(shell.spaces.shift("/s/d", Instant::now()), 0.);
            })
            .unwrap();
        visual.refresh().unwrap();
        assert_eq!(
            visual.debug_bounds("project-space-1").unwrap().left(),
            a.left(),
            "the spaces between make room for the dragged one"
        );
        visual.simulate_mouse_up(c.center(), MouseButton::Left, Default::default());
        visual.run_until_parked();
        window
            .update(visual, |shell, _, _| {
                assert_eq!(
                    shell.workspace.projects,
                    ["/s/b", "/s/c", "/s/a", "/s/d", "/s/e", "/s/f", "/s/g"]
                );
                assert_eq!(
                    shell.workspace.project, "/s/d",
                    "dropping a space must not open it"
                );
                assert!(shell.spaces.drag.is_none());
                assert!(!shell.spaces_animating());
                let saved = locked(&shell.store).unwrap().ui_state().unwrap().unwrap();
                let restored = crate::workspace::Workspace::restore(Some(&saved), &[], "/s/d");
                assert_eq!(restored.projects[..3], ["/s/b", "/s/c", "/s/a"]);
            })
            .unwrap();
        // A plain click still opens its project.
        visual.refresh().unwrap();
        let first = visual.debug_bounds("project-space-0").unwrap();
        visual.simulate_click(first.center(), Default::default());
        visual.run_until_parked();
        window
            .read_with(visual, |shell, _| {
                assert_eq!(shell.workspace.project, "/s/b")
            })
            .unwrap();
    }

    #[gpui::test]
    fn escape_puts_a_dragged_space_back(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        let a = visual.debug_bounds("project-space-0").unwrap();
        let b = visual.debug_bounds("project-space-1").unwrap();
        visual.simulate_mouse_down(a.center(), MouseButton::Left, Default::default());
        visual.simulate_mouse_move(b.center(), MouseButton::Left, Default::default());
        visual.dispatch_action(DismissMenu);
        visual.simulate_mouse_up(b.center(), MouseButton::Left, Default::default());
        visual.run_until_parked();
        window
            .read_with(visual, |shell, _| {
                assert_eq!(shell.workspace.projects, PROJECTS);
                assert_eq!(shell.workspace.project, "/s/d");
            })
            .unwrap();
    }

    #[gpui::test]
    fn swiping_slides_the_strip_and_settles_on_a_space(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        let strip = visual.debug_bounds("project-spaces").unwrap();
        let slot = strip.size.width.as_f32() / SHOWN as f32;
        let swipe = |dx: f32, visual: &mut VisualTestContext| {
            visual.simulate_event(ScrollWheelEvent {
                position: strip.center(),
                delta: ScrollDelta::Pixels(point(px(dx), px(0.))),
                modifiers: Default::default(),
                touch_phase: TouchPhase::Moved,
            });
        };
        // Fingers moving left bring later projects in.
        swipe(-slot * 0.8, visual);
        swipe(-slot * 0.8, visual);
        assert!(
            (pos(window, visual) - 1.6).abs() < 0.01,
            "the track follows the swipe"
        );
        visual.executor().advance_clock(SETTLE_AFTER * 2);
        visual.run_until_parked();
        assert_eq!(
            pos(window, visual),
            2.,
            "a finished swipe settles on a space"
        );
        visual.refresh().unwrap();
        assert!(visual.debug_bounds("project-space-0").is_none());
        assert!(visual.debug_bounds("project-space-6").is_some());
        // The track stops at either end.
        swipe(-slot * 10., visual);
        assert_eq!(pos(window, visual), 2.);
        swipe(slot * 0.3, visual);
        visual.executor().advance_clock(SETTLE_AFTER * 2);
        visual.run_until_parked();
        assert_eq!(pos(window, visual), 2., "a short swipe springs back");
    }

    #[gpui::test]
    fn chevrons_wheel_notches_and_switching_projects_step_the_strip(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        let click = |selector: &'static str, visual: &mut VisualTestContext| {
            visual.refresh().unwrap();
            let bounds = visual.debug_bounds(selector).unwrap();
            visual.simulate_click(bounds.center(), Default::default());
            visual.run_until_parked();
        };
        click("more-projects", visual);
        assert_eq!(pos(window, visual), 1.);
        click("more-projects", visual);
        click("more-projects", visual);
        assert_eq!(pos(window, visual), 2., "the strip stops at the last space");
        click("previous-projects", visual);
        assert_eq!(pos(window, visual), 1.);
        visual.refresh().unwrap();
        let strip = visual.debug_bounds("project-spaces").unwrap();
        visual.simulate_event(ScrollWheelEvent {
            position: strip.center(),
            delta: ScrollDelta::Lines(point(0., -1.)),
            modifiers: Default::default(),
            touch_phase: TouchPhase::Moved,
        });
        visual.run_until_parked();
        assert_eq!(pos(window, visual), 2., "a wheel notch steps one space");
        window
            .update(visual, |shell, window, cx| {
                shell.select_project("/s/a".into(), window, cx)
            })
            .unwrap();
        visual.run_until_parked();
        assert_eq!(
            pos(window, visual),
            0.,
            "the opened project slides into view"
        );
    }
}
