//! ContextCacheHit: under the context figures, the ring's popover says how
//! much of the prompt the provider read from its cache and, where the
//! provider says how long it keeps the cache, when that runs out.
use super::*;
use monocode_core::{context::CacheHit, prompt_cache};

pub(super) struct CacheStatus {
    headline: String,
    lines: Vec<String>,
}

impl CacheStatus {
    /// For the meter's label, after the context figures.
    pub(super) fn aria(&self) -> String {
        std::iter::once(self.headline.as_str())
            .chain(self.lines.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(", ")
    }
    pub(super) fn render(self) -> gpui::Div {
        div()
            .debug_selector(|| "context-cache-hit".into())
            .mt(px(6.))
            .flex()
            .flex_col()
            .child(self.headline)
            .children(self.lines.into_iter().map(|line| {
                div()
                    .text_size(px(11.))
                    .text_color(content(0.5))
                    .child(line)
            }))
    }
}

impl Conversation {
    /// Nothing until a turn has reported its cache reads.
    pub(super) fn context_cache_status(&self, cx: &gpui::App) -> Option<CacheStatus> {
        let turns = &self.transcript.read(cx).turns;
        let hit = CacheHit::from_turns(turns)?;
        let mut lines = vec![match hit.session {
            Some(session) => format!("Latest turn · {session:.0}% this session"),
            None => "Latest turn".into(),
        }];
        // Only Claude says how long it keeps the cache; the rest get no guess.
        if self.summary.provider == "claude"
            && !self.busy
            && !self.stopping
            && let Some(state) = prompt_cache::state(turns, &self.summary.provider)
        {
            lines.push(cache_lifetime(&state, monocode_core::time::now_ms()));
        }
        Some(CacheStatus {
            headline: format!("{:.0}% cache hit", hit.latest),
            lines,
        })
    }
}

/// Counted to the moment the expired mark shows beside Send.
fn cache_lifetime(state: &prompt_cache::State, now: u64) -> String {
    if state.expired(now) {
        return "Cache expired".into();
    }
    let left = state.warn_at() - now;
    if left < 60_000 {
        "Cache expires in under a minute".into()
    } else {
        format!(
            "Cache expires in {}",
            monocode_core::usage::duration(left as i64)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monocode_core::agent::{TurnInfo, TurnMetrics};

    fn turn(completed_at: u64, input: u64, read: u64, write: u64, ttl: Option<u64>) -> TurnInfo {
        TurnInfo {
            completed_at: Some(completed_at),
            metrics: Some(TurnMetrics {
                input_tokens: input,
                cache_read_tokens: read,
                cache_write_tokens: write,
                cache_hit_percent: Some(read as f64 / (input + read + write) as f64 * 100.),
                cache_ttl_seconds: ttl,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[gpui::test]
    fn the_context_popover_says_how_much_of_the_prompt_was_cached(cx: &mut gpui::TestAppContext) {
        let store = Arc::new(std::sync::Mutex::new(
            monocode_core::store::Store::open(Path::new(":memory:")).unwrap(),
        ));
        let summary = locked(&store).unwrap().create("claude", "/tmp").unwrap();
        let view = cx.new(|cx| Conversation::new(summary, store.clone(), cx));
        let now = monocode_core::time::now_ms();
        view.update(cx, |v, cx| {
            assert!(v.context_cache_status(cx).is_none(), "no turn has reported");
            v.transcript.update(cx, |t, _| {
                // The first turn writes the cache, for an hour.
                t.turns
                    .insert(1, turn(now - 60_000, 2_000, 0, 10_000, Some(3600)));
            });
            let first = v.context_cache_status(cx).unwrap();
            assert_eq!(first.headline, "0% cache hit");
            assert_eq!(first.lines, ["Latest turn", "Cache expires in 58m"]);
            v.transcript.update(cx, |t, _| {
                t.turns.insert(3, turn(now - 60_000, 500, 9_500, 0, None));
            });
            let status = v.context_cache_status(cx).unwrap();
            assert_eq!(status.headline, "95% cache hit");
            // 9,500 of the 22,000 prompt tokens sent over both turns.
            assert_eq!(status.lines[0], "Latest turn · 43% this session");
            // While a turn runs it uses the cache: no countdown.
            v.busy = true;
            assert_eq!(v.context_cache_status(cx).unwrap().lines.len(), 1);
            // Other providers do not say how long they keep it.
            v.busy = false;
            v.summary.provider = "pi".into();
            assert_eq!(v.context_cache_status(cx).unwrap().lines.len(), 1);
        });
    }

    #[gpui::test]
    fn hovering_the_context_ring_shows_the_cache_hit(cx: &mut gpui::TestAppContext) {
        let store = Arc::new(std::sync::Mutex::new(
            monocode_core::store::Store::open(Path::new(":memory:")).unwrap(),
        ));
        let summary = locked(&store).unwrap().create("dsh", "/tmp").unwrap();
        let window = cx.update(|cx| {
            cx.open_window(Default::default(), |_, cx| {
                cx.new(|cx| Conversation::new(summary, store.clone(), cx))
            })
            .unwrap()
        });
        let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
        let hover = |visual: &mut gpui::VisualTestContext| {
            window
                .update(visual, |v, _, cx| {
                    v.loaded = true;
                    v.context = Some(monocode_core::context::Usage {
                        used: 292_000,
                        window: Some(1_000_000),
                    });
                    v.context_hovered = true;
                    cx.notify();
                })
                .unwrap();
            visual.run_until_parked();
        };
        window
            .update(visual, |v, _, cx| {
                v.transcript.update(cx, |t, _| {
                    t.turns.insert(1, turn(0, 3_000, 30_040, 0, None));
                });
            })
            .unwrap();
        hover(visual);
        assert!(visual.debug_bounds("context-cache-hit").is_some());
        // Until a turn has reported its cache, the popover has only the context.
        window
            .update(visual, |v, _, cx| {
                v.transcript.update(cx, |t, _| t.turns.clear());
            })
            .unwrap();
        hover(visual);
        assert!(visual.debug_bounds("context-cache-hit").is_none());
    }

    #[test]
    fn the_lifetime_counts_down_to_the_expired_mark() {
        let state = prompt_cache::State {
            ttl_ms: 300_000,
            last_used_at: 0,
            expires_at: 300_000,
            estimated: false,
        };
        assert_eq!(cache_lifetime(&state, 0), "Cache expires in 4m");
        assert_eq!(
            cache_lifetime(&state, 230_000),
            "Cache expires in under a minute"
        );
        assert_eq!(cache_lifetime(&state, 270_000), "Cache expired");
    }
}
