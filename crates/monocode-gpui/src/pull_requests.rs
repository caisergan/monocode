//! GitPullRequests.tsx: the project's pull requests, as a folding section
//! under a Mono's changed files or as the right panel's own tab. Both have
//! Open, Merged and Closed lists. Rows show the status, title, number, branch,
//! author (unless it is you), review decision, a CI dot for open PRs, and
//! when each was updated, merged or closed. Clicking a row opens the PR in the
//! linked-work panel beside the chat.
//!
//! The tab leads with the checked-out branch: its pull request with the
//! checks and the one next step (push, ready for review, merge), or the
//! commits a new one would carry. Below it the rest, split into yours and
//! others while open and by week once merged or closed.
use crate::{
    input::{self, Input},
    popover::{Align, Anchor, Menu, MenuAction, MenuEvent, MenuItem, MenuStyle, menu_popover},
    right_panel::{icon_action, spinner, stroke},
    theme::*,
};
use gpui::{
    AnyElement, ClickEvent, ClipboardItem, Context, Entity, EventEmitter, FontWeight, Hsla,
    MouseButton, Pixels, Point, Role, Subscription, Window, div, prelude::*, px, relative, rgb,
};
use monocode_core::{
    inbox::Item,
    scm::{self, BranchCommits, PullRequest, PullRequestList},
};
use std::{collections::HashMap, path::PathBuf};

const STATES: [(&str, &str); 3] = [("open", "Open"), ("merged", "Merged"), ("closed", "Closed")];
const LIST_HEIGHT: f32 = 240.;
const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const GREEN: u32 = 0x4ade80;
const RED: u32 = 0xf87171;
const AMBER: u32 = 0xfbbf24;
const MERGE_METHODS: [(&str, &str); 3] = [
    ("merge", "Create a merge commit"),
    ("squash", "Squash and merge"),
    ("rebase", "Rebase and merge"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum MenuFor {
    Row,
    Merge,
}

struct RowMenu {
    pr: PullRequest,
    kind: MenuFor,
    at: Point<Pixels>,
    menu: Entity<Menu>,
    _events: Subscription,
}

/// A row was clicked: show this pull request's detail.
pub(crate) struct OpenPullRequest(pub Item);

/// The branch card asks the Changes flow to act on the checked-out branch.
pub(crate) enum BranchAction {
    Create { draft: bool },
    Push,
}

/// What the tab needs to know about the checked-out branch beyond its name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct BranchState {
    /// Commits not yet pushed to the upstream.
    pub ahead: i64,
    pub on_default: bool,
    pub default_branch: Option<String>,
    /// Why a pull request can't be created yet, as Changes decides it.
    pub blocker: Option<String>,
    /// Changes is pushing or creating the pull request.
    pub busy: bool,
}

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
    /// The right panel's tab rather than a section under changed files.
    tab_mode: bool,
    query: Option<Entity<Input>>,
    mine: bool,
    local: BranchState,
    commits: Option<Result<BranchCommits, String>>,
    commits_request: u64,
    loaded_at: Option<u64>,
    hovered: Option<u64>,
    /// A merge, ready or delete in flight, as its button reads meanwhile.
    working: Option<String>,
    merge_method: &'static str,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<OpenPullRequest> for PullRequests {}
impl EventEmitter<BranchAction> for PullRequests {}

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
            tab_mode: false,
            query: None,
            mine: false,
            local: BranchState::default(),
            commits: None,
            commits_request: 0,
            loaded_at: None,
            hovered: None,
            working: None,
            merge_method: "merge",
            _subscriptions: Vec::new(),
        }
    }
    /// The right panel's Pull requests tab.
    pub(crate) fn tab(cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| {
            let mut input = Input::field(
                "Filter pull requests",
                "Filter by title, #, branch, author",
                content(0.35),
                cx,
            );
            input.set_font_size(12.);
            input
        });
        let subscription = cx.subscribe(&query, |_, _, _: &input::Changed, cx| cx.notify());
        Self {
            tab_mode: true,
            query: Some(query),
            _subscriptions: vec![subscription],
            ..Self::new()
        }
    }
    pub(crate) fn set_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let (cwd, branch) = (self.cwd.clone(), self.branch.clone());
        self.set_project(&cwd, branch, enabled, cx);
    }
    pub(crate) fn set_branch_state(&mut self, state: BranchState, cx: &mut Context<Self>) {
        if self.local != state {
            let finished = self.local.busy && !state.busy;
            self.local = state;
            // A push or a new pull request changes what the card shows.
            if finished {
                self.load(cx);
            }
            cx.notify();
        }
    }
    /// How many pull requests are open, once the list has loaded.
    pub(crate) fn open_count(&self) -> Option<usize> {
        self.lists
            .get("open")
            .and_then(|list| list.as_ref().ok())
            .map(|list| list.items.len())
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
        let switched = branch != self.branch;
        self.branch = branch;
        self.enabled = enabled;
        if moved {
            self.cwd = cwd.to_owned();
            self.lists.clear();
            self.menu = None;
            self.status = None;
            self.commits = None;
            self.loaded_at = None;
        }
        if moved || woke {
            self.load(cx);
        } else if switched && self.tab_mode {
            self.commits = None;
            self.load_commits(cx);
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
        // The tab's branch card and count read the open list on every state.
        let also_open = self.tab_mode && tab != "open";
        let path = PathBuf::from(&self.cwd);
        self.loading = true;
        let work = cx.background_executor().spawn(async move {
            let list = scm::pull_requests(&path, tab, 30);
            let open = also_open.then(|| scm::pull_requests(&path, "open", 30));
            (list, open)
        });
        cx.spawn(async move |this, cx| {
            let (list, open) = work.await;
            let _ = this.update(cx, |this, cx| {
                if this.request == request {
                    this.loading = false;
                    this.lists.insert(tab, list);
                    if let Some(open) = open {
                        this.lists.insert("open", open);
                    }
                    this.loaded_at = Some(monocode_core::time::now_ms());
                    cx.notify();
                }
            });
        })
        .detach();
        if self.tab_mode {
            self.load_commits(cx);
        }
        cx.notify();
    }
    /// The commits a pull request from this branch would carry.
    fn load_commits(&mut self, cx: &mut Context<Self>) {
        if !self.enabled || self.cwd.is_empty() || self.cwd == "~" || self.branch.is_none() {
            return;
        }
        self.commits_request += 1;
        let request = self.commits_request;
        let path = PathBuf::from(&self.cwd);
        let work = cx
            .background_executor()
            .spawn(async move { scm::branch_commits(&path, 4) });
        cx.spawn(async move |this, cx| {
            let commits = work.await;
            let _ = this.update(cx, |this, cx| {
                if this.commits_request == request {
                    this.commits = Some(commits);
                    cx.notify();
                }
            });
        })
        .detach();
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
    /// The checked-out branch's open pull request.
    fn current(&self) -> Option<PullRequest> {
        let branch = self.branch.as_ref()?;
        let Some(Ok(list)) = self.lists.get("open") else {
            return None;
        };
        list.items
            .iter()
            .find(|pr| &pr.head_ref == branch && !pr.cross_repository)
            .cloned()
    }
    fn viewer(&self) -> String {
        self.lists
            .get(self.tab)
            .or_else(|| self.lists.get("open"))
            .and_then(|list| list.as_ref().ok())
            .map(|list| list.viewer.clone())
            .unwrap_or_default()
    }
    /// The tab's rows under the branch card: the search and Mine applied,
    /// the card's own pull request left out.
    fn filtered_by(&self, query: &str) -> Vec<PullRequest> {
        let viewer = self.viewer();
        let current = self.current().map(|pr| pr.number);
        let query = query.trim().to_lowercase();
        let query = query.strip_prefix('#').unwrap_or(&query).to_owned();
        self.rows()
            .into_iter()
            .filter(|pr| self.tab != "open" || Some(pr.number) != current)
            .filter(|pr| !self.mine || viewer.is_empty() || pr.author.eq_ignore_ascii_case(&viewer))
            .filter(|pr| {
                query.is_empty()
                    || pr.number.to_string().starts_with(&query)
                    || pr.title.to_lowercase().contains(&query)
                    || pr.head_ref.to_lowercase().contains(&query)
                    || pr.author.to_lowercase().contains(&query)
            })
            .collect()
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
        let mut items: Vec<MenuItem> = vec![
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
        if self.can_delete_branch(&pr) {
            items.push(MenuAction::new("delete-branch", "Delete local branch").into());
        }
        self.show_menu(pr, MenuFor::Row, items, 188., at, window, cx);
    }
    fn open_merge_menu(
        &mut self,
        pr: PullRequest,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items = MERGE_METHODS
            .iter()
            .map(|&(id, label)| {
                MenuAction::new(id, label)
                    .checked(self.merge_method == id)
                    .into()
            })
            .collect();
        self.show_menu(pr, MenuFor::Merge, items, 200., at, window, cx);
    }
    #[allow(clippy::too_many_arguments)]
    fn show_menu(
        &mut self,
        pr: PullRequest,
        kind: MenuFor,
        items: Vec<MenuItem>,
        width: f32,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let label = match kind {
            MenuFor::Row => "Pull request actions",
            MenuFor::Merge => "Merge method",
        };
        let menu = cx.new(|cx| {
            Menu::new(label, items, window, cx)
                .width(width)
                .style(MenuStyle::Git)
        });
        let events = cx.subscribe_in(&menu, window, |this, _, event: &MenuEvent, window, cx| {
            let Some(open) = this.menu.take() else {
                return;
            };
            if let MenuEvent::Picked(id, _) = event {
                match open.kind {
                    MenuFor::Row => this.run(id, open.pr, window, cx),
                    MenuFor::Merge => {
                        if let Some(&(method, _)) =
                            MERGE_METHODS.iter().find(|(m, _)| *m == id.as_ref())
                        {
                            this.merge_method = method;
                            this.merge(open.pr, window, cx);
                        }
                    }
                }
            }
            cx.notify();
        });
        self.menu = Some(RowMenu {
            pr,
            kind,
            at,
            menu,
            _events: events,
        });
        cx.notify();
    }
    fn can_delete_branch(&self, pr: &PullRequest) -> bool {
        pr.state == "merged"
            && !pr.cross_repository
            && !pr.head_ref.is_empty()
            && self.branch.as_deref() != Some(pr.head_ref.as_str())
            && self
                .lists
                .get(self.tab)
                .and_then(|list| list.as_ref().ok())
                .is_some_and(|list| list.local_branches.contains(&pr.head_ref))
    }
    /// Run a `gh`/`git` write in the background, then reload.
    fn write(
        &mut self,
        working: String,
        work: impl FnOnce(PathBuf) -> Result<(), String> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let path = PathBuf::from(&self.cwd);
        self.working = Some(working);
        self.status = None;
        let task = cx.background_executor().spawn(async move { work(path) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.working = None;
                this.status = result.err();
                this.load(cx);
            });
        })
        .detach();
        cx.notify();
    }
    /// Merge after asking; while checks run, turn on auto-merge instead.
    fn merge(&mut self, pr: PullRequest, window: &mut Window, cx: &mut Context<Self>) {
        let auto = pr.check_counts.pending > 0;
        let method = self.merge_method;
        let how = MERGE_METHODS
            .iter()
            .find(|(m, _)| *m == method)
            .map_or("Merge", |(_, label)| label);
        let base = if pr.base_ref.is_empty() {
            "its base".to_owned()
        } else {
            pr.base_ref.clone()
        };
        let (question, ok) = if auto {
            (
                format!("Merge #{} into {base} when its checks pass?", pr.number),
                "Enable auto-merge",
            )
        } else {
            (format!("Merge #{} into {base}?", pr.number), "Merge")
        };
        let answer = window.prompt(
            gpui::PromptLevel::Warning,
            &question,
            Some(how),
            &[
                gpui::PromptButton::ok(ok),
                gpui::PromptButton::cancel("Cancel"),
            ],
            cx,
        );
        let number = pr.number;
        cx.spawn(async move |this, cx| {
            if !matches!(answer.await, Ok(0)) {
                return;
            }
            let _ = this.update(cx, |this, cx| {
                this.write(
                    if auto {
                        "Enabling auto-merge…".into()
                    } else {
                        "Merging…".into()
                    },
                    move |path| scm::pr_merge(&path, number, method, auto),
                    cx,
                );
            });
        })
        .detach();
    }
    fn delete_branch(&mut self, pr: PullRequest, window: &mut Window, cx: &mut Context<Self>) {
        let branch = pr.head_ref;
        let answer = window.prompt(
            gpui::PromptLevel::Warning,
            &format!("Delete the local branch \"{branch}\"?"),
            Some("Its pull request is merged. The remote branch stays."),
            &[
                gpui::PromptButton::ok("Delete"),
                gpui::PromptButton::cancel("Cancel"),
            ],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if !matches!(answer.await, Ok(0)) {
                return;
            }
            let _ = this.update(cx, |this, cx| {
                this.write(
                    format!("Deleting {branch}…"),
                    move |path| scm::delete_local_branch(&path, &branch),
                    cx,
                );
            });
        })
        .detach();
    }
    fn run(&mut self, action: &str, pr: PullRequest, window: &mut Window, cx: &mut Context<Self>) {
        match action {
            "delete-branch" => self.delete_branch(pr, window, cx),
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
            .children(STATES.iter().enumerate().map(|(ix, &(id, label))| {
                let selected = self.tab == id;
                div()
                    .id(("pull-requests-tab", ix))
                    .debug_selector(move || format!("pull-requests-tab-{id}"))
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
        let number = pr.number;
        let actions =
            (self.tab_mode && self.hovered == Some(number)).then(|| self.row_actions(&pr, cx));
        div()
            .id(("pull-request", ix))
            .debug_selector(move || format!("pull-request-{number}"))
            .role(Role::Link)
            .aria_label(format!("Pull request #{} {}", pr.number, pr.title))
            .relative()
            .px_3()
            .py_1()
            .when(self.tab_mode, |d| d.mx_1().px_2().py(px(5.)))
            .flex()
            .gap_2()
            .cursor_pointer()
            .rounded_md()
            .hover(|s| s.bg(content(0.05)))
            .when(self.tab_mode, |d| {
                d.on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    if *hovered {
                        this.hovered = Some(number);
                    } else if this.hovered == Some(number) {
                        this.hovered = None;
                    }
                    cx.notify();
                }))
            })
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
            .children(actions)
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.tab_mode {
            return self.render_tab(window, cx);
        }
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
            .into_any_element()
    }
}

/// The ink on a primary button, matching [`PullRequests::button`].
fn primary_ink(enabled: bool) -> Hsla {
    primary_action(enabled).map_or(
        if enabled {
            background_base()
        } else {
            content(0.5)
        },
        |(_, ink)| ink,
    )
}

/// The tab's layout.
impl PullRequests {
    fn row_actions(&self, pr: &PullRequest, cx: &mut Context<Self>) -> AnyElement {
        let (url, copy) = (pr.url.clone(), pr.url.clone());
        let number = pr.number;
        let delete = self.can_delete_branch(pr).then(|| pr.clone());
        div()
            .absolute()
            .right(px(6.))
            .top(px(5.))
            .flex()
            .gap(px(2.))
            .p(px(2.))
            .rounded_md()
            .bg(floating_fill())
            .border_1()
            .border_color(stroke())
            .child(
                icon_action(
                    ("pull-request-copy", number),
                    "Copy link",
                    "response-copy",
                    true,
                )
                .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                })),
            )
            .child(
                icon_action(
                    ("pull-request-web", number),
                    "Open on GitHub",
                    "external-link",
                    true,
                )
                .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    cx.open_url(&url);
                })),
            )
            .when_some(delete, |d, pr| {
                d.child(
                    icon_action(
                        ("pull-request-delete-branch", number),
                        "Delete local branch",
                        "trash",
                        true,
                    )
                    .on_click(cx.listener(
                        move |this, _: &ClickEvent, window, cx| {
                            cx.stop_propagation();
                            this.delete_branch(pr.clone(), window, cx);
                        },
                    )),
                )
            })
            .into_any_element()
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let repo = self.repo();
        div()
            .px_3()
            .pt(px(10.))
            .pb_2()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h(px(28.))
                    .px_2()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded_md()
                    .bg(content(0.04))
                    .border_1()
                    .border_color(stroke())
                    .child(icon("search-01", 13.).text_color(content(0.35)))
                    .children(
                        self.query
                            .clone()
                            .map(|query| div().flex_1().min_w_0().child(query)),
                    ),
            )
            .child(if self.loading {
                div()
                    .size(px(20.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(spinner("pull-requests-loading", "loader", 14.))
                    .into_any_element()
            } else {
                icon_action(
                    "pull-requests-refresh",
                    "Refresh pull requests",
                    "refresh-cw",
                    true,
                )
                .on_click(cx.listener(|this, _, _, cx| this.load(cx)))
                .into_any_element()
            })
            .child(
                icon_action(
                    "pull-requests-web",
                    "Open pull requests on GitHub",
                    "external-link",
                    !repo.is_empty(),
                )
                .when(!repo.is_empty(), |d| {
                    d.on_click(cx.listener(move |_, _, _, cx| {
                        cx.open_url(&format!("https://github.com/{repo}/pulls"))
                    }))
                }),
            )
            .into_any_element()
    }

    fn segments(&self, cx: &mut Context<Self>) -> AnyElement {
        let open = self.open_count();
        div()
            .id("pull-requests-states")
            .px_3()
            .pb(px(6.))
            .flex()
            .items_center()
            .gap(px(2.))
            .role(Role::TabList)
            .aria_label("Pull request state")
            .children(STATES.iter().enumerate().map(|(ix, &(id, label))| {
                let selected = self.tab == id;
                div()
                    .id(("pull-requests-tab", ix))
                    .debug_selector(move || format!("pull-requests-tab-{id}"))
                    .role(Role::Tab)
                    .aria_selected(selected)
                    .h(px(24.))
                    .px_2()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .rounded_md()
                    .cursor_pointer()
                    .text_size(px(12.))
                    .text_color(if selected {
                        content(0.95)
                    } else {
                        content(0.5)
                    })
                    .when(selected, |d| d.bg(content(0.08)))
                    .hover(|s| s.text_color(content(0.9)))
                    .child(label)
                    .when_some(open.filter(|_| id == "open"), |d, count| {
                        d.child(
                            div()
                                .text_size(px(11.))
                                .text_color(content(0.4))
                                .font_features(crate::right_panel::tabular())
                                .child(count.to_string()),
                        )
                    })
                    .on_click(cx.listener(move |this, _, _, cx| this.select(id, cx)))
            }))
            .child(div().flex_1())
            .child(
                div()
                    .id("pull-requests-mine")
                    .debug_selector(|| "pull-requests-mine".into())
                    .role(Role::Switch)
                    .aria_label("Only my pull requests")
                    .aria_selected(self.mine)
                    .h(px(22.))
                    .px_2()
                    .flex()
                    .items_center()
                    .gap_1()
                    .rounded_full()
                    .border_1()
                    .cursor_pointer()
                    .text_size(px(11.))
                    .map(|d| {
                        if self.mine {
                            d.border_color(content(0.22))
                                .bg(content(0.06))
                                .text_color(content(0.9))
                        } else {
                            d.border_color(stroke()).text_color(content(0.5))
                        }
                    })
                    .hover(|s| s.text_color(content(0.9)))
                    .child(icon("account-user", 12.).text_color(content(if self.mine {
                        0.9
                    } else {
                        0.5
                    })))
                    .child("Mine")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.mine = !this.mine;
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    fn group_label(label: impl Into<gpui::SharedString>, count: Option<usize>) -> AnyElement {
        div()
            .px(px(14.))
            .pt_3()
            .pb_1()
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(11.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(content(0.45))
            .child(label.into())
            .when_some(count, |d, count| {
                d.child(
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(content(0.3))
                        .child(count.to_string()),
                )
            })
            .into_any_element()
    }

    fn button(
        id: &'static str,
        label: impl Into<gpui::SharedString>,
        primary: bool,
        enabled: bool,
    ) -> gpui::Stateful<gpui::Div> {
        let (fill, ink) = if primary {
            primary_action(enabled).unwrap_or((
                content(if enabled { 0.88 } else { 0.25 }),
                if enabled {
                    background_base()
                } else {
                    content(0.5)
                },
            ))
        } else {
            (
                gpui::transparent_black(),
                content(if enabled { 0.75 } else { 0.35 }),
            )
        };
        let label = label.into();
        div()
            .id(id)
            .debug_selector(move || id.into())
            .role(Role::Button)
            .aria_label(label.clone())
            .h(px(28.))
            .px(px(10.))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .rounded_md()
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .bg(fill)
            .text_color(ink)
            .when(!primary, |d| d.border_1().border_color(stroke()))
            .when(enabled, |d| d.cursor_pointer().hover(|s| s.opacity(0.9)))
    }

    /// The checks as one bar, green, red and amber in proportion.
    fn checks(pr: &PullRequest) -> Option<AnyElement> {
        let counts = pr.check_counts;
        let total = counts.total();
        if total == 0 {
            return None;
        }
        let part = |n: u32, color: Hsla| {
            (n > 0).then(|| {
                div()
                    .h_full()
                    .w(relative(n as f32 / total as f32))
                    .bg(color)
            })
        };
        let mut words: Vec<(String, Hsla)> = Vec::new();
        if counts.passed > 0 {
            words.push((format!("{} passed", counts.passed), rgb(GREEN).into()));
        }
        if counts.failed > 0 {
            words.push((format!("{} failed", counts.failed), rgb(RED).into()));
        }
        if counts.pending > 0 {
            words.push((format!("{} running", counts.pending), rgb(AMBER).into()));
        }
        if counts.other > 0 {
            words.push((format!("{} skipped", counts.other), content(0.45)));
        }
        let mut summary = div().flex().items_center().gap_1();
        for (ix, (word, color)) in words.into_iter().enumerate() {
            if ix > 0 {
                summary = summary.child(div().text_color(content(0.3)).child("·"));
            }
            summary = summary.child(div().text_color(color).child(word));
        }
        Some(
            div()
                .id("pull-request-checks")
                .debug_selector(|| "pull-request-checks".into())
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(
                    div()
                        .h(px(4.))
                        .w_full()
                        .flex()
                        .gap(px(1.))
                        .rounded_full()
                        .overflow_hidden()
                        .bg(content(0.08))
                        .children(part(counts.passed, rgb(GREEN).into()))
                        .children(part(counts.failed, rgb(RED).into()))
                        .children(part(counts.pending, rgb(AMBER).into()))
                        .children(part(counts.other, content(0.2))),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .text_size(px(11.))
                        .text_color(content(0.55))
                        .child("Checks")
                        .child(div().flex_1())
                        .child(summary),
                )
                .into_any_element(),
        )
    }

    /// The one next step for the branch's pull request.
    fn next_step(&self, pr: &PullRequest) -> (&'static str, String, bool) {
        let counts = pr.check_counts;
        if let Some(working) = &self.working {
            ("working", working.clone(), false)
        } else if self.local.busy {
            ("working", "Pushing…".into(), false)
        } else if self.local.ahead > 0 {
            let n = self.local.ahead;
            (
                "push",
                format!("Push {n} commit{}", if n == 1 { "" } else { "s" }),
                true,
            )
        } else if pr.draft {
            ("ready", "Ready for review".into(), true)
        } else if counts.failed > 0 {
            ("checks", "View failing checks".into(), true)
        } else if counts.pending > 0 {
            ("merge", "Merge when ready".into(), true)
        } else {
            ("merge", "Merge".into(), true)
        }
    }

    fn pull_request_card(&self, pr: PullRequest, cx: &mut Context<Self>) -> AnyElement {
        let (glyph, color): (&str, Hsla) = if pr.draft {
            ("git-pull-request-draft", content(0.45))
        } else {
            ("git-pull-request", rgb(GREEN).into())
        };
        let (step, label, enabled) = self.next_step(&pr);
        let item = self.inbox_item(&pr);
        let url = pr.url.clone();
        let mergeable = step == "merge";
        let mono = crate::fonts::mono();
        let primary = Self::button("pull-request-next-step", label.clone(), true, enabled)
            .flex_1()
            .min_w_0()
            .when(mergeable, |d| d.rounded_r_none())
            .child(if step == "working" {
                spinner("pull-request-working", "loader", 14.)
            } else {
                icon(
                    match step {
                        "push" => "mono-arrow-up",
                        "ready" => "eye",
                        "checks" => "alert-circle",
                        _ => "git-merge",
                    },
                    14.,
                )
                .text_color(primary_ink(enabled))
                .into_any_element()
            })
            .child(div().min_w_0().truncate().child(label))
            .when(enabled, |d| {
                let pr = pr.clone();
                d.on_click(
                    cx.listener(move |this, _: &ClickEvent, window, cx| match step {
                        "push" => cx.emit(BranchAction::Push),
                        "ready" => {
                            let number = pr.number;
                            this.write(
                                "Marking ready…".into(),
                                move |path| scm::pr_mark_ready(&path, number),
                                cx,
                            );
                        }
                        "checks" => cx.open_url(&format!("{}/checks", pr.url)),
                        _ => this.merge(pr.clone(), window, cx),
                    }),
                )
            });
        div()
            .id("pull-request-branch-card")
            .debug_selector(|| "pull-request-branch-card".into())
            .mx(px(10.))
            .mt(px(2.))
            .mb_1()
            .p(px(10.))
            .flex()
            .flex_col()
            .gap_2()
            .rounded_lg()
            .border_1()
            .border_color(stroke())
            .bg(content(0.03))
            .child(
                div()
                    .id("pull-request-branch-title")
                    .flex()
                    .gap_2()
                    .cursor_pointer()
                    .child(div().pt(px(1.)).child(icon(glyph, 15.).text_color(color)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(content(0.92))
                                    .hover(|s| s.underline())
                                    .child(pr.title.clone()),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(11.))
                                    .text_color(content(0.45))
                                    .child(format!(
                                        "#{} · {}{}",
                                        pr.number,
                                        pr.head_ref,
                                        if pr.base_ref.is_empty() {
                                            String::new()
                                        } else {
                                            format!(" → {}", pr.base_ref)
                                        }
                                    ))
                                    .font_family(mono),
                            ),
                    )
                    .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                        cx.emit(OpenPullRequest(item.clone()))
                    })),
            )
            .children(Self::checks(&pr))
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .child(primary)
                            .when(mergeable, |d| {
                                let pr = pr.clone();
                                d.child(
                                    Self::button(
                                        "pull-request-merge-method",
                                        "Merge method",
                                        true,
                                        enabled,
                                    )
                                    .w(px(26.))
                                    .px_0()
                                    .ml(px(1.))
                                    .rounded_l_none()
                                    .child(
                                        icon("chevron-down", 13.).text_color(primary_ink(enabled)),
                                    )
                                    .when(enabled, |d| {
                                        d.on_click(cx.listener(
                                            move |this, event: &ClickEvent, window, cx| {
                                                this.open_merge_menu(
                                                    pr.clone(),
                                                    event.position(),
                                                    window,
                                                    cx,
                                                )
                                            },
                                        ))
                                    }),
                                )
                            }),
                    )
                    .child(
                        Self::button("pull-request-open-web", "Open on GitHub", false, true)
                            .w(px(30.))
                            .px_0()
                            .child(icon("external-link", 14.).text_color(content(0.7)))
                            .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url))),
                    ),
            )
            .into_any_element()
    }

    fn create_card(&self, branch: &str, cx: &mut Context<Self>) -> AnyElement {
        let commits = match &self.commits {
            Some(Ok(commits)) => commits.commits.clone(),
            _ => Vec::new(),
        };
        let base = self
            .local
            .default_branch
            .clone()
            .or_else(|| match &self.commits {
                Some(Ok(commits)) => Some(commits.base.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "the default branch".into());
        let enabled = self.local.blocker.is_none() && !self.local.busy;
        let mono = crate::fonts::mono();
        let sub = self
            .local
            .blocker
            .clone()
            .unwrap_or_else(|| match commits.len() {
                0 => format!("Nothing ahead of {base} yet"),
                n => format!(
                    "{n}{} commit{} ahead of {base}",
                    if n >= 4 { "+" } else { "" },
                    if n == 1 { "" } else { "s" }
                ),
            });
        div()
            .id("pull-request-create-card")
            .debug_selector(|| "pull-request-create-card".into())
            .mx(px(10.))
            .mt(px(2.))
            .mb_1()
            .p(px(12.))
            .flex()
            .flex_col()
            .gap_2()
            .rounded_lg()
            .border_1()
            .border_dashed()
            .border_color(content(0.14))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .text_size(px(12.5))
                    .text_color(content(0.9))
                    .child(
                        div()
                            .font_family(mono)
                            .text_size(px(12.))
                            .child(branch.to_owned()),
                    )
                    .child("has no pull request"),
            )
            .when(!commits.is_empty(), |d| {
                d.child(div().flex().flex_col().gap(px(3.)).children(
                    commits.into_iter().take(3).map(|(sha, subject)| {
                        div()
                            .flex()
                            .gap(px(6.))
                            .text_size(px(11.))
                            .text_color(content(0.6))
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .font_family(mono)
                                    .text_color(content(0.3))
                                    .child(sha),
                            )
                            .child(div().min_w_0().truncate().child(subject))
                    }),
                ))
            })
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(if self.local.blocker.is_some() {
                        rgb(AMBER).into()
                    } else {
                        content(0.45)
                    })
                    .child(sub),
            )
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(
                        Self::button(
                            "pull-request-create",
                            format!("Create a pull request into {base}"),
                            true,
                            enabled,
                        )
                        .flex_1()
                        .min_w_0()
                        .child(if self.local.busy {
                            spinner("pull-request-create-spin", "loader", 14.)
                        } else {
                            icon("git-pull-request", 14.)
                                .text_color(primary_ink(enabled))
                                .into_any_element()
                        })
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .child(format!("Create PR to {base}")),
                        )
                        .when(enabled, |d| {
                            d.on_click(cx.listener(|_, _, _, cx| {
                                cx.emit(BranchAction::Create { draft: false })
                            }))
                        }),
                    )
                    .child(
                        Self::button(
                            "pull-request-create-draft",
                            "Create a draft pull request",
                            false,
                            enabled,
                        )
                        .child(
                            icon("git-pull-request-draft", 14.).text_color(content(if enabled {
                                0.7
                            } else {
                                0.35
                            })),
                        )
                        .child("Draft")
                        .when(enabled, |d| {
                            d.on_click(cx.listener(|_, _, _, cx| {
                                cx.emit(BranchAction::Create { draft: true })
                            }))
                        }),
                    ),
            )
            .into_any_element()
    }

    fn repo(&self) -> String {
        self.lists
            .get(self.tab)
            .or_else(|| self.lists.get("open"))
            .and_then(|list| list.as_ref().ok())
            .map(|list| list.repo.clone())
            .unwrap_or_default()
    }

    fn footer(&self) -> Option<AnyElement> {
        let repo = self.repo();
        if repo.is_empty() {
            return None;
        }
        let updated = self.loaded_at.map(|at| {
            let seconds = monocode_core::time::now_ms().saturating_sub(at) / 1000;
            match seconds {
                0..60 => "updated just now".to_owned(),
                60..3600 => format!("updated {}m ago", seconds / 60),
                _ => format!("updated {}h ago", seconds / 3600),
            }
        });
        Some(
            div()
                .h(px(30.))
                .flex_shrink_0()
                .px_3()
                .flex()
                .items_center()
                .gap(px(6.))
                .border_t_1()
                .border_color(stroke())
                .text_size(px(11.))
                .text_color(content(0.45))
                .child(icon("inbox-github", 12.).text_color(content(0.45)))
                .child(div().min_w_0().truncate().child(repo))
                .child(div().flex_1())
                .children(updated.map(|text| div().flex_shrink_0().child(text)))
                .into_any_element(),
        )
    }

    fn render_tab(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let viewer = self.viewer();
        let query = self
            .query
            .as_ref()
            .map(|q| q.read(cx).content.to_string())
            .unwrap_or_default();
        let rows = self.filtered_by(&query);
        let current = self.current();
        let mut body: Vec<AnyElement> = Vec::new();
        // The branch card: its pull request, or what one would take.
        if let Some(branch) = self.branch.clone().filter(|_| !self.local.on_default) {
            body.push(
                div()
                    .px(px(14.))
                    .pt(px(10.))
                    .pb_1()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(11.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(content(0.45))
                    .child(icon("git-branch", 12.).text_color(content(0.45)))
                    .child("This branch")
                    .into_any_element(),
            );
            match (&current, self.lists.get("open")) {
                (Some(pr), _) => body.push(self.pull_request_card(pr.clone(), cx)),
                (None, Some(Ok(_))) => body.push(self.create_card(&branch, cx)),
                (None, Some(Err(_))) => {}
                (None, None) => body.push(
                    div()
                        .px(px(14.))
                        .py_1()
                        .text_size(px(12.))
                        .text_color(content(0.45))
                        .child("Loading…")
                        .into_any_element(),
                ),
            }
        }
        if let Some(status) = self.status.clone() {
            body.push(
                div()
                    .px(px(14.))
                    .pt_1()
                    .text_size(px(11.))
                    .text_color(rgb(RED))
                    .child(status)
                    .into_any_element(),
            );
        }
        let empty = match self.lists.get(self.tab) {
            None if self.loading => Some("Loading pull requests…".to_owned()),
            None => None,
            Some(Err(error)) => Some(error.clone()),
            Some(Ok(_)) if rows.is_empty() && !query.trim().is_empty() => {
                Some("No pull requests match".to_owned())
            }
            Some(Ok(_)) if rows.is_empty() => Some(match self.tab {
                "open" if current.is_some() => "No other open pull requests".to_owned(),
                state => format!("No {state} pull requests"),
            }),
            Some(Ok(_)) => None,
        };
        let mut ix = 0;
        let mut group = |label: String,
                         items: Vec<PullRequest>,
                         body: &mut Vec<AnyElement>,
                         this: &Self,
                         cx: &mut Context<Self>| {
            if items.is_empty() {
                return;
            }
            body.push(Self::group_label(label, Some(items.len())));
            for pr in items {
                body.push(this.row(ix, pr, &viewer, cx));
                ix += 1;
            }
        };
        match empty {
            Some(text) => body.push(
                div()
                    .px(px(14.))
                    .pt_3()
                    .text_size(px(12.))
                    .text_color(content(0.45))
                    .child(text)
                    .into_any_element(),
            ),
            None if self.tab == "open" && !viewer.is_empty() => {
                let (yours, others): (Vec<_>, Vec<_>) = rows
                    .into_iter()
                    .partition(|pr| pr.author.eq_ignore_ascii_case(&viewer));
                group("Yours".into(), yours, &mut body, self, cx);
                group("Others".into(), others, &mut body, self, cx);
            }
            None if self.tab == "open" => group("Open".into(), rows, &mut body, self, cx),
            None => {
                let now = monocode_core::time::now_ms() as i64;
                let (recent, earlier): (Vec<_>, Vec<_>) = rows.into_iter().partition(|pr| {
                    now - monocode_core::inbox::timestamp_ms(pr.changed_at()) < WEEK_MS
                });
                group("This week".into(), recent, &mut body, self, cx);
                group("Earlier".into(), earlier, &mut body, self, cx);
            }
        }
        let menu = self
            .menu
            .as_ref()
            .map(|open| menu_popover(&open.menu, Anchor::Point(open.at), cx).align(Align::Start));
        div()
            .id("pull-requests")
            .debug_selector(|| "pull-requests".into())
            .role(Role::Region)
            .aria_label("Pull requests")
            .size_full()
            .min_h_0()
            .flex()
            .flex_col()
            .child(self.toolbar(cx))
            .child(self.segments(cx))
            .child(
                div()
                    .id("pull-requests-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .pb_2()
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                        if !*hovered && this.hovered.take().is_some() {
                            cx.notify();
                        }
                    }))
                    .children(body),
            )
            .children(self.footer())
            .children(menu)
            .into_any_element()
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

    fn authored(number: u64, head: &str, author: &str, title: &str) -> PullRequest {
        PullRequest {
            author: author.into(),
            title: title.into(),
            ..pr(number, head)
        }
    }

    #[test]
    fn the_tab_list_leaves_out_the_branch_card_and_filters() {
        let mut view = PullRequests::new();
        view.tab_mode = true;
        view.branch = Some("feat/card".into());
        view.lists.insert(
            "open",
            Ok(PullRequestList {
                viewer: "ege".into(),
                items: vec![
                    authored(9, "feat/card", "ege", "The card"),
                    authored(8, "feat/mine", "Ege", "Mine too"),
                    authored(7, "bump/tokio", "dependabot", "Bump tokio"),
                ],
                ..Default::default()
            }),
        );
        let numbers = |view: &PullRequests, query: &str| {
            view.filtered_by(query)
                .iter()
                .map(|p| p.number)
                .collect::<Vec<_>>()
        };
        assert_eq!(view.current().map(|p| p.number), Some(9));
        assert_eq!(numbers(&view, ""), vec![8, 7]);
        assert_eq!(numbers(&view, "tokio"), vec![7]);
        assert_eq!(numbers(&view, "#8"), vec![8]);
        assert_eq!(numbers(&view, "DEPENDABOT"), vec![7]);
        view.mine = true;
        assert_eq!(numbers(&view, ""), vec![8]);
    }

    #[test]
    fn the_card_offers_the_one_next_step() {
        let mut view = PullRequests::new();
        let mut card = pr(5, "feat/x");
        let step = |view: &PullRequests, card: &PullRequest| view.next_step(card).0;
        assert_eq!(step(&view, &card), "merge");
        card.check_counts.pending = 1;
        assert_eq!(view.next_step(&card).1, "Merge when ready");
        card.check_counts.failed = 1;
        assert_eq!(step(&view, &card), "checks");
        card.draft = true;
        assert_eq!(step(&view, &card), "ready");
        view.local.ahead = 2;
        assert_eq!(view.next_step(&card).1, "Push 2 commits");
        view.working = Some("Merging…".into());
        assert_eq!(view.next_step(&card), ("working", "Merging…".into(), false));
    }

    #[test]
    fn merged_rows_offer_to_delete_only_a_local_branch_not_checked_out() {
        let mut view = PullRequests::new();
        view.tab = "merged";
        view.branch = Some("dev".into());
        view.lists.insert(
            "merged",
            Ok(PullRequestList {
                local_branches: vec!["feat/old".into(), "dev".into()],
                ..Default::default()
            }),
        );
        let merged = |head: &str| PullRequest {
            state: "merged".into(),
            ..pr(1, head)
        };
        assert!(view.can_delete_branch(&merged("feat/old")));
        assert!(!view.can_delete_branch(&merged("feat/gone")));
        assert!(!view.can_delete_branch(&merged("dev")));
        assert!(!view.can_delete_branch(&pr(1, "feat/old")));
    }

    #[gpui::test]
    fn the_tab_shows_the_branch_card(cx: &mut gpui::TestAppContext) {
        let window = cx.update(|cx| {
            cx.open_window(Default::default(), |_, cx| cx.new(PullRequests::tab))
                .unwrap()
        });
        let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
        window
            .update(visual, |prs, _, cx| {
                prs.branch = Some("feat/card".into());
                prs.lists.insert(
                    "open",
                    Ok(PullRequestList {
                        items: vec![PullRequest {
                            check_counts: scm::CheckCounts {
                                passed: 3,
                                pending: 1,
                                ..Default::default()
                            },
                            ..pr(9, "feat/card")
                        }],
                        ..Default::default()
                    }),
                );
                cx.notify();
            })
            .unwrap();
        visual.run_until_parked();
        assert!(visual.debug_bounds("pull-request-branch-card").is_some());
        assert!(visual.debug_bounds("pull-request-checks").is_some());
        assert!(visual.debug_bounds("pull-request-merge-method").is_some());
        assert!(visual.debug_bounds("pull-request-create-card").is_none());
        window
            .update(visual, |prs, _, cx| {
                prs.branch = Some("feat/new".into());
                cx.notify();
            })
            .unwrap();
        visual.run_until_parked();
        assert!(visual.debug_bounds("pull-request-branch-card").is_none());
        assert!(visual.debug_bounds("pull-request-create-card").is_some());
        assert!(visual.debug_bounds("pull-request-9").is_some());
    }

    #[gpui::test]
    fn each_tab_selects_its_own_state(cx: &mut gpui::TestAppContext) {
        let window = cx.update(|cx| {
            cx.open_window(Default::default(), |_, cx| cx.new(|_| PullRequests::new()))
                .unwrap()
        });
        let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
        visual.run_until_parked();
        for (state, selector) in [
            ("closed", "pull-requests-tab-closed"),
            ("merged", "pull-requests-tab-merged"),
            ("open", "pull-requests-tab-open"),
            ("closed", "pull-requests-tab-closed"),
        ] {
            let tab = visual.debug_bounds(selector).unwrap();
            visual.simulate_click(tab.center(), Default::default());
            visual.run_until_parked();
            window
                .read_with(visual, |prs, _| assert_eq!(prs.tab, state))
                .unwrap();
        }
    }
}
