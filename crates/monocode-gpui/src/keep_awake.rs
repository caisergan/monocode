//! Keep awake: holds macOS idle sleep off while agents work, for a set time,
//! or until stopped. A footer chip shows how many chats hold the Mac and for
//! how long; its popover picks the mode. Everything follows the picked accent.
mod dial;
mod lid;
mod power;

use crate::popover::{Align, Anchor, AnchorSlot, Side, popover};
use crate::pulse::{self, Rate};
use crate::settings::Preferences;
use crate::theme::*;
use dial::Arc;
use gpui::{
    AnyElement, App, Context, EventEmitter, FocusHandle, FontWeight, Hsla, KeyBinding, MouseButton,
    Role, SharedString, Window, actions, div, prelude::*, px,
};
use std::time::Duration;

actions!(keep_awake, [DismissKeepAwake, OpenKeepAwake]);

pub(crate) fn bind(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("escape", DismissKeepAwake, Some("KeepAwakeDetails")),
        KeyBinding::new("enter", OpenKeepAwake, Some("KeepAwakeChip")),
        KeyBinding::new("space", OpenKeepAwake, Some("KeepAwakeChip")),
    ]);
}

/// The keybinding table's name for the start/stop shortcut.
pub(crate) const COMMAND: &str = "App: Toggle Keep Awake";
/// Agents mode keeps holding this long after the last turn ends, so the Mac
/// does not doze off between turns.
const GRACE_MS: u64 = 2 * 60_000;
/// A scheduled send due this soon holds the Mac in agents mode.
pub(crate) const SCHEDULED_SOON_MS: u64 = 10 * 60_000;
const STEAM: Duration = Duration::from_millis(2_400);
const ORBIT: Duration = Duration::from_millis(4_800);
const BREATHE: Duration = Duration::from_millis(1_600);
/// The most chats the popover lists before "and N more".
const LISTED: usize = 4;
/// A failed pmset call for lid mode retries this often.
const LID_RETRY_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    /// While any chat is mid-turn or a scheduled send is due soon.
    Agents,
    Hours(u32),
    Always,
}
const MODES: [Mode; 5] = [
    Mode::Agents,
    Mode::Hours(1),
    Mode::Hours(2),
    Mode::Hours(4),
    Mode::Always,
];
impl Mode {
    pub(crate) fn from_id(id: &str) -> Self {
        match id {
            "1h" => Mode::Hours(1),
            "2h" => Mode::Hours(2),
            "4h" => Mode::Hours(4),
            "always" => Mode::Always,
            _ => Mode::Agents,
        }
    }
    fn tile(self) -> (&'static str, &'static str) {
        match self {
            Mode::Agents => ("sparkles", "Agents"),
            Mode::Hours(1) => ("keep-awake-1h", "1 h"),
            Mode::Hours(2) => ("keep-awake-2h", "2 h"),
            Mode::Hours(_) => ("keep-awake-4h", "4 h"),
            Mode::Always => ("infinity", "Always"),
        }
    }
    fn name(self) -> String {
        match self {
            Mode::Agents => "While agents work".into(),
            Mode::Hours(1) => "For 1 hour".into(),
            Mode::Hours(h) => format!("For {h} hours"),
            Mode::Always => "Until turned off".into(),
        }
    }
}

/// A chat mid-turn, holding the Mac in agents mode.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Holder {
    pub id: i64,
    pub title: SharedString,
    pub provider: String,
    /// When its turn began, in epoch ms.
    pub since: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Session {
    mode: Mode,
    started: u64,
    ends: Option<u64>,
}

pub(crate) enum KeepAwakeEvent {
    OpenSettings,
    OpenSession(i64),
}

/// Lid-closed mode's state: pmset runs off the main thread, one call at a time.
#[derive(Default)]
struct Lid {
    status: lid::Status,
    /// Sleep is off for this app's session.
    held: Option<lid::Engaged>,
    busy: bool,
    installing: bool,
    /// When the last pmset call failed, so failures retry slowly.
    failed_at: Option<u64>,
}

enum LidOutcome {
    Engaged(lid::Engaged),
    Released,
    NeedsSetup,
    Failed(String),
}

pub(crate) struct KeepAwake {
    session: Option<Session>,
    /// Why the last session ended on its own, shown until the next one.
    stopped: Option<SharedString>,
    holders: Vec<Holder>,
    scheduled_soon: usize,
    /// When the last chat stopped working, for agents mode's grace period.
    last_busy: Option<u64>,
    /// Since when sleep has been blocked without a break.
    holding_since: Option<u64>,
    assertions: power::Assertions,
    verified: bool,
    battery: power::Battery,
    schedule: Option<power::Schedule>,
    // Preferences
    footer: bool,
    default_mode: Mode,
    keep_display: bool,
    keep_lid: bool,
    battery_floor: u32,
    shortcut: Option<String>,
    lid: Lid,
    // Chip and popover
    open: bool,
    classic: bool,
    anchor: AnchorSlot,
    trigger: FocusHandle,
    details: FocusHandle,
    previous_focus: Option<FocusHandle>,
    ticking: bool,
    shown: String,
}

impl EventEmitter<KeepAwakeEvent> for KeepAwake {}

fn now_ms() -> u64 {
    monocode_core::time::now_ms()
}

impl KeepAwake {
    pub(crate) fn new(prefs: &Preferences, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            session: None,
            stopped: None,
            holders: Vec::new(),
            scheduled_soon: 0,
            last_busy: None,
            holding_since: None,
            assertions: power::Assertions::default(),
            verified: true,
            battery: power::Battery::default(),
            schedule: None,
            footer: false,
            default_mode: Mode::Agents,
            keep_display: false,
            keep_lid: false,
            battery_floor: 0,
            shortcut: None,
            lid: Lid::default(),
            open: false,
            classic: false,
            anchor: AnchorSlot::default(),
            trigger: cx.focus_handle(),
            details: cx.focus_handle(),
            previous_focus: None,
            ticking: false,
            shown: String::new(),
        };
        this.apply(prefs);
        this.start_lid(cx);
        this
    }

    /// Undo sleep a crashed run left off, learn whether pmset is set up,
    /// and turn sleep back on when the app quits.
    fn start_lid(&mut self, cx: &mut Context<Self>) {
        let work = cx.background_executor().spawn(async {
            lid::recover();
            lid::ready()
        });
        cx.spawn(async move |this, cx| {
            let ready = work.await;
            let _ = this.update(cx, |this, cx| {
                if this.lid.status == lid::Status::Unknown {
                    this.lid.status = if ready {
                        lid::Status::Ready
                    } else {
                        lid::Status::NeedsSetup
                    };
                }
                this.drive_lid(now_ms(), cx);
                cx.notify();
            });
        })
        .detach();
        cx.on_app_quit(|this, _| {
            if this.lid.held == Some(lid::Engaged::Owned) {
                let _ = lid::release();
                this.lid.held = None;
            }
            async {}
        })
        .detach();
    }

    fn lid_wanted(&self, now: u64) -> bool {
        self.keep_lid && self.holding_at(now)
    }

    /// Make pmset's sleep setting follow whether lid mode should hold now.
    fn drive_lid(&mut self, now: u64, cx: &mut Context<Self>) {
        let want = self.lid_wanted(now);
        let lid = &mut self.lid;
        if lid.busy || lid.installing || want == lid.held.is_some() {
            return;
        }
        if want && matches!(lid.status, lid::Status::NeedsSetup | lid::Status::Unknown) {
            return;
        }
        if lid
            .failed_at
            .is_some_and(|at| now.saturating_sub(at) < LID_RETRY_MS)
        {
            return;
        }
        if !want && lid.held == Some(lid::Engaged::Borrowed) {
            lid.held = None;
            return;
        }
        lid.busy = true;
        let work = cx.background_executor().spawn(async move {
            if !want {
                return match lid::release() {
                    Ok(()) => LidOutcome::Released,
                    Err(e) => LidOutcome::Failed(e),
                };
            }
            if !lid::ready() {
                return LidOutcome::NeedsSetup;
            }
            match lid::engage() {
                Ok(engaged) => LidOutcome::Engaged(engaged),
                Err(e) => LidOutcome::Failed(e),
            }
        });
        cx.spawn(async move |this, cx| {
            let outcome = work.await;
            let _ = this.update(cx, |this, cx| {
                this.lid.busy = false;
                this.lid_outcome(outcome);
                this.drive_lid(now_ms(), cx);
                this.ensure_tick(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn lid_outcome(&mut self, outcome: LidOutcome) {
        let lid = &mut self.lid;
        lid.failed_at = None;
        match outcome {
            LidOutcome::Engaged(engaged) => {
                lid.held = Some(engaged);
                lid.status = lid::Status::Ready;
            }
            LidOutcome::Released => {
                lid.held = None;
                lid.status = lid::Status::Ready;
            }
            LidOutcome::NeedsSetup => lid.status = lid::Status::NeedsSetup,
            LidOutcome::Failed(error) => {
                lid.status = lid::Status::Failed(error);
                lid.failed_at = Some(now_ms());
            }
        }
    }

    /// Install the sudoers rule behind macOS's admin password sheet.
    fn set_up_lid(&mut self, cx: &mut Context<Self>) {
        if self.lid.installing {
            return;
        }
        self.lid.installing = true;
        cx.notify();
        let work = cx
            .background_executor()
            .spawn(async { lid::install().map(|()| lid::ready()) });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                this.lid.installing = false;
                this.lid.failed_at = None;
                this.lid.status = match result {
                    Ok(true) => lid::Status::Ready,
                    Ok(false) => lid::Status::Failed("sudo still asks for a password".into()),
                    Err(e) if e == "Cancelled" => lid::Status::NeedsSetup,
                    Err(e) => lid::Status::Failed(e),
                };
                this.drive_lid(now_ms(), cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn apply(&mut self, prefs: &Preferences) {
        self.footer = prefs.keep_awake_footer;
        self.default_mode = Mode::from_id(&prefs.keep_awake_mode);
        self.keep_display = prefs.keep_awake_display;
        self.keep_lid = prefs.keep_awake_lid;
        self.battery_floor = prefs.keep_awake_battery;
        self.shortcut = crate::settings::command_shortcut(prefs, COMMAND);
    }

    pub(crate) fn set_preferences(&mut self, prefs: &Preferences, cx: &mut Context<Self>) {
        self.apply(prefs);
        self.sync(cx);
    }

    pub(crate) fn set_classic(&mut self, classic: bool, cx: &mut Context<Self>) {
        if self.classic != classic {
            self.classic = classic;
            cx.notify();
        }
    }

    /// The chip shows once Settings turns it on, and always while a session
    /// runs, so a shortcut-started session is never hidden.
    pub(crate) fn visible(&self) -> bool {
        cfg!(target_os = "macos") && (self.footer || self.session.is_some())
    }

    pub(crate) fn set_holders(&mut self, holders: Vec<Holder>, cx: &mut Context<Self>) {
        if holders == self.holders {
            return;
        }
        if holders.is_empty() {
            self.last_busy = Some(now_ms());
        }
        self.holders = holders;
        self.sync(cx);
    }

    pub(crate) fn set_scheduled_soon(&mut self, count: usize, cx: &mut Context<Self>) {
        if self.scheduled_soon != count {
            self.scheduled_soon = count;
            self.sync(cx);
        }
    }

    /// ⌥⌘A: stop a running session, or start the default mode.
    pub(crate) fn toggle_session(&mut self, cx: &mut Context<Self>) {
        if self.session.is_some() {
            self.stop(None, cx);
        } else {
            self.start(self.default_mode, cx);
        }
    }

    fn start(&mut self, mode: Mode, cx: &mut Context<Self>) {
        let now = now_ms();
        self.session = Some(Session {
            mode,
            started: now,
            ends: match mode {
                Mode::Hours(h) => Some(now + u64::from(h) * 3_600_000),
                _ => None,
            },
        });
        self.stopped = None;
        self.battery = power::battery();
        self.ensure_tick(cx);
        self.sync(cx);
    }

    /// Pick a mode tile: start it, or switch the running session to it.
    fn choose(&mut self, mode: Mode, cx: &mut Context<Self>) {
        if self.session.is_some_and(|s| s.mode == mode) {
            return;
        }
        self.start(mode, cx);
    }

    fn extend(&mut self, minutes: u64, cx: &mut Context<Self>) {
        if let Some(Session {
            ends: Some(ends), ..
        }) = &mut self.session
        {
            *ends += minutes * 60_000;
            self.sync(cx);
        }
    }

    fn stop(&mut self, reason: Option<SharedString>, cx: &mut Context<Self>) {
        self.session = None;
        self.stopped = reason;
        self.sync(cx);
        if self.open {
            self.load_schedule(cx);
        }
    }

    fn holding_at(&self, now: u64) -> bool {
        let Some(session) = self.session else {
            return false;
        };
        match session.mode {
            Mode::Agents => {
                !self.holders.is_empty()
                    || self.scheduled_soon > 0
                    || self.last_busy.is_some_and(|at| {
                        at >= session.started && now.saturating_sub(at) < GRACE_MS
                    })
            }
            Mode::Hours(_) => session.ends.is_some_and(|ends| now < ends),
            Mode::Always => true,
        }
    }

    /// End a session that ran out or hit the battery floor, then make the
    /// assertions match whether sleep should be blocked now.
    fn settle(&mut self, now: u64) {
        if let Some(session) = self.session {
            if let Some(ends) = session.ends.filter(|&ends| now >= ends) {
                self.session = None;
                self.stopped =
                    Some(format!("Ended at {}", monocode_core::schedule::short_now(ends)).into());
            } else if self.battery_floor > 0
                && self.battery.on_battery
                && let Some(percent) = self.battery.percent
                && u32::from(percent) < self.battery_floor
            {
                self.session = None;
                self.stopped = Some(format!("Stopped at {percent}% battery").into());
            }
        }
        let hold = self.holding_at(now);
        match (hold, self.holding_since) {
            (true, None) => self.holding_since = Some(now),
            (false, Some(_)) => self.holding_since = None,
            _ => {}
        }
        let display = hold && self.keep_display;
        if self.assertions.holds_system() != hold || self.assertions.holds_display() != display {
            self.assertions.sync(hold, display);
            self.verified = self.assertions.verified();
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        self.settle(now_ms());
        self.drive_lid(now_ms(), cx);
        self.shown = self.signature(now_ms());
        cx.notify();
    }

    /// A one-second clock while a session runs: it ends timed sessions,
    /// lets agents mode's grace period lapse and keeps the labels current.
    fn ensure_tick(&mut self, cx: &mut Context<Self>) {
        if self.ticking {
            return;
        }
        self.ticking = true;
        cx.spawn(async move |this, cx| {
            let mut beat = 0u32;
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                beat = beat.wrapping_add(1);
                let live = this
                    .update(cx, |this, cx| this.tick(beat, cx))
                    .unwrap_or(false);
                if !live {
                    break;
                }
            }
        })
        .detach();
    }

    fn tick(&mut self, beat: u32, cx: &mut Context<Self>) -> bool {
        // Keep ticking while lid mode still has sleep to turn back on.
        if self.session.is_none() && self.lid.held.is_none() && !self.lid.busy {
            self.ticking = false;
            return false;
        }
        if beat.is_multiple_of(30) {
            self.battery = power::battery();
        }
        if self.open && beat.is_multiple_of(10) {
            self.verified = self.assertions.verified();
        }
        let now = now_ms();
        self.settle(now);
        self.drive_lid(now, cx);
        let shown = self.signature(now);
        if self.open || shown != self.shown {
            self.shown = shown;
            cx.notify();
        }
        true
    }

    /// What the chip shows, so the clock only redraws when it changes.
    fn signature(&self, now: u64) -> String {
        let (count, time) = self.chip_text(now);
        format!("{count:?}{time:?}{}", self.holding_at(now))
    }

    fn load_schedule(&mut self, cx: &mut Context<Self>) {
        let work = cx.background_executor().spawn(async { power::schedule() });
        cx.spawn(async move |this, cx| {
            let schedule = work.await;
            let _ = this.update(cx, |this, cx| {
                this.schedule = Some(schedule);
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            self.dismiss(window, cx);
            return;
        }
        self.previous_focus = window.focused(cx).filter(|f| *f != self.trigger);
        self.open = true;
        self.battery = power::battery();
        self.verified = self.assertions.verified();
        if self.session.is_none() {
            self.load_schedule(cx);
        }
        window.focus(&self.details, cx);
        cx.notify();
    }

    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        window.focus(self.previous_focus.as_ref().unwrap_or(&self.trigger), cx);
        cx.notify();
    }

    /// The chip's working count and time: `None` count when no chat works,
    /// and no time when nothing holds the Mac.
    fn chip_text(&self, now: u64) -> (Option<String>, Option<String>) {
        let Some(session) = self.session else {
            return (None, None);
        };
        let hold = self.holding_at(now);
        if !hold {
            return (None, Some("Agents".into()));
        }
        let count = (!self.holders.is_empty()).then(|| format!("{} working", self.holders.len()));
        let time = match (session.mode, session.ends) {
            (_, Some(ends)) => Some(format!("{} left", remaining(ends.saturating_sub(now)))),
            // How long agents mode lasts is up to the agents, so it shows
            // only who is working, or "Awake" through the grace period.
            (Mode::Agents, None) => count.is_none().then(|| "Awake".to_owned()),
            (_, None) => Some(elapsed_short(
                now.saturating_sub(self.holding_since.unwrap_or(now)),
            )),
        };
        (count, time)
    }
}

/// "<1m", "24m", "2h 41m": time held so far.
fn elapsed_short(ms: u64) -> String {
    let minutes = ms / 60_000;
    match minutes {
        0 => "<1m".into(),
        1..60 => format!("{minutes}m"),
        _ if minutes.is_multiple_of(60) => format!("{}h", minutes / 60),
        _ => format!("{}h {}m", minutes / 60, minutes % 60),
    }
}

/// "24 min", "1 h 12 min": the popover's longer spelling.
fn elapsed_long(ms: u64) -> String {
    minutes_long(ms / 60_000).unwrap_or_else(|| "under a minute".into())
}

fn minutes_long(minutes: u64) -> Option<String> {
    Some(match minutes {
        0 => return None,
        1..60 => format!("{minutes} min"),
        _ if minutes.is_multiple_of(60) => format!("{} h", minutes / 60),
        _ => format!("{} h {} min", minutes / 60, minutes % 60),
    })
}

/// "45s", "9m", "1h 9m": time left, rounded up so it never reads zero early.
fn remaining(ms: u64) -> String {
    let seconds = ms.div_ceil(1_000);
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = ms.div_ceil(60_000);
    match minutes {
        1..60 => format!("{minutes}m"),
        _ if minutes.is_multiple_of(60) => format!("{}h", minutes / 60),
        _ => format!("{}h {}m", minutes / 60, minutes % 60),
    }
}

/// "2-hour session", "2h 30m session".
fn session_label(total_ms: u64) -> String {
    let minutes = total_ms / 60_000;
    match (minutes / 60, minutes % 60) {
        (1, 0) => "1-hour session".into(),
        (h, 0) => format!("{h}-hour session"),
        (0, m) => format!("{m}-minute session"),
        (h, m) => format!("{h}h {m}m session"),
    }
}

/// A pmset timer: "10 min", "1 h", "Never".
fn timer_label(minutes: Option<u32>) -> String {
    match minutes {
        None => "…".into(),
        Some(0) => "Never".into(),
        Some(m) => minutes_long(u64::from(m)).unwrap_or_default(),
    }
}

/// The steam's phase while `hold`, on the shared clock.
fn cup_mark(id: &'static str, side: f32, color: Hsla, hold: bool) -> AnyElement {
    if hold {
        pulse::looping(id, STEAM, Rate::Smooth, move |phase| {
            dial::cup(side, color, Some(phase))
        })
        .into_any_element()
    } else {
        dial::cup(side, color, None).into_any_element()
    }
}

impl KeepAwake {
    fn chip(&self, now: u64, cx: &mut Context<Self>) -> AnyElement {
        let accent = picked_accent();
        let hold = self.holding_at(now);
        let timed = self
            .session
            .and_then(|s| s.ends.map(|ends| (s.started, ends)));
        let (count, time) = self.chip_text(now);
        // Off, it names itself the way Build and Terminal do.
        let time = time.or_else(|| self.session.is_none().then(|| "Keep awake".to_owned()));
        let color = if hold {
            accent
        } else if self.session.is_some() {
            content(0.5)
        } else {
            content(0.4)
        };
        let mark = match timed {
            Some((started, ends)) if hold => {
                let left = ends.saturating_sub(now) as f32 / (ends - started).max(1) as f32;
                dial::ring(
                    14.,
                    2.,
                    accent.opacity(0.25),
                    Some(Arc {
                        start: 0.,
                        length: left,
                        color: accent,
                        dot: false,
                    }),
                )
                .into_any_element()
            }
            _ => cup_mark("keep-awake-chip-steam", 14., color, hold),
        };
        let label = match (&count, &time) {
            (Some(count), Some(time)) => format!("Keep awake: {count}, {time}"),
            (None, Some(_)) if self.session.is_none() => "Keep Mac awake".into(),
            (None, Some(time)) => format!("Keep awake: {time}"),
            _ => "Keep Mac awake".into(),
        };
        let classic = self.classic;
        div()
            .id("keep-awake-chip")
            .debug_selector(|| "keep-awake-chip".into())
            .role(Role::Button)
            .aria_label(label)
            .aria_expanded(self.open)
            .track_focus(&self.trigger)
            .key_context("KeepAwakeChip")
            .tab_index(0)
            .relative()
            .h(px(20.))
            .map(|d| {
                if classic {
                    d.px(px(6.)).rounded_md()
                } else {
                    d.px(px(8.)).rounded_full()
                }
            })
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(6.))
            .whitespace_nowrap()
            .text_size(px(11.))
            .text_color(color)
            .cursor_pointer()
            .when(self.open, |d| d.bg(content(0.1)))
            .hover(move |s| {
                let s = s.bg(content(0.1));
                if hold { s } else { s.text_color(content(1.)) }
            })
            .child(self.anchor.probe())
            .child(mark)
            .when_some(count.clone(), |d, count| d.child(count))
            .when(count.is_some() && time.is_some(), |d| {
                d.child(div().size(px(3.)).rounded_full().bg(color.opacity(0.45)))
            })
            .when_some(time, |d, time| d.child(time))
            .on_click(cx.listener(|this, _, window, cx| this.toggle_open(window, cx)))
            // A right click stops a running session straight away.
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    if this.session.is_some() {
                        this.stop(None, cx);
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &OpenKeepAwake, window, cx| this.toggle_open(window, cx)),
            )
            .into_any_element()
    }

    fn details(&self, now: u64, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("keep-awake-details")
            .role(Role::Dialog)
            .aria_label("Keep Mac awake")
            .track_focus(&self.details)
            .key_context("KeepAwakeDetails")
            .on_action(
                cx.listener(|this, _: &DismissKeepAwake, window, cx| this.dismiss(window, cx)),
            )
            .flex()
            .flex_col()
            .text_size(px(11.))
            .text_color(content(1.))
            .child(self.hero(now, cx))
            .child(self.rail(cx))
            .child(self.card(now, cx))
            .when_some(self.lid_row(cx), |d, row| d.child(row))
            .child(div().mt(px(8.)).h(px(1.)).mx(px(6.)).bg(content(0.07)))
            .child(self.foot(now, cx))
            .into_any_element()
    }

    fn hero(&self, now: u64, cx: &mut Context<Self>) -> AnyElement {
        let accent = picked_accent();
        let hold = self.holding_at(now);
        let working = self.holders.len();
        let agents = match working {
            1 => "1 agent working".to_owned(),
            n => format!("{n} agents working"),
        };
        let (title, aside, sub): (String, Option<String>, String) = match self.session {
            None => (
                "Sleeping normally".into(),
                None,
                self.stopped
                    .as_ref()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "Your Mac follows its schedule".into()),
            ),
            Some(_) if !hold => (
                "Ready".into(),
                None,
                "Waits for an agent to start working".into(),
            ),
            Some(Session {
                ends: Some(ends), ..
            }) => (remaining(ends.saturating_sub(now)), Some("left".into()), {
                let until = format!("until {}", monocode_core::schedule::short_now(ends));
                if working > 0 {
                    format!("{agents} · {until}")
                } else {
                    format!("Awake {until}")
                }
            }),
            Some(s) => (
                "Awake".into(),
                (s.mode != Mode::Agents).then(|| {
                    format!(
                        "for {}",
                        elapsed_long(now.saturating_sub(self.holding_since.unwrap_or(now)))
                    )
                }),
                if working > 0 {
                    agents
                } else if self.scheduled_soon > 0 {
                    "A scheduled send is due soon".into()
                } else if s.mode == Mode::Always {
                    "Until you stop it".into()
                } else {
                    "Letting go shortly".into()
                },
            ),
        };
        let ring_arc = match self.session {
            Some(Session {
                started,
                ends: Some(ends),
                ..
            }) if hold => Some((
                0.,
                ends.saturating_sub(now) as f32 / (ends - started).max(1) as f32,
                true,
            )),
            _ => None,
        };
        let ring = if let Some((start, length, dot)) = ring_arc {
            dial::ring(
                44.,
                2.,
                dial::track(),
                Some(Arc {
                    start,
                    length,
                    color: accent,
                    dot,
                }),
            )
            .into_any_element()
        } else if hold {
            pulse::looping("keep-awake-orbit", ORBIT, Rate::Smooth, move |phase| {
                dial::ring(
                    44.,
                    2.,
                    dial::track(),
                    Some(Arc {
                        start: phase,
                        length: 0.24,
                        color: accent,
                        dot: false,
                    }),
                )
            })
            .into_any_element()
        } else {
            dial::ring(44., 2., dial::track(), None).into_any_element()
        };
        let cup_color = if hold {
            accent
        } else if self.session.is_some() {
            content(0.65)
        } else {
            content(0.5)
        };
        let dial = div()
            .relative()
            .size(px(44.))
            .flex_shrink_0()
            .when(hold, |d| {
                d.child(
                    div()
                        .absolute()
                        .top(px(7.))
                        .left(px(7.))
                        .size(px(30.))
                        .rounded_full()
                        .bg(accent.opacity(0.1)),
                )
            })
            .child(div().absolute().top_0().left_0().child(ring))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(cup_mark("keep-awake-dial-steam", 20., cup_color, hold)),
            );
        let running = self.session.is_some();
        let button = div()
            .id("keep-awake-start-stop")
            .role(Role::Switch)
            .aria_label("Keep Mac awake")
            .aria_toggled(if running {
                gpui::Toggled::True
            } else {
                gpui::Toggled::False
            })
            .flex_shrink_0()
            .cursor_pointer()
            .hover(|s| s.opacity(0.9))
            .child(Self::switch_track(running, 34., 20.))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_session(cx)));
        div()
            .flex()
            .items_center()
            .gap(px(12.))
            .px(px(6.))
            .pt(px(8.))
            .pb(px(12.))
            .child(dial)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .gap(px(6.))
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(if running { content(1.) } else { content(0.8) })
                            .child(title)
                            .when_some(aside, |d, aside| {
                                d.child(
                                    div()
                                        .text_size(px(11.))
                                        .font_weight(FontWeight::NORMAL)
                                        .text_color(content(0.5))
                                        .child(aside),
                                )
                            }),
                    )
                    .child(
                        div()
                            .mt(px(1.))
                            .text_color(content(0.5))
                            .truncate()
                            .child(sub),
                    ),
            )
            .child(button)
            .into_any_element()
    }

    fn rail(&self, cx: &mut Context<Self>) -> AnyElement {
        let accent = picked_accent();
        let active = self.session.map(|s| s.mode);
        let chosen = active.unwrap_or(self.default_mode);
        div()
            .id("keep-awake-modes")
            .grid()
            .grid_cols(5)
            .gap(px(4.))
            .px(px(2.))
            .pb(px(8.))
            .role(Role::RadioGroup)
            .aria_label("Keep awake mode")
            .children(MODES.iter().enumerate().map(|(ix, &mode)| {
                let (glyph, label) = mode.tile();
                let selected = mode == chosen;
                let lit = selected && active.is_some();
                div()
                    .id(("keep-awake-mode", ix))
                    .role(Role::RadioButton)
                    .aria_label(mode.name())
                    .aria_toggled(if selected {
                        gpui::Toggled::True
                    } else {
                        gpui::Toggled::False
                    })
                    .h(px(46.))
                    .rounded(px(8.))
                    .border_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(4.))
                    .text_size(px(10.))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .map(|d| {
                        let (fill, edge, ink) = if lit {
                            (accent.opacity(0.1), accent.opacity(0.32), accent)
                        } else if selected {
                            (content(0.06), content(0.1), content(0.8))
                        } else {
                            (
                                gpui::transparent_black(),
                                gpui::transparent_black(),
                                content(0.5),
                            )
                        };
                        d.bg(fill)
                            .border_color(edge)
                            .text_color(ink)
                            .child(icon(glyph, 16.).text_color(ink))
                    })
                    .when(!lit, |d| {
                        d.hover(|s| s.bg(content(0.06)).text_color(content(0.8)))
                    })
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| this.choose(mode, cx)))
            }))
            .into_any_element()
    }

    fn card_frame() -> gpui::Div {
        div()
            .mx(px(2.))
            .rounded(px(8.))
            .bg(content(0.045))
            .border_1()
            .border_color(content(0.06))
            .px(px(10.))
            .pt(px(9.))
            .pb(px(8.))
    }

    fn card_top(
        label: impl Into<SharedString>,
        value: impl Into<SharedString>,
        dim: bool,
    ) -> gpui::Div {
        div()
            .flex()
            .justify_between()
            .items_baseline()
            .gap(px(10.))
            .font_weight(FontWeight::MEDIUM)
            .child(div().text_color(content(0.65)).child(label.into()))
            .child(
                div()
                    .flex_shrink_0()
                    .text_color(if dim { content(0.5) } else { content(1.) })
                    .child(value.into()),
            )
    }

    fn meta(left: impl IntoElement, right: impl IntoElement) -> gpui::Div {
        div()
            .mt(px(7.))
            .flex()
            .justify_between()
            .items_center()
            .gap(px(10.))
            .text_size(px(10.))
            .line_height(px(16.))
            .text_color(content(0.4))
            .child(div().truncate().child(left))
            .child(div().flex_shrink_0().child(right))
    }

    fn card(&self, now: u64, cx: &mut Context<Self>) -> AnyElement {
        let accent = picked_accent();
        match self.session {
            None => {
                let schedule = self.schedule.unwrap_or_default();
                let loaded = self.schedule.is_some();
                let row = |label: &'static str, value: String| {
                    div()
                        .flex()
                        .justify_between()
                        .gap(px(10.))
                        .text_color(content(0.65))
                        .child(label)
                        .child(div().text_color(content(1.)).child(value))
                };
                Self::card_frame()
                    .child(Self::card_top(
                        "Your sleep schedule",
                        if self.battery.on_battery {
                            "On battery"
                        } else {
                            "On power"
                        },
                        true,
                    ))
                    .child(
                        div()
                            .mt(px(7.))
                            .flex()
                            .flex_col()
                            .gap(px(5.))
                            .child(row(
                                "Display turns off",
                                if loaded {
                                    timer_label(schedule.display)
                                } else {
                                    "…".into()
                                },
                            ))
                            .child(row(
                                "Mac sleeps",
                                if loaded {
                                    timer_label(schedule.system)
                                } else {
                                    "…".into()
                                },
                            )),
                    )
                    .child(Self::meta("From System Settings › Energy", ""))
                    .into_any_element()
            }
            Some(Session {
                started,
                ends: Some(ends),
                ..
            }) => {
                let total = ends.saturating_sub(started).max(1);
                let left = ends.saturating_sub(now) as f32 / total as f32;
                let extend = |id: &'static str, label: &'static str, minutes: u64| {
                    div()
                        .id(id)
                        .role(Role::Button)
                        .aria_label(format!("Add {label}"))
                        .cursor_pointer()
                        .hover(|s| s.text_color(content(1.)))
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| this.extend(minutes, cx)))
                };
                Self::card_frame()
                    .child(Self::card_top(
                        session_label(total),
                        format!("{:.0}% left", (left * 100.).clamp(0., 100.)),
                        false,
                    ))
                    .child(
                        div()
                            .mt(px(8.))
                            .h(px(6.))
                            .w_full()
                            .rounded_full()
                            .bg(content(0.1))
                            .overflow_hidden()
                            .child(
                                div()
                                    .h_full()
                                    .w(gpui::relative(left.clamp(0., 1.)))
                                    .rounded_full()
                                    .bg(accent),
                            ),
                    )
                    .child(Self::meta(
                        format!("Started {}", monocode_core::schedule::short_now(started)),
                        div()
                            .flex()
                            .gap(px(6.))
                            .child(extend("keep-awake-add-30", "+30 min", 30))
                            .child("·")
                            .child(extend("keep-awake-add-60", "+1 h", 60)),
                    ))
                    .into_any_element()
            }
            Some(session) => {
                let count = self.holders.len();
                let value = match count {
                    0 => "No chats working".to_owned(),
                    1 => "1 chat".to_owned(),
                    n => format!("{n} chats"),
                };
                let hint = if session.mode == Mode::Always {
                    "Stays on until you stop it".to_owned()
                } else if count == 0 && self.scheduled_soon > 0 {
                    "Holding for a scheduled send".to_owned()
                } else {
                    "Lets go 2 min after the last turn".to_owned()
                };
                let since = self
                    .holding_since
                    .map(|at| format!("Since {}", monocode_core::schedule::short_now(at)))
                    .unwrap_or_default();
                let more = count.saturating_sub(LISTED);
                Self::card_frame()
                    .child(Self::card_top("Holding for", value, count == 0))
                    .when(count > 0, |d| {
                        d.child(
                            div()
                                .mt(px(6.))
                                .flex()
                                .flex_col()
                                .gap(px(1.))
                                .children(self.holders.iter().take(LISTED).enumerate().map(
                                    |(ix, holder)| self.holder_row(ix, holder, now, accent, cx),
                                ))
                                .when(more > 0, |d| {
                                    d.child(
                                        div()
                                            .pl(px(22.))
                                            .text_size(px(10.))
                                            .text_color(content(0.4))
                                            .child(format!("and {more} more")),
                                    )
                                }),
                        )
                    })
                    .child(Self::meta(hint, since))
                    .into_any_element()
            }
        }
    }

    fn holder_row(
        &self,
        ix: usize,
        holder: &Holder,
        now: u64,
        accent: Hsla,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = holder.id;
        let offset = ix as f32 * 0.25;
        div()
            .id(("keep-awake-holder", ix))
            .role(Role::Button)
            .aria_label(format!("Open {}", holder.title))
            .h(px(22.))
            .px(px(2.))
            .rounded(px(5.))
            .flex()
            .items_center()
            .gap(px(7.))
            .text_color(content(0.8))
            .cursor_pointer()
            .hover(|s| s.bg(content(0.06)).text_color(content(1.)))
            .child(provider_icon(&holder.provider, 13.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(holder.title.clone()),
            )
            .child(pulse::looping(
                ("keep-awake-live", ix),
                BREATHE,
                Rate::Half,
                move |phase| {
                    let wave = 0.5 - 0.5 * ((phase + offset) * std::f32::consts::TAU).cos();
                    div()
                        .size(px(4.))
                        .rounded_full()
                        .bg(accent.opacity(0.25 + 0.75 * wave))
                },
            ))
            .when_some(holder.since, |d, since| {
                d.child(
                    div()
                        .text_size(px(10.))
                        .text_color(content(0.4))
                        .child(elapsed_short(now.saturating_sub(since))),
                )
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.dismiss(window, cx);
                cx.emit(KeepAwakeEvent::OpenSession(id));
            }))
            .into_any_element()
    }

    /// Lid mode's switch lives in Settings; the popover only keeps the line
    /// that needs the user: setup, the admin prompt, or a failed pmset call.
    fn lid_row(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (text, warn, setup) = self.keep_lid.then(|| self.lid_note()).flatten()?;
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .mx(px(2.))
                .mt(px(8.))
                .px(px(8.))
                .text_size(px(10.))
                .text_color(if warn {
                    gpui::rgb(0xf5b041).into()
                } else {
                    content(0.45)
                })
                .child(icon("laptop", 12.).text_color(content(0.5)))
                .child(div().flex_1().min_w_0().truncate().child(text))
                .when(setup, |d| {
                    d.child(
                        div()
                            .id("keep-awake-lid-setup")
                            .role(Role::Button)
                            .aria_label("Set up lid closed mode")
                            .flex_shrink_0()
                            .text_color(picked_accent())
                            .cursor_pointer()
                            .hover(|s| s.text_color(content(1.)))
                            .child("Set up")
                            .on_click(cx.listener(|this, _, _, cx| {
                                cx.stop_propagation();
                                this.set_up_lid(cx);
                            })),
                    )
                })
                .into_any_element(),
        )
    }

    /// The lid line that needs the user: its text, whether it warns, and
    /// whether it offers setup.
    fn lid_note(&self) -> Option<(SharedString, bool, bool)> {
        let lid = &self.lid;
        if lid.installing {
            return Some(("Waiting for your admin password…".into(), false, false));
        }
        match &lid.status {
            lid::Status::NeedsSetup => Some((
                "Lid closed mode needs your admin password once".into(),
                false,
                true,
            )),
            lid::Status::Failed(error) => Some((
                format!("Couldn't change sleep: {error}").into(),
                true,
                false,
            )),
            _ => None,
        }
    }

    fn switch_track(on: bool, width: f32, height: f32) -> gpui::Div {
        let knob = height - 3.;
        div()
            .relative()
            .w(px(width))
            .h(px(height))
            .flex_shrink_0()
            .rounded_full()
            .bg(if on { picked_accent() } else { content(0.2) })
            .child(
                div()
                    .absolute()
                    .top(px(1.5))
                    .left(px(if on { width - knob - 1.5 } else { 1.5 }))
                    .size(px(knob))
                    .rounded_full()
                    .bg(gpui::white()),
            )
    }

    fn foot(&self, now: u64, cx: &mut Context<Self>) -> AnyElement {
        let hold = self.holding_at(now);
        // A working hold says nothing; only an idle or failed one is worth a line.
        let status = if !hold {
            Some(("moon", "Not blocking sleep", content(0.45)))
        } else if self.verified {
            None
        } else {
            Some((
                "circle-alert",
                "macOS is not holding it",
                gpui::rgb(0xf5b041).into(),
            ))
        };
        div()
            .flex()
            .items_center()
            .justify_between()
            .px(px(8.))
            .pt(px(7.))
            .pb(px(3.))
            .text_size(px(10.))
            .text_color(content(0.4))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .when_some(status, |d, (glyph, text, tone)| {
                        d.child(icon(glyph, 11.).text_color(tone)).child(text)
                    }),
            )
            .child(
                div()
                    .id("keep-awake-settings")
                    .role(Role::Button)
                    .aria_label("Keep awake settings")
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_color(content(0.5))
                    .cursor_pointer()
                    .hover(|s| s.text_color(content(1.)))
                    .child("Settings")
                    .when_some(self.shortcut.clone(), |d, keys| {
                        d.child(
                            div()
                                .px(px(4.))
                                .py(px(1.))
                                .rounded(px(4.))
                                .border_1()
                                .border_color(content(0.1))
                                .text_size(px(9.5))
                                .text_color(content(0.4))
                                .child(keys),
                        )
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.dismiss(window, cx);
                        cx.emit(KeepAwakeEvent::OpenSettings);
                    })),
            )
            .into_any_element()
    }
}

impl Render for KeepAwake {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = now_ms();
        let weak = cx.weak_entity();
        div()
            .flex_shrink_0()
            .flex()
            .items_center()
            .child(self.chip(now, cx))
            .when(self.open, |d| {
                d.child(
                    popover("keep-awake", Anchor::Slot(self.anchor.clone()))
                        .side(Side::Top)
                        .align(Align::End)
                        .gap(7.)
                        .width(296.)
                        .padding(6.)
                        .on_dismiss(move |window, cx| {
                            let _ = weak.update(cx, |this, cx| this.dismiss(window, cx));
                        })
                        .child(self.details(now, cx)),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    fn holder(id: i64) -> Holder {
        Holder {
            id,
            title: format!("Chat {id}").into(),
            provider: "claude".into(),
            since: Some(now_ms()),
        }
    }

    #[test]
    fn times_read_as_hours_and_minutes() {
        assert_eq!(elapsed_short(30_000), "<1m");
        assert_eq!(elapsed_short(24 * 60_000), "24m");
        assert_eq!(elapsed_short(161 * 60_000), "2h 41m");
        assert_eq!(elapsed_short(120 * 60_000), "2h");
        assert_eq!(remaining(45_000), "45s");
        assert_eq!(remaining(68 * 60_000 + 1), "1h 9m");
        assert_eq!(remaining(60 * 60_000), "1h");
        assert_eq!(session_label(2 * 3_600_000), "2-hour session");
        assert_eq!(session_label(150 * 60_000), "2h 30m session");
        assert_eq!(timer_label(Some(0)), "Never");
        assert_eq!(timer_label(Some(90)), "1 h 30 min");
    }

    #[gpui::test]
    fn agents_mode_holds_while_chats_work_and_through_the_grace_period(cx: &mut TestAppContext) {
        let view = cx.new(|cx| KeepAwake::new(&Preferences::default(), cx));
        view.update(cx, |k, cx| {
            k.start(Mode::Agents, cx);
            assert!(!k.assertions.holds_system(), "nothing works yet");
            assert_eq!(k.chip_text(now_ms()), (None, Some("Agents".into())));

            k.set_holders(vec![holder(1), holder(2)], cx);
            assert!(k.assertions.holds_system());
            assert!(
                !k.assertions.holds_display(),
                "the display may sleep by default"
            );
            let (count, time) = k.chip_text(now_ms());
            assert_eq!(count.as_deref(), Some("2 working"));
            assert_eq!(time, None, "agents mode has no timer");

            k.set_holders(Vec::new(), cx);
            assert!(
                k.assertions.holds_system(),
                "the grace period keeps holding"
            );
            assert_eq!(k.chip_text(now_ms()), (None, Some("Awake".into())));
            k.last_busy = Some(now_ms() - GRACE_MS - 1);
            k.sync(cx);
            assert!(!k.assertions.holds_system());
            assert!(k.session.is_some(), "agents mode stays armed");
        });
    }

    #[gpui::test]
    fn timed_sessions_end_by_themselves_and_say_so(cx: &mut TestAppContext) {
        let view = cx.new(|cx| KeepAwake::new(&Preferences::default(), cx));
        view.update(cx, |k, cx| {
            k.start(Mode::Hours(2), cx);
            assert!(k.assertions.holds_system());
            let (_, time) = k.chip_text(now_ms());
            assert_eq!(time.as_deref(), Some("2h left"));
            k.extend(30, cx);
            let (_, time) = k.chip_text(now_ms());
            assert_eq!(time.as_deref(), Some("2h 30m left"));
            if let Some(s) = &mut k.session {
                s.ends = Some(now_ms() - 1);
            }
            k.sync(cx);
            assert!(k.session.is_none());
            assert!(!k.assertions.holds_system());
            assert!(
                k.stopped
                    .as_ref()
                    .is_some_and(|s| s.starts_with("Ended at"))
            );
        });
    }

    #[gpui::test]
    fn keep_display_and_the_battery_floor_follow_preferences(cx: &mut TestAppContext) {
        let prefs = Preferences {
            keep_awake_display: true,
            keep_awake_battery: 20,
            ..Default::default()
        };
        let view = cx.new(|cx| KeepAwake::new(&prefs, cx));
        view.update(cx, |k, cx| {
            k.start(Mode::Always, cx);
            assert!(k.assertions.holds_system() && k.assertions.holds_display());
            k.battery = power::Battery {
                on_battery: true,
                percent: Some(25),
            };
            k.sync(cx);
            assert!(k.session.is_some(), "above the floor keeps going");
            k.battery.percent = Some(19);
            k.sync(cx);
            assert!(k.session.is_none());
            assert!(!k.assertions.holds_system() && !k.assertions.holds_display());
            assert_eq!(k.stopped.as_deref(), Some("Stopped at 19% battery"));
        });
    }

    #[gpui::test]
    fn lid_mode_turns_sleep_off_only_while_holding(cx: &mut TestAppContext) {
        let prefs = Preferences {
            keep_awake_lid: true,
            ..Default::default()
        };
        let view = cx.new(|cx| KeepAwake::new(&prefs, cx));
        cx.run_until_parked();
        view.update(cx, |k, cx| {
            assert_eq!(k.lid.status, lid::Status::Ready);
            assert!(k.lid.held.is_none(), "no session, no lid hold");
            k.start(Mode::Agents, cx);
        });
        cx.run_until_parked();
        view.update(cx, |k, cx| {
            assert!(k.lid.held.is_none(), "armed agents mode waits for work");
            k.set_holders(vec![holder(1)], cx);
        });
        cx.run_until_parked();
        view.update(cx, |k, cx| {
            assert_eq!(k.lid.held, Some(lid::Engaged::Owned));
            k.stop(None, cx);
        });
        cx.run_until_parked();
        view.update(cx, |k, cx| {
            assert!(k.lid.held.is_none(), "stopping turns sleep back on");
            k.lid.status = lid::Status::NeedsSetup;
            k.start(Mode::Always, cx);
        });
        cx.run_until_parked();
        view.update(cx, |k, _| {
            assert!(k.lid.held.is_none(), "no pmset call before setup");
            assert!(k.lid_note().is_some_and(|(_, _, setup)| setup));
        });
    }

    #[gpui::test]
    fn the_shortcut_toggles_the_default_mode_and_shows_the_chip(cx: &mut TestAppContext) {
        let prefs = Preferences {
            keep_awake_mode: "4h".into(),
            ..Default::default()
        };
        let view = cx.new(|cx| KeepAwake::new(&prefs, cx));
        view.update(cx, |k, cx| {
            assert!(!k.footer);
            k.toggle_session(cx);
            assert_eq!(k.session.map(|s| s.mode), Some(Mode::Hours(4)));
            assert_eq!(k.visible(), cfg!(target_os = "macos"));
            k.toggle_session(cx);
            assert!(k.session.is_none());
            assert!(!k.visible());
        });
    }
}
