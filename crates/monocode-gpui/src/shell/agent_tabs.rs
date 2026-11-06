//! A lead's agents as title tabs attached to it. The tabs stay flat children of
//! the strip, because drags and scrolling address them by child index, so each
//! one draws its own piece of the frame that holds the group together.
use super::*;
use crate::workspace::TitleTab;
use gpui::{Div, Hsla};
use std::ops::Range;

/// An agent reduced to its mark: the plate's padding on each side of it.
pub(super) const FOLDED_WIDTH: f32 = 30.;
const NAMED_MIN_WIDTH: f32 = 62.;
const NAMED_MAX_WIDTH: f32 = 120.;
/// The mark, its gap and the plate's padding around a name.
const NAME_CHROME: f32 = 36.;
/// The same with room for the close button.
const SELECTED_NAME_CHROME: f32 = 56.;
/// Past this, the other tabs are too narrow to read, so agents fold first.
pub(super) const NEIGHBOUR_MIN_WIDTH: f32 = 76.;
const FRAME_HEIGHT: f32 = 31.;
const FRAME_PAD: f32 = 2.;
const FRAME_INK: f32 = 0.24;
/// The room between a frame and the tabs beside it, past the strip's own gap.
const FRAME_MARGIN: f32 = 6.;
pub(super) const GROUP_PLATE_HEIGHT: f32 = 25.;
const OUTER_RADIUS: f32 = 6.;
const INNER_RADIUS: f32 = 3.;

/// A tab's place in a group on the strip.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct GroupTab {
    pub lead: i64,
    /// The agent's short name; `None` on the lead's own tab.
    pub agent: Option<SharedString>,
    pub first: bool,
    pub last: bool,
    /// The group's slots in the strip.
    pub range: Range<usize>,
}

impl GroupTab {
    /// The room this tab asks for outside the strip's gaps.
    pub(super) fn margins(&self) -> (f32, f32) {
        let lead = if !self.first {
            0.
        } else if self.range.start == 0 {
            FRAME_PAD
        } else {
            FRAME_PAD + FRAME_MARGIN
        };
        (lead, if self.last { FRAME_MARGIN } else { 0. })
    }

    /// This tab's plate inside the frame: only the selected one is filled.
    pub(super) fn plate(&self, active: bool, hovered: bool) -> Div {
        let d = title_tab_plate(active, hovered)
            .h(px(GROUP_PLATE_HEIGHT))
            .bg(Self::fill(active, hovered))
            .rounded(px(INNER_RADIUS));
        let d = if self.first {
            d.rounded_tl(px(OUTER_RADIUS)).rounded_bl(px(OUTER_RADIUS))
        } else {
            d
        };
        if self.last {
            d.rounded_tr(px(OUTER_RADIUS)).rounded_br(px(OUTER_RADIUS))
        } else {
            d
        }
    }

    pub(super) fn fill(active: bool, hovered: bool) -> Hsla {
        if active {
            content(0.14)
        } else if hovered {
            content(0.07)
        } else {
            gpui::transparent_black()
        }
    }

    /// This tab's piece of the frame. A piece reaches over the gap to the next
    /// tab, and the ends close the outline with its round corners.
    pub(super) fn frame(&self) -> Div {
        let radius = px(OUTER_RADIUS + FRAME_PAD);
        div()
            .absolute()
            .top(px((TITLE_BAR_HEIGHT - FRAME_HEIGHT) / 2.))
            .h(px(FRAME_HEIGHT))
            .left(px(if self.first { -FRAME_PAD } else { 0. }))
            .right(px(if self.last { -FRAME_PAD } else { -2. }))
            .border_t_1()
            .border_b_1()
            .border_color(content(FRAME_INK))
            .when(self.first, |d| {
                d.border_l_1().rounded_tl(radius).rounded_bl(radius)
            })
            .when(self.last, |d| {
                d.border_r_1().rounded_tr(radius).rounded_br(radius)
            })
    }
}

impl Shell {
    /// The lead running in `tab`, if it still has open agents.
    pub(super) fn lead_in_tab(&self, tab: i64) -> Option<i64> {
        self.workspace
            .layout(tab)
            .leaf_ids()
            .into_iter()
            .find(|id| {
                self.orchestration_summaries
                    .get(id)
                    .is_some_and(|summary| summary.tasks.iter().any(|t| t.open()))
            })
    }

    /// The lead `tab` is attached to. An agent split into a pane is a pane,
    /// and no longer a tab of its lead's group.
    fn lead_of_agent_tab(&self, tab: i64) -> Option<i64> {
        if self.workspace.layout(tab).is_split() {
            return None;
        }
        self.agent_lead(self.workspace.session_for_pane(tab))
    }

    /// The tab whose scope an agent's tab follows, while it has a lead's tab
    /// to attach to.
    pub(super) fn agent_anchor_tab(&self, session: i64) -> Option<i64> {
        self.agent_lead(session)
            .and_then(|lead| self.workspace.tab_of(lead))
    }

    /// The group each of the strip's tabs belongs to. A group is a lead's tab
    /// with the agent tabs right after it; with the lead pinned, its agents
    /// alone hold the place.
    pub(super) fn strip_groups(&self, tabs: &[TitleTab]) -> Vec<Option<GroupTab>> {
        let agent_of = |tab: &TitleTab| tab.session().and_then(|id| self.lead_of_agent_tab(id));
        let mut groups = vec![None; tabs.len()];
        let mut ix = 0;
        while ix < tabs.len() {
            let lead_here = tabs[ix].session().and_then(|id| self.lead_in_tab(id));
            let pinned_lead = agent_of(&tabs[ix]).filter(|lead| {
                self.workspace
                    .tab_of(*lead)
                    .is_some_and(|tab| self.tab_pinned(&TitleTab::Session(tab)))
            });
            let Some(lead) = lead_here.or(pinned_lead) else {
                ix += 1;
                continue;
            };
            let agents = if lead_here.is_some() { ix + 1 } else { ix };
            let end = agents
                + tabs[agents..]
                    .iter()
                    .take_while(|tab| agent_of(tab) == Some(lead))
                    .count();
            if end == agents {
                ix += 1;
                continue;
            }
            for slot in ix..end {
                let agent = (slot >= agents)
                    .then(|| tabs[slot].session())
                    .flatten()
                    .and_then(|id| self.agent_tab_name(id))
                    .map(SharedString::from);
                groups[slot] = Some(GroupTab {
                    lead,
                    agent,
                    first: slot == ix,
                    last: slot + 1 == end,
                    range: ix..end,
                });
            }
            ix = end;
        }
        groups
    }

    /// The lead whose group `tab` belongs to, whatever part of it `tab` is.
    pub(super) fn tab_group_lead(&self, tab: &TitleTab) -> Option<i64> {
        let id = tab.session()?;
        self.lead_in_tab(id).or_else(|| self.lead_of_agent_tab(id))
    }

    /// The short name an agent's tab shows while it can attach to its lead.
    pub(super) fn agent_tab_name(&self, session: i64) -> Option<String> {
        let (lead, ix) = self.agent_of(session)?;
        self.workspace.tab_of(lead)?;
        Some(self.orchestration_summaries[&lead].tasks[ix].name.clone())
    }

    /// An agent's width with its name showing, plain and selected.
    pub(super) fn agent_tab_widths(&self, name: &SharedString, window: &Window) -> (f32, f32) {
        let font_size = px(TITLE_TAB_TEXT_SIZE);
        let style = window.text_style();
        let run = gpui::TextRun {
            len: name.len(),
            font: style.font(),
            color: style.color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let text = window
            .text_system()
            .shape_line(name.clone(), font_size, &[run], None)
            .width()
            .as_f32()
            .ceil();
        (
            (text + NAME_CHROME).clamp(NAMED_MIN_WIDTH, NAMED_MAX_WIDTH),
            (text + SELECTED_NAME_CHROME).clamp(TAB_CLOSE_MIN_WIDTH, NAMED_MAX_WIDTH),
        )
    }

    /// Adds an agent's tab to the end of its lead's group without selecting
    /// it. A lead whose tab is closed keeps the agent on its rail only.
    pub(super) fn attach_agent_tab(&mut self, lead: i64, agent: i64) {
        let Some(lead_tab) = self.workspace.tab_of(lead) else {
            return;
        };
        let after = self
            .workspace
            .title_order
            .iter()
            .rev()
            .filter_map(TitleTab::session)
            .find(|id| self.lead_of_agent_tab(*id) == Some(lead))
            .unwrap_or(lead_tab);
        self.workspace.add_tab_beside(agent, after);
        self.settle_agent_tabs();
    }

    /// Puts each lead's agents right after its tab, or first in the strip
    /// while it is pinned, keeping their own order.
    pub(super) fn settle_agent_tabs(&mut self) {
        let leads: Vec<i64> = self
            .orchestration_summaries
            .iter()
            .filter(|(_, summary)| summary.tasks.iter().any(|t| t.open()))
            .map(|(lead, _)| *lead)
            .collect();
        for lead in leads {
            let Some(lead_tab) = self.workspace.tab_of(lead) else {
                continue;
            };
            let members: Vec<TitleTab> = self
                .workspace
                .title_order
                .iter()
                .filter(|tab| {
                    tab.session()
                        .is_some_and(|id| self.lead_of_agent_tab(id) == Some(lead))
                        && !self.tab_pinned(tab)
                })
                .cloned()
                .collect();
            if members.is_empty() {
                continue;
            }
            let lead_entry = TitleTab::Session(lead_tab);
            let order = &mut self.workspace.title_order;
            order.retain(|tab| !members.contains(tab));
            let at = if self.workspace.pinned_tabs.contains(&lead_entry) {
                0
            } else {
                order
                    .iter()
                    .position(|tab| *tab == lead_entry)
                    .map_or(order.len(), |ix| ix + 1)
            };
            order.splice(at..at, members);
        }
        self.workspace.tabs = self
            .workspace
            .title_order
            .iter()
            .filter_map(TitleTab::session)
            .collect();
    }

    /// Opening a lead's closed tab brings back its open agents' tabs, and an
    /// agent reopened from the rail rejoins its group.
    pub(super) fn tab_reopened(&mut self, id: i64) {
        if let Some(summary) = self.orchestration_summaries.get(&id) {
            let agents: Vec<i64> = summary
                .tasks
                .iter()
                .filter(|t| t.open())
                .filter_map(|t| t.session)
                .filter(|agent| self.session_summaries.contains_key(agent))
                .collect();
            for agent in agents {
                self.attach_agent_tab(id, agent);
            }
        }
        self.settle_agent_tabs();
    }

    /// The agent tabs that close along with `tab` when it holds their lead.
    /// Their sessions keep running, as with any closed tab.
    pub(super) fn group_tabs_closing_with(&self, tab: i64) -> Vec<i64> {
        let Some(lead) = self.workspace.tab_of(tab).and_then(|t| self.lead_in_tab(t)) else {
            return Vec::new();
        };
        self.workspace
            .title_order
            .iter()
            .filter(|entry| !self.tab_pinned(entry))
            .filter_map(TitleTab::session)
            .filter(|id| self.lead_of_agent_tab(*id) == Some(lead))
            .collect()
    }

    /// What dragging slot `from` moves, and the slots it may land on: a lead
    /// carries its group, and an agent stays inside it.
    pub(super) fn drag_extent(
        &self,
        tabs: &[TitleTab],
        from: usize,
    ) -> (Range<usize>, Range<usize>) {
        let single = from..from + 1;
        let everywhere = 0..tabs.len();
        match &self.strip_groups(tabs)[from] {
            Some(group) if group.agent.is_some() => {
                let lead_slot = tabs[group.range.start]
                    .session()
                    .is_some_and(|id| self.lead_in_tab(id).is_some());
                let start = group.range.start + usize::from(lead_slot);
                (single, start..group.range.end)
            }
            Some(group) => {
                let slots = tabs.len() - group.range.len() + 1;
                (group.range.clone(), 0..slots)
            }
            None => (single, everywhere),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::tests::window;
    use gpui::{Modifiers, TestAppContext, WindowHandle, point};
    use monocode_core::orchestration::{Summary, SummaryTask};

    fn task(session: i64, name: &str) -> SummaryTask {
        SummaryTask {
            session: Some(session),
            name: name.into(),
            title: format!("{name}: Some work"),
            provider: "fixture".into(),
            model: None,
            status: "running".into(),
            outcome: None,
        }
    }

    fn add_session(shell: &mut Shell, cx: &mut Context<Shell>) -> i64 {
        let summary = locked(&shell.store)
            .unwrap()
            .create("codex", &shell.workspace.project)
            .unwrap();
        let id = summary.id;
        shell.add(summary, cx);
        id
    }

    /// A lead in the shell's project with two agents attached and one other
    /// open tab after them: (lead, agents, other tab).
    fn group(cx: &mut TestAppContext) -> (WindowHandle<Shell>, i64, [i64; 2], i64) {
        let (window, _, lead) = window(cx);
        let ids = window
            .update(cx, |shell, w, cx| {
                let agents = [add_session(shell, cx), add_session(shell, cx)];
                shell.save_summary(
                    lead,
                    Summary {
                        tasks: vec![task(agents[0], "api"), task(agents[1], "docs")],
                        live: true,
                    },
                    cx,
                );
                for agent in agents {
                    shell.attach_agent_tab(lead, agent);
                }
                let other = add_session(shell, cx);
                shell.open(other, w, cx);
                shell.open(lead, w, cx);
                (agents, other)
            })
            .unwrap();
        cx.run_until_parked();
        (window, lead, ids.0, ids.1)
    }

    fn sessions(tabs: Vec<TitleTab>) -> Vec<i64> {
        tabs.iter().filter_map(TitleTab::session).collect()
    }

    #[gpui::test]
    fn agents_attach_after_their_lead_without_taking_focus(cx: &mut TestAppContext) {
        let (window, lead, [api, docs], other) = group(cx);
        window
            .update(cx, |shell, _, cx| {
                let strip = shell.strip_tabs(cx);
                assert_eq!(sessions(strip.clone()), [lead, api, docs, other]);
                assert_eq!(shell.workspace.active, Some(lead));
                let groups = shell.strip_groups(&strip);
                let first = groups[0].as_ref().unwrap();
                assert_eq!((first.first, first.agent.clone()), (true, None));
                let middle = groups[1].as_ref().unwrap();
                assert_eq!(middle.agent.as_ref().unwrap().as_ref(), "api");
                assert!(!middle.first && !middle.last);
                assert!(groups[2].as_ref().unwrap().last);
                assert_eq!(groups[3], None);
            })
            .unwrap();
    }

    #[gpui::test]
    fn agents_in_their_own_worktrees_stay_on_the_leads_strip(cx: &mut TestAppContext) {
        let (window, lead, [api, docs], _) = group(cx);
        window
            .update(cx, |shell, _, cx| {
                // Scopes last only for the run, so this has to hold from the
                // lead's scope alone, as it does after a restart.
                shell.workspace.tab_workspaces.clear();
                for agent in [api, docs] {
                    shell
                        .session_worktrees
                        .insert(agent, Some(format!("/work/agent-{agent}")));
                }
                let strip = sessions(shell.strip_tabs(cx));
                assert_eq!(&strip[..3], [lead, api, docs]);
            })
            .unwrap();
    }

    #[gpui::test]
    fn closing_the_lead_closes_its_group_and_reopening_brings_it_back(cx: &mut TestAppContext) {
        let (window, lead, [api, docs], other) = group(cx);
        window
            .update(cx, |shell, w, cx| {
                shell.close(lead, w, cx);
                assert_eq!(sessions(shell.strip_tabs(cx)), [other]);
                assert!(
                    shell.sessions.contains_key(&api),
                    "agents outlive their tabs"
                );
                assert_eq!(shell.agent_lead(api), Some(lead));
                shell.open(lead, w, cx);
                let strip = sessions(shell.strip_tabs(cx));
                assert_eq!(strip[strip.len() - 3..], [lead, api, docs]);
            })
            .unwrap();
    }

    #[gpui::test]
    fn closing_an_agent_tab_leaves_the_rest_and_it_rejoins_from_the_rail(cx: &mut TestAppContext) {
        let (window, lead, [api, docs], other) = group(cx);
        window
            .update(cx, |shell, w, cx| {
                shell.close(api, w, cx);
                assert_eq!(sessions(shell.strip_tabs(cx)), [lead, docs, other]);
                assert_eq!(shell.workspace.active, Some(lead));
                shell.open(api, w, cx);
                assert_eq!(sessions(shell.strip_tabs(cx)), [lead, docs, api, other]);
                assert_eq!(shell.workspace.active, Some(api));
            })
            .unwrap();
    }

    #[gpui::test]
    fn a_lead_carries_its_group_and_an_agent_stays_inside_it(cx: &mut TestAppContext) {
        let (window, lead, [api, docs], other) = group(cx);
        window
            .update(cx, |shell, _, cx| {
                let strip = shell.strip_tabs(cx);
                assert_eq!(shell.drag_extent(&strip, 0), (0..3, 0..2));
                assert_eq!(shell.drag_extent(&strip, 1), (1..2, 1..3));
                assert_eq!(shell.drag_extent(&strip, 3), (3..4, 0..4));
                shell.reorder_title_tab(&TitleTab::Session(lead), 1, cx);
                assert_eq!(sessions(shell.strip_tabs(cx)), [other, lead, api, docs]);
                shell.reorder_title_tab(&TitleTab::Session(docs), 2, cx);
                assert_eq!(sessions(shell.strip_tabs(cx)), [other, lead, docs, api]);
                // Dropped inside the group, a tab lands right after it.
                shell.reorder_title_tab(&TitleTab::Session(other), 2, cx);
                assert_eq!(sessions(shell.strip_tabs(cx)), [lead, docs, api, other]);
            })
            .unwrap();
    }

    #[gpui::test]
    fn a_pinned_leads_agents_lead_the_strip_as_a_group(cx: &mut TestAppContext) {
        let (window, lead, [api, docs], other) = group(cx);
        window
            .update(cx, |shell, _, cx| {
                shell.reorder_title_tab(&TitleTab::Session(other), 0, cx);
                shell.toggle_pin_tab(TitleTab::Session(lead), cx);
                let strip = shell.strip_tabs(cx);
                assert_eq!(sessions(strip.clone()), [api, docs, other]);
                let groups = shell.strip_groups(&strip);
                assert!(groups[0].as_ref().unwrap().first);
                assert!(groups[1].as_ref().unwrap().last);
                assert_eq!(groups[2], None);
                assert_eq!(shell.drag_extent(&strip, 0), (0..1, 0..2));
            })
            .unwrap();
    }

    #[gpui::test]
    fn agents_show_names_in_view_and_fold_to_marks_elsewhere(cx: &mut TestAppContext) {
        let (window, lead, [api, docs], other) = group(cx);
        cx.update(|cx| cx.set_reduce_motion(true));
        let width = |id: i64, cx: &mut TestAppContext| {
            let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
            visual.run_until_parked();
            visual.refresh().unwrap();
            visual
                .debug_bounds(Box::leak(format!("title-tab-{id}").into_boxed_str()))
                .unwrap()
                .size
                .width
                .as_f32()
        };
        assert!(width(api, cx) >= NAMED_MIN_WIDTH);
        assert!(width(docs, cx) >= NAMED_MIN_WIDTH);
        window
            .update(cx, |shell, w, cx| shell.open(other, w, cx))
            .unwrap();
        assert_eq!(width(api, cx), FOLDED_WIDTH);
        assert_eq!(width(docs, cx), FOLDED_WIDTH);
        assert!(width(lead, cx) > FOLDED_WIDTH);
        window
            .update(cx, |shell, w, cx| shell.open(docs, w, cx))
            .unwrap();
        assert!(width(docs, cx) >= TAB_CLOSE_MIN_WIDTH);
        assert!(width(api, cx) >= NAMED_MIN_WIDTH);
    }

    #[gpui::test]
    fn dragging_a_lead_moves_its_whole_group(cx: &mut TestAppContext) {
        let (window, lead, [api, docs], other) = group(cx);
        cx.update(|cx| cx.set_reduce_motion(true));
        let visual = &mut gpui::VisualTestContext::from_window(window.into(), cx);
        visual.run_until_parked();
        visual.refresh().unwrap();
        let bounds = |id: i64, visual: &mut gpui::VisualTestContext| {
            visual
                .debug_bounds(Box::leak(format!("title-tab-{id}").into_boxed_str()))
                .unwrap()
        };
        let from = bounds(lead, visual).center();
        let to = bounds(other, visual).right();
        visual.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
        visual.simulate_mouse_move(
            point(to + px(200.), from.y),
            MouseButton::Left,
            Modifiers::default(),
        );
        visual.run_until_parked();
        visual.simulate_mouse_up(
            point(to + px(200.), from.y),
            MouseButton::Left,
            Modifiers::default(),
        );
        visual.run_until_parked();
        window
            .update(visual, |shell, _, cx| {
                assert_eq!(sessions(shell.strip_tabs(cx)), [other, lead, api, docs]);
            })
            .unwrap();
    }
}
