//! claude.ts's settingsSwitch: in stream-json mode `/model` and `/effort`
//! change the running Claude process only. After such a command's result,
//! ask Claude what it applied (get_settings) so the picker follows and the
//! next launch keeps it.
use super::*;
use crate::catalog::Model;

/// The request id of the `get_settings` question.
pub(super) const CLAUDE_SETTINGS_CHECK: &str = "native-settings";
/// How long a `/model` or `/effort` turn waits to hear what Claude applied.
const SETTINGS_REPLY: Duration = Duration::from_secs(3);

/// `/model opus` or `/effort high`; without an argument they only print the
/// current value.
pub(super) fn settings_switch(prompt: &str) -> Option<(String, String)> {
    let rest = prompt.trim_start().strip_prefix('/')?;
    let (command, rest) = rest.split_once(char::is_whitespace)?;
    let argument = rest.split_whitespace().next()?;
    matches!(command, "model" | "effort")
        .then(|| (command.to_owned(), argument.to_ascii_lowercase()))
}

/// Claude reports the concrete model: an alias the picker lists (`opus`) is
/// matched by what it resolves to, and some ids carry a date
/// (`claude-haiku-4-5-20251001`).
fn runs(model: &Model, reported: &str) -> bool {
    [Some(model.id.as_str()), model.alias_target.as_deref()]
        .into_iter()
        .flatten()
        .any(|id| {
            reported == id
                || reported
                    .strip_prefix(id)
                    .and_then(|rest| rest.strip_prefix('-'))
                    .is_some_and(|date| date.len() == 8 && date.chars().all(|c| c.is_ascii_digit()))
        })
}

impl Protocol {
    /// Ask Claude what it applied, holding the turn open until it answers.
    pub(super) fn ask_claude_settings(&mut self, stdin: &mut impl Write) -> Result<(), String> {
        if self.claude_settings_switch.is_none() || self.claude_settings_check.is_some() {
            return Ok(());
        }
        // An older Claude Code may not answer; the turn must still end.
        self.claude_settings_check = Some(Instant::now() + SETTINGS_REPLY);
        write_json(
            stdin,
            json!({"type":"control_request","request_id":CLAUDE_SETTINGS_CHECK,"request":{"subtype":"get_settings"}}),
        )
    }

    pub(super) fn applied_claude_settings(&mut self, response: &Value) -> Option<Event> {
        self.claude_settings_check = None;
        let (command, argument) = self.claude_settings_switch.take()?;
        if response["subtype"] != "success" {
            return None;
        }
        let applied = &response["response"]["applied"];
        let catalog =
            crate::catalog::cached_models_for(Kind::Claude, &self.request.settings.account)
                .unwrap_or_default();
        let selected = self.request.model.clone().unwrap_or_default();
        let current = catalog.iter().find(|model| model.id == selected);
        if command == "model" {
            let reported = applied["model"].as_str()?;
            let (id, wide) = match reported.strip_suffix("[1m]") {
                Some(id) => (id, true),
                None => (reported, false),
            };
            if current.is_some_and(|model| runs(model, id)) || selected == id {
                return None;
            }
            let model = catalog.iter().find(|model| runs(model, id))?;
            let mut model_settings = HashMap::new();
            if wide {
                model_settings.insert("context".into(), "1m".into());
            } else if self.request.settings.model_settings.contains_key("context") {
                // A wide window left over from the old model has to be
                // overwritten or the next launch would ask for it.
                model_settings.insert("context".into(), "200k".into());
            }
            return Some(Event::ConfigChanged {
                model: Some(model.id.clone()),
                model_settings,
                effort: None,
            });
        }
        // A refused level leaves Claude where it was, which need not be where
        // the picker is (Ultrathink launches at Claude's default).
        let level = applied["effort"].as_str().unwrap_or("");
        if argument != level && argument != "auto" && argument != "ultracode" {
            return None;
        }
        let effort = if applied["ultracode"] == true {
            "ultracode"
        } else {
            level
        };
        if effort.is_empty() || self.request.settings.effort.as_deref() == Some(effort) {
            return None;
        }
        // Only a level the picker offers for this model can be shown selected.
        if !current.is_some_and(|model| model.efforts.iter().any(|e| e == effort)) {
            return None;
        }
        Some(Event::ConfigChanged {
            model: None,
            model_settings: HashMap::new(),
            effort: Some(effort.into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_model_and_effort_commands_with_an_argument_switch() {
        assert_eq!(
            settings_switch(" /model Opus"),
            Some(("model".into(), "opus".into()))
        );
        assert_eq!(
            settings_switch("/effort high please"),
            Some(("effort".into(), "high".into()))
        );
        for prompt in [
            "/model",
            "/effort ",
            "/models opus",
            "use /model opus",
            "/compact",
        ] {
            assert_eq!(settings_switch(prompt), None, "{prompt}");
        }
    }

    #[test]
    fn reported_models_match_aliases_and_dated_ids() {
        let mut opus = crate::catalog::Model {
            id: "opus".into(),
            name: "Opus".into(),
            alias_target: Some("claude-opus-5-5".into()),
            efforts: Vec::new(),
            default_effort: None,
            fast: false,
            thinking: false,
            default: false,
            tiers: Vec::new(),
            controls: Vec::new(),
        };
        assert!(runs(&opus, "claude-opus-5-5"));
        assert!(runs(&opus, "opus"));
        assert!(!runs(&opus, "claude-opus-5-5-preview"));
        opus.id = "claude-haiku-4-5".into();
        opus.alias_target = None;
        assert!(runs(&opus, "claude-haiku-4-5-20251001"));
        assert!(!runs(&opus, "claude-haiku-4-5-2025"));
    }
}
