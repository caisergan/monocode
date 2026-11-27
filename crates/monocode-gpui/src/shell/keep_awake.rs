//! The shell's side of keep awake: which chats are mid-turn, scheduled sends
//! due soon, the footer chip's slot, and the popover's requests.
use super::*;
use crate::keep_awake::{Holder, KeepAwakeEvent, SCHEDULED_SOON_MS};

impl Shell {
    /// Hand keep awake the chats now mid-turn, oldest turn first.
    pub(super) fn sync_keep_awake(&mut self, cx: &mut Context<Self>) {
        let mut holders: Vec<Holder> = self
            .busy_sessions
            .iter()
            .filter_map(|id| {
                let session = self.sessions.get(id)?.read(cx);
                let since = session
                    .transcript
                    .read(cx)
                    .live_turn(&session.summary.cwd)
                    .1;
                Some(Holder {
                    id: *id,
                    title: session.summary.title.clone().into(),
                    provider: session.summary.provider.clone(),
                    since,
                })
            })
            .collect();
        holders.sort_by_key(|h| (h.since.unwrap_or(u64::MAX), h.id));
        self.keep_awake
            .update(cx, |keep_awake, cx| keep_awake.set_holders(holders, cx));
    }

    /// Scheduled sends due within ten minutes keep agents mode holding.
    pub(super) fn sync_keep_awake_schedule(
        &mut self,
        index: &std::collections::BTreeMap<i64, u64>,
        cx: &mut Context<Self>,
    ) {
        let now = monocode_core::time::now_ms();
        let soon = index
            .iter()
            .filter(|(id, at)| {
                **at > now
                    && **at - now <= SCHEDULED_SOON_MS
                    && self.session_summaries.get(id).is_some_and(|s| !s.archived)
            })
            .count();
        self.keep_awake
            .update(cx, |keep_awake, cx| keep_awake.set_scheduled_soon(soon, cx));
    }

    /// Subscribe once a window exists: the popover opens chats and Settings.
    pub(super) fn bind_keep_awake(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.keep_awake_bound {
            return;
        }
        self.keep_awake_bound = true;
        let keep_awake = self.keep_awake.clone();
        self.observations.push(cx.subscribe_in(
            &keep_awake,
            window,
            |this, _, event: &KeepAwakeEvent, window, cx| match event {
                KeepAwakeEvent::OpenSettings => {
                    this.open_settings(crate::settings::Section::General, window, cx)
                }
                KeepAwakeEvent::OpenSession(id) => this.open(*id, window, cx),
                KeepAwakeEvent::KeepDisplay(on) => {
                    this.workspace.preferences.keep_awake_display = *on;
                    this.apply_preferences(cx);
                    this.persist(cx);
                    this.sync_settings(cx);
                }
                KeepAwakeEvent::KeepLid(on) => {
                    this.workspace.preferences.keep_awake_lid = *on;
                    this.apply_preferences(cx);
                    this.persist(cx);
                    this.sync_settings(cx);
                }
            },
        ));
        // Redraw the footer only when the chip appears or goes.
        self.observations
            .push(cx.observe(&keep_awake, |this, keep_awake, cx| {
                let visible = keep_awake.read(cx).visible();
                if this.keep_awake_visible != visible {
                    this.keep_awake_visible = visible;
                    this.invalidate_chrome(cx);
                    cx.notify();
                }
            }));
    }

    /// The footer's keep-awake chip, before the pressure chip and terminal.
    pub(super) fn keep_awake_chip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.keep_awake.read(cx).visible() {
            return None;
        }
        let classic = self.workspace.boxy_layout();
        // Last in the footer (no terminal controls), it takes the inset margin.
        let alone = self.app_view_open() || self.workspace.project.is_empty();
        Some(
            div()
                .flex_shrink_0()
                .map(|d| match (classic, alone) {
                    (true, true) => d,
                    (true, false) => d.mr(px(super::terminal_dock::FOOTER_GAP)),
                    (false, true) => d.mr(px(6.)).pb(px(2.)),
                    (false, false) => d.mr(px(super::terminal_dock::FOOTER_GAP)).pb(px(2.)),
                })
                .child(self.keep_awake.clone())
                .into_any_element(),
        )
    }
}
