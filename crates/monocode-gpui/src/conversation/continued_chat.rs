//! HandoffMiniCard's "Continued chat": a chat started with "Continue in new
//! session" names its source, which opens on click, and "Show context"
//! reveals the recap that goes out with the first message.
use super::*;

impl Conversation {
    pub(super) fn continued_chat_card(
        &self,
        handoff: monocode_core::agent::Handoff,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(source) = handoff.continued.clone() else {
            return div().into_any_element();
        };
        let open = self.handoff_context_open;
        div()
            .id("continued-chat")
            .debug_selector(|| "continued-chat".into())
            .mb(px(6.))
            .px(px(12.))
            .py(px(8.))
            .rounded(px(10.))
            .bg(content(0.05))
            .flex()
            .flex_col()
            .gap(px(6.))
            .text_size(px(12.))
            .text_color(content(0.7))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(icon("response-handoff", 14.))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .items_center()
                            .gap_1()
                            .child("Continued chat ·")
                            .child(
                                div()
                                    .id("continued-chat-source")
                                    .role(Role::Link)
                                    .aria_label(format!("Open {}", source.title))
                                    .min_w_0()
                                    .truncate()
                                    .cursor_pointer()
                                    .text_color(content(0.9))
                                    .hover(|s| s.underline())
                                    .child(source.title.clone())
                                    .on_click(cx.listener(move |_, _, _, cx| {
                                        cx.emit(OpenSession(source.session))
                                    })),
                            ),
                    )
                    .child(
                        tool_pill(
                            "continued-chat-context",
                            if open { "Hide context" } else { "Show context" },
                        )
                        .aria_expanded(open)
                        .child(if open { "Hide context" } else { "Show context" })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.handoff_context_open = !this.handoff_context_open;
                            cx.notify();
                        })),
                    )
                    .child(
                        tool_pill("dismiss-continued-chat", "Dismiss")
                            .child(icon("close", 12.))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.settings.handoff = None;
                                this.handoff_context_open = false;
                                this.save_settings(cx);
                                cx.notify();
                            })),
                    ),
            )
            .when(open, |d| {
                d.child(
                    div()
                        .id("continued-chat-brief")
                        .max_h(px(220.))
                        .overflow_y_scroll()
                        .p_2()
                        .rounded(px(6.))
                        .bg(content(0.04))
                        .font_family(crate::fonts::mono())
                        .text_size(px(11.))
                        .line_height(px(16.))
                        .text_color(content(0.65))
                        .child(if handoff.brief.trim().is_empty() {
                            "The earlier chat had nothing to recap yet.".to_owned()
                        } else {
                            handoff.brief.clone()
                        }),
                )
            })
            .into_any_element()
    }
}
