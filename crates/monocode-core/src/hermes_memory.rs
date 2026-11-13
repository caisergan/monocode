//! What Hermes remembers between chats, as its memory tool keeps it
//! (hermes-agent tools/memory_tool_store.py): `memories/MEMORY.md`, its own
//! notes, and `memories/USER.md`, its picture of the user. Each is a list of
//! entries parted by a line holding only `§`, with a character budget from
//! config.yaml. Hermes writes them under a lock on `<file>.lock` and by
//! replacing the file whole; so does this.
use std::path::{Path, PathBuf};

const DELIMITER: &str = "\n§\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// `USER.md`: who the user is and how they like to be answered.
    User,
    /// `MEMORY.md`: what Hermes noted about the machine and its work.
    Notes,
}
impl Kind {
    pub const ALL: [Kind; 2] = [Kind::User, Kind::Notes];
    pub fn file(self) -> &'static str {
        match self {
            Kind::User => "USER.md",
            Kind::Notes => "MEMORY.md",
        }
    }
    pub fn title(self) -> &'static str {
        match self {
            Kind::User => "About you",
            Kind::Notes => "Notes",
        }
    }
    pub fn description(self) -> &'static str {
        match self {
            Kind::User => "Who you are and how you like to be answered.",
            Kind::Notes => "What Hermes noted about this machine and its work.",
        }
    }
    /// config.yaml's key for the budget, and Hermes's default.
    fn limit(self) -> (&'static str, usize) {
        match self {
            Kind::User => ("user_char_limit", 1375),
            Kind::Notes => ("memory_char_limit", 2200),
        }
    }
}

/// One memory file as it stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Store {
    pub kind: Kind,
    pub path: PathBuf,
    pub entries: Vec<String>,
    /// Characters the entries take, counted as Hermes counts them.
    pub used: usize,
    /// The most Hermes lets them take.
    pub limit: usize,
}

/// `HERMES_HOME`, or `.hermes` in the user's home.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HERMES_HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::accounts::home().map(|home| home.join(".hermes")))
}

/// Both stores, the user's first. `None` when Hermes keeps no memory here.
pub fn load(home: &Path) -> Option<Vec<Store>> {
    let folder = home.join("memories");
    if !folder.is_dir() {
        return None;
    }
    let config = std::fs::read_to_string(home.join("config.yaml")).unwrap_or_default();
    Some(
        Kind::ALL
            .into_iter()
            .map(|kind| {
                let path = folder.join(kind.file());
                let entries = parse(&std::fs::read_to_string(&path).unwrap_or_default());
                let (key, default) = kind.limit();
                Store {
                    kind,
                    used: joined(&entries).chars().count(),
                    limit: configured(&config, key).unwrap_or(default),
                    entries,
                    path,
                }
            })
            .collect(),
    )
}

/// Forget one entry. The file is read again under Hermes's lock, so a note
/// Hermes wrote in the meantime stays; an entry no longer there is an error,
/// not a guess at which one was meant.
pub fn remove(home: &Path, kind: Kind, entry: &str) -> Result<(), String> {
    mutate(home, kind, |entries| {
        let at = entries
            .iter()
            .position(|kept| kept == entry.trim())
            .ok_or("Hermes has changed this memory since it was read. Refresh and try again.")?;
        entries.remove(at);
        Ok(())
    })
}

fn mutate(
    home: &Path,
    kind: Kind,
    change: impl FnOnce(&mut Vec<String>) -> Result<(), &'static str>,
) -> Result<(), String> {
    let path = home.join("memories").join(kind.file());
    let _lock = Lock::take(&path)?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", kind.file()))?;
    let mut entries = parse(&raw);
    change(&mut entries)?;
    let beside = path.with_file_name(format!(".mem_{}.monocode", kind.file()));
    // On disk before it takes the file's place, as Hermes's own writes are:
    // a power cut must not leave the memory empty.
    let written = std::fs::File::create(&beside)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(joined(&entries).as_bytes())?;
            file.sync_all()
        })
        .and_then(|()| {
            if let Ok(meta) = std::fs::metadata(&path) {
                let _ = std::fs::set_permissions(&beside, meta.permissions());
            }
            std::fs::rename(&beside, &path)
        })
        .map_err(|error| format!("Could not write {}: {error}", kind.file()));
    if written.is_err() {
        let _ = std::fs::remove_file(&beside);
    }
    written
}

fn parse(raw: &str) -> Vec<String> {
    raw.split(DELIMITER)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}
fn joined(entries: &[String]) -> String {
    entries.join(DELIMITER)
}

/// `<key>: <number>` under the top-level `memory:` of config.yaml.
fn configured(config: &str, key: &str) -> Option<usize> {
    let mut in_memory = false;
    for line in config.lines() {
        let text = line.trim();
        if text.is_empty() || text.starts_with('#') {
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            in_memory = text == "memory:";
        } else if in_memory {
            if let Some(value) = text
                .strip_prefix(key)
                .and_then(|rest| rest.strip_prefix(':'))
            {
                return value.split('#').next()?.trim().parse().ok();
            }
        }
    }
    None
}

/// Hermes's exclusive lock on `<file>.lock`, held until dropped. Asked for
/// without waiting: Hermes holds it only for a write, and the UI must not hang
/// on one that went wrong.
struct Lock(std::fs::File);
impl Lock {
    fn take(path: &Path) -> Result<Self, String> {
        let mut name = path.as_os_str().to_owned();
        name.push(".lock");
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(PathBuf::from(name))
            .map_err(|error| format!("Could not open the memory lock: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let locked = (0..20).any(|attempt| {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                // SAFETY: the descriptor is open for as long as `file` lives.
                unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
            });
            if !locked {
                return Err(
                    "Hermes is writing its memory right now. Try again in a moment.".into(),
                );
            }
        }
        Ok(Self(file))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: as in `take`; closing the file would release it too.
            unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hermes(notes: &str, user: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("memories")).unwrap();
        std::fs::write(home.path().join("memories/MEMORY.md"), notes).unwrap();
        std::fs::write(home.path().join("memories/USER.md"), user).unwrap();
        std::fs::write(
            home.path().join("config.yaml"),
            "model:\n  user_char_limit: 1\nmemory:\n  memory_enabled: true\n  user_char_limit: 900  # mine\n",
        )
        .unwrap();
        home
    }

    #[test]
    fn the_stores_read_as_hermes_writes_them() {
        let home = hermes(
            "Mac: M5, 16GB\n§\n\n  Ornith runs locally  \n§\n",
            "Türkçe, kısa yanıt",
        );
        let stores = load(home.path()).unwrap();
        assert_eq!(stores[0].kind, Kind::User);
        assert_eq!(stores[0].entries, ["Türkçe, kısa yanıt"]);
        // Characters, not bytes; its own budget, and Hermes's default for the other.
        assert_eq!((stores[0].used, stores[0].limit), (18, 900));
        assert_eq!(stores[1].entries, ["Mac: M5, 16GB", "Ornith runs locally"]);
        assert_eq!((stores[1].used, stores[1].limit), (13 + 3 + 19, 2200));
        assert!(load(&home.path().join("nowhere")).is_none());
    }

    #[test]
    fn an_entry_is_forgotten_under_the_lock_and_nothing_else_is() {
        let home = hermes("one\n§\ntwo\n§\nthree", "");
        // Hermes added a note after the list was read.
        std::fs::write(
            home.path().join("memories/MEMORY.md"),
            "one\n§\ntwo\n§\nthree\n§\nfour",
        )
        .unwrap();
        remove(home.path(), Kind::Notes, "two").unwrap();
        let kept = std::fs::read_to_string(home.path().join("memories/MEMORY.md")).unwrap();
        assert_eq!(kept, "one\n§\nthree\n§\nfour");
        assert!(remove(home.path(), Kind::Notes, "two")
            .unwrap_err()
            .contains("changed this memory"));
        assert!(home.path().join("memories/MEMORY.md.lock").is_file());
        let left: Vec<_> = std::fs::read_dir(home.path().join("memories"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("monocode"))
            .collect();
        assert!(left.is_empty(), "{left:?}");

        // While Hermes holds the lock, the write waits its turn and then gives up.
        #[cfg(unix)]
        {
            let held = Lock::take(&home.path().join("memories/MEMORY.md")).unwrap();
            assert!(remove(home.path(), Kind::Notes, "one")
                .unwrap_err()
                .contains("writing its memory"));
            drop(held);
            remove(home.path(), Kind::Notes, "one").unwrap();
        }
    }
}
