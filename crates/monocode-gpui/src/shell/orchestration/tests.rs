use super::*;
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
fn agents_actions_belong_to_orchestrator_threads(cx: &mut TestAppContext) {
    let (window, _, caller) = crate::shell::tests::window(cx);
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&caller].update(cx, |v, cx| {
                v.summary.provider = "fixture".into();
                v.install_transfer(
                    Settings {
                        operator_enabled: true,
                        ..Default::default()
                    },
                    None,
                    cx,
                )
            });
        })
        .unwrap();
    cx.run_until_parked();
    assert!(
        call(window, caller, "list-1", "agents.list", json!({}), cx)
            .unwrap_err()
            .contains("Orchestrator threads")
    );
    window
        .update(cx, |shell, _, cx| {
            shell.sessions[&caller].update(cx, |v, cx| {
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
    assert!(
        call(
            window,
            lead,
            "read-closed",
            "agents.read",
            json!({"name":"api"}),
            cx
        )
        .unwrap_err()
        .contains("No open agent")
    );
    // A closed agent's name is free again.
    assert!(
        call(
            window,
            lead,
            "start-reuse",
            "agents.start",
            json!({"name":"api","prompt":"Second try","workspace":"shared"}),
            cx
        )
        .is_ok()
    );
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
        .contains("cannot be remembered")
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
        .contains("No open agent")
    );
}
