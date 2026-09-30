//! Pi and its fork omp (oh-my-pi) write the same session format: one JSONL
//! file per session, `<sessions>/<folder>/<timestamp>_<uuid>.jsonl`. A
//! `session` header carries the id and cwd; every later entry links to its
//! parent through `id`/`parentId`, so rewinds branch inside one file.
//!
//! - Pi: `~/.pi/agent/sessions`, or `$PI_CODING_AGENT_DIR/sessions`, or
//!   `$PI_CODING_AGENT_SESSION_DIR`. Folders are the cwd as `--a-b-c--`.
//! - omp: `~/.omp/agent/sessions` (`~/$PI_CONFIG_DIR/agent/sessions`).
//!   Folders are home-relative (`-Desktop-app`), and each file starts with a
//!   padded title line. Subagent transcripts live one level deeper, in a
//!   folder named after the session, and are not listed.
//!
//! Folder names are only read, never decoded: each file's header has the cwd.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::{
    non_empty_str, prompt_preview, scan_ends, subdirs, truncate_chars, truncate_strings, Candidate,
    Harness, SummaryScan, TranscriptInfo, MAX_TOOL_INPUT_CHARS, MAX_TOOL_RESULT_CHARS,
};
use crate::dirs_home;

/// Entries the importer replays. Every other entry becomes a link stub, so
/// the `parentId` chain still reaches the entries around it.
const KEPT_ENTRY_TYPES: &[&str] = &[
    "session",
    "message",
    "compaction",
    "branch_summary",
    "session_info",
    "title",
    "title_change",
    "model_change",
    "thinking_level_change",
];

const LINK_KEYS: &[&str] = &["type", "id", "parentId"];

/// Message fields the importer reads; provider payloads, encrypted reasoning
/// and context snapshots are dropped.
const KEPT_MESSAGE_KEYS: &[&str] = &[
    "role",
    "content",
    "model",
    "provider",
    "stopReason",
    "errorMessage",
    "usage",
    "timestamp",
    "toolCallId",
    "toolName",
    "details",
    "isError",
];

/// Tools whose results carry subagent runs in `details` (`toolKindFromName`
/// "agent" in the TypeScript importer).
const SUBAGENT_TOOLS: &[&str] = &["task", "agent", "subagent"];
const SUBAGENT_DETAIL_KEYS: &[&str] = &["results", "progress", "async"];

fn env_path(name: &str) -> Option<PathBuf> {
    let value = std::env::var(name).ok()?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(match value.strip_prefix("~/") {
        Some(rest) => PathBuf::from(dirs_home()?).join(rest),
        None => PathBuf::from(value),
    })
}

pub(super) fn root(harness: Harness) -> Option<PathBuf> {
    let root = match harness {
        Harness::Pi => env_path("PI_CODING_AGENT_SESSION_DIR").or_else(|| {
            env_path("PI_CODING_AGENT_DIR")
                .or_else(|| dirs_home().map(|home| Path::new(&home).join(".pi/agent")))
                .map(|agent| agent.join("sessions"))
        })?,
        Harness::Omp => {
            let config = std::env::var("PI_CONFIG_DIR")
                .ok()
                .filter(|dir| !dir.trim().is_empty())
                .unwrap_or_else(|| ".omp".into());
            Path::new(&dirs_home()?)
                .join(config)
                .join("agent")
                .join("sessions")
        }
        Harness::Claude | Harness::Codex => return None,
    };
    root.is_dir().then_some(root)
}

/// The session id in a transcript file name, `<timestamp>_<uuid>.jsonl`.
fn session_id_of(path: &Path) -> Option<&str> {
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let (_, id) = stem.rsplit_once('_')?;
    Some(id)
}

/// Session files: one level down in per-folder directories, or directly in
/// the root when a custom session dir is flat.
fn session_files(root: &Path) -> impl Iterator<Item = PathBuf> {
    std::iter::once(root.to_path_buf())
        .chain(subdirs(root))
        .flat_map(|dir| {
            std::fs::read_dir(dir)
                .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
                .unwrap_or_else(|_| Vec::new())
        })
        .filter(|path| path.is_file() && session_id_of(path).is_some())
}

pub(super) fn candidates(harness: Harness, root: &Path) -> Vec<Candidate> {
    session_files(root)
        .filter_map(|path| {
            let id = session_id_of(&path)?.to_string();
            Candidate::new(harness, path, &id)
        })
        .collect()
}

pub(super) fn find(root: &Path, session_id: &str) -> Option<PathBuf> {
    session_files(root).find(|path| session_id_of(path) == Some(session_id))
}

pub(super) fn transcript_info(candidate: &Candidate) -> Option<TranscriptInfo> {
    let scan = scan_ends::<PiScan>(candidate)?;
    Some(TranscriptInfo {
        cwd: scan.cwd?,
        title: scan.title.or(scan.title_slot),
        first_prompt: scan.first_prompt?,
        last_prompt: scan.last_prompt?,
        git_branch: None,
    })
}

#[derive(Default)]
struct PiScan {
    cwd: Option<String>,
    /// omp's first line, rewritten in place when the title changes.
    title_slot: Option<String>,
    /// The latest `/name` (Pi) or title change (omp).
    title: Option<String>,
    first_prompt: Option<String>,
    last_prompt: Option<String>,
    tail_prompt: bool,
}

impl SummaryScan for PiScan {
    fn tail_prompt(&self) -> bool {
        self.tail_prompt
    }

    fn visit(&mut self, line: &str, in_tail: bool) {
        let kind = if line.contains("\"type\":\"message\"") {
            // Tool results and replies are most of a transcript; only user
            // turns are parsed.
            if !line.contains("\"role\":\"user\"") {
                return;
            }
            "message"
        } else if line.contains("\"type\":\"session\"") {
            "session"
        } else if line.contains("\"type\":\"title\"") {
            "title"
        } else if line.contains("\"type\":\"title_change\"") {
            "title_change"
        } else if line.contains("\"type\":\"session_info\"") {
            "session_info"
        } else {
            return;
        };
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if record.get("type").and_then(Value::as_str) != Some(kind) {
            return;
        }
        match kind {
            "session" => {
                if self.cwd.is_none() {
                    self.cwd = non_empty_str(&record, "cwd");
                }
            }
            "title" => self.title_slot = non_empty_str(&record, "title"),
            "title_change" => {
                if let Some(title) = non_empty_str(&record, "title") {
                    self.title = Some(title);
                }
            }
            "session_info" => {
                if let Some(name) = non_empty_str(&record, "name") {
                    self.title = Some(name);
                }
            }
            _ => {
                let Some(message) = record.get("message") else {
                    return;
                };
                if message.get("role").and_then(Value::as_str) != Some("user") {
                    return;
                }
                let Some(prompt) = user_prompt_text(message) else {
                    return;
                };
                let preview = prompt_preview(&prompt);
                if self.first_prompt.is_none() {
                    self.first_prompt = Some(preview.clone());
                }
                self.last_prompt = Some(preview);
                self.tail_prompt = in_tail;
            }
        }
    }
}

/// The text of a user message. Keep in step with the TypeScript importer's
/// prompt rule so a row's preview matches the chat it opens.
fn user_prompt_text(message: &Value) -> Option<String> {
    let text = match message.get("content")? {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

pub(super) fn slim_record(record: Map<String, Value>) -> Option<Map<String, Value>> {
    let kind = record.get("type").and_then(Value::as_str)?;
    if !KEPT_ENTRY_TYPES.contains(&kind) {
        record.get("id")?;
        return Some(
            record
                .into_iter()
                .filter(|(key, _)| LINK_KEYS.contains(&key.as_str()))
                .collect(),
        );
    }
    let mut slim = record;
    // Compaction bookkeeping (file lists, preserved provider state) is large
    // and the transcript only notes that a compaction happened.
    slim.remove("details");
    slim.remove("preserveData");
    slim.remove("pad");
    if let Some(Value::String(summary)) = slim.get_mut("summary") {
        *summary = truncate_chars(summary, MAX_TOOL_RESULT_CHARS);
    }
    if let Some(Value::Object(message)) = slim.get_mut("message") {
        slim_message(message);
    }
    Some(slim)
}

fn slim_message(message: &mut Map<String, Value>) {
    message.retain(|key, _| KEPT_MESSAGE_KEYS.contains(&key.as_str()));
    let tool_result = message.get("role").and_then(Value::as_str) == Some("toolResult");
    if let Some(Value::Array(blocks)) = message.get_mut("content") {
        for block in blocks.iter_mut() {
            slim_content_block(block, tool_result);
        }
    }
    // Only a subagent tool's details become rows (its runs and their
    // reports); every other tool's details repeat what its output says.
    let subagent = message
        .get("toolName")
        .and_then(Value::as_str)
        .is_some_and(|name| SUBAGENT_TOOLS.contains(&name.to_ascii_lowercase().as_str()));
    if !subagent {
        message.remove("details");
    } else if let Some(Value::Object(details)) = message.get_mut("details") {
        details.retain(|key, _| SUBAGENT_DETAIL_KEYS.contains(&key.as_str()));
        for value in details.values_mut() {
            truncate_strings(value, MAX_TOOL_RESULT_CHARS);
        }
    }
}

fn slim_content_block(block: &mut Value, tool_result: bool) {
    let Some(object) = block.as_object_mut() else {
        return;
    };
    match object.get("type").and_then(Value::as_str) {
        // Inline image payloads are megabytes of base64 (omp stores a blob
        // reference) the transcript cannot show.
        Some("image") => {
            object.remove("data");
        }
        Some("thinking") => {
            object.remove("thinkingSignature");
        }
        Some("toolCall") => {
            if let Some(arguments) = object.get_mut("arguments") {
                truncate_strings(arguments, MAX_TOOL_INPUT_CHARS);
            }
        }
        Some("text") if tool_result => {
            if let Some(Value::String(text)) = object.get_mut("text") {
                *text = truncate_chars(text, MAX_TOOL_RESULT_CHARS);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{known_for, list, set_mtime, temp_root};
    use super::super::{read_records, AgentSessionQuery, Known, SessionFolder, Source};
    use super::*;
    use crate::session_store::KnownSession;
    use serde_json::json;
    use std::io::Write;

    const ID: &str = "01a02bd1-6b43-7b70-a1c8-e63521ccf32b";

    fn write(path: &Path, records: &[Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = std::fs::File::create(path).unwrap();
        for record in records {
            writeln!(file, "{record}").unwrap();
        }
    }

    fn header(id: &str, cwd: &str) -> Value {
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-08-22T23:32:19.907Z", "cwd": cwd })
    }

    fn message(id: &str, parent: &str, message: Value) -> Value {
        json!({ "type": "message", "id": id, "parentId": parent, "timestamp": "2026-08-22T23:32:28.974Z", "message": message })
    }

    fn user(id: &str, parent: &str, text: &str) -> Value {
        message(
            id,
            parent,
            json!({ "role": "user", "content": [{ "type": "text", "text": text }] }),
        )
    }

    fn source(harness: Harness, root: &Path) -> [Source; 1] {
        [Source {
            harness,
            root: root.to_path_buf(),
        }]
    }

    #[test]
    fn lists_pi_sessions_with_prompts_and_session_names() {
        let root = temp_root("pi-list");
        let cwd = root.join("app");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.to_str().unwrap();
        let file = root
            .join("sessions/--app--")
            .join(format!("2026-08-22T23-32-19-907Z_{ID}.jsonl"));
        write(
            &file,
            &[
                header(ID, cwd),
                json!({ "type": "model_change", "id": "m1", "parentId": null, "provider": "openai-codex", "modelId": "gpt-5.6-sol" }),
                user("u1", "m1", "fix the build"),
                message(
                    "t1",
                    "u1",
                    json!({ "role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{ "type": "text", "text": "\"role\":\"user\"" }] }),
                ),
                user("u2", "t1", "and add tests"),
                json!({ "type": "session_info", "id": "i1", "parentId": "u2", "name": "Build fixes" }),
            ],
        );
        // Not a session file name.
        write(
            &root.join("sessions/--app--/notes.jsonl"),
            &[header("x", cwd)],
        );

        let sessions_root = root.join("sessions");
        let listing = list(
            &source(Harness::Pi, &sessions_root),
            &AgentSessionQuery::default(),
            &Known::new(),
            None,
        );
        assert_eq!(listing.sessions.len(), 1);
        let session = &listing.sessions[0];
        assert_eq!(session.harness, Harness::Pi);
        assert_eq!(session.id, ID);
        assert_eq!(session.cwd, cwd);
        assert_eq!(session.title.as_deref(), Some("Build fixes"));
        assert_eq!(session.first_prompt, "fix the build");
        assert_eq!(session.last_prompt, "and add tests");
        assert_eq!(session.folder, SessionFolder::Ok);
        assert_eq!(find(&sessions_root, ID), Some(file));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn omp_titles_and_subagent_transcripts() {
        let root = temp_root("omp-list");
        let dir = root.join("-Desktop-app");
        let stem = format!("2026-09-15T16-05-04-818Z_{ID}");
        write(
            &dir.join(format!("{stem}.jsonl")),
            &[
                json!({ "type": "title", "v": 1, "title": "Slot title", "pad": "   " }),
                header(ID, "/work/app"),
                user("u1", "h", "map the network code"),
                json!({ "type": "title_change", "id": "c1", "parentId": "u1", "title": "Network audit", "source": "auto" }),
            ],
        );
        // A subagent's transcript, in the session's artifact folder.
        write(
            &dir.join(&stem).join("Scout.jsonl"),
            &[header("sub", "/work/app"), user("s1", "h", "subtask")],
        );
        set_mtime(&dir.join(format!("{stem}.jsonl")), 100);

        let known = known_for(Harness::Omp, [("other", KnownSession::new("m", "/w"))]);
        let listing = list(
            &source(Harness::Omp, &root),
            &AgentSessionQuery::default(),
            &known,
            None,
        );
        assert_eq!(listing.sessions.len(), 1);
        assert_eq!(listing.sessions[0].harness, Harness::Omp);
        assert_eq!(listing.sessions[0].title.as_deref(), Some("Network audit"));
        assert_eq!(listing.sessions[0].folder, SessionFolder::Missing);

        let known = known_for(Harness::Omp, [(ID, KnownSession::new("m", "/work/app"))]);
        let listing = list(
            &source(Harness::Omp, &root),
            &AgentSessionQuery::default(),
            &known,
            None,
        );
        assert!(listing.sessions.is_empty());
        assert_eq!(listing.imported_count, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_slims_payloads_and_keeps_the_parent_chain() {
        let root = temp_root("pi-read");
        let file = root.join(format!("2026_{ID}.jsonl"));
        let long = "x".repeat(MAX_TOOL_RESULT_CHARS + 10);
        write(
            &file,
            &[
                header(ID, "/w"),
                json!({ "type": "custom", "id": "x1", "parentId": null, "customType": "tool_execution_start", "data": { "big": "payload" } }),
                message(
                    "a1",
                    "x1",
                    json!({
                        "role": "assistant",
                        "content": [
                            { "type": "thinking", "thinking": "plan", "thinkingSignature": "secret" },
                            { "type": "toolCall", "id": "c1", "name": "write", "arguments": { "path": "/w/a", "content": long } },
                        ],
                        "provider": "openai-codex", "model": "gpt-5.6-sol", "stopReason": "toolUse",
                        "contextSnapshot": { "huge": true }, "responseId": "r",
                    }),
                ),
                message(
                    "t1",
                    "a1",
                    json!({
                        "role": "toolResult", "toolCallId": "c1", "toolName": "read", "isError": false,
                        "content": [{ "type": "text", "text": long }, { "type": "image", "data": "AAAA", "mimeType": "image/png" }],
                        "details": { "diff": "big" },
                    }),
                ),
                json!({ "type": "compaction", "id": "k1", "parentId": "t1", "summary": "Earlier work", "details": { "readFiles": ["a"] } }),
            ],
        );
        let records = read_records(&file, slim_record).unwrap();
        assert_eq!(records.len(), 5);
        assert_eq!(
            records[1],
            json!({ "type": "custom", "id": "x1", "parentId": null })
        );
        let assistant = &records[2]["message"];
        assert!(assistant.get("contextSnapshot").is_none());
        assert!(assistant["content"][0].get("thinkingSignature").is_none());
        let written = assistant["content"][1]["arguments"]["content"]
            .as_str()
            .unwrap();
        assert_eq!(written.chars().count(), MAX_TOOL_INPUT_CHARS + 1);
        let result = &records[3]["message"]["content"];
        assert_eq!(
            result[0]["text"].as_str().unwrap().chars().count(),
            MAX_TOOL_RESULT_CHARS + 1
        );
        assert!(result[1].get("data").is_none());
        assert!(records[3]["message"].get("details").is_none());
        assert!(records[4].get("details").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn roots_follow_the_documented_overrides() {
        assert_eq!(
            session_id_of(Path::new(&format!(
                "/s/2026-08-22T23-32-19-907Z_{ID}.jsonl"
            ))),
            Some(ID)
        );
        assert_eq!(session_id_of(Path::new("/s/Scout.jsonl")), None);
        assert_eq!(root(Harness::Claude), None);
    }
}
