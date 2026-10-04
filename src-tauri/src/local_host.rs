//! "This computer": MonoCode Host on this desktop's own account, so phones can
//! use its projects. Setup runs the SSH setup's bootstrap script locally, as a
//! background job the renderer polls the same way as an SSH setup job. The
//! host keeps running when the desktop quits.
use crate::remote::{self, LocalRecord, Machine};
use crate::remote_ssh::{self, HostPlatform};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

/// The host's usual RPC port, the same one SSH setup uses.
const DEFAULT_PORT: u16 = 3774;
/// The host's default phone listener; its RPC port must differ.
const DIRECT_PORT: u16 = 3775;
const MAX_OUTPUT: usize = 64 * 1024;
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(300);
const CANCELLED: &str = "Cancelled";
const BUSY: &str = "This computer's host is already being changed. Wait for that to finish.";
const NOT_INSTALLED: &str = "MonoCode Host isn't installed on this computer. Set it up first.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Detect,
    Download,
    Verify,
    Install,
    Start,
    Connect,
    Done,
}

impl Step {
    /// The `monocode-step:<name>` lines the bootstrap prints for local setup.
    fn from_marker(line: &str) -> Option<Self> {
        match line.trim().strip_prefix("monocode-step:")? {
            "download" => Some(Self::Download),
            "verify" => Some(Self::Verify),
            "install" => Some(Self::Install),
            "start" => Some(Self::Start),
            _ => None,
        }
    }
    fn message(self) -> &'static str {
        match self {
            Self::Detect => "Checking this computer…",
            Self::Download => "Downloading MonoCode Host…",
            Self::Verify => "Verifying the package…",
            Self::Install => "Installing the background service…",
            Self::Start => "Starting the host…",
            Self::Connect => "Connecting this desktop…",
            Self::Done => "Done",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalJobView {
    pub id: String,
    pub message: String,
    pub step: Step,
    pub done: bool,
    pub error: Option<String>,
    /// What the failed command printed, shown collapsed under the error.
    pub output: Option<String>,
    pub machine: Option<Machine>,
}

pub struct LocalJob {
    view: Mutex<LocalJobView>,
    cancelled: AtomicBool,
}

impl LocalJob {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            view: Mutex::new(LocalJobView {
                id: uuid::Uuid::new_v4().to_string(),
                message: Step::Detect.message().into(),
                step: Step::Detect,
                done: false,
                error: None,
                output: None,
                machine: None,
            }),
            cancelled: AtomicBool::new(false),
        })
    }
    fn lock(&self) -> MutexGuard<'_, LocalJobView> {
        self.view.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub fn view(&self) -> LocalJobView {
        self.lock().clone()
    }
    fn step(&self, step: Step) {
        let mut view = self.lock();
        view.step = step;
        view.message = step.message().into();
    }
    fn message(&self, text: &str) {
        self.lock().message = text.into();
    }
    fn output(&self, output: String) {
        let output = output.trim();
        if !output.is_empty() {
            self.lock().output = Some(output.into());
        }
    }
    fn finish(&self, result: Result<Finished, String>) {
        let result = if self.cancelled() {
            Err(CANCELLED.to_string())
        } else {
            result
        };
        let mut view = self.lock();
        view.done = true;
        match result {
            Ok(finished) => {
                view.step = Step::Done;
                view.message = finished.message;
                view.machine = finished.machine;
                view.output = None;
            }
            Err(error) => view.error = Some(error),
        }
    }
    fn cancel(&self) {
        if !self.lock().done {
            self.cancelled.store(true, Ordering::Relaxed);
        }
    }
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

struct Finished {
    message: String,
    machine: Option<Machine>,
}

/// One local-host job at a time, with a lock separate from SSH setup's.
#[derive(Default)]
pub struct LocalHost {
    jobs: Mutex<HashMap<String, Arc<LocalJob>>>,
}

impl LocalHost {
    fn jobs(&self) -> MutexGuard<'_, HashMap<String, Arc<LocalJob>>> {
        self.jobs.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn begin(&self, job: Arc<LocalJob>) -> Result<(), String> {
        let mut jobs = self.jobs();
        if jobs.values().any(|job| !job.view().done) {
            return Err(BUSY.into());
        }
        jobs.retain(|_, job| !job.view().done);
        jobs.insert(job.view().id, job);
        Ok(())
    }
    fn job(&self, id: &str) -> Result<Arc<LocalJob>, String> {
        self.jobs()
            .get(id)
            .cloned()
            .ok_or_else(|| "This change has expired. Check this computer's host again.".into())
    }
    fn active(&self) -> Option<String> {
        self.jobs()
            .values()
            .map(|job| job.view())
            .find(|view| !view.done)
            .map(|view| view.id)
    }
}

/// A finished process: whether it exited 0, and what it printed.
pub(crate) struct Run {
    ok: bool,
    stdout: String,
    stderr: String,
}

impl Run {
    /// The line that explains a failure: the last thing written to stderr.
    fn reason(&self, fallback: &str) -> String {
        self.stdout
            .lines()
            .chain(self.stderr.lines())
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty() && Step::from_marker(line).is_none())
            .map(|line| line.chars().take(500).collect())
            .unwrap_or_else(|| fallback.into())
    }
    fn combined(&self) -> String {
        format!("{}\n{}", self.stdout.trim(), self.stderr.trim())
    }
}

/// Everything a job does to this computer, so tests can script it.
trait System: Send + Sync {
    fn platform(&self) -> HostPlatform;
    fn installed(&self) -> bool;
    /// Runs `monocode-host <args>`.
    fn host(
        &self,
        args: &[&str],
        timeout: Duration,
        job: Option<&Arc<LocalJob>>,
    ) -> Result<Run, String>;
    /// Runs a bootstrap script in the platform shell, following its steps.
    fn bootstrap(&self, script: String, job: &Arc<LocalJob>) -> Result<Run, String>;
    fn port_free(&self, port: u16) -> bool;
    fn free_port(&self) -> Result<u16, String>;
    fn rpc(
        &self,
        endpoint: &str,
        token: &str,
        environment_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String>;
}

/// `~/.monocode-host`, where the bootstrap installs the host.
fn host_dir() -> Result<PathBuf, String> {
    crate::dirs_home()
        .map(|home| PathBuf::from(home).join(".monocode-host"))
        .ok_or_else(|| "Could not find your home folder".into())
}

fn this_platform() -> HostPlatform {
    if cfg!(windows) {
        HostPlatform::Windows
    } else {
        HostPlatform::Unix
    }
}

struct RealSystem {
    base: PathBuf,
}

impl RealSystem {
    fn new() -> Result<Self, String> {
        Ok(Self { base: host_dir()? })
    }
    fn launcher(&self) -> PathBuf {
        self.base.join("bin").join(match this_platform() {
            HostPlatform::Unix => "monocode-host",
            HostPlatform::Windows => "monocode-host.cmd",
        })
    }
    fn runtime(&self) -> Option<PathBuf> {
        std::fs::read_to_string(self.base.join("runtime-path"))
            .ok()
            .map(|path| PathBuf::from(path.trim()))
            .filter(|path| !path.as_os_str().is_empty())
    }
    /// The installed package's version, from its runtime folder's name.
    fn installed_version(&self) -> Option<String> {
        runtime_version(&self.runtime()?.file_name()?.to_string_lossy())
    }
}

impl System for RealSystem {
    fn platform(&self) -> HostPlatform {
        this_platform()
    }
    fn installed(&self) -> bool {
        self.launcher().is_file()
            && (this_platform() == HostPlatform::Unix || self.runtime().is_some())
    }
    fn host(
        &self,
        args: &[&str],
        timeout: Duration,
        job: Option<&Arc<LocalJob>>,
    ) -> Result<Run, String> {
        let mut command = match this_platform() {
            HostPlatform::Unix => Command::new(self.launcher()),
            // The launcher is a batch file. Run its Node runtime directly, so
            // arguments such as the computer name never pass through cmd.exe.
            HostPlatform::Windows => {
                let runtime = self.runtime().ok_or(NOT_INSTALLED)?;
                let mut command = Command::new(runtime.join("node.exe"));
                command.arg(runtime.join("host.mjs"));
                command
            }
        };
        command.args(args);
        run(command, None, timeout, job)
    }
    fn bootstrap(&self, script: String, job: &Arc<LocalJob>) -> Result<Run, String> {
        run(
            shell(this_platform()),
            Some(script),
            SCRIPT_TIMEOUT,
            Some(job),
        )
    }
    fn port_free(&self, port: u16) -> bool {
        port_free(port)
    }
    fn free_port(&self) -> Result<u16, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
    }
    fn rpc(
        &self,
        endpoint: &str,
        token: &str,
        environment_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        remote::rpc_within(
            endpoint,
            token,
            Some(environment_id),
            method,
            params,
            Duration::from_secs(30),
        )
    }
}

/// Free when nothing answers on the loopback port and it can be bound. The
/// connect catches a listener on the wildcard address that bind may not.
fn port_free(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200)).is_err()
        && TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// `sh -l -s`, or Windows PowerShell reading the script from stdin.
fn shell(platform: HostPlatform) -> Command {
    match platform {
        HostPlatform::Unix => {
            let mut command = Command::new("sh");
            command.args(["-l", "-s"]).env("LC_ALL", "C");
            command
        }
        HostPlatform::Windows => {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &remote_ssh::powershell_reader(),
            ]);
            command
        }
    }
}

/// Reads a child's pipe on its own thread. A process the child started (the
/// host itself) may inherit the pipe, so the result never waits for its end.
struct Collector {
    text: Arc<Mutex<String>>,
    done: mpsc::Receiver<()>,
}

impl Collector {
    fn start(reader: impl Read + Send + 'static, job: Option<Arc<LocalJob>>) -> Self {
        let text = Arc::new(Mutex::new(String::new()));
        let (sender, done) = mpsc::channel();
        let shared = text.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).split(b'\n') {
                let Ok(line) = line else { break };
                let line = String::from_utf8_lossy(&line);
                if let (Some(job), Some(step)) = (&job, Step::from_marker(&line)) {
                    job.step(step);
                }
                let mut text = shared.lock().unwrap_or_else(PoisonError::into_inner);
                if text.len() < MAX_OUTPUT {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
            let _ = sender.send(());
        });
        Self { text, done }
    }
    fn finish(self) -> String {
        let _ = self.done.recv_timeout(Duration::from_secs(2));
        let text = self.text.lock().unwrap_or_else(PoisonError::into_inner);
        text.clone()
    }
}

fn run(
    mut command: Command,
    stdin: Option<String>,
    timeout: Duration,
    job: Option<&Arc<LocalJob>>,
) -> Result<Run, String> {
    if job.is_some_and(|job| job.cancelled()) {
        return Err(CANCELLED.into());
    }
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::hide_window_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not run MonoCode Host: {e}"))?;
    let stdout = Collector::start(child.stdout.take().unwrap(), job.cloned());
    let stderr = Collector::start(child.stderr.take().unwrap(), None);
    if let (Some(script), Some(mut pipe)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || pipe.write_all(script.as_bytes()));
    }
    let deadline = Instant::now() + timeout;
    let ok = loop {
        if job.is_some_and(|job| job.cancelled()) || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if job.is_some_and(|job| job.cancelled()) {
                CANCELLED.into()
            } else {
                "MonoCode Host took too long to answer. Try again.".into()
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    };
    Ok(Run {
        ok,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
    })
}

/// The port in `connection-info`'s JSON, its last line of output.
pub(crate) fn parse_connection_info(output: &str) -> Result<u16, String> {
    let line = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let info: Value =
        serde_json::from_str(line).map_err(|_| "Host setup returned an invalid response")?;
    info.get("port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| "Host did not report a valid port".into())
}

#[derive(Debug, PartialEq)]
pub(crate) struct Pairing {
    environment_id: String,
    token: String,
}

/// `pair --json`: `{id, token, environmentId}`, as SSH setup reads it.
pub(crate) fn parse_pairing(output: &str) -> Result<Pairing, String> {
    let line = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let pair: Value =
        serde_json::from_str(line).map_err(|_| "Host pairing returned an invalid response")?;
    let token = pair
        .get("token")
        .and_then(Value::as_str)
        .filter(|s| {
            s.len() == 43
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or("Host returned an invalid device credential")?
        .to_string();
    let environment_id = pair
        .get("environmentId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Host identity is missing")?
        .to_string();
    Ok(Pairing {
        environment_id,
        token,
    })
}

/// Prefers the port this computer's host used before, then 3774. When those
/// are taken by something else, any free loopback port.
fn choose_port(
    previous: Option<u16>,
    port_free: impl Fn(u16) -> bool,
    free_port: impl FnOnce() -> Result<u16, String>,
) -> Result<u16, String> {
    previous
        .into_iter()
        .chain([DEFAULT_PORT])
        .find(|port| *port != DIRECT_PORT && port_free(*port))
        .map_or_else(free_port, Ok)
}

fn endpoint_port(endpoint: &str) -> Option<u16> {
    url::Url::parse(endpoint).ok()?.port()
}

pub(crate) struct ScriptEnv<'a> {
    pub port: u16,
    pub upgrade: bool,
    /// A local package, in development builds only.
    pub archive: Option<&'a str>,
}

/// The bootstrap, preceded by the variables it reads. They are set in the
/// script itself, as `upgrade_script` does, so a login profile can't drop them.
pub(crate) fn local_script(platform: HostPlatform, env: &ScriptEnv) -> String {
    let mut variables = vec![
        ("MONOCODE_HOST_PORT", env.port.to_string()),
        ("MONOCODE_HOST_PROGRESS", "1".to_string()),
    ];
    if env.upgrade {
        variables.push(("MONOCODE_HOST_FORCE_UPGRADE", "1".into()));
    }
    if let Some(archive) = env.archive {
        variables.push(("MONOCODE_HOST_LOCAL_ARCHIVE", archive.into()));
    }
    let mut script = String::new();
    for (name, value) in variables {
        script.push_str(&match platform {
            HostPlatform::Unix => format!("{name}={}\n", remote_ssh::shell_quote(&value)),
            HostPlatform::Windows => {
                format!("$env:{name} = {}\n", remote_ssh::powershell_quote(&value))
            }
        });
    }
    script + &remote_ssh::bootstrap_script(platform)
}

/// Development builds install a host packaged by `npm run host:package` when
/// the desktop runs with `MONOCODE_HOST_ARCHIVE` (the archive, or its folder).
fn development_archive() -> Option<String> {
    archive_path(
        cfg!(debug_assertions),
        std::env::var_os("MONOCODE_HOST_ARCHIVE"),
    )
}

fn archive_path(development: bool, value: Option<std::ffi::OsString>) -> Option<String> {
    let path = PathBuf::from(value.filter(|_| development)?);
    if path.as_os_str().is_empty() {
        return None;
    }
    // The script runs in its own shell; give it an absolute path.
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    Some(path.to_string_lossy().into_owned())
}

/// `0.9.0-darwin-arm64-.install.x1Y2` or `0.9.0-win32-x64-<guid>`: the
/// version is everything before the platform.
fn runtime_version(folder: &str) -> Option<String> {
    ["-darwin-", "-linux-", "-win32-"]
        .iter()
        .filter_map(|platform| folder.find(platform))
        .min()
        .map(|end| folder[..end].to_string())
        .filter(|version| !version.is_empty())
}

/// "<computer name> (this computer)", within the host's 64-character names.
fn local_device_name(computer: Option<String>) -> String {
    const SUFFIX: &str = " (this computer)";
    match computer {
        Some(name) => {
            let name: String = name.chars().take(64 - SUFFIX.len()).collect();
            format!("{name}{SUFFIX}")
        }
        None => "This computer".into(),
    }
}

/// `connection-info`'s port, when the host is installed and answers.
fn running_port(system: &dyn System) -> Option<u16> {
    if !system.installed() {
        return None;
    }
    system
        .host(&["connection-info"], STATUS_TIMEOUT, None)
        .ok()
        .filter(|run| run.ok)
        .and_then(|run| parse_connection_info(&run.stdout).ok())
}

fn check_descriptor(descriptor: &Value, environment_id: &str) -> Result<(), String> {
    if descriptor.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("This host uses an incompatible protocol version".into());
    }
    if descriptor.get("environmentId").and_then(Value::as_str) != Some(environment_id) {
        return Err("Host identity changed. Set up this computer's host again.".into());
    }
    Ok(())
}

/// What setup, update and restart hand to the machine store.
#[derive(Debug, PartialEq)]
struct Prepared {
    endpoint: String,
    environment_id: String,
    token: String,
}

/// Setup and update: reuse a running host or install one, pair this desktop
/// unless the host still accepts its credential, then check the host answers
/// as itself.
fn prepare(
    system: &dyn System,
    job: &Arc<LocalJob>,
    record: Option<&LocalRecord>,
    upgrade: bool,
    archive: Option<&str>,
    name: &str,
) -> Result<Prepared, String> {
    job.step(Step::Detect);
    let running = running_port(system);
    let port = match running {
        // The same account may already serve another desktop over SSH; it is
        // the same host.
        Some(port) if !upgrade => port,
        _ => {
            let port = match running {
                // An update restarts the host on the port it already uses.
                Some(port) => port,
                None => choose_port(
                    record.and_then(|record| endpoint_port(&record.endpoint)),
                    |port| system.port_free(port),
                    || system.free_port(),
                )?,
            };
            job.step(if system.installed() && !upgrade {
                Step::Install
            } else {
                Step::Download
            });
            let script = local_script(
                system.platform(),
                &ScriptEnv {
                    port,
                    upgrade,
                    archive,
                },
            );
            let output = system.bootstrap(script, job)?;
            if !output.ok {
                job.output(output.combined());
                return Err(output.reason("MonoCode Host setup failed."));
            }
            parse_connection_info(&output.stdout)?
        }
    };
    job.step(Step::Connect);
    let endpoint = format!("http://127.0.0.1:{port}");
    if let Some(record) = record {
        let describe = system.rpc(
            &endpoint,
            &record.token,
            &record.environment_id,
            "environment.describe",
            json!({}),
        );
        if let Ok(descriptor) = describe {
            check_descriptor(&descriptor, &record.environment_id)?;
            return Ok(Prepared {
                endpoint,
                environment_id: record.environment_id.clone(),
                token: record.token.clone(),
            });
        }
    }
    let output = system.host(
        &["pair", "--name", name, "--json"],
        COMMAND_TIMEOUT,
        Some(job),
    )?;
    if !output.ok {
        job.output(output.combined());
        return Err(output.reason("Could not pair this desktop with the host."));
    }
    let pairing = parse_pairing(&output.stdout)?;
    let descriptor = system.rpc(
        &endpoint,
        &pairing.token,
        &pairing.environment_id,
        "environment.describe",
        json!({}),
    )?;
    check_descriptor(&descriptor, &pairing.environment_id)?;
    Ok(Prepared {
        endpoint,
        environment_id: pairing.environment_id,
        token: pairing.token,
    })
}

/// Stops and starts the host through its service, on the port it uses.
fn restart(
    system: &dyn System,
    job: &Arc<LocalJob>,
    record: &LocalRecord,
) -> Result<Prepared, String> {
    let port = running_port(system)
        .or_else(|| endpoint_port(&record.endpoint))
        .unwrap_or(DEFAULT_PORT);
    job.step(Step::Install);
    job.message("Stopping the host…");
    let stopped = system.host(&["service", "uninstall"], COMMAND_TIMEOUT, Some(job))?;
    if !stopped.ok {
        job.output(stopped.combined());
        return Err(stopped.reason("Could not stop the host."));
    }
    job.step(Step::Start);
    let started = system.host(
        &["service", "install", "--port", &port.to_string()],
        COMMAND_TIMEOUT,
        Some(job),
    )?;
    if !started.ok {
        job.output(started.combined());
        return Err(started.reason("Could not start the host."));
    }
    let port = parse_connection_info(&started.stdout)?;
    job.step(Step::Connect);
    let endpoint = format!("http://127.0.0.1:{port}");
    let descriptor = system.rpc(
        &endpoint,
        &record.token,
        &record.environment_id,
        "environment.describe",
        json!({}),
    )?;
    check_descriptor(&descriptor, &record.environment_id)?;
    Ok(Prepared {
        endpoint,
        environment_id: record.environment_id.clone(),
        token: record.token.clone(),
    })
}

/// "Stop sharing with phones": no relay, no direct listener, no phones. The
/// host keeps running for this desktop.
fn stop_sharing(
    system: &dyn System,
    job: &Arc<LocalJob>,
    record: &LocalRecord,
) -> Result<usize, String> {
    let call = |method: &str, params: Value| {
        system.rpc(
            &record.endpoint,
            &record.token,
            &record.environment_id,
            method,
            params,
        )
    };
    job.message("Turning off connections from phones…");
    call(
        "host.config.set",
        json!({ "relay": { "enabled": false }, "direct": { "mode": "off" } }),
    )?;
    job.message("Removing phones…");
    let devices = call("devices.list", json!({}))?;
    let phones: Vec<&str> = devices
        .as_array()
        .into_iter()
        .flatten()
        .filter(|device| device.get("kind").and_then(Value::as_str) == Some("mobile"))
        .filter_map(|device| device.get("id").and_then(Value::as_str))
        .collect();
    for id in &phones {
        call("devices.revoke", json!({ "deviceId": id }))?;
    }
    Ok(phones.len())
}

/// Removes the host's service. Sessions and data stay in `~/.monocode-host`.
fn uninstall(
    system: &dyn System,
    job: &Arc<LocalJob>,
    record: Option<&LocalRecord>,
) -> Result<String, String> {
    if let Some(record) = record {
        // A fresh setup pairs again; don't leave this credential behind.
        let _ = system.rpc(
            &record.endpoint,
            &record.token,
            &record.environment_id,
            "devices.revokeSelf",
            json!({}),
        );
    }
    job.step(Step::Install);
    job.message("Removing the background service…");
    let output = system.host(&["service", "uninstall"], COMMAND_TIMEOUT, Some(job))?;
    if !output.ok {
        job.output(output.combined());
        return Err(output.reason("Could not remove the host's service."));
    }
    Ok(output.stdout.trim().to_string())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Setup,
    Update,
    Restart,
    StopSharing,
    Uninstall,
}

fn start_job(app: AppHandle, kind: Kind) -> Result<String, String> {
    let job = LocalJob::new();
    let id = job.view().id;
    app.state::<LocalHost>().begin(job.clone())?;
    std::thread::spawn(move || {
        let result = (|| -> Result<Finished, String> {
            let system = RealSystem::new()?;
            let record = remote::local_record(&app)?;
            let save = |prepared: Prepared| {
                remote::save_local_machine(
                    &app,
                    prepared.endpoint,
                    prepared.environment_id,
                    prepared.token,
                )
            };
            match kind {
                Kind::Setup | Kind::Update => {
                    let prepared = prepare(
                        &system,
                        &job,
                        record.as_ref(),
                        kind == Kind::Update,
                        development_archive().as_deref(),
                        &local_device_name(remote_ssh::computer_name()),
                    )?;
                    Ok(Finished {
                        message: if kind == Kind::Update {
                            "MonoCode Host was updated."
                        } else {
                            "This computer is ready."
                        }
                        .into(),
                        machine: Some(save(prepared)?),
                    })
                }
                Kind::Restart => {
                    let record = record.ok_or(NOT_INSTALLED)?;
                    let prepared = restart(&system, &job, &record)?;
                    Ok(Finished {
                        message: "MonoCode Host restarted.".into(),
                        machine: Some(save(prepared)?),
                    })
                }
                Kind::StopSharing => {
                    let record = record.ok_or(NOT_INSTALLED)?;
                    let phones = stop_sharing(&system, &job, &record)?;
                    Ok(Finished {
                        message: match phones {
                            0 => "Phones can no longer connect to this computer.".into(),
                            1 => "Phones can no longer connect to this computer. 1 phone was removed.".into(),
                            n => format!("Phones can no longer connect to this computer. {n} phones were removed."),
                        },
                        machine: None,
                    })
                }
                Kind::Uninstall => {
                    if !system.installed() {
                        return Err(NOT_INSTALLED.into());
                    }
                    let notes = uninstall(&system, &job, record.as_ref())?;
                    remote::forget_local_machine(&app)?;
                    Ok(Finished {
                        message: if notes.is_empty() {
                            "MonoCode Host was removed from this computer.".into()
                        } else {
                            notes
                        },
                        machine: None,
                    })
                }
            }
        })();
        job.finish(result);
    });
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHostStatus {
    installed: bool,
    running: bool,
    /// The running host's version, or else the installed package's.
    version: Option<String>,
    port: Option<u16>,
    machine_id: Option<String>,
    app_version: &'static str,
    data_dir: String,
    /// A setup, update or removal still in progress.
    job_id: Option<String>,
}

#[tauri::command(async)]
pub fn local_host_status(
    app: AppHandle,
    state: State<'_, LocalHost>,
) -> Result<LocalHostStatus, String> {
    let system = RealSystem::new()?;
    let record = remote::local_record(&app)?;
    let installed = system.installed();
    let port = running_port(&system);
    let running_version = port.zip(record.as_ref()).and_then(|(port, record)| {
        remote::rpc_within(
            &format!("http://127.0.0.1:{port}"),
            &record.token,
            Some(&record.environment_id),
            "environment.describe",
            json!({}),
            Duration::from_secs(3),
        )
        .ok()?
        .get("hostVersion")?
        .as_str()
        .map(String::from)
    });
    Ok(LocalHostStatus {
        installed,
        running: port.is_some(),
        version: running_version.or_else(|| system.installed_version()),
        port: port.or_else(|| record.as_ref().and_then(|r| endpoint_port(&r.endpoint))),
        machine_id: record.map(|record| record.id),
        app_version: env!("CARGO_PKG_VERSION"),
        data_dir: crate::fs::path_to_js(&system.base),
        job_id: state.active(),
    })
}

#[tauri::command(async)]
pub fn local_host_setup(app: AppHandle) -> Result<String, String> {
    start_job(app, Kind::Setup)
}

#[tauri::command(async)]
pub fn local_host_update(app: AppHandle) -> Result<String, String> {
    start_job(app, Kind::Update)
}

#[tauri::command(async)]
pub fn local_host_restart(app: AppHandle) -> Result<String, String> {
    start_job(app, Kind::Restart)
}

#[tauri::command(async)]
pub fn local_host_remove(app: AppHandle, mode: String) -> Result<String, String> {
    match mode.as_str() {
        "stopSharing" => start_job(app, Kind::StopSharing),
        "uninstall" => start_job(app, Kind::Uninstall),
        _ => Err("Unknown removal option".into()),
    }
}

/// `monocode-host start`, for a host that stopped.
#[tauri::command(async)]
pub fn local_host_start(app: AppHandle, state: State<'_, LocalHost>) -> Result<(), String> {
    if state.active().is_some() {
        return Err(BUSY.into());
    }
    let system = RealSystem::new()?;
    if !system.installed() {
        return Err(NOT_INSTALLED.into());
    }
    let port = remote::local_record(&app)?
        .and_then(|record| endpoint_port(&record.endpoint))
        .unwrap_or(DEFAULT_PORT);
    let output = system.host(
        &["start", "--port", &port.to_string()],
        COMMAND_TIMEOUT,
        None,
    )?;
    if !output.ok {
        return Err(output.reason("The host didn't start."));
    }
    Ok(())
}

/// `monocode-host doctor --json`. It exits 1 when a check fails, and still
/// prints the report.
#[tauri::command(async)]
pub fn local_host_doctor(app: AppHandle) -> Result<Value, String> {
    let system = RealSystem::new()?;
    if !system.installed() {
        return Err(NOT_INSTALLED.into());
    }
    let port = remote::local_record(&app)?
        .and_then(|record| endpoint_port(&record.endpoint))
        .unwrap_or(DEFAULT_PORT);
    let output = system.host(
        &["doctor", "--json", "--port", &port.to_string()],
        COMMAND_TIMEOUT,
        None,
    )?;
    parse_doctor(&output.stdout)
        .map_err(|_| output.reason("This host can't run diagnostics. Update it first."))
}

/// `DoctorReport` (`packages/core/src/wire.ts`), checked before the renderer
/// sees it.
fn parse_doctor(output: &str) -> Result<Value, String> {
    let start = output.find('{').ok_or("No report")?;
    let report: Value = serde_json::from_str(output[start..].trim()).map_err(|e| e.to_string())?;
    if report.get("v").and_then(Value::as_u64) != Some(1)
        || !report.get("checks").is_some_and(Value::is_array)
    {
        return Err("Unknown report".into());
    }
    Ok(report)
}

#[tauri::command]
pub fn local_host_poll(
    state: State<'_, LocalHost>,
    job_id: String,
) -> Result<LocalJobView, String> {
    Ok(state.job(&job_id)?.view())
}

#[tauri::command]
pub fn local_host_cancel(state: State<'_, LocalHost>, job_id: String) -> Result<(), String> {
    state.job(&job_id)?.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    #[test]
    fn reads_connection_info_after_setup_output() {
        assert_eq!(
            parse_connection_info("monocode-step:start\n{\"port\":3780,\"pid\":12}\n\n").unwrap(),
            3780
        );
        assert_eq!(
            parse_connection_info("{\"port\":3774,\"pid\":1}\r\n").unwrap(),
            3774
        );
        for output in [
            "",
            "not json",
            "{\"port\":0}",
            "{\"port\":70000}",
            "{\"pid\":1}",
        ] {
            assert!(parse_connection_info(output).is_err(), "{output}");
        }
    }

    #[test]
    fn reads_the_pairing_credential() {
        let output = format!("{{\"id\":\"d\",\"token\":\"{TOKEN}\",\"environmentId\":\"env\"}}\n");
        assert_eq!(
            parse_pairing(&output).unwrap(),
            Pairing {
                environment_id: "env".into(),
                token: TOKEN.into()
            }
        );
        for output in [
            "".to_string(),
            "{\"token\":\"short\",\"environmentId\":\"env\"}".into(),
            format!("{{\"token\":\"{TOKEN}\",\"environmentId\":\"\"}}"),
            format!(
                "{{\"token\":\"{}\",\"environmentId\":\"env\"}}",
                "a/".repeat(21) + "a"
            ),
        ] {
            assert!(parse_pairing(&output).is_err(), "{output}");
        }
    }

    #[test]
    fn prefers_3774_then_any_free_loopback_port() {
        let free = |ports: &'static [u16]| move |port| ports.contains(&port);
        assert_eq!(
            choose_port(None, free(&[3774]), || Ok(50000)).unwrap(),
            3774
        );
        assert_eq!(choose_port(None, free(&[]), || Ok(50000)).unwrap(), 50000);
        // The port this computer's host had before wins when it is free.
        assert_eq!(
            choose_port(Some(3790), free(&[3774, 3790]), || Ok(50000)).unwrap(),
            3790
        );
        assert_eq!(
            choose_port(Some(3790), free(&[3774]), || Ok(50000)).unwrap(),
            3774
        );
        // Never the phone listener's port.
        assert_eq!(
            choose_port(Some(3775), free(&[3775]), || Ok(50000)).unwrap(),
            50000
        );
        assert!(choose_port(None, free(&[]), || Err("none".into())).is_err());
    }

    #[test]
    fn a_listening_port_is_not_free() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_free(port));
        drop(listener);
    }

    #[test]
    fn script_sets_the_port_progress_and_development_package() {
        let script = local_script(
            HostPlatform::Unix,
            &ScriptEnv {
                port: 3790,
                upgrade: false,
                archive: Some("/tmp/host's packages"),
            },
        );
        assert!(script.starts_with(
            "MONOCODE_HOST_PORT='3790'\nMONOCODE_HOST_PROGRESS='1'\nMONOCODE_HOST_LOCAL_ARCHIVE='/tmp/host'\\''s packages'\nset -eu\n"
        ));
        assert!(!script.contains("MONOCODE_HOST_FORCE_UPGRADE='1'"));
        assert!(script.contains("LOCAL_ARCHIVE=${MONOCODE_HOST_LOCAL_ARCHIVE:-}"));
        assert!(!script.contains("@@"));
        let script = local_script(
            HostPlatform::Unix,
            &ScriptEnv {
                port: 3774,
                upgrade: true,
                archive: None,
            },
        );
        assert!(script.contains("MONOCODE_HOST_FORCE_UPGRADE='1'\n"));
        assert!(!script.contains("MONOCODE_HOST_LOCAL_ARCHIVE='"));
        let script = local_script(
            HostPlatform::Windows,
            &ScriptEnv {
                port: 3790,
                upgrade: true,
                archive: Some("C:\\Users\\Ni'ck\\host"),
            },
        );
        assert!(script.starts_with(
            "$env:MONOCODE_HOST_PORT = '3790'\n$env:MONOCODE_HOST_PROGRESS = '1'\n$env:MONOCODE_HOST_FORCE_UPGRADE = '1'\n$env:MONOCODE_HOST_LOCAL_ARCHIVE = 'C:\\Users\\Ni''ck\\host'\n"
        ));
        assert!(script.contains("$localArchive = $env:MONOCODE_HOST_LOCAL_ARCHIVE"));
        assert!(script.contains("Write-MonoCodeStep 'download'"));
        assert!(!script.contains("@@"));
    }

    #[test]
    fn only_development_builds_use_a_local_package() {
        let value = || Some(std::ffi::OsString::from("/no/such/monocode-host.tar.gz"));
        assert_eq!(archive_path(false, value()), None);
        assert_eq!(archive_path(true, None), None);
        assert_eq!(archive_path(true, Some("".into())), None);
        assert_eq!(
            archive_path(true, value()).as_deref(),
            Some("/no/such/monocode-host.tar.gz")
        );
        let folder = std::env::temp_dir();
        let resolved = archive_path(true, Some(folder.clone().into_os_string())).unwrap();
        assert_eq!(
            PathBuf::from(resolved),
            std::fs::canonicalize(folder).unwrap()
        );
    }

    #[test]
    fn names_and_versions() {
        assert_eq!(
            local_device_name(Some("Nick's MacBook".into())),
            "Nick's MacBook (this computer)"
        );
        assert_eq!(local_device_name(None), "This computer");
        assert_eq!(local_device_name(Some("x".repeat(100))).chars().count(), 64);
        assert_eq!(
            runtime_version("0.9.0-darwin-arm64-.install.AbC123").as_deref(),
            Some("0.9.0")
        );
        assert_eq!(
            runtime_version("1.0.0-beta.2-linux-x64-.install.q").as_deref(),
            Some("1.0.0-beta.2")
        );
        assert_eq!(
            runtime_version("0.9.0-win32-x64-0f9e").as_deref(),
            Some("0.9.0")
        );
        assert_eq!(runtime_version("unpacked"), None);
        assert_eq!(endpoint_port("http://127.0.0.1:3790"), Some(3790));
        assert_eq!(
            Step::from_marker("monocode-step:verify\r"),
            Some(Step::Verify)
        );
        assert_eq!(Step::from_marker("monocode-step:other"), None);
    }

    #[test]
    fn doctor_reports_are_checked() {
        let report = parse_doctor(
            "{\n  \"v\": 1,\n  \"hostVersion\": \"0.9.0\",\n  \"ok\": false,\n  \"checks\": []\n}\n",
        )
        .unwrap();
        assert_eq!(report["hostVersion"], "0.9.0");
        assert!(parse_doctor("Unknown command; run with --help").is_err());
        assert!(parse_doctor("{\"v\":2,\"checks\":[]}").is_err());
    }

    /// A computer whose host and network a test scripts.
    #[derive(Default)]
    struct Fake {
        installed: bool,
        running: Mutex<Option<u16>>,
        busy: Vec<u16>,
        accepted: Mutex<Vec<String>>,
        fail_bootstrap: bool,
        devices: Value,
        calls: Mutex<Vec<String>>,
        scripts: Mutex<Vec<String>>,
    }

    impl Fake {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn record(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
    }

    fn ok(stdout: &str) -> Result<Run, String> {
        Ok(Run {
            ok: true,
            stdout: stdout.into(),
            stderr: String::new(),
        })
    }

    impl System for Fake {
        fn platform(&self) -> HostPlatform {
            HostPlatform::Unix
        }
        fn installed(&self) -> bool {
            self.installed
        }
        fn host(
            &self,
            args: &[&str],
            _: Duration,
            _: Option<&Arc<LocalJob>>,
        ) -> Result<Run, String> {
            self.record(format!("host {}", args.join(" ")));
            match args {
                ["connection-info"] => match *self.running.lock().unwrap() {
                    Some(port) => ok(&format!("{{\"port\":{port},\"pid\":1}}")),
                    None => Ok(Run {
                        ok: false,
                        stdout: String::new(),
                        stderr: "Host is not ready".into(),
                    }),
                },
                ["pair", "--name", _, "--json"] => {
                    self.accepted.lock().unwrap().push(TOKEN.into());
                    ok(&format!(
                        "{{\"id\":\"d\",\"token\":\"{TOKEN}\",\"environmentId\":\"env\"}}"
                    ))
                }
                ["service", "uninstall"] => {
                    *self.running.lock().unwrap() = None;
                    ok("The host is stopped and will not start automatically.")
                }
                ["service", "install", "--port", port] => {
                    *self.running.lock().unwrap() = Some(port.parse().unwrap());
                    ok(&format!("{{\"port\":{port},\"pid\":2}}"))
                }
                _ => panic!("unexpected {args:?}"),
            }
        }
        fn bootstrap(&self, script: String, job: &Arc<LocalJob>) -> Result<Run, String> {
            self.record("bootstrap".into());
            if self.fail_bootstrap {
                return Ok(Run {
                    ok: false,
                    stdout: "monocode-step:download\n".into(),
                    stderr: "curl: (22) 404\nThe MonoCode Host package for version 0.9.0 is unavailable.\n".into(),
                });
            }
            job.step(Step::Verify);
            let port: u16 = script
                .lines()
                .find_map(|line| line.strip_prefix("MONOCODE_HOST_PORT='"))
                .and_then(|rest| rest.trim_end_matches('\'').parse().ok())
                .unwrap();
            self.scripts.lock().unwrap().push(script);
            *self.running.lock().unwrap() = Some(port);
            ok(&format!(
                "monocode-step:start\n{{\"port\":{port},\"pid\":3}}\n"
            ))
        }
        fn port_free(&self, port: u16) -> bool {
            !self.busy.contains(&port)
        }
        fn free_port(&self) -> Result<u16, String> {
            Ok(51000)
        }
        fn rpc(
            &self,
            endpoint: &str,
            token: &str,
            environment: &str,
            method: &str,
            params: Value,
        ) -> Result<Value, String> {
            self.record(format!("rpc {method} {endpoint}"));
            if !self.accepted.lock().unwrap().iter().any(|t| t == token) {
                return Err("Host rejected request: Unauthorized".into());
            }
            Ok(match method {
                "environment.describe" => {
                    json!({ "protocolVersion": 1, "environmentId": environment, "hostVersion": "0.9.0" })
                }
                "devices.list" => self.devices.clone(),
                "devices.revoke" => json!({ "revoked": true, "id": params["deviceId"] }),
                _ => json!({}),
            })
        }
    }

    fn record(port: u16, token: &str) -> LocalRecord {
        LocalRecord {
            id: "machine".into(),
            endpoint: format!("http://127.0.0.1:{port}"),
            environment_id: "env".into(),
            token: token.into(),
        }
    }

    #[test]
    fn setup_installs_pairs_and_verifies_a_new_host() {
        let fake = Fake::default();
        let job = LocalJob::new();
        let prepared = prepare(&fake, &job, None, false, None, "Mac (this computer)").unwrap();
        assert_eq!(
            prepared,
            Prepared {
                endpoint: "http://127.0.0.1:3774".into(),
                environment_id: "env".into(),
                token: TOKEN.into()
            }
        );
        assert_eq!(
            fake.calls(),
            [
                "bootstrap",
                "host pair --name Mac (this computer) --json",
                "rpc environment.describe http://127.0.0.1:3774",
            ]
        );
        assert_eq!(job.view().step, Step::Connect);
        job.finish(Ok(Finished {
            message: "This computer is ready.".into(),
            machine: None,
        }));
        assert_eq!(job.view().step, Step::Done);
        assert!(job.view().done && job.view().error.is_none());
    }

    #[test]
    fn setup_reuses_a_running_host_and_its_port() {
        let fake = Fake {
            installed: true,
            running: Mutex::new(Some(3781)),
            ..Fake::default()
        };
        let prepared = prepare(&fake, &LocalJob::new(), None, false, None, "Mac").unwrap();
        assert_eq!(prepared.endpoint, "http://127.0.0.1:3781");
        assert!(!fake.calls().contains(&"bootstrap".to_string()));
        assert!(fake
            .calls()
            .iter()
            .any(|call| call.starts_with("host pair")));
    }

    #[test]
    fn setup_moves_off_a_taken_port_and_keeps_a_working_credential() {
        let fake = Fake {
            installed: true,
            busy: vec![3774],
            accepted: Mutex::new(vec!["saved".into()]),
            ..Fake::default()
        };
        let saved = record(3774, "saved");
        let prepared = prepare(
            &fake,
            &LocalJob::new(),
            Some(&saved),
            false,
            Some("/dev/pkg"),
            "Mac",
        )
        .unwrap();
        assert_eq!(prepared.endpoint, "http://127.0.0.1:51000");
        assert_eq!(prepared.token, "saved");
        let script = fake.scripts.lock().unwrap()[0].clone();
        assert!(script.starts_with("MONOCODE_HOST_PORT='51000'\n"));
        assert!(script.contains("MONOCODE_HOST_LOCAL_ARCHIVE='/dev/pkg'\n"));
        assert!(!fake
            .calls()
            .iter()
            .any(|call| call.starts_with("host pair")));
    }

    #[test]
    fn update_reinstalls_on_the_running_port() {
        let fake = Fake {
            installed: true,
            running: Mutex::new(Some(3782)),
            accepted: Mutex::new(vec!["saved".into()]),
            ..Fake::default()
        };
        let prepared = prepare(
            &fake,
            &LocalJob::new(),
            Some(&record(3782, "saved")),
            true,
            None,
            "Mac",
        )
        .unwrap();
        assert_eq!(prepared.endpoint, "http://127.0.0.1:3782");
        let script = fake.scripts.lock().unwrap()[0].clone();
        assert!(script.starts_with("MONOCODE_HOST_PORT='3782'\n"));
        assert!(script.contains("MONOCODE_HOST_FORCE_UPGRADE='1'\n"));
    }

    #[test]
    fn a_failed_install_keeps_the_raw_output() {
        let fake = Fake {
            fail_bootstrap: true,
            ..Fake::default()
        };
        let job = LocalJob::new();
        let error = prepare(&fake, &job, None, false, None, "Mac").unwrap_err();
        assert_eq!(
            error,
            "The MonoCode Host package for version 0.9.0 is unavailable."
        );
        job.finish(Err(error));
        let view = job.view();
        assert!(view.done);
        assert_eq!(view.step, Step::Download);
        assert!(view.output.unwrap().contains("curl: (22) 404"));
    }

    #[test]
    fn restart_cycles_the_service_and_reconnects() {
        let fake = Fake {
            installed: true,
            running: Mutex::new(Some(3790)),
            accepted: Mutex::new(vec!["saved".into()]),
            ..Fake::default()
        };
        let prepared = restart(&fake, &LocalJob::new(), &record(3790, "saved")).unwrap();
        assert_eq!(prepared.endpoint, "http://127.0.0.1:3790");
        assert_eq!(
            fake.calls(),
            [
                "host connection-info",
                "host service uninstall",
                "host service install --port 3790",
                "rpc environment.describe http://127.0.0.1:3790",
            ]
        );
    }

    #[test]
    fn stop_sharing_turns_off_listeners_and_removes_only_phones() {
        let fake = Fake {
            accepted: Mutex::new(vec!["saved".into()]),
            devices: json!([
                { "id": "desk", "kind": "desktop", "current": true },
                { "id": "phone-1", "kind": "mobile" },
                { "id": "phone-2", "kind": "mobile" },
            ]),
            ..Fake::default()
        };
        assert_eq!(
            stop_sharing(&fake, &LocalJob::new(), &record(3774, "saved")).unwrap(),
            2
        );
        let calls = fake.calls();
        assert_eq!(calls[0], "rpc host.config.set http://127.0.0.1:3774");
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.contains("devices.revoke "))
                .count(),
            2
        );
        assert!(!calls.iter().any(|call| call.starts_with("host ")));
    }

    #[test]
    fn uninstall_removes_the_service_and_keeps_data() {
        let fake = Fake {
            installed: true,
            running: Mutex::new(Some(3774)),
            accepted: Mutex::new(vec!["saved".into()]),
            ..Fake::default()
        };
        let notes = uninstall(&fake, &LocalJob::new(), Some(&record(3774, "saved"))).unwrap();
        assert!(notes.contains("will not start automatically"));
        assert_eq!(
            fake.calls(),
            [
                "rpc devices.revokeSelf http://127.0.0.1:3774",
                "host service uninstall"
            ]
        );
    }

    #[test]
    fn one_job_at_a_time() {
        let host = LocalHost::default();
        let first = LocalJob::new();
        host.begin(first.clone()).unwrap();
        assert_eq!(host.active(), Some(first.view().id));
        assert_eq!(host.begin(LocalJob::new()).unwrap_err(), BUSY);
        first.cancel();
        first.finish(Ok(Finished {
            message: String::new(),
            machine: None,
        }));
        assert_eq!(first.view().error.as_deref(), Some(CANCELLED));
        host.begin(LocalJob::new()).unwrap();
        assert!(host.job(&first.view().id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_runner_follows_progress_and_stops_on_cancel() {
        let job = LocalJob::new();
        let mut command = Command::new("sh");
        command.arg("-s");
        let output = run(
            command,
            Some("echo monocode-step:verify\necho done\necho problem >&2\nexit 3\n".into()),
            Duration::from_secs(10),
            Some(&job),
        )
        .unwrap();
        assert!(!output.ok);
        assert_eq!(job.view().step, Step::Verify);
        assert_eq!(output.reason("x"), "problem");
        let waiting = job.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            waiting.cancel();
        });
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let started = Instant::now();
        assert_eq!(
            run(command, None, Duration::from_secs(30), Some(&job))
                .err()
                .as_deref(),
            Some(CANCELLED)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// The real bootstrap with a local package, in a throwaway home folder.
    /// The packaged "host" only records what it was asked to do.
    #[cfg(unix)]
    #[test]
    fn bootstrap_installs_a_local_development_package() {
        let root =
            std::env::temp_dir().join(format!("monocode-local-host-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let source = root.join("source");
        let packages = root.join("host packages");
        for dir in [&home, &source, &packages] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let events = root.join("events");
        let fake_host = format!(
            "#!/bin/sh\ncase \"$1\" in\n--version) echo {version} ;;\nservice) echo \"$*\" >> {events} ;;\nconnection-info) echo '{{\"port\":3790,\"pid\":1}}' ;;\n*) exit 1 ;;\nesac\n",
            version = env!("CARGO_PKG_VERSION"),
            events = remote_ssh::shell_quote(&events.to_string_lossy()),
        );
        let entry = source.join("monocode-host");
        std::fs::write(&entry, fake_host).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();
        let os = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let file = format!("monocode-host-{os}-{arch}.tar.gz");
        let archive = packages.join(&file);
        assert!(Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&source)
            .arg(".")
            .status()
            .unwrap()
            .success());
        use sha2::Digest;
        let hash = sha2::Sha256::digest(std::fs::read(&archive).unwrap());
        let hex: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
        std::fs::write(
            packages.join(format!("{file}.sha256")),
            format!("{hex}  {file}\n"),
        )
        .unwrap();

        let script = local_script(
            HostPlatform::Unix,
            &ScriptEnv {
                port: 3790,
                upgrade: false,
                archive: Some(&packages.to_string_lossy()),
            },
        );
        let job = LocalJob::new();
        let mut command = Command::new("sh");
        command.arg("-s").env("HOME", &home);
        let output = run(command, Some(script), Duration::from_secs(60), Some(&job)).unwrap();
        assert!(output.ok, "{}", output.combined());
        assert_eq!(parse_connection_info(&output.stdout).unwrap(), 3790);
        assert_eq!(
            output
                .stdout
                .lines()
                .filter_map(Step::from_marker)
                .collect::<Vec<_>>(),
            [Step::Download, Step::Verify, Step::Install, Step::Start]
        );
        assert_eq!(job.view().step, Step::Start);
        assert!(home.join(".monocode-host/bin/monocode-host").is_file());
        assert_eq!(
            std::fs::read_to_string(&events).unwrap().trim(),
            "service install --port 3790"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
