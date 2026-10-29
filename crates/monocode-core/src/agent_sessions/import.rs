//! agentSessionImport.ts: an agent's terminal conversation saved as a
//! MonoCode chat. The chat keeps the agent's session id, so the next message
//! resumes that conversation.
use super::{rows, AgentSessionSummary, Harness, Known, KnownSession, SessionFolder};
use crate::store::{Session, Store};

/// Where an imported conversation lives: its project (or "~" for a chat
/// without one), the linked worktree it ran in, and whether the agent can
/// resume it, which only works from the folder it ran in.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub cwd: String,
    pub worktree_cwd: Option<String>,
    pub resumable: bool,
}

pub fn plan(summary: &AgentSessionSummary) -> Plan {
    match summary.folder {
        SessionFolder::Home => Plan {
            cwd: "~".into(),
            worktree_cwd: None,
            resumable: true,
        },
        SessionFolder::Missing => Plan {
            cwd: "~".into(),
            worktree_cwd: None,
            resumable: false,
        },
        SessionFolder::Ok => match &summary.project {
            Some(project) => Plan {
                cwd: project.clone(),
                worktree_cwd: Some(summary.cwd.clone()),
                resumable: true,
            },
            None => Plan {
                cwd: summary.cwd.clone(),
                worktree_cwd: None,
                resumable: true,
            },
        },
    }
}

fn kind(harness: Harness) -> crate::provider::Kind {
    match harness {
        Harness::Claude => crate::provider::Kind::Claude,
        Harness::Codex => crate::provider::Kind::Codex,
        Harness::Pi => crate::provider::Kind::Pi,
        Harness::Omp => crate::provider::Kind::Omp,
    }
}

/// The MonoCode chats already holding each agent's conversations, so the
/// sheet opens them instead of importing a duplicate.
pub fn known(store: &Store) -> Result<Known, String> {
    let mut known = Known::new();
    for session in store.sessions()? {
        let Some(harness) = Harness::ALL
            .into_iter()
            .find(|harness| harness.id() == session.provider)
        else {
            continue;
        };
        if let Some(id) = &session.provider_id {
            let worktree_cwd = store
                .agent_settings(session.id)?
                .and_then(|settings| settings.worktree_cwd);
            known.entry(harness).or_default().insert(
                id.clone(),
                KnownSession {
                    id: session.id.to_string(),
                    cwd: session.cwd.clone(),
                    worktree_cwd,
                },
            );
        }
    }
    Ok(known)
}

/// Import `summary`, or find the chat that already holds it. Returns the
/// chat and whether it was already in MonoCode.
pub fn import(store: &mut Store, summary: &AgentSessionSummary) -> Result<(Session, bool), String> {
    let label = summary.harness.label();
    if let Some(existing) = store.sessions()?.into_iter().find(|session| {
        session.provider == summary.harness.id()
            && session.provider_id.as_deref() == Some(summary.id.as_str())
    }) {
        return Ok((existing, true));
    }
    let plan = plan(summary);
    let records = super::read_session(summary.harness, &summary.cwd, &summary.id)?;
    let mut imported = rows::rows(summary.harness, &records);
    if !imported.rows.iter().any(|row| row.role == "user") {
        return Err(format!("That {label} session has no messages to import."));
    }
    if !plan.resumable {
        let note = crate::transcript::Interjection {
            text: format!(
                "The folder this conversation ran in no longer exists, so the next message starts a new {label} conversation."
            ),
            custom_type: "custom".into(),
            severity: Some("warning".into()),
        };
        imported.rows.push(crate::transcript::Row {
            role: "interjection".into(),
            text: serde_json::to_string(&note).map_err(|e| e.to_string())?,
            first: true,
            sent_at: None,
        });
    }
    let kind = kind(summary.harness);
    let mut session = store.create(kind.id(), &plan.cwd)?;
    store.write_rows(session.id, 0, &imported.rows)?;
    if plan.resumable {
        store.provider_id(session.id, &summary.id)?;
        session.provider_id = Some(summary.id.clone());
    }
    let title = imported
        .title
        .clone()
        .or_else(|| summary.title.clone())
        .unwrap_or_else(|| summary.first_prompt.clone());
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = title.chars().take(80).collect();
    if !title.is_empty() {
        store.title(session.id, &title)?;
        session.title = title;
    }
    if let Some(worktree) = &plan.worktree_cwd {
        let mut settings = store.agent_settings(session.id)?.unwrap_or_default();
        settings.worktree_cwd = Some(worktree.clone());
        store.configure_agent(session.id, kind.id(), &settings)?;
    }
    session.has_messages = true;
    Ok((session, false))
}

#[cfg(test)]
mod tests {
    use super::super::{AgentSessionListing, SessionFolder};

    #[test]
    fn a_hosts_listing_reads_as_the_sheets_rows() {
        let listing: AgentSessionListing = serde_json::from_value(serde_json::json!({
            "sessions": [{
                "harness": "claude", "id": "5f1d7e1c-0000-4000-8000-000000000001",
                "cwd": "/home/me/repo", "title": null, "firstPrompt": "Fix it",
                "lastPrompt": "Fix it", "gitBranch": "dev", "updatedAt": 20,
                "sizeBytes": 400, "folder": "ok", "project": null, "monocodeSessionId": null
            }],
            "importedCount": 2,
            "hasMore": false
        }))
        .unwrap();
        assert_eq!(listing.sessions[0].folder, SessionFolder::Ok);
        assert_eq!(listing.sessions[0].first_prompt, "Fix it");
        assert_eq!(listing.imported_count, 2);
    }
}
