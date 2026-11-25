//! Where a Pi or OMP model comes from. Both reach many model providers, and
//! name a model `provider/model`, so the same model can be offered several
//! times: `anthropic/claude-opus-5-5` and `openrouter/claude-opus-5-5`.
use gpui::SharedString;
use monocode_core::provider::Kind;

/// The provider in a model ID; `None` for harnesses that have only one.
pub(crate) fn model_source(kind: Kind, id: &str) -> Option<&str> {
    if !matches!(kind, Kind::Pi | Kind::Omp) {
        return None;
    }
    // A remote host prefixes its IDs with the harness: `omp:openrouter/…`.
    let id = id
        .strip_prefix(kind.id())
        .and_then(|id| id.strip_prefix(':'))
        .unwrap_or(id);
    id.split_once('/')
        .map(|(source, _)| source)
        .filter(|source| !source.is_empty())
}

/// A provider's name. One from the user's own configuration keeps its ID.
pub(crate) fn source_label(source: &str) -> SharedString {
    match source {
        "amazon-bedrock" => "Amazon Bedrock",
        "anthropic" => "Anthropic",
        "azure-openai-responses" => "Azure OpenAI",
        "cerebras" => "Cerebras",
        "deepseek" => "DeepSeek",
        "fireworks" => "Fireworks",
        "github-copilot" => "GitHub Copilot",
        "google" => "Google",
        "google-vertex" => "Google Vertex",
        "groq" => "Groq",
        "huggingface" => "Hugging Face",
        "lm-studio" => "LM Studio",
        "mistral" => "Mistral",
        "ollama" => "Ollama",
        "openai" => "OpenAI",
        "openai-codex" => "ChatGPT",
        "opencode" => "OpenCode Zen",
        "openrouter" => "OpenRouter",
        "vercel-ai-gateway" => "Vercel AI Gateway",
        "xai" => "xAI",
        "zai" => "Z.ai",
        custom => return custom.to_owned().into(),
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pi_and_omp_ids_name_a_provider() {
        assert_eq!(
            model_source(Kind::Omp, "commandcode/deepseek/deepseek-v4"),
            Some("commandcode")
        );
        assert_eq!(
            model_source(Kind::Pi, "explabs/gpt-6-luna"),
            Some("explabs")
        );
        assert_eq!(model_source(Kind::Pi, "gpt-6-luna"), None);
        assert_eq!(model_source(Kind::Pi, "/gpt-6-luna"), None);
        assert_eq!(model_source(Kind::OpenCode, "openrouter/gpt-6"), None);
    }

    #[test]
    fn a_remote_hosts_prefix_is_not_the_provider() {
        assert_eq!(
            model_source(Kind::Omp, "omp:openrouter/z-ai/glm"),
            Some("openrouter")
        );
        assert_eq!(
            model_source(Kind::Pi, "pi:explabs/gpt-6-luna"),
            Some("explabs")
        );
    }

    #[test]
    fn custom_providers_keep_their_id() {
        assert_eq!(source_label("openai-codex"), "ChatGPT");
        assert_eq!(source_label("commandcode-zdr"), "commandcode-zdr");
    }
}
