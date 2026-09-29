//! Read the session transcripts coding-agent CLIs keep on disk, so a
//! conversation started in a terminal can be continued in MonoCode. Each
//! agent's module finds its transcripts, summarizes one, and slims one for
//! import; listing, caching, scoping and search are shared here.
//!
//! Only each agent's default config directory (or its documented override) is
//! scanned. Named MonoCode account profiles keep their sessions elsewhere and
//! already resume natively.

mod claude;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::dirs_home;
use crate::session_store::{KnownSession, SessionStore};

/// Beyond this a transcript is not worth replaying into the UI.
const MAX_SESSION_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Tool output is shown as a collapsed detail; the model keeps the full text.
const MAX_TOOL_RESULT_CHARS: usize = 16 * 1024;
/// Each string in a tool call's input (a whole file for Write, say) is capped
/// the same way; the transcript only previews it.
const MAX_TOOL_INPUT_CHARS: usize = 16 * 1024;
const MAX_PROMPT_PREVIEW_CHARS: usize = 200;
/// A summary reads the start of a transcript (cwd, first prompt) and its end
/// (titles, last prompt), never the middle of a long session.
const SUMMARY_HEAD_BYTES: u64 = 64 * 1024;
const SUMMARY_TAIL_BYTES: u64 = 256 * 1024;
const MAX_SUMMARY_TAIL_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_LIST_LIMIT: usize = 15;
const MAX_LIST_LIMIT: usize = 200;
/// Newest transcripts summarized per listing; a search looks no further back.
const MAX_SUMMARIZED: usize = 500;

/// Agents whose terminal sessions can be imported. Serialized as MonoCode's
/// harness id.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Hash, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    Claude,
}

impl Harness {
    const ALL: [Harness; 1] = [Harness::Claude];

    fn id(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Harness::Claude => "Claude Code",
        }
    }
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSessionQuery {
    /// Only these agents; every supported agent when absent.
    harnesses: Option<Vec<Harness>>,
    /// Only sessions started in this folder or its worktrees; every folder
    /// when absent.
    cwd: Option<String>,
    /// Case-insensitive match on the title, prompts and folder name.
    query: Option<String>,
    limit: Option<usize>,
    /// Also list conversations MonoCode already has.
    include_imported: bool,
    /// A newer listing from the same owner makes this one stop early.
    owner: Option<String>,
    /// Only sessions changed at or after this time (ms since the epoch).
    since: Option<u64>,
    /// Only sessions that import as a chat without a project: started in the
    /// home folder, or in one that no longer exists. Ignored with `cwd`.
    projectless: bool,
}

/// Whether a session's folder can hold a MonoCode chat.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum SessionFolder {
    Ok,
    /// Started in the home folder, which is not a project.
    Home,
    /// The folder was moved or deleted.
    Missing,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    harness: Harness,
    id: String,
    cwd: String,
    /// The agent's generated or user-set title, when the transcript has one.
    title: Option<String>,
    first_prompt: String,
    last_prompt: String,
    git_branch: Option<String>,
    updated_at: u64,
    size_bytes: u64,
    folder: SessionFolder,
    /// The main checkout when `cwd` is one of its linked git worktrees.
    project: Option<String>,
    /// The MonoCode session already bound to this conversation.
    monocode_session_id: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionListing {
    sessions: Vec<AgentSessionSummary>,
    /// Conversations left out because MonoCode already has them.
    imported_count: usize,
    /// Older sessions exist past `limit`.
    has_more: bool,
}

/// MonoCode sessions holding each agent's conversations, keyed by the
/// agent's own session id.
type Known = HashMap<Harness, HashMap<String, KnownSession>>;

/// Where one agent keeps its transcripts.
struct Source {
    harness: Harness,
    root: PathBuf,
}

fn sources(only: Option<&[Harness]>) -> Vec<Source> {
    let mut seen = HashSet::new();
    Harness::ALL
        .into_iter()
        .filter(|harness| only.is_none_or(|only| only.contains(harness)))
        .filter_map(|harness| {
            let root = match harness {
                Harness::Claude => claude::root(),
            }?;
            // Two agents pointed at one folder would list every file twice.
            seen.insert(root.clone())
                .then_some(Source { harness, root })
        })
        .collect()
}

#[tauri::command(async)]
pub fn agent_list_sessions(
    store: State<'_, SessionStore>,
    request: AgentSessionQuery,
) -> Result<AgentSessionListing, String> {
    let sources = sources(request.harnesses.as_deref());
    let mut known = Known::new();
    for source in &sources {
        known.insert(
            source.harness,
            store.known_provider_sessions(source.harness.id())?,
        );
    }
    let generation = request.owner.as_deref().map(begin_listing);
    let is_current = || {
        generation
            .as_ref()
            .is_none_or(|(owner, generation)| listing_is_current(owner, *generation))
    };
    Ok(list_sessions(
        &sources,
        &request,
        &known,
        dirs_home().as_deref(),
        &is_current,
    ))
}

#[tauri::command(async)]
pub fn agent_read_session(
    harness: Harness,
    cwd: String,
    session_id: String,
) -> Result<Vec<Value>, String> {
    validate_session_id(&session_id)?;
    let missing = || format!("That {} session no longer exists", harness.label());
    let source = sources(Some(&[harness]))
        .into_iter()
        .next()
        .ok_or_else(|| format!("{}'s session folder was not found", harness.label()))?;
    let path = match harness {
        Harness::Claude => claude::find(&source.root, &cwd, &session_id),
    }
    .ok_or_else(missing)?;
    let size = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_SESSION_FILE_BYTES {
        return Err(format!(
            "This {} session is too large to import",
            harness.label()
        ));
    }
    Ok(match harness {
        Harness::Claude => read_records(&path, claude::slim_record)?,
    })
}

/// Latest listing per owner. The picker lists again on every search pause;
/// an older listing still reading transcripts gives way to the newer one.
static LISTING_GENERATIONS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn begin_listing(owner: &str) -> (String, u64) {
    let mut generations = LISTING_GENERATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let generation = generations.get(owner).copied().unwrap_or(0) + 1;
    generations.insert(owner.to_string(), generation);
    (owner.to_string(), generation)
}

fn listing_is_current(owner: &str, generation: u64) -> bool {
    LISTING_GENERATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(owner)
        .is_none_or(|latest| *latest == generation)
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        Ok(())
    } else {
        Err("Invalid session id".into())
    }
}

fn same_cwd(left: &str, right: &str) -> bool {
    left.trim_end_matches(['/', '\\']) == right.trim_end_matches(['/', '\\'])
}

/// Directories directly inside `dir`.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

struct Candidate {
    harness: Harness,
    path: PathBuf,
    id: String,
    updated_at: u64,
    size_bytes: u64,
}

impl Candidate {
    fn new(harness: Harness, path: PathBuf, id: &str) -> Option<Self> {
        validate_session_id(id).ok()?;
        let metadata = std::fs::metadata(&path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let updated_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        Some(Self {
            harness,
            path,
            id: id.to_string(),
            updated_at,
            size_bytes: metadata.len(),
        })
    }
}

/// Every agent's transcripts, newest first. With `cwd`, an agent may narrow
/// its search to that folder's directories; callers still check each
/// session's own `cwd`.
fn candidates(sources: &[Source], cwd: Option<&str>) -> Vec<Candidate> {
    let mut found: Vec<Candidate> = sources
        .iter()
        .flat_map(|source| match source.harness {
            Harness::Claude => claude::candidates(&source.root, cwd),
        })
        .collect();
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    found
}

/// What a transcript says about itself. Parsing it is the slow part of a
/// listing, so it is kept until the file changes.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TranscriptInfo {
    cwd: String,
    title: Option<String>,
    first_prompt: String,
    last_prompt: String,
    git_branch: Option<String>,
}

fn transcript_info(candidate: &Candidate) -> Option<TranscriptInfo> {
    match candidate.harness {
        Harness::Claude => claude::transcript_info(candidate),
    }
}

struct CachedInfo {
    updated_at: u64,
    size_bytes: u64,
    /// `None` for a transcript with nothing to continue.
    info: Option<TranscriptInfo>,
}

static TRANSCRIPT_CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedInfo>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached_transcript_info(candidate: &Candidate) -> Option<TranscriptInfo> {
    let cached = TRANSCRIPT_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&candidate.path)
        .filter(|cached| {
            cached.updated_at == candidate.updated_at && cached.size_bytes == candidate.size_bytes
        })
        .map(|cached| cached.info.clone());
    if let Some(info) = cached {
        return info;
    }
    let info = transcript_info(candidate);
    TRANSCRIPT_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            candidate.path.clone(),
            CachedInfo {
                updated_at: candidate.updated_at,
                size_bytes: candidate.size_bytes,
                info: info.clone(),
            },
        );
    info
}

/// Drop entries for transcripts under `roots` that no longer exist. Only a
/// listing of every folder has seen them all.
fn prune_transcript_cache(roots: &[&Path], seen: &HashSet<&Path>) {
    TRANSCRIPT_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|path, _| {
            seen.contains(path.as_path()) || !roots.iter().any(|root| path.starts_with(root))
        });
}

/// Whether a session belongs in a listing scoped to `scope`: it ran there,
/// or in one of that checkout's worktrees.
fn in_scope(summary: &AgentSessionSummary, scope: &str) -> bool {
    same_cwd(&summary.cwd, scope)
        || summary
            .project
            .as_deref()
            .is_some_and(|project| same_cwd(project, scope))
}

/// Newest sessions first. Conversations MonoCode already has are skipped
/// before their transcript is opened, and counted instead.
fn list_sessions(
    sources: &[Source],
    request: &AgentSessionQuery,
    known: &Known,
    home: Option<&str>,
    is_current: &dyn Fn() -> bool,
) -> AgentSessionListing {
    let limit = request
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let cwd = request
        .cwd
        .as_deref()
        .map(|cwd| cwd.trim_end_matches(['/', '\\']))
        .filter(|cwd| !cwd.is_empty());
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_lowercase);
    let projectless = request.projectless && cwd.is_none();
    let candidates = candidates(sources, cwd);
    let bound_to = |candidate: &Candidate| {
        known
            .get(&candidate.harness)
            .and_then(|sessions| sessions.get(&candidate.id))
    };
    let mut listing = AgentSessionListing::default();
    let mut summarized = 0;
    // Past the limit, only known sessions are still counted: that needs no
    // transcript reads, and the count covers every session, not one page.
    let mut full = false;
    for candidate in &candidates {
        // Newest first: everything past here is older than the filter.
        if request
            .since
            .is_some_and(|since| candidate.updated_at < since)
        {
            break;
        }
        let bound = bound_to(candidate);
        if let Some(bound) = bound {
            if !request.include_imported {
                let in_scope = match cwd {
                    Some(cwd) => bound.belongs_to(cwd),
                    None => !projectless || bound.is_projectless(),
                };
                if in_scope {
                    listing.imported_count += 1;
                }
                continue;
            }
        }
        if full {
            continue;
        }
        if summarized == MAX_SUMMARIZED || !is_current() {
            full = true;
            continue;
        }
        summarized += 1;
        let Some(info) = cached_transcript_info(candidate) else {
            continue;
        };
        let summary = summary_from(candidate, info, bound.map(|bound| bound.id.clone()), home);
        if cwd.is_some_and(|cwd| !in_scope(&summary, cwd)) {
            continue;
        }
        if projectless && summary.folder == SessionFolder::Ok {
            continue;
        }
        if query
            .as_deref()
            .is_some_and(|query| !matches_query(&summary, query))
        {
            continue;
        }
        if listing.sessions.len() == limit {
            listing.has_more = true;
            full = true;
            continue;
        }
        listing.sessions.push(summary);
    }
    if cwd.is_none() && is_current() {
        let roots: Vec<&Path> = sources.iter().map(|source| source.root.as_path()).collect();
        prune_transcript_cache(
            &roots,
            &candidates.iter().map(|c| c.path.as_path()).collect(),
        );
    }
    listing
}

fn matches_query(summary: &AgentSessionSummary, query: &str) -> bool {
    let folder = summary
        .cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    [
        summary.title.as_deref().unwrap_or(""),
        &summary.first_prompt,
        &summary.last_prompt,
        folder,
    ]
    .iter()
    .any(|text| text.to_lowercase().contains(query))
}

fn folder_state(cwd: &str, home: Option<&str>) -> SessionFolder {
    if home.is_some_and(|home| same_cwd(home, cwd)) {
        SessionFolder::Home
    } else if Path::new(cwd).is_dir() {
        SessionFolder::Ok
    } else {
        SessionFolder::Missing
    }
}

/// The main checkout of a linked git worktree at `cwd`. A worktree's `.git`
/// is a file naming its admin directory, whose `commondir` leads back to the
/// main repository's `.git`. Submodules have no `commondir` and bare
/// repositories no checkout, so both give `None`.
fn main_checkout(cwd: &str) -> Option<String> {
    let cwd = Path::new(cwd);
    let pointer = std::fs::read_to_string(cwd.join(".git")).ok()?;
    let admin = cwd.join(pointer.strip_prefix("gitdir:")?.trim());
    let common = std::fs::read_to_string(admin.join("commondir")).ok()?;
    let common = admin.join(common.trim()).canonicalize().ok()?;
    if common.file_name()? != ".git" {
        return None;
    }
    let main = common.parent()?;
    main.is_dir().then(|| main.to_string_lossy().into_owned())
}

fn summary_from(
    candidate: &Candidate,
    info: TranscriptInfo,
    monocode_session_id: Option<String>,
    home: Option<&str>,
) -> AgentSessionSummary {
    let folder = folder_state(&info.cwd, home);
    let project = match folder {
        SessionFolder::Ok => main_checkout(&info.cwd),
        _ => None,
    };
    AgentSessionSummary {
        harness: candidate.harness,
        id: candidate.id.clone(),
        folder,
        project,
        cwd: info.cwd,
        title: info.title,
        first_prompt: info.first_prompt,
        last_prompt: info.last_prompt,
        git_branch: info.git_branch,
        updated_at: candidate.updated_at,
        size_bytes: candidate.size_bytes,
        monocode_session_id,
    }
}

/// An agent's line-by-line reading of a transcript for its summary.
trait SummaryScan: Default {
    fn visit(&mut self, line: &str, in_tail: bool);
    /// The last prompt seen came from the tail rather than the head.
    fn tail_prompt(&self) -> bool;
}

/// Scan a transcript's ends. A long run of tool output can push the last
/// prompt out of the tail, so the tail widens until it holds one.
fn scan_ends<S: SummaryScan>(candidate: &Candidate) -> Option<S> {
    let mut tail_bytes = SUMMARY_TAIL_BYTES;
    loop {
        let mut scan = S::default();
        visit_summary_lines(
            &candidate.path,
            candidate.size_bytes,
            tail_bytes,
            |line, in_tail| scan.visit(line, in_tail),
        )
        .ok()?;
        if scan.tail_prompt()
            || tail_bytes >= MAX_SUMMARY_TAIL_BYTES
            || candidate.size_bytes <= SUMMARY_HEAD_BYTES + tail_bytes
        {
            return Some(scan);
        }
        tail_bytes *= 4;
    }
}

/// Feeds `visit` the first `SUMMARY_HEAD_BYTES` and the last `tail_bytes` of
/// a transcript, line by line, flagging tail lines. Small transcripts are read
/// whole and count as tail.
fn visit_summary_lines(
    path: &Path,
    size: u64,
    tail_bytes: u64,
    mut visit: impl FnMut(&str, bool),
) -> std::io::Result<()> {
    let mut reader = BufReader::new(std::fs::File::open(path)?);
    let mut line = Vec::new();
    let whole = size <= SUMMARY_HEAD_BYTES + tail_bytes;
    let mut offset = 0u64;
    while whole || offset < SUMMARY_HEAD_BYTES {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(());
        }
        offset += read as u64;
        visit(&String::from_utf8_lossy(&line), whole);
    }
    let tail_start = size - tail_bytes;
    if tail_start > offset {
        reader.seek(SeekFrom::Start(tail_start))?;
        // The seek lands mid-line; that fragment is not a record.
        line.clear();
        reader.read_until(b'\n', &mut line)?;
    }
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(());
        }
        visit(&String::from_utf8_lossy(&line), true);
    }
}

/// An agent's filter for one transcript record: `None` drops it.
type SlimRecord = fn(serde_json::Map<String, Value>) -> Option<serde_json::Map<String, Value>>;

/// Every JSON object line of a transcript, through `slim`.
fn read_records(path: &Path, slim: SlimRecord) -> Result<Vec<Value>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut records = Vec::new();
    loop {
        bytes.clear();
        if reader
            .read_until(b'\n', &mut bytes)
            .map_err(|error| error.to_string())?
            == 0
        {
            break;
        }
        // A session being written right now can end in a partial line, cut
        // anywhere, even inside a multi-byte character; it fails to parse.
        let line = String::from_utf8_lossy(&bytes);
        if line.trim().is_empty() {
            continue;
        }
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(record) = slim(record) {
            records.push(Value::Object(record));
        }
    }
    Ok(records)
}

/// One line of prompt text for a list row.
fn prompt_preview(prompt: &str) -> String {
    let collapsed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, MAX_PROMPT_PREVIEW_CHARS)
}

fn non_empty_str(record: &Value, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((index, _)) => format!("{}…", &value[..index]),
        None => value.to_string(),
    }
}

/// Cap every string inside `value`, keeping its shape so paths and short
/// fields still read the same.
fn truncate_strings(value: &mut Value, max: usize) {
    match value {
        Value::String(text) => {
            if text.len() > max {
                *text = truncate_chars(text, max);
            }
        }
        Value::Array(items) => {
            for item in items {
                truncate_strings(item, max);
            }
        }
        Value::Object(fields) => {
            for field in fields.values_mut() {
                truncate_strings(field, max);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod test_support {
    use super::*;

    pub(super) fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "monocode-agent-sessions-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    pub(super) fn set_mtime(path: &Path, seconds: u64) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(seconds))
            .unwrap();
    }

    /// Known sessions for one agent.
    pub(super) fn known_for(
        harness: Harness,
        sessions: impl IntoIterator<Item = (&'static str, KnownSession)>,
    ) -> Known {
        HashMap::from([(
            harness,
            sessions
                .into_iter()
                .map(|(id, session)| (id.to_string(), session))
                .collect(),
        )])
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn rejects_path_like_session_ids() {
        assert!(validate_session_id("../etc").is_err());
        assert!(validate_session_id("d35a3d8b-d7b9-4b7a-b919-01cd52ccd01a").is_ok());
    }

    #[test]
    fn home_and_missing_folders_are_flagged() {
        let root = temp_root("folders");
        let home = root.to_str().unwrap();
        assert_eq!(
            folder_state(&format!("{home}/"), Some(home)),
            SessionFolder::Home
        );
        assert_eq!(folder_state(home, None), SessionFolder::Ok);
        assert_eq!(
            folder_state(&format!("{home}/gone"), Some(home)),
            SessionFolder::Missing
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn previews_collapse_whitespace() {
        assert_eq!(prompt_preview("  fix\n\n the   build "), "fix the build");
    }

    #[test]
    fn a_superseded_listing_stops_reading() {
        let (owner, first) = begin_listing("test-owner");
        assert!(listing_is_current(&owner, first));
        let (_, second) = begin_listing("test-owner");
        assert!(!listing_is_current(&owner, first));
        assert!(listing_is_current(&owner, second));
    }

    #[test]
    fn harnesses_serialize_as_monocode_ids() {
        assert_eq!(serde_json::to_value(Harness::Claude).unwrap(), "claude");
        assert_eq!(
            serde_json::from_value::<Harness>(Value::from("claude")).unwrap(),
            Harness::Claude
        );
    }
}
