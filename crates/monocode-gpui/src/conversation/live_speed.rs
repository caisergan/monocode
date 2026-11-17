//! LiveSpeed: how fast a prompt's reply writes. While the turn runs it reads
//! the stream's own speed; once it ends the turn's average stays until the
//! next prompt, which is measured afresh.
use super::*;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

/// Long enough to smooth a bursty stream, short enough that a pause shows. Three
/// seconds across a stream that arrives in bursts reads steady instead of
/// hopping with every chunk.
const WINDOW: Duration = Duration::from_millis(3000);
/// Below this the reading is one burst, not a speed.
const MEASURED: Duration = Duration::from_millis(500);
/// No bytes for this long is a tool call or a wait, not writing.
const IDLE: Duration = Duration::from_millis(1500);
/// Bytes per token, roughly: the provider counts tokens, the stream arrives in
/// bytes, and four of them make a token of prose or code.
const BYTES_PER_TOKEN: f64 = 4.;
/// The read-out's beat: arrivals land on the spinners' 30 Hz, too fine to read.
const TICK: Duration = Duration::from_millis(250);

/// Sampled on its own beat while a turn runs, in view or not, so the average
/// covers the whole reply and not only what was painted.
#[derive(Default)]
pub(super) struct LiveSpeed {
    /// (arrival, bytes written so far), oldest first, inside the window. The
    /// newest is the last time the reply grew.
    samples: VecDeque<(Instant, usize)>,
    /// The window's speed, or None while the reply is not writing.
    shown: Option<f64>,
    /// What the turn wrote while it was writing, and how long that took: tool
    /// calls and waits are in neither, so the average is the model's own speed.
    written: usize,
    writing: Duration,
    /// Samples while a turn runs.
    timer: Option<gpui::Task<()>>,
}

impl LiveSpeed {
    /// Takes the reply's size now. `bytes` is the model's whole output so far
    /// in this turn.
    fn sample(&mut self, bytes: usize, now: Instant) {
        let Some(&(at, seen)) = self.samples.back() else {
            // Nothing written yet is not a start: the wait for the first byte
            // is not writing time.
            if bytes > 0 {
                self.samples.push_back((now, bytes));
            }
            return;
        };
        let gap = now.duration_since(at);
        if bytes == seen {
            if gap > IDLE {
                // A pause is not writing: the figure goes until bytes arrive.
                self.shown = None;
            }
            return;
        }
        if bytes < seen || gap > IDLE {
            // A rewritten reply, or the first bytes after a pause: when they
            // began is unknown, so they open a new window and count for nothing.
            self.samples.clear();
            self.shown = None;
        } else {
            self.writing += gap;
            self.written += bytes - seen;
        }
        self.samples.push_back((now, bytes));
        while self.samples.len() > 1 && now.duration_since(self.samples[1].0) > WINDOW {
            self.samples.pop_front();
        }
        let (first, start) = self.samples[0];
        let waited = now.duration_since(first);
        // A fresh burst has no window yet: dividing a handful of bytes by a
        // heartbeat is not a speed.
        if waited >= MEASURED {
            self.shown = Some((bytes - start) as f64 / BYTES_PER_TOKEN / waited.as_secs_f64());
        }
    }
    /// The turn so far: what it wrote over the time it spent writing.
    fn average(&self) -> Option<f64> {
        (self.writing >= MEASURED && self.written > 0)
            .then(|| self.written as f64 / BYTES_PER_TOKEN / self.writing.as_secs_f64())
    }
    /// What the footer reads while the turn runs: the speed now, and the
    /// turn's average while a tool call or a wait holds the writing.
    fn reading(&self) -> Option<f64> {
        self.shown.or_else(|| self.average())
    }
    fn clear(&mut self) {
        self.samples.clear();
        self.shown = None;
        self.written = 0;
        self.writing = Duration::ZERO;
    }
}

/// The figure as the footer writes it.
pub(super) fn speed_label(rate: f64) -> String {
    if rate < 10. {
        format!("{rate:.1} tok/s")
    } else {
        format!("{rate:.0} tok/s")
    }
}

impl Conversation {
    /// The figure the footer shows, and whether it is live: the running
    /// reply's speed while a prompt is answered, that prompt's average once it
    /// is, until the next prompt.
    pub(super) fn speed_read_out(&self, cx: &Context<Self>) -> Option<(f64, bool)> {
        if self.responding() {
            return self.live_speed.reading().map(|rate| (rate, true));
        }
        // A message steered into a turn has a receipt of its own with no
        // clock: the turn it joined is the one that was measured.
        let transcript = self.transcript.read(cx);
        let (at, turn) = transcript
            .turns
            .iter()
            .filter(|(_, turn)| turn.joined_turn.is_none())
            .max_by_key(|(at, _)| **at)?;
        if let Some(rate) = turn.output_rate {
            return Some((rate, false));
        }
        // A turn that was not measured as it streamed, an older one or a
        // reply that came whole: its output over its run, tool time included,
        // as its own tooltip counts it.
        if turn.duration_ms == 0 {
            return None;
        }
        let output = turn
            .metrics
            .map(|metrics| metrics.output_tokens)
            .filter(|tokens| *tokens > 0)
            .unwrap_or_else(|| (transcript.turn_output_bytes(*at) as u64).div_ceil(4));
        (output > 0).then(|| (output as f64 / (turn.duration_ms as f64 / 1000.), false))
    }
    /// A prompt went out: measure its reply from nothing, on the read-out's
    /// own beat.
    pub(super) fn begin_live_speed(&mut self, cx: &mut Context<Self>) {
        self.live_speed.clear();
        self.live_speed.timer = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                let running = this
                    .update(cx, |this, cx| {
                        if !this.responding() {
                            return false;
                        }
                        let before = this.live_speed.reading().map(speed_label);
                        let bytes = this.transcript.read(cx).live_output_bytes();
                        this.live_speed.sample(bytes, Instant::now());
                        if this.live_speed.reading().map(speed_label) != before {
                            cx.notify();
                        }
                        true
                    })
                    .unwrap_or(false);
                if !running {
                    break;
                }
            }
        }));
    }
    /// The turn ended: its average, for its receipt. None when nothing was
    /// measured, which a second call after a stop always is.
    pub(super) fn end_live_speed(&mut self) -> Option<f64> {
        let average = self.live_speed.average();
        self.live_speed.clear();
        self.live_speed.timer = None;
        average
    }
    /// Keeps the turn's measured average on its receipt, where the footer
    /// reads it until the next prompt and after a restart.
    pub(super) fn record_live_speed(&mut self, cx: &mut Context<Self>) {
        let Some(rate) = self.end_live_speed() else {
            return;
        };
        self.transcript.update(cx, |view, _| {
            if let Some(turn) = view.active_turn()
                && let Some(info) = view.turns.get_mut(&turn)
            {
                info.output_rate = Some(rate);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds bytes the way the sampler sees a stream: a little, every tick.
    fn stream(speed: &mut LiveSpeed, from: usize, to: usize, at: &mut Instant, step: usize) {
        let mut bytes = from;
        while bytes < to {
            bytes = (bytes + step).min(to);
            *at += TICK;
            speed.sample(bytes, *at);
        }
    }

    #[test]
    fn the_rate_is_the_window_and_a_pause_hides_it() {
        let mut speed = LiveSpeed::default();
        let mut at = Instant::now();
        // 1,000 bytes a second is 250 tokens a second.
        stream(&mut speed, 0, 4_000, &mut at, 250);
        let rate = speed.shown.expect("a window of arrivals");
        assert!((235. ..=265.).contains(&rate), "got {rate}");
        // A tool call writes nothing, so the live figure goes and stays gone
        // on every beat of the pause, not only the first.
        for _ in 0..12 {
            at += TICK;
            speed.sample(4_000, at);
            if at.duration_since(speed.samples.back().unwrap().0) > IDLE {
                assert_eq!(speed.shown, None, "a stale speed came back in the pause");
            }
        }
        assert_eq!(speed.shown, None);
        // The turn's average holds the footer meanwhile.
        let average = speed.reading().expect("the turn so far");
        assert!((235. ..=265.).contains(&average), "got {average}");
        // Writing again reads the new burst, not the pause before it.
        stream(&mut speed, 4_000, 7_000, &mut at, 250);
        let rate = speed.shown.expect("the second burst");
        assert!((235. ..=265.).contains(&rate), "got {rate}");
    }

    #[test]
    fn the_average_is_writing_time_and_each_prompt_starts_over() {
        let mut speed = LiveSpeed::default();
        let mut at = Instant::now();
        // Five seconds before the first byte, then 250 tok/s for four seconds.
        for _ in 0..20 {
            at += TICK;
            speed.sample(0, at);
        }
        assert_eq!(speed.reading(), None, "waiting is not a speed");
        stream(&mut speed, 0, 4_000, &mut at, 250);
        // A thirty second tool call, then a slower stretch: 125 tok/s for four seconds.
        for _ in 0..120 {
            at += TICK;
            speed.sample(4_000, at);
        }
        stream(&mut speed, 4_000, 6_000, &mut at, 125);
        // 6,000 bytes less the two opening samples, over the writing alone:
        // near 190 tok/s, where the whole 43 s run would say 35.
        let average = speed.average().expect("a measured turn");
        assert!((170. ..=200.).contains(&average), "got {average}");
        // The next prompt is measured from nothing.
        speed.clear();
        assert_eq!(speed.reading(), None);
        assert_eq!(speed.average(), None);
        stream(&mut speed, 0, 2_000, &mut at, 125);
        let average = speed.average().expect("the new prompt's own figure");
        assert!((115. ..=135.).contains(&average), "got {average}");
    }

    #[test]
    fn a_reply_that_comes_whole_has_no_speed() {
        let mut speed = LiveSpeed::default();
        let mut at = Instant::now();
        at += TICK;
        speed.sample(0, at);
        at += Duration::from_secs(8);
        speed.sample(9_000, at);
        at += TICK;
        speed.sample(9_000, at);
        assert_eq!(speed.reading(), None);
        assert_eq!(speed.average(), None);
    }

    #[gpui::test]
    fn the_footer_keeps_a_prompts_average_until_the_next_prompt(cx: &mut gpui::TestAppContext) {
        use monocode_core::agent::{TurnInfo, TurnMetrics};
        use monocode_core::transcript::Row;
        let store = Arc::new(std::sync::Mutex::new(
            monocode_core::store::Store::open(Path::new(":memory:")).unwrap(),
        ));
        let summary = locked(&store).unwrap().create("hermes", "/tmp").unwrap();
        let view = cx.new(|cx| Conversation::new(summary, store.clone(), cx));
        let row = |role: &str, bytes: usize| Row {
            role: role.into(),
            text: "x".repeat(bytes),
            first: true,
            sent_at: None,
        };
        view.update(cx, |v, cx| {
            v.loaded = true;
            v.busy = true;
            // The provider starts before its prompt arrives.
            v.transcript.update(cx, |t, cx| {
                t.streaming(true, cx);
                t.patch(0, vec![row("user", 10)], cx);
            });
            // A turn that just began has nothing to divide yet.
            assert!(v.speed_read_out(cx).is_none());
            let mut at = Instant::now();
            for bytes in (500..=4_000).step_by(250) {
                at += TICK;
                v.live_speed.sample(bytes, at);
            }
            let (rate, live) = v.speed_read_out(cx).expect("a figure while it writes");
            assert!(live, "the running reply's own speed");
            assert!((235. ..=265.).contains(&rate), "got {rate}");
            // The turn ends: its average goes on its receipt and stays.
            v.busy = false;
            v.transcript.update(cx, |t, cx| {
                t.patch(1, vec![row("assistant", 4_000)], cx);
                t.streaming(false, cx);
            });
            v.record_live_speed(cx);
            let (average, live) = v.speed_read_out(cx).expect("the finished prompt's average");
            assert!(!live);
            assert!((235. ..=265.).contains(&average), "got {average}");
            // Ending twice, as a stop and then the provider's own end do,
            // does not wipe it.
            v.record_live_speed(cx);
            assert_eq!(v.speed_read_out(cx), Some((average, false)));
            // A message steered into that turn has a clockless receipt after
            // it: the footer still reads the turn that was measured.
            v.transcript.update(cx, |t, _| {
                let root = *t.turns.keys().max().unwrap();
                t.turns.insert(
                    root + 5,
                    TurnInfo {
                        joined_turn: Some(root),
                        ..Default::default()
                    },
                );
            });
            assert_eq!(v.speed_read_out(cx), Some((average, false)));
            // The next prompt starts from nothing, whatever the last one read.
            v.busy = true;
            v.begin_live_speed(cx);
            assert!(v.speed_read_out(cx).is_none());
            v.busy = false;
            // A turn nobody measured as it streamed is counted by its provider:
            // output over the run.
            v.transcript.update(cx, |t, _| {
                t.turns.clear();
                t.turns.insert(
                    1,
                    TurnInfo {
                        duration_ms: 20_000,
                        metrics: Some(TurnMetrics {
                            output_tokens: 5_000,
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                );
            });
            assert_eq!(v.speed_read_out(cx), Some((250., false)));
            // And one with no metrics by the text it wrote: 4,000 bytes in 4 s.
            v.transcript.update(cx, |t, _| {
                t.turns.insert(
                    1,
                    TurnInfo {
                        duration_ms: 4_000,
                        ..Default::default()
                    },
                );
            });
            assert_eq!(v.speed_read_out(cx), Some((250., false)));
        });
    }
}
