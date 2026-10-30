//! claudeImport.ts / piImport.ts: an agent's slimmed transcript as native
//! transcript rows, so an imported chat renders like one that ran here.
use crate::tool::{ToolCall, ToolState};
use crate::transcript::{Row, Transcript};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use super::Harness;

/// What an import shows: its rows, the title the agent gave the chat, and
/// the model its last reply came from.
#[derive(Debug, Default)]
pub struct Imported {
    pub rows: Vec<Row>,
    pub title: Option<String>,
    pub model: Option<String>,
}

pub fn rows(harness: Harness, records: &[Value]) -> Imported {
    match harness {
        Harness::Claude => claude(records),
        Harness::Pi | Harness::Omp => pi(records),
        Harness::Codex => Imported::default(),
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}

/// Records on the current branch, oldest first, walked back from the last
/// record by `parent` (or `logical` after a compaction).
fn chain<'a>(
    records: &'a [Value],
    id: &str,
    parents: &[&str],
    leaf: impl Fn(&Value) -> bool,
) -> Vec<&'a Value> {
    let mut by_id = HashMap::new();
    let mut last = None;
    for record in records {
        if let Some(key) = record[id].as_str() {
            by_id.insert(key, record);
            if leaf(record) {
                last = Some(record);
            }
        }
    }
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current = last;
    while let Some(record) = current {
        let Some(key) = record[id].as_str() else {
            break;
        };
        if !seen.insert(key) {
            break;
        }
        chain.push(record);
        current = parents
            .iter()
            .find_map(|parent| record[*parent].as_str())
            .and_then(|parent| by_id.get(parent).copied());
    }
    chain.reverse();
    chain
}

struct Builder {
    transcript: Transcript,
    /// Tool rows by call id, so a result fills in its call.
    tools: HashMap<String, usize>,
    in_turn: bool,
}
impl Builder {
    fn new() -> Self {
        Self {
            transcript: Transcript::default(),
            tools: HashMap::new(),
            in_turn: false,
        }
    }
    fn message(&mut self, role: &str, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        self.transcript.begin(role);
        self.transcript.append(text);
    }
    fn prompt(&mut self, text: &str, images: usize) {
        let text = if images > 0 && text.is_empty() {
            format!("[{images} image{}]", if images == 1 { "" } else { "s" })
        } else {
            text.to_owned()
        };
        self.message("user", &text);
        self.in_turn = true;
    }
    fn tool(&mut self, id: &str, name: &str, input: &Value) {
        let mut call = ToolCall::new(id, name);
        call.input = input.to_string();
        // Its result may never have been written; it ran in another app.
        call.state = ToolState::Completed;
        let at = self.transcript.begin("tool");
        self.transcript.rows[at].text = serde_json::to_string(&call).unwrap_or_default();
        self.tools.insert(id.to_owned(), at);
    }
    fn result(&mut self, id: &str, output: &str, failed: bool) {
        let Some(&at) = self.tools.get(id) else {
            return;
        };
        let Ok(mut call) = serde_json::from_str::<ToolCall>(&self.transcript.rows[at].text) else {
            return;
        };
        call.output = output.to_owned();
        call.bound_output();
        call.state = if failed {
            ToolState::Failed
        } else {
            ToolState::Completed
        };
        self.transcript.rows[at].text = serde_json::to_string(&call).unwrap_or_default();
    }
}

fn tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim())
}

/// classifyClaudeUserRecord: a prompt (with its image count), or nothing to show.
fn claude_prompt(record: &Value) -> Option<(String, usize)> {
    if record["isMeta"] == true || record["isCompactSummary"] == true {
        return None;
    }
    let content = &record["message"]["content"];
    let mut images = 0;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => {
            let mut parts = Vec::new();
            for block in blocks {
                match block["type"].as_str() {
                    Some("tool_result") => return None,
                    Some("image") => images += 1,
                    Some("text") => parts.extend(block["text"].as_str()),
                    _ => {}
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    };
    let trimmed = text.trim();
    if trimmed.starts_with("[Request interrupted")
        || trimmed.starts_with("<local-command-")
        || trimmed.starts_with("<task-notification>")
        || trimmed.starts_with("<system-reminder>")
    {
        return None;
    }
    // Only a record that starts with the wrapper is a slash command.
    if trimmed.starts_with("<command-") {
        if let Some(command) = tag(trimmed, "command-name") {
            return Some((
                match tag(trimmed, "command-args").filter(|args| !args.is_empty()) {
                    Some(args) => format!("{command} {args}"),
                    None => command.to_owned(),
                },
                0,
            ));
        }
    }
    (!trimmed.is_empty() || images > 0).then(|| (trimmed.to_owned(), images))
}

fn claude(records: &[Value]) -> Imported {
    let chain = chain(records, "uuid", &["parentUuid", "logicalParentUuid"], |r| {
        matches!(r["type"].as_str(), Some("user" | "assistant")) && r["isSidechain"] != true
    });
    let mut build = Builder::new();
    let mut model = None;
    for record in &chain {
        match record["type"].as_str() {
            Some("user") => {
                if let Some(blocks) = record["message"]["content"].as_array() {
                    for block in blocks.iter().filter(|b| b["type"] == "tool_result") {
                        if let Some(id) = block["tool_use_id"].as_str() {
                            let output = block["content"].as_str().unwrap_or_default();
                            build.result(id, output, block["is_error"] == true);
                        }
                    }
                }
                if let Some((text, images)) = claude_prompt(record) {
                    build.prompt(&text, images);
                }
            }
            Some("assistant") if build.in_turn => {
                let message = &record["message"];
                if let Some(id) = message["model"].as_str().filter(|m| !m.starts_with('<')) {
                    model = Some(id.to_owned());
                }
                for block in message["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => {
                            build.message("assistant", block["text"].as_str().unwrap_or(""))
                        }
                        Some("thinking") => {
                            build.message("reasoning", block["thinking"].as_str().unwrap_or(""))
                        }
                        Some("tool_use") => build.tool(
                            block["id"].as_str().unwrap_or(""),
                            block["name"].as_str().unwrap_or("Tool"),
                            &block["input"],
                        ),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    // A custom title wins over Claude's own, and either over an older summary.
    let latest = |kind: &str, key: &str| {
        records
            .iter()
            .filter(|r| r["type"] == kind)
            .filter_map(|r| text(r, key).filter(|t| !t.trim().is_empty()))
            .next_back()
    };
    Imported {
        rows: build.transcript.rows,
        title: latest("custom-title", "customTitle")
            .or_else(|| latest("ai-title", "aiTitle"))
            .or_else(|| latest("summary", "summary"))
            .map(|title| title.trim().to_owned()),
        model,
    }
}

/// textFromContent: a Pi message's text parts.
fn pi_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn pi(records: &[Value]) -> Imported {
    let chain = chain(records, "id", &["parentId"], |r| {
        !matches!(r["type"].as_str(), None | Some("session" | "title"))
    });
    let mut build = Builder::new();
    let mut model = None;
    for entry in &chain {
        if entry["type"] != "message" {
            continue;
        }
        let message = &entry["message"];
        match message["role"].as_str() {
            Some("user") => {
                if message["attribution"]
                    .as_str()
                    .is_some_and(|who| who != "user")
                {
                    continue;
                }
                let images = message["content"].as_array().map_or(0, |parts| {
                    parts.iter().filter(|p| p["type"] == "image").count()
                });
                let text = pi_text(&message["content"]);
                if !text.trim().is_empty() || images > 0 {
                    build.prompt(text.trim(), images);
                }
            }
            Some("assistant") if build.in_turn => {
                if let (Some(provider), Some(id)) =
                    (message["provider"].as_str(), message["model"].as_str())
                {
                    model = Some(format!("{provider}/{id}"));
                }
                for block in message["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => {
                            build.message("assistant", block["text"].as_str().unwrap_or(""))
                        }
                        Some("thinking") => {
                            build.message("reasoning", block["thinking"].as_str().unwrap_or(""))
                        }
                        Some("toolCall") => build.tool(
                            block["id"].as_str().unwrap_or(""),
                            block["name"].as_str().unwrap_or("tool"),
                            &block["arguments"],
                        ),
                        _ => {}
                    }
                }
            }
            Some("toolResult") if build.in_turn => {
                if let Some(id) = message["toolCallId"].as_str() {
                    build.result(
                        id,
                        &pi_text(&message["content"]),
                        message["isError"] == true,
                    );
                }
            }
            _ => {}
        }
    }
    let title = records
        .iter()
        .filter_map(|r| match r["type"].as_str() {
            Some("title_change") => text(r, "title"),
            Some("session_info") => text(r, "name"),
            Some("title") => text(r, "title"),
            _ => None,
        })
        .rfind(|t| !t.trim().is_empty());
    Imported {
        rows: build.transcript.rows,
        title,
        model,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_records_become_prompts_replies_reasoning_and_tools_on_the_live_branch() {
        let records = vec![
            json!({"type":"user","uuid":"u1","message":{"role":"user","content":"Fix the crash"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"model":"claude-opus-5-5","content":[
                {"type":"thinking","thinking":"Look at main.rs"},
                {"type":"text","text":"Checking."},
                {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test"}}]}}),
            json!({"type":"user","uuid":"r1","parentUuid":"a1","message":{"role":"user","content":[
                {"type":"tool_result","tool_use_id":"t1","content":"1 failed","is_error":true}]}}),
            // A rewound reply that is not on the branch being continued.
            json!({"type":"assistant","uuid":"old","parentUuid":"r1","message":{"content":[{"type":"text","text":"Abandoned"}]}}),
            json!({"type":"user","uuid":"meta","parentUuid":"r1","isMeta":true,"message":{"content":"<system stuff>"}}),
            json!({"type":"user","uuid":"u2","parentUuid":"meta","message":{"content":"<command-name>/review</command-name><command-args>main</command-args>"}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"content":[{"type":"text","text":"Fixed."}]}}),
            json!({"type":"ai-title","aiTitle":"Crash on launch"}),
        ];
        let imported = rows(Harness::Claude, &records);
        let roles: Vec<_> = imported.rows.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(
            roles,
            [
                "user",
                "reasoning",
                "assistant",
                "tool",
                "user",
                "assistant"
            ]
        );
        assert_eq!(imported.rows[4].text, "/review main");
        let tool: ToolCall = serde_json::from_str(&imported.rows[3].text).unwrap();
        assert_eq!(
            (tool.name.as_str(), tool.output.as_str()),
            ("Bash", "1 failed")
        );
        assert_eq!(tool.state, ToolState::Failed);
        assert_eq!(tool.presentation().command.as_deref(), Some("cargo test"));
        assert!(!imported.rows.iter().any(|r| r.text == "Abandoned"));
        assert_eq!(imported.title.as_deref(), Some("Crash on launch"));
        assert_eq!(imported.model.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn pi_entries_become_prompts_replies_and_tool_results() {
        let records = vec![
            json!({"type":"session","id":"s","cwd":"/w"}),
            json!({"type":"message","id":"1","message":{"role":"user","content":[{"type":"text","text":"List files"}]}}),
            json!({"type":"message","id":"2","parentId":"1","message":{"role":"assistant","provider":"anthropic","model":"opus","content":[
                {"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls"}}]}}),
            json!({"type":"message","id":"3","parentId":"2","message":{"role":"toolResult","toolCallId":"c1","content":[{"type":"text","text":"a.rs"}]}}),
            json!({"type":"message","id":"4","parentId":"3","message":{"role":"assistant","content":[{"type":"text","text":"One file."}]}}),
            json!({"type":"session_info","id":"5","parentId":"4","name":"Files"}),
        ];
        let imported = rows(Harness::Pi, &records);
        let roles: Vec<_> = imported.rows.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(roles, ["user", "tool", "assistant"]);
        let tool: ToolCall = serde_json::from_str(&imported.rows[1].text).unwrap();
        assert_eq!(tool.output, "a.rs");
        assert_eq!(imported.title.as_deref(), Some("Files"));
        assert_eq!(imported.model.as_deref(), Some("anthropic/opus"));
    }
}
