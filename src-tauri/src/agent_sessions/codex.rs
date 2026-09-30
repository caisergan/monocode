//! Codex keeps one JSONL "rollout" per conversation, under
//! `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, or
//! `$CODEX_HOME/sessions` (a MonoCode account profile sets `CODEX_HOME`). The
//! first record is `session_meta`, with the conversation's id and cwd.
//!
//! Resuming a conversation appends to the same file, so a record's position is
//! a stable cursor into it. Rollouts written for other purposes (a guardian
//! review, a spawned subagent) are marked by their `source` and never listed.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::{
    non_empty_str, prompt_preview, scan_ends, truncate_strings, Candidate, Harness, SummaryScan,
    TranscriptInfo, MAX_TOOL_RESULT_CHARS,
};
use crate::dirs_home;

/// Rollouts sit at most `year/month/day` below the sessions folder; older
/// builds wrote them flat.
const MAX_DEPTH: usize = 3;

/// A conversation id is a UUID.
const ID_LEN: usize = 36;

pub(super) fn root() -> Option<PathBuf> {
    let base = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|home| Path::new(&home).join(".codex")))?;
    let root = base.join("sessions");
    root.is_dir().then_some(root)
}

/// The conversation id at the end of `rollout-<timestamp>-<uuid>.jsonl`.
fn session_id_of(path: &Path) -> Option<&str> {
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    if !stem.starts_with("rollout-") || stem.len() < ID_LEN + 1 {
        return None;
    }
    let (rest, id) = stem.split_at(stem.len() - ID_LEN);
    if !rest.ends_with('-') || !is_uuid(id) {
        return None;
    }
    Some(id)
}

fn is_uuid(id: &str) -> bool {
    id.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// Every rollout under `dir`, `depth` more folders down at most.
fn rollout_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if session_id_of(&path).is_some() {
                out.push(path);
            }
        } else if depth > 0 && path.is_dir() {
            rollout_files(&path, depth - 1, out);
        }
    }
}

pub(super) fn candidates(root: &Path) -> Vec<Candidate> {
    let mut files = Vec::new();
    rollout_files(root, MAX_DEPTH, &mut files);
    files
        .into_iter()
        .filter_map(|path| {
            let id = session_id_of(&path)?.to_string();
            Candidate::new(Harness::Codex, path, &id)
        })
        .collect()
}

/// The rollout of `session_id`. Dates are newest first, so a recent
/// conversation is found without walking every folder.
pub(super) fn find(root: &Path, session_id: &str) -> Option<PathBuf> {
    fn search(dir: &Path, depth: usize, session_id: &str) -> Option<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .collect();
        entries.sort_by(|a, b| b.cmp(a));
        for path in entries {
            if path.is_file() {
                if session_id_of(&path) == Some(session_id) {
                    return Some(path);
                }
            } else if depth > 0 && path.is_dir() {
                if let Some(found) = search(&path, depth - 1, session_id) {
                    return Some(found);
                }
            }
        }
        None
    }
    search(root, MAX_DEPTH, session_id)
}

pub(super) fn transcript_info(candidate: &Candidate) -> Option<TranscriptInfo> {
    let scan = scan_ends::<CodexScan>(candidate)?;
    if scan.not_a_conversation {
        return None;
    }
    Some(TranscriptInfo {
        cwd: scan.cwd?,
        title: None,
        first_prompt: scan.first_prompt?,
        last_prompt: scan.last_prompt?,
        git_branch: scan.git_branch,
    })
}

#[derive(Default)]
struct CodexScan {
    cwd: Option<String>,
    git_branch: Option<String>,
    first_prompt: Option<String>,
    last_prompt: Option<String>,
    tail_prompt: bool,
    /// A guardian review or a spawned subagent, not something to continue.
    not_a_conversation: bool,
}

impl SummaryScan for CodexScan {
    fn tail_prompt(&self) -> bool {
        self.tail_prompt
    }

    fn visit(&mut self, line: &str, in_tail: bool) {
        if line.contains("\"type\":\"session_meta\"") {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                return;
            };
            let Some(meta) = record.get("payload") else {
                return;
            };
            if self.cwd.is_none() {
                self.cwd = non_empty_str(meta, "cwd");
            }
            if meta
                .get("source")
                .is_some_and(|source| source.get("subagent").is_some())
            {
                self.not_a_conversation = true;
            }
            if let Some(branch) = meta.get("git").and_then(|git| non_empty_str(git, "branch")) {
                self.git_branch = Some(branch);
            }
            return;
        }
        if let Some(prompt) = user_prompt(line) {
            let preview = prompt_preview(&prompt);
            if self.first_prompt.is_none() {
                self.first_prompt = Some(preview.clone());
            }
            self.last_prompt = Some(preview);
            self.tail_prompt = in_tail;
        }
    }
}

/// What the user typed, from either shape a prompt is recorded in: the CLI's
/// `user_message` event, or an app-server `UserMessage` item.
fn user_prompt(line: &str) -> Option<String> {
    let cli = line.contains("\"type\":\"user_message\"");
    let item = line.contains("\"type\":\"UserMessage\"");
    if !cli && !item {
        return None;
    }
    let record = serde_json::from_str::<Value>(line).ok()?;
    if record.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = record.get("payload")?;
    let text = match payload.get("type").and_then(Value::as_str)? {
        "user_message" => payload.get("message")?.as_str()?.to_string(),
        "item_completed" => {
            let item = payload.get("item")?;
            if item.get("type").and_then(Value::as_str) != Some("UserMessage") {
                return None;
            }
            item.get("content")?
                .as_array()?
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Event types the importer replays.
const KEPT_EVENTS: &[&str] = &[
    "user_message",
    "agent_message",
    "agent_reasoning",
    "exec_command_end",
    "patch_apply_end",
    "mcp_tool_call_end",
    "web_search_end",
    "item_completed",
    "turn_aborted",
    "thread_rolled_back",
    "context_compacted",
    "task_started",
    "task_complete",
];

/// Model calls the importer replays, and their results. Messages, encrypted
/// reasoning and injected context are not among them: the events above carry
/// what was said, and the rest is prompt plumbing.
const KEPT_RESPONSE_ITEMS: &[&str] = &[
    "function_call",
    "custom_tool_call",
    "function_call_output",
    "custom_tool_call_output",
];

pub(super) fn slim_record(record: Map<String, Value>) -> Option<Map<String, Value>> {
    let kind = record.get("type").and_then(Value::as_str)?;
    let payload = record.get("payload")?.as_object()?;
    let payload_kind = payload.get("type").and_then(Value::as_str);
    let mut slim = Map::new();
    if let Some(timestamp) = record.get("timestamp") {
        slim.insert("timestamp".into(), timestamp.clone());
    }
    slim.insert("type".into(), Value::String(kind.to_string()));
    let mut kept = Map::new();
    match (kind, payload_kind) {
        ("event_msg", Some(event)) if KEPT_EVENTS.contains(&event) => {
            kept = payload.clone();
            // Rate limits and other accounting sit in the same record.
            kept.remove("rate_limits");
        }
        ("event_msg", Some("token_count")) => {
            kept.insert("type".into(), Value::String("token_count".into()));
            if let Some(info) = payload.get("info").and_then(Value::as_object) {
                let mut slim_info = Map::new();
                for key in ["last_token_usage", "model_context_window"] {
                    if let Some(value) = info.get(key) {
                        slim_info.insert(key.into(), value.clone());
                    }
                }
                kept.insert("info".into(), Value::Object(slim_info));
            }
        }
        ("response_item", Some(item)) if KEPT_RESPONSE_ITEMS.contains(&item) => {
            for key in [
                "type",
                "call_id",
                "name",
                "arguments",
                "input",
                "output",
                "status",
            ] {
                if let Some(value) = payload.get(key) {
                    kept.insert(key.into(), value.clone());
                }
            }
        }
        // The model in use, without the rest of a turn's settings.
        ("turn_context", _) => {
            kept.insert("type".into(), Value::String("turn_context".into()));
            if let Some(model) = payload.get("model") {
                kept.insert("model".into(), model.clone());
            }
        }
        _ => return None,
    }
    let mut kept = Value::Object(kept);
    // A prompt, a command, a diff and a tool's output are each shown collapsed
    // and only previewed; the agent keeps the full text.
    truncate_strings(&mut kept, MAX_TOOL_RESULT_CHARS);
    slim.insert("payload".into(), kept);
    Some(slim)
}

#[cfg(test)]
mod tests {
    use super::super::read_records;
    use super::super::test_support::temp_root;
    use super::*;
    use serde_json::json;

    const ID: &str = "01a0e30f-534b-7dc1-bfbc-204d96cc23cf";

    fn write_rollout(root: &Path, date: &str, id: &str, lines: &[Value]) -> PathBuf {
        let dir = root.join(date);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-2026-09-27T16-30-27-{id}.jsonl"));
        let body = lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, format!("{body}\n")).unwrap();
        path
    }

    fn meta(cwd: &str, source: Value) -> Value {
        json!({ "type": "session_meta", "payload": { "id": ID, "cwd": cwd, "source": source } })
    }

    #[test]
    fn finds_a_rollout_by_the_id_in_its_name() {
        let root = temp_root("codex-find");
        let path = write_rollout(&root, "2026/09/27", ID, &[meta("/work/app", json!("cli"))]);
        write_rollout(
            &root,
            "2026/09/26",
            "11111111-2222-3333-4444-555555555555",
            &[],
        );
        assert_eq!(find(&root, ID), Some(path));
        assert_eq!(find(&root, "99999999-2222-3333-4444-555555555555"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_conversation_files_are_rollouts() {
        assert!(session_id_of(Path::new(&format!(
            "rollout-2026-09-27T16-30-27-{ID}.jsonl"
        )))
        .is_some());
        for name in [
            "notes.jsonl",
            "rollout-2026-09-27T16-30-27-not-a-uuid.jsonl",
            &format!("rollout-2026-09-27T16-30-27-{ID}.json"),
            &format!("session-{ID}.jsonl"),
        ] {
            assert!(session_id_of(Path::new(name)).is_none(), "{name}");
        }
    }

    #[test]
    fn summarizes_a_cli_conversation_by_its_prompts() {
        let root = temp_root("codex-info-cli");
        let path = write_rollout(
            &root,
            "2026/09/27",
            ID,
            &[
                meta("/work/app", json!("cli")),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "fix the login bug" } }),
                json!({ "type": "event_msg", "payload": { "type": "agent_message", "message": "on it" } }),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "now add a test" } }),
            ],
        );
        let candidate = Candidate::new(Harness::Codex, path, ID).unwrap();
        let info = transcript_info(&candidate).unwrap();
        assert_eq!(info.cwd, "/work/app");
        assert_eq!(info.first_prompt, "fix the login bug");
        assert_eq!(info.last_prompt, "now add a test");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn summarizes_an_app_server_conversation_by_its_user_items() {
        let root = temp_root("codex-info-app");
        let path = write_rollout(
            &root,
            "2026/09/27",
            ID,
            &[
                meta("/work/app", json!("vscode")),
                json!({ "type": "event_msg", "payload": { "type": "item_completed",
                    "item": { "type": "UserMessage", "content": [{ "type": "text", "text": "pull upstream" }] } } }),
            ],
        );
        let candidate = Candidate::new(Harness::Codex, path, ID).unwrap();
        let info = transcript_info(&candidate).unwrap();
        assert_eq!(info.first_prompt, "pull upstream");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn subagent_rollouts_are_not_conversations() {
        let root = temp_root("codex-info-guardian");
        let path = write_rollout(
            &root,
            "2026/09/27",
            ID,
            &[
                meta("/work/app", json!({ "subagent": { "other": "guardian" } })),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "review" } }),
            ],
        );
        let candidate = Candidate::new(Harness::Codex, path, ID).unwrap();
        assert!(transcript_info(&candidate).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rollout_with_no_prompt_has_nothing_to_continue() {
        let root = temp_root("codex-info-empty");
        let path = write_rollout(&root, "2026/09/27", ID, &[meta("/work/app", json!("cli"))]);
        let candidate = Candidate::new(Harness::Codex, path, ID).unwrap();
        assert!(transcript_info(&candidate).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn slimming_keeps_what_the_replay_reads_and_drops_the_rest() {
        let root = temp_root("codex-slim");
        let path = write_rollout(
            &root,
            "2026/09/27",
            ID,
            &[
                meta("/work/app", json!("cli")),
                json!({ "type": "turn_context", "payload": { "model": "gpt-6", "sandbox_policy": { "type": "x" } } }),
                json!({ "type": "response_item", "payload": { "type": "message", "role": "developer", "content": [] } }),
                json!({ "type": "response_item", "payload": { "type": "reasoning", "encrypted_content": "AAAA" } }),
                json!({ "type": "event_msg", "timestamp": "2026-09-27T13:30:30Z", "payload": { "type": "user_message", "message": "hi" } }),
                json!({ "type": "response_item", "payload": { "type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{\"cmd\":\"ls\"}", "namespace": "x" } }),
                json!({ "type": "event_msg", "payload": { "type": "token_count",
                    "info": { "last_token_usage": { "total_tokens": 7 }, "total_token_usage": { "total_tokens": 99 }, "model_context_window": 1000 },
                    "rate_limits": { "primary": {} } } }),
                json!({ "type": "world_state", "payload": { "type": "snapshot" } }),
            ],
        );
        let records = read_records(&path, slim_record).unwrap();
        let kinds: Vec<(String, String)> = records
            .iter()
            .map(|record| {
                (
                    record["type"].as_str().unwrap().to_string(),
                    record["payload"]["type"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [
                ("turn_context", "turn_context"),
                ("event_msg", "user_message"),
                ("response_item", "function_call"),
                ("event_msg", "token_count"),
            ]
            .map(|(a, b)| (a.to_string(), b.to_string()))
        );
        assert_eq!(records[0]["payload"]["model"], "gpt-6");
        assert!(records[0]["payload"].get("sandbox_policy").is_none());
        assert_eq!(records[1]["timestamp"], "2026-09-27T13:30:30Z");
        assert!(records[2]["payload"].get("namespace").is_none());
        assert_eq!(records[2]["payload"]["arguments"], "{\"cmd\":\"ls\"}");
        assert_eq!(
            records[3]["payload"]["info"]["last_token_usage"]["total_tokens"],
            7
        );
        assert!(records[3]["payload"]["info"]
            .get("total_token_usage")
            .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn slimming_is_the_same_every_time_so_a_position_stays_a_cursor() {
        let root = temp_root("codex-cursor");
        let lines = [
            meta("/work/app", json!("cli")),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "one" } }),
            json!({ "type": "world_state", "payload": {} }),
            json!({ "type": "event_msg", "payload": { "type": "agent_message", "message": "uno" } }),
        ];
        let path = write_rollout(&root, "2026/09/27", ID, &lines[..3]);
        let before = read_records(&path, slim_record).unwrap();
        write_rollout(&root, "2026/09/27", ID, &lines);
        let after = read_records(&path, slim_record).unwrap();
        assert_eq!(after[..before.len()], before[..]);
        assert_eq!(after.len(), before.len() + 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn long_tool_output_is_capped() {
        let big = "x".repeat(MAX_TOOL_RESULT_CHARS * 2);
        let record = json!({ "type": "response_item", "payload": {
            "type": "function_call_output", "call_id": "c1", "output": big } });
        let slim = slim_record(record.as_object().unwrap().clone()).unwrap();
        let output = slim["payload"]["output"].as_str().unwrap();
        assert!(output.chars().count() <= MAX_TOOL_RESULT_CHARS + 1);
    }
}
