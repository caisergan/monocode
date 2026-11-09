//! Every close that would hide work in progress asks first: a chat still
//! working, or a terminal still running something.
use super::*;

/// Who wants the tab closed. Terminals always ask, because closing one stops
/// its process. A working chat only holds up the user's own closes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CloseBy {
    User,
    /// Archive, delete, removing a project and a lead closing its agent have
    /// already decided, and some need the tab gone by the time they return.
    App,
}

/// What a close prompt says, or None when nothing is in progress. `working`
/// holds chat titles and `terminals` holds (label, process) pairs.
fn close_prompt(
    working: &[String],
    terminals: &[(String, String)],
) -> Option<(String, Option<String>)> {
    let bullets = |lines: Vec<String>| {
        lines
            .iter()
            .map(|line| format!("• {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let chats = || bullets(working.to_vec());
    let shells = || {
        bullets(
            terminals
                .iter()
                .map(|(label, process)| format!("{label} ({process})"))
                .collect(),
        )
    };
    Some(match (working, terminals) {
        ([], []) => return None,
        ([], [(label, process)]) => (
            format!("\"{process}\" is still running in {label}. Close this terminal anyway?"),
            None,
        ),
        ([], _) => (
            format!(
                "These terminals are still running:\n{}\n\nClose them anyway?",
                shells()
            ),
            None,
        ),
        // The heading stays short: a long title would wrap and strand its "?".
        ([title], []) => (
            "Close this working chat?".into(),
            Some(format!(
                "“{title}” will keep running in the background, and you can reopen it from the \
                 sidebar."
            )),
        ),
        (_, []) => (
            format!("Close {} working chats?", working.len()),
            Some(format!(
                "{}\n\nThey will keep running in the background, and you can reopen them from \
                 the sidebar.",
                chats()
            )),
        ),
        (_, _) => (
            "Close these anyway?".into(),
            Some(format!(
                "Still working, and will keep running in the background:\n{}\n\nStill running, \
                 and will stop:\n{}",
                chats(),
                shells()
            )),
        ),
    })
}

impl Shell {
    /// The chat's tab shows a spinner or an attention mark for this turn. A
    /// turn the user stopped is only finishing its save, so it doesn't count.
    fn session_working(&self, id: i64, cx: &App) -> bool {
        self.sessions
            .get(&id)
            .is_some_and(|view| view.read(cx).responding())
            || (self.session_summaries.contains_key(&id)
                && self.remote_marks.get(&id).is_some_and(|state| state.0))
    }

    /// Runs `close` once the panes it would close are safe to lose, asking
    /// first if any of them still has work in progress.
    pub(super) fn confirm_close_panes(
        &mut self,
        by: CloseBy,
        panes: &[i64],
        window: &mut Window,
        cx: &mut Context<Self>,
        close: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let working = panes
            .iter()
            .filter(|pane| by == CloseBy::User && self.session_working(**pane, cx))
            .map(|pane| self.session_metadata(*pane, cx).display_title())
            .collect::<Vec<_>>();
        let terminals = panes
            .iter()
            .filter_map(|pane| self.terminal_pane_views.get(pane))
            .filter_map(|terminal| {
                let terminal = terminal.read(cx);
                let process = terminal.foreground.as_deref()?;
                Some((project_name(&terminal.cwd), process.to_owned()))
            })
            .collect::<Vec<_>>();
        let Some((message, detail)) = close_prompt(&working, &terminals) else {
            close(self, window, cx);
            return;
        };
        let answer = window.prompt(
            gpui::PromptLevel::Warning,
            &message,
            detail.as_deref(),
            &["Close", "Cancel"],
            cx,
        );
        cx.spawn_in(window, async move |this, cx| {
            if matches!(answer.await, Ok(0)) {
                let _ = this.update_in(cx, close);
            }
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::window;
    use super::*;
    use gpui::{TestAppContext, VisualTestContext, WindowHandle};

    fn set_working(shell: &mut Shell, id: i64, cx: &mut Context<Shell>) {
        shell.sessions[&id].update(cx, |session, _| session.busy = true);
    }

    #[test]
    fn prompts_name_what_is_in_progress_and_what_happens_to_it() {
        let chats = |titles: &[&str]| titles.iter().map(|t| (*t).to_owned()).collect::<Vec<_>>();
        let shell = [("api".to_owned(), "sleep".to_owned())];
        assert_eq!(close_prompt(&[], &[]), None);

        let (message, detail) = close_prompt(&chats(&["Review"]), &[]).unwrap();
        assert_eq!(message, "Close this working chat?");
        let detail = detail.unwrap();
        assert!(detail.starts_with("“Review” will keep running in the background"));

        let (message, detail) = close_prompt(&chats(&["Review", "Docs"]), &[]).unwrap();
        assert_eq!(message, "Close 2 working chats?");
        let detail = detail.unwrap();
        assert!(detail.contains("• Review\n• Docs"));
        assert!(detail.contains("reopen them from the sidebar"));

        let (message, detail) = close_prompt(&[], &shell).unwrap();
        assert!(message.contains("\"sleep\" is still running in api"));
        assert_eq!(detail, None);

        let (_, detail) = close_prompt(&chats(&["Review"]), &shell).unwrap();
        let detail = detail.unwrap();
        assert!(detail.contains("• Review"));
        assert!(detail.contains("will stop:\n• api (sleep)"));
    }

    /// The shell showing `a`, the session with history: `b` is a blank tab,
    /// which can't close as its project's last one.
    fn shell_on_a(cx: &mut TestAppContext) -> (WindowHandle<Shell>, VisualTestContext, i64, i64) {
        let (window, a, b) = window(cx);
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        window
            .update(&mut visual, |shell, w, cx| shell.open(a, w, cx))
            .unwrap();
        // Loading a chat settles its state, so mark it working afterwards.
        visual.run_until_parked();
        (window, visual, a, b)
    }

    #[gpui::test]
    fn closing_a_working_tab_asks_and_cancel_keeps_it(cx: &mut TestAppContext) {
        let (window, mut visual, a, b) = shell_on_a(cx);
        visual.update(|_, cx| bind_keys(cx));
        window
            .update(&mut visual, |shell, _, cx| set_working(shell, a, cx))
            .unwrap();
        for answer in ["Cancel", "Close"] {
            visual.simulate_keystrokes("cmd-w");
            visual.run_until_parked();
            let (message, detail) = visual.pending_prompt().expect("closing asks first");
            assert_eq!(message, "Close this working chat?");
            assert!(detail.contains("keep running in the background"));
            window
                .update(&mut visual, |shell, _, _| {
                    assert!(shell.workspace.tab_of(a).is_some());
                })
                .unwrap();
            visual.simulate_prompt_answer(answer);
            visual.run_until_parked();
            assert!(!visual.has_pending_prompt());
            window
                .update(&mut visual, |shell, _, cx| {
                    assert_eq!(shell.workspace.tab_of(a).is_some(), answer == "Cancel");
                    assert!(
                        shell.sessions[&a].read(cx).busy,
                        "closing a tab never stops its session"
                    );
                    assert!(shell.workspace.tab_of(b).is_some());
                })
                .unwrap();
        }
    }

    #[gpui::test]
    fn idle_and_stopped_tabs_close_without_asking(cx: &mut TestAppContext) {
        for stopped in [false, true] {
            let (window, mut visual, a, _) = shell_on_a(cx);
            window
                .update(&mut visual, |shell, w, cx| {
                    if stopped {
                        set_working(shell, a, cx);
                        shell.sessions[&a].update(cx, |session, cx| session.stop_if_busy(cx));
                    }
                    assert!(!shell.session_working(a, cx));
                    shell.close(a, w, cx);
                })
                .unwrap();
            visual.run_until_parked();
            assert!(!visual.has_pending_prompt());
            window
                .update(&mut visual, |shell, _, _| {
                    assert!(shell.workspace.tab_of(a).is_none());
                })
                .unwrap();
        }
    }

    #[gpui::test]
    fn a_working_split_pane_asks_before_only_that_pane_closes(cx: &mut TestAppContext) {
        let (window, mut visual, a, b) = shell_on_a(cx);
        window
            .update(&mut visual, |shell, w, cx| {
                shell.open(b, w, cx);
                shell.workspace.close(a);
                shell.workspace.active = Some(b);
                shell.workspace.split(a, SplitDir::Right);
            })
            .unwrap();
        visual.run_until_parked();
        window
            .update(&mut visual, |shell, w, cx| {
                assert_eq!(shell.workspace.tab_of(a), shell.workspace.tab_of(b));
                set_working(shell, a, cx);
                shell.close_pane(a, w, cx);
            })
            .unwrap();
        visual.run_until_parked();
        assert!(visual.has_pending_prompt());
        visual.simulate_prompt_answer("Close");
        visual.run_until_parked();
        window
            .update(&mut visual, |shell, _, _| {
                assert!(shell.workspace.tab_of(a).is_none());
                assert!(shell.workspace.tab_of(b).is_some());
            })
            .unwrap();
    }

    #[gpui::test]
    fn app_closes_never_ask_but_still_close_the_tab(cx: &mut TestAppContext) {
        let (window, mut visual, a, _) = shell_on_a(cx);
        window
            .update(&mut visual, |shell, w, cx| {
                set_working(shell, a, cx);
                shell.close_pane_for_app(a, w, cx);
                assert!(
                    shell.workspace.tab_of(a).is_none(),
                    "delete and archive check this before they return"
                );
            })
            .unwrap();
        visual.run_until_parked();
        assert!(!visual.has_pending_prompt());
    }

    #[gpui::test]
    fn deleting_a_working_session_does_not_wait_on_a_prompt(cx: &mut TestAppContext) {
        let (window, mut visual, a, _) = shell_on_a(cx);
        window
            .update(&mut visual, |shell, w, cx| {
                set_working(shell, a, cx);
                shell.delete_session(a, w, cx);
                assert!(shell.error.is_none(), "{:?}", shell.error);
                assert!(shell.workspace.tab_of(a).is_none());
            })
            .unwrap();
        visual.run_until_parked();
        assert!(!visual.has_pending_prompt());
    }
}
