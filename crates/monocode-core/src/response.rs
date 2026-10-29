//! Response actions use the same prose and recap rules as transcriptActivity.ts,
//! secondOpinion.ts and handoff.ts. Tool chrome and private reasoning aren't copied.
use crate::{tool::ToolCall, transcript::Row};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferKind {
    Handoff,
    SecondOpinion,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Target {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub settings: std::collections::HashMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub id: u64,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub source_session: i64,
    pub source_cwd: String,
}
pub use crate::time::now_ms;
pub fn local_clock(epoch_ms: u64) -> String {
    #[cfg(unix)]
    {
        let time = (epoch_ms / 1000) as libc::time_t;
        let mut local = std::mem::MaybeUninit::<libc::tm>::uninit();
        // localtime_r writes the caller-owned buffer and doesn't share tm storage.
        if !unsafe { libc::localtime_r(&time, local.as_mut_ptr()) }.is_null() {
            let local = unsafe { local.assume_init() };
            return format!("{:02}:{:02}", local.tm_hour, local.tm_min);
        }
    }
    let minutes = epoch_ms / 60_000;
    format!("{:02}:{:02}", (minutes / 60) % 24, minutes % 60)
}
pub fn limit(text: &str, count: usize) -> String {
    if text.chars().count() <= count {
        text.into()
    } else {
        format!(
            "{}\n\n[truncated]",
            text.chars()
                .take(count.saturating_sub(13))
                .collect::<String>()
        )
    }
}
pub fn prose(rows: &[Row]) -> String {
    let mut messages: Vec<String> = Vec::new();
    let mut previous = false;
    for row in rows {
        if row.role == "assistant" {
            if !previous || row.first {
                messages.push(String::new());
            }
            messages.last_mut().unwrap().push_str(&row.text);
            previous = true;
        } else {
            previous = false;
        }
    }
    messages
        .iter()
        .map(|s| s.trim().replace("\r\n", "\n").replace('\r', "\n"))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}
pub fn request(rows: &[Row]) -> String {
    rows.iter()
        .take_while(|r| r.role == "user")
        .map(|r| r.text.as_str())
        .collect::<String>()
        .trim()
        .into()
}
pub fn edited_files(rows: &[Row]) -> Vec<String> {
    let mut files = Vec::new();
    for row in rows.iter().filter(|r| r.role == "tool") {
        if let Ok(tool) = serde_json::from_str::<ToolCall>(&row.text) {
            let (action, path) = tool.summary();
            if matches!(action.as_str(), "Edit" | "Write")
                && !path.is_empty()
                && !files.contains(&path)
            {
                files.push(path);
            }
        }
    }
    files.truncate(40);
    files
}
pub fn second_opinion(from: &str, rows: &[Row]) -> String {
    let title = crate::provider::Kind::from_id(from).label();
    let user = request(rows);
    let report = prose(rows);
    let files = edited_files(rows);
    let sections=[
        format!("Give a second opinion on work {title} just finished in this same working copy. The files are already on disk."),
        "Review that work: what is wrong, what is missing, and what you would have done differently. Fix anything you agree is broken or incomplete. If you would leave it, say so and stop. Do not redo the task from scratch unless the work is actually wrong. Read the listed files before changing anything.".into(),
        format!("## User request\n{}",if user.is_empty(){"(no user message on this turn)".into()}else{limit(&user,400)}),
        format!("## What {title} reported\n{}",if report.is_empty(){"(no written summary — inspect the files)".into()}else{limit(&report,900)}),
        format!("## Files it edited\n{}",if files.is_empty(){"(none recorded on this turn)".into()}else{files.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n")}),
    ];
    limit(&sections.join("\n\n"), 1800)
}
pub fn handoff(rows: &[Row]) -> String {
    let mut users = Vec::new();
    let mut user = String::new();
    for row in rows {
        if row.role == "user" {
            if row.first && !user.is_empty() {
                users.push(std::mem::take(&mut user));
            }
            user.push_str(&row.text);
        }
    }
    if !user.is_empty() {
        users.push(user);
    }
    let last = rows
        .iter()
        .rposition(|r| r.role == "assistant" && r.first)
        .unwrap_or(rows.len());
    let report = prose(&rows[last..]);
    let files = edited_files(rows);
    let mut sections = vec![format!(
        "## Session so far\n{}",
        users
            .iter()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|s| format!("User: {}", limit(s, 240).replace('\n', " ")))
            .collect::<Vec<_>>()
            .join("\n")
    )];
    if !report.is_empty() {
        sections.push(format!("Assistant: {}", limit(&report, 500)));
    }
    if !files.is_empty() {
        sections.push(format!(
            "## Files edited in this session\n{}",
            files
                .iter()
                .map(|f| format!("- {f}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    limit(&sections.join("\n\n"), 1800)
}

pub fn outgoing_handoff_prompt(user_request: &str) -> String {
    let request = user_request.trim();
    let request = if request.is_empty() {
        "(no text)"
    } else {
        request
    };
    format!(
        "The user is switching to another coding agent. Their new message will be sent separately — do not repeat it, and do not add a Goal heading.\n\n<user_request>\n{}\n</user_request>\n\nWrite a short recap of this conversation so the next agent can continue. Under 120 words. Plain markdown. No title card. No greeting. Do not paste the whole transcript.\n\nRules:\n- Use only this conversation.\n- Do not run git, do not inspect the working tree, do not read files, do not call tools.\n- Mention files only if this chat edited them.\n- If the chat was a greeting or has no task yet, say that in one sentence. Do not invent work from uncommitted repo files.\n\nInclude only sections that have session-specific content:\n- Session so far (a few bullets, not a transcript)\n- Files edited in this session\n- Suggested next step",
        limit(request, 1500)
    )
}

pub fn choose_handoff_brief(agent: &str, rows: &[Row]) -> String {
    let agent = strip_goal_sections(agent);
    if agent.chars().count() >= 40 {
        limit(&agent, 1800)
    } else {
        strip_goal_sections(&handoff(rows))
    }
}

/// continuation.ts's buildContinuationBrief: the recap for continuing a
/// session in a fresh chat, built from the transcript alone. Asking the old
/// thread to summarize would replay its whole context, which is the cost a
/// fresh chat exists to avoid once the prompt cache is cold.
pub fn continuation(rows: &[Row], earlier: Option<&str>) -> String {
    let mut users: Vec<String> = Vec::new();
    let mut latest_user = None;
    let mut changed: Vec<String> = Vec::new();
    let mut read: Vec<String> = Vec::new();
    for (ix, row) in rows.iter().enumerate() {
        if row.role == "user" {
            if row.first || users.is_empty() {
                users.push(String::new());
            }
            users.last_mut().unwrap().push_str(&row.text);
            latest_user = Some(ix);
        } else if row.role == "tool" {
            let Ok(tool) = serde_json::from_str::<ToolCall>(&row.text) else {
                continue;
            };
            let (action, path) = tool.summary();
            if path.is_empty() {
                continue;
            }
            let key = path.to_lowercase();
            if matches!(action.as_str(), "Edit" | "Write") {
                if !changed.iter().any(|seen| seen.to_lowercase() == key) {
                    changed.push(path);
                }
            } else if action == "Read" {
                read.retain(|seen| seen.to_lowercase() != key);
                read.push(path);
            }
        }
    }
    let list = |items: &[String], max: usize, note: Option<&str>| {
        let mut lines: Vec<String> = Vec::new();
        if let Some(note) = note.filter(|_| items.len() > 1) {
            lines.push(format!("({note})"));
        }
        lines.extend(items.iter().take(max).map(|item| format!("- {item}")));
        if items.len() > max {
            lines.push(format!("- … and {} more", items.len() - max));
        }
        lines.join("\n")
    };
    let mut sections = Vec::new();
    if let Some(earlier) = earlier.map(str::trim).filter(|e| !e.is_empty()) {
        sections.push(format!(
            "## Earlier context\nThis chat already continued an earlier one. Its recap:\n\n{}",
            limit(earlier, 4_000)
        ));
    }
    let texts: Vec<_> = users.iter().map(|text| text.trim()).collect();
    if let Some(first) = texts.first().filter(|text| !text.is_empty()) {
        sections.push(format!("## First request\n{}", limit(first, 1_200)));
    }
    let later: Vec<_> = texts
        .iter()
        .skip(1)
        .filter(|text| !text.is_empty())
        .collect();
    if !later.is_empty() {
        let recent = &later[later.len().saturating_sub(3)..];
        let mut lines = vec!["## Latest requests".to_owned()];
        if later.len() > recent.len() {
            lines.push(format!(
                "({} earlier messages omitted)",
                later.len() - recent.len()
            ));
        }
        lines.extend(recent.iter().map(|text| {
            format!(
                "- {}",
                limit(text, 600)
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        }));
        sections.push(lines.join("\n"));
    }
    let latest = prose(&rows[latest_user.map_or(0, |ix| ix + 1)..]);
    if !latest.is_empty() {
        // The end of a long reply holds its conclusion, so cut from the start.
        let count = latest.chars().count();
        let latest = if count > 8_000 {
            format!(
                "[earlier part truncated]\n\n{}",
                latest.chars().skip(count - 8_000).collect::<String>()
            )
        } else {
            latest
        };
        sections.push(format!("## Latest response\n{latest}"));
    }
    if !changed.is_empty() {
        sections.push(format!(
            "## Files changed in this session\n{}\nOnly edits made with file tools are listed; run `git diff` on a file before relying on its contents.",
            list(&changed, 60, None)
        ));
    }
    let read_only: Vec<String> = read
        .into_iter()
        .rev()
        .filter(|path| {
            !changed
                .iter()
                .any(|seen| seen.to_lowercase() == path.to_lowercase())
        })
        .collect();
    if !read_only.is_empty() {
        sections.push(format!(
            "## Files read in this session\n{}",
            list(&read_only, 30, Some("most recent first"))
        ));
    }
    sections.join("\n\n")
}

/// A continued chat's first prompt: the user's request, then the recap of
/// the chat it continues.
pub fn wrap_continuation_prompt(title: &str, brief: &str, user_request: &str) -> String {
    let lead = format!(
        "You are continuing work from an earlier chat in this project, \"{title}\". This is not a new task. Do not say you have no prior context.\n\n{}",
        user_request.trim()
    );
    let body = brief.trim();
    if body.is_empty() {
        lead
    } else {
        format!(
            "{lead}\n\nRecap of the earlier chat, built from its transcript. Read the files it lists before relying on them:\n\n<continued_chat>\n{body}\n</continued_chat>"
        )
    }
}

/// The first prompt after a handoff: a provider switch, or a chat continued
/// in a fresh session.
pub fn wrap_any_handoff(handoff: &crate::agent::Handoff, user_request: &str) -> String {
    match &handoff.continued {
        Some(source) => wrap_continuation_prompt(&source.title, &handoff.brief, user_request),
        None => wrap_handoff_prompt(&handoff.from, &handoff.brief, user_request),
    }
}
pub fn wrap_handoff_prompt(from: &str, brief: &str, user_request: &str) -> String {
    let provider = crate::provider::Kind::from_id(from).label();
    let body = strip_goal_sections(brief);
    let lead = format!(
        "You are continuing an existing conversation handed off from {provider}. This is not a new session. Do not say you have no prior context.\n\n{}",
        user_request.trim()
    );
    if body.is_empty() {
        format!("{lead}\n\nContinue from a {provider} session. Do not invent prior work.")
    } else {
        format!(
            "{lead}\n\nPrior conversation from {provider} — this is the thread you are joining, not optional background:\n\n<handoff>\n{body}\n</handoff>"
        )
    }
}

pub fn strip_goal_sections(markdown: &str) -> String {
    let mut skip_section = false;
    let mut removed_goal_line = false;
    markdown
        .trim()
        .lines()
        .filter(|line| {
            let heading = line.trim_start_matches('#');
            let depth = line.len() - heading.len();
            if (1..=6).contains(&depth) && heading.starts_with(char::is_whitespace) {
                let title = heading.trim_start().to_lowercase();
                skip_section = title.strip_prefix("goal").is_some_and(|rest| {
                    rest.chars()
                        .next()
                        .is_none_or(|c| !c.is_alphanumeric() && c != '_')
                });
            }
            if skip_section {
                return false;
            }
            if !removed_goal_line && line.to_lowercase().starts_with("goal:") {
                removed_goal_line = true;
                return false;
            }
            true
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn continuation_recaps_requests_the_latest_reply_and_files_from_the_transcript() {
        let row = |role: &str, text: &str| Row {
            role: role.into(),
            text: text.into(),
            first: true,
            sent_at: None,
        };
        let tool = |name: &str, input: serde_json::Value| {
            let mut call = ToolCall::new("t", name);
            call.input = input.to_string();
            row("tool", &serde_json::to_string(&call).unwrap())
        };
        let rows = [
            row("user", "Fix the crash on launch"),
            row("assistant", "Looking."),
            tool("Read", serde_json::json!({"file_path":"src/a.rs"})),
            tool("Edit", serde_json::json!({"file_path":"src/b.rs"})),
            row("user", "Also add a test"),
            row("user", "And update the changelog"),
            tool("Read", serde_json::json!({"file_path":"src/b.rs"})),
            row("assistant", "Done: added the test."),
        ];
        let brief = continuation(&rows, Some("Older recap"));
        assert!(brief.starts_with("## Earlier context"));
        assert!(brief.contains("## First request\nFix the crash on launch"));
        assert!(brief.contains("- Also add a test\n- And update the changelog"));
        assert!(brief.contains("## Latest response\nDone: added the test."));
        assert!(brief.contains("## Files changed in this session\n- src/b.rs"));
        // A file the session changed is not also listed as read.
        assert!(brief.contains("## Files read in this session\n- src/a.rs"));
        let prompt = wrap_continuation_prompt("Crash fix", &brief, "Ship it");
        assert!(prompt.contains("\"Crash fix\""));
        assert!(prompt.contains("Ship it"));
        assert!(prompt.contains("<continued_chat>"));
    }

    use super::*;
    #[test]
    fn copied_prose_and_transfer_recaps_keep_message_boundaries() {
        let rows = vec![
            Row {
                role: "user".into(),
                text: "Check the footer".into(),
                first: true,
                sent_at: None,
            },
            Row {
                role: "assistant".into(),
                text: "I’ll inspect ".into(),
                first: true,
                sent_at: None,
            },
            Row {
                role: "assistant".into(),
                text: "the footer.".into(),
                first: false,
                sent_at: None,
            },
            Row {
                role: "reasoning".into(),
                text: "Private reasoning".into(),
                first: true,
                sent_at: None,
            },
            Row {
                role: "tool".into(),
                text: "Tool output".into(),
                first: true,
                sent_at: None,
            },
            Row {
                role: "assistant".into(),
                text: "**The footer is ready.**\n\n```rust\nlet ready = true;\n```".into(),
                first: true,
                sent_at: None,
            },
        ];
        assert_eq!(
            prose(&rows),
            "I’ll inspect the footer.\n\n**The footer is ready.**\n\n```rust\nlet ready = true;\n```"
        );
        let recap = handoff(&rows);
        assert!(recap.contains("User: Check the footer"));
        assert!(recap.contains("**The footer is ready.**"));
        assert!(!recap.contains("Private reasoning"));
        let review = second_opinion("codex", &rows);
        assert!(review.contains("## User request\nCheck the footer"));
        assert!(review.contains("## What Codex reported"));
        assert!(!review.contains("Tool output"));
    }
}
