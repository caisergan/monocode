//! PromptCacheWarning: once a Claude chat's prompt cache lapses, an amber mark
//! beside Send explains what the next message costs, and sending asks first.
use super::*;
use monocode_core::prompt_cache;

#[derive(Default)]
pub(super) struct PromptCacheWarning {
    hovered: bool,
    /// A send waits on "Send anyway"; it carries that send's Cmd/Ctrl flip.
    pub(super) confirming: Option<bool>,
    /// The next send was confirmed and skips the question once.
    confirmed: bool,
    /// The user turned the question off for this chat. In memory only.
    skipped: bool,
    /// The confirm's "Don't ask again for this chat" box.
    skip_checked: bool,
    anchor: AnchorSlot,
    /// The mark and Send together, which the confirm opens against.
    pub(super) send_area: AnchorSlot,
    /// Repaints when the cache lapses: its moment and the waiting task.
    timer: Option<(u64, gpui::Task<()>)>,
}

impl Conversation {
    /// The lapsed cache the next message would re-read, if it is worth saying.
    fn expired_prompt_cache(&self, cx: &gpui::App) -> Option<prompt_cache::State> {
        if self.summary.provider != "claude" || self.busy || self.stopping {
            return None;
        }
        let state = prompt_cache::state(&self.transcript.read(cx).turns)?;
        (state.expired(monocode_core::time::now_ms())
            && prompt_cache::worth_warning(self.context.map(|usage| usage.used)))
        .then_some(state)
    }
    /// Whether this send stops to ask first; a confirmed send passes once.
    pub(super) fn confirms_expired_cache(&mut self, cx: &gpui::App) -> bool {
        if std::mem::take(&mut self.prompt_cache.confirmed) {
            return false;
        }
        !self.prompt_cache.skipped
            && cx
                .try_global::<crate::settings::Preferences>()
                .is_none_or(|prefs| prefs.confirm_expired_cache_send)
            && (self.input.read(cx).has_message_text() || !self.attachments.is_empty())
            && !self.draft_active(cx)
            && self.expired_prompt_cache(cx).is_some()
    }
    /// Answers the open question; the checkbox only counts for a send.
    pub(super) fn answer_cache_confirm(&mut self, send: bool, cx: &mut Context<Self>) {
        let Some(invert) = self.prompt_cache.confirming.take() else {
            return;
        };
        let skip = std::mem::take(&mut self.prompt_cache.skip_checked);
        self.prompt_cache.skipped |= send && skip;
        if send {
            self.prompt_cache.confirmed = true;
            self.send_follow_up(invert, cx);
        }
        cx.notify();
    }
    /// Repaint when the cache lapses, so the mark appears without input.
    fn schedule_cache_mark(&mut self, cx: &mut Context<Self>) {
        if self.summary.provider != "claude" {
            return;
        }
        let Some(state) = prompt_cache::state(&self.transcript.read(cx).turns) else {
            return;
        };
        let at = state.warn_at();
        let now = monocode_core::time::now_ms();
        if at <= now
            || self
                .prompt_cache
                .timer
                .as_ref()
                .is_some_and(|(due, _)| *due == at)
        {
            return;
        }
        let delay = std::time::Duration::from_millis(at - now);
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |_, cx| cx.notify());
        });
        self.prompt_cache.timer = Some((at, task));
    }
    pub(super) fn prompt_cache_mark(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.schedule_cache_mark(cx);
        let Some(state) = self.expired_prompt_cache(cx) else {
            self.prompt_cache.confirming = None;
            return None;
        };
        let (headline, detail, consequence) = state.tooltip(
            monocode_core::time::now_ms(),
            self.context.map(|usage| usage.used),
        );
        let hovered = self.prompt_cache.hovered && self.prompt_cache.confirming.is_none();
        let amber = tint(AMBER_400, 1.);
        Some(
            div()
                .id("prompt-cache-mark")
                .debug_selector(|| "prompt-cache-mark".into())
                .role(Role::Image)
                .aria_label(format!("{headline}. {detail} {consequence}"))
                .flex_shrink_0()
                .size(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .child(self.prompt_cache.anchor.probe())
                .child(icon("alert-circle", 14.).text_color(amber))
                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    this.prompt_cache.hovered = *hovered;
                    cx.notify();
                }))
                .when(hovered, |d| {
                    d.child(
                        popover(
                            "prompt-cache-tooltip",
                            Anchor::Slot(self.prompt_cache.anchor.clone()),
                        )
                        .side(Side::Top)
                        .align(Align::End)
                        .width(288.)
                        .allow_outside_press()
                        .child(
                            div()
                                .px(px(10.))
                                .py(px(6.))
                                .text_size(px(11.))
                                .line_height(px(16.))
                                .text_color(content(0.5))
                                .child(div().text_size(px(12.)).text_color(amber).child(headline))
                                .child(div().mt(px(2.)).child(detail))
                                .child(div().mt_1().child(consequence)),
                        ),
                    )
                })
                .into_any_element(),
        )
    }
    /// PromptCacheSendConfirm: asks before a send re-reads the whole context.
    /// Enter sends anyway; Escape or a press outside cancels.
    pub(super) fn prompt_cache_confirm(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.prompt_cache.confirming?;
        let state = self.expired_prompt_cache(cx)?;
        let (_, detail, consequence) = state.tooltip(
            monocode_core::time::now_ms(),
            self.context.map(|usage| usage.used),
        );
        let skip = self.prompt_cache.skip_checked;
        let accent = crate::theme::accent_color();
        let this = cx.entity().downgrade();
        Some(
            popover(
                "prompt-cache-confirm",
                Anchor::Slot(self.prompt_cache.send_area.clone()),
            )
            .side(Side::Top)
            .align(Align::End)
            .width(300.)
            .padding(12.)
            .on_dismiss(move |_, cx| {
                let _ = this.update(cx, |this, cx| this.answer_cache_confirm(false, cx));
            })
            .child(
                div()
                    .id("prompt-cache-confirm")
                    .debug_selector(|| "prompt-cache-confirm".into())
                    .role(Role::AlertDialog)
                    .aria_label("Prompt cache expired")
                    .flex()
                    .flex_col()
                    .gap_2()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(content(1.))
                    .child(
                        div()
                            .child(
                                div()
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .child("Re-read the whole chat?"),
                            )
                            .child(
                                div()
                                    .mt_1()
                                    .text_size(px(11.))
                                    .text_color(content(0.55))
                                    .child(format!("{detail} {consequence}")),
                            ),
                    )
                    .child(
                        div()
                            .id("prompt-cache-skip")
                            .debug_selector(|| "prompt-cache-skip".into())
                            .role(Role::CheckBox)
                            .aria_label("Don't ask again for this chat")
                            .aria_toggled(skip.into())
                            .cursor_pointer()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_size(px(11.))
                            .text_color(content(0.7))
                            .child(
                                div()
                                    .size(px(13.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(3.))
                                    .border_1()
                                    .map(|d| {
                                        if skip {
                                            d.bg(accent)
                                                .border_color(accent)
                                                .child(icon("check", 10.).text_color(gpui::white()))
                                        } else {
                                            d.border_color(content(0.35))
                                        }
                                    }),
                            )
                            .child("Don't ask again for this chat")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.prompt_cache.skip_checked ^= true;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap_2()
                            .child(
                                div()
                                    .id("prompt-cache-cancel")
                                    .role(Role::Button)
                                    .cursor_pointer()
                                    .rounded(px(6.))
                                    .px(px(10.))
                                    .py_1()
                                    .hover(|s| s.bg(content(0.08)))
                                    .child("Cancel")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.answer_cache_confirm(false, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .id("prompt-cache-send")
                                    .debug_selector(|| "prompt-cache-send".into())
                                    .role(Role::Button)
                                    .cursor_pointer()
                                    .rounded(px(6.))
                                    .px(px(10.))
                                    .py_1()
                                    .border_1()
                                    .border_color(tint(AMBER_400, 1.))
                                    .bg(tint(AMBER_500, 0.2))
                                    .hover(|s| s.bg(tint(AMBER_500, 0.3)))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(tint(AMBER_400, 1.))
                                    .child("Send anyway")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.answer_cache_confirm(true, cx)
                                    })),
                            ),
                    ),
            )
            .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monocode_core::agent::{TurnInfo, TurnMetrics};

    #[gpui::test]
    fn an_expired_claude_cache_asks_before_sending_and_can_be_skipped(
        cx: &mut gpui::TestAppContext,
    ) {
        let store = Arc::new(std::sync::Mutex::new(
            monocode_core::store::Store::open(Path::new(":memory:")).unwrap(),
        ));
        let summary = locked(&store).unwrap().create("claude", "/tmp").unwrap();
        let view = cx.new(|cx| Conversation::new(summary, store.clone(), cx));
        let hour_ago = monocode_core::time::now_ms() - 3_700_000;
        view.update(cx, |v, cx| {
            v.loaded = true;
            v.summary.has_messages = true;
            v.context = Some(monocode_core::context::Usage {
                used: 84_000,
                window: Some(200_000),
            });
            v.transcript.update(cx, |t, _| {
                t.turns.insert(
                    1,
                    TurnInfo {
                        completed_at: Some(hour_ago),
                        metrics: Some(TurnMetrics {
                            input_tokens: 10,
                            cache_read_tokens: 80_000,
                            cache_ttl_seconds: Some(3600),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                );
            });
            assert!(v.expired_prompt_cache(cx).is_some());
            v.input
                .update(cx, |i, cx| i.set_text("next question".into(), cx));
            assert!(v.confirms_expired_cache(cx));
            v.prompt_cache.confirming = Some(false);
            // Cancel keeps the message.
            v.answer_cache_confirm(false, cx);
            assert_eq!(v.input.read(cx).content.as_ref(), "next question");
            assert!(v.confirms_expired_cache(cx));
            // A ticked box only counts when the message is sent.
            v.prompt_cache.confirming = Some(false);
            v.prompt_cache.skip_checked = true;
            v.answer_cache_confirm(false, cx);
            assert!(v.confirms_expired_cache(cx));
            // "Don't ask again for this chat" stops asking.
            v.prompt_cache.skipped = true;
            assert!(!v.confirms_expired_cache(cx));
            // A small context is not worth a warning.
            v.prompt_cache.skipped = false;
            v.context = Some(monocode_core::context::Usage {
                used: 12_000,
                window: Some(200_000),
            });
            assert!(!v.confirms_expired_cache(cx));
        });
    }
}
