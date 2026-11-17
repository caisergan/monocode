//! Where Hermes keeps what its usage is read from: the provider its model
//! names (`<provider>:<model>` over ACP, `model.provider` in config.yaml for
//! the default) and that provider's key in its `.env`. Read only.
use std::path::{Path, PathBuf};

/// `HERMES_HOME`, or `~/.hermes`.
pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("HERMES_HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::accounts::home().map(|home| home.join(".hermes")))
}

/// The provider a Hermes model bills through. ACP names a model
/// `<provider>:<model>`; the footer's key keeps just `<provider>/`. A session
/// on the default model names none, and config.yaml has it.
pub(super) fn provider(model: Option<&str>, home: Option<&Path>) -> Option<String> {
    let model = model.unwrap_or("").trim();
    let model = model.strip_prefix("hermes:").unwrap_or(model);
    let named = model
        .split_once([':', '/'])
        .map(|(provider, _)| provider.trim())
        .filter(|provider| !provider.is_empty());
    named
        .map(str::to_owned)
        .or_else(|| {
            let config = std::fs::read_to_string(home?.join("config.yaml")).ok()?;
            configured_provider(&config)
        })
        .map(|provider| provider.to_lowercase())
}

/// `opencode-go`, and a custom provider that extends it (`opencode-go-bridge`).
pub(super) fn is_opencode_go(provider: &str) -> bool {
    matches!(provider, "go" | "opencode_go" | "opencode-go-sub")
        || provider.starts_with("opencode-go")
}

/// `provider:` under the top-level `model:` of config.yaml.
fn configured_provider(config: &str) -> Option<String> {
    let mut in_model = false;
    for line in config.lines() {
        let indented = line.starts_with([' ', '\t']);
        let text = line.trim();
        if text.is_empty() || text.starts_with('#') {
            continue;
        }
        if !indented {
            in_model = text == "model:";
            continue;
        }
        if in_model {
            if let Some(value) = text.strip_prefix("provider:") {
                let value = value.split(" #").next().unwrap_or("").trim();
                let value = value.trim_matches(['"', '\'']);
                return (!value.is_empty()).then(|| value.to_owned());
            }
        }
    }
    None
}

/// The Go key as Hermes resolves it: its `.env`, which it loads over the
/// process environment, then that environment.
pub(crate) fn opencode_go_key(home: &Path) -> Option<String> {
    const NAME: &str = "OPENCODE_GO_API_KEY";
    let set = |value: String| Some(value.trim().to_owned()).filter(|value| !value.is_empty());
    std::fs::read_to_string(home.join(".env"))
        .ok()
        .and_then(|env| env_value(&env, NAME))
        .or_else(|| std::env::var(NAME).ok().and_then(set))
}

fn env_value(env: &str, name: &str) -> Option<String> {
    env.lines().rev().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let value = line.strip_prefix(name)?.trim_start().strip_prefix('=')?;
        let value = value.trim();
        let value = match value.chars().next() {
            Some(quote @ ('"' | '\'')) => value[1..].split(quote).next().unwrap_or(""),
            _ => value.split(" #").next().unwrap_or("").trim(),
        };
        (!value.is_empty()).then(|| value.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_provider_comes_from_the_model_then_the_config() {
        let config = "# top\nmodel:\n  default: deepseek-v4.1-flash\n  provider: opencode-go  # go\n  context_length: 1000000\nauxiliary:\n  provider: copilot\n";
        assert_eq!(configured_provider(config).as_deref(), Some("opencode-go"));
        assert_eq!(
            configured_provider("auxiliary:\n  provider: copilot\n"),
            None
        );
        for model in [
            "opencode-go:deepseek-v4.1-flash",
            "hermes:opencode-go:glm-5.3",
            "OpenCode-Go/",
        ] {
            assert_eq!(provider(Some(model), None).as_deref(), Some("opencode-go"));
        }
        assert_eq!(provider(Some("deepseek-v4.1-flash"), None), None);
        assert_eq!(provider(None, None), None);
        assert!(is_opencode_go("opencode-go") && is_opencode_go("opencode-go-bridge"));
        assert!(!is_opencode_go("opencode-zen") && !is_opencode_go("anthropic"));
    }

    #[test]
    fn the_key_is_the_last_one_the_env_file_sets() {
        let env = "# OPENCODE_GO_API_KEY=\nOPENCODE_GO_API_KEY=old\nOTHER=1\nexport OPENCODE_GO_API_KEY=\"oc_new\"  # note\n";
        assert_eq!(
            env_value(env, "OPENCODE_GO_API_KEY").as_deref(),
            Some("oc_new")
        );
        assert_eq!(
            env_value("OPENCODE_GO_API_KEY=oc_plain # x\n", "OPENCODE_GO_API_KEY").as_deref(),
            Some("oc_plain")
        );
        assert_eq!(
            env_value(
                "OPENCODE_GO_API_KEY_OLD=x\n# OPENCODE_GO_API_KEY=\n",
                "OPENCODE_GO_API_KEY"
            ),
            None
        );
        assert_eq!(
            env_value("OPENCODE_GO_API_KEY=\n", "OPENCODE_GO_API_KEY"),
            None
        );
    }
}
