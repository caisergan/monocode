use super::*;

fn facts() -> Facts {
    Facts {
        projects: vec![
            "/p/monocode".into(),
            "/p/trade-station".into(),
            "/p/egeasirlik-web".into(),
        ],
        sessions: vec![
            SessionFact {
                id: 1,
                project: "/p/egeasirlik-web".into(),
                title: "CMS deploy fix".into(),
                harness: "claude".into(),
                worktree: Some("/p/egeasirlik-web-worktrees/cms".into()),
                busy: false,
                hidden: false,
            },
            SessionFact {
                id: 2,
                project: "/p/monocode".into(),
                title: "Remote host setup".into(),
                harness: "claude".into(),
                worktree: None,
                busy: false,
                hidden: false,
            },
            SessionFact {
                id: 3,
                project: "/p/monocode".into(),
                title: "A Mono".into(),
                harness: "claude".into(),
                worktree: None,
                busy: true,
                hidden: true,
            },
        ],
    }
}
fn config() -> Config {
    Config {
        models: vec![
            AllowedModel {
                harness: "claude".into(),
                model: "opus".into(),
            },
            AllowedModel {
                harness: "claude".into(),
                model: "sonnet".into(),
            },
            AllowedModel {
                harness: "pi".into(),
                model: "deepseek/deepseek-v4.1-flash".into(),
            },
        ],
        safe_list: vec![SafeCommand {
            project: "/p/monocode".into(),
            command: "npm test".into(),
        }],
        ..Config::default()
    }
}
fn plan(steps: Value) -> Result<Task, String> {
    parse_plan(
        &json!({"title":"Node 24 everywhere","steps":steps}),
        &config(),
        &facts(),
        "t1".into(),
        10,
    )
}

#[test]
fn a_plan_names_where_each_step_runs_and_defaults_to_the_plans_access() {
    let task = plan(json!([
        {"title":"Move the CMS","project":"egeasirlik-web","target":"message","sessionId":1,"prompt":"Move the CMS to Node 24."},
        {"title":"Move trade-station","project":"/p/trade-station","prompt":"Move it.","model":"sonnet"},
        {"title":"Move the host","project":"monocode","target":"continue","sessionId":2,"prompt":"Move the host."},
        {"title":"CI image","project":"trade-station","prompt":"Rebuild it.","after":[1,2],"harness":"pi"}
    ]))
    .unwrap();
    assert_eq!(task.state, TaskState::Proposed);
    assert_eq!(task.access, AccessMode::Auto);
    let ids: Vec<_> = task.steps.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["1", "2", "3", "4"]);
    assert_eq!(task.steps[0].project, "/p/egeasirlik-web");
    // A follow-up keeps the session's own provider and model.
    assert_eq!(task.steps[0].harness, "claude");
    assert_eq!(task.steps[0].model, None);
    assert_eq!(task.steps[1].model.as_deref(), Some("sonnet"));
    // No model given: the list's first for that harness.
    assert_eq!(task.steps[2].model.as_deref(), Some("opus"));
    assert_eq!(
        task.steps[3].model.as_deref(),
        Some("deepseek/deepseek-v4.1-flash")
    );
    assert_eq!(task.steps[3].after, ["1", "2"]);
    assert!(task.steps.iter().all(|s| s.access == AccessMode::Auto));
    assert!(task.steps[3].never_asks());
    assert_eq!(task.steps[3].json()["neverAsks"], true);
}

#[test]
fn a_session_in_the_main_checkout_is_continued_not_messaged() {
    let error = plan(json!([
        {"title":"Host","project":"monocode","target":"message","sessionId":2,"prompt":"x"}
    ]))
    .unwrap_err();
    assert!(error.contains("main checkout"), "{error}");
    assert!(error.contains("continue"), "{error}");
}

#[test]
fn plans_refuse_what_master_may_not_reach() {
    for (steps, needle) in [
        (
            json!([{"title":"x","project":"/p/elsewhere","prompt":"x"}]),
            "not a project",
        ),
        (
            json!([{"title":"x","project":"monocode","target":"continue","sessionId":3,"prompt":"x"}]),
            "not one Master can see",
        ),
        (
            json!([{"title":"x","project":"monocode","target":"continue","sessionId":1,"prompt":"x"}]),
            "is in /p/egeasirlik-web",
        ),
        (
            json!([{"title":"x","project":"monocode","prompt":"x","model":"haiku"}]),
            "not on Master's list",
        ),
        (
            json!([{"title":"x","project":"monocode","prompt":"x","access":"full-access"}]),
            "above the plan's auto",
        ),
        (
            json!([{"title":"x","project":"monocode","prompt":"x","after":[2]},{"title":"y","project":"monocode","prompt":"y"}]),
            "does not come before it",
        ),
        (
            json!([{"title":"x","project":"monocode","target":"new","sessionId":2,"prompt":"x"}]),
            "takes no sessionId",
        ),
        (
            json!([{"title":"x","project":"monocode","prompt":"x","force":true}]),
            "does not take force",
        ),
        (json!([]), "1 to 12 steps"),
    ] {
        let error = plan(steps).unwrap_err();
        assert!(error.contains(needle), "{needle}: {error}");
    }
}

#[test]
fn one_writer_per_checkout_within_a_plan() {
    let error = plan(json!([
        {"title":"a","project":"egeasirlik-web","target":"message","sessionId":1,"prompt":"a"},
        {"title":"b","project":"egeasirlik-web","target":"message","sessionId":1,"prompt":"b"}
    ]))
    .unwrap_err();
    assert!(error.contains("one writer per checkout"), "{error}");
    plan(json!([
        {"title":"a","project":"egeasirlik-web","target":"message","sessionId":1,"prompt":"a"},
        {"title":"b","project":"egeasirlik-web","target":"message","sessionId":1,"prompt":"b","after":[1]}
    ]))
    .unwrap();
    let mut facts = facts();
    facts.sessions[1].busy = true;
    assert_eq!(facts.writer("/p/monocode", None).map(|s| s.id), Some(2));
    // Hidden sessions still write in their checkout.
    assert_eq!(facts.writer("/p/monocode/", Some(2)).map(|s| s.id), Some(3));
    facts.sessions[2].busy = false;
    assert_eq!(facts.writer("/p/monocode", Some(2)), None);
}

#[test]
fn a_plan_may_raise_the_cap_but_steps_stay_under_it() {
    let task = parse_plan(
        &json!({"title":"t","access":"supervised","steps":[{"title":"x","project":"monocode","prompt":"x"}]}),
        &config(),
        &facts(),
        "t2".into(),
        0,
    )
    .unwrap();
    assert_eq!(task.steps[0].access, AccessMode::Supervised);
    assert!(parse_plan(
        &json!({"title":"t","access":"read-only","steps":[]}),
        &config(),
        &facts(),
        "t3".into(),
        0
    )
    .is_err());
}

#[test]
fn steps_start_only_in_a_running_task_after_their_dependencies() {
    let mut task = plan(json!([
        {"title":"a","project":"monocode","prompt":"a"},
        {"title":"b","project":"monocode","prompt":"b","after":["1"]}
    ]))
    .unwrap();
    assert!(task.blocked_start(0).unwrap().contains("proposed"));
    task.state = TaskState::Running;
    assert_eq!(task.blocked_start(0), None);
    assert!(task.blocked_start(1).unwrap().contains("waits for step 1"));
    task.steps[0].status = StepStatus::Working;
    assert!(task.blocked_start(0).unwrap().contains("already ran"));
    task.steps[0].status = StepStatus::Idle;
    assert_eq!(task.blocked_start(1), None);
}

#[test]
fn the_safe_list_holds_exact_single_commands_per_project() {
    let config = config();
    assert!(safe(&config, "/p/monocode", "npm test"));
    assert!(safe(&config, "/p/monocode/", " npm test "));
    assert!(!safe(&config, "/p/trade-station", "npm test"));
    assert!(!safe(&config, "/p/monocode", "npm test -- --watch"));
    assert!(!safe(&config, "/p/monocode", "npm test && git push"));
    for command in [
        "git push",
        "docker push registry/cms:24",
        "npm publish",
        "rm -rf build",
        "git reset --hard",
        "git branch -D old",
        "ssh vm sudo systemctl restart monocode-host",
        "curl https://example.com",
        "vercel deploy",
        "npm test | tee log",
        "cargo test > out",
    ] {
        assert!(can_add_safe(command).is_err(), "{command}");
    }
    for command in [
        "npm test",
        "cargo test",
        "cargo clippy",
        "git commit -m x",
        "npm run build -- --release",
    ] {
        assert!(can_add_safe(command).is_ok(), "{command}");
    }
}

#[test]
fn a_restart_stops_live_steps_and_reruns_nothing() {
    let mut state = State::default();
    let mut task = plan(json!([
        {"title":"a","project":"monocode","prompt":"a"},
        {"title":"b","project":"monocode","prompt":"b"},
        {"title":"c","project":"monocode","prompt":"c"}
    ]))
    .unwrap();
    task.state = TaskState::Running;
    task.steps[0].status = StepStatus::Working;
    task.steps[0].session = Some(9);
    task.steps[1].status = StepStatus::Idle;
    state.tasks.push(task);
    let saved: State = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
    assert_eq!(saved, state);
    assert_eq!(state.step_of(9), Some((0, 0)));
    assert_eq!(state.live_steps(), 1);
    assert_eq!(state.after_restart(), 1);
    let task = &state.tasks[0];
    assert!(task.restarted);
    assert_eq!(task.steps[0].status, StepStatus::Stopped);
    assert_eq!(task.steps[1].status, StepStatus::Idle);
    assert_eq!(task.steps[2].status, StepStatus::Planned);
    assert_eq!(state.live_steps(), 0);
}

#[test]
fn a_wake_up_names_each_step_and_says_who_decides_a_request() {
    let mut task = plan(json!([
        {"title":"Move the CMS","project":"egeasirlik-web","target":"message","sessionId":1,"prompt":"a"},
        {"title":"Move the host","project":"monocode","target":"continue","sessionId":2,"prompt":"b"}
    ]))
    .unwrap();
    task.state = TaskState::Running;
    let request = orch::Request {
        id: "\"r1\"".into(),
        kind: "approval",
        title: "Run a command".into(),
        detail: "docker push registry/cms:24".into(),
        items: Value::Null,
        remember: false,
        remembers: Vec::new(),
    };
    let finished = orch::Event {
        session: 20,
        name: String::new(),
        kind: orch::EventKind::Finished,
        at: 5,
        report: "Moved to Node 24. 214 tests pass.".into(),
        elapsed: Some(62_000),
    };
    let blocked = orch::Event {
        session: 1,
        name: String::new(),
        kind: orch::EventKind::Blocked(request),
        at: 6,
        report: String::new(),
        elapsed: None,
    };
    let updates = vec![
        Update::new(&task, &task.steps[1], &finished, false),
        Update::new(&task, &task.steps[0], &blocked, false),
    ];
    let saved: Vec<Update> =
        serde_json::from_str(&serde_json::to_string(&updates).unwrap()).unwrap();
    assert_eq!(saved, updates);
    let text = wake_message(&updates, &[task], false);
    assert!(text.starts_with("[Master update] monocode finished · egeasirlik-web needs input\n"));
    assert!(text.contains("Task t1 step 2 (monocode, Move the host) finished its turn, 62s."));
    assert!(text.contains("214 tests pass"));
    assert!(text.contains("(requestId r1)"));
    assert!(text.contains("not on the safe list"));
    assert!(text.contains("Task t1 \"Node 24 everywhere\": 1 planned, 2 planned"));
    assert!(!text.contains("last automatic update"));
    assert_eq!(updates[1].json(100)["needsInput"]["requestId"], "r1");
    assert_eq!(updates[1].json(100)["needsInput"]["masterMayAllow"], false);
}

#[test]
fn actions_reject_unknown_fields_and_wrong_values() {
    assert!(validate("master.sessions", &json!({"project":"monocode","limit":5})).is_ok());
    for (action, input, needle) in [
        ("master.edit", json!({}), "Unknown Master action"),
        ("master.sessions", json!({"all":true}), "does not take all"),
        (
            "master.sessions",
            json!({"limit":500}),
            "limit must be 1 to 50",
        ),
        ("master.search", json!({}), "Provide query"),
        ("master.read", json!({"sessionId":[1]}), "wrong type"),
        ("master.plan", json!({"title":"x"}), "Provide steps"),
        (
            "master.plan",
            json!({"title":"x","steps":[],"access":"read-only"}),
            "access must be one of",
        ),
        (
            "master.change",
            json!({"task":"t1","reason":"x"}),
            "adds steps",
        ),
        ("master.start", json!({"task":"t1"}), "Provide step"),
        (
            "master.message",
            json!({"task":"t1","step":1}),
            "Provide prompt",
        ),
        (
            "master.approve",
            json!({"task":"t1","step":1,"decision":"session"}),
            "decision must be one of",
        ),
        (
            "master.answer",
            json!({"task":"t1","step":1}),
            "answers, or skip",
        ),
        ("master.wait", json!({"timeoutSeconds":90}), "at most 45"),
        ("master.finish", json!({"task":"t1"}), "Provide report"),
    ] {
        let error = validate(action, &input).unwrap_err();
        assert!(error.contains(needle), "{action}: {error}");
    }
    assert!(reads("master.search") && !reads("master.message"));
    assert_eq!(step_id(&json!({"step":3})).as_deref(), Some("3"));
    assert_eq!(step_id(&json!({"step":" 3 "})).as_deref(), Some("3"));
}

#[test]
fn config_scope_leaves_out_excluded_and_remote_projects() {
    let mut config = config();
    config.excluded.push("/p/durum-hijyen-gida".into());
    assert!(config.includes("/p/monocode"));
    assert!(!config.includes("/p/durum-hijyen-gida/"));
    assert!(!config.includes("remote://vm/p/monocode"));
    assert!(Config::default()
        .step_model("codex", Some("gpt-5.5"))
        .is_ok());
    assert!(config
        .step_model("codex", None)
        .unwrap_err()
        .contains("No codex model"));
    let saved: Config = serde_json::from_str("{\"enabled\":true}").unwrap();
    assert_eq!(saved.max_sessions, 6);
    assert_eq!(saved.access, AccessMode::Auto);
    assert_eq!(saved.harness, "pi");
}

#[test]
fn senders_mark_masters_turns() {
    let sender = sender("t1", "3");
    assert_eq!(sender, "master:t1:3");
    assert!(from_master(Some(&sender)));
    assert!(!from_master(None));
    assert!(!from_master(Some("user")));
}
