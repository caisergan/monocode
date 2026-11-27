//! Context-window accounting, matching sessions/model/contextUsage.ts.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub used: u64,
    pub window: Option<u64>,
}
impl Usage {
    pub fn ratio(self) -> Option<f32> {
        self.window
            .filter(|w| *w > 0)
            .map(|w| (self.used as f64 / w as f64).min(1.) as f32)
    }
    pub fn merge(&mut self, used: Option<u64>, window: Option<u64>) {
        if let Some(used) = used {
            self.used = used;
        }
        if let Some(window) = window.filter(|w| *w > 0) {
            self.window = Some(window);
        }
    }
}

pub fn claude_used(usage: &Value) -> Option<u64> {
    let used = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
    ]
    .iter()
    .map(|key| usage[key].as_u64().unwrap_or(0))
    .sum();
    (used > 0).then_some(used)
}

/// sessionTokens.ts's SessionTokenTotals: tokens the session has spent
/// across every turn, so compaction never lowers it. Input splits into
/// `uncached`, the prompt tokens the model processed fresh (including those it
/// wrote to the cache), and `cache_read`, the ones served from the cache.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenTotals {
    pub uncached: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
}
impl TokenTotals {
    /// sessionTokenTotals: the sum of each turn's metrics. Claude reports
    /// `input_tokens` without the cached share, so cache writes are added to
    /// it to count every token not read from the cache.
    pub fn sum<'a>(turns: impl IntoIterator<Item = &'a crate::agent::TurnMetrics>) -> Option<Self> {
        let mut totals = Self::default();
        for metrics in turns {
            totals.uncached += metrics.input_tokens + metrics.cache_write_tokens;
            totals.cache_read += metrics.cache_read_tokens;
            totals.cache_write += metrics.cache_write_tokens;
            totals.output += metrics.output_tokens;
        }
        (totals.uncached > 0 || totals.cache_read > 0 || totals.output > 0).then_some(totals)
    }
    /// sessionTokensTooltip: "120K uncached · 5.8M cached · 45K output".
    pub fn detail(&self) -> String {
        format!(
            "{} uncached · {} cached · {} output",
            format_tokens(self.uncached),
            format_tokens(self.cache_read),
            format_tokens(self.output)
        )
    }
}

/// contextCacheHit: how much of the prompt the provider read from its
/// cache, on the latest turn that said and over every turn that did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CacheHit {
    pub latest: f64,
    /// Only once a second turn has reported, when it can differ from `latest`.
    pub session: Option<f64>,
}
impl CacheHit {
    pub fn from_turns(
        turns: &std::collections::HashMap<usize, crate::agent::TurnInfo>,
    ) -> Option<Self> {
        let mut reported: Vec<_> = turns
            .iter()
            .filter_map(|(turn, info)| Some((*turn, info.metrics?)))
            .filter(|(_, metrics)| metrics.cache_hit_percent.is_some())
            .collect();
        reported.sort_by_key(|(turn, _)| *turn);
        let latest = reported.last()?.1.cache_hit_percent?;
        // Providers count the prompt differently (Codex's input already holds
        // its cached reads), so each turn's prompt size comes back from its
        // own rate. A turn that read nothing prompted its input and writes.
        let (read, prompt) = reported.iter().fold((0., 0.), |(read, prompt), (_, m)| {
            let hit = m.cache_hit_percent.unwrap_or(0.);
            let size = if hit > 0. {
                m.cache_read_tokens as f64 * 100. / hit
            } else {
                (m.input_tokens + m.cache_write_tokens) as f64
            };
            (read + m.cache_read_tokens as f64, prompt + size)
        });
        Some(Self {
            latest,
            session: (reported.len() > 1 && prompt > 0.).then(|| read / prompt * 100.),
        })
    }
}

pub fn format_tokens(count: u64) -> String {
    let (value, suffix) = if count >= 1_000_000 {
        (count as f64 / 1_000_000., "M")
    } else if count >= 1000 {
        (count as f64 / 1000., "K")
    } else {
        return count.to_string();
    };
    if value < 10. {
        format!(
            "{}{suffix}",
            format!("{value:.1}")
                .trim_end_matches('0')
                .trim_end_matches('.')
        )
    } else {
        format!("{value:.0}{suffix}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_reads_the_latest_turn_and_weighs_the_session_by_prompt() {
        use crate::agent::{TurnInfo, TurnMetrics};
        use std::collections::HashMap;
        let turn = |input, read, write, hit| TurnInfo {
            metrics: Some(TurnMetrics {
                input_tokens: input,
                cache_read_tokens: read,
                cache_write_tokens: write,
                cache_hit_percent: hit,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(CacheHit::from_turns(&HashMap::new()), None);
        // A first turn writes the cache; later ones read it.
        let mut turns = HashMap::from([(1, turn(1_000, 0, 9_000, Some(0.)))]);
        let first = CacheHit::from_turns(&turns).unwrap();
        assert_eq!((first.latest, first.session), (0., None));
        turns.insert(4, turn(500, 9_500, 0, Some(95.)));
        // A turn that did not report the cache does not count.
        turns.insert(9, turn(80, 0, 0, None));
        let hit = CacheHit::from_turns(&turns).unwrap();
        assert_eq!(hit.latest, 95.);
        // 9,500 of 20,000 prompt tokens over both turns.
        assert_eq!(hit.session.map(|rate| rate.round()), Some(48.));
        // Codex's input holds its cached reads: 90% of an 8,000 prompt.
        let codex = HashMap::from([
            (1, turn(2_000, 0, 0, Some(0.))),
            (2, turn(8_000, 7_200, 0, Some(90.))),
        ]);
        let codex = CacheHit::from_turns(&codex).unwrap();
        assert_eq!(codex.session.map(|rate| rate.round()), Some(72.));
    }

    #[test]
    fn session_token_totals_count_uncached_input_and_output() {
        let turn = |input, read, write, output| crate::agent::TurnMetrics {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: read,
            cache_write_tokens: write,
            cache_hit_percent: None,
            cache_ttl_seconds: None,
            ..Default::default()
        };
        let turns = [turn(100, 5_000, 2_000, 300), turn(20, 7_000, 0, 1_200)];
        let totals = TokenTotals::sum(&turns).unwrap();
        assert_eq!(
            (totals.uncached, totals.cache_read, totals.output),
            (2_120, 12_000, 1_500)
        );
        assert_eq!(totals.detail(), "2.1K uncached · 12K cached · 1.5K output");
        assert_eq!(TokenTotals::sum(&[turn(0, 0, 0, 0)]), None);
    }
}
