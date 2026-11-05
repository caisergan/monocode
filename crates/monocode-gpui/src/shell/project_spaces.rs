//! The new layout's project spaces: five at a time on a track that slides
//! with a swipe, the wheel or the chevrons and settles on a whole space. A
//! space dragged sideways reorders the projects, as the original rail does.
//!
//! A trackpad swipe moves the track with the fingers, gives a little past
//! either end, and settles when the fingers lift: on the nearest space for a
//! slow release, further along for a flick, the way it was going. macOS keeps
//! sending momentum events after the lift; the track ignores them, since the
//! settle has already picked where to stop.
use super::*;
use gpui::{
    DispatchPhase, MouseUpEvent, ScrollDelta, ScrollWheelEvent, TouchPhase, canvas, relative,
};
use std::time::{Duration, Instant};

/// Spaces in view at once.
const SHOWN: usize = 5;
/// A smooth wheel that sends no gesture phases settles once its events
/// pause this long. Momentum events closer together than this still belong
/// to the swipe that let go.
const SETTLE_AFTER: Duration = Duration::from_millis(120);
/// A trackpad swipe settles when the fingers lift. If that never arrives,
/// it settles after this long without events.
const STRAY_AFTER: Duration = Duration::from_millis(1000);
/// How fast the spring the track settles with is; it comes to rest in
/// about 0.3 s.
const SPRING: f32 = 22.;
/// How far a released swipe's speed carries the track, in seconds of travel.
const CARRY_SECS: f32 = 0.12;
/// Above this speed, in spaces a second, a release moves at least to the
/// next space its way instead of springing back.
const FLICK_SPEED: f32 = 4.;
/// Samples within this long of the last one set a release's speed.
const SPEED_WINDOW: Duration = Duration::from_millis(80);
/// Fingers that rest this long before lifting let go without speed.
const REST_BEFORE_LIFT: Duration = Duration::from_millis(50);
/// The most a track pulled past an end can give, in spaces.
const BAND: f32 = 1.;
/// The fastest a settle may start moving away from its resting space, so a
/// flick into an end bounces gently.
const BOUNCE_SPEED: f32 = 8.;
/// A space dragged past either end of the strip slides it, in spaces a second.
const EDGE_SPEED: f32 = 6.;
/// Pointer travel before a press on a space becomes a drag.
const DRAG_THRESHOLD: f32 = 4.;

#[derive(Default)]
pub(super) struct SpacesStrip {
    /// The first space in view, fractional while the track moves, and past
    /// either end while a swipe pulls on it.
    pos: f32,
    glide: Option<Glide>,
    swipe: Option<Swipe>,
    /// Bumped by every swipe event; a pending settle runs only if it still
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

/// The track settling on a space: a critically damped spring that starts at
/// the speed the track already had, so a release carries on smoothly.
struct Glide {
    from: f32,
    to: f32,
    speed: f32,
    start: Instant,
}
impl Glide {
    fn new(from: f32, to: f32, speed: f32, start: Instant) -> Self {
        let gap = to - from;
        let speed = if speed * gap > 0. {
            // Faster than this toward the space and the spring sails past it.
            speed.clamp(-SPRING * gap.abs(), SPRING * gap.abs())
        } else {
            speed.clamp(-BOUNCE_SPEED, BOUNCE_SPEED)
        };
        Self {
            from,
            to,
            speed,
            start,
        }
    }
    fn at(&self, now: Instant) -> (f32, bool) {
        let t = now.saturating_duration_since(self.start).as_secs_f32();
        let c1 = self.from - self.to;
        let c2 = self.speed + SPRING * c1;
        let decay = (-SPRING * t).exp();
        let offset = (c1 + c2 * t) * decay;
        let speed = (c2 - SPRING * (c1 + c2 * t)) * decay;
        if SPRING * t > 12. || (offset.abs() < 0.002 && speed.abs() < 0.05) {
            (self.to, true)
        } else {
            (self.to + offset, false)
        }
    }
}

/// A trackpad or smooth-wheel gesture over the strip.
struct Swipe {
    /// Sideways or up and down, picked by the gesture's first movement. The
    /// other axis is ignored from then on, so the drift in a sideways swipe
    /// doesn't jolt the track.
    horizontal: Option<bool>,
    /// Where the gesture has pulled the track, before the ends' give.
    raw: f32,
    /// Recent `(time, raw)` points, for the speed at release.
    samples: Vec<(Instant, f32)>,
    /// Came with gesture phases, as a trackpad does. Without them the swipe
    /// settles when its events pause.
    phased: bool,
    /// The fingers lifted and the track is settling. The momentum events
    /// that follow are ignored.
    released: bool,
    last: Instant,
}
impl Swipe {
    fn speed(&self, now: Instant) -> f32 {
        let Some(&(newest_at, newest)) = self.samples.last() else {
            return 0.;
        };
        if now.saturating_duration_since(newest_at) > REST_BEFORE_LIFT {
            return 0.;
        }
        let Some(&(oldest_at, oldest)) = self
            .samples
            .iter()
            .find(|(at, _)| newest_at.saturating_duration_since(*at) <= SPEED_WINDOW)
        else {
            return 0.;
        };
        let dt = newest_at.saturating_duration_since(oldest_at).as_secs_f32();
        if dt < 0.008 {
            return 0.;
        }
        (newest - oldest) / dt
    }
}

/// The give of a track pulled `over` spaces past an end, as macOS's rubber
/// band: it follows at first and stiffens toward [`BAND`].
fn band(over: f32) -> f32 {
    BAND * (1. - 1. / (over * 0.55 / BAND + 1.))
}
/// How far past an end the fingers pulled for the track to show `shown`.
fn unband(shown: f32) -> f32 {
    let shown = shown.min(BAND * 0.99);
    BAND / 0.55 * (1. / (1. - shown / BAND) - 1.)
}
/// The track position a gesture's raw pull shows.
fn banded(raw: f32, last: f32) -> f32 {
    if raw < 0. {
        -band(-raw)
    } else if raw > last {
        last + band(raw - last)
    } else {
        raw
    }
}
fn unbanded(pos: f32, last: f32) -> f32 {
    if pos < 0. {
        -unband(-pos)
    } else if pos > last {
        last + unband(pos - last)
    } else {
        pos
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
    /// Fingers are moving the track.
    fn swiping(&self) -> bool {
        self.swipe
            .as_ref()
            .is_some_and(|swipe| !swipe.released && swipe.horizontal.is_some())
    }
    /// The track is sliding, so the spaces under the pointer keep changing.
    fn moving(&self) -> bool {
        self.glide.is_some() || self.swiping()
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
        self.glide_spaces_from(to, 0., cx);
    }

    /// Glides the track to `to`, starting at `speed` spaces a second.
    fn glide_spaces_from(&mut self, to: f32, speed: f32, cx: &mut Context<Self>) {
        let to = to.clamp(0., self.spaces_last());
        let now = cx.background_executor().now();
        // A glide already under way starts from where it is drawn.
        if let Some(glide) = self.spaces.glide.take() {
            self.spaces.pos = glide.at(now).0;
        }
        if cx.reduce_motion() {
            self.spaces.pos = to;
        } else if (self.spaces.pos - to).abs() > f32::EPSILON {
            self.spaces.glide = Some(Glide::new(self.spaces.pos, to, speed, now));
            // The tip would trail a space sliding out from under the pointer.
            self.hovered_space = None;
        }
        self.redraw_spaces(cx);
    }

    fn page_spaces(&mut self, step: f32, cx: &mut Context<Self>) {
        self.spaces.swipe = None;
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
        if self.spaces_last() <= 0. || self.spaces.drag.as_ref().is_some_and(|drag| drag.active) {
            return;
        }
        match event.delta {
            // A wheel notch steps one whole space, on either axis, so a
            // plain wheel browses the strip too.
            ScrollDelta::Lines(lines) => {
                let step = if lines.x.abs() >= lines.y.abs() {
                    -lines.x
                } else {
                    -lines.y
                };
                if step != 0. {
                    self.page_spaces(step.signum(), cx);
                }
            }
            ScrollDelta::Pixels(delta) => {
                self.swipe_spaces(delta.x.as_f32(), delta.y.as_f32(), event.touch_phase, cx)
            }
        }
    }

    fn swipe_spaces(&mut self, dx: f32, dy: f32, phase: TouchPhase, cx: &mut Context<Self>) {
        let now = cx.background_executor().now();
        let started = phase == TouchPhase::Started;
        if let Some(swipe) = &mut self.spaces.swipe
            && swipe.released
            && !started
            && now.saturating_duration_since(swipe.last) < SETTLE_AFTER
        {
            // Momentum from a swipe that already let go.
            swipe.last = now;
            return;
        }
        if started
            || self
                .spaces
                .swipe
                .as_ref()
                .is_none_or(|swipe| swipe.released)
        {
            self.spaces.swipe = Some(Swipe {
                horizontal: None,
                raw: 0.,
                samples: Vec::new(),
                phased: started,
                released: false,
                last: now,
            });
        }
        let last = self.spaces_last();
        let slot = self.spaces.slot_width(self.workspace.projects.len());
        let pos = self.spaces.pos;
        let glide = self.spaces.glide.take();
        let Some(swipe) = &mut self.spaces.swipe else {
            return;
        };
        swipe.last = now;
        let mut moved = false;
        if let Some(slot) = slot
            && (dx != 0. || dy != 0.)
        {
            let horizontal = *swipe.horizontal.get_or_insert_with(|| {
                // The first movement catches the track where it is drawn.
                swipe.raw = unbanded(glide.as_ref().map_or(pos, |glide| glide.at(now).0), last);
                dx.abs() >= dy.abs()
            });
            let delta = if horizontal { dx } else { dy };
            if delta != 0. {
                swipe.raw -= delta / slot;
                swipe.samples.push((now, swipe.raw));
                swipe
                    .samples
                    .retain(|(at, _)| now.saturating_duration_since(*at) <= SPEED_WINDOW * 2);
                moved = true;
            }
        }
        let phased = swipe.phased;
        if swipe.horizontal.is_some() {
            self.spaces.pos = banded(swipe.raw, last);
            self.hovered_space = None;
        } else {
            // A touch that hasn't moved yet leaves a settling track alone.
            self.spaces.glide = glide;
        }
        if matches!(phase, TouchPhase::Ended | TouchPhase::Cancelled) {
            self.release_swipe(true, cx);
            return;
        }
        self.spaces.settle += 1;
        let settle = self.spaces.settle;
        let wait = if phased { STRAY_AFTER } else { SETTLE_AFTER };
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            this.update(cx, |this, cx| {
                if this.spaces.settle == settle {
                    this.release_swipe(false, cx);
                }
            })
            .ok();
        })
        .detach();
        if moved {
            self.redraw_spaces(cx);
        }
    }

    /// Settles a swipe whose fingers lifted: on the nearest space, or, for a
    /// flick, as far as its speed carries, at least one space its way.
    fn release_swipe(&mut self, carry: bool, cx: &mut Context<Self>) {
        let now = cx.background_executor().now();
        let Some(swipe) = self.spaces.swipe.as_mut().filter(|swipe| !swipe.released) else {
            return;
        };
        swipe.released = true;
        if swipe.horizontal.is_none() {
            self.spaces.swipe = None;
            return;
        }
        let speed = if carry { swipe.speed(now) } else { 0. };
        let raw = swipe.raw;
        let mut to = (raw + speed * CARRY_SECS).round();
        if speed > FLICK_SPEED {
            to = to.max(raw.ceil());
        } else if speed < -FLICK_SPEED {
            to = to.min(raw.floor());
        }
        // The track's own speed, which the ends' give has slowed.
        let last = self.spaces_last();
        let drawn_speed = if raw < 0. || raw > last {
            speed * 0.3
        } else {
            speed
        };
        self.glide_spaces_from(to, drawn_speed, cx);
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
        // A track still settling keeps going; a drag rides along with it.
        self.spaces.drag = Some(SpaceDrag {
            path,
            from,
            to: from,
            origin_x: event.position.x,
            origin_pos: self.spaces.pos,
            pointer_x: event.position.x,
            active: false,
        });
        // Paints the window-wide watch that follows the drag.
        self.redraw_spaces(cx);
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
        self.settle_spaces(cx);
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
            self.settle_spaces(cx);
        }
        true
    }

    /// Brings a track left between spaces, after a drag slid it, to rest on
    /// the nearest one, unless it is already gliding to one.
    fn settle_spaces(&mut self, cx: &mut Context<Self>) {
        if self.spaces.glide.is_none() && !self.spaces.swiping() {
            let to = self.spaces.pos.round();
            self.glide_spaces(to, cx);
        }
    }

    /// Advances the glide, and slides the track while a drag is held past
    /// either end of it.
    fn tick_spaces(&mut self, now: Instant, clock: Instant) {
        if let Some(glide) = &self.spaces.glide {
            let (pos, done) = glide.at(clock);
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
        // A swipe may pull past the ends, and a glide springs back from there.
        if self.spaces.glide.is_none() && !self.spaces.swiping() {
            self.spaces.pos = self.spaces.pos.clamp(0., last);
        }
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
                self.spaces.glide = None;
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

    /// Chats without a project: fixed beside the track, since "~" is not one of
    /// the projects the track slides through and reorders.
    fn chats_space(&self, dragging: bool, cx: &mut Context<Self>) -> AnyElement {
        let active = self.workspace.project == "~";
        let attention = !active && self.chats_need_attention(cx);
        let hovered = !dragging && self.hovered_space.as_deref() == Some("~");
        div()
            .id("chats-space")
            .debug_selector(|| "chats-space".into())
            .group("chats-space")
            .role(Role::Tab)
            .aria_label("Chats")
            .aria_selected(active)
            .when(attention, |d| d.aria_description("A chat needs you"))
            .relative()
            .flex_shrink_0()
            .w(px(26.))
            .h(px(20.))
            .rounded_md()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .when(active, |d| d.bg(content(0.1)))
            .when(!dragging && !active, |d| d.hover(|s| s.bg(content(0.05))))
            .child(
                // Only the icon dims, so the dot keeps its full colour.
                div()
                    .opacity(if active { 1. } else { 0.55 })
                    .group_hover("chats-space", |s| s.opacity(1.))
                    .child(icon("message-multiple", 14.)),
            )
            .when(attention, |d| {
                d.child(
                    div()
                        .debug_selector(|| "chats-space-dot".into())
                        .absolute()
                        .top(px(1.))
                        .right(px(3.))
                        .size(px(6.))
                        .rounded_full()
                        .bg(accent_color()),
                )
            })
            .when(hovered, |d| d.child(self.space_anchor.probe()))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if *hovered && this.spaces.drag.is_none() && !this.spaces.moving() {
                    this.hovered_space = Some("~".into());
                } else if this.hovered_space.as_deref() == Some("~") {
                    this.hovered_space = None;
                } else {
                    return;
                }
                this.invalidate_chrome(cx);
            }))
            .on_click(cx.listener(|this, _, window, cx| {
                this.hovered_space = None;
                this.select_project("~".into(), window, cx)
            }))
            .into_any_element()
    }
    pub(super) fn project_spaces(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let now = Instant::now();
        self.tick_spaces(now, cx.background_executor().now());
        if self.spaces.edge_tick.is_some() {
            // The track moved under the held space; pick its new slot.
            self.update_space_drag(cx);
        }
        if self
            .hovered_space
            .as_ref()
            .is_some_and(|hovered| hovered != "~" && !self.workspace.projects.contains(hovered))
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
        let chats_shortcut =
            crate::settings::command_shortcut(prefs, "Project: Chats").unwrap_or_default();
        let tooltip = self
            .hovered_space
            .clone()
            .filter(|_| dragged.is_none() && !self.spaces.moving())
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
                        .map(|d| {
                            let keys = if path == "~" {
                                &chats_shortcut
                            } else {
                                &shortcuts
                            };
                            d.when(!keys.is_empty(), |d| {
                                d.child(div().text_color(content(0.55)).child(keys.clone()))
                            })
                        }),
                )
            });
        let dragging = dragged.is_some();
        let moving = self.spaces.moving();
        // A press on a space follows the pointer across the whole window.
        // The shell's own mouse listeners can't: in the sidebar's peek the
        // card above them blocks the pointer, so they never hear the drag.
        let drag_watch = self.spaces.drag.is_some().then(|| {
            let shell = cx.entity().downgrade();
            canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    let moves = shell.clone();
                    window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = moves.update(cx, |this, cx| this.move_space_drag(event, cx));
                        }
                    });
                    let releases = shell.clone();
                    window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture && event.button == MouseButton::Left {
                            let _ = releases.update(cx, |this, cx| this.finish_space_drag(cx));
                        }
                    });
                },
            )
            .absolute()
            .size_0()
        });
        div()
            .h(px(30.))
            .flex_shrink_0()
            .px_2()
            .pb_0p5()
            .flex()
            .items_center()
            .gap_1()
            .child(self.chats_space(dragging, cx))
            .child(div().w_px().h(px(14.)).flex_shrink_0().bg(content(0.12)))
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
                                    .when(!dragging && !moving, |d| {
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
                                            if *hovered
                                                && this.spaces.drag.is_none()
                                                && !this.spaces.moving()
                                            {
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
                                                // Spaces have no pins or groups to offer.
                                                let target = MenuTarget::Project {
                                                    path: path.clone(),
                                                    rail: false,
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
            .children(drag_watch)
            .into_any()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, TouchPhase, VisualTestContext, WindowHandle, point, size};

    const PROJECTS: [&str; 7] = ["/s/a", "/s/b", "/s/c", "/s/d", "/s/e", "/s/f", "/s/g"];

    fn strip(cx: &mut TestAppContext) -> (WindowHandle<Shell>, VisualTestContext) {
        strip_of(cx, &PROJECTS)
    }

    fn strip_of(
        cx: &mut TestAppContext,
        projects: &[&str],
    ) -> (WindowHandle<Shell>, VisualTestContext) {
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
                shell.workspace.projects = projects.iter().map(|p| p.to_string()).collect();
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
    fn the_chats_slot_opens_chats_without_joining_the_projects(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let slot = visual.debug_bounds("chats-space").unwrap().center();
        // The track keeps its spaces; the slot sits before it.
        let track = visual.debug_bounds("project-spaces").unwrap();
        assert!(slot.x < track.left());
        visual.simulate_click(slot, Default::default());
        visual.run_until_parked();
        window
            .update(&mut visual, |shell, _, cx| {
                assert_eq!(shell.workspace.project, "~");
                assert_eq!(shell.workspace.projects.len(), PROJECTS.len());
                assert!(!shell.workspace.projects.contains(&"~".to_owned()));
                let id = shell.workspace.active.unwrap();
                assert_eq!(shell.session_metadata(id, cx).summary.cwd, "~");
            })
            .unwrap();
        visual.refresh().unwrap();
        // A space on the strip leads back to its project.
        let space = visual.debug_bounds("project-space-0").unwrap().center();
        visual.simulate_click(space, Default::default());
        visual.run_until_parked();
        window
            .update(&mut visual, |shell, _, _| {
                assert_eq!(shell.workspace.project, PROJECTS[0]);
            })
            .unwrap();
    }
    #[gpui::test]
    fn the_chats_slot_shows_a_dot_for_an_unread_chat_until_chats_opens(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        assert!(visual.debug_bounds("chats-space-dot").is_none());
        window
            .update(&mut visual, |shell, _, cx| {
                let id = shell.workspace.active.unwrap();
                assert!(!shell.chats_need_attention(cx));
                shell.sessions[&id].update(cx, |s, _| s.summary.cwd = "/s/d".into());
                shell.unseen_finished.insert(id);
                assert!(!shell.chats_need_attention(cx), "a project's reply");
                shell.sessions[&id].update(cx, |s, _| s.summary.cwd = "~".into());
                assert!(shell.chats_need_attention(cx));
                shell.invalidate_chrome(cx);
                cx.notify();
            })
            .unwrap();
        visual.run_until_parked();
        visual.refresh().unwrap();
        assert!(visual.debug_bounds("chats-space-dot").is_some());
        window
            .update(&mut visual, |shell, _, cx| {
                shell.workspace.project = "~".into();
                shell.invalidate_chrome(cx);
                cx.notify();
            })
            .unwrap();
        visual.run_until_parked();
        visual.refresh().unwrap();
        assert!(visual.debug_bounds("chats-space-dot").is_none());
    }
    #[gpui::test]
    fn the_chats_command_only_acts_in_the_focused_layout(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        window
            .update(&mut visual, |shell, w, cx| {
                shell.workspace.classic_layout = true;
                shell.focus_active(w, cx);
                w.dispatch_action(Box::new(ShowChats), cx);
            })
            .unwrap();
        visual.run_until_parked();
        window
            .update(&mut visual, |shell, w, cx| {
                assert_eq!(shell.workspace.project, "/s/d");
                shell.workspace.classic_layout = false;
                w.dispatch_action(Box::new(ShowChats), cx);
            })
            .unwrap();
        visual.run_until_parked();
        window
            .update(&mut visual, |shell, _, _| {
                assert_eq!(shell.workspace.project, "~");
            })
            .unwrap();
    }
    #[gpui::test]
    fn chats_hide_monos_and_offer_a_first_chat(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        window
            .update(&mut visual, |shell, w, cx| {
                shell.select_project("~".into(), w, cx);
            })
            .unwrap();
        visual.run_until_parked();
        visual.refresh().unwrap();
        window
            .update(&mut visual, |shell, _, cx| {
                let id = shell.workspace.active.unwrap();
                let view = shell.sessions[&id].read(cx);
                assert_eq!(view.input.read(cx).placeholder_text(), "Ask anything…");
            })
            .unwrap();
        assert!(visual.debug_bounds("chats-empty-new").is_some());
        assert!(visual.debug_bounds("composer-home-folder").is_some());
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
    fn a_space_drags_inside_the_sidebars_peek(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        // The inset layout's collapsed sidebar, peeked out over the workspace.
        window
            .update(visual, |shell, _, cx| {
                shell.workspace.new_layout_boxy = false;
                shell.workspace.sidebar_visible = false;
                shell.set_peek(true, cx);
                shell.invalidate_chrome(cx);
                cx.notify();
            })
            .unwrap();
        visual.run_until_parked();
        visual.refresh().unwrap();
        assert!(visual.debug_bounds("sidebar-peek").is_some());
        let a = visual.debug_bounds("project-space-0").unwrap();
        let c = visual.debug_bounds("project-space-2").unwrap();
        visual.simulate_mouse_move(a.center(), None, Default::default());
        visual.simulate_mouse_down(a.center(), MouseButton::Left, Default::default());
        visual.run_until_parked();
        visual.refresh().unwrap();
        let mut x = a.center().x;
        while x < c.center().x {
            x += px(3.);
            let at = point(x, a.center().y);
            visual.simulate_mouse_move(at, MouseButton::Left, Default::default());
            visual.run_until_parked();
            visual.refresh().unwrap();
        }
        window
            .read_with(visual, |shell, _| {
                let drag = shell.spaces.drag.as_ref().expect("the press is a drag");
                assert!(drag.active, "the drag follows the pointer in the peek");
                assert_eq!(drag.to, 2);
            })
            .unwrap();
        visual.simulate_mouse_up(
            point(x, a.center().y),
            MouseButton::Left,
            Default::default(),
        );
        visual.run_until_parked();
        window
            .read_with(visual, |shell, _| {
                assert_eq!(
                    shell.workspace.projects,
                    ["/s/b", "/s/c", "/s/a", "/s/d", "/s/e", "/s/f", "/s/g"]
                );
                assert_eq!(shell.workspace.project, "/s/d", "the drop opens nothing");
                assert!(shell.peek_open(), "the peek stays out after the drop");
            })
            .unwrap();
    }

    #[gpui::test]
    fn the_project_menu_and_shortcut_move_a_space(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        let (first, last) = (PROJECTS[0], PROJECTS[PROJECTS.len() - 1]);
        window
            .update(visual, |shell, window, cx| {
                let target = MenuTarget::Project {
                    path: "/s/c".into(),
                    rail: false,
                };
                shell.run_menu(target.clone(), "move:start", None, window, cx);
                assert_eq!(shell.workspace.projects[0], "/s/c");
                shell.run_menu(target, "move:end", None, window, cx);
                assert_eq!(shell.workspace.projects.last().unwrap(), "/s/c");
                assert_eq!(shell.workspace.projects[0], first);
                assert_ne!(last, "/s/c");
                shell.select_project("/s/c".into(), window, cx);
            })
            .unwrap();
        visual.run_until_parked();
        window
            .update(visual, |shell, _, cx| shell.move_current_project(-1, cx))
            .unwrap();
        visual.run_until_parked();
        window
            .update(visual, |shell, _, _| {
                let count = shell.workspace.projects.len();
                assert_eq!(shell.workspace.projects[count - 2], "/s/c");
                let saved = locked(&shell.store).unwrap().ui_state().unwrap().unwrap();
                let restored = Workspace::restore(Some(&saved), &[], "/s/c");
                assert_eq!(restored.projects, shell.workspace.projects);
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
        // Past an end the track gives a little, then springs back.
        swipe(-slot * 10., visual);
        let pulled = pos(window, visual);
        assert!(
            pulled > 2.5 && pulled < 2. + BAND,
            "the end gives, but less than the pull: {pulled}"
        );
        swipe(slot * 0.3, visual);
        visual.executor().advance_clock(SETTLE_AFTER * 2);
        visual.run_until_parked();
        assert_eq!(pos(window, visual), 2., "a pull past the end springs back");
    }

    /// Sends one trackpad event over the strip, `dx`/`dy` in spaces, then
    /// lets `gap` pass as the next event would.
    fn trackpad(
        visual: &mut VisualTestContext,
        dx: f32,
        dy: f32,
        phase: TouchPhase,
        gap: Duration,
    ) {
        visual.refresh().unwrap();
        let strip = visual.debug_bounds("project-spaces").unwrap();
        let slot = strip.size.width.as_f32() / SHOWN as f32;
        visual.simulate_event(ScrollWheelEvent {
            position: strip.center(),
            delta: ScrollDelta::Pixels(point(px(dx * slot), px(dy * slot))),
            modifiers: Default::default(),
            touch_phase: phase,
        });
        visual.executor().advance_clock(gap);
        visual.run_until_parked();
    }

    const FRAME: Duration = Duration::from_millis(8);

    #[gpui::test]
    fn a_trackpad_swipe_settles_when_the_fingers_lift(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        trackpad(visual, 0., 0., TouchPhase::Started, FRAME);
        for _ in 0..4 {
            trackpad(visual, -0.15, 0., TouchPhase::Moved, FRAME);
        }
        assert!((pos(window, visual) - 0.6).abs() < 0.01);
        // Fingers resting mid-swipe hold the track where they put it.
        visual.executor().advance_clock(STRAY_AFTER / 2);
        visual.run_until_parked();
        assert!(
            (pos(window, visual) - 0.6).abs() < 0.01,
            "resting fingers must not snap the track"
        );
        // Lifting after the rest lets go without speed: nearest space.
        trackpad(visual, 0., 0., TouchPhase::Ended, FRAME);
        assert_eq!(pos(window, visual), 1.);
        // The momentum macOS sends after the lift doesn't move it again.
        for _ in 0..20 {
            trackpad(visual, -0.3, 0., TouchPhase::Moved, FRAME);
        }
        assert_eq!(pos(window, visual), 1., "momentum is ignored");
        // A later swipe works again, from where the track rests.
        visual.executor().advance_clock(SETTLE_AFTER * 2);
        trackpad(visual, 0., 0., TouchPhase::Started, FRAME);
        trackpad(visual, 0.3, 0., TouchPhase::Moved, FRAME);
        assert!((pos(window, visual) - 0.7).abs() < 0.01);
        visual.executor().advance_clock(REST_BEFORE_LIFT * 2);
        trackpad(visual, 0., 0., TouchPhase::Ended, FRAME);
        assert_eq!(pos(window, visual), 1., "a short slow swipe springs back");
    }

    #[gpui::test]
    fn a_flick_carries_the_track_the_way_it_was_going(cx: &mut TestAppContext) {
        let projects: Vec<String> = (0..16).map(|ix| format!("/s/{ix}")).collect();
        let projects: Vec<&str> = projects.iter().map(String::as_str).collect();
        let (window, mut visual) = strip_of(cx, &projects);
        let visual = &mut visual;
        // A quick, short flick still moves to the next space.
        trackpad(visual, 0., 0., TouchPhase::Started, FRAME);
        trackpad(visual, -0.1, 0., TouchPhase::Moved, FRAME);
        trackpad(visual, -0.1, 0., TouchPhase::Moved, FRAME);
        trackpad(visual, 0., 0., TouchPhase::Ended, FRAME);
        let landed = pos(window, visual);
        assert!(
            landed == 1. || landed == 2.,
            "a flick moves at least one space: {landed}"
        );
        visual.executor().advance_clock(SETTLE_AFTER * 2);
        // A fast one carries several.
        trackpad(visual, 0., 0., TouchPhase::Started, FRAME);
        for _ in 0..6 {
            trackpad(visual, -0.5, 0., TouchPhase::Moved, FRAME);
        }
        trackpad(visual, 0., 0., TouchPhase::Ended, FRAME);
        let landed = pos(window, visual);
        assert!(
            landed >= 6. && landed.fract() == 0.,
            "a fast flick carries past where the fingers left it: {landed}"
        );
        visual.executor().advance_clock(SETTLE_AFTER * 2);
        // Flicking back works the same way, and stops at the first space.
        trackpad(visual, 0., 0., TouchPhase::Started, FRAME);
        for _ in 0..12 {
            trackpad(visual, 1., 0., TouchPhase::Moved, FRAME);
        }
        trackpad(visual, 0., 0., TouchPhase::Ended, FRAME);
        assert_eq!(pos(window, visual), 0.);
    }

    #[gpui::test]
    fn a_swipe_keeps_to_the_axis_it_started_on(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        trackpad(visual, 0., 0., TouchPhase::Started, FRAME);
        trackpad(visual, -0.4, 0.1, TouchPhase::Moved, FRAME);
        // A sideways swipe's drift, even an event that is mostly vertical,
        // doesn't move the track.
        trackpad(visual, -0.05, 0.6, TouchPhase::Moved, FRAME);
        trackpad(visual, 0., -0.6, TouchPhase::Moved, FRAME);
        assert!((pos(window, visual) - 0.45).abs() < 0.01);
        visual.executor().advance_clock(REST_BEFORE_LIFT * 2);
        trackpad(visual, 0., 0., TouchPhase::Ended, FRAME);
        assert_eq!(pos(window, visual), 0.);
        visual.executor().advance_clock(SETTLE_AFTER * 2);
        // A swipe that starts up or down slides the strip on that axis.
        trackpad(visual, 0., 0., TouchPhase::Started, FRAME);
        trackpad(visual, 0.05, -0.7, TouchPhase::Moved, FRAME);
        trackpad(visual, 0.6, 0., TouchPhase::Moved, FRAME);
        assert!((pos(window, visual) - 0.7).abs() < 0.01);
    }

    #[gpui::test]
    fn a_press_while_the_track_glides_leaves_it_on_a_space(cx: &mut TestAppContext) {
        let (window, mut visual) = strip(cx);
        let visual = &mut visual;
        visual.update(|_, cx| cx.set_reduce_motion(false));
        let frame = |visual: &mut VisualTestContext| {
            visual.executor().advance_clock(Duration::from_millis(16));
            window
                .update(visual, |shell, _, cx| shell.redraw_spaces(cx))
                .unwrap();
            visual.run_until_parked();
            visual.refresh().unwrap();
        };
        visual.refresh().unwrap();
        let more = visual.debug_bounds("more-projects").unwrap();
        visual.simulate_click(more.center(), Default::default());
        frame(visual);
        frame(visual);
        let mid = pos(window, visual);
        assert!(mid > 0. && mid < 1., "the track is gliding: {mid}");
        // Click a space while it moves.
        let space = visual.debug_bounds("project-space-2").unwrap();
        visual.simulate_click(space.center(), Default::default());
        for _ in 0..60 {
            frame(visual);
        }
        window
            .read_with(visual, |shell, _| {
                assert_eq!(shell.spaces.pos, 1., "the track still rests on a space");
                assert!(shell.spaces.glide.is_none());
            })
            .unwrap();
        // The same after a swipe that a press interrupts before it settles.
        trackpad(visual, -0.4, 0., TouchPhase::Moved, FRAME);
        let space = visual.debug_bounds("project-space-3").unwrap();
        visual.simulate_mouse_down(space.center(), MouseButton::Left, Default::default());
        visual.executor().advance_clock(SETTLE_AFTER * 2);
        visual.run_until_parked();
        visual.simulate_mouse_up(space.center(), MouseButton::Left, Default::default());
        for _ in 0..60 {
            frame(visual);
        }
        assert_eq!(pos(window, visual), 1.);
    }

    #[test]
    fn the_settle_spring_starts_at_the_release_speed_and_never_overshoots() {
        let start = Instant::now();
        let glide = Glide::new(1.4, 2., 30., start);
        let mut last = 1.4;
        let mut done_at = None;
        for ms in 1..=600 {
            let (x, done) = glide.at(start + Duration::from_millis(ms));
            assert!(x >= last - 1e-5 && x <= 2. + 1e-5, "{ms} ms: {x}");
            last = x;
            if done && done_at.is_none() {
                done_at = Some(ms);
            }
        }
        let done_at = done_at.expect("the spring comes to rest");
        assert!(done_at < 450, "rests in {done_at} ms");
        let (early, _) = glide.at(start + Duration::from_millis(10));
        let (still, _) = Glide::new(1.4, 2., 0., start).at(start + Duration::from_millis(10));
        assert!(
            early - 1.4 > 0.1 && still - 1.4 < 0.02,
            "it keeps the release's speed: {early} against {still} from rest"
        );
        for raw in [-3., -0.5, 0., 0.7, 2., 2.4, 9.] {
            let shown = banded(raw, 2.);
            assert!((unbanded(shown, 2.) - raw).abs() < 1e-3, "{raw}");
            assert!(shown > -BAND && shown < 2. + BAND);
        }
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
