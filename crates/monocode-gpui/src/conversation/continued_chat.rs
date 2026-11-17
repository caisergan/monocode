//! HandoffMiniCard's "Continued chat": a chat started with "Continue in new
//! session" names its source, which opens on click, and "Show context"
//! reveals the recap that goes out with the first message. It sits inside
//! the composer box, above the input.
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
        let brief = handoff.brief.trim().to_owned();
        let dismiss = div()
            .id("dismiss-continued-chat")
            .role(Role::Button)
            .aria_label("Remove continued chat")
            .group("dismiss-continued-chat")
            .cursor_pointer()
            .mr(px(-4.))
            .size(px(20.))
            .rounded(px(4.))
            .flex()
            .items_center()
            .justify_center()
            .hover(|s| s.bg(content(0.1)))
            .child(
                icon("close", 12.)
                    .text_color(content(0.4))
                    .group_hover("dismiss-continued-chat", |s| s.text_color(content(1.))),
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _, _, cx| {
                this.settings.handoff = None;
                this.handoff_context_open = false;
                this.save_settings(cx);
                cx.notify();
            }));
        div()
            .px_3()
            .pt_3()
            .child(
                div()
                    .id("continued-chat")
                    .debug_selector(|| "continued-chat".into())
                    .rounded_lg()
                    .border_1()
                    .border_color(content(0.08))
                    .bg(content(0.04))
                    .px(px(10.))
                    .py_2()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(16.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(icon("continued", 14.).text_color(continued_color()))
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(11.))
                                    .text_color(content(0.5))
                                    .child("Continued chat"),
                            )
                            .child(dismiss),
                    )
                    .child(
                        div()
                            .mt_1()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(content(1.))
                            .child(provider_icon(&handoff.from, 14.))
                            .child(
                                div()
                                    .id("continued-chat-source")
                                    .role(Role::Link)
                                    .aria_label(format!("Open {}", source.title))
                                    .min_w_0()
                                    .truncate()
                                    .cursor_pointer()
                                    .hover(|s| s.underline())
                                    .child(source.title.clone())
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation()
                                    })
                                    .on_click(cx.listener(move |_, _, _, cx| {
                                        cx.emit(OpenSession(source.session))
                                    })),
                            ),
                    )
                    .when(!brief.is_empty(), |d| {
                        d.child(
                            div().mt_1().flex().child(
                                div()
                                    .id("continued-chat-context")
                                    .role(Role::Button)
                                    .aria_expanded(open)
                                    .aria_label(if open { "Hide context" } else { "Show context" })
                                    .group("continued-chat-context")
                                    .cursor_pointer()
                                    .rounded(px(4.))
                                    .flex()
                                    .items_center()
                                    .gap(px(2.))
                                    .text_size(px(11.))
                                    .line_height(px(16.))
                                    .text_color(content(0.45))
                                    .hover(|s| s.text_color(content(1.)))
                                    .child(if open { "Hide context" } else { "Show context" })
                                    .child(
                                        icon(
                                            if open {
                                                "chevron-down"
                                            } else {
                                                "chevron-right"
                                            },
                                            12.,
                                        )
                                        .text_color(content(0.45))
                                        .group_hover("continued-chat-context", |s| {
                                            s.text_color(content(1.))
                                        }),
                                    )
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation()
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.handoff_context_open = !this.handoff_context_open;
                                        cx.notify();
                                    })),
                            ),
                        )
                    })
                    .when(open && !brief.is_empty(), |d| {
                        // The recap that goes out with the first message.
                        d.child(
                            div()
                                .id("continued-chat-brief")
                                .mt(px(6.))
                                .max_h(px(192.))
                                .overflow_y_scroll()
                                .px_2()
                                .py(px(6.))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(content(0.1))
                                .bg(background_base().opacity(0.6))
                                .font_family(crate::fonts::mono())
                                .text_size(px(11.))
                                .line_height(px(16.))
                                .text_color(content(0.7))
                                .child(brief),
                        )
                    }),
            )
            .into_any_element()
    }
}

impl Conversation {
    /// The first message of a chat started with "Continue in new session"
    /// went out: keep its source and recap for the transcript and sidebar.
    pub(crate) fn link_continued(
        &mut self,
        handoff: monocode_core::agent::Handoff,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = handoff.continued else {
            return;
        };
        let mut continued = monocode_core::agent::ContinuedFrom {
            session: source.session,
            title: source.title,
            provider: handoff.from,
            brief: handoff.brief,
            earlier: None,
        };
        let roots = self.continued_roots();
        self.transcript.update(cx, |view, cx| {
            view.set_continued(Some(continued.clone()), roots.clone(), cx)
        });
        let store = self.store.clone();
        let id = self.summary.id;
        cx.spawn(async move |this, cx| {
            let saved = cx
                .background_executor()
                .spawn(async move {
                    let store = locked(&store)?;
                    continued.earlier = store.continued_from(continued.session)?.map(|earlier| {
                        monocode_core::agent::ContinuedChat {
                            session: earlier.session,
                            title: earlier.title,
                        }
                    });
                    store.save_continued_from(id, &continued)?;
                    Ok::<_, String>(continued)
                })
                .await;
            let _ = this.update(cx, |this, cx| match saved {
                Ok(continued) => {
                    let source = continued.session;
                    this.transcript.update(cx, |view, cx| {
                        view.set_continued(Some(continued), roots, cx)
                    });
                    cx.emit(ContinuedLinked(source));
                }
                Err(error) => {
                    this.status = error;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// The folders a recap's file paths are shown inside: the chat's
    /// worktree, then its project.
    pub(super) fn continued_roots(&self) -> Vec<String> {
        self.settings
            .worktree_cwd
            .iter()
            .cloned()
            .chain(std::iter::once(self.summary.cwd.clone()))
            .collect()
    }

    pub(crate) fn set_continued_in(
        &mut self,
        next: Option<monocode_core::agent::ContinuedChat>,
        cx: &mut Context<Self>,
    ) {
        if self.continued_in != next {
            self.continued_in = next.clone();
            self.transcript
                .update(cx, |view, cx| view.set_continued_in(next, cx));
            cx.notify();
        }
    }

    /// Above the composer of a chat that continues in a newer one.
    pub(super) fn continued_in_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let next = self.continued_in.clone()?;
        let session = next.session;
        Some(
            div()
                .id("continued-in-banner")
                .debug_selector(|| "continued-in-banner".into())
                .mb(px(6.))
                .px(px(12.))
                .py(px(7.))
                .rounded(px(10.))
                .border_1()
                .border_color(content(0.08))
                .bg(content(0.04))
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(12.))
                .text_color(content(0.6))
                .child(icon("continued", 14.).text_color(continued_color()))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(div().flex_shrink_0().child("This chat continues in"))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(content(1.))
                                .child(next.title.clone()),
                        ),
                )
                .child(
                    div()
                        .id("open-continued-in")
                        .role(Role::Button)
                        .aria_label(format!("Open {}", next.title))
                        .flex_shrink_0()
                        .cursor_pointer()
                        .px(px(8.))
                        .py(px(2.))
                        .rounded(px(6.))
                        .bg(content(0.07))
                        .text_color(content(1.))
                        .hover(|s| s.bg(content(0.12)))
                        .child("Open")
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |_, _, _, cx| cx.emit(OpenSession(session)))),
                )
                .into_any_element(),
        )
    }
}

/// The continued-chat mark's amber, apart from the Orchestrator's fuchsia and
/// the Operator's sky (amber-200/90).
pub(crate) fn continued_color() -> gpui::Hsla {
    gpui::Hsla::from(gpui::rgb(0xfde68a)).opacity(0.9)
}
