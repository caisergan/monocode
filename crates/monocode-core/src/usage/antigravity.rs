//! Antigravity quota, read with the CLI's own `agy -p /usage --output-format
//! json`: no model turn, and MonoCode never touches agy's Google login. Each
//! model group has its own limits. The chip shows Gemini, the group MonoCode
//! runs; the popover shows every group.
use super::{FetchError, Snapshot, Window, WindowGroup, now_ms, timestamp};
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
    let mut groups: Vec<WindowGroup> = value["command"]["data"]["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(group)
        .collect();
    // Gemini first: its limits are the chip's.
    groups.sort_by_key(|group| !group.name.to_lowercase().contains("gemini"));
    let Some(gemini) = groups
        .first()
        .filter(|group| group.name.to_lowercase().contains("gemini"))
    else {
        let message = value["response"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or("No Antigravity Gemini quota is available for this account.");
        return Err(FetchError::unavailable(message.to_owned()));
    };
    Ok(Snapshot {
        windows: gemini.windows.clone(),
        updated_at: now_ms(),
        groups,
        ..Default::default()
    })
}

fn group(value: &Value) -> Option<WindowGroup> {
    let windows: Vec<Window> = value["buckets"]
        .as_array()?
        .iter()
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
    let name = value["name"].as_str()?.trim();
    (!windows.is_empty() && !name.is_empty()).then(|| WindowGroup {
        name: name.to_owned(),
        models: value["description"]
            .as_str()
            .map(|text| {
                text.trim()
                    .trim_start_matches("Models within this group:")
                    .trim()
                    .to_owned()
            })
            .filter(|text| !text.is_empty()),
        windows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_group_is_kept_with_gemini_first_for_the_chip() {
        let output = r#"{"conversation_id":"","status":"SUCCESS","response":"…","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Claude and GPT models","description":"Models within this group: Claude Opus 5.5, GPT-OSS 120B","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":0.1,"reset_time":"2026-12-01T00:00:00Z"},{"id":"3p-5h","window":"5h","remaining_fraction":1,"reset_time":"1970-01-01T00:00:00Z"}]},{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.85,"reset_time":"2026-12-04T15:04:49Z"},{"id":"gemini-5h","window":"5h","remaining_fraction":1,"reset_time":"1970-01-01T00:00:00Z"}]}]}}}"#;
        let snapshot = parse(output).unwrap().ordered();
        let five_hour = &snapshot.windows[0];
        assert_eq!((five_hour.minutes, five_hour.used_percent), (300, 0.));
        assert_eq!(five_hour.resets_at, None);
        let weekly = &snapshot.windows[1];
        assert_eq!(weekly.minutes, 10_080);
        assert!((weekly.used_percent - 15.).abs() < 1e-6);
        assert_eq!(weekly.resets_at, Some(1_796_396_689_000));
        assert_eq!(snapshot.windows.len(), 2);
        let names: Vec<_> = snapshot.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["Gemini Models", "Claude and GPT models"]);
        assert_eq!(snapshot.groups[0].windows, snapshot.windows);
        let other = &snapshot.groups[1];
        assert_eq!(
            other.models.as_deref(),
            Some("Claude Opus 5.5, GPT-OSS 120B")
        );
        assert_eq!(
            other.windows.iter().map(|w| w.minutes).collect::<Vec<_>>(),
            [300, 10_080]
        );
        assert!((other.windows[1].used_percent - 90.).abs() < 1e-6);
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
