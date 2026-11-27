//! Lid-closed mode: `pmset -a disablesleep 1` keeps the Mac running with its
//! lid shut, the way Amphetamine's Power Protect does. Power assertions can't
//! do this: macOS sleeps on lid close whatever they hold.
//!
//! pmset needs root, so a one-time sudoers rule, approved with an admin
//! password, lets this user run exactly the two commands without one. Unlike
//! an assertion the setting outlives the process, so a marker file records
//! that MonoCode turned it on; the next launch undoes what a crash left.
//! When something else (Amphetamine, a script) already disabled sleep,
//! MonoCode leaves it to that owner and never turns it back on.
//!
//! Tests and other platforms use a stand-in that never touches the machine.

/// What the last attempt to engage lid mode found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Status {
    /// Not checked yet.
    #[default]
    Unknown,
    /// sudo needs a password for pmset: the rule isn't installed.
    NeedsSetup,
    Ready,
    Failed(String),
}

/// Engaged: whether MonoCode itself turned sleep off (and so owns turning it
/// back on), or it was already off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Engaged {
    Owned,
    Borrowed,
}

pub(crate) use backend::{engage, install, ready, recover, release};

#[cfg(all(target_os = "macos", not(test)))]
mod backend {
    use super::Engaged;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    const SUDO: &str = "/usr/bin/sudo";
    const PMSET: &str = "/usr/bin/pmset";
    const RULE: &str = "/etc/sudoers.d/monocode_lid";

    fn marker() -> PathBuf {
        crate::data_dir().join("keep-awake-lid")
    }

    fn pmset_args(on: bool) -> [&'static str; 3] {
        ["-a", "disablesleep", if on { "1" } else { "0" }]
    }

    /// sudo lets this user run pmset's disablesleep without a password.
    pub(crate) fn ready() -> bool {
        Command::new(SUDO)
            .args(["-n", "-l", PMSET])
            .args(pmset_args(true))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    fn sleep_disabled() -> Option<bool> {
        let out = Command::new(PMSET).arg("-g").output().ok()?;
        super::parse_sleep_disabled(&String::from_utf8_lossy(&out.stdout))
    }

    fn set(on: bool) -> Result<(), String> {
        let out = Command::new(SUDO)
            .arg("-n")
            .arg(PMSET)
            .args(pmset_args(on))
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        Err(if text.is_empty() {
            format!("pmset exited with {}", out.status)
        } else {
            text
        })
    }

    pub(crate) fn engage() -> Result<Engaged, String> {
        if sleep_disabled() == Some(true) && !marker().exists() {
            return Ok(Engaged::Borrowed);
        }
        // Write the marker first: a crash between the two still gets undone.
        let marker = marker();
        if let Some(dir) = marker.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&marker, std::process::id().to_string());
        set(true).inspect_err(|_| {
            let _ = std::fs::remove_file(&marker);
        })?;
        Ok(Engaged::Owned)
    }

    pub(crate) fn release() -> Result<(), String> {
        set(false)?;
        let _ = std::fs::remove_file(marker());
        Ok(())
    }

    /// At launch: turn sleep back on if a previous run left it off.
    /// Another copy of the app that is still running keeps its own.
    pub(crate) fn recover() {
        let Ok(owner) = std::fs::read_to_string(marker()) else {
            return;
        };
        let alive = owner.trim().parse::<i32>().is_ok_and(|pid| {
            pid as u32 != std::process::id()
                // SAFETY: signal 0 only checks that the process exists.
                && unsafe { libc::kill(pid, 0) } == 0
        });
        if !alive {
            let _ = release();
        }
    }

    /// Install the sudoers rule. macOS asks for an admin password; the rule
    /// is checked with visudo before it goes in, so a bad file can't lock
    /// sudo out.
    pub(crate) fn install() -> Result<(), String> {
        let user = std::env::var("USER").map_err(|_| "Unknown user".to_owned())?;
        if user.is_empty()
            || !user
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        {
            return Err(format!("Can't write a sudo rule for user {user:?}"));
        }
        let rule = format!(
            "# MonoCode keep awake: run with the lid closed.\n\
             Cmnd_Alias MONOCODE_LID = {PMSET} -a disablesleep 1, {PMSET} -a disablesleep 0\n\
             {user} ALL=(root) NOPASSWD: MONOCODE_LID\n"
        );
        let draft = std::env::temp_dir().join(format!("monocode-lid-{}", std::process::id()));
        std::fs::write(&draft, rule).map_err(|e| e.to_string())?;
        let shell = format!(
            "/usr/sbin/visudo -cf {draft} && /usr/bin/install -m 0440 -o root -g wheel {draft} {RULE}",
            draft = shell_quote(&draft.to_string_lossy()),
        );
        let script = format!(
            "do shell script \"{}\" with prompt \"MonoCode wants to keep your Mac running with the lid closed.\" with administrator privileges",
            shell.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let out = Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&draft);
        let out = out?;
        if out.status.success() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&out.stderr);
        // -128: the password sheet was cancelled.
        Err(if text.contains("-128") {
            "Cancelled".into()
        } else {
            text.trim().to_owned()
        })
    }

    fn shell_quote(text: &str) -> String {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

#[cfg(not(all(target_os = "macos", not(test))))]
mod backend {
    use super::Engaged;

    pub(crate) fn ready() -> bool {
        true
    }
    pub(crate) fn engage() -> Result<Engaged, String> {
        Ok(Engaged::Owned)
    }
    pub(crate) fn release() -> Result<(), String> {
        Ok(())
    }
    pub(crate) fn recover() {}
    pub(crate) fn install() -> Result<(), String> {
        Ok(())
    }
}

/// `pmset -g`'s `SleepDisabled` line.
#[cfg_attr(not(all(target_os = "macos", not(test))), allow(dead_code))]
pub(crate) fn parse_sleep_disabled(text: &str) -> Option<bool> {
    text.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        (words.next()? == "SleepDisabled").then(|| words.next() == Some("1"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sleep_disabled_from_pmset() {
        let text =
            "System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 1\n";
        assert_eq!(parse_sleep_disabled(text), Some(true));
        assert_eq!(parse_sleep_disabled(" SleepDisabled\t\t0\n"), Some(false));
        assert_eq!(parse_sleep_disabled(" sleep 1\n"), None);
    }
}
