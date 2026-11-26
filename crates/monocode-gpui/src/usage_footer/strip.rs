//! The footer's usage row: a chip for every provider turned on in Settings,
//! whatever harness the open tab runs, plus the open tab's own provider.
use super::*;
use crate::settings::Preferences;
use gpui::{Entity, Task};
use monocode_core::accounts::Profile;

/// Providers the footer can read usage for.
pub(super) fn reports_usage(kind: Kind) -> bool {
    kind.subscription_usage()
        || matches!(kind, Kind::Devin | Kind::OpenCode | Kind::Pi | Kind::Hermes)
}

pub(crate) struct UsageStrip {
    /// The open tab's provider and context; its chip shows that tab's account
    /// and model, the others the project's selected account and default model.
    active: Kind,
    profile: Profile,
    model: Option<String>,
    project: String,
    session: Option<i64>,
    chips: Vec<(Kind, Entity<UsageFooter>)>,
    /// A chip hidden for want of usage is not drawn, so its own notify
    /// cannot redraw the strip when usage arrives; these do.
    _chip_observers: Vec<gpui::Subscription>,
    /// Installed providers that report usage; `None` until discovery ends.
    installed: Option<Vec<Kind>>,
    prefs: Preferences,
    classic: bool,
    show_remaining: bool,
    refresh_focus: FocusHandle,
    _discovery: Option<Task<()>>,
}

impl UsageStrip {
    pub(crate) fn new(kind: Kind, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            active: kind,
            profile: Default::default(),
            model: None,
            project: String::new(),
            session: None,
            chips: Vec::new(),
            _chip_observers: Vec::new(),
            installed: None,
            prefs: cx.try_global::<Preferences>().cloned().unwrap_or_default(),
            classic: false,
            show_remaining: false,
            refresh_focus: cx.focus_handle(),
            _discovery: None,
        };
        this.discover(cx);
        this.sync(cx);
        this
    }
    /// Which usage-reporting CLIs are installed; reruns when binary paths change.
    fn discover(&mut self, cx: &mut Context<Self>) {
        if cfg!(test) {
            return;
        }
        let work = cx.background_executor().spawn(async move {
            Kind::ALL
                .into_iter()
                .filter(|k| reports_usage(*k) && monocode_core::provider::resolve(*k).is_some())
                .collect::<Vec<_>>()
        });
        self._discovery = Some(cx.spawn(async move |this, cx| {
            let installed = work.await;
            let _ = this.update(cx, |this, cx| {
                this.installed = Some(installed);
                this.sync(cx);
                cx.notify();
            });
        }));
    }
    pub(crate) fn context(
        &mut self,
        kind: Kind,
        profile: Profile,
        model: Option<&str>,
        project: String,
        session: Option<i64>,
        cx: &mut Context<Self>,
    ) {
        self.active = kind;
        self.profile = profile;
        self.model = model.map(str::to_owned);
        self.project = project;
        self.session = session;
        self.sync(cx);
    }
    pub(crate) fn set_preferences(&mut self, prefs: &Preferences, cx: &mut Context<Self>) {
        let rediscover = self.prefs.binary_paths != prefs.binary_paths;
        self.prefs = prefs.clone();
        self.set_remaining(prefs.show_remaining_usage, cx);
        if rediscover {
            self.discover(cx);
        }
        self.sync(cx);
    }
    pub(crate) fn set_remaining(&mut self, remaining: bool, cx: &mut Context<Self>) {
        self.show_remaining = remaining;
        for (_, chip) in &self.chips {
            chip.update(cx, |chip, cx| chip.set_remaining(remaining, cx));
        }
    }
    pub(crate) fn set_classic(&mut self, classic: bool, cx: &mut Context<Self>) {
        if self.classic != classic {
            self.classic = classic;
            for (_, chip) in &self.chips {
                chip.update(cx, |chip, cx| chip.set_classic(classic, cx));
            }
            cx.notify();
        }
    }
    #[cfg(test)]
    pub(crate) fn kind(&self) -> Kind {
        self.active
    }
    #[cfg(test)]
    pub(crate) fn kinds(&self) -> Vec<Kind> {
        self.chips.iter().map(|(k, _)| *k).collect()
    }
    /// Turned on in Settings (globally and for this project) and installed.
    fn enabled(&self, kind: Kind) -> bool {
        let hidden = self.prefs.hidden_for(&self.project);
        reports_usage(kind)
            && self
                .installed
                .as_ref()
                .is_some_and(|installed| installed.contains(&kind))
            && !hidden.iter().any(|id| id == kind.id())
    }
    fn default_model(&self, kind: Kind) -> Option<String> {
        self.prefs
            .project_providers
            .get(&self.project)
            .and_then(|p| p.models.get(kind.id()))
            .or_else(|| self.prefs.default_models.get(kind.id()))
            .cloned()
    }
    /// One chip per enabled provider, in Settings order, plus the open tab's.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let wanted: Vec<Kind> = Kind::ALL
            .into_iter()
            .filter(|k| *k == self.active || self.enabled(*k))
            .collect();
        let mut old = std::mem::take(&mut self.chips);
        let center = crate::accounts::get(cx);
        for kind in wanted {
            let chip = match old.iter().position(|(k, _)| *k == kind) {
                Some(at) => old.remove(at).1,
                None => {
                    let (classic, remaining) = (self.classic, self.show_remaining);
                    cx.new(|cx| {
                        let mut chip = UsageFooter::new(kind, cx);
                        chip.set_classic(classic, cx);
                        chip.set_remaining(remaining, cx);
                        chip
                    })
                }
            };
            let (profile, model, session) = if kind == self.active {
                (self.profile.clone(), self.model.clone(), self.session)
            } else {
                (
                    center
                        .as_ref()
                        .map(|c| c.read(cx).selected(kind, &self.project))
                        .unwrap_or_default(),
                    self.default_model(kind),
                    None,
                )
            };
            let project = self.project.clone();
            chip.update(cx, |chip, cx| {
                chip.context(kind, profile, model.as_deref(), project, session, cx)
            });
            self.chips.push((kind, chip));
        }
        self._chip_observers = self
            .chips
            .iter()
            .map(|(_, chip)| cx.observe(chip, |_, _, cx| cx.notify()))
            .collect();
        cx.notify();
    }
    /// The chips worth showing: the open tab's provider when it can report
    /// usage, and every other one once it has some. A tab whose harness has
    /// no usage keeps its chip only when nothing else would show.
    fn visible(&self, cx: &App) -> Vec<(Kind, Entity<UsageFooter>)> {
        let others: Vec<_> = self
            .chips
            .iter()
            .filter(|(k, chip)| *k != self.active && chip.read(cx).has_usage())
            .cloned()
            .collect();
        self.chips
            .iter()
            .filter(|(k, chip)| {
                if *k == self.active {
                    reports_usage(*k) || others.is_empty()
                } else {
                    chip.read(cx).has_usage()
                }
            })
            .cloned()
            .collect()
    }
    fn refresh_all(&mut self, cx: &mut Context<Self>) {
        for (_, chip) in self.visible(cx) {
            chip.update(cx, |chip, cx| chip.refresh(true, cx));
        }
    }
}

impl Render for UsageStrip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let classic = self.classic;
        let visible = self.visible(cx);
        let fetching = visible.iter().any(|(_, chip)| chip.read(cx).fetching());
        div()
            .id("usage-footer")
            .role(Role::Group)
            .aria_label("Provider usage")
            .h(px(if classic { 28. } else { 30. }))
            .w_full()
            .flex_shrink_0()
            .when(!classic, |d| d.pb(px(2.)))
            .flex()
            .items_center()
            .gap(px(2.))
            .text_size(px(11.))
            .text_color(content(0.55))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .flex()
                    .items_center()
                    .gap(px(if classic { 6. } else { 2. }))
                    .children(visible.into_iter().map(|(kind, chip)| {
                        div()
                            .id(("usage-chip", index(kind)))
                            .debug_selector(move || format!("usage-chip-{}", kind.id()))
                            .flex_shrink_0()
                            .child(chip)
                    })),
            )
            .child(
                div()
                    .id("refresh-usage")
                    .role(Role::Button)
                    .aria_label("Refresh usage")
                    .track_focus(&self.refresh_focus)
                    .tab_index(0)
                    .key_context("UsageRefresh")
                    .map(|d| {
                        if classic {
                            d.size(px(18.)).rounded_md()
                        } else {
                            d.size(px(20.)).rounded_full()
                        }
                    })
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .opacity(if fetching { 0.5 } else { 1. })
                    .when(!fetching, |d| d.hover(|s| s.bg(content(0.1))))
                    .child(icon("refresh", 12.))
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_all(cx)))
                    .on_action(cx.listener(|this, _: &RefreshUsage, _, cx| this.refresh_all(cx))),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(used: f64) -> Result<Snapshot, FetchError> {
        Ok(Snapshot {
            windows: vec![usage::Window {
                used_percent: used,
                minutes: 300,
                resets_at: Some(usage::now_ms() + 5_400_000),
            }],
            updated_at: usage::now_ms(),
            ..Default::default()
        })
    }

    /// The footer row: the strip as a cached view beside fixed controls.
    struct Footer(Entity<UsageStrip>);
    impl Render for Footer {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .w_full()
                .h(px(30.))
                .flex()
                .items_center()
                .child(
                    self.0.clone().cached(
                        gpui::StyleRefinement::default()
                            .flex_1()
                            .min_w_0()
                            .h(px(30.)),
                    ),
                )
                .child(div().flex_shrink_0().w(px(200.)).h(px(20.)))
        }
    }

    #[gpui::test]
    fn chips_keep_their_width_and_appear_when_usage_arrives(cx: &mut gpui::TestAppContext) {
        for classic in [false, true] {
            let mut strip = None;
            let window = cx.update(|cx| {
                cx.open_window(Default::default(), |_, cx| {
                    let s = cx.new(|cx| UsageStrip::new(Kind::Claude, cx));
                    strip = Some(s.clone());
                    cx.new(|_| Footer(s))
                })
                .unwrap()
            });
            let strip = strip.unwrap();
            let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
            strip.update(visual, |strip, cx| {
                strip.set_classic(classic, cx);
                strip.installed = Some(vec![Kind::Claude, Kind::Codex]);
                strip.sync(cx);
            });
            visual.run_until_parked();
            visual.refresh().unwrap();
            let width = |visual: &mut gpui::VisualTestContext, kind: &str| {
                visual
                    .debug_bounds(Box::leak(format!("usage-chip-{kind}").into_boxed_str()))
                    .map(|b| b.size.width)
            };
            let loading = width(visual, "claude").unwrap();
            assert!(loading > px(40.), "classic {classic}: {loading:?}");
            assert_eq!(width(visual, "codex"), None);
            // Each chip's own notify, as a finished fetch sends, and a normal
            // frame rather than a full refresh.
            for (at, kind) in [(0, Kind::Claude), (1, Kind::Codex)] {
                let chip = strip.read_with(visual, |s, _| s.chips[at].1.clone());
                chip.update(visual, |chip, cx| {
                    chip.cache[index(kind)].complete(snapshot(24.));
                    cx.notify();
                });
            }
            visual.run_until_parked();
            visual.update(|window, cx| window.draw(cx).clear(cx));
            assert!(
                width(visual, "claude").unwrap() > loading,
                "classic {classic}"
            );
            assert!(
                width(visual, "codex").unwrap() > px(40.),
                "classic {classic}"
            );
        }
    }

    #[gpui::test]
    fn enabled_providers_get_chips_beside_the_open_tabs(cx: &mut gpui::TestAppContext) {
        let window = cx.update(|cx| {
            cx.open_window(Default::default(), |_, cx| {
                cx.new(|cx| UsageStrip::new(Kind::Cursor, cx))
            })
            .unwrap()
        });
        window
            .update(cx, |strip, _, cx| {
                assert_eq!(strip.kinds(), [Kind::Cursor]);
                strip.installed = Some(vec![Kind::Claude, Kind::Codex, Kind::Pi]);
                let prefs = Preferences {
                    hidden_providers: vec!["pi".into()],
                    ..Default::default()
                };
                strip.set_preferences(&prefs, cx);
                assert_eq!(strip.kinds(), [Kind::Claude, Kind::Codex, Kind::Cursor]);
                // A Cursor tab has no usage: with nothing else loaded it keeps
                // its chip, and hides once another provider has some.
                let visible = |strip: &UsageStrip, cx: &App| {
                    strip
                        .visible(cx)
                        .into_iter()
                        .map(|(k, _)| k)
                        .collect::<Vec<_>>()
                };
                assert_eq!(visible(strip, cx), [Kind::Cursor]);
                let claude = strip.chips[0].1.clone();
                claude.update(cx, |chip, _| {
                    chip.cache[index(Kind::Claude)].complete(Ok(Snapshot {
                        windows: vec![usage::Window {
                            used_percent: 12.,
                            minutes: 300,
                            resets_at: None,
                        }],
                        updated_at: usage::now_ms(),
                        ..Default::default()
                    }))
                });
                assert_eq!(visible(strip, cx), [Kind::Claude]);
                // Opening a Codex tab keeps Claude's chip and the same entity.
                strip.context(
                    Kind::Codex,
                    Default::default(),
                    None,
                    "/p".into(),
                    Some(1),
                    cx,
                );
                assert_eq!(strip.kinds(), [Kind::Claude, Kind::Codex]);
                assert_eq!(strip.chips[0].1, claude);
                assert_eq!(visible(strip, cx), [Kind::Claude, Kind::Codex]);
                assert_eq!(strip.chips[1].1.read(cx).kind(), Kind::Codex);
                // A provider turned off for the project drops out.
                let mut prefs = prefs.clone();
                prefs
                    .project_providers
                    .entry("/p".into())
                    .or_default()
                    .hidden = vec!["claude".into()];
                strip.set_preferences(&prefs, cx);
                assert_eq!(strip.kinds(), [Kind::Codex]);
            })
            .unwrap();
    }
}
