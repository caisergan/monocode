//! GitPullRequests.tsx's list: the pull requests of the repository this
//! working copy pushes to, by state (Tauri's git_github_pull_requests).
use super::{expand_home, gh_run, git_stdout, github_repo_for, remote_workspace};
use serde::Deserialize;
use std::path::Path;
use std::sync::Mutex;

/// One row of a project's pull request list, with enough to triage it at a
/// glance: who opened it, which branch, how review and CI stand.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `open`, `merged` or `closed`.
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub author_is_bot: bool,
    pub head_ref: String,
    pub base_ref: String,
    /// The head branch lives in another repository, usually a contributor's fork.
    pub cross_repository: bool,
    pub updated_at: String,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or empty.
    pub review_decision: String,
    /// Rolled-up CI for open pull requests: `pass`, `fail`, `pending`, or
    /// empty when there are no checks or they were not requested.
    pub checks: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PullRequestList {
    pub repo: String,
    /// The signed-in GitHub login, so the list can tell your pull requests apart.
    pub viewer: String,
    pub items: Vec<PullRequest>,
}

pub fn pull_requests(cwd: &Path, state: &str, limit: u32) -> Result<PullRequestList, String> {
    if remote_workspace::is_remote(cwd) {
        return Err("Pull requests are listed for local projects only".into());
    }
    let root = expand_home(cwd);
    let state = match state.trim().to_ascii_lowercase().as_str() {
        "open" => "open",
        "merged" => "merged",
        "closed" => "closed",
        _ => return Err("Unknown pull request state".into()),
    };
    let repo = push_repo(&root)?;
    let limit = limit.clamp(1, 100).to_string();
    let mut fields = String::from(
        "number,title,url,state,isDraft,author,headRefName,baseRefName,isCrossRepository,\
         updatedAt,mergedAt,closedAt,reviewDecision",
    );
    // Checks are the expensive part of the query and only matter while open.
    if state == "open" {
        fields.push_str(",statusCheckRollup");
    }
    let mut args = vec![
        "pr", "list", "--repo", &repo, "--state", state, "--limit", &limit, "--json", &fields,
    ];
    // gh counts merged pull requests as closed; the Closed list is the rest.
    if state == "closed" {
        args.extend(["--search", "is:unmerged"]);
    }
    let json = gh_run(&root, &args)?;
    Ok(PullRequestList {
        items: parse(&json)?,
        viewer: viewer(&root),
        repo,
    })
}

/// Check out a pull request's branch, including one from a fork.
pub fn checkout(cwd: &Path, number: u64) -> Result<(), String> {
    if remote_workspace::is_remote(cwd) {
        return Err("Pull requests are checked out in local projects only".into());
    }
    let number = number.to_string();
    // gh prints nothing on stdout when it switches, which gh_run reports as an error.
    match gh_run(&expand_home(cwd), &["pr", "checkout", &number]) {
        Ok(_) => Ok(()),
        Err(error) if error == "gh returned no output" => Ok(()),
        Err(error) => Err(error),
    }
}

/// `origin` decides the repository when it is on GitHub. For a fork that is
/// the user's own copy, where `gh` would pick the parent named by `upstream`.
fn push_repo(root: &Path) -> Result<String, String> {
    git_stdout(root, &["remote", "get-url", "origin"])
        .and_then(|url| slug_from_remote(&url))
        .map_or_else(|| github_repo_for(root), Ok)
}

/// `owner/name` from an https, ssh or scp-style github.com remote URL.
fn slug_from_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let (authority, path) = match url.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?,
        None => url.split_once(':')?,
    };
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    let valid = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (valid(owner) && valid(name)).then(|| format!("{owner}/{name}"))
}

static VIEWER: Mutex<Option<String>> = Mutex::new(None);

/// Looked up once per run; an empty login just means rows show every author.
fn viewer(root: &Path) -> String {
    if let Some(login) = VIEWER.lock().ok().and_then(|viewer| viewer.clone()) {
        return login;
    }
    let login = gh_run(root, &["api", "user", "--jq", ".login"])
        .map(|login| login.trim().to_owned())
        .unwrap_or_default();
    if !login.is_empty() {
        if let Ok(mut viewer) = VIEWER.lock() {
            *viewer = Some(login.clone());
        }
    }
    login
}

fn parse(json: &str) -> Result<Vec<PullRequest>, String> {
    #[derive(Deserialize, Default)]
    struct Author {
        #[serde(default)]
        login: String,
        #[serde(default)]
        is_bot: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        number: u64,
        title: String,
        url: String,
        state: String,
        #[serde(default)]
        is_draft: bool,
        #[serde(default)]
        author: Option<Author>,
        #[serde(default)]
        head_ref_name: String,
        #[serde(default)]
        base_ref_name: String,
        #[serde(default)]
        is_cross_repository: bool,
        #[serde(default)]
        updated_at: String,
        #[serde(default)]
        merged_at: Option<String>,
        #[serde(default)]
        closed_at: Option<String>,
        #[serde(default)]
        review_decision: Option<String>,
        #[serde(default)]
        status_check_rollup: Option<Vec<crate::inbox::github::GitHubStatusCheckRow>>,
    }
    let rows: Vec<Row> = serde_json::from_str(json).map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let author = row.author.unwrap_or_default();
            PullRequest {
                number: row.number,
                title: row.title,
                url: row.url,
                state: row.state.to_lowercase(),
                draft: row.is_draft,
                author: author.login,
                author_is_bot: author.is_bot,
                head_ref: row.head_ref_name,
                base_ref: row.base_ref_name,
                cross_repository: row.is_cross_repository,
                updated_at: row.updated_at,
                merged_at: row.merged_at.filter(|value| !value.is_empty()),
                closed_at: row.closed_at.filter(|value| !value.is_empty()),
                review_decision: row.review_decision.unwrap_or_default().to_uppercase(),
                checks: rollup(row.status_check_rollup.unwrap_or_default()),
            }
        })
        .collect())
}

/// One word for a PR's CI: any failure wins, then anything still running.
fn rollup(rows: Vec<crate::inbox::github::GitHubStatusCheckRow>) -> String {
    let states: Vec<String> = rows
        .into_iter()
        .map(|row| crate::inbox::github::github_pr_check_from_row(row).state)
        .collect();
    ["fail", "pending", "pass"]
        .into_iter()
        .find(|state| states.iter().any(|s| s == state))
        .unwrap_or("")
        .to_owned()
}

impl PullRequest {
    /// When the row's state last changed: merged, closed, or updated.
    pub fn changed_at(&self) -> &str {
        self.merged_at
            .as_deref()
            .or(self.closed_at.as_deref())
            .unwrap_or(&self.updated_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_urls_name_github_repositories_only() {
        for url in [
            "https://github.com/caisergan/monocode.git",
            "git@github.com:caisergan/monocode.git",
            "ssh://git@github.com/caisergan/monocode",
            "https://user@GitHub.com/caisergan/monocode/",
        ] {
            assert_eq!(
                slug_from_remote(url).as_deref(),
                Some("caisergan/monocode"),
                "{url}"
            );
        }
        for url in [
            "https://gitlab.com/a/b.git",
            "git@github.com:a",
            "/local/path",
        ] {
            assert_eq!(slug_from_remote(url), None, "{url}");
        }
    }

    #[test]
    fn rows_keep_state_review_and_rolled_up_checks() {
        let json = r#"[
          {"number":12,"title":"Fix","url":"https://github.com/a/b/pull/12","state":"OPEN","isDraft":true,
           "author":{"login":"ege","is_bot":false},"headRefName":"fix/x","baseRefName":"dev",
           "isCrossRepository":false,"updatedAt":"2026-10-29T10:00:00Z","reviewDecision":"APPROVED",
           "statusCheckRollup":[
             {"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"SUCCESS"},
             {"__typename":"CheckRun","name":"lint","status":"IN_PROGRESS","conclusion":""}]},
          {"number":9,"title":"Old","url":"https://github.com/a/b/pull/9","state":"MERGED",
           "author":null,"mergedAt":"2026-10-20T10:00:00Z","closedAt":""}
        ]"#;
        let rows = parse(json).unwrap();
        assert_eq!(rows[0].state, "open");
        assert!(rows[0].draft);
        assert_eq!(rows[0].review_decision, "APPROVED");
        assert_eq!(rows[0].checks, "pending");
        assert_eq!(rows[1].author, "");
        assert_eq!(rows[1].checks, "");
        assert_eq!(rows[1].closed_at, None);
        assert_eq!(rows[1].changed_at(), "2026-10-20T10:00:00Z");
    }
}
