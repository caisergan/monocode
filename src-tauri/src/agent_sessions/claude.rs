//! Claude Code keeps one JSONL transcript per session under
//! `~/.claude/projects/<cwd with every non-alphanumeric character as ->/`,
//! or `$CLAUDE_CONFIG_DIR/projects`. Subagent transcripts sit in nested
//! directories and are not listed.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::{
    non_empty_str, prompt_preview, scan_ends, subdirs, truncate_chars, truncate_strings, Candidate,
    Harness, SummaryScan, TranscriptInfo, MAX_TOOL_INPUT_CHARS, MAX_TOOL_RESULT_CHARS,
};
use crate::dirs_home;

/// Claude caps the encoded project directory name and appends a hash.
const MAX_ENCODED_DIR_LEN: usize = 200;

/// Record keys the importer reads. Everything else — notably `toolUseResult`,
/// which duplicates tool output in structured form — is dropped before IPC.
const KEPT_KEYS: &[&str] = &[
    "type",
    "subtype",
    "uuid",
    "parentUuid",
    "logicalParentUuid",
    "isSidechain",
    "isMeta",
    "isCompactSummary",
    "timestamp",
    "cwd",
    "gitBranch",
    "message",
    "content",
    "aiTitle",
    "customTitle",
    "summary",
];

/// All that is kept of a record the transcript doesn't show.
const LINK_KEYS: &[&str] = &[
    "type",
    "uuid",
    "parentUuid",
    "logicalParentUuid",
    "isSidechain",
];

pub(super) fn root() -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|home| Path::new(&home).join(".claude")))?;
    let root = base.join("projects");
    root.is_dir().then_some(root)
}

/// Claude names a project directory by replacing every non-alphanumeric
/// character of its cwd with `-`.
fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

/// The transcript of `session_id`, which ran in `cwd`. Encoding is lossy
/// (`a-b` and `a/b` collide) and long names are truncated, so more than one
/// directory can match.
pub(super) fn find(root: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    let encoded = encode_project_dir(cwd.trim_end_matches(['/', '\\']));
    let dirs = if encoded.len() <= MAX_ENCODED_DIR_LEN {
        vec![root.join(&encoded)]
    } else {
        let prefix = &encoded[..MAX_ENCODED_DIR_LEN];
        subdirs(root)
            .into_iter()
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(prefix))
            })
            .collect()
    };
    dirs.into_iter()
        .map(|dir| dir.join(format!("{session_id}.jsonl")))
        .find(|path| path.is_file())
}

/// Directories that can hold sessions for `cwd`: its own, and those of
/// folders inside it or beside it with a longer name (`app/.worktrees/x`,
/// `app-worktrees/x`), which may be its worktrees.
fn scoped_dirs(root: &Path, cwd: &str) -> Vec<PathBuf> {
    let encoded = encode_project_dir(cwd.trim_end_matches(['/', '\\']));
    let prefix = &encoded[..encoded.len().min(MAX_ENCODED_DIR_LEN)];
    subdirs(root)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix(prefix))
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
        })
        .collect()
}

pub(super) fn candidates(root: &Path, cwd: Option<&str>) -> Vec<Candidate> {
    let dirs = match cwd {
        Some(cwd) => scoped_dirs(root, cwd),
        None => subdirs(root),
    };
    let mut found = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let id = id.to_string();
            found.extend(Candidate::new(Harness::Claude, path, &id));
        }
    }
    found
}

/// Only title records and prompt-bearing user lines are parsed. Sessions
/// without a real prompt (a cancelled `/resume`, say) give `None` because
/// there is nothing to continue.
pub(super) fn transcript_info(candidate: &Candidate) -> Option<TranscriptInfo> {
    let scan = scan_ends::<ClaudeScan>(candidate)?;
    Some(TranscriptInfo {
        cwd: scan.cwd?,
        title: scan.custom_title.or(scan.ai_title).or(scan.summary_title),
        first_prompt: scan.first_prompt?,
        last_prompt: scan.last_prompt?,
        git_branch: scan.git_branch,
    })
}

#[derive(Default)]
struct ClaudeScan {
    cwd: Option<String>,
    git_branch: Option<String>,
    ai_title: Option<String>,
    custom_title: Option<String>,
    /// Older Claude Code versions title a session with a `summary` record.
    summary_title: Option<String>,
    first_prompt: Option<String>,
    last_prompt: Option<String>,
    tail_prompt: bool,
}

impl SummaryScan for ClaudeScan {
    fn tail_prompt(&self) -> bool {
        self.tail_prompt
    }

    fn visit(&mut self, line: &str, in_tail: bool) {
        if line.contains("\"type\":\"ai-title\"") || line.contains("\"type\":\"custom-title\"") {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                return;
            };
            if let Some(title) = non_empty_str(&record, "aiTitle") {
                self.ai_title = Some(title);
            }
            if let Some(title) = non_empty_str(&record, "customTitle") {
                self.custom_title = Some(title);
            }
            return;
        }
        if line.contains("\"type\":\"summary\"") {
            if let Ok(record) = serde_json::from_str::<Value>(line) {
                if record.get("type").and_then(Value::as_str) == Some("summary") {
                    if let Some(title) = non_empty_str(&record, "summary") {
                        self.summary_title = Some(title);
                    }
                }
            }
            return;
        }
        if !line.contains("\"type\":\"user\"") || line.contains("\"tool_result\"") {
            return;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if record.get("type").and_then(Value::as_str) != Some("user") {
            return;
        }
        if self.cwd.is_none() {
            self.cwd = non_empty_str(&record, "cwd");
        }
        if let Some(branch) = non_empty_str(&record, "gitBranch") {
            self.git_branch = Some(branch);
        }
        if let Some(prompt) = user_prompt_text(&record) {
            let preview = prompt_preview(&prompt);
            if self.first_prompt.is_none() {
                self.first_prompt = Some(preview.clone());
            }
            self.last_prompt = Some(preview);
            self.tail_prompt = in_tail;
        }
    }
}

/// Text between `<tag>` and `</tag>`.
fn tag_text<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&format!("</{tag}>"))?;
    Some(text[start..end].trim())
}

/// Text the user actually typed, with slash commands shown as `/name args`.
/// Keep in step with `classifyClaudeUserRecord`, which decides what an
/// import renders, so a row's preview matches the chat it opens.
fn user_prompt_text(record: &Value) -> Option<String> {
    if record.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || record.get("isMeta").and_then(Value::as_bool) == Some(true)
        || record.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let content = record.get("message")?.get("content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("[Request interrupted")
        || trimmed.starts_with("<local-command-")
        || trimmed.starts_with("<task-notification>")
        || trimmed.starts_with("<system-reminder>")
    {
        return None;
    }
    if trimmed.starts_with("<command-") {
        let name = tag_text(trimmed, "command-name")?;
        let args = tag_text(trimmed, "command-args").unwrap_or("");
        return Some(format!("{name} {args}").trim_end().to_string());
    }
    Some(text)
}

pub(super) fn slim_record(record: Map<String, Value>) -> Option<Map<String, Value>> {
    let kind = record.get("type").and_then(Value::as_str)?;
    let keep = match kind {
        "user" | "assistant" | "ai-title" | "custom-title" | "summary" => true,
        "system" => record.get("subtype").and_then(Value::as_str) == Some("compact_boundary"),
        _ => false,
    };
    if !keep {
        // Attachments and hook summaries sit between turns in the `parentUuid`
        // chain; keep their links or the conversation can't be walked back.
        record.get("uuid")?;
        return Some(
            record
                .into_iter()
                .filter(|(key, _)| LINK_KEYS.contains(&key.as_str()))
                .collect(),
        );
    }
    let mut slim: Map<String, Value> = record
        .into_iter()
        .filter(|(key, _)| KEPT_KEYS.contains(&key.as_str()))
        .collect();
    if let Some(Value::Object(message)) = slim.get_mut("message") {
        message
            .retain(|key, _| matches!(key.as_str(), "role" | "content" | "model" | "usage" | "id"));
        if let Some(Value::Array(blocks)) = message.get_mut("content") {
            for block in blocks.iter_mut() {
                slim_content_block(block);
            }
        }
    }
    Some(slim)
}

fn slim_content_block(block: &mut Value) {
    let Some(object) = block.as_object_mut() else {
        return;
    };
    match object.get("type").and_then(Value::as_str) {
        // Inline image payloads are megabytes of base64 the transcript cannot show.
        Some("image") => {
            object.remove("source");
        }
        Some("tool_result") => {
            let text = tool_result_text(object.get("content"));
            object.insert(
                "content".into(),
                Value::String(truncate_chars(&text, MAX_TOOL_RESULT_CHARS)),
            );
        }
        Some("tool_use") => {
            if let Some(input) = object.get_mut("input") {
                truncate_strings(input, MAX_TOOL_INPUT_CHARS);
            }
        }
        _ => {}
    }
}

/// Tool result content as plain text.
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.as_str()),
                Value::Object(object)
                    if object.get("type").and_then(Value::as_str) == Some("text") =>
                {
                    object.get("text").and_then(Value::as_str)
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{known_for, set_mtime, temp_root};
    use super::super::{
        list_sessions, main_checkout, read_records, AgentSessionListing, AgentSessionQuery, Known,
        SessionFolder, Source, SUMMARY_HEAD_BYTES, SUMMARY_TAIL_BYTES,
    };
    use super::*;
    use crate::session_store::KnownSession;
    use serde_json::json;
    use std::io::Write;

    fn read_session(path: &Path) -> Result<Vec<Value>, String> {
        read_records(path, slim_record)
    }

    fn claude(root: &Path) -> [Source; 1] {
        [Source {
            harness: Harness::Claude,
            root: root.to_path_buf(),
        }]
    }

    fn known(sessions: impl IntoIterator<Item = (&'static str, KnownSession)>) -> Known {
        known_for(Harness::Claude, sessions)
    }

    fn write_session(dir: &Path, id: &str, records: &[Value]) {
        std::fs::create_dir_all(dir).unwrap();
        let mut file = std::fs::File::create(dir.join(format!("{id}.jsonl"))).unwrap();
        for record in records {
            writeln!(file, "{record}").unwrap();
        }
    }

    fn user(cwd: &str, content: Value) -> Value {
        json!({
            "type": "user",
            "uuid": "u1",
            "parentUuid": null,
            "cwd": cwd,
            "gitBranch": "main",
            "isSidechain": false,
            "message": { "role": "user", "content": content },
            "toolUseResult": { "huge": "payload" },
        })
    }

    #[test]
    fn encodes_every_non_alphanumeric_character() {
        assert_eq!(
            encode_project_dir("/Users/me/my.app/.worktrees/x_y"),
            "-Users-me-my-app--worktrees-x-y"
        );
    }

    #[test]
    fn lists_sessions_with_prompts_for_the_exact_cwd() {
        let root = temp_root("list");
        let cwd = "/work/a-b";
        let dir = root.join(encode_project_dir(cwd));
        write_session(
            &dir,
            "one",
            &[
                user(cwd, json!("fix the build")),
                user(
                    cwd,
                    json!([{ "type": "tool_result", "tool_use_id": "t", "content": "ok" }]),
                ),
                user(
                    cwd,
                    json!("<local-command-stdout>done</local-command-stdout>"),
                ),
                user(cwd, json!([{ "type": "text", "text": "and add tests" }])),
                json!({ "type": "ai-title", "aiTitle": "Fix build" }),
            ],
        );
        // `a/b` encodes to the same directory; its records carry another cwd.
        write_session(&dir, "other", &[user("/work/a/b", json!("elsewhere"))]);
        write_session(
            &dir,
            "empty",
            &[json!({ "type": "mode", "mode": "normal" })],
        );

        let listing = list(&root, &scoped(cwd), &Known::new());
        assert_eq!(listing.sessions.len(), 1);
        let session = &listing.sessions[0];
        assert_eq!(session.id, "one");
        assert_eq!(session.title.as_deref(), Some("Fix build"));
        assert_eq!(session.first_prompt, "fix the build");
        assert_eq!(session.last_prompt, "and add tests");
        assert_eq!(session.git_branch.as_deref(), Some("main"));
        assert_eq!(session.folder, SessionFolder::Missing);
        assert!(!listing.has_more);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn list(root: &Path, request: &AgentSessionQuery, known: &Known) -> AgentSessionListing {
        list_sessions(&claude(root), request, known, None, &|| true)
    }

    fn scoped(cwd: &str) -> AgentSessionQuery {
        AgentSessionQuery {
            cwd: Some(cwd.into()),
            ..Default::default()
        }
    }

    fn touch(dir: &Path, id: &str, seconds: u64) {
        set_mtime(&dir.join(format!("{id}.jsonl")), seconds);
    }

    #[test]
    fn lists_every_folder_newest_first_and_leaves_out_known_sessions() {
        let root = temp_root("all");
        let app = root.join(encode_project_dir("/work/app"));
        let site = root.join(encode_project_dir("/work/site"));
        write_session(&app, "old", &[user("/work/app", json!("old work"))]);
        write_session(
            &site,
            "known",
            &[user("/work/site", json!("from MonoCode"))],
        );
        write_session(&site, "new", &[user("/work/site", json!("new work"))]);
        touch(&app, "old", 100);
        touch(&site, "known", 200);
        touch(&site, "new", 300);
        let known = known([("known", KnownSession::new("mono-1", "/work/site"))]);

        let listing = list(&root, &AgentSessionQuery::default(), &known);
        let ids: Vec<_> = listing.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["new", "old"]);
        assert_eq!(listing.imported_count, 1);

        let all = AgentSessionQuery {
            include_imported: true,
            ..Default::default()
        };
        let listing = list(&root, &all, &known);
        assert_eq!(listing.sessions.len(), 3);
        assert_eq!(
            listing.sessions[1].monocode_session_id.as_deref(),
            Some("mono-1")
        );
        assert_eq!(listing.imported_count, 0);

        let first = AgentSessionQuery {
            limit: Some(1),
            ..Default::default()
        };
        let listing = list(&root, &first, &known);
        assert_eq!(listing.sessions.len(), 1);
        assert!(listing.has_more);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_matches_title_prompts_folder_name_and_id() {
        let root = temp_root("search");
        let dir = root.join(encode_project_dir("/work/billing"));
        write_session(
            &dir,
            "9f3c2a71-beef",
            &[
                user("/work/billing", json!("first ask")),
                user("/work/billing", json!("Then Add Tests")),
                json!({ "type": "custom-title", "customTitle": "Invoice export" }),
            ],
        );
        let search = |query: &str| {
            let request = AgentSessionQuery {
                query: Some(query.into()),
                ..Default::default()
            };
            list(&root, &request, &Known::new()).sessions.len()
        };
        assert_eq!(search("invoice"), 1);
        assert_eq!(search("first"), 1);
        assert_eq!(search("add tests"), 1);
        assert_eq!(search("billing"), 1);
        assert_eq!(search("9F3C2A"), 1);
        assert_eq!(search("  "), 1);
        assert_eq!(search("payroll"), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn long_transcripts_are_summarized_from_their_ends() {
        let root = temp_root("long");
        let cwd = "/work/long";
        let dir = root.join(encode_project_dir(cwd));
        let filler = json!({ "type": "assistant", "message": { "content": "y".repeat(4096) } });
        let mut records = vec![user(cwd, json!("start here"))];
        records.extend(std::iter::repeat_n(filler, 200));
        records.push(user(cwd, json!("finish up")));
        records.push(json!({ "type": "ai-title", "aiTitle": "Long one" }));
        write_session(&dir, "long", &records);
        let size = std::fs::metadata(dir.join("long.jsonl")).unwrap().len();
        assert!(size > SUMMARY_HEAD_BYTES + SUMMARY_TAIL_BYTES);

        let listing = list(&root, &scoped(cwd), &Known::new());
        let session = &listing.sessions[0];
        assert_eq!(session.first_prompt, "start here");
        assert_eq!(session.last_prompt, "finish up");
        assert_eq!(session.title.as_deref(), Some("Long one"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tail_widens_past_long_tool_output_to_find_the_last_prompt() {
        let root = temp_root("wide");
        let cwd = "/work/wide";
        let dir = root.join(encode_project_dir(cwd));
        let filler = json!({ "type": "assistant", "message": { "content": "z".repeat(4096) } });
        let mut records = vec![user(cwd, json!("start here"))];
        records.extend(std::iter::repeat_n(filler.clone(), 50));
        records.push(user(cwd, json!("the real last ask")));
        records.extend(std::iter::repeat_n(filler, 100));
        write_session(&dir, "wide", &records);

        let listing = list(&root, &scoped(cwd), &Known::new());
        assert_eq!(listing.sessions[0].last_prompt, "the real last ask");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn previews_show_slash_commands_as_typed() {
        let record = user(
            "/w",
            json!("<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>"),
        );
        assert_eq!(user_prompt_text(&record).as_deref(), Some("/model opus"));
    }

    #[test]
    fn read_session_drops_heavy_and_irrelevant_fields() {
        let root = temp_root("read");
        let long = "x".repeat(MAX_TOOL_RESULT_CHARS + 10);
        write_session(
            &root,
            "s",
            &[
                json!({ "type": "attachment", "attachment": {} }),
                json!({ "type": "system", "subtype": "turn_duration" }),
                json!({ "type": "attachment", "uuid": "a", "parentUuid": "p", "attachment": { "big": "x" } }),
                json!({ "type": "system", "subtype": "compact_boundary", "uuid": "c" }),
                user(
                    "/w",
                    json!([
                        { "type": "image", "source": { "data": "AAAA" } },
                        { "type": "tool_result", "tool_use_id": "t", "content": [{ "type": "text", "text": long }] },
                    ]),
                ),
            ],
        );
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(root.join("s.jsonl"))
            .unwrap();
        write!(file, "{{\"type\":\"user\",\"partial").unwrap();

        let records = read_session(&root.join("s.jsonl")).unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(
            records[0],
            json!({ "type": "attachment", "uuid": "a", "parentUuid": "p" })
        );
        assert_eq!(records[1]["subtype"], "compact_boundary");
        let record = &records[2];
        assert!(record.get("toolUseResult").is_none());
        let content = record["message"]["content"].as_array().unwrap();
        assert!(content[0].get("source").is_none());
        let text = content[1]["content"].as_str().unwrap();
        assert_eq!(text.chars().count(), MAX_TOOL_RESULT_CHARS + 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn chats_lists_only_sessions_without_a_project() {
        let root = temp_root("chats");
        let projects = root.join("projects");
        let home = root.join("home");
        let app = root.join("app");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&app).unwrap();
        let (home, app) = (home.to_str().unwrap(), app.to_str().unwrap());
        let gone = format!("{app}-deleted");
        for (id, cwd, seconds) in [
            ("in-home", home, 400),
            ("in-app", app, 300),
            ("in-gone", gone.as_str(), 200),
            ("known-home", home, 100),
        ] {
            let dir = projects.join(encode_project_dir(cwd));
            write_session(&dir, id, &[user(cwd, json!("work"))]);
            touch(&dir, id, seconds);
        }
        let known = known([
            ("known-home", KnownSession::new("m-1", "~")),
            ("in-app", KnownSession::new("m-2", app)),
        ]);
        let request = AgentSessionQuery {
            projectless: true,
            ..Default::default()
        };
        let listing = list_sessions(&claude(&projects), &request, &known, Some(home), &|| true);
        let ids: Vec<_> = listing.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["in-home", "in-gone"]);
        // Only the chat already in MonoCode's Chats counts, not the project one.
        assert_eq!(listing.imported_count, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_time_filter_ends_the_listing_at_older_sessions() {
        let root = temp_root("since");
        let dir = root.join(encode_project_dir("/work/app"));
        for (id, seconds) in [("new", 300), ("mid", 200), ("old", 100)] {
            write_session(&dir, id, &[user("/work/app", json!("work"))]);
            touch(&dir, id, seconds);
        }
        let known = known([("old", KnownSession::new("m", "/work/app"))]);
        let request = AgentSessionQuery {
            since: Some(200_000),
            limit: Some(1),
            ..Default::default()
        };
        let listing = list(&root, &request, &known);
        let ids: Vec<_> = listing.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["new"]);
        assert!(listing.has_more);
        // The imported session is older than the filter, so it isn't counted.
        assert_eq!(listing.imported_count, 0);

        let request = AgentSessionQuery {
            since: Some(250_000),
            limit: Some(1),
            ..Default::default()
        };
        assert!(!list(&root, &request, &known).has_more);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn counts_every_known_session_not_just_one_page() {
        let root = temp_root("count");
        let dir = root.join(encode_project_dir("/work/app"));
        for (index, id) in ["a", "b", "c", "d"].iter().enumerate() {
            write_session(&dir, id, &[user("/work/app", json!("work"))]);
            touch(&dir, id, 100 + index as u64);
        }
        // The two oldest are in MonoCode, one of them under another project.
        let known = known([
            ("a", KnownSession::new("m-a", "/work/app")),
            ("b", KnownSession::new("m-b", "/work/other")),
        ]);

        let first = AgentSessionQuery {
            limit: Some(1),
            ..Default::default()
        };
        let listing = list(&root, &first, &known);
        assert_eq!(listing.sessions.len(), 1);
        assert!(listing.has_more);
        assert_eq!(listing.imported_count, 2);

        let scoped_first = AgentSessionQuery {
            limit: Some(1),
            ..scoped("/work/app")
        };
        assert_eq!(list(&root, &scoped_first, &known).imported_count, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_superseded_listing_stops_reading() {
        let root = temp_root("superseded");
        let dir = root.join(encode_project_dir("/work/app"));
        write_session(&dir, "s", &[user("/work/app", json!("work"))]);
        let listing = list_sessions(
            &claude(&root),
            &AgentSessionQuery::default(),
            &Known::new(),
            None,
            &|| false,
        );
        assert!(listing.sessions.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_changed_transcript_is_read_again() {
        let root = temp_root("cache");
        let dir = root.join(encode_project_dir("/work/app"));
        write_session(&dir, "s", &[user("/work/app", json!("first"))]);
        touch(&dir, "s", 100);
        let prompt = |root: &Path| {
            list(root, &scoped("/work/app"), &Known::new()).sessions[0]
                .last_prompt
                .clone()
        };
        assert_eq!(prompt(&root), "first");
        write_session(
            &dir,
            "s",
            &[
                user("/work/app", json!("first")),
                user("/work/app", json!("second")),
            ],
        );
        touch(&dir, "s", 200);
        assert_eq!(prompt(&root), "second");
        let _ = std::fs::remove_dir_all(&root);
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            // A pre-push hook exports these; they would aim every command at
            // the repository being pushed instead of the temp folder.
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn worktree_sessions_list_under_their_main_checkout() {
        let root = temp_root("worktree");
        let main = root
            .join("repo")
            .canonicalize()
            .unwrap_or(root.join("repo"));
        std::fs::create_dir_all(&main).unwrap();
        let main = main.canonicalize().unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                ".worktrees/feature",
                "-b",
                "feature",
            ],
        );
        let main_str = main.to_str().unwrap();
        let tree = format!("{main_str}/.worktrees/feature");
        assert_eq!(main_checkout(&tree).as_deref(), Some(main_str));
        assert_eq!(main_checkout(main_str), None);

        let projects = root.join("projects");
        write_session(
            &projects.join(encode_project_dir(&tree)),
            "wt",
            &[user(&tree, json!("in the worktree"))],
        );
        // Shares the name prefix but is another folder.
        let sibling = format!("{main_str}-other");
        write_session(
            &projects.join(encode_project_dir(&sibling)),
            "sib",
            &[user(&sibling, json!("elsewhere"))],
        );
        let listing = list(&projects, &scoped(main_str), &Known::new());
        let ids: Vec<_> = listing.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["wt"]);
        assert_eq!(listing.sessions[0].project.as_deref(), Some(main_str));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_a_transcript_cut_inside_a_character() {
        let root = temp_root("cut");
        write_session(&root, "s", &[user("/w", json!("héllo"))]);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(root.join("s.jsonl"))
            .unwrap();
        // The first byte of a two-byte "é", as a write in progress leaves it.
        file.write_all(b"{\"type\":\"user\",\"x\":\"\xc3").unwrap();
        let records = read_session(&root.join("s.jsonl")).unwrap();
        assert_eq!(records.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn caps_tool_inputs_and_keeps_old_summary_titles() {
        let root = temp_root("inputs");
        let cwd = "/work/old";
        let dir = root.join(encode_project_dir(cwd));
        let big = "w".repeat(MAX_TOOL_INPUT_CHARS + 5);
        write_session(
            &dir,
            "s",
            &[
                json!({ "type": "summary", "summary": "Old style title", "leafUuid": "x" }),
                user(cwd, json!("write it")),
                json!({
                    "type": "assistant",
                    "uuid": "a1",
                    "message": { "role": "assistant", "content": [{
                        "type": "tool_use", "id": "t", "name": "Write",
                        "input": { "file_path": "/work/old/a.txt", "content": big },
                    }] },
                }),
            ],
        );
        let listing = list(&root, &scoped(cwd), &Known::new());
        assert_eq!(
            listing.sessions[0].title.as_deref(),
            Some("Old style title")
        );

        let records = read_session(&dir.join("s.jsonl")).unwrap();
        assert_eq!(records[0]["summary"], "Old style title");
        let input = &records[2]["message"]["content"][0]["input"];
        assert_eq!(input["file_path"], "/work/old/a.txt");
        assert_eq!(
            input["content"].as_str().unwrap().chars().count(),
            MAX_TOOL_INPUT_CHARS + 1
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn system_reminders_are_not_prompts() {
        let record = user("/w", json!("<system-reminder>be brief</system-reminder>"));
        assert_eq!(user_prompt_text(&record), None);
    }
}
