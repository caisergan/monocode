//! Read Claude Code's own session transcripts (`~/.claude/projects`) so a
//! conversation started in the terminal can be continued in MonoCode.
//!
//! Only the default Claude config directory is scanned. Named MonoCode
//! account profiles keep their sessions elsewhere and already resume natively.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::dirs_home;

/// Claude caps the encoded project directory name and appends a hash.
const MAX_ENCODED_DIR_LEN: usize = 200;
/// Beyond this a transcript is not worth replaying into the UI.
const MAX_SESSION_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Tool output is shown as a collapsed detail; the model keeps the full text.
const MAX_TOOL_RESULT_CHARS: usize = 16 * 1024;
const MAX_PROMPT_PREVIEW_CHARS: usize = 200;

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

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionSummary {
    id: String,
    cwd: String,
    /// Claude's generated or user-set title, when the transcript has one.
    title: Option<String>,
    first_prompt: Option<String>,
    prompt_count: usize,
    git_branch: Option<String>,
    updated_at: u64,
    size_bytes: u64,
}

#[tauri::command(async)]
pub fn claude_list_sessions(cwd: String) -> Result<Vec<ClaudeSessionSummary>, String> {
    let Some(root) = claude_projects_root() else {
        return Ok(Vec::new());
    };
    list_sessions(&root, &cwd)
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

fn list_sessions(root: &Path, cwd: &str) -> Result<Vec<ClaudeSessionSummary>, String> {
    let mut sessions = Vec::new();
    for dir in project_dirs(root, cwd) {
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
            if let Some(summary) = summarize_session(&path, id) {
                if same_cwd(&summary.cwd, cwd) {
                    sessions.push(summary);
                }
            }
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

/// Cheap single pass: only title records and prompt-bearing user lines are
/// parsed. Sessions without a real prompt (a cancelled `/resume`, say) are
/// skipped because there is nothing to continue.
fn summarize_session(path: &Path, id: &str) -> Option<ClaudeSessionSummary> {
    let metadata = std::fs::metadata(path).ok()?;
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let file = std::fs::File::open(path).ok()?;
    let mut cwd = None;
    let mut git_branch = None;
    let mut ai_title = None;
    let mut custom_title = None;
    let mut first_prompt = None;
    let mut prompt_count = 0;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        if line.contains("\"type\":\"ai-title\"") || line.contains("\"type\":\"custom-title\"") {
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(title) = non_empty_str(&record, "aiTitle") {
                ai_title = Some(title);
            }
            if let Some(title) = non_empty_str(&record, "customTitle") {
                custom_title = Some(title);
            }
            continue;
        }
        if !line.contains("\"type\":\"user\"") || line.contains("\"tool_result\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if cwd.is_none() {
            cwd = non_empty_str(&record, "cwd");
        }
        if let Some(branch) = non_empty_str(&record, "gitBranch") {
            git_branch = Some(branch);
        }
        if let Some(prompt) = user_prompt_text(&record) {
            prompt_count += 1;
            if first_prompt.is_none() {
                first_prompt = Some(truncate_chars(prompt.trim(), MAX_PROMPT_PREVIEW_CHARS));
            }
        }
    }
    if prompt_count == 0 {
        return None;
    }
    Some(ClaudeSessionSummary {
        id: id.to_string(),
        cwd: cwd?,
        title: custom_title.or(ai_title),
        first_prompt,
        prompt_count,
        git_branch,
        updated_at,
        size_bytes: metadata.len(),
    })
}

fn non_empty_str(record: &Value, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Text the user actually typed. Mirrors the importer's prompt filter closely
/// enough for a count; the TypeScript side decides what is rendered.
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
        return None;
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

        let sessions = list_sessions(&root, cwd).unwrap();
        assert_eq!(sessions.len(), 1);
        let session = &sessions[0];
        assert_eq!(session.id, "one");
        assert_eq!(session.title.as_deref(), Some("Fix build"));
        assert_eq!(session.first_prompt.as_deref(), Some("fix the build"));
        assert_eq!(session.prompt_count, 2);
        assert_eq!(session.git_branch.as_deref(), Some("main"));
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
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["subtype"], "compact_boundary");
        let record = &records[1];
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
