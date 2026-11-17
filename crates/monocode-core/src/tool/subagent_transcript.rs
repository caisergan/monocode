//! claudeSubagentTranscript.ts: Claude writes every subagent's conversation to
//! its own JSONL file and hands the path over as the task's `outputFile`. The
//! parent's stream mirrors the subagent's messages too, but with the usage each
//! one had when its first content block landed, so output counts there are a
//! fraction of the real ones. The file has every request's final usage, so it
//! is what a run's tokens are counted from and what its context view shows.
use super::{
    tasks::{AgentStep, AgentUsage},
    ToolCall, ToolState,
};
use crate::transcript::{Row, Transcript};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
};

/// The most of the conversation a context view holds on to.
const MAX_ENTRIES: usize = 600;
const MAX_TEXT: usize = 20_000;
const MAX_TOOL_OUTPUT: usize = 4_000;
/// How much one read takes in, so a huge file can't stall the provider thread.
const READ_CHUNK: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RequestUsage {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
}
impl RequestUsage {
    /// One request's usage from a mirrored assistant message.
    pub fn from_value(usage: &Value) -> Option<Self> {
        let usage = usage.as_object()?;
        let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        Some(Self {
            input: count("input_tokens"),
            cache_read: count("cache_read_input_tokens"),
            cache_write: count("cache_creation_input_tokens"),
            output: count("output_tokens"),
        })
    }
}

/// A request's records repeat its usage as it streams; keep the largest.
pub fn merge_request(requests: &mut HashMap<String, RequestUsage>, id: &str, next: RequestUsage) {
    let entry = requests.entry(id.to_owned()).or_default();
    entry.input = entry.input.max(next.input);
    entry.cache_read = entry.cache_read.max(next.cache_read);
    entry.cache_write = entry.cache_write.max(next.cache_write);
    entry.output = entry.output.max(next.output);
}

/// Every request's tokens, with the window as the latest one left it.
pub fn usage_from_requests(
    requests: &HashMap<String, RequestUsage>,
    last: Option<&str>,
) -> Option<AgentUsage> {
    if requests.is_empty() {
        return None;
    }
    let mut usage = AgentUsage::default();
    for request in requests.values() {
        usage.uncached += request.input + request.cache_write;
        usage.cache_read += request.cache_read;
        usage.cache_write += request.cache_write;
        usage.output += request.output;
    }
    usage.context_used = last
        .and_then(|id| requests.get(id))
        .map(|last| last.input + last.cache_read + last.cache_write + last.output);
    Some(usage)
}

enum Entry {
    Said { role: &'static str, text: String },
    Tool(Box<ToolCall>),
}

/// An incremental reader of one run's transcript file.
pub struct SubagentTranscript {
    path: PathBuf,
    offset: u64,
    requests: HashMap<String, RequestUsage>,
    last_request: Option<String>,
    model: Option<String>,
    /// The conversation itself, kept only by readers that show it.
    entries: Option<Vec<Entry>>,
    tools: HashMap<String, usize>,
    /// A live log names a result by its tool alone: the calls still waiting
    /// for theirs, oldest first, with where each sits in `entries`.
    open_calls: Vec<(String, usize)>,
    /// The summary a live log closes with: the opening of the run's reply.
    summary: Option<String>,
}

impl SubagentTranscript {
    /// A reader that counts tokens only.
    pub fn usage_only(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            offset: 0,
            requests: HashMap::new(),
            last_request: None,
            model: None,
            entries: None,
            tools: HashMap::new(),
            open_calls: Vec::new(),
            summary: None,
        }
    }
    /// A reader that also keeps the conversation, for the context view.
    pub fn conversation(path: impl Into<PathBuf>) -> Self {
        Self {
            entries: Some(Vec::new()),
            ..Self::usage_only(path)
        }
    }
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }
    pub fn usage(&self) -> Option<AgentUsage> {
        usage_from_requests(&self.requests, self.last_request.as_deref())
    }

    /// Read whatever the run has written since the last read. Returns true
    /// when anything new arrived; only whole lines are taken, so a line still
    /// being written is left for next time.
    pub fn read(&mut self) -> std::io::Result<bool> {
        // `outputFile` is a /tmp symlink into the session's own directory.
        if let Ok(path) = std::fs::canonicalize(&self.path) {
            self.path = path;
        }
        let mut file = std::fs::File::open(&self.path)?;
        let size = file.metadata()?.len();
        if size < self.offset {
            // The file was replaced; start it over rather than read past its end.
            self.reset();
        }
        let mut changed = false;
        while self.offset < size {
            file.seek(SeekFrom::Start(self.offset))?;
            let mut chunk = Vec::new();
            (&mut file).take(READ_CHUNK).read_to_end(&mut chunk)?;
            let Some(end) = chunk.iter().rposition(|byte| *byte == b'\n') else {
                // One line longer than a chunk is taken whole, or never ends.
                if chunk.len() as u64 == READ_CHUNK {
                    let mut rest = Vec::new();
                    file.read_to_end(&mut rest)?;
                    chunk.extend(rest);
                    if let Some(end) = chunk.iter().rposition(|byte| *byte == b'\n') {
                        changed |= self.feed(&chunk[..=end]);
                        self.offset += end as u64 + 1;
                        continue;
                    }
                }
                break;
            };
            changed |= self.feed(&chunk[..=end]);
            self.offset += end as u64 + 1;
        }
        Ok(changed)
    }

    fn reset(&mut self) {
        self.offset = 0;
        self.requests.clear();
        self.tools.clear();
        self.last_request = None;
        self.open_calls.clear();
        self.summary = None;
        if let Some(entries) = &mut self.entries {
            entries.clear();
        }
    }

    /// Take in complete lines: Claude's JSONL records, or the lines of a Hermes
    /// live log. Returns true when anything was recorded.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        let mut changed = false;
        for line in bytes.split(|byte| *byte == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Value>(line) else {
                if let Ok(text) = std::str::from_utf8(line) {
                    changed |= self.live_log_line(text);
                }
                continue;
            };
            match record["type"].as_str() {
                Some("assistant") => changed |= self.assistant(&record),
                Some("user") if record["isMeta"] != true => changed |= self.user(&record),
                _ => {}
            }
        }
        changed
    }

    /// One line of a Hermes subagent's live log, as its
    /// tools/delegation_live_log.py writes it: `HH:MM:SS role     | text`. The
    /// log is a preview of the run, not its record: every line is folded to
    /// one and cut short, and none of them carries a token count.
    fn live_log_line(&mut self, line: &str) -> bool {
        let Some((role, text)) = live_log_parts(line) else {
            return false;
        };
        let Some(entries) = &mut self.entries else {
            return false;
        };
        match role {
            "user" => {
                let brief = text.strip_prefix("kickoff:").map_or(text, str::trim);
                push(
                    entries,
                    Entry::Said {
                        role: "user",
                        text: capped(brief, MAX_TEXT),
                    },
                )
            }
            "think" => push(
                entries,
                Entry::Said {
                    role: "reasoning",
                    text: capped(text, MAX_TEXT),
                },
            ),
            "assistant" => {
                // A long reply is written a piece at a time, each cut short.
                if let Some(Entry::Said {
                    role: "assistant",
                    text: said,
                }) = entries.last_mut()
                {
                    if said.len() < MAX_TEXT {
                        *said = capped(&format!("{said}\n\n{text}"), MAX_TEXT);
                    }
                    true
                } else {
                    push(
                        entries,
                        Entry::Said {
                            role: "assistant",
                            text: capped(text, MAX_TEXT),
                        },
                    )
                }
            }
            "tool" => {
                let started = text.strip_prefix("->").map_or(text, str::trim);
                let (name, preview) = match started.split_once('(') {
                    Some((name, rest)) => (name.trim(), rest.strip_suffix(')').unwrap_or(rest)),
                    None => (started, ""),
                };
                let mut call = live_log_call(&format!("live-{}", entries.len()), name, preview);
                call.state = ToolState::Running;
                if !push(entries, Entry::Tool(Box::new(call))) {
                    return false;
                }
                self.open_calls.push((name.to_owned(), entries.len() - 1));
                true
            }
            "result" => {
                // `<tool> ok 0.4s: <result>`, or `ERROR` in place of `ok`.
                let (head, body) = text.split_once(": ").unwrap_or((text, ""));
                let mut head = head.split_whitespace();
                let name = head.next().unwrap_or("");
                let failed = head.next() == Some("ERROR");
                // Calls made together report back in any order.
                let waiting = self
                    .open_calls
                    .iter()
                    .position(|(open, _)| open == name)
                    .or((!self.open_calls.is_empty()).then_some(0));
                let Some(waiting) = waiting else {
                    return false;
                };
                let (_, index) = self.open_calls.remove(waiting);
                let Some(Entry::Tool(call)) = entries.get_mut(index) else {
                    return false;
                };
                call.state = if failed {
                    ToolState::Failed
                } else {
                    ToolState::Completed
                };
                call.output = capped(body, MAX_TOOL_OUTPUT);
                true
            }
            "final" => {
                // The run is over; a call still waiting never got its result.
                let mut changed = false;
                for (_, index) in self.open_calls.drain(..) {
                    if let Some(Entry::Tool(call)) = entries.get_mut(index) {
                        call.state = ToolState::Cancelled;
                        changed = true;
                    }
                }
                // `status=… duration=…s summary: …`, then `end status=… [error: …]`.
                let said = if text.starts_with("end ") {
                    text.split_once(" error: ").map(|(_, error)| error)
                } else {
                    let summary = text.split_once("summary: ").map(|(_, summary)| summary);
                    self.summary = summary
                        .map(str::trim)
                        .filter(|summary| !summary.is_empty())
                        .map(|summary| capped(summary, MAX_TEXT));
                    // It repeats the reply when the log already has that.
                    summary.filter(|_| {
                        !matches!(
                            entries.last(),
                            Some(Entry::Said {
                                role: "assistant",
                                ..
                            })
                        )
                    })
                };
                match said.map(str::trim).filter(|said| !said.is_empty()) {
                    Some(said) => {
                        push(
                            entries,
                            Entry::Said {
                                role: "assistant",
                                text: capped(said, MAX_TEXT),
                            },
                        ) || changed
                    }
                    None => changed,
                }
            }
            // `start` repeats the kickoff.
            _ => false,
        }
    }

    fn assistant(&mut self, record: &Value) -> bool {
        let message = &record["message"];
        if !message.is_object() {
            return false;
        }
        if let Some(model) = message["model"].as_str().filter(|m| *m != "<synthetic>") {
            self.model = Some(model.into());
        }
        let id = message["id"].as_str();
        let usage = RequestUsage::from_value(&message["usage"]);
        if let (Some(id), Some(usage)) = (id, usage) {
            merge_request(&mut self.requests, id, usage);
            self.last_request = Some(id.to_owned());
        }
        let Some(entries) = &mut self.entries else {
            return id.is_some() && usage.is_some();
        };
        for block in message["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("thinking") => {
                    if let Some(text) = trimmed(&block["thinking"]) {
                        push(
                            entries,
                            Entry::Said {
                                role: "reasoning",
                                text: capped(text, MAX_TEXT),
                            },
                        );
                    }
                }
                Some("text") => {
                    if let Some(text) = trimmed(&block["text"]) {
                        push(
                            entries,
                            Entry::Said {
                                role: "assistant",
                                text: capped(text, MAX_TEXT),
                            },
                        );
                    }
                }
                Some("tool_use") => {
                    let Some(id) = block["id"].as_str() else {
                        continue;
                    };
                    if self.tools.contains_key(id) {
                        continue;
                    }
                    let mut call = ToolCall::new(id, block["name"].as_str().unwrap_or("Tool"));
                    call.input = block["input"].to_string();
                    if push(entries, Entry::Tool(Box::new(call))) {
                        self.tools.insert(id.to_owned(), entries.len() - 1);
                    }
                }
                _ => {}
            }
        }
        true
    }

    fn user(&mut self, record: &Value) -> bool {
        let Some(entries) = &mut self.entries else {
            return false;
        };
        let content = &record["message"]["content"];
        let mut changed = false;
        let said = content.as_str().map(str::to_owned).unwrap_or_else(|| {
            content
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        });
        if !said.trim().is_empty() {
            // The first thing a run is told is the brief its parent wrote.
            changed |= push(
                entries,
                Entry::Said {
                    role: "user",
                    text: capped(said.trim(), MAX_TEXT),
                },
            );
        }
        for part in content.as_array().into_iter().flatten() {
            if part["type"] != "tool_result" {
                continue;
            }
            let Some(index) = part["tool_use_id"]
                .as_str()
                .and_then(|id| self.tools.get(id))
            else {
                continue;
            };
            let Some(Entry::Tool(call)) = entries.get_mut(*index) else {
                continue;
            };
            call.state = if part["is_error"] == true {
                ToolState::Failed
            } else {
                ToolState::Completed
            };
            call.output = capped(result_text(&part["content"]).trim(), MAX_TOOL_OUTPUT);
            changed = true;
        }
        changed
    }

    /// The conversation as transcript rows, for a transcript view to show.
    pub fn rows(&self) -> Vec<Row> {
        let mut transcript = Transcript::default();
        for entry in self.entries.iter().flatten() {
            match entry {
                Entry::Said { role, text } => {
                    transcript.begin(role);
                    transcript.append(text);
                }
                Entry::Tool(call) => {
                    transcript.begin("tool");
                    transcript.append(&serde_json::to_string(call).unwrap_or_default());
                }
            }
        }
        transcript.rows
    }

    /// What the run thought and called, as steps of its trail.
    pub fn steps(&self) -> Vec<AgentStep> {
        self.entries
            .iter()
            .flatten()
            .enumerate()
            .filter_map(|(at, entry)| match entry {
                Entry::Said {
                    role: "reasoning",
                    text,
                } => Some(AgentStep {
                    id: format!("live-thought-{at}"),
                    kind: "thinking".into(),
                    text: text.clone(),
                    ..AgentStep::default()
                }),
                Entry::Tool(call) => Some(AgentStep::from_tool_call(call)),
                Entry::Said { .. } => None,
            })
            .collect()
    }

    /// What the run has to say for itself: the summary its log closed with,
    /// or the latest thing it said while it is still going. A long reply is
    /// logged in pieces, so its last piece alone is seldom its point.
    pub fn reply(&self) -> Option<&str> {
        self.summary.as_deref().or_else(|| {
            self.entries
                .iter()
                .flatten()
                .rev()
                .find_map(|entry| match entry {
                    Entry::Said {
                        role: "assistant",
                        text,
                    } if !text.trim().is_empty() => Some(text.as_str()),
                    _ => None,
                })
        })
    }
}

/// The role and text of a live log line, or nothing for its header lines.
fn live_log_parts(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_end();
    let bytes = line.as_bytes();
    let clocked = bytes.len() > 9
        && bytes[8] == b' '
        && bytes[..8].iter().enumerate().all(|(at, byte)| {
            if at == 2 || at == 5 {
                *byte == b':'
            } else {
                byte.is_ascii_digit()
            }
        });
    if !clocked {
        return None;
    }
    let (role, text) = line[9..].split_once('|')?;
    let text = text.trim();
    (!text.is_empty()).then_some((role.trim(), text))
}

/// A call as the live log names it, `tool(preview)`, as the tool row it is.
/// The preview is Hermes's own short form of the arguments, not the arguments.
fn live_log_call(id: &str, name: &str, preview: &str) -> ToolCall {
    let preview = preview.trim();
    let (native, input) = match name {
        "terminal" | "process" => ("Bash", serde_json::json!({ "command": preview })),
        "read_file" => {
            // `PROGRESS.md L1557-1856`: the lines read follow the path.
            let path = preview
                .rsplit_once(" L")
                .filter(|(_, lines)| {
                    !lines.is_empty() && lines.bytes().all(|b| b.is_ascii_digit() || b == b'-')
                })
                .map_or(preview, |(path, _)| path);
            ("Read", serde_json::json!({ "file_path": path }))
        }
        "write_file" => ("Write", serde_json::json!({ "file_path": preview })),
        "patch" => ("Edit", serde_json::json!({ "file_path": preview })),
        "search_files" => ("Grep", serde_json::json!({ "pattern": preview })),
        "web_search" => ("WebSearch", serde_json::json!({ "query": preview })),
        "web_extract" | "browser_navigate" => ("WebFetch", serde_json::json!({ "url": preview })),
        _ => (name, Value::Null),
    };
    let mut call = ToolCall::new(id, if native.is_empty() { "Tool" } else { native });
    if !input.is_null() {
        call.input = input.to_string();
    }
    call.display = Some(serde_json::json!({
        "title": if preview.is_empty() {
            name.to_owned()
        } else {
            format!("{name}: {preview}")
        },
    }));
    call
}

fn push(entries: &mut Vec<Entry>, entry: Entry) -> bool {
    if entries.len() >= MAX_ENTRIES {
        return false;
    }
    entries.push(entry);
    true
}

fn trimmed(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn capped(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut at = limit;
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    format!("{}…", &text[..at])
}

fn result_text(content: &Value) -> String {
    content.as_str().map(str::to_owned).unwrap_or_else(|| {
        content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(value: Value) -> String {
        format!("{value}\n")
    }

    #[test]
    fn requests_keep_their_largest_usage_and_the_window_follows_the_last() {
        let mut transcript = SubagentTranscript::usage_only("/nowhere");
        let request = |id: &str, output: u64| {
            line(
                json!({"type":"assistant","message":{"id":id,"model":"claude-haiku-5-5",
                "usage":{"input_tokens":10,"cache_read_input_tokens":100,
                         "cache_creation_input_tokens":20,"output_tokens":output},
                "content":[]}}),
            )
        };
        let text = request("a", 5) + &request("a", 188) + &request("b", 7);
        assert!(transcript.feed(text.as_bytes()));
        let usage = transcript.usage().unwrap();
        assert_eq!(usage.uncached, 60);
        assert_eq!(usage.cache_read, 200);
        assert_eq!(usage.cache_write, 40);
        assert_eq!(usage.output, 195);
        assert_eq!(usage.context_used, Some(137));
        assert_eq!(transcript.model(), Some("claude-haiku-5-5"));
    }

    #[test]
    fn the_conversation_reads_as_rows_with_tools_settled_by_their_results() {
        let mut transcript = SubagentTranscript::conversation("/nowhere");
        let text = line(json!({"type":"user","message":{"content":"Review the diff"}}))
            + &line(json!({"type":"user","isMeta":true,"message":{"content":"hidden"}}))
            + &line(json!({"type":"assistant","message":{"id":"m","content":[
                {"type":"thinking","thinking":"Plan"},
                {"type":"text","text":"Looking"},
                {"type":"tool_use","id":"t","name":"Read","input":{"file_path":"a.rs"}}]}}))
            + &line(json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"t","content":[{"type":"text","text":"body"}]}]}}));
        transcript.feed(text.as_bytes());
        let rows = transcript.rows();
        let roles: Vec<_> = rows.iter().map(|row| row.role.as_str()).collect();
        assert_eq!(roles, ["user", "reasoning", "assistant", "tool"]);
        assert_eq!(rows[0].text, "Review the diff");
        let call: ToolCall = serde_json::from_str(&rows[3].text).unwrap();
        assert_eq!(call.state, ToolState::Completed);
        assert_eq!(call.output, "body");
    }

    #[test]
    fn reading_takes_whole_lines_and_starts_over_when_the_file_is_replaced() {
        let dir = std::env::temp_dir().join(format!(
            "subagent-transcript-{}-{}",
            std::process::id(),
            crate::time::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.jsonl");
        let request = |id: &str| {
            line(json!({"type":"assistant","message":{"id":id,
                "usage":{"input_tokens":1,"output_tokens":1},"content":[]}}))
        };
        let first = request("a");
        std::fs::write(&path, format!("{first}{{\"type\":\"assis")).unwrap();
        let mut transcript = SubagentTranscript::usage_only(&path);
        assert!(transcript.read().unwrap());
        assert_eq!(transcript.usage().unwrap().output, 1);
        assert!(!transcript.read().unwrap(), "the partial line waits");

        std::fs::write(&path, first.clone() + &request("b")).unwrap();
        assert!(transcript.read().unwrap());
        assert_eq!(transcript.usage().unwrap().output, 2);

        std::fs::write(&path, "\n").unwrap();
        transcript.read().unwrap();
        assert!(transcript.usage().is_none(), "a replaced file starts over");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The lines are the ones Hermes 0.23's tools/delegation_live_log.py writes.
    #[test]
    fn a_hermes_live_log_reads_as_the_runs_conversation() {
        let mut transcript = SubagentTranscript::conversation("/nowhere/task-0.log");
        let log = "\
=== Hermes subagent live transcript ===
delegation: deleg_e2310619   task: 0
goal: Audit the provider
started: 2026-11-10 01:26:07
(append-only; streams while the subagent runs — tail -f me)
========================================
01:26:07 user     | kickoff: Audit the provider | context: Only read.
01:26:07 start    | Audit the provider
01:26:12 think    | Reading the adapter first
01:26:13 tool     | -> read_file(PLAN.md)
01:26:13 tool     | -> read_file(PROGRESS.md L1557-1856)
01:26:13 tool     | -> terminal(git log --oneline -30 + 3 commands)
01:26:14 result   | terminal ok 0.3s: {\"output\": \"e9f7fe1 Record Step 9\"}
01:26:14 result   | read_file ok 0.0s: {\"content\": \"1|# Plan\"}
01:26:14 result   | read_file ERROR 0.0s: File not found: PROGRESS.md
01:26:15 tool     | -> skill_view(senior-agentic-engineer)
01:26:20 assistant| The adapter is sound.
01:26:21 assistant| Two tests are missing.
01:26:21 final    | status=completed duration=14.2s summary: The adapter is sound.
01:26:21 final    | end status=completed exit_reason=completed
";
        assert!(transcript.feed(log.as_bytes()));
        assert!(transcript.usage().is_none(), "a live log counts no tokens");
        assert!(transcript.model().is_none());
        let rows = transcript.rows();
        let roles: Vec<_> = rows.iter().map(|row| row.role.as_str()).collect();
        assert_eq!(
            roles,
            [
                "user",
                "reasoning",
                "tool",
                "tool",
                "tool",
                "tool",
                "assistant"
            ]
        );
        assert_eq!(rows[0].text, "Audit the provider | context: Only read.");
        let calls: Vec<ToolCall> = rows
            .iter()
            .filter(|row| row.role == "tool")
            .map(|row| serde_json::from_str(&row.text).unwrap())
            .collect();
        // Calls made together are matched to their own results, in any order.
        assert_eq!(
            (calls[0].name.as_str(), &calls[0].state),
            ("Read", &ToolState::Completed)
        );
        assert_eq!(calls[0].output, "{\"content\": \"1|# Plan\"}");
        assert_eq!(calls[1].state, ToolState::Failed);
        assert_eq!(calls[1].output, "File not found: PROGRESS.md");
        assert!(
            calls[1].input.contains("\"PROGRESS.md\""),
            "{}",
            calls[1].input
        );
        assert_eq!(calls[2].name, "Bash");
        assert_eq!(calls[2].state, ToolState::Completed);
        assert!(calls[2].input.contains("git log --oneline -30"));
        // A call with no result by the end was never answered.
        assert_eq!(calls[3].name, "skill_view");
        assert_eq!(calls[3].state, ToolState::Cancelled);
        // The reply's pieces are one message, and the summary does not repeat
        // it as another: it is what the run has to say for itself.
        assert_eq!(
            rows.last().unwrap().text,
            "The adapter is sound.\n\nTwo tests are missing."
        );
        assert_eq!(transcript.reply(), Some("The adapter is sound."));
        let steps = transcript.steps();
        assert_eq!(steps.len(), 5);
        assert_eq!(steps[0].kind, "thinking");
        assert_eq!(steps[0].text, "Reading the adapter first");
        assert_eq!(steps[3].state, Some(ToolState::Completed));
        assert_eq!(steps[3].to_tool_call().name, "Bash");
    }

    #[test]
    fn a_live_log_that_ends_in_an_error_says_so() {
        let mut transcript = SubagentTranscript::conversation("/nowhere/task-1.log");
        let log = "\
02:00:00 user     | kickoff: Fix it
02:00:05 final    | status=failed duration=5.0s
02:00:05 final    | end status=failed exit_reason=error error: provider refused the request
";
        assert!(transcript.feed(log.as_bytes()));
        assert_eq!(transcript.reply(), Some("provider refused the request"));
        // Lines that are not log lines are left alone.
        assert!(!transcript.feed(b"not a log line\n12:00 | nor this\n"));
    }
}
