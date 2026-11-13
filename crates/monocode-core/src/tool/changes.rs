//! What a turn's edit calls changed, read from the calls themselves: the
//! files, how many lines went in and out, and one edit taken back. For the
//! calls whose provider records the change (Hermes: `display.detail` is
//! `diff`, the output its diff). Unlike the Git-backed checkpoint this needs
//! no repository, and sees only what an edit tool did: a file a shell command
//! rewrote is not here.
use super::{ToolCall, ToolState};
use crate::transcript::Row;
use serde_json::Value;
use std::path::Path;

/// One file a turn edited, with the lines its edits added and removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
}

/// The files the turn's finished edits changed, in the order first touched.
pub fn turn_changes(rows: &[Row]) -> Vec<FileChange> {
    let mut files: Vec<FileChange> = Vec::new();
    for call in rows
        .iter()
        .filter(|row| row.role == "tool" && row.text.contains(r#""detail":"diff""#))
        .filter_map(|row| serde_json::from_str::<ToolCall>(&row.text).ok())
        .filter(recorded_edit)
    {
        let input: Value = serde_json::from_str(&call.input).unwrap_or_default();
        let Some(path) = input["file_path"].as_str().filter(|path| !path.is_empty()) else {
            continue;
        };
        // The row shows a long diff cut short; its counts are of the whole.
        let counted = call.display.as_ref().and_then(|display| {
            Some((
                display["additions"].as_u64()? as usize,
                display["deletions"].as_u64()? as usize,
            ))
        });
        let (additions, deletions) = counted.unwrap_or_else(|| diff_counts(&call.output));
        match files.iter_mut().find(|file| file.path == path) {
            Some(file) => {
                file.additions += additions;
                file.deletions += deletions;
            }
            None => files.push(FileChange {
                path: path.to_owned(),
                additions,
                deletions,
            }),
        }
    }
    files
}

fn recorded_edit(call: &ToolCall) -> bool {
    call.state == ToolState::Completed
        && matches!(call.name.as_str(), "Edit" | "Write")
        && call
            .display
            .as_ref()
            .is_some_and(|display| display["detail"] == "diff")
}

/// Added and removed lines of a diff, its file headers aside. A header is a
/// `--- ` line with a `+++ ` line right after it; a changed line that only
/// begins that way (`--count;`, a Markdown rule) is counted like any other.
pub fn diff_counts(diff: &str) -> (usize, usize) {
    let lines: Vec<&str> = diff.lines().collect();
    let (mut added, mut removed, mut at) = (0, 0, 0);
    while at < lines.len() {
        let line = lines[at];
        if line.starts_with("--- ")
            && lines
                .get(at + 1)
                .is_some_and(|next| next.starts_with("+++ "))
        {
            at += 2;
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
        at += 1;
    }
    (added, removed)
}

/// What each hunk of a unified diff left in the file: its context and added
/// lines, in order. None for a diff with no context to tell a place by.
fn hunks_after(diff: &str) -> Option<Vec<String>> {
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    let mut context = false;
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunks.push(Vec::new());
        } else if let Some(hunk) = hunks.last_mut() {
            if let Some(kept) = line.strip_prefix(' ') {
                context = true;
                hunk.push(kept);
            } else if let Some(new) = line.strip_prefix('+') {
                hunk.push(new);
            } else if !line.starts_with('-') && !line.starts_with('\\') {
                // The row's cut ("… N more lines"): what follows is not shown.
                break;
            }
        }
    }
    (context && !hunks.is_empty()).then(|| hunks.iter().map(|hunk| hunk.join("\n")).collect())
}

/// Whether an edit call is one `revert` can take back: a finished
/// replacement with both its texts on record. A whole-file write is not, for
/// what the file held before is nowhere; nor is a replace-all, whose new text
/// may have been in the file already.
pub fn revertible(call: &ToolCall) -> bool {
    if !recorded_edit(call) || call.name != "Edit" {
        return false;
    }
    let input: Value = serde_json::from_str(&call.input).unwrap_or_default();
    let text = |key: &str| input[key].as_str().is_some_and(|text| !text.is_empty());
    text("file_path") && text("old_string") && text("new_string") && input["replace_all"] != true
}

/// Take one edit back: put the old text where the new one is. Only while the
/// file still has that new text exactly once, so nothing written since is
/// guessed at or lost. The file's path on success.
pub fn revert(call: &ToolCall, cwd: &Path) -> Result<String, String> {
    if !revertible(call) {
        return Err("This edit cannot be undone on its own.".into());
    }
    // A remote project's files are not on this disk; a file of the same
    // name here is another file.
    if cwd.to_string_lossy().contains("://") {
        return Err("Edits in a remote project cannot be undone from here.".into());
    }
    let input: Value = serde_json::from_str(&call.input).unwrap_or_default();
    let text = |key: &str| input[key].as_str().unwrap_or("");
    let (old, new) = (text("old_string"), text("new_string"));
    let path = crate::scm::expand_home(Path::new(text("file_path")));
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    let shown = path.to_string_lossy().into_owned();
    // Write through a link to the file it names, as the edit did: moving a
    // file over the link would leave the real one edited.
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {shown}: {error}"))?;
    // A file with Windows line endings holds the edit with them.
    let (old, new) = if contents.contains("\r\n") && !new.contains("\r\n") {
        (old.replace('\n', "\r\n"), new.replace('\n', "\r\n"))
    } else {
        (old.to_owned(), new.to_owned())
    };
    match contents.matches(new.as_str()).count() {
        1 => {}
        0 => return Err("The file no longer has this change; it was edited since.".into()),
        _ => return Err("The changed text is in the file more than once; undo it by hand.".into()),
    }
    // The same text once in the file is not yet this edit: another edit may
    // have taken this one back and a third written the same words elsewhere.
    // The lines the edit left around it say where it was.
    if let Some(hunks) = hunks_after(&call.output) {
        let plain = contents.replace("\r\n", "\n");
        if !hunks.iter().all(|hunk| plain.contains(hunk.as_str())) {
            return Err("The file changed around this edit since; undo it by hand.".into());
        }
    }
    let restored = contents.replacen(new.as_str(), &old, 1);
    // Beside the file, then moved over it: a crash leaves one or the other.
    let beside = path.with_extension(format!(
        "{}.monocode-undo",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    let written = std::fs::write(&beside, restored)
        .and_then(|()| {
            if let Ok(meta) = std::fs::metadata(&path) {
                let _ = std::fs::set_permissions(&beside, meta.permissions());
            }
            std::fs::rename(&beside, &path)
        })
        .map_err(|error| format!("Could not write {shown}: {error}"));
    if written.is_err() {
        let _ = std::fs::remove_file(&beside);
    }
    written.map(|()| shown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn edit(id: &str, name: &str, input: Value, output: &str) -> ToolCall {
        let mut call = ToolCall::new(id, name);
        call.input = input.to_string();
        call.output = output.into();
        call.state = ToolState::Completed;
        call.display = Some(json!({"detail":"diff"}));
        call
    }
    fn row(call: &ToolCall) -> Row {
        Row {
            role: "tool".into(),
            text: serde_json::to_string(call).unwrap(),
            first: true,
            sent_at: None,
        }
    }

    #[test]
    fn a_turn_changes_the_files_its_recorded_edits_name() {
        let patch = edit(
            "p",
            "Edit",
            json!({"file_path":"/repo/a.txt","old_string":"beta","new_string":"BETA"}),
            "--- a//repo/a.txt\n+++ b//repo/a.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma",
        );
        let write = edit(
            "w",
            "Write",
            json!({"file_path":"/repo/b.txt","content":"one\ntwo\n"}),
            "+one\n+two",
        );
        let again = edit(
            "p2",
            "Edit",
            json!({"file_path":"/repo/a.txt","old_string":"gamma","new_string":"gamma\ndelta"}),
            "@@ -3 +3,2 @@\n gamma\n+delta",
        );
        // A failed edit, one with no record, and a command change nothing here.
        let mut failed = patch.clone();
        failed.state = ToolState::Failed;
        let mut unrecorded = patch.clone();
        unrecorded.display = None;
        let mut bash = edit("b", "Bash", json!({"command":"sed -i s/a/b/ c.txt"}), "+x");
        bash.display = Some(json!({"detail":"text"}));
        let rows: Vec<_> = [&patch, &write, &failed, &unrecorded, &bash, &again]
            .map(row)
            .to_vec();
        let changed = turn_changes(&rows);
        assert_eq!(
            changed,
            [
                FileChange {
                    path: "/repo/a.txt".into(),
                    additions: 2,
                    deletions: 1
                },
                FileChange {
                    path: "/repo/b.txt".into(),
                    additions: 2,
                    deletions: 0
                },
            ]
        );
        assert!(turn_changes(&[]).is_empty());
        assert!(revertible(&patch) && revertible(&again));
        assert!(!revertible(&write) && !revertible(&failed) && !revertible(&unrecorded));
        let all = edit(
            "all",
            "Edit",
            json!({"file_path":"/repo/a.txt","old_string":"a","new_string":"b","replace_all":true}),
            "-a\n+b",
        );
        assert!(!revertible(&all));
    }

    #[test]
    fn an_edit_is_taken_back_only_while_the_file_still_has_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "alpha\nBETA\ngamma\n").unwrap();
        let call = edit(
            "p",
            "Edit",
            json!({"file_path":"a.txt","old_string":"beta","new_string":"BETA"}),
            "-beta\n+BETA",
        );
        // A path the provider gave relative to the session's folder.
        assert_eq!(revert(&call, dir.path()).unwrap(), path.to_string_lossy());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "alpha\nbeta\ngamma\n"
        );
        assert!(revert(&call, dir.path())
            .unwrap_err()
            .contains("no longer has this change"));

        std::fs::write(&path, "BETA\nBETA\n").unwrap();
        assert!(revert(&call, dir.path())
            .unwrap_err()
            .contains("more than once"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "BETA\nBETA\n");

        // The file's own line endings are kept.
        let lines = edit(
            "l",
            "Edit",
            json!({"file_path":path,"old_string":"one\ntwo","new_string":"1\n2"}),
            "",
        );
        std::fs::write(&path, "zero\r\n1\r\n2\r\n").unwrap();
        revert(&lines, Path::new("/")).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "zero\r\none\r\ntwo\r\n"
        );
        assert!(
            std::fs::read_dir(dir.path()).unwrap().count() == 1,
            "no stray file"
        );

        std::fs::remove_file(&path).unwrap();
        assert!(revert(&call, dir.path())
            .unwrap_err()
            .starts_with("Could not read"));
    }

    #[test]
    fn a_changed_line_that_looks_like_a_header_is_still_counted() {
        // Hermes's own diff has headers; a replacement shown without context has none.
        let unified = "--- a/f.rs\n+++ b/f.rs\n@@ -1,2 +1,2 @@\n-old\n+new\n same";
        assert_eq!(diff_counts(unified), (1, 1));
        assert_eq!(diff_counts("---count;\n-x\n+++i;\n+y"), (2, 2));
    }

    #[test]
    fn undo_reads_where_the_edit_was_and_not_only_its_words() {
        let dir = std::env::temp_dir().join(format!(
            "monocode-undo-place-{}-{}",
            std::process::id(),
            crate::time::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.rs");
        // The edit renamed `count` in `f`. Since then another edit took that
        // back and a third wrote the same word in `g`.
        std::fs::write(&file, "fn f() {\n    count\n}\nfn g() {\n    total\n}\n").unwrap();
        let call = edit(
            "e",
            "Edit",
            json!({"file_path": file, "old_string": "count", "new_string": "total"}),
            "--- a/f.rs\n+++ b/f.rs\n@@ -1,3 +1,3 @@\n fn f() {\n-    count\n+    total\n }",
        );
        let error = revert(&call, &dir).unwrap_err();
        assert!(error.contains("changed around this edit"), "{error}");
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .contains("fn g() {\n    total"));
        // Where the edit still stands it is taken back.
        std::fs::write(&file, "fn f() {\n    total\n}\n").unwrap();
        revert(&call, &dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "fn f() {\n    count\n}\n"
        );
        // A remote project's files are not on this disk.
        let remote = revert(&call, Path::new("remote://env/home/code")).unwrap_err();
        assert!(remote.contains("remote project"), "{remote}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
