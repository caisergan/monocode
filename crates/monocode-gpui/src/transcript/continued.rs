//! A continued chat's first message names the chat it continues at the top
//! of its bubble, and folds the recap that went out with it at the bottom:
//! one line of counts, opening into the recap's sections, or its raw text.
use super::*;
use monocode_core::agent::ContinuedFrom;
use monocode_core::recap::Recap;

/// Files and requests shown before "Show all".
const FILES_SHOWN: usize = 6;

#[derive(Default)]
pub(super) struct State {
    from: Option<ContinuedFrom>,
    /// The chat's folders, which file paths in the recap are shown inside.
    roots: Vec<String>,
    /// The newer chat this one continues in, marked under its last turn.
    next: Option<monocode_core::agent::ContinuedChat>,
    recap: Recap,
    open: bool,
    raw: bool,
    full_first: bool,
    full_response: bool,
    all_changed: bool,
    all_read: bool,
}

#[derive(Clone, Copy)]
enum Toggle {
    Open,
    Raw,
    FullFirst,
    FullResponse,
    AllChanged,
    AllRead,
}

impl TranscriptView {
    pub(crate) fn set_continued(
        &mut self,
        from: Option<ContinuedFrom>,
        roots: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        if self.continued.from == from {
            return;
        }
        let next = self.continued.next.take();
        let recap = from
            .as_ref()
            .map(|from| Recap::parse(&from.brief))
            .unwrap_or_default();
        self.continued = State {
            from,
            roots,
            next,
            recap,
            ..Default::default()
        };
        if let Some(start) = self.continued_start() {
            self.rebuild(start, cx);
        } else {
            cx.notify();
        }
    }

    /// The first prompt, once it is loaded, of a chat that continues another.
    pub(super) fn continued_start(&self) -> Option<usize> {
        if self.mono || self.continued.from.is_none() || self.history_before.is_some() {
            return None;
        }
        self.source
            .iter()
            .position(|row| row.first && row.role == "user")
    }

    fn toggle_continued(&mut self, toggle: Toggle, cx: &mut Context<Self>) {
        let state = &mut self.continued;
        let flag = match toggle {
            Toggle::Open => &mut state.open,
            Toggle::Raw => &mut state.raw,
            Toggle::FullFirst => &mut state.full_first,
            Toggle::FullResponse => &mut state.full_response,
            Toggle::AllChanged => &mut state.all_changed,
            Toggle::AllRead => &mut state.all_read,
        };
        *flag = !*flag;
        if let Some(start) = self.continued_start() {
            self.list.pause_following_tail();
            self.rebuild(start, cx);
        }
    }

    /// "Continued from" and the source's title, above the prompt's text.
    pub(super) fn continued_header(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let from = self.continued.from.as_ref()?;
        let session = from.session;
        Some(
            div()
                .id("continued-from")
                .debug_selector(|| "continued-from".into())
                .role(Role::Link)
                .aria_label(format!("Continued from {}. Open it", from.title))
                .group("continued-from")
                .cursor_pointer()
                .mb(px(6.))
                .pb(px(6.))
                .border_b_1()
                .border_color(content(0.08))
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(12.))
                .line_height(px(16.))
                .child(icon("continued", 12.).text_color(crate::conversation::continued_color()))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_color(content(0.55))
                        .child("Continued from"),
                )
                .child(provider_icon(&from.provider, 12.).flex_shrink_0())
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(content(1.))
                        .group_hover("continued-from", |s| s.underline())
                        .child(from.title.clone()),
                )
                .child(
                    icon("chevron-right", 12.)
                        .flex_shrink_0()
                        .text_color(content(0.4))
                        .group_hover("continued-from", |s| s.text_color(content(1.))),
                )
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(ResponseRequest::OpenSession { id: session })
                }))
                .into_any_element(),
        )
    }

    /// The recap, folded under the prompt's text.
    pub(super) fn continued_recap(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let from = self.continued.from.as_ref()?;
        if from.brief.trim().is_empty() {
            return None;
        }
        let state = &self.continued;
        let recap = &state.recap;
        let mut counts = Vec::new();
        let plural = |count: usize, one: &str, many: &str| {
            format!("{count} {}", if count == 1 { one } else { many })
        };
        if recap.request_count() > 0 {
            counts.push(plural(recap.request_count(), "request", "requests"));
        }
        if recap.changed_count() > 0 {
            counts.push(plural(
                recap.changed_count(),
                "file changed",
                "files changed",
            ));
        }
        if recap.read_count() > 0 {
            counts.push(format!("{} read", recap.read_count()));
        }
        let open = state.open;
        let strip = div()
            .id("continued-recap-toggle")
            .debug_selector(|| "continued-recap-toggle".into())
            .role(Role::Button)
            .aria_expanded(open)
            .aria_label(if open { "Hide recap" } else { "Show recap" })
            .group("continued-recap-toggle")
            .cursor_pointer()
            .h(px(28.))
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(11.5))
            .line_height(px(16.))
            .text_color(content(0.45))
            .hover(|s| s.text_color(content(0.8)))
            .child(icon("response-handoff", 12.).text_color(content(0.5)))
            .child(
                div()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(content(0.65))
                    .group_hover("continued-recap-toggle", |s| s.text_color(content(1.)))
                    .child("Recap"),
            )
            .children(counts.into_iter().enumerate().flat_map(|(ix, count)| {
                let dot = (ix > 0).then(|| {
                    div()
                        .size(px(3.))
                        .rounded_full()
                        .bg(content(0.3))
                        .into_any_element()
                });
                dot.into_iter()
                    .chain(std::iter::once(div().child(count).into_any_element()))
            }))
            .child(div().flex_1())
            .child(
                icon(
                    if open {
                        "chevron-down"
                    } else {
                        "chevron-right"
                    },
                    12.,
                )
                .text_color(content(0.45)),
            )
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _, _, cx| this.toggle_continued(Toggle::Open, cx)));
        Some(
            div()
                .id("continued-recap")
                .debug_selector(|| "continued-recap".into())
                .mt(px(8.))
                .border_t_1()
                .border_color(content(0.08))
                .flex()
                .flex_col()
                .child(strip)
                .when(open, |d| {
                    d.child(
                        div()
                            .pt(px(4.))
                            .pb(px(2.))
                            .flex()
                            .flex_col()
                            .gap(px(14.))
                            .when(state.raw || recap.is_empty(), |d| {
                                d.child(raw_recap(&from.brief))
                            })
                            .when(!state.raw && !recap.is_empty(), |d| {
                                d.children(self.recap_sections(from, cx))
                            })
                            .child(self.recap_footer(from, cx)),
                    )
                })
                .into_any_element(),
        )
    }

    fn recap_sections(
        &self,
        from: &ContinuedFrom,
        cx: &mut Context<Self>,
    ) -> Vec<gpui::AnyElement> {
        let state = &self.continued;
        let recap = &state.recap;
        let mut out = Vec::new();
        if let Some(first) = &recap.first_request {
            out.push(section(
                "Started with",
                None,
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .pl(px(10.))
                            .border_l_2()
                            .border_color(content(0.16))
                            .text_size(px(13.))
                            .line_height(px(19.))
                            .text_color(content(0.82))
                            .when(!state.full_first, |d| d.line_clamp(3).text_ellipsis())
                            .child(first.clone()),
                    )
                    .when(first.chars().count() > 220, |d| {
                        d.child(more_link(
                            "continued-first-more",
                            state.full_first,
                            cx.listener(|this, _, _, cx| {
                                this.toggle_continued(Toggle::FullFirst, cx)
                            }),
                        ))
                    }),
            ));
        }
        if !recap.requests.is_empty() {
            let count = recap.request_count().saturating_sub(1);
            let last = recap.requests.len() - 1;
            out.push(section(
                "Latest requests",
                Some(count),
                div()
                    .relative()
                    .pl(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .absolute()
                            .left(px(3.5))
                            .top(px(7.))
                            .bottom(px(7.))
                            .w(px(1.))
                            .bg(content(0.14)),
                    )
                    .when(recap.omitted > 0, |d| {
                        d.child(
                            div()
                                .text_size(px(11.5))
                                .line_height(px(16.))
                                .text_color(content(0.4))
                                .child(format!("{} earlier", recap.omitted)),
                        )
                    })
                    .children(recap.requests.iter().enumerate().map(|(ix, request)| {
                        let latest = ix == last;
                        div()
                            .relative()
                            .text_size(px(12.5))
                            .line_height(px(17.))
                            .text_color(content(if latest { 1. } else { 0.55 }))
                            .child(
                                div()
                                    .absolute()
                                    .left(px(-16.))
                                    .top(px(4.5))
                                    .size(px(8.))
                                    .rounded_full()
                                    .border_1()
                                    .when(latest, |d| {
                                        let amber = crate::conversation::continued_color();
                                        d.bg(amber).border_color(amber)
                                    })
                                    .when(!latest, |d| {
                                        d.bg(user_bubble_fill()).border_color(content(0.3))
                                    }),
                            )
                            .child(div().line_clamp(2).text_ellipsis().child(request.clone()))
                    })),
            ));
        }
        if let Some(response) = &recap.latest_response {
            out.push(section(
                "Where it left off",
                None,
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(12.5))
                            .line_height(px(19.))
                            .text_color(content(0.78))
                            .when(!state.full_response, |d| d.line_clamp(3).text_ellipsis())
                            .child(response.clone()),
                    )
                    .when(response.chars().count() > 240, |d| {
                        d.child(more_link(
                            "continued-response-more",
                            state.full_response,
                            cx.listener(|this, _, _, cx| {
                                this.toggle_continued(Toggle::FullResponse, cx)
                            }),
                        ))
                    }),
            ));
        }
        if !recap.changed.is_empty() {
            let shown = if state.all_changed {
                recap.changed.len()
            } else {
                FILES_SHOWN
            };
            let hidden = recap.changed.len().saturating_sub(shown);
            out.push(section(
                "Files changed",
                Some(recap.changed_count()),
                div()
                    .flex()
                    .flex_col()
                    .children(
                        recap
                            .changed
                            .iter()
                            .take(shown)
                            .enumerate()
                            .map(|(ix, path)| file_row(ix, path, &state.roots)),
                    )
                    .when(hidden > 0 || state.all_changed, |d| {
                        d.child(more_link(
                            "continued-changed-more",
                            state.all_changed,
                            cx.listener(|this, _, _, cx| {
                                this.toggle_continued(Toggle::AllChanged, cx)
                            }),
                        ))
                    })
                    .when(recap.changed_more > 0 && (hidden == 0), |d| {
                        d.child(
                            div()
                                .pt(px(2.))
                                .text_size(px(11.5))
                                .text_color(content(0.4))
                                .child(format!("and {} more", recap.changed_more)),
                        )
                    }),
            ));
        }
        if !recap.read.is_empty() {
            let shown = if state.all_read {
                recap.read.len()
            } else {
                FILES_SHOWN
            };
            let hidden = recap.read.len().saturating_sub(shown) + recap.read_more;
            out.push(section(
                "Files read",
                Some(recap.read_count()),
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(5.))
                    .children(
                        recap
                            .read
                            .iter()
                            .take(shown)
                            .enumerate()
                            .map(|(ix, path)| file_chip(ix, path)),
                    )
                    .when(hidden > 0 && !state.all_read, |d| {
                        d.child(
                            chip("continued-read-more")
                                .child(format!("+{hidden}"))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.toggle_continued(Toggle::AllRead, cx)
                                })),
                        )
                    }),
            ));
        }
        for (ix, (heading, body)) in recap.other.iter().enumerate() {
            let title = if heading.is_empty() {
                "Summary"
            } else {
                heading.as_str()
            };
            out.push(section_owned(
                SharedString::from(title.to_owned()),
                None,
                div()
                    .id(("continued-other", ix))
                    .text_size(px(12.5))
                    .line_height(px(19.))
                    .text_color(content(0.78))
                    .child(body.clone()),
            ));
        }
        if recap.earlier || from.earlier.is_some() {
            out.push(self.earlier_link(from, cx));
        }
        out
    }

    fn earlier_link(&self, from: &ContinuedFrom, cx: &mut Context<Self>) -> gpui::AnyElement {
        let row = div()
            .id("continued-earlier")
            .debug_selector(|| "continued-earlier".into())
            .px(px(9.))
            .py(px(6.))
            .rounded(px(8.))
            .border_1()
            .border_color(content(0.06))
            .bg(content(0.035))
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(12.))
            .line_height(px(16.))
            .text_color(content(0.55))
            .child(icon("continued", 12.).text_color(crate::conversation::continued_color()));
        match &from.earlier {
            Some(earlier) => {
                let session = earlier.session;
                row.role(Role::Link)
                    .aria_label(format!("Open {}", earlier.title))
                    .cursor_pointer()
                    .hover(|s| s.bg(content(0.06)))
                    .child(div().flex_shrink_0().child("Also carries the recap of"))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(content(1.))
                            .child(earlier.title.clone()),
                    )
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ResponseRequest::OpenSession { id: session })
                    }))
                    .into_any_element()
            }
            None => row
                .child("Also carries an earlier chat's recap")
                .into_any_element(),
        }
    }

    fn recap_footer(&self, from: &ContinuedFrom, cx: &mut Context<Self>) -> gpui::AnyElement {
        let raw = self.continued.raw;
        let structured = !self.continued.recap.is_empty();
        let brief = from.brief.clone();
        div()
            .pt(px(8.))
            .border_t_1()
            .border_color(content(0.08))
            .flex()
            .items_center()
            .gap(px(4.))
            .text_size(px(11.))
            .line_height(px(16.))
            .text_color(content(0.35))
            .child(div().flex_1().truncate().child(format!(
                "Sent with this message · {} chars",
                thousands(from.brief.chars().count())
            )))
            .when(structured, |d| {
                d.child(
                    footer_button("continued-raw", "Raw", raw)
                        .aria_label(if raw {
                            "Show sections"
                        } else {
                            "Show raw recap"
                        })
                        .on_click(
                            cx.listener(|this, _, _, cx| this.toggle_continued(Toggle::Raw, cx)),
                        ),
                )
            })
            .child(
                footer_button("continued-copy", "Copy", false)
                    .aria_label("Copy recap")
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(brief.clone()))
                    }),
            )
            .into_any_element()
    }
}

fn section(title: &'static str, count: Option<usize>, body: impl IntoElement) -> gpui::AnyElement {
    section_owned(title.into(), count, body)
}

fn section_owned(
    title: SharedString,
    count: Option<usize>,
    body: impl IntoElement,
) -> gpui::AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(10.5))
                .line_height(px(14.))
                .child(
                    div()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(content(0.42))
                        .child(SharedString::from(title.to_uppercase())),
                )
                .children(
                    count.map(|count| div().text_color(content(0.3)).child(count.to_string())),
                ),
        )
        .child(body)
        .into_any_element()
}

fn more_link(
    id: &'static str,
    open: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> impl IntoElement {
    div().pt(px(3.)).flex().child(
        div()
            .id(id)
            .role(Role::Button)
            .aria_expanded(open)
            .cursor_pointer()
            .text_size(px(11.5))
            .line_height(px(16.))
            .text_color(content(0.4))
            .hover(|s| s.text_color(content(1.)))
            .child(if open { "Show less" } else { "Show all" })
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(on_click),
    )
}

/// A path as its name, with its folder dimmed after it.
fn split_path(path: &str) -> (String, String) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((dir, name)) => (name.to_owned(), dir.to_owned()),
        None => (trimmed.to_owned(), String::new()),
    }
}

/// A path inside one of the chat's folders, without that folder.
fn relative<'a>(path: &'a str, roots: &[String]) -> &'a str {
    roots
        .iter()
        .filter(|root| !root.is_empty())
        .find_map(|root| {
            path.strip_prefix(root.trim_end_matches('/'))?
                .strip_prefix('/')
        })
        .unwrap_or(path)
}

fn file_row(ix: usize, path: &str, roots: &[String]) -> gpui::AnyElement {
    let (name, dir) = split_path(relative(path, roots));
    let open = path.to_owned();
    div()
        .id(("continued-changed", ix))
        .role(Role::Link)
        .aria_label(format!("Open {path}"))
        .cursor_pointer()
        .h(px(24.))
        .px(px(4.))
        .rounded(px(6.))
        .hover(|s| s.bg(content(0.05)))
        .flex()
        .items_center()
        .gap(px(7.))
        .text_size(px(12.5))
        .line_height(px(16.))
        .child(
            div()
                .size(px(6.))
                .flex_shrink_0()
                .rounded(px(2.))
                .bg(crate::conversation::continued_color()),
        )
        .child(div().flex_shrink_0().text_color(content(1.)).child(name))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .truncate()
                .text_color(content(0.3))
                .child(dir),
        )
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            window.dispatch_action(Box::new(crate::file_editor::OpenPath(open.clone())), cx)
        })
        .into_any_element()
}

fn chip(id: impl Into<gpui::ElementId>) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .cursor_pointer()
        .px(px(7.))
        .py(px(2.))
        .rounded(px(6.))
        .border_1()
        .border_color(content(0.07))
        .bg(content(0.05))
        .text_size(px(11.5))
        .line_height(px(16.))
        .text_color(content(0.55))
        .hover(|s| s.bg(content(0.08)).text_color(content(1.)))
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

fn file_chip(ix: usize, path: &str) -> gpui::AnyElement {
    let (name, _) = split_path(path);
    let open = path.to_owned();
    chip(("continued-read", ix))
        .role(Role::Link)
        .aria_label(format!("Open {path}"))
        .child(name)
        .on_click(move |_, window, cx| {
            window.dispatch_action(Box::new(crate::file_editor::OpenPath(open.clone())), cx)
        })
        .into_any_element()
}

fn footer_button(id: &'static str, label: &'static str, on: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .role(Role::Button)
        .cursor_pointer()
        .px(px(6.))
        .py(px(2.))
        .rounded(px(5.))
        .text_color(content(if on { 1. } else { 0.45 }))
        .when(on, |d| d.bg(content(0.08)))
        .hover(|s| s.bg(content(0.06)).text_color(content(1.)))
        .child(label)
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

impl TranscriptView {
    pub(crate) fn set_continued_in(
        &mut self,
        next: Option<monocode_core::agent::ContinuedChat>,
        cx: &mut Context<Self>,
    ) {
        if self.continued.next != next {
            self.continued.next = next;
            let footer = self.footer_ix();
            self.list.remeasure_items(footer..footer + 1);
            cx.notify();
        }
    }

    /// The room the "Continued in" mark takes under the last turn.
    pub(super) fn continued_in_height(&self) -> f32 {
        if self.continued.next.is_some() && !self.mono {
            CONTINUED_IN_HEIGHT
        } else {
            0.
        }
    }

    /// A rule under the last turn naming the chat this one continues in.
    pub(super) fn continued_in_mark(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if self.mono {
            return None;
        }
        let next = self.continued.next.as_ref()?;
        let session = next.session;
        let rule = || div().h(px(1.)).min_w(px(16.)).flex_1().bg(content(0.12));
        Some(
            div()
                .w_full()
                .h(px(CONTINUED_IN_HEIGHT))
                .flex()
                .justify_center()
                .child(
                    div()
                        .w_full()
                        .max_w(px(COLUMN))
                        .px(px(crate::theme::COLUMN_PAD))
                        .flex()
                        .items_center()
                        .gap_3()
                        .child(rule())
                        .child(
                            div()
                                .id("continued-in")
                                .debug_selector(|| "continued-in".into())
                                .role(Role::Link)
                                .aria_label(format!("Continued in {}. Open it", next.title))
                                .group("continued-in")
                                .cursor_pointer()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .text_color(content(0.45))
                                .child(
                                    icon("continued", 12.)
                                        .text_color(crate::conversation::continued_color()),
                                )
                                .child(div().flex_shrink_0().child("Continued in"))
                                .child(
                                    div()
                                        .min_w_0()
                                        .max_w(px(320.))
                                        .truncate()
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(content(1.))
                                        .group_hover("continued-in", |s| s.underline())
                                        .child(next.title.clone()),
                                )
                                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                                    cx.stop_propagation()
                                })
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    cx.emit(ResponseRequest::OpenSession { id: session })
                                })),
                        )
                        .child(rule()),
                )
                .into_any_element(),
        )
    }
}

const CONTINUED_IN_HEIGHT: f32 = 40.;

/// The recap as it was sent, in a small monospace block.
fn raw_recap(brief: &str) -> gpui::AnyElement {
    div()
        .id("continued-recap-raw")
        .max_h(px(220.))
        .overflow_y_scroll()
        .px(px(10.))
        .py(px(8.))
        .rounded(px(8.))
        .border_1()
        .border_color(content(0.08))
        .bg(background_base().opacity(0.6))
        .font_family(crate::fonts::mono())
        .text_size(px(11.))
        .line_height(px(16.))
        .text_color(content(0.65))
        .child(brief.trim().to_owned())
        .into_any_element()
}

fn thousands(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_into_name_and_folder() {
        assert_eq!(
            split_path("crates/gpui/src/shell.rs"),
            ("shell.rs".into(), "crates/gpui/src".into())
        );
        assert_eq!(split_path("README.md"), ("README.md".into(), String::new()));
    }

    #[test]
    fn paths_inside_the_chat_folder_drop_it() {
        let roots = ["/work/app/".to_string(), "/other".to_string()];
        assert_eq!(relative("/work/app/src/a.rs", &roots), "src/a.rs");
        assert_eq!(relative("/other/b.rs", &roots), "b.rs");
        assert_eq!(
            relative("/work/application/c.rs", &roots),
            "/work/application/c.rs"
        );
    }

    #[test]
    fn counts_get_thousands_separators() {
        assert_eq!(thousands(7), "7");
        assert_eq!(thousands(1742), "1,742");
        assert_eq!(thousands(1_000_000), "1,000,000");
    }
}
