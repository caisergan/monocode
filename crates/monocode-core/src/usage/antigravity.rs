//! Antigravity quota, read with the CLI's own `agy -p /usage --output-format
//! json`: no model turn, and MonoCode never touches agy's Google login. Only
//! the Gemini group is shown, since MonoCode runs only Gemini on Antigravity.
use super::{FetchError, Snapshot, Window, now_ms, timestamp};
use crate::provider::Kind;
use serde_json::Value;

pub(super) fn fetch() -> Result<Snapshot, FetchError> {
    let output = crate::accounts::login::cli_output(
        Kind::Antigravity,
        &["-p", "/usage", "--output-format", "json"],
        &Default::default(),
    )
    .map_err(FetchError::unavailable)?;
    parse(&output)
}

fn parse(output: &str) -> Result<Snapshot, FetchError> {
    let value: Value = serde_json::from_str(output.trim()).map_err(|_| {
        // A Gemini API key has no account quota; agy says so in plain text.
        let text = output.trim();
        if text.is_empty() {
            FetchError::failed("Antigravity usage came back empty.")
        } else {
            FetchError::unavailable(text.lines().next().unwrap_or(text).to_owned())
        }
    })?;
    let groups = value["command"]["data"]["groups"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let gemini = groups.iter().find(|group| {
        group["name"]
            .as_str()
            .is_some_and(|name| name.to_lowercase().contains("gemini"))
    });
    let windows: Vec<Window> = gemini
        .and_then(|group| group["buckets"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|bucket| {
            let minutes = match bucket["window"].as_str()? {
                "5h" => 300,
                "daily" | "1d" => 1_440,
                "weekly" => 10_080,
                "monthly" => 43_200,
                _ => return None,
            };
            let remaining = bucket["remaining_fraction"].as_f64()?;
            Some(Window {
                used_percent: ((1. - remaining) * 100.).clamp(0., 100.),
                minutes,
                // An untouched window reports the epoch.
                resets_at: timestamp(&bucket["reset_time"]).filter(|at| *at > 0),
            })
        })
        .collect();
    if windows.is_empty() {
        let message = value["response"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or("No Antigravity Gemini quota is available for this account.");
        return Err(FetchError::unavailable(message.to_owned()));
    }
    Ok(Snapshot {
        windows,
        updated_at: now_ms(),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gemini_group_becomes_five_hour_and_weekly_windows() {
        let output = r#"{"conversation_id":"","status":"SUCCESS","response":"…","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.85,"reset_time":"2026-12-04T15:04:49Z"},{"id":"gemini-5h","window":"5h","remaining_fraction":1,"reset_time":"1970-01-01T00:00:00Z"}]},{"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":0.1,"reset_time":"2026-12-01T00:00:00Z"}]}]}}}"#;
        let snapshot = parse(output).unwrap();
        assert_eq!(snapshot.windows.len(), 2);
        let weekly = &snapshot.windows[0];
        assert_eq!(weekly.minutes, 10_080);
        assert!((weekly.used_percent - 15.).abs() < 1e-6);
        assert_eq!(weekly.resets_at, Some(1_796_396_689_000));
        let five_hour = &snapshot.windows[1];
        assert_eq!((five_hour.minutes, five_hour.used_percent), (300, 0.));
        assert_eq!(five_hour.resets_at, None);
    }

    #[test]
    fn plain_text_and_empty_groups_are_unavailable() {
        let error =
            parse("/usage is not available with a Gemini API key.\nSee AI Studio.").unwrap_err();
        assert!(error.unavailable);
        assert_eq!(
            error.message,
            "/usage is not available with a Gemini API key."
        );
        let error = parse(r#"{"response":"","command":{"data":{"groups":[]}}}"#).unwrap_err();
        assert!(error.unavailable);
        assert!(!parse("").unwrap_err().unavailable);
    }
}
