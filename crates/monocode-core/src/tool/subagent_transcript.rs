//! claudeSubagentTranscript.ts: Claude writes every subagent's conversation to
//! its own JSONL file and hands the path over as the task's `outputFile`. The
//! parent's stream mirrors the subagent's messages too, but with the usage each
//! one had when its first content block landed, so output counts there are a
//! fraction of the real ones. The file has every request's final usage, so it
//! is what a run's tokens are counted from and what its context view shows.
use super::{tasks::AgentUsage, ToolCall, ToolState};
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
        if let Some(entries) = &mut self.entries {
            entries.clear();
        }
    }

    /// Take in complete JSONL lines. Returns true when anything was recorded.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        let mut changed = false;
        for line in bytes.split(|byte| *byte == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Value>(line) else {
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
}
