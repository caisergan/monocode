//! DSH's ACP bridge sends only the context size (`usage_update` has `used`
//! and `size`, the prompt result only `stopReason`). Each request's tokens,
//! cache reads included, are in the session's own log, which DSH persists
//! before it settles the prompt.
use crate::agent::TurnMetrics;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The tokens of the latest turn in a DSH session's log, with the log
/// position that turn started at, so a prompt that never started a turn does
/// not report the one before it again.
pub(super) fn turn_metrics(session: &str) -> Option<(u64, TurnMetrics)> {
    let log = find_log(&super::super::tasks::dsh_sessions_root()?, session)?;
    let file = std::fs::File::open(log).ok()?;
    let mut decoded = Vec::new();
    // DSH appends a zstd frame per write; a frame still being written ends
    // the read, and what came before it is kept.
    let _ = zstd::stream::read::Decoder::new(file)
        .ok()?
        .read_to_end(&mut decoded);
    last_turn(&decoded)
}

/// Logs live at `<root>/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`. The
/// slug is DSH's own spelling of the working directory, so look in each.
fn find_log(root: &Path, session: &str) -> Option<PathBuf> {
    if session.is_empty() || session.contains(['/', '\\']) || session.starts_with('.') {
        return None;
    }
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|slug| slug.path().join(session).join("session.v4.jsonl.zstd"))
        .find(|log| log.is_file())
}

/// Sums every request after the log's last `turn/start`. DSH counts
/// `inputTokens` without the cached part and writes no cache, so the prompt
/// is input plus cache reads.
fn last_turn(log: &[u8]) -> Option<(u64, TurnMetrics)> {
    let mut turn: Option<(u64, TurnMetrics)> = None;
    for line in log.split(|byte| *byte == b'\n') {
        // A long log is mostly messages and tool output: parse only the two
        // record types read here, whose `type` comes first.
        let head = &line[..line.len().min(48)];
        let is = |kind: &[u8]| head.windows(kind.len()).any(|window| window == kind);
        if !is(b"\"turn/start\"") && !is(b"\"assistant/message\"") {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        match record["type"].as_str() {
            Some("turn/start") => {
                let at = record["seq"].as_u64().unwrap_or(0);
                turn = Some((at, TurnMetrics::default()));
            }
            Some("assistant/message") => {
                let (Some((_, metrics)), Some(usage)) =
                    (turn.as_mut(), record["data"]["usage"].as_object())
                else {
                    continue;
                };
                let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
                metrics.input_tokens += count("inputTokens");
                metrics.output_tokens += count("outputTokens");
                metrics.cache_read_tokens += count("cacheReadTokens");
                metrics.reasoning_tokens += count("reasoningTokens");
            }
            _ => {}
        }
    }
    let (at, mut metrics) = turn.filter(|(_, metrics)| metrics.reported())?;
    let prompt = metrics.input_tokens + metrics.cache_read_tokens;
    metrics.cache_hit_percent =
        (prompt > 0).then(|| metrics.cache_read_tokens as f64 / prompt as f64 * 100.);
    Some((at, metrics))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records as a real DSH 0.2.2 lead log writes them.
    const LOG: &str = concat!(
        r#"{"type":"session","version":4,"id":"lead","cwd":"/p","delegationDepth":0}"#,
        "\n",
        r#"{"type":"turn/start","seq":6,"time":1,"data":{"turn":1}}"#,
        "\n",
        r#"{"type":"assistant/message","seq":16,"data":{"usage":{"inputTokens":13550,"outputTokens":244,"totalTokens":13794}}}"#,
        "\n",
        r#"{"type":"turn/end","seq":20,"data":{"turn":1,"reason":{"kind":"completed"}}}"#,
        "\n",
        r#"{"type":"turn/start","seq":21,"time":2,"data":{"turn":2}}"#,
        "\n",
        r#"{"type":"tool/result","seq":22,"data":{"message":{"content":"assistant/message"}}}"#,
        "\n",
        r#"{"type":"assistant/message","seq":25,"data":{"usage":{"inputTokens":2536,"outputTokens":243,"totalTokens":16475,"cacheReadTokens":13696}}}"#,
        "\n",
        r#"{"type":"assistant/message","seq":34,"data":{"usage":{"inputTokens":464,"outputTokens":57,"totalTokens":16865,"cacheReadTokens":16344}}}"#,
        "\n",
        r#"{"type":"turn/end","seq":40,"data":{"turn":2,"reason":{"kind":"completed"}}}"#,
        "\n",
    );

    #[test]
    fn the_latest_turn_sums_its_requests_and_their_cache_reads() {
        let (at, metrics) = last_turn(LOG.as_bytes()).unwrap();
        assert_eq!(at, 21);
        assert_eq!(
            (
                metrics.input_tokens,
                metrics.cache_read_tokens,
                metrics.output_tokens
            ),
            (3_000, 30_040, 300)
        );
        // 30,040 of a 33,040-token prompt came from the cache.
        assert_eq!(metrics.cache_hit_percent.map(|hit| hit.round()), Some(91.));
        // A turn that has made no request yet reports nothing.
        let started = format!(
            "{LOG}{}\n",
            r#"{"type":"turn/start","seq":41,"data":{"turn":3}}"#
        );
        assert_eq!(last_turn(started.as_bytes()), None);
    }

    #[test]
    fn the_log_is_found_under_any_working_directory_slug() {
        let root = std::env::temp_dir().join(format!("monocode-dsh-log-{}", std::process::id()));
        let log = root.join("--p--/lead/session.v4.jsonl.zstd");
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        std::fs::create_dir_all(root.join("--other--")).unwrap();
        std::fs::write(&log, zstd::stream::encode_all(LOG.as_bytes(), 0).unwrap()).unwrap();
        assert_eq!(find_log(&root, "lead"), Some(log));
        assert_eq!(find_log(&root, "missing"), None);
        assert_eq!(find_log(&root, "../--p--/lead"), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
