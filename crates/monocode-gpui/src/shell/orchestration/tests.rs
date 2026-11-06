use super::*;
use crate::workspace::TitleTab;
use gpui::{TestAppContext, WindowHandle};
use monocode_core::agent::{Approval, Settings};
use std::sync::mpsc;

fn call(
    window: WindowHandle<Shell>,
    caller: i64,
    request: &str,
    action: &str,
    input: Value,
    cx: &mut TestAppContext,
) -> Result<Value, String> {
    let (reply, result) = mpsc::channel();
    window
        .update(cx, |shell, window, cx| {
            shell.handle_app_call(
                Call {
                    session: caller,
                    request_id: request.into(),
                    action: action.into(),
                    input,
                    reply,
                },
                window,
                cx,
            )
        })
        .unwrap();
    cx.run_until_parked();
    result.try_recv().expect("the agents action must settle")
}

/// A lead on the fixture provider: its own and its agents' turns fail at
/// once without starting a real CLI.
fn lead(cx: &mut TestAppContext) -> (WindowHandle<Shell>, i64, i64) {
    let (window, other, lead) = crate::shell::tests::window(cx);
    window
        .update(cx, |shell, _, cx| {
            for id in [lead, other] {
                shell.sessions[&id].update(cx, |v, _| v.summary.provider = "fixture".into());
            }
            shell.sessions[&lead].update(cx, |v, cx| {
                v.install_transfer(
                    Settings {
                        operator_enabled: true,
                        orchestrator_enabled: true,
                        ..Default::default()
                    },
                    None,
                    cx,
                )
            });
        })
        .unwrap();
    cx.run_until_parked();
    (window, other, lead)
}

fn wake_ups(window: WindowHandle<Shell>, lead: i64, cx: &mut TestAppContext) -> Vec<String> {
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&lead]
                .read(cx)
                .transcript
                .read(cx)
                .source_rows()
                .iter()
                .filter(|r| r.role == "mono-system")
                .map(|r| r.text.clone())
                .collect()
        })
        .unwrap()
}

#[gpui::test]
fn an_ordinary_thread_delegates_and_its_first_agent_makes_it_the_lead(cx: &mut TestAppContext) {
    let (window, _, caller) = crate::shell::tests::window(cx);
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&caller].update(cx, |v, _| v.summary.provider = "fixture".into());
        })
        .unwrap();
    cx.run_until_parked();
    // Without Operator or Orchestrator a thread has only delegation.
    assert_eq!(
        call(window, caller, "sessions", "sessions.list", json!({}), cx).unwrap_err(),
        "Operator is not enabled for this thread."
    );
    let list = call(window, caller, "list-1", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["agents"], json!([]));
    window
        .update(cx, |shell, _, cx| {
            assert!(
                !shell.sessions[&caller]
                    .read(cx)
                    .settings
                    .orchestrator_enabled
            );
        })
        .unwrap();

    let started = call(
        window,
        caller,
        "start-api",
        "agents.start",
        json!({"name":"api","prompt":"Fix the login bug","workspace":"shared"}),
        cx,
    )
    .unwrap();
    assert!(
        started["lead"]
            .as_str()
            .unwrap()
            .starts_with("This thread now leads its agents")
    );
    let agent = started["sessionId"].as_i64().unwrap();
    window
        .update(cx, |shell, _, cx| {
            let lead = shell.sessions[&caller].read(cx);
            assert!(lead.settings.orchestrator_enabled && lead.settings.operator_enabled);
            assert!(!lead.settings.orchestrator, "no composer mode was selected");
            let saved = locked(&shell.store)
                .unwrap()
                .agent_settings(caller)
                .unwrap()
                .unwrap();
            assert!(saved.orchestrator_enabled && saved.operator_enabled);
            assert_eq!(shell.orchestration_summaries[&caller].tasks[0].name, "api");
        })
        .unwrap();
    // The new lead hears about its agent like any lead.
    let updates = wake_ups(window, caller, cx);
    assert_eq!(updates.len(), 1);
    assert!(updates[0].contains("api failed"));
    // A lead keeps Operator's actions, and later starts carry no lead note.
    assert!(call(window, caller, "sessions-2", "sessions.list", json!({}), cx).is_ok());
    let second = call(
        window,
        caller,
        "start-docs",
        "agents.start",
        json!({"name":"docs","prompt":"Write the README","workspace":"shared"}),
        cx,
    )
    .unwrap();
    assert!(second.get("lead").is_none());

    // An agent cannot start agents of its own, nor use other app actions.
    for (request, action, input) in [
        (
            "nested",
            "agents.start",
            json!({"name":"sub","prompt":"Help"}),
        ),
        ("models", "models.list", json!({})),
    ] {
        assert!(
            call(window, agent, request, action, input, cx)
                .unwrap_err()
                .starts_with("Agents cannot use MonoCode app actions")
        );
    }
}

#[gpui::test]
fn a_started_agent_opens_as_a_tab_beside_its_lead_and_leaves_with_close(cx: &mut TestAppContext) {
    let (window, _, lead) = lead(cx);
    let start = |name: &str, extra: Value, cx: &mut TestAppContext| {
        let mut input = json!({"name":name,"prompt":"Do it","workspace":"shared"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let started = call(window, lead, name, "agents.start", input, cx).unwrap();
        started["sessionId"].as_i64().unwrap()
    };
    let tabs = |cx: &mut TestAppContext| {
        window
            .update(cx, |shell, _, cx| {
                shell
                    .strip_tabs(cx)
                    .iter()
                    .filter_map(TitleTab::session)
                    .collect::<Vec<_>>()
            })
            .unwrap()
    };
    let active = |cx: &mut TestAppContext| {
        window
            .update(cx, |shell, _, _| shell.workspace.active.unwrap())
            .unwrap()
    };
    let api = start("api", json!({}), cx);
    let docs = start("docs", json!({}), cx);
    assert_eq!(tabs(cx), [lead, api, docs]);
    assert_eq!(active(cx), lead, "a new agent leaves the lead in view");

    let web = start("web", json!({"reveal":true}), cx);
    assert_eq!(tabs(cx), [lead, api, docs, web]);
    assert_eq!(active(cx), web, "reveal still opens it");

    window
        .update(cx, |shell, w, cx| shell.open(lead, w, cx))
        .unwrap();
    cx.run_until_parked();
    call(
        window,
        lead,
        "close",
        "agents.close",
        json!({"name":"docs"}),
        cx,
    )
    .unwrap();
    assert_eq!(tabs(cx), [lead, api, web]);
    assert_eq!(active(cx), lead);
}

#[gpui::test]
fn sending_with_orchestrator_selected_makes_a_lead(cx: &mut TestAppContext) {
    let (window, _, caller) = crate::shell::tests::window(cx);
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&caller].update(cx, |v, cx| {
                v.summary.provider = "fixture".into();
                v.quick_submit(
                    "/orchestrator Lead this work".into(),
                    v.settings.clone(),
                    cx,
                );
                assert!(!v.settings.orchestrator);
                assert!(v.settings.orchestrator_enabled && v.settings.operator_enabled);
            });
        })
        .unwrap();
    cx.run_until_parked();
    let list = call(window, caller, "list-2", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["agents"], json!([]));
    // Unlike the old plan runner, a lead keeps its write access.
    assert!(
        call(
            window,
            caller,
            "note",
            "notes.write",
            json!({"title":"Plan","body":"Lead"}),
            cx
        )
        .is_ok()
    );
    // The flag survives a reload of its settings.
    window
        .update(cx, |shell, _, _| {
            let saved = locked(&shell.store)
                .unwrap()
                .agent_settings(caller)
                .unwrap()
                .unwrap();
            assert!(saved.orchestrator_enabled && !saved.orchestrator);
        })
        .unwrap();
}

#[gpui::test]
fn a_started_agent_reports_its_failed_turn_to_the_lead(cx: &mut TestAppContext) {
    let (window, _, lead) = lead(cx);
    let started = call(
        window,
        lead,
        "start-api",
        "agents.start",
        json!({"name":"api","prompt":"Fix the login bug","workspace":"shared"}),
        cx,
    )
    .unwrap();
    assert_eq!(started["name"], "api");
    assert_eq!(started["harness"], "codex");
    let id = started["sessionId"].as_i64().unwrap();
    window
        .update(cx, |shell, _, cx| {
            let task = &shell.orchestration_summaries[&lead].tasks[0];
            assert_eq!(
                (task.name.as_str(), task.status.as_str()),
                ("api", "failed")
            );
            assert!(shell.orchestration_worker(id));
            let worker = shell.sessions[&id].read(cx);
            assert_eq!(worker.summary.title, "api: Fix the login bug");
            assert!(!worker.settings.operator_enabled && !worker.settings.orchestrator_enabled);
            let rows = worker.transcript.read(cx).source_rows();
            assert!(rows[0].text.starts_with("You are agent `api`"));
            assert!(rows[0].text.ends_with("Fix the login bug"));
        })
        .unwrap();
    let updates = wake_ups(window, lead, cx);
    assert_eq!(updates.len(), 1, "one wake-up for one event");
    assert!(updates[0].starts_with("[Orchestration update]"));
    assert!(updates[0].contains("api failed"));
    assert!(updates[0].contains("Unknown provider: fixture"));

    assert!(
        call(
            window,
            lead,
            "start-again",
            "agents.start",
            json!({"name":"api","prompt":"Again","workspace":"shared"}),
            cx
        )
        .unwrap_err()
        .contains("already named api")
    );
    let list = call(window, lead, "list", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["agents"][0]["state"], "failed");
    assert!(
        list["agents"][0]["error"]
            .as_str()
            .unwrap()
            .contains("Unknown provider")
    );
    let read = call(
        window,
        lead,
        "read",
        "agents.read",
        json!({"name":"api"}),
        cx,
    )
    .unwrap();
    assert_eq!(read["view"], "last");
    assert!(
        read["finalMessage"]
            .as_str()
            .unwrap()
            .contains("Unknown provider")
    );
    // The wake-up already reported it, so a wait has nothing new.
    let waited = call(
        window,
        lead,
        "wait",
        "agents.wait",
        json!({"timeoutSeconds":0}),
        cx,
    )
    .unwrap();
    assert_eq!(waited["matched"], false);
    assert_eq!(waited["agents"][0]["state"], "failed");

    let closed = call(
        window,
        lead,
        "close",
        "agents.close",
        json!({"name":"api"}),
        cx,
    )
    .unwrap();
    assert_eq!(closed["closed"], true);
    window
        .update(cx, |shell, _, cx| {
            assert_eq!(
                shell.orchestration_summaries[&lead].tasks[0].status,
                "closed"
            );
            // The lead's past agents still say how its work ended.
            assert_eq!(
                shell.orchestration_summaries[&lead].tasks[0]
                    .outcome
                    .as_deref(),
                Some("failed")
            );
            assert!(shell.sessions[&id].read(cx).summary.archived);
            assert!(
                locked(&shell.store)
                    .unwrap()
                    .sessions()
                    .unwrap()
                    .iter()
                    .any(|s| s.id == id && s.archived)
            );
        })
        .unwrap();
    // A closed agent stays readable by name, from its saved transcript, but
    // nothing else can drive it.
    window
        .update(cx, |shell, _, _| {
            shell.sessions.remove(&id);
        })
        .unwrap();
    let list = call(window, lead, "list-closed", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["agents"], json!([]));
    assert_eq!(list["closedAgentNames"], json!(["api"]));
    let read = call(
        window,
        lead,
        "read-closed",
        "agents.read",
        json!({"name":"api"}),
        cx,
    )
    .unwrap();
    assert_eq!(read["sessionId"], id);
    assert_eq!(read["state"], "closed");
    assert_eq!(read["outcome"], "failed");
    assert_eq!(read["view"], "last");
    assert!(
        read["finalMessage"]
            .as_str()
            .unwrap()
            .contains("Unknown provider")
    );
    let history = call(
        window,
        lead,
        "read-closed-history",
        "agents.read",
        json!({"name":"api","view":"history"}),
        cx,
    )
    .unwrap();
    assert_eq!(history["state"], "closed");
    assert_eq!(history["sessionId"], id);
    assert!(history.to_string().contains("Fix the login bug"));
    window
        .update(cx, |shell, _, _| {
            assert!(
                !shell.sessions.contains_key(&id),
                "reading a closed agent does not load its chat"
            );
        })
        .unwrap();
    assert!(
        call(
            window,
            lead,
            "prompt-closed",
            "agents.prompt",
            json!({"name":"api","prompt":"More"}),
            cx
        )
        .unwrap_err()
        .contains("No open agent")
    );
    assert!(
        call(
            window,
            lead,
            "read-unknown",
            "agents.read",
            json!({"name":"nobody"}),
            cx
        )
        .unwrap_err()
        .contains("No open or closed agent")
    );
    // A closed agent's name is free again, and the open agent wins the read.
    let second = call(
        window,
        lead,
        "start-reuse",
        "agents.start",
        json!({"name":"api","prompt":"Second try","workspace":"shared"}),
        cx,
    )
    .unwrap()["sessionId"]
        .as_i64()
        .unwrap();
    assert_ne!(second, id);
    let read = call(
        window,
        lead,
        "read-reused",
        "agents.read",
        json!({"name":"api"}),
        cx,
    )
    .unwrap();
    assert_eq!(read["sessionId"], second);
    assert_ne!(read["state"], "closed");
    assert!(read.get("outcome").is_none());
    // With both closed, the name means the newest.
    call(
        window,
        lead,
        "close-reused",
        "agents.close",
        json!({"name":"api"}),
        cx,
    )
    .unwrap();
    let read = call(
        window,
        lead,
        "read-newest",
        "agents.read",
        json!({"name":"api"}),
        cx,
    )
    .unwrap();
    assert_eq!(read["sessionId"], second);
    assert_eq!(read["state"], "closed");
    let list = call(window, lead, "list-both", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["closedAgents"], 2);
    assert_eq!(list["closedAgentNames"], json!(["api"]));
}

#[gpui::test]
fn the_lead_waits_steers_and_decides_for_a_working_agent(cx: &mut TestAppContext) {
    let (window, worker, lead) = lead(cx);
    window
        .update(cx, |shell, _, cx| {
            // The user is writing to the lead, so updates wait for it.
            shell.sessions[&lead].update(cx, |v, cx| {
                v.input.update(cx, |i, cx| i.set_text("typing".into(), cx))
            });
            shell.save_summary(
                lead,
                Summary {
                    tasks: vec![SummaryTask {
                        session: Some(worker),
                        name: "web".into(),
                        title: "web: UI".into(),
                        provider: "fixture".into(),
                        model: None,
                        status: "running".into(),
                        outcome: None,
                    }],
                    live: true,
                },
                cx,
            );
            shell.sessions[&worker].update(cx, |v, cx| {
                v.busy = true;
                cx.emit(SessionChanged);
            });
        })
        .unwrap();
    cx.run_until_parked();
    let read = call(
        window,
        lead,
        "read",
        "agents.read",
        json!({"name":"web"}),
        cx,
    )
    .unwrap();
    assert_eq!(
        (read["state"].as_str(), read["view"].as_str()),
        (Some("working"), Some("activity"))
    );
    assert_eq!(
        read["activity"]["latestText"],
        "History loaded when the adjacent tab becomes active"
    );

    // A blocking wait is answered by the next event.
    let (reply, waited) = mpsc::channel();
    window
        .update(cx, |shell, window, cx| {
            shell.handle_app_call(
                Call {
                    session: lead,
                    request_id: "wait-1".into(),
                    action: "agents.wait".into(),
                    input: json!({"names":["web"],"timeoutSeconds":30}),
                    reply,
                },
                window,
                cx,
            )
        })
        .unwrap();
    cx.run_until_parked();
    assert!(waited.try_recv().is_err(), "nothing has happened yet");
    let decisions = window
        .update(cx, |shell, _, cx| {
            shell.sessions[&worker].update(cx, |v, cx| {
                v.test_wait_for_approval(
                    Approval {
                        id: "req-1".into(),
                        title: "Run command".into(),
                        detail: "npm install".into(),
                        can_remember: false,
                        remembers: Vec::new(),
                    },
                    cx,
                )
            })
        })
        .unwrap();
    cx.run_until_parked();
    let event = waited.try_recv().unwrap().unwrap();
    assert_eq!(event["matched"], true);
    assert_eq!(event["events"][0]["event"], "blocked");
    assert_eq!(event["events"][0]["needsInput"]["requestId"], "req-1");
    assert_eq!(event["events"][0]["needsInput"]["detail"], "npm install");

    // A blocked agent refuses prompts until the lead decides.
    assert!(
        call(
            window,
            lead,
            "p1",
            "agents.prompt",
            json!({"name":"web","prompt":"Hurry"}),
            cx
        )
        .unwrap_err()
        .contains("decide it first")
    );
    assert!(
        call(
            window,
            lead,
            "a1",
            "agents.approve",
            json!({"name":"web","decision":"session"}),
            cx
        )
        .unwrap_err()
        .contains("cannot be allowed for the session")
    );
    let approved = call(
        window,
        lead,
        "a2",
        "agents.approve",
        json!({"name":"web","decision":"allow"}),
        cx,
    )
    .unwrap();
    assert_eq!(approved["requestId"], "req-1");
    assert!(matches!(
        decisions.try_recv().unwrap().decision,
        Decision::Allow
    ));

    // The turn ends while the lead is busy: the event waits for it, and a
    // wait takes it instead of a wake-up.
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&worker].update(cx, |v, cx| v.test_end_turn(cx));
        })
        .unwrap();
    cx.run_until_parked();
    assert!(wake_ups(window, lead, cx).is_empty());
    let finished = call(
        window,
        lead,
        "w2",
        "agents.wait",
        json!({"timeoutSeconds":0}),
        cx,
    )
    .unwrap();
    assert_eq!(finished["events"][0]["event"], "finished");
    assert_eq!(finished["agents"][0]["state"], "idle");

    // Its next task starts a turn; the fixture fails it, and the now idle
    // lead hears about it.
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&lead].update(cx, |v, cx| {
                v.input.update(cx, |i, cx| i.set_text(String::new(), cx))
            });
        })
        .unwrap();
    let prompted = call(
        window,
        lead,
        "p2",
        "agents.prompt",
        json!({"name":"web","prompt":"Add tests"}),
        cx,
    )
    .unwrap();
    assert_eq!(prompted["delivered"], "turn");
    let updates = wake_ups(window, lead, cx);
    assert_eq!(updates.len(), 1);
    assert!(updates[0].contains("web failed"));
    assert!(
        !updates[0].contains("web finished"),
        "the waited event is not sent again"
    );
}

#[gpui::test]
fn a_stop_the_lead_asked_for_is_not_news(cx: &mut TestAppContext) {
    let (window, worker, lead) = lead(cx);
    window
        .update(cx, |shell, _, cx| {
            shell.save_summary(
                lead,
                Summary {
                    tasks: vec![SummaryTask {
                        session: Some(worker),
                        name: "db".into(),
                        title: "db: Migrations".into(),
                        provider: "fixture".into(),
                        model: None,
                        status: "running".into(),
                        outcome: None,
                    }],
                    live: true,
                },
                cx,
            );
            shell.sessions[&worker].update(cx, |v, cx| {
                v.busy = true;
                cx.emit(SessionChanged);
            });
        })
        .unwrap();
    cx.run_until_parked();
    let queued = call(
        window,
        lead,
        "q",
        "agents.prompt",
        json!({"name":"db","prompt":"Also check indexes","mode":"queue"}),
        cx,
    )
    .unwrap();
    assert_eq!(queued["delivered"], "queued");
    let stopped = call(window, lead, "s", "agents.stop", json!({"name":"db"}), cx).unwrap();
    assert_eq!(stopped["stopped"], true);
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&worker].update(cx, |v, cx| v.test_end_turn(cx));
        })
        .unwrap();
    cx.run_until_parked();
    window
        .update(cx, |shell, _, cx| {
            assert_eq!(
                shell.orchestration_summaries[&lead].tasks[0].status,
                "stopped"
            );
            assert!(!shell.orchestration_summaries[&lead].live);
            assert_eq!(
                shell.sessions[&worker].read(cx).agent_held_messages(),
                (1, true)
            );
        })
        .unwrap();
    assert!(wake_ups(window, lead, cx).is_empty());
    let list = call(window, lead, "l", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["agents"][0]["state"], "stopped");
    assert_eq!(list["agents"][0]["heldMessages"], 1);
    assert_eq!(list["unreportedEvents"], 0);
}

#[gpui::test]
fn parallel_starts_cannot_share_a_name(cx: &mut TestAppContext) {
    let (window, _, lead) = lead(cx);
    let start = |request: &str, reply| Call {
        session: lead,
        request_id: request.into(),
        action: "agents.start".into(),
        input: json!({"name":"api","prompt":"Build it","workspace":"shared"}),
        reply,
    };
    let (first, first_result) = mpsc::channel();
    let (second, second_result) = mpsc::channel();
    window
        .update(cx, |shell, window, cx| {
            // Both arrive before the first one's session exists.
            shell.handle_app_call(start("one", first), window, cx);
            shell.handle_app_call(start("two", second), window, cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(first_result.try_recv().unwrap().is_ok());
    assert!(
        second_result
            .try_recv()
            .unwrap()
            .unwrap_err()
            .contains("already named api")
    );
    window
        .update(cx, |shell, _, _| {
            assert_eq!(shell.orchestration_summaries[&lead].tasks.len(), 1);
            assert!(shell.orchestrations.starting.is_empty());
        })
        .unwrap();
}

#[gpui::test]
fn reading_a_finished_agent_counts_as_its_update_and_open_shows_it(cx: &mut TestAppContext) {
    let (window, worker, lead) = lead(cx);
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&lead].update(cx, |v, cx| {
                v.input.update(cx, |i, cx| i.set_text("typing".into(), cx))
            });
            shell.save_summary(
                lead,
                Summary {
                    tasks: vec![SummaryTask {
                        session: Some(worker),
                        name: "web".into(),
                        title: "web: UI".into(),
                        provider: "fixture".into(),
                        model: None,
                        status: "running".into(),
                        outcome: None,
                    }],
                    live: true,
                },
                cx,
            );
            shell.sessions[&worker].update(cx, |v, cx| {
                v.busy = true;
                cx.emit(SessionChanged);
            });
        })
        .unwrap();
    cx.run_until_parked();
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&worker].update(cx, |v, cx| v.test_end_turn(cx));
        })
        .unwrap();
    cx.run_until_parked();
    let list = call(window, lead, "l1", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["unreportedEvents"], 1);
    let read = call(window, lead, "r", "agents.read", json!({"name":"web"}), cx).unwrap();
    assert_eq!(read["view"], "last");
    let list = call(window, lead, "l2", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["unreportedEvents"], 0, "the lead already read it");

    // The user's draft in an idle agent's composer is left alone.
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&worker].update(cx, |v, cx| {
                v.input
                    .update(cx, |i, cx| i.set_text("my own note".into(), cx))
            });
        })
        .unwrap();
    let prompted = call(
        window,
        lead,
        "p",
        "agents.prompt",
        json!({"name":"web","prompt":"Next task"}),
        cx,
    )
    .unwrap();
    assert_eq!(prompted["delivered"], "turn");
    window
        .update(cx, |shell, _, cx| {
            let worker = shell.sessions[&worker].read(cx);
            assert_eq!(worker.input.read(cx).content, "my own note");
            assert!(
                worker
                    .transcript
                    .read(cx)
                    .source_rows()
                    .iter()
                    .any(|r| r.role == "user" && r.text == "Next task")
            );
        })
        .unwrap();

    let opened = call(window, lead, "o", "agents.open", json!({"name":"web"}), cx).unwrap();
    assert_eq!(opened["opened"], true);
    window
        .update(cx, |shell, _, _| {
            assert_eq!(shell.workspace.active, Some(worker))
        })
        .unwrap();
}

#[gpui::test]
fn deleting_an_agents_session_retires_it_from_its_lead(cx: &mut TestAppContext) {
    let (window, _, lead) = lead(cx);
    let started = call(
        window,
        lead,
        "start",
        "agents.start",
        json!({"name":"api","prompt":"Build it","workspace":"shared"}),
        cx,
    )
    .unwrap();
    let id = started["sessionId"].as_i64().unwrap();
    window
        .update(cx, |shell, window, cx| shell.delete_session(id, window, cx))
        .unwrap();
    cx.run_until_parked();
    let list = call(window, lead, "list", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["agents"], json!([]));
    assert_eq!(list["closedAgents"], 1);
    assert_eq!(list["closedAgentNames"], json!([]));
    assert!(
        call(
            window,
            lead,
            "read",
            "agents.read",
            json!({"name":"api"}),
            cx
        )
        .unwrap_err()
        .contains("was deleted")
    );
}

#[gpui::test]
fn plain_request_ids_decide_and_user_decisions_are_not_news(cx: &mut TestAppContext) {
    let (window, worker, lead) = lead(cx);
    window
        .update(cx, |shell, _, cx| {
            // The lead is busy, so events wait in its mailbox.
            shell.sessions[&lead].update(cx, |v, cx| {
                v.input.update(cx, |i, cx| i.set_text("typing".into(), cx))
            });
            shell.save_summary(
                lead,
                Summary {
                    tasks: vec![SummaryTask {
                        session: Some(worker),
                        name: "docs".into(),
                        title: "docs: README".into(),
                        provider: "fixture".into(),
                        model: None,
                        status: "running".into(),
                        outcome: None,
                    }],
                    live: true,
                },
                cx,
            );
        })
        .unwrap();
    cx.run_until_parked();
    // Claude's request ids reach the session JSON-encoded.
    let approval = |id: &str| Approval {
        id: format!("\"{id}\""),
        title: "Allow Bash?".into(),
        detail: "python3 -c 'print(1)'".into(),
        can_remember: true,
        remembers: vec!["Bash(python3 -c 'print(1)')".into()],
    };
    let decisions = window
        .update(cx, |shell, _, cx| {
            shell.sessions[&worker]
                .update(cx, |v, cx| v.test_wait_for_approval(approval("w-1"), cx))
        })
        .unwrap();
    cx.run_until_parked();
    let list = call(window, lead, "l1", "agents.list", json!({}), cx).unwrap();
    let pending = &list["agents"][0]["needsInput"][0];
    assert_eq!(pending["requestId"], "w-1");
    assert_eq!(pending["decisions"], json!(["allow", "session", "deny"]));
    assert_eq!(list["agents"][0]["runtimeMode"], "supervised");
    assert_eq!(list["unreportedEvents"], 1);

    // The user allows it in the agent's chat before the lead gets to it: the
    // lead's "needs input" event is dropped, not sent later as a wake-up.
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&worker].update(cx, |v, cx| {
                assert!(v.decide_notification_request("\"w-1\"", Decision::Allow, cx))
            })
        })
        .unwrap();
    cx.run_until_parked();
    assert!(matches!(
        decisions.try_recv().unwrap().decision,
        Decision::Allow
    ));
    let list = call(window, lead, "l2", "agents.list", json!({}), cx).unwrap();
    assert_eq!(list["unreportedEvents"], 0);
    let late = call(
        window,
        lead,
        "a1",
        "agents.approve",
        json!({"name":"docs","requestId":"w-1","decision":"allow"}),
        cx,
    )
    .unwrap_err();
    assert!(late.contains("no longer pending"), "{late}");

    // The next request is decided by its plain id, as needsInput shows it.
    let decisions = window
        .update(cx, |shell, _, cx| {
            shell.sessions[&worker]
                .update(cx, |v, cx| v.test_wait_for_approval(approval("w-2"), cx))
        })
        .unwrap();
    cx.run_until_parked();
    let approved = call(
        window,
        lead,
        "a2",
        "agents.approve",
        json!({"name":"docs","requestId":"w-2","decision":"session"}),
        cx,
    )
    .unwrap();
    assert_eq!(approved["requestId"], "w-2");
    assert!(matches!(
        decisions.try_recv().unwrap().decision,
        Decision::Session
    ));

    // Once the lead is free, only news reaches it.
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&lead].update(cx, |v, cx| {
                v.input.update(cx, |i, cx| i.set_text(String::new(), cx))
            });
            shell.sessions[&worker].update(cx, |v, cx| v.test_end_turn(cx));
        })
        .unwrap();
    cx.run_until_parked();
    let updates = wake_ups(window, lead, cx);
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert!(updates[0].contains("docs finished"));
    assert!(!updates[0].contains("needs input"), "{}", updates[0]);
}
