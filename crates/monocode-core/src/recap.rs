//! A continued chat's recap, read back into the sections
//! `response::continuation` writes, so the transcript can lay it out rather
//! than show the markdown it was sent as.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recap {
    /// The recap of the chat the source itself continued.
    pub earlier: bool,
    pub first_request: Option<String>,
    /// The latest few requests after the first, oldest first.
    pub requests: Vec<String>,
    /// Requests between the first and those listed.
    pub omitted: usize,
    pub latest_response: Option<String>,
    pub changed: Vec<String>,
    pub changed_more: usize,
    /// Most recently read first.
    pub read: Vec<String>,
    pub read_more: usize,
    /// Sections this layout doesn't know, such as a provider-written handoff,
    /// by heading.
    pub other: Vec<(String, String)>,
}

impl Recap {
    pub fn parse(brief: &str) -> Self {
        let mut recap = Recap::default();
        for (heading, body) in sections(brief) {
            let body = body.trim();
            match heading.as_str() {
                "Earlier context" => recap.earlier = true,
                "First request" if !body.is_empty() => recap.first_request = Some(body.into()),
                "Latest requests" => {
                    for line in body.lines().map(str::trim) {
                        if let Some(item) = line.strip_prefix("- ") {
                            recap.requests.push(item.trim().into());
                        } else if let Some(count) = omitted_count(line) {
                            recap.omitted = count;
                        }
                    }
                }
                "Latest response" if !body.is_empty() => recap.latest_response = Some(body.into()),
                "Files changed in this session" | "Files edited in this session" => {
                    (recap.changed, recap.changed_more) = files(body)
                }
                "Files read in this session" => (recap.read, recap.read_more) = files(body),
                _ if !body.is_empty() => recap.other.push((heading, body.into())),
                _ => {}
            }
        }
        recap
    }
    /// Every request the source chat received, including those omitted.
    pub fn request_count(&self) -> usize {
        usize::from(self.first_request.is_some()) + self.omitted + self.requests.len()
    }
    pub fn changed_count(&self) -> usize {
        self.changed.len() + self.changed_more
    }
    pub fn read_count(&self) -> usize {
        self.read.len() + self.read_more
    }
    pub fn is_empty(&self) -> bool {
        self == &Recap::default()
    }
}

/// `## Heading` sections. Text before the first heading counts as one
/// without a name; the earlier chat's recap keeps its sections at `###`.
fn sections(brief: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in brief.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            out.push((heading.trim().into(), String::new()));
            continue;
        }
        match out.last_mut() {
            Some((_, body)) => {
                body.push_str(line);
                body.push('\n');
            }
            None if !line.trim().is_empty() => out.push((String::new(), format!("{line}\n"))),
            None => {}
        }
    }
    out
}

fn omitted_count(line: &str) -> Option<usize> {
    line.strip_prefix('(')?
        .strip_suffix(" earlier messages omitted)")?
        .parse()
        .ok()
}

fn files(body: &str) -> (Vec<String>, usize) {
    let mut paths = Vec::new();
    let mut more = 0;
    for line in body.lines().map(str::trim) {
        let Some(item) = line.strip_prefix("- ") else {
            continue;
        };
        if let Some(count) = item
            .strip_prefix("… and ")
            .and_then(|rest| rest.strip_suffix(" more"))
            .and_then(|count| count.parse().ok())
        {
            more = count;
        } else {
            paths.push(item.trim().to_owned());
        }
    }
    (paths, more)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::Row;

    fn row(role: &str, text: &str) -> Row {
        Row {
            role: role.into(),
            text: text.into(),
            first: true,
            sent_at: None,
        }
    }
    fn tool(name: &str, path: &str) -> Row {
        let mut call = crate::tool::ToolCall::new("t", name);
        call.input = serde_json::json!({ "file_path": path }).to_string();
        row("tool", &serde_json::to_string(&call).unwrap())
    }

    #[test]
    fn reads_back_every_section_continuation_writes() {
        let mut rows = vec![row("user", "Fix the crash on launch")];
        for ix in 1..=5 {
            rows.push(row("assistant", "ok"));
            rows.push(row("user", &format!("Request {ix}")));
        }
        rows.push(tool("Edit", "src/b.rs"));
        rows.push(tool("Read", "src/a.rs"));
        rows.push(row("assistant", "Done: added the test."));
        let brief = crate::response::continuation(&rows, Some("## First request\nOlder work"));
        let recap = Recap::parse(&brief);
        assert!(recap.earlier);
        assert_eq!(
            recap.first_request.as_deref(),
            Some("Fix the crash on launch")
        );
        assert_eq!(recap.requests, ["Request 3", "Request 4", "Request 5"]);
        assert_eq!(recap.omitted, 2);
        assert_eq!(recap.request_count(), 6);
        assert_eq!(
            recap.latest_response.as_deref(),
            Some("Done: added the test.")
        );
        assert_eq!(recap.changed, ["src/b.rs"]);
        assert_eq!(recap.read, ["src/a.rs"]);
        assert!(recap.other.is_empty(), "{:?}", recap.other);
    }

    #[test]
    fn counts_files_past_the_listed_ones_and_skips_notes() {
        let recap = Recap::parse(
            "## Files changed in this session\n- a.rs\n- b.rs\n- … and 7 more\nOnly edits made with file tools are listed.\n\n## Files read in this session\n(most recent first)\n- c.rs",
        );
        assert_eq!(recap.changed, ["a.rs", "b.rs"]);
        assert_eq!(recap.changed_count(), 9);
        assert_eq!(recap.read, ["c.rs"]);
        assert_eq!(recap.read_count(), 1);
    }

    #[test]
    fn keeps_unknown_sections_and_untitled_text() {
        let recap = Recap::parse("Short summary.\n\n## Suggested next step\nRun the tests.");
        assert_eq!(
            recap.other,
            [
                (String::new(), "Short summary.".into()),
                ("Suggested next step".into(), "Run the tests.".into())
            ]
        );
        assert!(Recap::parse("  ").is_empty());
    }
}
