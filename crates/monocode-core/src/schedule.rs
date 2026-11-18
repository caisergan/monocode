//! Send later: the times a composer message can wait for, typed or picked,
//! and the app-wide index of chats holding a scheduled message.
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, TimeZone, Weekday};
use std::collections::BTreeMap;

/// A message this late was due while MonoCode was closed or the Mac slept.
/// It waits for the user instead of sending a stale prompt.
pub const MISSED_AFTER_MS: u64 = 10 * 60_000;
/// "After the usage limit resets" waits this long past the reset, so the
/// message never races the provider's own window rollover.
pub const AFTER_RESET_MS: u64 = 60_000;
const INDEX: &str = "scheduled-sends";

pub fn missed(send_at: u64, now: u64) -> bool {
    now > send_at.saturating_add(MISSED_AFTER_MS)
}

/// A usage window's next reset, and the row that offers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reset {
    pub at: u64,
    pub label: String,
}
impl Reset {
    /// The chat has hit its limit: the reset it waits for.
    pub fn limit(at: u64) -> Self {
        Self {
            at,
            label: "After the usage limit resets".into(),
        }
    }
    /// Before any limit: an exhausted window's reset, or else the shortest
    /// window's, so a message can go out as soon as fresh usage arrives.
    pub fn from_usage(snapshot: &crate::usage::Snapshot, now: u64) -> Option<Self> {
        if let Some(at) = snapshot.exhausted_reset().filter(|at| *at > now as i64) {
            return Some(Self::limit(at as u64));
        }
        let window = snapshot
            .windows
            .iter()
            .filter(|w| w.resets_at.is_some_and(|at| at > now as i64))
            .min_by_key(|w| w.minutes)?;
        let name = match window.minutes {
            300 => "5-hour".to_owned(),
            1_440 => "daily".into(),
            10_080 => "weekly".into(),
            43_200 => "monthly".into(),
            _ => window.label(),
        };
        Some(Self {
            at: window.resets_at? as u64,
            label: format!("When the {name} limit resets"),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub id: String,
    pub label: String,
    /// Epoch milliseconds.
    pub at: u64,
}

fn ms<Tz: TimeZone>(at: &DateTime<Tz>) -> u64 {
    at.timestamp_millis().max(0) as u64
}
fn local_at<Tz: TimeZone>(tz: &Tz, date: NaiveDate, time: NaiveTime) -> Option<DateTime<Tz>> {
    let naive = date.and_time(time);
    // A spring-forward gap resolves to the first valid minute after it.
    (0..=180).find_map(|gap| {
        tz.from_local_datetime(&(naive + Duration::minutes(gap)))
            .earliest()
    })
}
/// Rounded up to the next whole minute, so the time shown is when it fires.
fn ceil_minute<Tz: TimeZone>(at: DateTime<Tz>) -> DateTime<Tz> {
    let rest = at.timestamp_millis().rem_euclid(60_000);
    if rest == 0 {
        at
    } else {
        at + Duration::milliseconds(60_000 - rest)
    }
}
fn from_ms<Tz: TimeZone>(tz: &Tz, at: u64) -> DateTime<Tz> {
    tz.timestamp_millis_opt(at as i64)
        .single()
        .unwrap_or_else(|| tz.timestamp_millis_opt(0).unwrap())
}

/// The menu's quick picks. The usage row appears only with a known reset.
pub fn presets<Tz: TimeZone>(now: &DateTime<Tz>, reset: Option<Reset>) -> Vec<Choice> {
    let tz = now.timezone();
    let today = now.date_naive();
    let mut out = vec![
        Choice {
            id: "in-30m".into(),
            label: "In 30 minutes".into(),
            at: ms(&ceil_minute(now.clone() + Duration::minutes(30))),
        },
        Choice {
            id: "in-1h".into(),
            label: "In 1 hour".into(),
            at: ms(&ceil_minute(now.clone() + Duration::hours(1))),
        },
        Choice {
            id: "in-3h".into(),
            label: "In 3 hours".into(),
            at: ms(&ceil_minute(now.clone() + Duration::hours(3))),
        },
    ];
    let hm = |h, m| NaiveTime::from_hms_opt(h, m, 0).unwrap();
    if let Some(evening) = local_at(&tz, today, hm(18, 0))
        .filter(|at| *at > now.clone() + Duration::hours(3) + Duration::minutes(30))
    {
        out.push(Choice {
            id: "evening".into(),
            label: "This evening".into(),
            at: ms(&evening),
        });
    }
    let early = now.time() < hm(5, 0);
    let morning_day = if early {
        today
    } else {
        today.succ_opt().unwrap_or(today)
    };
    if let Some(morning) = local_at(&tz, morning_day, hm(9, 0)) {
        out.push(Choice {
            id: "morning".into(),
            label: if early {
                "This morning"
            } else {
                "Tomorrow morning"
            }
            .into(),
            at: ms(&morning),
        });
    }
    if matches!(today.weekday(), Weekday::Fri | Weekday::Sat) {
        let ahead = 7 - today.weekday().num_days_from_monday() as i64;
        if let Some(monday) = local_at(&tz, today + Duration::days(ahead), hm(9, 0)) {
            out.push(Choice {
                id: "monday".into(),
                label: "Monday morning".into(),
                at: ms(&monday),
            });
        }
    }
    if let Some(reset) = reset.filter(|reset| reset.at > ms(now)) {
        out.push(Choice {
            id: "limit-reset".into(),
            label: reset.label,
            at: reset.at + AFTER_RESET_MS,
        });
    }
    out
}

/// What a typed time can mean, soonest first. Empty when it reads as nothing.
/// Understands "in 2h", "45m", "18:30", "6pm", "tomorrow 9", "thu 9am",
/// "monday evening", "19 nov 14:00", "19.11 9:30" and "2026-11-19 09:00".
pub fn parse<Tz: TimeZone>(text: &str, now: &DateTime<Tz>) -> Vec<Choice> {
    let text = text.trim().to_lowercase().replace(',', " ");
    if text.is_empty() {
        return Vec::new();
    }
    if let Some(after) = duration(&text) {
        if after <= Duration::zero() {
            return Vec::new();
        }
        return vec![Choice {
            id: "typed:0".into(),
            label: format!("In {}", spoken(after)),
            at: ms(&ceil_minute(now.clone() + after)),
        }];
    }
    let Some((day, times)) = absolute(&text, now) else {
        return Vec::new();
    };
    let tz = now.timezone();
    let today = now.date_naive();
    let mut found: Vec<DateTime<Tz>> = Vec::new();
    for time in times {
        let dates: Vec<NaiveDate> = match day {
            Day::Any => vec![today, today + Duration::days(1)],
            Day::Date(date) => vec![date],
            Day::Weekday(weekday) => {
                let ahead = (weekday.num_days_from_monday() as i64
                    - today.weekday().num_days_from_monday() as i64)
                    .rem_euclid(7);
                vec![
                    today + Duration::days(ahead),
                    today + Duration::days(ahead + 7),
                ]
            }
        };
        if let Some(at) = dates
            .into_iter()
            .filter_map(|date| local_at(&tz, date, time))
            .find(|at| at > now)
        {
            found.push(at);
        }
    }
    found.sort();
    found.dedup();
    found
        .into_iter()
        .enumerate()
        .map(|(ix, at)| Choice {
            id: format!("typed:{ix}"),
            label: day_name(&at, now),
            at: ms(&at),
        })
        .collect()
}

#[derive(Clone, Copy)]
enum Day {
    Any,
    Date(NaiveDate),
    Weekday(Weekday),
}

fn duration(text: &str) -> Option<Duration> {
    let text = text.strip_prefix("in ").unwrap_or(text).trim();
    let text = text
        .strip_prefix("an ")
        .or_else(|| text.strip_prefix("a "))
        .map_or_else(|| text.to_owned(), |rest| format!("1 {rest}"));
    let mut total = Duration::zero();
    let mut number: Option<f64> = None;
    let mut any = false;
    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() || c == '+' {
            chars.next();
        } else if c.is_ascii_digit() || c == '.' {
            let mut digits = String::new();
            while let Some(&c) = chars.peek().filter(|c| c.is_ascii_digit() || **c == '.') {
                digits.push(c);
                chars.next();
            }
            if number.is_some() {
                return None;
            }
            number = Some(digits.parse().ok()?);
        } else if c.is_alphabetic() {
            let mut word = String::new();
            while let Some(&c) = chars.peek().filter(|c| c.is_alphabetic()) {
                word.push(c);
                chars.next();
            }
            if word == "and" {
                continue;
            }
            let minutes = match word.as_str() {
                "m" | "min" | "mins" | "minute" | "minutes" => 1.,
                "h" | "hr" | "hrs" | "hour" | "hours" => 60.,
                "d" | "day" | "days" => 1440.,
                "w" | "wk" | "week" | "weeks" => 10080.,
                _ => return None,
            };
            total += Duration::seconds((number.take()? * minutes * 60.).round() as i64);
            any = true;
        } else {
            return None;
        }
    }
    (any && number.is_none()).then_some(total)
}

fn spoken(after: Duration) -> String {
    let minutes = after.num_minutes();
    let part = |n: i64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    let (days, hours, mins) = (minutes / 1440, minutes % 1440 / 60, minutes % 60);
    [(days, "day"), (hours, "hour"), (mins, "minute")]
        .into_iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, unit)| part(n, unit))
        .collect::<Vec<_>>()
        .join(" ")
}

fn weekday(word: &str) -> Option<Weekday> {
    Some(match word {
        "mon" | "monday" => Weekday::Mon,
        "tue" | "tues" | "tuesday" => Weekday::Tue,
        "wed" | "weds" | "wednesday" => Weekday::Wed,
        "thu" | "thur" | "thurs" | "thursday" => Weekday::Thu,
        "fri" | "friday" => Weekday::Fri,
        "sat" | "saturday" => Weekday::Sat,
        "sun" | "sunday" => Weekday::Sun,
        _ => return None,
    })
}
fn month(word: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let word = word.get(..3)?;
    MONTHS.iter().position(|m| *m == word).map(|i| i as u32 + 1)
}

/// A date for day and month, this year or next when it has passed.
fn day_month<Tz: TimeZone>(day: u32, month: u32, now: &DateTime<Tz>) -> Option<NaiveDate> {
    let today = now.date_naive();
    let this = NaiveDate::from_ymd_opt(today.year(), month, day)?;
    if this < today {
        NaiveDate::from_ymd_opt(today.year() + 1, month, day)
    } else {
        Some(this)
    }
}

/// Clock readings for a token: "9" means 09:00 or 21:00, "9pm" only 21:00.
fn clock(token: &str, meridiem: Option<&str>) -> Option<Vec<NaiveTime>> {
    let (body, suffix) = match token.strip_suffix("am").or_else(|| token.strip_suffix("a")) {
        Some(body) if !body.is_empty() => (body, Some("am")),
        _ => match token.strip_suffix("pm").or_else(|| token.strip_suffix("p")) {
            Some(body) if !body.is_empty() => (body, Some("pm")),
            _ => (token, meridiem),
        },
    };
    let (hour, minute) = match body.split_once([':', '.']) {
        Some((h, m)) if m.len() == 2 => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        Some(_) => return None,
        None if body.len() <= 2 => (body.parse::<u32>().ok()?, 0),
        None => return None,
    };
    if minute > 59 {
        return None;
    }
    let time = |h| NaiveTime::from_hms_opt(h, minute, 0);
    match suffix {
        Some(half) => {
            if !(1..=12).contains(&hour) {
                return None;
            }
            let hour = hour % 12 + if half == "pm" { 12 } else { 0 };
            Some(vec![time(hour)?])
        }
        // "09:00" and "18" are already 24-hour; a bare "7" may be either.
        None if hour >= 13 || body.starts_with('0') => Some(vec![time(hour)?]),
        None if hour == 12 => Some(vec![time(12)?]),
        None if (1..=11).contains(&hour) => Some(vec![time(hour)?, time(hour + 12)?]),
        None if hour == 0 => Some(vec![time(0)?]),
        None => None,
    }
}

fn absolute<Tz: TimeZone>(text: &str, now: &DateTime<Tz>) -> Option<(Day, Vec<NaiveTime>)> {
    let tokens: Vec<&str> = text
        .split_whitespace()
        .filter(|t| !matches!(*t, "at" | "on" | "next" | "this" | "the"))
        .collect();
    let today = now.date_naive();
    let hm = |h, m| NaiveTime::from_hms_opt(h, m, 0).unwrap();
    let mut day = Day::Any;
    let mut day_set = false;
    let mut times: Option<Vec<NaiveTime>> = None;
    let mut part: Option<NaiveTime> = None;
    let mut i = 0;
    let mut set_day = |value: Day, day_set: &mut bool| -> Option<()> {
        if std::mem::replace(day_set, true) {
            return None;
        }
        day = value;
        Some(())
    };
    while i < tokens.len() {
        let token = tokens[i];
        let next = tokens.get(i + 1).copied();
        let meridiem = next.filter(|n| matches!(*n, "am" | "pm"));
        if matches!(token, "am" | "pm") {
            i += 1;
            continue;
        }
        if let Some(rest) = token
            .strip_suffix("th")
            .or_else(|| token.strip_suffix("st"))
            .or_else(|| token.strip_suffix("nd"))
            .or_else(|| token.strip_suffix("rd"))
            .filter(|rest| rest.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty())
        {
            // "19th nov" / "nov 19th".
            let day_number: u32 = rest.parse().ok()?;
            let month_word = next.and_then(month).map(|m| (m, 2)).or_else(|| {
                i.checked_sub(1)
                    .and_then(|p| month(tokens[p]))
                    .map(|m| (m, 1))
            })?;
            set_day(
                Day::Date(day_month(day_number, month_word.0, now)?),
                &mut day_set,
            )?;
            i += month_word.1;
            continue;
        }
        match token {
            "today" => set_day(Day::Date(today), &mut day_set)?,
            "tonight" => {
                set_day(Day::Date(today), &mut day_set)?;
                part = Some(hm(20, 0));
            }
            "tomorrow" | "tmr" | "tmrw" | "tomorow" => {
                set_day(Day::Date(today + Duration::days(1)), &mut day_set)?
            }
            "morning" => part = Some(hm(9, 0)),
            "noon" | "midday" => times = Some(vec![hm(12, 0)]),
            "afternoon" => part = Some(hm(14, 0)),
            "evening" => part = Some(hm(18, 0)),
            "night" => part = Some(hm(21, 0)),
            "midnight" => {
                times = Some(vec![hm(0, 0)]);
                if !day_set {
                    set_day(Day::Date(today + Duration::days(1)), &mut day_set)?;
                }
            }
            _ => {
                if let Some(weekday) = weekday(token) {
                    set_day(Day::Weekday(weekday), &mut day_set)?;
                } else if let Some(m) = month(token).filter(|_| token.len() >= 3) {
                    // "nov 19".
                    let day_number: u32 =
                        next?.trim_end_matches(char::is_alphabetic).parse().ok()?;
                    set_day(Day::Date(day_month(day_number, m, now)?), &mut day_set)?;
                    i += 1;
                } else if let Some(m) = next
                    .and_then(month)
                    .filter(|_| token.chars().all(|c| c.is_ascii_digit()) && token.len() <= 2)
                {
                    // "19 nov".
                    set_day(
                        Day::Date(day_month(token.parse().ok()?, m, now)?),
                        &mut day_set,
                    )?;
                    i += 1;
                } else if token.len() == 10 && token.as_bytes()[4] == b'-' {
                    let date = NaiveDate::parse_from_str(token, "%Y-%m-%d").ok()?;
                    set_day(Day::Date(date), &mut day_set)?;
                } else if let Some((d, m)) = token
                    .split_once(['/', '.'])
                    .filter(|(d, m)| d.len() <= 2 && m.len() <= 2 && !m.is_empty())
                    .and_then(|(d, m)| Some((d.parse::<u32>().ok()?, m.parse::<u32>().ok()?)))
                    .filter(|_| times.is_some() || next.is_some() || token.contains('/'))
                    .filter(|(_, m)| *m <= 12 && !token.contains(':'))
                    .filter(|_| {
                        token.contains('/') || next.is_some_and(|n| clock(n, None).is_some())
                    })
                {
                    // "19/11" and "19.11 9:30" are day, month.
                    set_day(Day::Date(day_month(d, m, now)?), &mut day_set)?;
                } else if times.is_none() {
                    times = Some(clock(token, meridiem)?);
                    if meridiem.is_some() {
                        i += 1;
                    }
                } else {
                    return None;
                }
            }
        }
        i += 1;
    }
    let times = match (times, part) {
        (Some(times), Some(part)) => {
            // "7 evening": keep the reading that fits the part of the day.
            let fits: Vec<_> = times
                .iter()
                .copied()
                .filter(|t| (*t >= hm(12, 0)) == (part >= hm(12, 0)))
                .collect();
            if fits.is_empty() {
                times
            } else {
                fits
            }
        }
        (Some(times), None) => times,
        (None, Some(part)) => vec![part],
        (None, None) if day_set => {
            // A bare day means its morning; "today" alone means this evening.
            match day {
                Day::Date(date) if date == today => vec![hm(18, 0)],
                _ => vec![hm(9, 0)],
            }
        }
        (None, None) => return None,
    };
    Some((day, times))
}

fn day_name<Tz: TimeZone>(at: &DateTime<Tz>, now: &DateTime<Tz>) -> String {
    let date = at.date_naive();
    let today = now.date_naive();
    if date == today {
        "Today".into()
    } else if date == today + Duration::days(1) {
        "Tomorrow".into()
    } else if date.year() == today.year() {
        format!("{}", date.format("%A %-d %b"))
    } else {
        format!("{}", date.format("%A %-d %b %Y"))
    }
}

/// The compact time for a menu value: "14:30", "Thu 09:00", "19 Nov 09:00".
pub fn short<Tz: TimeZone>(at: u64, now: &DateTime<Tz>) -> String {
    let at = from_ms(&now.timezone(), at);
    let (date, today) = (at.date_naive(), now.date_naive());
    let time = at.time().format("%H:%M");
    if date == today {
        format!("{time}")
    } else if date > today && date < today + Duration::days(7) {
        format!("{} {time}", date.format("%a"))
    } else if date.year() == today.year() {
        format!("{} {time}", date.format("%-d %b"))
    } else {
        format!("{} {time}", date.format("%-d %b %Y"))
    }
}
/// The time on the composer pill and queue row: "Tomorrow 09:00".
pub fn label<Tz: TimeZone>(at: u64, now: &DateTime<Tz>) -> String {
    let local = from_ms(&now.timezone(), at);
    if local.date_naive() == now.date_naive() + Duration::days(1) {
        format!("Tomorrow {}", local.time().format("%H:%M"))
    } else if local.date_naive() == now.date_naive() {
        format!("Today {}", local.time().format("%H:%M"))
    } else {
        short(at, now)
    }
}
/// "in 5m", "in 2h 10m", "in 3d".
pub fn countdown(at: u64, now: u64) -> String {
    let minutes = at.saturating_sub(now).div_ceil(60_000);
    if minutes < 60 {
        format!("in {}m", minutes.max(1))
    } else if minutes < 24 * 60 {
        let (h, m) = (minutes / 60, minutes % 60);
        if h >= 10 || m == 0 {
            format!("in {h}h")
        } else {
            format!("in {h}h {m}m")
        }
    } else {
        format!("in {}d", (minutes + 12 * 60) / (24 * 60))
    }
}

pub fn presets_now(reset: Option<Reset>) -> Vec<Choice> {
    presets(&Local::now(), reset)
}
pub fn parse_now(text: &str) -> Vec<Choice> {
    parse(text, &Local::now())
}
pub fn short_now(at: u64) -> String {
    short(at, &Local::now())
}
pub fn label_now(at: u64) -> String {
    label(at, &Local::now())
}

impl crate::store::Store {
    /// Each chat holding a scheduled message, with its earliest send time.
    pub fn scheduled_sends(&self) -> Result<BTreeMap<i64, u64>, String> {
        Ok(self
            .setting(INDEX)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }
    pub fn set_scheduled_send(&self, session: i64, earliest: Option<u64>) -> Result<(), String> {
        let mut index = self.scheduled_sends()?;
        let changed = match earliest {
            Some(at) => index.insert(session, at) != Some(at),
            None => index.remove(&session).is_some(),
        };
        if !changed {
            return Ok(());
        }
        self.save_setting(
            INDEX,
            &serde_json::to_string(&index).map_err(|e| e.to_string())?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    /// Wednesday 18 November 2026, 10:43:20 at UTC+3.
    fn now() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(3 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 11, 18, 10, 43, 20)
            .unwrap()
    }
    fn when(choice: &Choice) -> String {
        let at = from_ms(&now().timezone(), choice.at);
        at.format("%a %d %H:%M").to_string()
    }
    fn read(text: &str) -> Vec<String> {
        parse(text, &now()).iter().map(when).collect()
    }

    #[test]
    fn presets_round_up_and_offer_the_limit_reset_a_minute_late() {
        let reset = ms(&now()) + 3 * 3_600_000;
        let presets = presets(&now(), Some(Reset::limit(reset)));
        let labels: Vec<_> = presets
            .iter()
            .map(|c| (c.label.as_str(), when(c)))
            .collect();
        assert_eq!(
            labels,
            vec![
                ("In 30 minutes", "Wed 18 11:14".into()),
                ("In 1 hour", "Wed 18 11:44".into()),
                ("In 3 hours", "Wed 18 13:44".into()),
                ("This evening", "Wed 18 18:00".into()),
                ("Tomorrow morning", "Thu 19 09:00".into()),
                ("After the usage limit resets", "Wed 18 13:44".into()),
            ]
        );
        assert_eq!(presets.last().unwrap().at, reset + 60_000);
        assert!(super::presets(&now(), Some(Reset::limit(ms(&now()) - 1)))
            .iter()
            .all(|c| c.id != "limit-reset"));
    }

    #[test]
    fn usage_offers_an_exhausted_window_first_then_the_shortest_one() {
        use crate::usage::{Snapshot, Window};
        let base = ms(&now());
        let window = |minutes, used_percent, after: u64| Window {
            used_percent,
            minutes,
            resets_at: Some((base + after) as i64),
        };
        let mut snapshot = Snapshot {
            windows: vec![
                window(10_080, 40., 4 * 86_400_000),
                window(300, 62., 2 * 3_600_000),
            ],
            ..Default::default()
        };
        let reset = Reset::from_usage(&snapshot, base).unwrap();
        assert_eq!(reset.label, "When the 5-hour limit resets");
        assert_eq!(reset.at, base + 2 * 3_600_000);
        let row = super::presets(&now(), Some(reset)).pop().unwrap();
        assert_eq!(row.at, base + 2 * 3_600_000 + AFTER_RESET_MS);
        snapshot.windows[0].used_percent = 100.;
        let reset = Reset::from_usage(&snapshot, base).unwrap();
        assert_eq!(reset.label, "After the usage limit resets");
        assert_eq!(reset.at, base + 4 * 86_400_000);
        // A snapshot whose resets have all passed offers nothing.
        assert!(Reset::from_usage(&snapshot, base + 5 * 86_400_000).is_none());
    }

    #[test]
    fn reads_relative_and_clock_times() {
        assert_eq!(read("in 2h"), ["Wed 18 12:44"]);
        assert_eq!(read("45m"), ["Wed 18 11:29"]);
        assert_eq!(read("in an hour"), ["Wed 18 11:44"]);
        assert_eq!(read("1h 30m"), ["Wed 18 12:14"]);
        assert_eq!(read("18:30"), ["Wed 18 18:30"]);
        assert_eq!(read("6pm"), ["Wed 18 18:00"]);
        assert_eq!(read("9am"), ["Thu 19 09:00"]);
        // A bare hour can be either half of the day.
        assert_eq!(read("7"), ["Wed 18 19:00", "Thu 19 07:00"]);
        assert_eq!(read("10:30"), ["Wed 18 22:30", "Thu 19 10:30"]);
        assert_eq!(read("09:00"), ["Thu 19 09:00"]);
    }

    #[test]
    fn reads_days_dates_and_parts_of_the_day() {
        assert_eq!(read("tomorrow"), ["Thu 19 09:00"]);
        assert_eq!(read("tomorrow 7"), ["Thu 19 07:00", "Thu 19 19:00"]);
        assert_eq!(read("thu 9am"), ["Thu 19 09:00"]);
        assert_eq!(read("friday evening"), ["Fri 20 18:00"]);
        assert_eq!(read("tonight"), ["Wed 18 20:00"]);
        assert_eq!(read("wed 9am"), ["Wed 25 09:00"]);
        assert_eq!(read("wed 14:00"), ["Wed 18 14:00"]);
        assert_eq!(read("19 nov 14:00"), ["Thu 19 14:00"]);
        assert_eq!(read("nov 20 at 9:30am"), ["Fri 20 09:30"]);
        assert_eq!(read("19.11 9:30"), ["Thu 19 09:30", "Thu 19 21:30"]);
        assert_eq!(read("2026-11-21 08:15"), ["Sat 21 08:15"]);
        assert_eq!(read("7 evening"), ["Wed 18 19:00"]);
    }

    #[test]
    fn rejects_nonsense_and_the_past() {
        for text in [
            "",
            "soon",
            "25:00",
            "tomorrow friday",
            "in -2h",
            "2026-11-01 09:00",
            "hello 9",
        ] {
            assert!(read(text).is_empty(), "{text}");
        }
    }

    #[test]
    fn labels_and_countdowns() {
        let base = ms(&now());
        assert_eq!(short(base + 3_600_000, &now()), "11:43");
        assert_eq!(label(base + 23 * 3_600_000, &now()), "Tomorrow 09:43");
        assert_eq!(short(base + 2 * 86_400_000, &now()), "Fri 10:43");
        assert_eq!(short(base + 10 * 86_400_000, &now()), "28 Nov 10:43");
        assert_eq!(countdown(base + 30_000, base), "in 1m");
        assert_eq!(countdown(base + 90 * 60_000, base), "in 1h 30m");
        assert_eq!(countdown(base + 22 * 3_600_000, base), "in 22h");
        assert_eq!(countdown(base + 60 * 3_600_000, base), "in 3d");
        assert!(!missed(base, base + MISSED_AFTER_MS));
        assert!(missed(base, base + MISSED_AFTER_MS + 1));
    }

    #[test]
    fn the_index_tracks_each_chat_once() {
        let store = crate::store::Store::open(std::path::Path::new(":memory:")).unwrap();
        store.set_scheduled_send(4, Some(10)).unwrap();
        store.set_scheduled_send(9, Some(5)).unwrap();
        store.set_scheduled_send(4, Some(12)).unwrap();
        assert_eq!(
            store
                .scheduled_sends()
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            vec![(4, 12), (9, 5)]
        );
        store.set_scheduled_send(9, None).unwrap();
        assert_eq!(store.scheduled_sends().unwrap().len(), 1);
    }
}
