//! Hermes offers every model the same eight reasoning levels and clamps the
//! ones a model lacks without saying so (`ultra` on DeepSeek V4.1 Flash is
//! `max`). For its OpenCode Go models the provider itself lists what each one
//! has, so the picker shows those and no others. Its list of Go models is one
//! it ships with, too: the ones the provider no longer serves are left out.
use super::Model;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MODELS_URL: &str = "https://opencode.ai/zen/go/v1/models";
const HTTP_TIMEOUT: Duration = Duration::from_secs(6);
/// A model's levels change with its releases, not by the hour.
const FRESH_FOR: Duration = Duration::from_secs(6 * 60 * 60);
/// Hermes's own two: whatever its profile is set to, and thinking off.
const ALWAYS: [&str; 2] = ["default", "none"];

/// Each Go model's graded levels, by its bare id. A model with none listed
/// (a plain on/off toggle, or no reasoning at all) has an empty list.
type Levels = HashMap<String, Vec<String>>;

/// Keep the OpenCode Go models the provider serves, each with only the levels
/// it has. Best-effort: no key, no network or an answer in another shape
/// leaves Hermes's list as is.
pub(super) fn narrow(models: &mut Vec<Model>) {
    if !models.iter().any(|model| go_model(&model.id).is_some()) {
        return;
    }
    if let Some(levels) = go_levels() {
        served(models, &levels);
        narrow_efforts(models, &levels);
    }
}

/// Drop the Go models missing from the provider's own list: a request to one
/// only fails. The model the session is on stays, whatever it is.
fn served(models: &mut Vec<Model>, levels: &Levels) {
    models.retain(|model| {
        model.default || go_model(&model.id).is_none_or(|id| levels.contains_key(id))
    });
}

fn narrow_efforts(models: &mut [Model], levels: &Levels) {
    for model in models {
        let Some(has) = go_model(&model.id).and_then(|id| levels.get(id)) else {
            continue;
        };
        model
            .efforts
            .retain(|effort| ALWAYS.contains(&effort.as_str()) || has.contains(effort));
        // The profile's level may be one this model lacks (`xhigh`): Hermes
        // clamps it, so the honest name for it here is its own default.
        if model
            .default_effort
            .as_ref()
            .is_some_and(|effort| !model.efforts.contains(effort))
        {
            model.default_effort = model
                .efforts
                .iter()
                .any(|effort| effort == "default")
                .then(|| "default".to_owned());
        }
    }
}

/// `opencode-go:<model>`, as Hermes names a model over ACP: the bare id.
fn go_model(id: &str) -> Option<&str> {
    let id = id.strip_prefix("hermes:").unwrap_or(id);
    id.strip_prefix("opencode-go:")
        .filter(|model| !model.is_empty())
}

/// What a million tokens of a Go model cost at the provider's list price, in
/// dollars. A subscription pays for them out of its windows; this is the
/// measure those windows are counted in.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Price {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
}
impl Price {
    /// The list price of a turn's tokens. Reasoning is part of the output.
    pub(crate) fn of(&self, input: u64, cache_read: u64, cache_write: u64, output: u64) -> f64 {
        (input as f64 * self.input
            + cache_read as f64 * self.cache_read
            + cache_write as f64 * self.cache_write
            + output as f64 * self.output)
            / 1_000_000.
    }
}
type Prices = HashMap<String, Price>;

fn cache() -> &'static Mutex<Option<(Instant, Levels, Prices)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Levels, Prices)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// A Go model's list price, as the model list last fetched has it. Never
/// fetches: a turn that ends is not kept waiting on the network for it.
pub(crate) fn go_price(model: &str) -> Option<Price> {
    let cached = cache().lock().unwrap_or_else(|e| e.into_inner());
    cached.as_ref()?.2.get(model).copied()
}

fn go_levels() -> Option<Levels> {
    // The lock is not held over the request: a turn that ends meanwhile
    // reads its price from the same cache and must not wait on the network.
    {
        let cached = cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, levels, _)) = cached.as_ref() {
            if at.elapsed() < FRESH_FOR {
                return Some(levels.clone());
            }
        }
    }
    let home = crate::usage::hermes::home()?;
    let key = crate::usage::hermes::opencode_go_key(&home)?;
    let body = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .build()
        .get(MODELS_URL)
        .set("Authorization", &format!("Bearer {key}"))
        .call()
        .ok()?
        .into_string()
        .ok()?;
    let listed: Value = serde_json::from_str(&body).ok()?;
    let levels = parse(&listed)?;
    *cache().lock().unwrap_or_else(|e| e.into_inner()) =
        Some((Instant::now(), levels.clone(), prices(&listed)));
    Some(levels)
}

/// `data[].cost.text` of the Go model list: dollars per million tokens.
fn prices(value: &Value) -> Prices {
    let rows = value.get("data").unwrap_or(value).as_array();
    rows.into_iter()
        .flatten()
        .filter_map(|row| {
            let text = &row["cost"]["text"];
            let input = text["input"]["price"].as_f64()?;
            let cache = &text["input"]["cache"];
            Some((
                row["id"].as_str()?.to_owned(),
                Price {
                    input,
                    // A model with no cache price charges a cached token as any other.
                    cache_read: cache["read"].as_f64().unwrap_or(input),
                    cache_write: cache["write"].as_f64().unwrap_or(input),
                    output: text["output"]["price"].as_f64()?,
                },
            ))
        })
        .collect()
}

/// `data[].capabilities.reasoning.effort` of the Go model list.
fn parse(value: &Value) -> Option<Levels> {
    let rows = value.get("data").unwrap_or(value).as_array()?;
    let levels: Levels = rows
        .iter()
        .filter_map(|row| {
            let effort = &row["capabilities"]["reasoning"]["effort"];
            let levels = effort
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|level| level.as_str().map(str::to_lowercase))
                .collect();
            Some((row["id"].as_str()?.to_owned(), levels))
        })
        .collect();
    (!levels.is_empty()).then_some(levels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hermes_model(id: &str, default: &str) -> Model {
        let mut model = super::super::model(id, id);
        model.efforts = [
            "default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ]
        .map(str::to_owned)
        .to_vec();
        model.default_effort = Some(default.into());
        model
    }

    #[test]
    fn a_go_model_shows_only_the_levels_the_provider_lists_for_it() {
        // As https://opencode.ai/zen/go/v1/models answered on 2026-11-12.
        let levels = parse(&json!({"data":[
            {"id":"deepseek-v4.1-flash","capabilities":{"reasoning":{"supported":true,"effort":["low","high","max"]}}},
            {"id":"gpt-6-luna","capabilities":{"reasoning":{"supported":true,"effort":["none","low","medium","high","xhigh","max"]}}},
            {"id":"minimax-m3","capabilities":{"reasoning":{"supported":true,"toggle":true}}},
            {"id":"no-capabilities"}
        ]}))
        .unwrap();
        let mut models = vec![
            hermes_model("opencode-go:deepseek-v4.1-flash", "xhigh"),
            hermes_model("opencode-go:gpt-6-luna", "high"),
            hermes_model("opencode-go:minimax-m3", "max"),
            hermes_model("opencode-go:not-listed", "xhigh"),
            hermes_model("anthropic:claude-fable-5-2", "xhigh"),
        ];
        narrow_efforts(&mut models, &levels);
        let shown = |at: usize| models[at].efforts.join(" ");
        assert_eq!(shown(0), "default none low high max");
        assert_eq!(models[0].default_effort.as_deref(), Some("default"));
        assert_eq!(shown(1), "default none low medium high xhigh max");
        assert_eq!(models[1].default_effort.as_deref(), Some("high"));
        // On or off is all it has.
        assert_eq!(shown(2), "default none");
        // What the provider does not list, and other providers, stay as Hermes says.
        assert_eq!(models[3].efforts.len(), 9);
        assert_eq!(models[4].efforts.len(), 9);
        assert_eq!(models[4].default_effort.as_deref(), Some("xhigh"));

        // A model the provider stopped serving goes, unless the session is on it.
        models[3].default = true;
        models.push(hermes_model("opencode-go:retired", "high"));
        served(&mut models, &levels);
        let ids: Vec<_> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "opencode-go:deepseek-v4.1-flash",
                "opencode-go:gpt-6-luna",
                "opencode-go:minimax-m3",
                "opencode-go:not-listed",
                "anthropic:claude-fable-5-2"
            ]
        );

        let listed = json!({"data":[
            {"id":"deepseek-v4.1-flash","cost":{"text":{"input":{"price":0.15,"cache":{"read":0.003}},"output":{"price":0.6}}}},
            {"id":"free","cost":{"text":{"input":{"price":0.0},"output":{"price":0.0}}}},
            {"id":"unpriced"}
        ]});
        let prices = prices(&listed);
        assert_eq!(prices.len(), 2);
        let flash = prices["deepseek-v4.1-flash"];
        assert_eq!((flash.cache_read, flash.cache_write), (0.003, 0.15));
        // 20k fresh, 150k cached, 2k out: $0.003 + $0.00045 + $0.0012.
        assert!((flash.of(20_000, 150_000, 0, 2_000) - 0.00465).abs() < 1e-9);

        assert_eq!(go_model("hermes:opencode-go:glm-5.3"), Some("glm-5.3"));
        assert_eq!(go_model("opencode-go:"), None);
        assert_eq!(go_model("opencode-zen:glm-5.3"), None);
        assert!(parse(&json!({"error":"unauthorized"})).is_none());
        assert!(parse(&json!({"data":[]})).is_none());
    }
}
