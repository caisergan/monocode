//! ProjectRail's Chats section: conversations that belong to no project (cwd
//! "~"), which run from the home folder. The newest five show, with "Show
//! more"; the header folds the section away and its + starts a new chat.
use super::*;

const SHOWN: usize = 5;

impl Shell {
    /// Chats without a project, newest first.
    pub(super) fn projectless_chats(&self, cx: &App) -> Vec<i64> {
        let mut ids: Vec<_> = self
            .session_summaries
            .keys()
            .copied()
            .filter(|id| {
                let s = self.session_metadata(*id, cx).summary;
                s.cwd == "~" && s.has_messages && !s.archived && !self.deleting.contains(id)
            })
            .collect();
        ids.sort_by_key(|id| {
            std::cmp::Reverse((self.session_metadata(*id, cx).summary.updated_at, *id))
        });
        ids
    }
    /// A new chat without a project, opened without adding "~" to the rail.
    pub(super) fn new_projectless_chat(&mut self, cx: &mut Context<Self>) {
        self.workspace.rail_chats_collapsed = false;
        self.workspace.project = "~".into();
        self.create(self.default_kind(), cx);
        self.invalidate_chrome(cx);
    }
    pub(super) fn rail_chats(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let chats = self.projectless_chats(cx);
        let collapsed = self.workspace.rail_chats_collapsed;
        let more = !self.rail_chats_expanded && chats.len() > SHOWN;
        let shown = if self.rail_chats_expanded {
            chats.len()
        } else {
            SHOWN
        };
        let active = self.workspace.active;
        let header = div()
            .id("rail-chats-header")
            .debug_selector(|| "rail-chats-header".into())
            .h(px(28.))
            .px_2()
            .flex()
            .items_center()
            .gap_1()
            .text_size(px(11.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(content(0.5))
            .child(
                div()
                    .id("rail-chats-toggle")
                    .role(Role::Button)
                    .aria_label("Chats")
                    .aria_expanded(!collapsed)
                    .flex_1()
                    .flex()
                    .items_center()
                    .gap_1()
                    .cursor_pointer()
                    .hover(|s| s.text_color(content(0.85)))
                    .child(icon(
                        if collapsed {
                            "chevron-right"
                        } else {
                            "chevron-down"
                        },
                        12.,
                    ))
                    .child("Chats")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.workspace.rail_chats_collapsed = !this.workspace.rail_chats_collapsed;
                        this.persist(cx);
                        this.invalidate_chrome(cx);
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .id("rail-chats-new")
                    .debug_selector(|| "rail-chats-new".into())
                    .role(Role::Button)
                    .aria_label("New chat without a project")
                    .p_0p5()
                    .rounded_sm()
                    .cursor_pointer()
                    .hover(|s| s.bg(content(0.08)).text_color(content(0.9)))
                    .child(icon("plus", 14.))
                    .on_click(cx.listener(|this, _, _, cx| this.new_projectless_chat(cx))),
            );
        let rows = chats.iter().take(shown).map(|&id| {
            let title = self.session_metadata(id, cx).display_title();
            let when = monocode_core::time::relative(
                self.session_metadata(id, cx).summary.updated_at,
                monocode_core::time::now_ms(),
            );
            let selected = active == Some(id) && self.workspace.project == "~";
            div()
                .id(("rail-chat", id as usize))
                .role(Role::Button)
                .aria_label(title.clone())
                .h(px(30.))
                .mx_1()
                .px_2()
                .rounded_md()
                .flex()
                .items_center()
                .gap_2()
                .cursor_pointer()
                .text_size(px(13.))
                .text_color(content(if selected { 1. } else { 0.75 }))
                .when(selected, |d| d.bg(content(0.08)))
                .hover(|s| s.bg(content(0.06)))
                .child(icon("message-multiple", 14.).text_color(content(0.45)))
                .child(div().min_w_0().flex_1().truncate().child(title))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(11.))
                        .text_color(content(0.4))
                        .child(when),
                )
                .on_click(cx.listener(move |this, _, window, cx| this.open(id, window, cx)))
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                        this.selected_sessions.clear();
                        this.selected_sessions.insert(id);
                        this.context_selection = true;
                        this.open_menu(
                            MenuTarget::Session(id),
                            Anchor::Point(event.position),
                            window,
                            cx,
                        );
                    }),
                )
        });
        div()
            .id("rail-chats")
            .debug_selector(|| "rail-chats".into())
            .role(Role::Region)
            .aria_label("Chats")
            .flex_shrink_0()
            .pt_1()
            .border_t_1()
            .border_color(content(0.06))
            .child(header)
            .when(!collapsed, |d| {
                d.children(rows)
                    .when(chats.is_empty(), |d| {
                        d.child(
                            div()
                                .px_3()
                                .pb_1()
                                .text_size(px(11.))
                                .text_color(content(0.4))
                                .child("Chats without a project show here."),
                        )
                    })
                    .when(more, |d| {
                        d.child(
                            div()
                                .id("rail-chats-more")
                                .role(Role::Button)
                                .mx_1()
                                .px_2()
                                .py_1()
                                .rounded_md()
                                .cursor_pointer()
                                .text_size(px(12.))
                                .text_color(content(0.5))
                                .hover(|s| s.bg(content(0.06)).text_color(content(0.85)))
                                .child(format!("Show more ({})", chats.len() - SHOWN))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.rail_chats_expanded = true;
                                    this.invalidate_chrome(cx);
                                    cx.notify();
                                })),
                        )
                    })
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    #[gpui::test]
    fn the_rail_lists_chats_without_a_project_and_starts_new_ones(cx: &mut TestAppContext) {
        let (window, a, b) = crate::shell::tests::window(cx);
        window
            .update(cx, |shell, _, cx| {
                for id in [a, b] {
                    shell.sessions[&id].update(cx, |s, _| s.summary.has_messages = true);
                }
                shell.sessions[&a].update(cx, |s, _| s.summary.cwd = "~".into());
                assert_eq!(shell.projectless_chats(cx), vec![a]);
                assert_eq!(shell.project_label("~"), "Chats");
                let before = shell.session_summaries.len();
                shell.new_projectless_chat(cx);
                (before, shell.workspace.projects.contains(&"~".to_owned()))
            })
            .map(|(before, listed)| {
                assert!(!listed, "~ never joins the project rail");
                before
            })
            .and_then(|before| {
                cx.run_until_parked();
                window.update(cx, move |shell, _, cx| {
                    assert_eq!(shell.session_summaries.len(), before + 1);
                    let id = shell.workspace.active.unwrap();
                    assert_eq!(shell.session_metadata(id, cx).summary.cwd, "~");
                })
            })
            .unwrap();
    }
}
