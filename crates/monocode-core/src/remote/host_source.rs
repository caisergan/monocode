//! Builds MonoCode Host on this computer from the fork's dev branch. "Update
//! Host" installs that package, because the release packages are upstream's
//! and lack the fork's host changes.
use super::ssh::Job;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub const REPOSITORY: &str = "https://github.com/caisergan/monocode.git";
pub const BRANCH: &str = "dev";
/// `npm ci` reruns only when the lockfile differs from the one recorded here.
const LOCK_MARKER: &str = "node_modules/.monocode-host-lock";

pub struct HostPackage {
    pub file: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub version: String,
    /// Set when `bytes` leaves out Node: the machine's host has the same one.
    pub reuse_node: Option<String>,
}

fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    let start = text
        .char_indices()
        .rev()
        .nth(1999)
        .map_or(0, |(index, _)| index);
    text[start..].to_string()
}

fn run(job: Option<&Job>, mut command: Command, what: &str) -> Result<String, String> {
    crate::scm::shell::apply_gui_env(&mut command);
    // An app started from a git hook or terminal must not aim git elsewhere.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("{what} failed: could not start {e}"))?;
    let read = |mut reader: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut output = Vec::new();
            let _ = reader.read_to_end(&mut output);
            output
        })
    };
    let stdout = read(Box::new(child.stdout.take().unwrap()));
    let stderr = read(Box::new(child.stderr.take().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(20 * 60);
    let status = loop {
        let cancelled = job.is_some_and(|job| job.cancelled.load(Ordering::Relaxed));
        if cancelled || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if cancelled {
                "Connection cancelled".into()
            } else {
                format!("{what} timed out")
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(format!("{what} failed: {error}")),
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if !status.success() {
        let detail = tail(if stderr.is_empty() { &stdout } else { &stderr });
        return Err(format!("{what} failed: {detail}"));
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

fn git(dir: Option<&Path>) -> Command {
    let mut command = Command::new("git");
    if let Some(dir) = dir {
        command.arg("-C").arg(dir);
    }
    // Global hooks (core.hooksPath) would run in a checkout nobody edits.
    command.args(["-c", "core.hooksPath=/dev/null"]);
    command
}

fn parse_head(output: &str) -> Result<String, String> {
    output
        .split_whitespace()
        .next()
        .filter(|commit| commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_string)
        .ok_or_else(|| format!("{BRANCH} was not found in {REPOSITORY}"))
}

/// The commit at the tip of the source branch.
pub fn latest_commit() -> Result<String, String> {
    let mut command = git(None);
    command.args(["ls-remote", REPOSITORY, &format!("refs/heads/{BRANCH}")]);
    parse_head(&run(None, command, "Checking the host source")?)
}

/// [`latest_commit`], asked at most every five minutes; None when it failed.
pub fn latest_commit_cached() -> Option<String> {
    static HEAD: std::sync::Mutex<Option<(Instant, Option<String>)>> = std::sync::Mutex::new(None);
    let mut head = HEAD.lock().ok()?;
    if let Some((at, commit)) = head.as_ref() {
        if at.elapsed() < Duration::from_secs(5 * 60) {
            return commit.clone();
        }
    }
    let commit = latest_commit().ok();
    *head = Some((Instant::now(), commit.clone()));
    commit
}

/// Prints the machine's platform and the Node of the host it runs, if any.
pub const MACHINE_PROBE: &str = r#"printf 'MONOCODE_UNAME %s %s\n' "$(uname -s)" "$(uname -m)"
R=$(cat "$HOME/.monocode-host/runtime-path" 2>/dev/null) && [ -x "$R/bin/node" ] &&
  printf 'MONOCODE_NODE %s\nMONOCODE_NODE_VERSION %s\n' "$R/bin/node" "$("$R/bin/node" --version)"
true
"#;

pub struct Machine {
    /// The package target, such as `linux-x64`.
    pub target: String,
    /// The installed host's Node executable and its `--version`.
    pub node: Option<(String, String)>,
}

/// Reads [`MACHINE_PROBE`] output, which may follow login shell noise.
pub fn parse_machine(output: &str) -> Result<Machine, String> {
    let field = |name: &str| {
        output
            .lines()
            .rev()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(' '))
    };
    let mut uname = field("MONOCODE_UNAME").unwrap_or("").split_whitespace();
    let (system, machine) = (uname.next().unwrap_or(""), uname.next().unwrap_or(""));
    let os = match system {
        "Linux" => "linux",
        "Darwin" => "darwin",
        _ => return Err(format!("Unsupported host platform: {system} {machine}")),
    };
    let arch = match machine {
        "x86_64" | "amd64" => "x64",
        "arm64" | "aarch64" => "arm64",
        _ => return Err(format!("Unsupported host platform: {system} {machine}")),
    };
    let node = field("MONOCODE_NODE")
        .zip(field("MONOCODE_NODE_VERSION"))
        .map(|(path, version)| (path.to_string(), version.trim().to_string()));
    Ok(Machine {
        target: format!("{os}-{arch}"),
        node,
    })
}

fn npm() -> Command {
    Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" })
}

/// Checks out the latest source branch under `data_dir` and packages the host
/// for `machine`.
pub(crate) fn build(data_dir: &Path, machine: &Machine, job: &Job) -> Result<HostPackage, String> {
    let target = machine.target.as_str();
    let dir: PathBuf = data_dir.join("host-source");
    if dir.join(".git").is_dir() {
        job.message(&format!("Fetching the latest {BRANCH} branch…"));
        let mut fetch = git(Some(&dir));
        fetch.args(["fetch", "--depth", "1", REPOSITORY, BRANCH]);
        run(Some(job), fetch, "Fetching the host source")?;
        let mut checkout = git(Some(&dir));
        checkout.args(["checkout", "--force", "--detach", "FETCH_HEAD"]);
        run(Some(job), checkout, "Checking out the host source")?;
    } else {
        job.message("Downloading the MonoCode source…");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let mut clone = git(None);
        clone
            .args([
                "clone",
                "--depth",
                "1",
                "--single-branch",
                "--branch",
                BRANCH,
                REPOSITORY,
            ])
            .arg(&dir);
        run(Some(job), clone, "Downloading the host source")?;
    }

    let lock = std::fs::read(dir.join("package-lock.json")).map_err(|e| e.to_string())?;
    let lock = format!("{:x}", Sha256::digest(&lock));
    if std::fs::read_to_string(dir.join(LOCK_MARKER))
        .ok()
        .as_deref()
        != Some(lock.as_str())
    {
        job.message("Installing build tools (the first update takes a few minutes)…");
        let mut install = npm();
        // Lifecycle scripts are not needed to bundle the host.
        install
            .args(["ci", "--ignore-scripts", "--no-audit", "--no-fund"])
            .current_dir(&dir);
        run(Some(job), install, "Installing build tools")?;
        std::fs::write(dir.join(LOCK_MARKER), &lock).map_err(|e| e.to_string())?;
    }

    job.message("Building MonoCode Host…");
    let mut package = npm();
    package
        .args(["run", "host:package", "--", "--target", target])
        .current_dir(&dir);
    run(Some(job), package, "Building MonoCode Host")?;

    let file = format!("monocode-host-{target}.tar.gz");
    let output = dir.join("build/host-packages");
    let read_json = |path: PathBuf| -> Result<serde_json::Value, String> {
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    };
    let field = |value: &serde_json::Value, key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("The host package has no {key}"))
    };
    let version = field(&read_json(dir.join("package.json"))?, "version")?;
    let node_version = field(
        &read_json(output.join(target).join("version.json"))?,
        "nodeVersion",
    )?;
    // Node is most of the package; a slow uplink takes minutes to send it.
    let reuse_node = machine
        .node
        .as_ref()
        .filter(|(_, installed)| *installed == format!("v{node_version}"))
        .map(|(path, _)| path.clone());
    let archive = if reuse_node.is_some() {
        let slim = output.join(format!("without-node-{file}"));
        let mut tar = Command::new("tar");
        tar.arg("-czf")
            .arg(&slim)
            .arg("-C")
            .arg(output.join(target))
            .args(["--exclude", "./bin/node", "."])
            .env("COPYFILE_DISABLE", "1");
        run(Some(job), tar, "Packing MonoCode Host")?;
        slim
    } else {
        output.join(&file)
    };
    let bytes = std::fs::read(archive).map_err(|e| e.to_string())?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(HostPackage {
        file,
        bytes,
        sha256,
        version,
        reuse_node,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_platform_and_installed_node_from_the_probe() {
        let machine = parse_machine(
            "Welcome to Ubuntu\nMONOCODE_UNAME Linux x86_64\nMONOCODE_NODE /home/me/.monocode-host/runtime/a b/bin/node\nMONOCODE_NODE_VERSION v24.21.0\n",
        )
        .unwrap();
        assert_eq!(machine.target, "linux-x64");
        assert_eq!(
            machine.node,
            Some((
                "/home/me/.monocode-host/runtime/a b/bin/node".into(),
                "v24.21.0".into()
            ))
        );
        let fresh = parse_machine("MONOCODE_UNAME Darwin arm64\n").unwrap();
        assert_eq!(fresh.target, "darwin-arm64");
        assert_eq!(fresh.node, None);
        assert_eq!(
            parse_machine("MONOCODE_UNAME Linux aarch64")
                .unwrap()
                .target,
            "linux-arm64"
        );
        assert!(parse_machine("MONOCODE_UNAME FreeBSD amd64").is_err());
        assert!(parse_machine("MONOCODE_UNAME Linux riscv64").is_err());
        assert!(parse_machine("").is_err());
    }

    #[test]
    fn reads_the_branch_head_from_ls_remote() {
        let commit = "1d1a7e275e9902c28307ba9e57b8570ec0e697cc";
        assert_eq!(
            parse_head(&format!("{commit}\trefs/heads/dev\n")).unwrap(),
            commit
        );
        assert!(parse_head("").is_err());
        assert!(parse_head("not-a-commit\trefs/heads/dev").is_err());
    }
}
