//! promptCache.ts: when Claude's prompt cache for a session runs out. Every
//! request reads the cached prefix and resets its timer, so the cache lives
//! until one TTL after the last turn that used it. Past that point the next
//! message re-sends the whole context uncached.
use crate::agent::TurnInfo;
use serde_json::Value;
use std::collections::HashMap;

/// The expiry is measured from when MonoCode saw the turn end, which trails
/// the provider's last request, so a message sent at the edge may miss.
pub const EXPIRY_MARGIN_MS: u64 = 30_000;
/// Below this much context a re-read costs little. A fresh Claude Code
/// session starts around 20K.
pub const MIN_CONTEXT: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    pub ttl_ms: u64,
    /// Epoch ms the last turn that used the cache finished.
    pub last_used_at: u64,
    pub expires_at: u64,
}

/// cacheTtlFromUsage: the lifetime of the cache a Claude turn wrote, from
/// its 5m/1h write split. Claude Code writes the conversation to the 1h cache
/// on subscription plans and its side calls to the 5m one, so the longer
/// tier wins. A turn that wrote nothing says nothing about the tier.
pub fn claude_ttl(usage: &Value) -> Option<u64> {
    let creation = &usage["cache_creation"];
    let wrote = |key: &str| creation[key].as_u64().unwrap_or(0) > 0;
    if wrote("ephemeral_1h_input_tokens") {
        Some(3600)
    } else if wrote("ephemeral_5m_input_tokens") {
        Some(300)
    } else {
        None
    }
}

/// promptCacheState: the cache window from the session's turns. Only
/// providers that report the cache tier set a TTL, so the rest return None
/// rather than guess a lifetime.
pub fn state(turns: &HashMap<usize, TurnInfo>) -> Option<State> {
    let mut ordered: Vec<_> = turns.iter().collect();
    ordered.sort_by_key(|(turn, _)| **turn);
    let mut ttl = None;
    let mut last_used_at = None;
    for (_, info) in ordered {
        let Some(metrics) = info.metrics else {
            continue;
        };
        if let Some(seconds) = metrics.cache_ttl_seconds {
            ttl = Some(seconds);
        }
        let ended = info.completed_at.or_else(|| {
            info.started_at
                .filter(|_| info.has_duration())
                .map(|at| at + info.duration_ms)
        });
        if metrics.cache_read_tokens > 0 || metrics.cache_write_tokens > 0 {
            if let Some(ended) = ended {
                last_used_at = Some(ended);
            }
        }
    }
    let ttl_ms = ttl? * 1000;
    let last_used_at = last_used_at?;
    Some(State {
        ttl_ms,
        last_used_at,
        expires_at: last_used_at + ttl_ms,
    })
}

impl State {
    /// When the warning shows, margin included.
    pub fn warn_at(&self) -> u64 {
        self.expires_at.saturating_sub(EXPIRY_MARGIN_MS)
    }
    pub fn expired(&self, now: u64) -> bool {
        now >= self.warn_at()
    }
    /// promptCacheTooltip: what happened, then what it costs. `context_used`
    /// is the size of the prompt the next message re-sends.
    pub fn tooltip(&self, now: u64, context_used: Option<u64>) -> (String, String, String) {
        let idle = crate::usage::duration(now.saturating_sub(self.last_used_at) as i64);
        let minutes = (self.ttl_ms as f64 / 60_000.).round() as u64;
        let ttl = if minutes.is_multiple_of(60) {
            match minutes / 60 {
                1 => "1 hour".to_owned(),
                hours => format!("{hours} hours"),
            }
        } else if minutes == 1 {
            "1 minute".to_owned()
        } else {
            format!("{minutes} minutes")
        };
        let resend = match context_used.filter(|used| *used > 0) {
            Some(used) => format!(
                "about {} tokens of context",
                crate::context::format_tokens(used)
            ),
            None => "the whole context".to_owned(),
        };
        (
            "Prompt cache expired".into(),
            format!(
                "Idle for {idle}. The provider keeps this session's cache for {ttl} after the last request."
            ),
            format!(
                "Your next message re-sends {resend} uncached, so it uses more of your limits and takes longer to start."
            ),
        )
    }
}

/// An unknown context size still warns; a small known one does not.
pub fn worth_warning(context_used: Option<u64>) -> bool {
    context_used.is_none_or(|used| used >= MIN_CONTEXT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::TurnMetrics;

    fn turn(completed_at: u64, read: u64, ttl: Option<u64>) -> TurnInfo {
        TurnInfo {
            completed_at: Some(completed_at),
            metrics: Some(TurnMetrics {
                input_tokens: 10,
                cache_read_tokens: read,
                cache_ttl_seconds: ttl,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn the_cache_expires_one_ttl_after_the_last_cached_turn() {
        let turns = HashMap::from([
            (1, turn(1_000, 500, Some(3600))),
            (3, turn(9_000, 900, None)),
            // A turn that read nothing from the cache does not refresh it.
            (5, turn(20_000, 0, None)),
        ]);
        let state = state(&turns).unwrap();
        assert_eq!(state.last_used_at, 9_000);
        assert_eq!(state.expires_at, 9_000 + 3_600_000);
        assert!(!state.expired(state.expires_at - 31_000));
        assert!(state.expired(state.expires_at - 30_000));
        // No reported tier, no guess.
        assert_eq!(super::state(&HashMap::from([(1, turn(1, 5, None))])), None);
    }

    #[test]
    fn claude_reports_its_cache_tier_in_the_write_split() {
        let ttl = |creation: Value| claude_ttl(&serde_json::json!({ "cache_creation": creation }));
        use serde_json::json;
        assert_eq!(
            ttl(json!({"ephemeral_1h_input_tokens":400,"ephemeral_5m_input_tokens":100})),
            Some(3600)
        );
        assert_eq!(
            ttl(json!({"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":500})),
            Some(300)
        );
        assert_eq!(ttl(json!({"ephemeral_1h_input_tokens":0})), None);
    }

    #[test]
    fn the_tooltip_says_what_lapsed_and_what_the_next_message_costs() {
        let state = State {
            ttl_ms: 300_000,
            last_used_at: 0,
            expires_at: 300_000,
        };
        let (headline, detail, consequence) = state.tooltip(3_900_000, Some(84_000));
        assert_eq!(headline, "Prompt cache expired");
        assert_eq!(
            detail,
            "Idle for 1h 5m. The provider keeps this session's cache for 5 minutes after the last request."
        );
        assert!(consequence.contains("about 84K tokens of context"));
        assert!(worth_warning(None) && worth_warning(Some(30_000)) && !worth_warning(Some(29_999)));
    }
}
