//! Read Claude Code's own session transcripts (`~/.claude/projects`) so a
//! conversation started in the terminal can be continued in MonoCode. The
//! listing covers every folder, or one project's folder when scoped.
//!
//! Only the default Claude config directory is scanned. Named MonoCode
//! account profiles keep their sessions elsewhere and already resume natively.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;

use crate::dirs_home;
use crate::session_store::SessionStore;

/// Claude caps the encoded project directory name and appends a hash.
const MAX_ENCODED_DIR_LEN: usize = 200;
/// Beyond this a transcript is not worth replaying into the UI.
const MAX_SESSION_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Tool output is shown as a collapsed detail; the model keeps the full text.
const MAX_TOOL_RESULT_CHARS: usize = 16 * 1024;
const MAX_PROMPT_PREVIEW_CHARS: usize = 200;
/// A summary reads the start of a transcript (cwd, first prompt) and its end
/// (titles, last prompt), never the middle of a long session.
const SUMMARY_HEAD_BYTES: u64 = 64 * 1024;
const SUMMARY_TAIL_BYTES: u64 = 256 * 1024;
const MAX_SUMMARY_TAIL_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_LIST_LIMIT: usize = 15;
const MAX_LIST_LIMIT: usize = 200;
/// Newest transcripts summarized per listing; a search looks no further back.
const MAX_SUMMARIZED: usize = 500;

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
];

/// All that is kept of a record the transcript doesn't show.
const LINK_KEYS: &[&str] = &[
    "type",
    "uuid",
    "parentUuid",
    "logicalParentUuid",
    "isSidechain",
];

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeSessionQuery {
    /// Only sessions started in this folder; every folder when absent.
    cwd: Option<String>,
    /// Case-insensitive match on the title, prompts and folder name.
    query: Option<String>,
    limit: Option<usize>,
    /// Also list conversations MonoCode already has.
    include_imported: bool,
}

/// Whether a session's folder can hold a MonoCode chat.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum SessionFolder {
    Ok,
    /// Started in the home folder, which is not a project.
    Home,
    /// The folder was moved or deleted.
    Missing,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionSummary {
    id: String,
    cwd: String,
    /// Claude's generated or user-set title, when the transcript has one.
    title: Option<String>,
    first_prompt: String,
    last_prompt: String,
    git_branch: Option<String>,
    updated_at: u64,
    size_bytes: u64,
    folder: SessionFolder,
    /// The MonoCode session already bound to this conversation.
    monocode_session_id: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionListing {
    sessions: Vec<ClaudeSessionSummary>,
    /// Conversations left out because MonoCode already has them.
    imported_count: usize,
    /// Older sessions exist past `limit`.
    has_more: bool,
}

#[tauri::command(async)]
pub fn claude_list_sessions(
    store: State<'_, SessionStore>,
    request: ClaudeSessionQuery,
) -> Result<ClaudeSessionListing, String> {
    let Some(root) = claude_projects_root() else {
        return Ok(ClaudeSessionListing::default());
    };
    let known = store.provider_session_ids("claude")?;
    Ok(list_sessions(
        &root,
        &request,
        &known,
        dirs_home().as_deref(),
    ))
}

#[tauri::command(async)]
pub fn claude_read_session(cwd: String, session_id: String) -> Result<Vec<Value>, String> {
    validate_session_id(&session_id)?;
    let root = claude_projects_root().ok_or("Claude Code's config directory was not found")?;
    let path = project_dirs(&root, &cwd)
        .into_iter()
        .map(|dir| dir.join(format!("{session_id}.jsonl")))
        .find(|path| path.is_file())
        .ok_or("That Claude Code session no longer exists")?;
    read_session(&path)
}

fn claude_projects_root() -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|home| Path::new(&home).join(".claude")))?;
    let root = base.join("projects");
    root.is_dir().then_some(root)
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        Ok(())
    } else {
        Err("Invalid Claude session id".into())
    }
}

/// Claude names a project directory by replacing every non-alphanumeric
/// character of its cwd with `-`.
fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

/// Candidate directories for `cwd`. Encoding is lossy (`a-b` and `a/b` collide)
/// and long names are truncated, so callers still check each record's `cwd`.
fn project_dirs(root: &Path, cwd: &str) -> Vec<PathBuf> {
    let cwd = cwd.trim_end_matches(['/', '\\']);
    let encoded = encode_project_dir(cwd);
    let exact = root.join(&encoded);
    if encoded.len() <= MAX_ENCODED_DIR_LEN {
        return if exact.is_dir() {
            vec![exact]
        } else {
            Vec::new()
        };
    }
    let prefix = &encoded[..MAX_ENCODED_DIR_LEN];
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(prefix))
        })
        .collect()
}

fn same_cwd(left: &str, right: &str) -> bool {
    left.trim_end_matches(['/', '\\']) == right.trim_end_matches(['/', '\\'])
}

struct Candidate {
    path: PathBuf,
    id: String,
    updated_at: u64,
    size_bytes: u64,
}

/// Transcripts under `root`, newest first. Only top-level files count;
/// subagent transcripts live in nested directories.
fn candidates(root: &Path, cwd: Option<&str>) -> Vec<Candidate> {
    let dirs = match cwd {
        Some(cwd) => project_dirs(root, cwd),
        None => std::fs::read_dir(root)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir())
                    .collect()
            })
            .unwrap_or_default(),
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
            if validate_session_id(id).is_err() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let updated_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            found.push(Candidate {
                id: id.to_string(),
                path,
                updated_at,
                size_bytes: metadata.len(),
            });
        }
    }
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    found
}

/// Newest sessions first. Conversations MonoCode already has are skipped
/// before their transcript is opened, and counted instead.
fn list_sessions(
    root: &Path,
    request: &ClaudeSessionQuery,
    known: &HashMap<String, String>,
    home: Option<&str>,
) -> ClaudeSessionListing {
    let limit = request
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let cwd = request
        .cwd
        .as_deref()
        .map(|cwd| cwd.trim_end_matches(['/', '\\']))
        .filter(|cwd| !cwd.is_empty());
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_lowercase);
    let mut listing = ClaudeSessionListing::default();
    let mut summarized = 0;
    for candidate in candidates(root, cwd) {
        let monocode_session_id = known.get(&candidate.id).cloned();
        if monocode_session_id.is_some() && !request.include_imported {
            listing.imported_count += 1;
            continue;
        }
        if summarized == MAX_SUMMARIZED {
            break;
        }
        summarized += 1;
        let Some(summary) = summarize_session(&candidate, monocode_session_id, home) else {
            continue;
        };
        if cwd.is_some_and(|cwd| !same_cwd(&summary.cwd, cwd)) {
            continue;
        }
        if query
            .as_deref()
            .is_some_and(|query| !matches_query(&summary, query))
        {
            continue;
        }
        if listing.sessions.len() == limit {
            listing.has_more = true;
            break;
        }
        listing.sessions.push(summary);
    }
    listing
}

fn matches_query(summary: &ClaudeSessionSummary, query: &str) -> bool {
    let folder = summary
        .cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    [
        summary.title.as_deref().unwrap_or(""),
        &summary.first_prompt,
        &summary.last_prompt,
        folder,
    ]
    .iter()
    .any(|text| text.to_lowercase().contains(query))
}

fn folder_state(cwd: &str, home: Option<&str>) -> SessionFolder {
    if home.is_some_and(|home| same_cwd(home, cwd)) {
        SessionFolder::Home
    } else if Path::new(cwd).is_dir() {
        SessionFolder::Ok
    } else {
        SessionFolder::Missing
    }
}

/// Only title records and prompt-bearing user lines are parsed. Sessions
/// without a real prompt (a cancelled `/resume`, say) are skipped because
/// there is nothing to continue.
fn summarize_session(
    candidate: &Candidate,
    monocode_session_id: Option<String>,
    home: Option<&str>,
) -> Option<ClaudeSessionSummary> {
    // A long run of tool output can push the last prompt out of the tail, so
    // the tail widens until it holds one.
    let mut tail_bytes = SUMMARY_TAIL_BYTES;
    let scan = loop {
        let mut scan = SummaryScan::default();
        visit_summary_lines(
            &candidate.path,
            candidate.size_bytes,
            tail_bytes,
            |line, in_tail| scan.visit(line, in_tail),
        )
        .ok()?;
        if scan.tail_prompt
            || tail_bytes >= MAX_SUMMARY_TAIL_BYTES
            || candidate.size_bytes <= SUMMARY_HEAD_BYTES + tail_bytes
        {
            break scan;
        }
        tail_bytes *= 4;
    };
    let cwd = scan.cwd?;
    Some(ClaudeSessionSummary {
        id: candidate.id.clone(),
        folder: folder_state(&cwd, home),
        cwd,
        title: scan.custom_title.or(scan.ai_title),
        first_prompt: scan.first_prompt?,
        last_prompt: scan.last_prompt?,
        git_branch: scan.git_branch,
        updated_at: candidate.updated_at,
        size_bytes: candidate.size_bytes,
        monocode_session_id,
    })
}

#[derive(Default)]
struct SummaryScan {
    cwd: Option<String>,
    git_branch: Option<String>,
    ai_title: Option<String>,
    custom_title: Option<String>,
    first_prompt: Option<String>,
    last_prompt: Option<String>,
    /// The last prompt came from the tail rather than the head.
    tail_prompt: bool,
}

impl SummaryScan {
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

/// Feeds `visit` the first `SUMMARY_HEAD_BYTES` and the last `tail_bytes` of
/// a transcript, line by line, flagging tail lines. Small transcripts are read
/// whole and count as tail.
fn visit_summary_lines(
    path: &Path,
    size: u64,
    tail_bytes: u64,
    mut visit: impl FnMut(&str, bool),
) -> std::io::Result<()> {
    let mut reader = BufReader::new(std::fs::File::open(path)?);
    let mut line = Vec::new();
    let whole = size <= SUMMARY_HEAD_BYTES + tail_bytes;
    let mut offset = 0u64;
    while whole || offset < SUMMARY_HEAD_BYTES {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(());
        }
        offset += read as u64;
        visit(&String::from_utf8_lossy(&line), whole);
    }
    let tail_start = size - tail_bytes;
    if tail_start > offset {
        reader.seek(SeekFrom::Start(tail_start))?;
        // The seek lands mid-line; that fragment is not a record.
        line.clear();
        reader.read_until(b'\n', &mut line)?;
    }
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(());
        }
        visit(&String::from_utf8_lossy(&line), true);
    }
}

/// One line of prompt text for a list row.
fn prompt_preview(prompt: &str) -> String {
    let collapsed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, MAX_PROMPT_PREVIEW_CHARS)
}

/// Text between `<tag>` and `</tag>`.
fn tag_text<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&format!("</{tag}>"))?;
    Some(text[start..end].trim())
}

fn non_empty_str(record: &Value, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Text the user actually typed, with slash commands shown as `/name args`.
/// Mirrors the importer's prompt filter closely enough for a preview; the
/// TypeScript side decides what is rendered.
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

fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((index, _)) => format!("{}…", &value[..index]),
        None => value.to_string(),
    }
}

fn read_session(path: &Path) -> Result<Vec<Value>, String> {
    let size = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_SESSION_FILE_BYTES {
        return Err("This Claude Code session is too large to import".into());
    }
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut records = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        // A session being written right now can end in a partial line.
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(record) = slim_record(record) {
            records.push(Value::Object(record));
        }
    }
    Ok(records)
}

fn slim_record(record: Map<String, Value>) -> Option<Map<String, Value>> {
    let kind = record.get("type").and_then(Value::as_str)?;
    let keep = match kind {
        "user" | "assistant" | "ai-title" | "custom-title" => true,
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
        _ => {}
    }
}

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
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "monocode-claude-sessions-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
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

        let listing = list_sessions(&root, &scoped(cwd), &HashMap::new(), None);
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

    fn scoped(cwd: &str) -> ClaudeSessionQuery {
        ClaudeSessionQuery {
            cwd: Some(cwd.into()),
            ..Default::default()
        }
    }

    fn touch(dir: &Path, id: &str, seconds: u64) {
        std::fs::File::options()
            .write(true)
            .open(dir.join(format!("{id}.jsonl")))
            .unwrap()
            .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(seconds))
            .unwrap();
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
        let known = HashMap::from([("known".to_string(), "mono-1".to_string())]);

        let listing = list_sessions(&root, &ClaudeSessionQuery::default(), &known, None);
        let ids: Vec<_> = listing.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["new", "old"]);
        assert_eq!(listing.imported_count, 1);

        let all = ClaudeSessionQuery {
            include_imported: true,
            ..Default::default()
        };
        let listing = list_sessions(&root, &all, &known, None);
        assert_eq!(listing.sessions.len(), 3);
        assert_eq!(
            listing.sessions[1].monocode_session_id.as_deref(),
            Some("mono-1")
        );
        assert_eq!(listing.imported_count, 0);

        let first = ClaudeSessionQuery {
            limit: Some(1),
            ..Default::default()
        };
        let listing = list_sessions(&root, &first, &known, None);
        assert_eq!(listing.sessions.len(), 1);
        assert!(listing.has_more);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_matches_title_prompts_and_folder_name() {
        let root = temp_root("search");
        let dir = root.join(encode_project_dir("/work/billing"));
        write_session(
            &dir,
            "s",
            &[
                user("/work/billing", json!("first ask")),
                user("/work/billing", json!("Then Add Tests")),
                json!({ "type": "custom-title", "customTitle": "Invoice export" }),
            ],
        );
        let search = |query: &str| {
            let request = ClaudeSessionQuery {
                query: Some(query.into()),
                ..Default::default()
            };
            list_sessions(&root, &request, &HashMap::new(), None)
                .sessions
                .len()
        };
        assert_eq!(search("invoice"), 1);
        assert_eq!(search("first"), 1);
        assert_eq!(search("add tests"), 1);
        assert_eq!(search("billing"), 1);
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

        let listing = list_sessions(&root, &scoped(cwd), &HashMap::new(), None);
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

        let listing = list_sessions(&root, &scoped(cwd), &HashMap::new(), None);
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
        assert_eq!(prompt_preview("  fix\n\n the   build "), "fix the build");
    }

    #[test]
    fn home_and_missing_folders_are_flagged() {
        let root = temp_root("folders");
        let home = root.to_str().unwrap();
        assert_eq!(
            folder_state(&format!("{home}/"), Some(home)),
            SessionFolder::Home
        );
        assert_eq!(folder_state(home, None), SessionFolder::Ok);
        assert_eq!(
            folder_state(&format!("{home}/gone"), Some(home)),
            SessionFolder::Missing
        );
        let _ = std::fs::remove_dir_all(&root);
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
    fn rejects_path_like_session_ids() {
        assert!(validate_session_id("../etc").is_err());
        assert!(validate_session_id("d35a3d8b-d7b9-4b7a-b919-01cd52ccd01a").is_ok());
    }
}
