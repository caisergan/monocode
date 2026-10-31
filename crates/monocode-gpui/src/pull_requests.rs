//! GitPullRequests.tsx: the Changes tab's Pull requests section. A folding
//! header with the open count, and Open, Merged and Closed tabs. Rows show the
//! status, title, number, branch, author (unless it is you), review decision,
//! a CI dot for open PRs, and when each was updated, merged or closed. The
//! checked-out branch's PR leads the Open list. Clicking a row opens the PR
//! in the Inbox's detail view.
use crate::{
    popover::{Align, Anchor, Menu, MenuAction, MenuEvent, MenuItem, MenuStyle, menu_popover},
    theme::*,
};
use gpui::{
    AnyElement, ClickEvent, ClipboardItem, Context, Entity, EventEmitter, Hsla, MouseButton,
    Pixels, Point, Role, Subscription, Window, div, prelude::*, px, rgb,
};
use monocode_core::{
    inbox::Item,
    scm::{self, PullRequest, PullRequestList},
};
use std::{collections::HashMap, path::PathBuf};

const STATES: [(&str, &str); 3] = [("open", "Open"), ("merged", "Merged"), ("closed", "Closed")];
const LIST_HEIGHT: f32 = 240.;

struct RowMenu {
    pr: PullRequest,
    at: Point<Pixels>,
    menu: Entity<Menu>,
    _events: Subscription,
}

/// A row was clicked: show this pull request's detail.
pub(crate) struct OpenPullRequest(pub Item);

pub(crate) struct PullRequests {
    cwd: String,
    enabled: bool,
    open: bool,
    tab: &'static str,
    /// Each state's last list, or why it could not be read.
    lists: HashMap<&'static str, Result<PullRequestList, String>>,
    loading: bool,
    request: u64,
    branch: Option<String>,
    status: Option<String>,
    menu: Option<RowMenu>,
}

impl EventEmitter<OpenPullRequest> for PullRequests {}

impl PullRequests {
    pub(crate) fn new() -> Self {
        Self {
            cwd: String::new(),
            enabled: false,
            open: true,
            tab: "open",
            lists: HashMap::new(),
            loading: false,
            request: 0,
            branch: None,
            status: None,
            menu: None,
        }
    }
    /// The project and checked-out branch the Changes tab shows.
    pub(crate) fn set_project(
        &mut self,
        cwd: &str,
        branch: Option<String>,
        enabled: bool,
        cx: &mut Context<Self>,
    ) {
        let moved = cwd != self.cwd;
        let woke = enabled && !self.enabled;
        self.branch = branch;
        self.enabled = enabled;
        if moved {
            self.cwd = cwd.to_owned();
            self.lists.clear();
            self.menu = None;
            self.status = None;
        }
        if moved || woke {
            self.load(cx);
        } else {
            cx.notify();
        }
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if !self.enabled || !self.open || self.cwd.is_empty() || self.cwd == "~" {
            return;
        }
        self.request += 1;
        let request = self.request;
        let tab = self.tab;
        let path = PathBuf::from(&self.cwd);
        self.loading = true;
        let work = cx
            .background_executor()
            .spawn(async move { scm::pull_requests(&path, tab, 30) });
        cx.spawn(async move |this, cx| {
            let list = work.await;
            let _ = this.update(cx, |this, cx| {
                if this.request == request {
                    this.loading = false;
                    this.lists.insert(tab, list);
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }
    fn select(&mut self, tab: &'static str, cx: &mut Context<Self>) {
        self.tab = tab;
        self.load(cx);
    }
    fn toggle(&mut self, cx: &mut Context<Self>) {
        self.open = !self.open;
        if self.open {
            self.load(cx);
        }
        cx.notify();
    }
    /// The tab's rows, the checked-out branch's PR first in Open.
    fn rows(&self) -> Vec<PullRequest> {
        let Some(Ok(list)) = self.lists.get(self.tab) else {
            return Vec::new();
        };
        let mut rows = list.items.clone();
        if self.tab == "open"
            && let Some(branch) = &self.branch
            && let Some(ix) = rows
                .iter()
                .position(|pr| &pr.head_ref == branch && !pr.cross_repository)
        {
            let current = rows.remove(ix);
            rows.insert(0, current);
        }
        rows
    }
    /// The pull request as the Inbox lists GitHub PRs, so its detail view
    /// can load it from this project's checkout.
    fn inbox_item(&self, pr: &PullRequest) -> Item {
        let repo = match self.lists.get(self.tab) {
            Some(Ok(list)) => list.repo.clone(),
            _ => String::new(),
        };
        Item {
            provider: "github".into(),
            kind: "pr".into(),
            number: pr.number as i64,
            title: pr.title.clone(),
            url: pr.url.clone(),
            state: pr.state.clone(),
            updated_at: pr.changed_at().to_owned(),
            draft: pr.draft,
            repo,
            project_path: self.cwd.clone(),
            ..Default::default()
        }
    }
    fn open_menu(
        &mut self,
        pr: PullRequest,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items: Vec<MenuItem> = vec![
            MenuAction::new("open", "Open on GitHub").into(),
            MenuAction::new("copy-link", "Copy link").into(),
            MenuAction::new("copy-branch", "Copy branch name")
                .disabled(pr.head_ref.is_empty())
                .into(),
            MenuItem::Separator,
            MenuAction::new("checkout", "Check out branch")
                .disabled(self.branch.as_deref() == Some(pr.head_ref.as_str()))
                .into(),
        ];
        let menu = cx.new(|cx| {
            Menu::new("Pull request actions", items, window, cx)
                .width(188.)
                .style(MenuStyle::Git)
        });
        let events = cx.subscribe_in(&menu, window, |this, _, event: &MenuEvent, _, cx| {
            let Some(open) = this.menu.take() else {
                return;
            };
            if let MenuEvent::Picked(id, _) = event {
                this.run(id, open.pr, cx);
            }
            cx.notify();
        });
        self.menu = Some(RowMenu {
            pr,
            at,
            menu,
            _events: events,
        });
        cx.notify();
    }
    fn run(&mut self, action: &str, pr: PullRequest, cx: &mut Context<Self>) {
        match action {
            "open" => cx.open_url(&pr.url),
            "copy-link" => cx.write_to_clipboard(ClipboardItem::new_string(pr.url)),
            "copy-branch" => cx.write_to_clipboard(ClipboardItem::new_string(pr.head_ref)),
            "checkout" => {
                let path = PathBuf::from(&self.cwd);
                let number = pr.number;
                self.status = Some(format!("Checking out #{number}…"));
                let work = cx
                    .background_executor()
                    .spawn(async move { scm::pr_checkout(&path, number) });
                cx.spawn(async move |this, cx| {
                    let result = work.await;
                    let _ = this.update(cx, |this, cx| {
                        this.status = result.err();
                        cx.notify();
                    });
                })
                .detach();
                cx.notify();
            }
            _ => {}
        }
    }
    fn header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let count = self
            .lists
            .get("open")
            .and_then(|list| list.as_ref().ok())
            .map(|list| list.items.len());
        div()
            .id("pull-requests-header")
            .debug_selector(|| "pull-requests-header".into())
            .role(Role::Button)
            .aria_expanded(self.open)
            .aria_label("Pull requests")
            .h(px(28.))
            .px_3()
            .flex()
            .items_center()
            .gap_1p5()
            .cursor_pointer()
            .text_size(px(11.))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(content(0.6))
            .hover(|s| s.text_color(content(0.9)))
            .child(icon(
                if self.open {
                    "chevron-down"
                } else {
                    "chevron-right"
                },
                12.,
            ))
            .child("Pull requests")
            .when_some(count.filter(|count| *count > 0), |d, count| {
                d.child(
                    div()
                        .px_1p5()
                        .rounded_full()
                        .bg(content(0.08))
                        .text_size(px(10.))
                        .child(count.to_string()),
                )
            })
            .child(div().flex_1())
            .when(self.open, |d| {
                d.child(
                    div()
                        .id("pull-requests-refresh")
                        .role(Role::Button)
                        .aria_label("Refresh pull requests")
                        .p_0p5()
                        .rounded_sm()
                        .hover(|s| s.bg(content(0.08)))
                        .child(icon(
                            if self.loading { "loader" } else { "refresh-cw" },
                            12.,
                        ))
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            this.load(cx);
                        })),
                )
            })
            .on_click(cx.listener(|this, _, _, cx| this.toggle(cx)))
    }
    fn tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_3()
            .pb_1()
            .flex()
            .gap_1()
            .children(STATES.map(|(id, label)| {
                let selected = self.tab == id;
                div()
                    .id(("pull-requests-tab", id.len() + label.len()))
                    .role(Role::Tab)
                    .aria_selected(selected)
                    .px_2()
                    .py_0p5()
                    .rounded_md()
                    .cursor_pointer()
                    .text_size(px(11.))
                    .text_color(if selected { content(1.) } else { content(0.5) })
                    .when(selected, |d| d.bg(content(0.08)))
                    .hover(|s| s.text_color(content(0.9)))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| this.select(id, cx)))
            }))
    }
    fn row(&self, ix: usize, pr: PullRequest, viewer: &str, cx: &mut Context<Self>) -> AnyElement {
        let (glyph, color): (&str, Hsla) = match pr.state.as_str() {
            "merged" => ("git-merge", rgb(0xa78bfa).into()),
            "closed" => ("git-pull-request-closed", rgb(0xf87171).into()),
            _ if pr.draft => ("git-pull-request-draft", content(0.45)),
            _ => ("git-pull-request", rgb(0x4ade80).into()),
        };
        let current = self.tab == "open"
            && self.branch.as_deref() == Some(pr.head_ref.as_str())
            && !pr.cross_repository;
        let mut detail = vec![format!("#{}", pr.number)];
        if !pr.head_ref.is_empty() {
            detail.push(pr.head_ref.clone());
        }
        if !pr.author.is_empty() && !pr.author.eq_ignore_ascii_case(viewer) {
            detail.push(pr.author.clone());
        }
        let review: Option<(&str, Hsla)> = match pr.review_decision.as_str() {
            "APPROVED" => Some(("Approved", rgb(0x4ade80).into())),
            "CHANGES_REQUESTED" => Some(("Changes requested", rgb(0xf87171).into())),
            _ => None,
        };
        let checks: Option<Hsla> = match pr.checks.as_str() {
            "pass" => Some(rgb(0x4ade80).into()),
            "fail" => Some(rgb(0xf87171).into()),
            "pending" => Some(rgb(0xfbbf24).into()),
            _ => None,
        };
        let when = monocode_core::inbox::relative_time(pr.changed_at());
        let item = self.inbox_item(&pr);
        div()
            .id(("pull-request", ix))
            .role(Role::Link)
            .aria_label(format!("Pull request #{} {}", pr.number, pr.title))
            .px_3()
            .py_1()
            .flex()
            .gap_2()
            .cursor_pointer()
            .rounded_md()
            .hover(|s| s.bg(content(0.05)))
            .child(div().pt(px(2.)).child(icon(glyph, 14.).text_color(color)))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .text_size(px(12.))
                            .text_color(content(0.9))
                            .child(div().min_w_0().truncate().child(pr.title.clone()))
                            .when(current, |d| {
                                d.child(
                                    div()
                                        .flex_shrink_0()
                                        .px_1()
                                        .rounded_sm()
                                        .bg(content(0.08))
                                        .text_size(px(10.))
                                        .text_color(content(0.6))
                                        .child("Current branch"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .text_size(px(11.))
                            .text_color(content(0.45))
                            .child(div().min_w_0().truncate().child(detail.join(" · ")))
                            .when_some(review, |d, (label, color)| {
                                d.child(div().flex_shrink_0().text_color(color).child(label))
                            })
                            .when_some(checks, |d, color| {
                                d.child(div().flex_shrink_0().size(px(6.)).rounded_full().bg(color))
                            })
                            .child(div().flex_1())
                            .child(div().flex_shrink_0().child(when)),
                    ),
            )
            .on_click(
                cx.listener(move |_, _: &ClickEvent, _, cx| cx.emit(OpenPullRequest(item.clone()))),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &gpui::MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.open_menu(pr.clone(), event.position, window, cx);
                }),
            )
            .into_any_element()
    }
}

impl Render for PullRequests {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewer = self
            .lists
            .get(self.tab)
            .and_then(|list| list.as_ref().ok())
            .map(|list| list.viewer.clone())
            .unwrap_or_default();
        let rows = self.rows();
        let empty = match self.lists.get(self.tab) {
            None if self.loading => Some("Loading pull requests…".to_owned()),
            None => Some("Pull requests load when this section is open.".to_owned()),
            Some(Err(error)) => Some(error.clone()),
            Some(Ok(_)) if rows.is_empty() => Some(format!(
                "No {} pull requests",
                STATES
                    .iter()
                    .find(|(id, _)| *id == self.tab)
                    .map_or("", |(_, label)| label)
                    .to_lowercase()
            )),
            Some(Ok(_)) => None,
        };
        let menu = self
            .menu
            .as_ref()
            .map(|open| menu_popover(&open.menu, Anchor::Point(open.at), cx).align(Align::Start));
        div()
            .id("pull-requests")
            .debug_selector(|| "pull-requests".into())
            .role(Role::Region)
            .aria_label("Pull requests")
            .flex_shrink_0()
            .flex()
            .flex_col()
            .border_t_1()
            .border_color(content(0.08))
            .child(self.header(cx))
            .when(self.open, |d| {
                d.child(self.tabs(cx))
                    .when_some(self.status.clone(), |d, status| {
                        d.child(
                            div()
                                .px_3()
                                .pb_1()
                                .text_size(px(11.))
                                .text_color(content(0.55))
                                .child(status),
                        )
                    })
                    .child(match empty {
                        Some(text) => div()
                            .px_3()
                            .pt_1()
                            .pb_2()
                            .text_size(px(12.))
                            .text_color(content(0.45))
                            .child(text)
                            .into_any_element(),
                        None => div()
                            .id("pull-request-rows")
                            .max_h(px(LIST_HEIGHT))
                            .overflow_y_scroll()
                            .pb_1()
                            .children(
                                rows.into_iter()
                                    .enumerate()
                                    .map(|(ix, pr)| self.row(ix, pr, &viewer, cx)),
                            )
                            .into_any_element(),
                    })
            })
            .children(menu)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: u64, head: &str) -> PullRequest {
        PullRequest {
            number,
            head_ref: head.into(),
            state: "open".into(),
            ..Default::default()
        }
    }

    #[test]
    fn the_checked_out_branch_leads_the_open_list() {
        let mut view = PullRequests::new();
        view.branch = Some("fix/b".into());
        view.lists.insert(
            "open",
            Ok(PullRequestList {
                items: vec![pr(3, "feat/a"), pr(2, "fix/b"), pr(1, "fix/c")],
                ..Default::default()
            }),
        );
        let numbers =
            |view: &PullRequests| view.rows().iter().map(|p| p.number).collect::<Vec<_>>();
        assert_eq!(numbers(&view), vec![2, 3, 1]);
        view.tab = "merged";
        assert!(view.rows().is_empty());
    }

    #[test]
    fn a_row_opens_as_the_inbox_lists_the_same_github_pr() {
        let mut view = PullRequests::new();
        view.cwd = "/work/app".into();
        view.lists.insert(
            "open",
            Ok(PullRequestList {
                repo: "Acme/App".into(),
                items: vec![pr(58, "feat/a")],
                ..Default::default()
            }),
        );
        let item = view.inbox_item(&view.rows()[0]);
        let listed = Item {
            provider: "github".into(),
            kind: "pr".into(),
            repo: "acme/app".into(),
            number: 58,
            ..Default::default()
        };
        assert_eq!(item.key(), listed.key());
        assert_eq!(item.project_path, "/work/app");
    }
}
