//! ImportSessionDialog: conversations started in an agent's terminal CLI
//! (Claude Code, Pi, omp), listed newest first and saved as MonoCode chats
//! that resume them. A conversation MonoCode already has opens instead.
use super::*;
use monocode_core::agent_sessions::{
    self, AgentSessionListing, AgentSessionQuery, AgentSessionSummary, Harness, SessionFolder,
};

const HARNESSES: [Harness; 3] = [Harness::Claude, Harness::Pi, Harness::Omp];

pub(super) struct ImportSheet {
    search: Entity<input::Input>,
    /// The project the sheet opened for; None lists every folder.
    project: Option<String>,
    all_folders: bool,
    listing: Option<Result<AgentSessionListing, String>>,
    request: u64,
    loading: bool,
    /// The conversation being imported, which keeps the sheet busy.
    importing: Option<String>,
    error: Option<String>,
    _events: Vec<Subscription>,
}

impl Shell {
    pub(super) fn open_import_sheet(
        &mut self,
        project: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_preview(cx);
        let search = cx.new(|cx| {
            input::Input::field(
                "Search terminal sessions",
                "Search by title, prompt, folder or session ID",
                content(0.3),
                cx,
            )
        });
        let events = vec![cx.subscribe(&search, |this, _, _: &input::Changed, cx| {
            this.reload_import_sheet(cx)
        })];
        window.focus(&search.read(cx).focus_handle(cx), cx);
        let local = project.filter(|path| !path.starts_with("remote://") && path != "~");
        self.import_sheet = Some(ImportSheet {
            search,
            all_folders: local.is_none(),
            project: local,
            listing: None,
            request: 0,
            loading: false,
            importing: None,
            error: None,
            _events: events,
        });
        self.reload_import_sheet(cx);
    }
    pub(super) fn close_import_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.import_sheet.take().is_some() {
            self.focus_active(window, cx);
            cx.notify();
        }
    }
    fn reload_import_sheet(&mut self, cx: &mut Context<Self>) {
        let store = self.store.clone();
        let Some(sheet) = &mut self.import_sheet else {
            return;
        };
        sheet.request += 1;
        sheet.loading = true;
        let request = sheet.request;
        let query = AgentSessionQuery {
            harnesses: Some(HARNESSES.to_vec()),
            cwd: sheet.project.clone().filter(|_| !sheet.all_folders),
            query: Some(sheet.search.read(cx).content.trim().to_owned()),
            limit: Some(60),
            include_imported: true,
            owner: Some("import-sheet".into()),
            ..Default::default()
        };
        let work = cx.background_executor().spawn(async move {
            // Let a burst of typing settle before reading transcripts.
            std::thread::sleep(std::time::Duration::from_millis(150));
            let known = agent_sessions::import::known(&*locked(&store)?)?;
            Ok::<_, String>(agent_sessions::list(&query, &known))
        });
        cx.spawn(async move |this, cx| {
            let listing = work.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(sheet) = &mut this.import_sheet
                    && sheet.request == request
                {
                    sheet.loading = false;
                    sheet.listing = Some(listing);
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }
    fn import_agent_session(&mut self, summary: AgentSessionSummary, cx: &mut Context<Self>) {
        let store = self.store.clone();
        let Some(sheet) = &mut self.import_sheet else {
            return;
        };
        if sheet.importing.is_some() {
            return;
        }
        sheet.importing = Some(summary.id.clone());
        sheet.error = None;
        let work = cx.background_executor().spawn(async move {
            let mut store = locked(&store)?;
            agent_sessions::import::import(&mut store, &summary)
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update_in(cx, |this, window, cx| match result {
                Ok((session, existing)) => {
                    let id = session.id;
                    if !existing || !this.session_summaries.contains_key(&id) {
                        this.add(session.clone(), cx);
                    }
                    if this.workspace.project != session.cwd && session.cwd != "~" {
                        if !this.workspace.projects.contains(&session.cwd) {
                            this.workspace.projects.push(session.cwd.clone());
                        }
                        this.select_project(session.cwd.clone(), window, cx);
                    }
                    this.import_sheet = None;
                    this.open(id, window, cx);
                    this.persist(cx);
                    cx.notify();
                }
                Err(error) => {
                    if let Some(sheet) = &mut this.import_sheet {
                        sheet.importing = None;
                        sheet.error = Some(error);
                    }
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn import_modal(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let sheet = self.import_sheet.as_ref()?;
        let viewport = window.viewport_size();
        let width = 560f32.min(viewport.width.as_f32() - 24.);
        let height = 480f32.min(viewport.height.as_f32() - 48.);
        let weak = cx.weak_entity();
        let sessions = match &sheet.listing {
            Some(Ok(listing)) => listing.sessions.as_slice(),
            _ => &[],
        };
        let empty = match &sheet.listing {
            None => Some("Reading terminal sessions…".to_owned()),
            Some(Err(error)) => Some(error.clone()),
            Some(Ok(listing)) if listing.sessions.is_empty() => {
                Some(if sheet.search.read(cx).content.trim().is_empty() {
                    "No terminal sessions found here.".to_owned()
                } else {
                    "No terminal sessions match.".to_owned()
                })
            }
            _ => None,
        };
        let scope = |id: &'static str, label: &'static str, all: bool| {
            let selected = sheet.all_folders == all;
            div()
                .id(id)
                .role(Role::Tab)
                .aria_selected(selected)
                .px_2()
                .py_0p5()
                .rounded_md()
                .cursor_pointer()
                .text_size(px(12.))
                .text_color(if selected { content(1.) } else { content(0.5) })
                .when(selected, |d| d.bg(content(0.08)))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(sheet) = &mut this.import_sheet
                        && sheet.all_folders != all
                    {
                        sheet.all_folders = all;
                        this.reload_import_sheet(cx);
                    }
                }))
        };
        let rows = sessions.iter().enumerate().map(|(ix, summary)| {
            let title = summary
                .title
                .clone()
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| summary.first_prompt.clone());
            let folder = match summary.folder {
                SessionFolder::Home => "Home folder".to_owned(),
                SessionFolder::Missing => format!("{} · folder gone", summary.cwd),
                SessionFolder::Ok => summary.cwd.clone(),
            };
            let when =
                monocode_core::time::relative(summary.updated_at, monocode_core::time::now_ms());
            let busy = sheet.importing.as_deref() == Some(summary.id.as_str());
            let imported = summary.monocode_session_id.is_some();
            let picked = summary.clone();
            div()
                .id(("import-session", ix))
                .debug_selector(move || format!("import-session-{ix}"))
                .role(Role::Button)
                .aria_label(format!("{} {}", summary.harness.label(), title))
                .px_3()
                .py_2()
                .rounded_md()
                .flex()
                .items_center()
                .gap_3()
                .cursor_pointer()
                .hover(|s| s.bg(content(0.06)))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(content(0.95))
                                .truncate()
                                .child(title),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(content(0.45))
                                .truncate()
                                .child(format!(
                                    "{} · {} · {}",
                                    summary.harness.label(),
                                    folder,
                                    summary.id.chars().take(8).collect::<String>()
                                )),
                        ),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(11.))
                        .text_color(content(0.45))
                        .child(if busy {
                            "Importing…".to_owned()
                        } else if imported {
                            "Open".to_owned()
                        } else {
                            when
                        }),
                )
                .on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.import_agent_session(picked.clone(), cx)
                    }),
                )
        });
        let field = div()
            .h(px(34.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap_2()
            .rounded_md()
            .border_1()
            .border_color(content(0.1))
            .bg(content(0.05))
            .text_size(px(13.))
            .text_color(content(1.))
            .child(icon("search-01", 14.).text_color(content(0.45)))
            .child(div().flex_1().child(sheet.search.clone()))
            .when(sheet.loading, |d| {
                d.child(icon("loader", 12.).text_color(content(0.45)))
            });
        Some(
            div()
                .absolute()
                .size_full()
                .child(crate::modal::scrim("import-sessions-scrim"))
                .child(
                    popover("import-sessions-modal", Anchor::Center)
                        .modal_surface(self.workspace.boxy_layout())
                        .width(width)
                        .gap(0.)
                        .priority(60)
                        .on_dismiss(move |window, cx| {
                            let _ = weak.update(cx, |this, cx| this.close_import_sheet(window, cx));
                        })
                        .child(
                            div()
                                .id("import-sessions-dialog")
                                .debug_selector(|| "import-sessions-dialog".into())
                                .role(Role::Dialog)
                                .aria_label("Import terminal sessions")
                                .h(px(height))
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .px_4()
                                        .pt_4()
                                        .pb_2()
                                        .flex()
                                        .flex_col()
                                        .gap_2()
                                        .child(
                                            div()
                                                .text_size(px(14.))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .text_color(content(1.))
                                                .child("Import terminal sessions"),
                                        )
                                        .child(div().text_size(px(12.)).text_color(content(0.5)).child(
                                            "Continue a Claude Code, Pi or omp conversation started in a terminal. The next message resumes it.",
                                        ))
                                        .child(field)
                                        .when(sheet.project.is_some(), |d| {
                                            d.child(
                                                div()
                                                    .flex()
                                                    .gap_1()
                                                    .child(scope("import-scope-project", "This project", false))
                                                    .child(scope("import-scope-all", "All folders", true)),
                                            )
                                        })
                                        .when_some(sheet.error.clone(), |d, error| {
                                            d.child(
                                                div()
                                                    .id("import-sessions-error")
                                                    .role(Role::Alert)
                                                    .text_size(px(11.))
                                                    .text_color(rgb(0xf87171))
                                                    .child(error),
                                            )
                                        }),
                                )
                                .child(
                                    div()
                                        .id("import-sessions-list")
                                        .flex_1()
                                        .min_h_0()
                                        .overflow_y_scroll()
                                        .px_2()
                                        .pb_2()
                                        .map(|d| match empty {
                                            Some(text) => d.child(
                                                div()
                                                    .px_3()
                                                    .py_2()
                                                    .text_size(px(12.))
                                                    .text_color(content(0.45))
                                                    .child(text),
                                            ),
                                            None => d.children(rows),
                                        }),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    #[gpui::test]
    fn a_terminal_claude_session_imports_once_and_opens_with_its_transcript(
        cx: &mut TestAppContext,
    ) {
        let (window, _, _) = crate::shell::tests::window(cx);
        let config = std::env::temp_dir().join(format!(
            "monocode-import-sheet-{}",
            monocode_core::mono::new_id()
        ));
        // The conversation's folder must exist for it to resume there.
        let project = config.join("project").to_string_lossy().into_owned();
        std::fs::create_dir_all(&project).unwrap();
        window
            .update(cx, |shell, _, _| {
                shell.workspace.projects.push(project.clone());
                shell.workspace.project = project.clone();
            })
            .unwrap();
        let folder = config
            .join("projects")
            .join(project.replace(['/', '.', '_'], "-"));
        std::fs::create_dir_all(&folder).unwrap();
        let id = "5f1d7e1c-0000-4000-8000-000000000001";
        let records = [
            serde_json::json!({"type":"user","uuid":"u1","cwd":project,"sessionId":id,"timestamp":"2026-10-29T10:00:00Z","message":{"role":"user","content":"Fix the crash on launch"}}),
            serde_json::json!({"type":"assistant","uuid":"a1","parentUuid":"u1","cwd":project,"sessionId":id,"message":{"content":[{"type":"text","text":"Fixed it."}]}}),
        ];
        std::fs::write(
            folder.join(format!("{id}.jsonl")),
            records.iter().map(|r| format!("{r}\n")).collect::<String>(),
        )
        .unwrap();
        // SAFETY: GPUI tests run on one thread here (--test-threads=1).
        unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", &config) };
        window
            .update(cx, |shell, w, cx| {
                shell.open_import_sheet(Some(project.clone()), w, cx)
            })
            .unwrap();
        let summary = (0..200)
            .find_map(|_| {
                cx.run_until_parked();
                std::thread::sleep(std::time::Duration::from_millis(10));
                window
                    .update(cx, |shell, _, _| {
                        match shell.import_sheet.as_ref().and_then(|s| s.listing.as_ref()) {
                            Some(Ok(listing)) => listing.sessions.first().cloned(),
                            _ => None,
                        }
                    })
                    .unwrap()
            })
            .expect("the sheet lists the terminal session");
        assert_eq!(summary.id, id);
        window
            .update(cx, |shell, _, cx| {
                shell.import_agent_session(summary.clone(), cx)
            })
            .unwrap();
        cx.run_until_parked();
        let opened = window
            .update(cx, |shell, _, cx| {
                assert!(shell.import_sheet.is_none());
                let active = shell.workspace.active.unwrap();
                let view = shell.sessions[&active].read(cx);
                assert_eq!(view.summary.provider_id.as_deref(), Some(id));
                assert_eq!(view.summary.title, "Fix the crash on launch");
                active
            })
            .unwrap();
        // Importing again opens the same chat.
        window
            .update(cx, |shell, w, cx| {
                shell.open_import_sheet(Some(project.clone()), w, cx);
                shell.import_agent_session(summary, cx);
            })
            .unwrap();
        cx.run_until_parked();
        window
            .update(cx, |shell, _, _| {
                assert_eq!(shell.workspace.active, Some(opened))
            })
            .unwrap();
        unsafe { std::env::remove_var("CLAUDE_CONFIG_DIR") };
        let _ = std::fs::remove_dir_all(config);
    }
}
