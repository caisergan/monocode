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
    anchor: AnchorSlot,
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
    fn answer_cache_confirm(&mut self, send: bool, skip: bool, cx: &mut Context<Self>) {
        let Some(invert) = self.prompt_cache.confirming.take() else {
            return;
        };
        self.prompt_cache.skipped |= skip;
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
        let confirming = self.prompt_cache.confirming.is_some();
        let amber = tint(AMBER_400, 0.9);
        let text = div()
            .flex()
            .flex_col()
            .gap_1()
            .text_size(px(12.))
            .line_height(px(16.))
            .text_color(content(1.))
            .child(headline.clone())
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(content(0.5))
                    .child(detail),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(content(0.7))
                    .child(consequence.clone()),
            );
        Some(
            div()
                .id("prompt-cache-mark")
                .debug_selector(|| "prompt-cache-mark".into())
                .role(Role::Image)
                .aria_label(format!("{headline}. {consequence}"))
                .flex_shrink_0()
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(self.prompt_cache.anchor.probe())
                .child(icon("alert-circle", 15.).text_color(amber))
                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    this.prompt_cache.hovered = *hovered;
                    cx.notify();
                }))
                .when(self.prompt_cache.hovered || confirming, |d| {
                    d.child(
                        popover(
                            "prompt-cache-tooltip",
                            Anchor::Slot(self.prompt_cache.anchor.clone()),
                        )
                        .side(Side::Top)
                        .align(Align::End)
                        .max_width(300.)
                        .padding(10.)
                        .child(text)
                        .when(confirming, |p| {
                            p.child(
                                div()
                                    .id("prompt-cache-confirm")
                                    .debug_selector(|| "prompt-cache-confirm".into())
                                    .role(Role::Dialog)
                                    .aria_label("Send with an expired prompt cache?")
                                    .pt_2()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .id("prompt-cache-skip")
                                            .role(Role::Button)
                                            .cursor_pointer()
                                            .text_size(px(11.))
                                            .text_color(content(0.55))
                                            .hover(|s| s.text_color(content(0.9)))
                                            .child("Don't ask in this chat")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.answer_cache_confirm(true, true, cx)
                                            })),
                                    )
                                    .child(div().flex_1())
                                    .child(
                                        crate::modal::ghost_button("prompt-cache-cancel", "Cancel")
                                            .cursor_pointer()
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.answer_cache_confirm(false, false, cx)
                                            })),
                                    )
                                    .child(
                                        crate::modal::primary_button(
                                            "prompt-cache-send",
                                            "Send anyway",
                                        )
                                        .debug_selector(|| "prompt-cache-send".into())
                                        .cursor_pointer()
                                        .on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.answer_cache_confirm(true, false, cx)
                                            }),
                                        ),
                                    ),
                            )
                        }),
                    )
                })
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
            v.answer_cache_confirm(false, false, cx);
            assert_eq!(v.input.read(cx).content.as_ref(), "next question");
            assert!(v.confirms_expired_cache(cx));
            // "Don't ask in this chat" stops asking.
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
