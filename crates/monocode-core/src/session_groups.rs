//! The sidebar's session grouping: sessionFolders.ts, sessionReminders.ts and
//! sessionWorkItem.ts's URL parsing, without their storage.
use chrono::{Datelike, Duration, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

/// sessionFolders.ts's `SessionFolder`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub session_ids: Vec<i64>,
    #[serde(default)]
    pub collapsed: bool,
    /// Index into the tab group palette; missing or 0 is the default wash.
    #[serde(default)]
    pub color_index: Option<usize>,
    /// Desktop folder pickers allow a custom hex color in addition to a palette.
    #[serde(default)]
    pub custom_color: Option<String>,
}

/// A project's folders, and whether its Pinned and Reminders groups are folded.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Groups {
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub pinned_collapsed: bool,
    #[serde(default)]
    pub reminders_collapsed: bool,
}

impl Groups {
    pub fn folder_of(&self, session: i64) -> Option<&Folder> {
        self.folders
            .iter()
            .find(|f| f.session_ids.contains(&session))
    }
    pub fn folder(&self, id: &str) -> Option<&Folder> {
        self.folders.iter().find(|f| f.id == id)
    }
    fn folder_mut(&mut self, id: &str) -> Option<&mut Folder> {
        self.folders.iter_mut().find(|f| f.id == id)
    }
    fn unique_name(&self, base: &str) -> String {
        let taken = |name: &str| self.folders.iter().any(|f| f.name == name);
        if !taken(base) {
            return base.into();
        }
        (2..)
            .map(|n| format!("{base} {n}"))
            .find(|name| !taken(name))
            .unwrap()
    }
    fn remove_empty(&mut self) {
        self.folders.retain(|f| !f.session_ids.is_empty());
    }
    /// A new folder, first in the list, takes the sessions from their old ones.
    pub fn create_folder(&mut self, sessions: &[i64], id: String) -> Option<String> {
        let mut ids = Vec::new();
        for &session in sessions {
            if !ids.contains(&session) {
                ids.push(session);
            }
        }
        if ids.is_empty() {
            return None;
        }
        self.remove_sessions(&ids);
        let name = self.unique_name("New folder");
        self.folders.insert(
            0,
            Folder {
                id: id.clone(),
                name,
                session_ids: ids,
                collapsed: false,
                color_index: None,
                custom_color: None,
            },
        );
        Some(id)
    }
    /// Moves the session into the folder and opens it.
    pub fn add_to_folder(&mut self, folder: &str, session: i64) {
        if self.folder(folder).is_none() {
            return;
        }
        if self.folder_of(session).is_none_or(|f| f.id != folder) {
            for f in &mut self.folders {
                f.session_ids.retain(|&id| id != session);
            }
            if let Some(f) = self.folder_mut(folder) {
                f.session_ids.push(session);
            }
            self.remove_empty();
        }
        if let Some(f) = self.folder_mut(folder) {
            f.collapsed = false;
        }
    }
    /// Takes the sessions out of their folders; emptied folders go too.
    pub fn remove_sessions(&mut self, sessions: &[i64]) {
        for f in &mut self.folders {
            f.session_ids.retain(|id| !sessions.contains(id));
        }
        self.remove_empty();
    }
    pub fn rename_folder(&mut self, folder: &str, name: &str) {
        let name = name.trim();
        if !name.is_empty() {
            if let Some(f) = self.folder_mut(folder) {
                f.name = name.into();
            }
        }
    }
    /// Ungroup: the folder goes and its sessions return to the list.
    pub fn dissolve(&mut self, folder: &str) {
        self.folders.retain(|f| f.id != folder);
    }
    pub fn toggle_folder(&mut self, folder: &str) {
        if let Some(f) = self.folder_mut(folder) {
            f.collapsed = !f.collapsed;
        }
    }
    pub fn set_color(&mut self, folder: &str, color_index: Option<usize>) {
        if let Some(f) = self.folder_mut(folder) {
            f.color_index = color_index.filter(|&ix| ix > 0);
            f.custom_color = None;
        }
    }
}

/// The sidebar's entries, top to bottom: pinned, reminders, folders, then
/// loose sessions. `visible` is already in the list's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Reminders {
        collapsed: bool,
        sessions: Vec<i64>,
    },
    Folder {
        id: String,
        sessions: Vec<i64>,
    },
    /// Loose pinned sessions, shown as ordinary cards under a Pinned label.
    Pinned {
        sessions: Vec<i64>,
    },
    Session(i64),
}

/// buildSessionList: pins lead, followed by reminders, folders and loose
/// sessions. Reminder membership only changes this view.
pub fn build_list(
    visible: &[i64],
    pinned: impl Fn(i64) -> bool,
    groups: &Groups,
    reminders: &[(i64, u64)],
) -> Vec<Entry> {
    let mut entries = Vec::new();
    let visible_members: HashSet<_> = visible.iter().copied().collect();
    let mut due: Vec<_> = reminders
        .iter()
        .filter(|(id, _)| visible_members.contains(id))
        .copied()
        .collect();
    due.sort_by_key(|&(id, at)| (at, id));
    let reminded: Vec<i64> = due.into_iter().map(|(id, _)| id).collect();
    let reminded_members: HashSet<_> = reminded.iter().copied().collect();
    if !reminded.is_empty() {
        entries.push(Entry::Reminders {
            collapsed: groups.reminders_collapsed,
            sessions: reminded.clone(),
        });
    }
    let mut foldered = HashSet::new();
    for folder in &groups.folders {
        foldered.extend(folder.session_ids.iter().copied());
        let members: HashSet<_> = folder.session_ids.iter().copied().collect();
        let members: Vec<i64> = visible
            .iter()
            .copied()
            .filter(|id| members.contains(id) && !reminded_members.contains(id))
            .collect();
        if !members.is_empty() {
            entries.push(Entry::Folder {
                id: folder.id.clone(),
                sessions: members,
            });
        }
    }
    let loose: Vec<i64> = visible
        .iter()
        .copied()
        .filter(|id| !foldered.contains(id) && !reminded_members.contains(id))
        .collect();
    let (pins, loose): (Vec<_>, Vec<_>) = loose.into_iter().partition(|&id| pinned(id));
    if !pins.is_empty() {
        entries.push(Entry::Pinned { sessions: pins });
    }
    entries.extend(loose.into_iter().map(Entry::Session));
    entries
}

/// sessionListNavigationIds: the sessions as shown, folded groups skipped
/// unless a search has opened them.
pub fn navigation_ids(entries: &[Entry], expand_collapsed: bool) -> Vec<i64> {
    let mut ids = Vec::new();
    for entry in entries {
        match entry {
            Entry::Session(id) => ids.push(*id),
            Entry::Reminders {
                collapsed,
                sessions,
            } => {
                if !collapsed || expand_collapsed {
                    ids.extend(sessions);
                }
            }
            Entry::Folder { sessions, .. } | Entry::Pinned { sessions } => ids.extend(sessions),
        }
    }
    ids
}

pub const REMINDER_PRESETS: [&str; 5] = [
    "reminder:1h",
    "reminder:3h",
    "reminder:evening",
    "reminder:tomorrow",
    "reminder:next-week",
];

/// reminderTime in local wall-clock time; None for a time already past.
pub fn reminder_at(preset: &str, now: NaiveDateTime) -> Option<NaiveDateTime> {
    let nine = NaiveTime::from_hms_opt(9, 0, 0)?;
    let at = match preset {
        "reminder:1h" => return Some(now + Duration::hours(1)),
        "reminder:3h" => return Some(now + Duration::hours(3)),
        "reminder:evening" => now.date().and_time(NaiveTime::from_hms_opt(18, 0, 0)?),
        "reminder:tomorrow" => (now.date() + Duration::days(1)).and_time(nine),
        "reminder:next-week" => {
            // The next Monday, a week out when today is Monday.
            let weekday = now.weekday().num_days_from_sunday() as i64;
            let ahead = match (8 - weekday) % 7 {
                0 => 7,
                days => days,
            };
            (now.date() + Duration::days(ahead)).and_time(nine)
        }
        _ => return None,
    };
    (at > now).then_some(at)
}

/// sessionReminderPresets: id, label and whether it can still be chosen.
pub fn reminder_presets(now: NaiveDateTime) -> Vec<(&'static str, String, bool)> {
    let clock = |hours| {
        reminder_at(hours, now)
            .map(|at| at.format("%-H:%M").to_string())
            .unwrap_or_default()
    };
    vec![
        (
            REMINDER_PRESETS[0],
            format!("In 1 hour ({})", clock(REMINDER_PRESETS[0])),
            true,
        ),
        (
            REMINDER_PRESETS[1],
            format!("In 3 hours ({})", clock(REMINDER_PRESETS[1])),
            true,
        ),
        (
            REMINDER_PRESETS[2],
            "This evening (18:00)".into(),
            reminder_at(REMINDER_PRESETS[2], now).is_some(),
        ),
        (REMINDER_PRESETS[3], "Tomorrow (9:00)".into(), true),
        (REMINDER_PRESETS[4], "Next week (Mon 9:00)".into(), true),
    ]
}

/// formatReminderTime: "Mon, Oct 19, 15:00".
pub fn format_reminder(at: NaiveDateTime) -> String {
    at.format("%a, %b %-d, %-H:%M").to_string()
}

/// session.ts's `LinkedWorkItem`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkItem {
    /// "issue" or "pr".
    pub kind: String,
    pub repo: String,
    pub number: u64,
    pub url: String,
    /// sessionStore.ts's StoredLinkedWorkItem: every other link, newest first,
    /// kept inside the card's item so older builds and the mobile app still
    /// read that one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub more: Vec<WorkItem>,
}
impl WorkItem {
    /// sameLinkedWorkItem: one GitHub identity, however its URL was written.
    pub fn same(&self, other: &WorkItem) -> bool {
        self.kind == other.kind
            && self.number == other.number
            && self.repo.trim().eq_ignore_ascii_case(other.repo.trim())
    }
    /// linkedWorkItemsOf: the card's item, then the rest, each once.
    pub fn links(&self) -> Vec<WorkItem> {
        let mut links: Vec<WorkItem> = Vec::new();
        for item in std::iter::once(self).chain(&self.more) {
            if !links.iter().any(|seen| seen.same(item)) {
                links.push(WorkItem {
                    more: Vec::new(),
                    ..item.clone()
                });
            }
        }
        links
    }
    /// withLinkedWorkItems: the first item is the card's, carrying the rest.
    pub fn from_links(items: impl IntoIterator<Item = WorkItem>) -> Option<WorkItem> {
        let mut links: Vec<WorkItem> = Vec::new();
        for item in items.into_iter().flat_map(|item| item.links()) {
            if !links.iter().any(|seen| seen.same(&item)) {
                links.push(item);
            }
        }
        let mut links = links.into_iter();
        let mut first = links.next()?;
        first.more = links.collect();
        Some(first)
    }
}

/// createdPullRequests: PRs the agent opened with `gh pr create`, newest
/// first, read from the command's output. A failed create still counts: gh
/// exits non-zero when the branch already has a PR, and prints its URL.
pub fn created_pull_requests(rows: &[crate::transcript::Row]) -> Vec<WorkItem> {
    static CREATE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\bgh\s+pr\s+create\b").unwrap());
    static URL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)https?://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+\b")
            .unwrap()
    });
    let mut created: Vec<WorkItem> = Vec::new();
    for row in rows.iter().rev().filter(|row| row.role == "tool") {
        let Ok(tool) = serde_json::from_str::<crate::tool::ToolCall>(&row.text) else {
            continue;
        };
        if !tool
            .presentation()
            .command
            .is_some_and(|command| CREATE.is_match(&command))
        {
            continue;
        }
        // gh prints the new PR's URL last; earlier URLs can be warnings or links.
        let item = URL
            .find_iter(&tool.output)
            .last()
            .and_then(|url| parse_github_work_item(url.as_str()));
        if let Some(item) = item.filter(|item| !created.iter().any(|seen| seen.same(item))) {
            created.push(item);
        }
    }
    created
}

/// withCreatedPullRequests: the session's links with the PRs its agent
/// opened added first, or `None` when nothing new was opened. A linked
/// session only reads its latest turn, so a link removed by hand stays
/// removed.
pub fn with_created_pull_requests(
    linked: Option<&WorkItem>,
    rows: &[crate::transcript::Row],
) -> Option<WorkItem> {
    let rows = match linked {
        Some(_) => rows
            .iter()
            .rposition(|row| row.is_prompt() && row.first)
            .map_or(rows, |start| &rows[start + 1..]),
        None => rows,
    };
    let current = linked.map(WorkItem::links).unwrap_or_default();
    let created: Vec<_> = created_pull_requests(rows)
        .into_iter()
        .filter(|item| !current.iter().any(|seen| seen.same(item)))
        .collect();
    if created.is_empty() {
        return None;
    }
    WorkItem::from_links(created.into_iter().chain(current))
}

/// parseGithubWorkItemUrl: the first github.com issue or pull request URL.
pub fn parse_github_work_item(text: &str) -> Option<WorkItem> {
    let name = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    let lower = text.to_ascii_lowercase();
    for (start, _) in lower.match_indices("github.com/") {
        let scheme = &lower[..start];
        if !(scheme.ends_with("https://") || scheme.ends_with("http://")) {
            continue;
        }
        let mut parts = text[start + "github.com/".len()..].splitn(4, '/');
        let (Some(owner), Some(repo), Some(kind), Some(rest)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let kind = match kind.to_ascii_lowercase().as_str() {
            "pull" => "pr",
            "issues" => "issue",
            _ => continue,
        };
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        // `\b` after the number: it must not run on into a word.
        let after = rest[digits.len()..].chars().next();
        if !name(owner) || !name(repo) || after.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let Some(number) = digits.parse::<u64>().ok().filter(|&n| n > 0) else {
            continue;
        };
        let repo = format!("{owner}/{repo}");
        let url = format!(
            "https://github.com/{repo}/{}/{number}",
            if kind == "pr" { "pull" } else { "issues" }
        );
        return Some(WorkItem {
            kind: kind.into(),
            repo,
            number,
            url,
            more: Vec::new(),
        });
    }
    None
}

fn github_url(repo: &str, kind: &str, number: u64) -> String {
    let path = if kind == "pr" { "pull" } else { "issues" };
    format!("https://github.com/{repo}/{path}/{number}")
}

fn valid_repo(repo: &str) -> bool {
    repo.split_once('/').is_some_and(|(owner, name)| {
        [owner, name].iter().all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        })
    })
}

/// sessionWorkItem.ts's explicitHint: "PR #12", "pull request 12", "issue 7".
fn explicit_work_item_hint(message: &str) -> Option<(&'static str, u64)> {
    static PATTERNS: std::sync::LazyLock<[(&str, regex::Regex); 2]> =
        std::sync::LazyLock::new(|| {
            [
                ("pr", r"(?i)\b(?:pr|pull\s+request)\s*#?\s*(\d+)\b"),
                ("issue", r"(?i)\bissue\s*#?\s*(\d+)\b"),
            ]
            .map(|(kind, re)| (kind, regex::Regex::new(re).unwrap()))
        });
    PATTERNS.iter().find_map(|(kind, re)| {
        let number = re.captures(message)?[1].parse::<u64>().ok()?;
        (number > 0).then_some((*kind, number))
    })
}

fn references_current_pr(message: &str) -> bool {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:this|the|current)\s+(?:pr|pull\s+request)\b").unwrap()
    });
    RE.is_match(message)
}

/// resolveLinkedWorkItem: a first message's explicit GitHub context, as one
/// stable identity. A URL wins; then a numbered reference (or the title
/// model's hint) in the working copy's repository; then "this PR", meaning
/// the current branch's pull request. Lookups that fail link nothing.
pub fn resolve_work_item(
    message: &str,
    cwd: &Path,
    generated: Option<&crate::session_title::WorkItemHint>,
) -> Option<WorkItem> {
    if let Some(item) = parse_github_work_item(message) {
        return Some(item);
    }
    let hint = explicit_work_item_hint(message).or_else(|| {
        let hint = generated?;
        let kind = match hint.kind.as_str() {
            "pr" => "pr",
            "issue" => "issue",
            _ => return None,
        };
        (hint.number > 0).then_some((kind, hint.number))
    });
    if let Some((kind, number)) = hint {
        let repo = crate::scm::github_repo(cwd)
            .ok()
            .filter(|r| valid_repo(r))?;
        return Some(WorkItem {
            kind: kind.into(),
            url: github_url(&repo, kind, number),
            repo,
            number,
            more: Vec::new(),
        });
    }
    if !references_current_pr(message) {
        return None;
    }
    let pr = crate::scm::pr_status(cwd).ok()??;
    let number = u64::try_from(pr.number).ok().filter(|&n| n > 0)?;
    let repo = parse_github_work_item(&pr.url)
        .map(|item| item.repo)
        .or_else(|| crate::scm::github_repo(cwd).ok())
        .filter(|r| valid_repo(r))?;
    let url = if pr.url.is_empty() {
        github_url(&repo, "pr", number)
    } else {
        pr.url
    };
    Some(WorkItem {
        kind: "pr".into(),
        repo,
        number,
        url,
        more: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap()
    }

    #[test]
    fn folders_move_sessions_and_drop_when_emptied() {
        let mut groups = Groups::default();
        let a = groups.create_folder(&[1, 2, 2], "a".into()).unwrap();
        assert_eq!(groups.folders[0].name, "New folder");
        assert_eq!(groups.folders[0].session_ids, vec![1, 2]);
        let b = groups.create_folder(&[2], "b".into()).unwrap();
        assert_eq!(groups.folders[0].name, "New folder 2");
        assert_eq!(groups.folder(&a).unwrap().session_ids, vec![1]);
        groups.toggle_folder(&a);
        groups.add_to_folder(&a, 2);
        assert!(groups.folder(&b).is_none(), "its last session left");
        let folder = groups.folder(&a).unwrap();
        assert_eq!(folder.session_ids, vec![1, 2]);
        assert!(!folder.collapsed, "adding opens the folder");
        groups.rename_folder(&a, "  ");
        groups.rename_folder(&a, " Work ");
        assert_eq!(groups.folder(&a).unwrap().name, "Work");
        groups.remove_sessions(&[1, 2]);
        assert!(groups.folders.is_empty());
    }

    #[test]
    fn list_orders_reminders_folders_then_pins_and_loose_sessions() {
        let mut groups = Groups::default();
        groups.create_folder(&[2, 3], "f".into());
        let visible = [1, 2, 3, 4, 5, 6];
        let list = build_list(
            &visible,
            |id| id == 5 || id == 3,
            &groups,
            &[(6, 20), (3, 10)],
        );
        assert_eq!(
            list,
            vec![
                Entry::Reminders {
                    collapsed: false,
                    sessions: vec![3, 6]
                },
                Entry::Folder {
                    id: "f".into(),
                    sessions: vec![2]
                },
                Entry::Pinned { sessions: vec![5] },
                Entry::Session(1),
                Entry::Session(4),
            ]
        );
        groups.reminders_collapsed = true;
        let list = build_list(&visible, |id| id == 5, &groups, &[(3, 10)]);
        assert_eq!(navigation_ids(&list, false), vec![2, 5, 1, 4, 6]);
        assert_eq!(navigation_ids(&list, true), vec![3, 2, 5, 1, 4, 6]);
    }

    #[test]
    fn reminder_presets_follow_the_local_clock() {
        let monday_noon = at(2026, 10, 19, 12, 5);
        assert_eq!(
            reminder_at("reminder:1h", monday_noon),
            Some(at(2026, 10, 19, 13, 5))
        );
        assert_eq!(
            reminder_at("reminder:evening", monday_noon),
            Some(at(2026, 10, 19, 18, 0))
        );
        assert_eq!(
            reminder_at("reminder:evening", at(2026, 10, 19, 18, 0)),
            None
        );
        assert_eq!(
            reminder_at("reminder:tomorrow", monday_noon),
            Some(at(2026, 10, 20, 9, 0))
        );
        assert_eq!(
            reminder_at("reminder:next-week", monday_noon),
            Some(at(2026, 10, 26, 9, 0))
        );
        assert_eq!(
            reminder_at("reminder:next-week", at(2026, 10, 25, 22, 0)),
            Some(at(2026, 10, 26, 9, 0))
        );
        let presets = reminder_presets(at(2026, 10, 19, 19, 0));
        assert_eq!(presets[0].1, "In 1 hour (20:00)");
        assert!(!presets[2].2, "this evening has passed");
        assert_eq!(format_reminder(monday_noon), "Mon, Oct 19, 12:05");
    }

    #[test]
    fn github_links_parse_issues_and_pull_requests() {
        assert_eq!(
            parse_github_work_item("see https://github.com/acme/app/pull/123/files"),
            Some(WorkItem {
                kind: "pr".into(),
                repo: "acme/app".into(),
                number: 123,
                url: "https://github.com/acme/app/pull/123".into(),
                more: Vec::new(),
            })
        );
        assert_eq!(
            parse_github_work_item("HTTP://GitHub.com/a/b/Issues/7")
                .unwrap()
                .url,
            "https://github.com/a/b/issues/7"
        );
        for bad in [
            "https://github.com/acme/app/pull/0",
            "https://github.com/acme/app/commit/1",
            "https://github.com/acme/app/pull/12abc",
            "github.com/acme/app/pull/1",
            "https://gitlab.com/acme/app/pull/1",
        ] {
            assert_eq!(parse_github_work_item(bad), None, "{bad}");
        }
    }

    fn row(role: &str, text: String) -> crate::transcript::Row {
        crate::transcript::Row {
            role: role.into(),
            text,
            first: true,
            sent_at: None,
        }
    }
    fn bash(command: &str, output: &str) -> crate::transcript::Row {
        let mut call = crate::tool::ToolCall::new("toolu_1", "Bash");
        call.input = serde_json::json!({ "command": command }).to_string();
        call.output = output.into();
        row("tool", serde_json::to_string(&call).unwrap())
    }
    fn pr(number: u64) -> WorkItem {
        parse_github_work_item(&format!("https://github.com/acme/app/pull/{number}")).unwrap()
    }

    #[test]
    fn created_pull_requests_come_from_gh_pr_create_output_newest_first() {
        let rows = [
            bash(
                "gh pr create --title A --body-file - <<'EOF'\nSee https://github.com/acme/app/pull/1\nEOF",
                "Warning: https://github.com/acme/app/pull/3 is related\nhttps://github.com/acme/app/pull/7\n",
            ),
            // gh exits non-zero when the branch already has a PR, and prints it.
            bash(
                "cd app && gh pr create -R acme/app --fill",
                "a pull request for branch \"x\" already exists:\nhttps://github.com/acme/app/pull/9\n",
            ),
            bash("gh pr view 12", "https://github.com/acme/app/pull/12"),
            bash("echo https://github.com/acme/app/pull/13", "https://github.com/acme/app/pull/13"),
            row("assistant", "Opened https://github.com/acme/app/pull/14".into()),
            bash("gh pr create --fill", "https://github.com/acme/app/pull/7\n"),
        ];
        let numbers = |items: Vec<WorkItem>| items.iter().map(|i| i.number).collect::<Vec<_>>();
        assert_eq!(numbers(created_pull_requests(&rows)), vec![7, 9]);
    }

    #[test]
    fn created_pull_requests_join_the_links_and_a_removed_link_stays_removed() {
        let first = [
            row("user", "Fix the crash".into()),
            bash("gh pr create --fill", "https://github.com/acme/app/pull/48"),
        ];
        let linked = with_created_pull_requests(None, &first).unwrap();
        assert_eq!((linked.number, linked.more.len()), (48, 0));
        // Nothing new: nothing to save.
        assert_eq!(with_created_pull_requests(Some(&linked), &first), None);

        let mut rows = first.to_vec();
        rows.push(row("user", "Open a follow-up".into()));
        rows.push(bash(
            "gh pr create --fill",
            "https://github.com/acme/app/pull/49",
        ));
        let both = with_created_pull_requests(Some(&linked), &rows).unwrap();
        assert_eq!(
            both.links().iter().map(|i| i.number).collect::<Vec<_>>(),
            vec![49, 48]
        );

        // Removing #48 by hand: its turn is no longer the latest, so it stays gone.
        let kept = WorkItem::from_links([pr(49)]).unwrap();
        assert_eq!(with_created_pull_requests(Some(&kept), &rows), None);
    }

    #[test]
    fn extra_links_round_trip_under_more_and_old_items_still_read() {
        let item = WorkItem::from_links([pr(3), pr(2), pr(3), pr(1)]).unwrap();
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["number"], 3);
        assert_eq!(json["more"][1]["number"], 1);
        assert!(json["more"][0].get("more").is_none());
        let back: WorkItem = serde_json::from_value(json).unwrap();
        assert_eq!(back.links().len(), 3);
        // A single link is stored exactly as before.
        assert!(serde_json::to_value(pr(5)).unwrap().get("more").is_none());
        let mut upper = pr(5);
        upper.repo = "ACME/App".into();
        assert!(upper.same(&pr(5)));
    }

    #[test]
    fn first_messages_link_their_explicit_github_context() {
        // A pasted URL needs no repository lookup, whatever the folder is.
        let none = Path::new("/nonexistent/monocode-test");
        let hint = crate::session_title::WorkItemHint {
            kind: "issue".into(),
            number: 9,
        };
        assert_eq!(
            resolve_work_item(
                "hey lets review this pr\n\nhttps://github.com/acme/app/pull/1142 its for the native one",
                none,
                Some(&hint),
            )
            .map(|item| (item.kind, item.repo, item.number)),
            Some(("pr".into(), "acme/app".into(), 1142))
        );
        assert_eq!(resolve_work_item("Fix the sidebar", none, None), None);

        assert_eq!(
            explicit_work_item_hint("look at PR #42 please"),
            Some(("pr", 42))
        );
        assert_eq!(explicit_work_item_hint("pull request 7"), Some(("pr", 7)));
        assert_eq!(explicit_work_item_hint("see Issue#3"), Some(("issue", 3)));
        for text in ["PR #0", "issue tracker", "approach 12", "prs 5"] {
            assert_eq!(explicit_work_item_hint(text), None, "{text}");
        }
        assert!(references_current_pr("review the current PR"));
        assert!(references_current_pr("land this pull request"));
        assert!(!references_current_pr("open a PR for this"));
    }
}
