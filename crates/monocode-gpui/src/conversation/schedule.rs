//! Send later: the composer's time menu, the armed pill beside Send, and the
//! clock that releases scheduled follow-ups into the queue when they are due.
use super::*;
use crate::input::Input;
use crate::popover::{Menu, MenuAction, MenuEvent, MenuItem, MenuStyle, Popover, menu_popover};
use gpui::App;
use monocode_core::schedule::{self, Choice};

/// What a picked time applies to.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Target {
    /// The next message sent from the composer.
    Composer,
    /// A message already waiting in the queue.
    Queued(String),
}

pub(crate) struct Open {
    pub view: Entity<ScheduleMenu>,
    pub target: Target,
    anchor: Anchor,
    _picked: Subscription,
}

/// The trigger picker's search header, as a time field.
struct TimeField {
    input: Entity<Input>,
}
impl Render for TimeField {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .h(px(44.))
            .mx(px(-4.))
            .mt(px(-4.))
            .mb(px(4.))
            .px(px(12.))
            .border_b_1()
            .border_color(content(0.1))
            .flex()
            .items_center()
            .gap(px(10.))
            .child(icon("clock", 14.).text_color(content(0.45)))
            .child(div().flex_1().min_w_0().child(self.input.clone()))
    }
}

pub(crate) enum Picked {
    At(u64),
    Clear,
    Dismissed,
}
impl EventEmitter<Picked> for ScheduleMenu {}

/// A Menu whose rows follow what is typed in its time field.
pub(crate) struct ScheduleMenu {
    field: Entity<TimeField>,
    pub(crate) menu: Entity<Menu>,
    limit_reset: Option<schedule::Reset>,
    current: Option<u64>,
    clear: Option<&'static str>,
    _subscriptions: Vec<Subscription>,
}
impl ScheduleMenu {
    fn new(
        limit_reset: Option<schedule::Reset>,
        current: Option<u64>,
        clear: Option<&'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            Input::field(
                "Send at",
                "Type a time, like fri 9am or in 2h",
                content(0.35),
                cx,
            )
        });
        let field = cx.new(|_| TimeField {
            input: input.clone(),
        });
        let items = Self::items(&field, limit_reset.clone(), current, clear, cx);
        let menu = cx.new(|cx| {
            Menu::new("Send later", items, window, cx)
                .width(264.)
                .style(MenuStyle::Settings)
                .search_navigation()
        });
        let changed = cx.subscribe(&input, |this, _, _: &input::Changed, cx| this.refresh(cx));
        let picked = cx.subscribe(&menu, |_, _, event: &MenuEvent, cx| {
            cx.emit(match event {
                MenuEvent::Picked(id, _) if id.as_ref() == "clear" => Picked::Clear,
                MenuEvent::Picked(id, _) => {
                    match id.strip_prefix("at:").and_then(|at| at.parse().ok()) {
                        Some(at) => Picked::At(at),
                        None => Picked::Dismissed,
                    }
                }
                MenuEvent::Dismissed => Picked::Dismissed,
            });
        });
        Self {
            field,
            menu,
            limit_reset,
            current,
            clear,
            _subscriptions: vec![changed, picked],
        }
    }
    fn items(
        field: &Entity<TimeField>,
        limit_reset: Option<schedule::Reset>,
        current: Option<u64>,
        clear: Option<&'static str>,
        cx: &App,
    ) -> Vec<MenuItem> {
        let input = field.read(cx).input.read(cx);
        let query = input.content.to_string();
        let mut items = vec![MenuItem::Custom(
            field.clone().into(),
            input.focus_handle(cx),
        )];
        let row = |choice: Choice, value: String| -> MenuItem {
            MenuAction::new(format!("at:{}", choice.at), choice.label)
                .value(value)
                .checked(current == Some(choice.at))
                .into()
        };
        if query.trim().is_empty() {
            items.push(MenuItem::Header("Send later".into()));
            for choice in schedule::presets_now(limit_reset.clone()) {
                let value = schedule::short_now(choice.at);
                let limit = choice.id == "limit-reset";
                if limit {
                    items.push(MenuItem::Separator);
                }
                items.push(row(choice, value));
            }
            if let Some(clear) = clear {
                items.push(MenuItem::Separator);
                items.push(MenuAction::new("clear", clear).into());
            }
        } else {
            let choices = schedule::parse_now(&query);
            if choices.is_empty() {
                items.push(MenuItem::Note(
                    "Try 18:30, tomorrow 9am, fri evening or in 2h".into(),
                ));
            }
            for choice in choices.into_iter().take(4) {
                // A typed day already names the day; its value is the clock.
                let value = if choice.label.starts_with("In ") {
                    schedule::short_now(choice.at)
                } else {
                    gpui_time(choice.at)
                };
                items.push(row(choice, value));
            }
        }
        items
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let items = Self::items(
            &self.field,
            self.limit_reset.clone(),
            self.current,
            self.clear,
            cx,
        );
        self.menu.update(cx, |menu, cx| menu.set_items(items, cx));
        cx.notify();
    }
}

/// "09:00" in local time.
fn gpui_time(at: u64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(at as i64)
        .single()
        .map(|at| at.format("%H:%M").to_string())
        .unwrap_or_default()
}

impl Conversation {
    /// Local chats only: a remote host and a Mono deliver their own queues.
    pub(super) fn can_schedule(&self) -> bool {
        !self.is_remote() && self.settings.mono.is_none()
    }
    /// The follow-ups that would go out now, ignoring the ones that wait.
    pub(crate) fn unscheduled_follow_ups(&self) -> bool {
        self.follow_ups
            .state
            .messages
            .iter()
            .any(|m| !m.scheduled())
    }
    /// The chat's own limit first; otherwise the account's usage windows,
    /// so the row is there before the limit is hit.
    fn usage_reset(&self, cx: &mut Context<Self>) -> Option<schedule::Reset> {
        if let Some(at) = self
            .settings
            .usage_limit
            .as_ref()
            .and_then(|limit| limit.resets_at)
            .filter(|at| *at > 0)
        {
            return Some(schedule::Reset::limit(at as u64));
        }
        let center = crate::accounts::get(cx)?;
        let key = crate::accounts::Key::new(
            Kind::from_id(&self.summary.provider),
            self.settings.account.clone(),
            self.account_model(),
        );
        // Refresh a stale snapshot for next time; this menu uses what is cached.
        center.update(cx, |center, cx| center.refresh(key.clone(), false, cx));
        let snapshot = center.read(cx).usage.get(&key)?.snapshot.clone()?;
        schedule::Reset::from_usage(&snapshot, monocode_core::time::now_ms())
    }
    pub(super) fn open_schedule(
        &mut self,
        target: Target,
        anchor: Anchor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_schedule() {
            return;
        }
        if self
            .follow_ups
            .schedule
            .as_ref()
            .is_some_and(|open| open.target == target)
        {
            self.close_schedule(window, cx);
            return;
        }
        self.menu = None;
        self.completion
            .update(cx, |completion, cx| completion.dismiss(cx));
        let current = match &target {
            Target::Composer => self.follow_ups.armed,
            Target::Queued(id) => self
                .follow_ups
                .state
                .messages
                .iter()
                .find(|m| &m.id == id)
                .and_then(|m| m.send_at),
        };
        let limit = self.usage_reset(cx);
        let clear = match &target {
            Target::Composer => current.map(|_| "Don't send later"),
            Target::Queued(_) => Some("Send now"),
        };
        let view = cx.new(|cx| ScheduleMenu::new(limit, current, clear, window, cx));
        let picked = cx.subscribe_in(&view, window, |this, _, event: &Picked, window, cx| {
            let Some(target) = this.follow_ups.schedule.as_ref().map(|o| o.target.clone()) else {
                return;
            };
            match event {
                Picked::At(at) => this.apply_schedule(target, Some(*at), cx),
                Picked::Clear => this.apply_schedule(target, None, cx),
                Picked::Dismissed => {}
            }
            this.close_schedule(window, cx);
        });
        self.follow_ups.schedule = Some(Open {
            view,
            target,
            anchor,
            _picked: picked,
        });
        cx.notify();
    }
    fn close_schedule(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.follow_ups.schedule.take().is_some() {
            window.focus(&self.input.focus_handle(cx), cx);
            cx.notify();
        }
    }
    fn apply_schedule(&mut self, target: Target, at: Option<u64>, cx: &mut Context<Self>) {
        match target {
            Target::Composer => self.follow_ups.armed = at,
            Target::Queued(id) => match at {
                Some(at) => {
                    let Some(message) = self
                        .follow_ups
                        .state
                        .messages
                        .iter_mut()
                        .find(|m| m.id == id)
                    else {
                        return;
                    };
                    message.send_at = Some(at);
                    message.error = None;
                    self.save_follow_ups(cx);
                }
                None => self.send_scheduled_now(&id, cx),
            },
        }
        cx.notify();
    }
    /// Release a waiting message: it goes next, after any running turn.
    pub(super) fn send_scheduled_now(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(ix) = self
            .follow_ups
            .state
            .messages
            .iter()
            .position(|m| m.id == id)
        else {
            return;
        };
        let mut message = self.follow_ups.state.messages.remove(ix);
        message.send_at = None;
        message.error = None;
        message.steer = false;
        let front = self
            .follow_ups
            .state
            .messages
            .iter()
            .position(|m| !m.scheduled())
            .unwrap_or(self.follow_ups.state.messages.len());
        self.follow_ups
            .state
            .messages
            .insert(front.min(ix), message);
        if self.follow_ups.requested.is_none() {
            self.follow_ups.requested = Some(id.to_owned());
        } else if !self.follow_ups.continuations.iter().any(|c| c == id) {
            self.follow_ups.continuations.push_back(id.to_owned());
        }
        self.save_follow_ups(cx);
    }
    /// The composer's armed message joins the queue with its time.
    pub(super) fn schedule_message(
        &mut self,
        prompt: String,
        mode: Option<String>,
        at: u64,
        cx: &mut Context<Self>,
    ) {
        let attachments = std::mem::take(&mut self.attachments);
        let mut message = self.message(prompt, attachments, mode, cx);
        message.send_at = Some(at);
        self.follow_ups.motion.insert(
            &message.id,
            self.follow_ups.state.messages.is_empty(),
            !cx.reduce_motion(),
        );
        self.follow_ups.state.messages.push(message);
        self.save_follow_ups(cx);
    }
    /// Due messages leave their time behind and go next; ones that were due
    /// long ago (MonoCode closed, the Mac asleep) wait for the user instead.
    pub(crate) fn tick_schedule(&mut self, cx: &mut Context<Self>) {
        if !self.can_schedule() {
            return;
        }
        let now = monocode_core::time::now_ms();
        let due: Vec<String> = self
            .follow_ups
            .state
            .messages
            .iter()
            .filter(|m| {
                m.send_at
                    .is_some_and(|at| at <= now && !schedule::missed(at, now))
            })
            .map(|m| m.id.clone())
            .collect();
        if !due.is_empty() && self.needs_history_restore() {
            // A background chat whose rows were unloaded sends once they are back.
            self.defer_history_action(|this, cx| this.tick_schedule(cx), cx);
            return;
        }
        if !due.is_empty() && !self.loaded {
            // The load completion ticks again.
            return;
        }
        for id in &due {
            self.send_scheduled_now(id, cx);
        }
        self.arm_schedule(cx);
        cx.notify();
    }
    /// Wake exactly when the next message is due (re-checking each minute,
    /// so sleep and clock changes cannot strand it).
    pub(super) fn arm_schedule(&mut self, cx: &mut Context<Self>) {
        let now = monocode_core::time::now_ms();
        let next = self
            .follow_ups
            .state
            .messages
            .iter()
            .filter_map(|m| m.send_at)
            .filter(|at| !schedule::missed(*at, now))
            .min();
        let Some(next) = next else {
            self.follow_ups.schedule_timer = None;
            return;
        };
        let wait = next.saturating_sub(now).clamp(250, 60_000);
        self.follow_ups.schedule_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(wait))
                .await;
            let _ = this.update(cx, |this, cx| this.tick_schedule(cx));
        }));
    }

    pub(super) fn schedule_popover(&self, cx: &App) -> Option<Popover> {
        let open = self.follow_ups.schedule.as_ref()?;
        Some(
            menu_popover(&open.view.read(cx).menu, open.anchor.clone(), cx)
                .side(Side::Top)
                .gap(4.),
        )
    }
    /// The armed time beside Send: click to change it, × to drop it.
    pub(super) fn schedule_pill(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let at = self.follow_ups.armed?;
        let open = self
            .follow_ups
            .schedule
            .as_ref()
            .is_some_and(|o| o.target == Target::Composer);
        let accent = accent_color();
        Some(
            // tool_pill's metrics in the accent: one hover style per element.
            div()
                .id("composer-send-later")
                .role(Role::Button)
                .aria_label(format!("Sends {}. Change time", schedule::label_now(at)))
                .aria_expanded(open)
                .debug_selector(|| "composer-send-later".into())
                .cursor_pointer()
                .relative()
                .flex_shrink_0()
                .h(px(26.))
                .pl(px(6.))
                .pr(px(3.))
                .rounded_md()
                .flex()
                .items_center()
                .gap_1()
                .child(self.schedule_anchor.probe())
                .bg(accent.opacity(if open { 0.22 } else { 0.14 }))
                .hover(|s| s.bg(accent.opacity(0.22)))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .text_color(accent)
                .child(icon("clock", 14.).text_color(accent))
                .child(pill_label(schedule::label_now(at)))
                .child(
                    div()
                        .id("composer-send-later-clear")
                        .role(Role::Button)
                        .aria_label("Don't send later")
                        .size(px(18.))
                        .rounded(px(4.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .hover(|s| s.bg(accent.opacity(0.2)))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            this.follow_ups.armed = None;
                            cx.notify();
                        }))
                        .child(icon("close", 11.).text_color(accent)),
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    let anchor = Anchor::Slot(this.schedule_anchor.clone());
                    this.open_schedule(Target::Composer, anchor, window, cx);
                }))
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, WindowHandle};
    use monocode_core::store::Store;
    use std::sync::Mutex;

    fn conversation(cx: &mut TestAppContext) -> WindowHandle<Conversation> {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let summary = store.create("codex", "/tmp").unwrap();
        cx.update(|cx| {
            input::bind(cx);
            cx.set_global(crate::settings::Preferences {
                follow_up: "steer".into(),
                ..Default::default()
            });
            cx.open_window(Default::default(), |_, cx| {
                cx.new(|cx| {
                    let mut view = Conversation::new(summary, Arc::new(Mutex::new(store)), cx);
                    view.loaded = true;
                    view
                })
            })
            .unwrap()
        })
    }

    #[gpui::test]
    fn an_armed_message_waits_in_the_queue_until_its_time(cx: &mut TestAppContext) {
        let window = conversation(cx);
        let (controls, received) = std::sync::mpsc::channel();
        let now = monocode_core::time::now_ms();
        window
            .update(cx, |view, _, cx| {
                view.busy = true;
                view.controls = Some(controls);
                view.follow_ups.ready = true;
                view.follow_ups.armed = Some(now + 3_600_000);
                view.input
                    .update(cx, |i, cx| i.set_text("run the suite again".into(), cx));
                view.send(cx);
                assert!(view.input.read(cx).content.is_empty());
                assert!(view.follow_ups.armed.is_none(), "arming lasts one message");
                let message = &view.follow_ups.state.messages[0];
                assert_eq!(message.send_at, Some(now + 3_600_000));
                assert!(!message.steer, "a scheduled message never steers");
                assert!(!view.unscheduled_follow_ups());
            })
            .unwrap();
        cx.run_until_parked();
        assert!(
            received.try_recv().is_err(),
            "it must not go before its time"
        );
        window
            .update(cx, |view, _, cx| {
                let id = view.follow_ups.state.messages[0].id.clone();
                let index = locked(&view.store).unwrap().scheduled_sends().unwrap();
                assert_eq!(index.get(&view.summary.id), Some(&(now + 3_600_000)));
                // Its time comes during the turn: it goes next, as the queue does.
                view.follow_ups.state.messages[0].send_at = Some(now - 1_000);
                view.tick_schedule(cx);
                let message = &view.follow_ups.state.messages[0];
                assert_eq!(message.send_at, None);
                assert_eq!(view.follow_ups.requested.as_deref(), Some(id.as_str()));
                assert!(view.unscheduled_follow_ups());
            })
            .unwrap();
        cx.run_until_parked();
        window
            .update(cx, |view, _, _| {
                let index = locked(&view.store).unwrap().scheduled_sends().unwrap();
                assert!(index.is_empty(), "a released message leaves the index");
            })
            .unwrap();
    }

    #[gpui::test]
    fn a_missed_message_waits_for_the_user(cx: &mut TestAppContext) {
        let window = conversation(cx);
        let now = monocode_core::time::now_ms();
        window
            .update(cx, |view, _, cx| {
                let mut message = view.message("stale".into(), Vec::new(), None, cx);
                message.send_at = Some(now - schedule::MISSED_AFTER_MS - 60_000);
                let id = message.id.clone();
                view.follow_ups.state.messages.push(message);
                view.tick_schedule(cx);
                assert!(view.follow_ups.state.messages[0].scheduled());
                assert!(view.follow_ups.requested.is_none());
                // Send now releases it by hand.
                view.send_scheduled_now(&id, cx);
                assert!(!view.follow_ups.state.messages[0].scheduled());
                assert_eq!(view.follow_ups.requested.as_deref(), Some(id.as_str()));
            })
            .unwrap();
    }

    #[gpui::test]
    fn rescheduling_and_dropping_the_armed_time(cx: &mut TestAppContext) {
        let window = conversation(cx);
        let now = monocode_core::time::now_ms();
        window
            .update(cx, |view, _, cx| {
                view.apply_schedule(Target::Composer, Some(now + 60_000), cx);
                assert_eq!(view.follow_ups.armed, Some(now + 60_000));
                view.apply_schedule(Target::Composer, None, cx);
                assert_eq!(view.follow_ups.armed, None);
                let mut message = view.message("later".into(), Vec::new(), None, cx);
                message.send_at = Some(now + 60_000);
                let id = message.id.clone();
                view.follow_ups.state.messages.push(message);
                view.apply_schedule(Target::Queued(id.clone()), Some(now + 120_000), cx);
                assert_eq!(
                    view.follow_ups.state.messages[0].send_at,
                    Some(now + 120_000)
                );
            })
            .unwrap();
    }
}
