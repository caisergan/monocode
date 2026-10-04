import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { revealPath } from "../../../platform/tauri/fs";
import { Modal } from "../../../shared/ui/Modal";
import { Popover } from "../../../shared/ui/Popover";
import {
  Check,
  Internet,
  Loader,
  MoreHorizontal,
} from "../../../shared/ui/icons";
import { playCue } from "../../settings/model/sounds";
import {
  isLocalMachine,
  OPEN_REMOTE_PROJECT_EVENT,
  refreshRemoteMachines,
  remoteRequest,
  useRemoteMachineOnline,
  useRemoteMachines,
} from "../../connections/model/connections";
import {
  REMOTE_PROVIDERS,
  type HostDescriptor,
  type RemoteMachine,
  type SshSetup,
} from "../../connections/model/protocol";
import {
  cancelLocalHost,
  hostBusy,
  hostConfig,
  hostMessage,
  listDevices,
  localHostDoctor,
  localHostState,
  localHostStatus,
  pollLocalHost,
  relayOperator,
  RELAY_CONSENT,
  removeLocalHost,
  restartLocalHost,
  setHostConfig,
  setUpLocalHost,
  setupSteps,
  startLocalHost,
  stepState,
  supportsPairing,
  updateCopy,
  updateLocalHost,
  type DoctorReport,
  type HostConfigView,
  type LocalHostJob,
  type LocalHostStatus,
  type RemoveMode,
} from "../model/mobile";
import { DeviceList } from "./DeviceList";
import { Phone } from "./icons";
import { PairPhoneDialog } from "./PairPhoneDialog";

const button =
  "rounded-lg bg-selection px-3 py-2 text-[13px] font-medium hover:bg-selection-hover disabled:opacity-40";
const item =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-content/80 hover:bg-content/8 hover:text-content";
const errorBox =
  "whitespace-pre-wrap break-words rounded-lg bg-red-500/5 p-3 text-[12px] leading-relaxed text-red-400";
/** Agents may be mid-turn: check again this often before updating. */
const IDLE_RECHECK_MS = 5 * 60_000;

type JobKind = "setup" | "update" | "restart" | RemoveMode;

/** Where Settings search lands: `data-setting-id` is a `SETTINGS_INDEX` id,
 * and Settings scrolls to the element with id `setting-<id>`. */
const anchor = (id: string) => ({ id: `setting-${id}`, "data-setting-id": id });

/** Settings → Mobile (spec 10 §10.3): this computer's host, the phones paired
 * with it, and pairing on the other machines. */
export function MobileSettings() {
  const { machines, loaded } = useRemoteMachines();
  const local = machines.find(isLocalMachine);
  const others = machines.filter((machine) => !isLocalMachine(machine));
  const [pairing, setPairing] = useState<{ machine: RemoteMachine; name: string }>();
  const [paired, setPaired] = useState(0);
  return (
    <div {...anchor("pair-phone")} className="flex flex-col gap-8">
      <ThisComputer
        machine={local}
        onPair={(machine) => setPairing({ machine, name: "this computer" })}
      />
      {/* Every machine's devices; hidden until there is a list to show. */}
      <div {...anchor("mobile-devices")} className="flex flex-col gap-8 empty:hidden">
        {local ? (
          <Section title="Phones and devices on this computer">
            <DeviceList machine={local} machineName="this computer" refresh={paired} />
          </Section>
        ) : null}
        {loaded && others.length ? (
          <Section
            title="Other machines"
            description="Pair a phone with any machine you added in Connections."
          >
            <div className="divide-y divide-stroke overflow-hidden rounded-xl border border-stroke">
              {others.map((machine) => (
                <OtherMachine
                  key={machine.id}
                  machine={machine}
                  refresh={paired}
                  onPair={() => setPairing({ machine, name: machine.name })}
                />
              ))}
            </div>
          </Section>
        ) : null}
      </div>
      {pairing ? (
        <PairPhoneDialog
          machine={pairing.machine}
          machineName={pairing.name}
          onClose={() => setPairing(undefined)}
          onPaired={() => setPaired((value) => value + 1)}
        />
      ) : null}
    </div>
  );
}

function Section({
  id,
  title,
  description,
  action,
  children,
}: {
  /** A `SETTINGS_INDEX` id, when search can land here. */
  id?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section {...(id ? anchor(id) : {})} className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-content">{title}</h2>
          {description ? (
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function StatusDot({ tone, children }: { tone: "on" | "off" | "warn"; children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-content/50">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${
          tone === "on" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-400" : "bg-content/35"
        }`}
      />
      {children}
    </span>
  );
}

function ThisComputer({
  machine,
  onPair,
}: {
  machine?: RemoteMachine;
  onPair: (machine: RemoteMachine) => void;
}) {
  const [status, setStatus] = useState<LocalHostStatus>();
  const [statusError, setStatusError] = useState("");
  const [job, setJob] = useState<LocalHostJob>();
  const [jobId, setJobId] = useState<string>();
  const [jobKind, setJobKind] = useState<JobKind>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReport>();
  const [agentsBusy, setAgentsBusy] = useState<boolean>();
  const [refresh, setRefresh] = useState(0);
  const online = useRemoteMachineOnline(machine?.id);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void localHostStatus()
      .then((next) => {
        if (disposed) return;
        setStatus(next);
        setStatusError("");
        // A setup that kept running while Settings was closed.
        if (next?.jobId) setJobId((current) => current ?? next.jobId!);
      })
      .catch((reason) => {
        if (!disposed) setStatusError(hostMessage(reason));
      });
    return () => {
      disposed = true;
    };
  }, [refresh, online, machine?.id]);

  useEffect(() => {
    if (!jobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await pollLocalHost(jobId);
        if (disposed) return;
        setJob(next);
        if (next.done) {
          setJobId(undefined);
          if (!next.error) {
            setNotice(next.message);
            setJob(undefined);
            setJobKind(undefined);
          }
          refreshRemoteMachines();
          setRefresh((value) => value + 1);
          return;
        }
      } catch (reason) {
        if (disposed) return;
        setError(hostMessage(reason));
        setJobId(undefined);
        setJob(undefined);
        return;
      }
      timer = setTimeout(() => void poll(), 350);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [jobId]);

  const begin = async (kind: JobKind) => {
    if (jobId || busy) return;
    setError("");
    setNotice("");
    setDoctor(undefined);
    setRemoving(false);
    setBusy(true);
    try {
      const id = await (kind === "setup"
        ? setUpLocalHost()
        : kind === "update"
          ? updateLocalHost()
          : kind === "restart"
            ? restartLocalHost()
            : removeLocalHost(kind));
      if (!alive.current) return;
      setJob(undefined);
      setJobKind(kind);
      setJobId(id);
    } catch (reason) {
      if (alive.current) setError(hostMessage(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const state = localHostState(status);
  // A host that differs from this app updates once no agent is working.
  const outdated = state.kind === "updateAvailable" && machine && !jobId;
  const agentsBusyRef = useRef(false);
  useEffect(() => {
    if (!outdated || !machine) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const working = await hostBusy(machine.id).catch(() => true);
      if (disposed) return;
      setAgentsBusy(working);
      if (!working && agentsBusyRef.current) {
        void begin("update");
        return;
      }
      agentsBusyRef.current = working;
      timer = setTimeout(() => void check(), IDLE_RECHECK_MS);
    };
    void check();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [outdated, machine?.id]);

  const working = !!jobId || (!!job && !job.done);
  const version = status?.version ?? status?.appVersion ?? "";
  const chip = working ? (
    <StatusDot tone="warn">{jobKind === "setup" ? "Setting up" : "Working"}</StatusDot>
  ) : state.kind === "running" ? (
      <StatusDot tone="on">Running {state.version ?? ""}</StatusDot>
    ) : state.kind === "updateAvailable" ? (
      <StatusDot tone="warn">Update available</StatusDot>
  ) : state.kind === "stopped" ? (
    <StatusDot tone="off">Stopped</StatusDot>
  ) : state.kind === "notSetUp" ? (
    <StatusDot tone="off">Not set up</StatusDot>
  ) : null;

  return (
    <Section id="this-computer" title="This computer">
      <div className="overflow-hidden rounded-xl border border-stroke">
        <div className="flex items-start gap-3 px-4 py-4">
          <Phone className="size-5 shrink-0 text-content/45" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div className="truncate text-[13px] font-medium">This computer</div>
              {chip}
            </div>
            {statusError ? (
              <p role="alert" className={`mt-3 ${errorBox}`}>
                {statusError}
              </p>
            ) : working || (job && job.error) ? (
              <SetupProgress
                job={job}
                kind={jobKind}
                version={status?.appVersion ?? version}
                onRetry={() => jobKind && void begin(jobKind)}
                onDismiss={() => {
                  setJob(undefined);
                  setJobKind(undefined);
                }}
                onCancel={() => jobId && void cancelLocalHost(jobId).catch(() => {})}
              />
            ) : state.kind === "loading" ? (
              <div className="mt-2 flex items-center gap-2 text-[12px] text-content/45">
                <Loader className="size-3.5 animate-spin" /> Checking this computer…
              </div>
            ) : state.kind === "notSetUp" ? (
              <div className="mt-1 flex flex-col gap-3">
                <p className="text-[12px] leading-relaxed text-content/45">
                  Use this computer from your phone. MonoCode installs a
                  background host on this computer. Projects you open on it can
                  be used from the desktop and from your phone.
                </p>
                <button
                  className={`${button} self-start`}
                  disabled={busy}
                  onClick={() => void begin("setup")}
                >
                  Set up
                </button>
              </div>
            ) : state.kind === "stopped" ? (
              <Stopped
                doctor={doctor}
                onStart={async () => {
                  setError("");
                  setBusy(true);
                  try {
                    await startLocalHost();
                    setRefresh((value) => value + 1);
                    refreshRemoteMachines();
                  } catch (reason) {
                    setError(hostMessage(reason));
                  } finally {
                    setBusy(false);
                  }
                }}
                onDiagnose={async () => {
                  setError("");
                  setBusy(true);
                  try {
                    setDoctor(await localHostDoctor());
                  } catch (reason) {
                    setError(hostMessage(reason));
                  } finally {
                    setBusy(false);
                  }
                }}
                busy={busy}
              />
            ) : machine ? (
              <Running
                machine={machine}
                version={state.kind === "running" ? state.version : status?.version ?? undefined}
                update={
                  state.kind === "updateAvailable"
                    ? { copy: updateCopy(state.version, state.appVersion), waiting: agentsBusy }
                    : undefined
                }
                busy={busy}
                onPair={() => onPair(machine)}
                onJob={(kind) => void begin(kind)}
                onRemove={() => setRemoving(true)}
              />
            ) : null}
          </div>
        </div>
      </div>
      {error ? (
        <p role="alert" className={errorBox}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-[13px] text-emerald-500">
          {notice}
        </p>
      ) : null}
      {removing && status ? (
        <RemoveDialog
          dataDir={status.dataDir}
          onClose={() => setRemoving(false)}
          onRemove={(mode) => void begin(mode)}
        />
      ) : null}
    </Section>
  );
}

function SetupProgress({
  job,
  kind,
  version,
  onRetry,
  onDismiss,
  onCancel,
}: {
  job?: LocalHostJob;
  kind?: JobKind;
  version: string;
  onRetry: () => void;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const listed = (kind === "setup" || kind === "update") && job;
  return (
    <div className="mt-3 flex flex-col gap-3" role="status">
      {listed ? (
        <ol aria-label="Setup steps" className="flex flex-col gap-1.5 text-[12px]">
          {setupSteps(version).map(({ step, label }) => {
            const state = stepState(job, step);
            return (
              <li
                key={step}
                data-state={state}
                className={`flex items-center gap-2 ${
                  state === "pending" ? "text-content/35" : state === "failed" ? "text-red-400" : "text-content/70"
                }`}
              >
                <span className="grid size-3.5 shrink-0 place-items-center">
                  {state === "done" ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : state === "active" ? (
                    <Loader className="size-3.5 animate-spin" />
                  ) : (
                    <span
                      aria-hidden="true"
                      className={`size-1.5 rounded-full ${state === "failed" ? "bg-red-400" : "bg-content/25"}`}
                    />
                  )}
                </span>
                {label}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="flex items-center gap-2 text-[13px]">
          {job?.error ? null : <Loader className="size-4 animate-spin" />}
          {job?.message ?? "Starting…"}
        </div>
      )}
      {job?.error ? (
        <>
          <p role="alert" className={errorBox}>
            {job.error}
          </p>
          {job.output ? (
            <details className="text-[12px] text-content/45">
              <summary className="cursor-pointer">Show output</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-content/5 p-3 font-mono text-[11px] text-content/60">
                {job.output}
              </pre>
            </details>
          ) : null}
          <div className="flex gap-2">
            {kind ? (
              <button className={button} onClick={onRetry}>
                Retry
              </button>
            ) : null}
            <button
              type="button"
              className="px-3 py-2 text-[13px] text-content/50"
              onClick={onDismiss}
            >
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="self-start text-[12px] text-content/50 hover:text-content"
          onClick={onCancel}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

function Running({
  machine,
  version,
  update,
  busy,
  onPair,
  onJob,
  onRemove,
}: {
  machine: RemoteMachine;
  version?: string;
  update?: { copy: string; waiting?: boolean };
  busy: boolean;
  onPair: () => void;
  onJob: (kind: "update" | "restart") => void;
  onRemove: () => void;
}) {
  const [config, setConfig] = useState<HostConfigView>();
  const [configError, setConfigError] = useState("");
  const [saving, setSaving] = useState(false);
  const [consent, setConsent] = useState(false);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let disposed = false;
    void hostConfig(machine.id)
      .then((next) => {
        if (!disposed) setConfig(next);
      })
      .catch((reason) => {
        if (!disposed) setConfigError(hostMessage(reason));
      });
    return () => {
      disposed = true;
    };
  }, [machine.id]);
  const change = async (patch: Parameters<typeof setHostConfig>[1]) => {
    setSaving(true);
    setConfigError("");
    try {
      setConfig(await setHostConfig(machine.id, patch));
    } catch (reason) {
      setConfigError(hostMessage(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-1 flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-content/45">
        MonoCode Host {version} is running.
      </p>
      {update ? (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-content/60">
          <span>{update.copy}</span>
          {update.waiting ? (
            <span className="text-content/45">Will update when agents are idle</span>
          ) : (
            <button
              className={button}
              disabled={busy || update.waiting === undefined}
              title="Updating restarts the host; phones reconnect on their own"
              onClick={() => onJob("update")}
            >
              Update now
            </button>
          )}
        </div>
      ) : null}
      {config ? (
        <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3">
          <ToggleRow
            label="Direct connections on your network"
            description="Phones on the same network or Tailscale connect straight to this computer."
            on={config.direct.mode !== "off"}
            disabled={saving}
            onChange={(on) => void change({ direct: { mode: on ? "private" : "off" } })}
          />
          <ToggleRow
            label="Relay (reach this computer from anywhere)"
            description={relayStatus(config)}
            on={config.relay.enabled}
            disabled={saving}
            onChange={(on) =>
              on ? setConsent(true) : void change({ relay: { enabled: false } })
            }
          />
        </div>
      ) : configError ? null : (
        <div className="flex items-center gap-2 text-[12px] text-content/45">
          <Loader className="size-3.5 animate-spin" /> Loading connection settings…
        </div>
      )}
      {configError ? (
        <p role="alert" className={errorBox}>
          {configError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button className={button} disabled={busy} onClick={onPair}>
          Pair a phone
        </button>
        <button
          className={button}
          disabled={busy}
          onClick={() => window.dispatchEvent(new Event(OPEN_REMOTE_PROJECT_EVENT))}
        >
          Open folder on this computer…
        </button>
        <button
          ref={more}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label="More for this computer’s host"
          className="ml-auto rounded p-2 text-content/40 hover:bg-selection hover:text-content disabled:opacity-40"
          onClick={() => setMenu((open) => !open)}
        >
          <MoreHorizontal className="size-4" />
        </button>
        {menu ? (
          <Popover
            anchor={more}
            align="end"
            width={200}
            onDismiss={() => setMenu(false)}
            role="menu"
            aria-label="This computer’s host"
            className="p-1"
          >
            <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); onJob("update"); }}>
              Update host
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); onJob("restart"); }}>
              Restart host
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); onRemove(); }}>
              Remove host…
            </button>
          </Popover>
        ) : null}
      </div>
      {consent && config ? (
        <Modal title="Use the relay?" size="sm" onClose={() => setConsent(false)}>
          <div className="flex flex-col gap-4 p-4 text-[12px]">
            <p className="leading-relaxed">
              {RELAY_CONSENT} {relayOperator(config.relay.url)}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConsent(false)}
                className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content"
              >
                Not now
              </button>
              <button
                type="button"
                onClick={() => {
                  setConsent(false);
                  void change({ relay: { enabled: true } });
                }}
                className="rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/80"
              >
                Use relay
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function relayStatus(config: HostConfigView): string {
  if (!config.relay.enabled) return "Off until you turn it on.";
  switch (config.relay.status) {
    case "online":
      return "Connected to the relay.";
    case "connecting":
      return "Connecting to the relay…";
    case "unauthorized":
      return "The relay didn’t accept this computer.";
    case "blocked":
      return "This network blocks the relay.";
    default:
      return "Not connected to the relay yet.";
  }
}

function ToggleRow({
  label,
  description,
  on,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  on: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="settings-row flex items-start gap-6 border-b border-content/5 px-4 py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-content">{label}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-content/45">{description}</p>
      </div>
      <div className="settings-row-control flex min-w-0 max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          role="switch"
          aria-label={label}
          aria-checked={on}
          disabled={disabled}
          onClick={() => {
            onChange(!on);
            playCue("switch");
          }}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            on ? "bg-accent" : "bg-content/20"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
              on ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

function Stopped({
  doctor,
  busy,
  onStart,
  onDiagnose,
}: {
  doctor?: DoctorReport;
  busy: boolean;
  onStart: () => void;
  onDiagnose: () => void;
}) {
  return (
    <div className="mt-1 flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-content/45">
        The host isn’t responding.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy} onClick={onStart}>
          Start
        </button>
        <button className={button} disabled={busy} onClick={onDiagnose}>
          Diagnostics
        </button>
      </div>
      {doctor ? (
        <div
          aria-label="Diagnostics"
          className="divide-y divide-stroke overflow-hidden rounded-xl border border-stroke text-[12px]"
        >
          <p className="px-4 py-3 text-content/60">
            {doctor.ok
              ? `MonoCode Host ${doctor.hostVersion}: no problems found.`
              : `MonoCode Host ${doctor.hostVersion}: some checks failed.`}
          </p>
          {doctor.checks.map((check) => (
            <div key={check.id} data-status={check.status} className="flex items-start gap-3 px-4 py-3">
              <span
                aria-label={check.status}
                className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                  check.status === "ok" ? "bg-emerald-400" : check.status === "warn" ? "bg-amber-400" : "bg-red-400"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium capitalize text-content/80">{check.id}</div>
                <div className="mt-0.5 text-content/50">{check.detail}</div>
                {check.fix ? (
                  <code className="mt-1 inline-block rounded bg-content/10 px-1 text-content/60">
                    {check.fix}
                  </code>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RemoveDialog({
  dataDir,
  onClose,
  onRemove,
}: {
  dataDir: string;
  onClose: () => void;
  onRemove: (mode: RemoveMode) => void;
}) {
  const choice =
    "flex flex-col gap-2 rounded-lg border border-content/10 bg-content/3 p-3";
  const action =
    "self-start rounded-md bg-content/8 px-3 py-1.5 text-[12px] font-medium text-content hover:bg-content/12";
  return (
    <Modal title="Remove host" description="This computer" size="sm" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4 text-[12px]">
        <div className={choice}>
          <p className="font-medium text-content">Stop sharing with phones</p>
          <p className="leading-relaxed text-content/55">
            Turns off direct connections and the relay, and removes every
            phone. The host keeps running for this desktop.
          </p>
          <button
            type="button"
            className={action}
            onClick={() => {
              onClose();
              onRemove("stopSharing");
            }}
          >
            Stop sharing
          </button>
        </div>
        <div className={choice}>
          <p className="font-medium text-content">Remove the host from this computer</p>
          <p className="leading-relaxed text-content/55">
            Stops the host and removes its background service. Sessions and
            data stay in <code className="rounded bg-content/10 px-1">{dataDir}</code>{" "}
            until you delete them.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-red-500/20 px-3 py-1.5 text-[12px] font-medium text-red-400 hover:bg-red-500/30"
              onClick={() => {
                onClose();
                onRemove("uninstall");
              }}
            >
              Remove host
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content"
              onClick={() => void revealPath(dataDir).catch(() => {})}
            >
              Show folder
            </button>
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A machine from Connections, with pairing when its host supports it. */
function OtherMachine({
  machine,
  refresh,
  onPair,
}: {
  machine: RemoteMachine;
  refresh: number;
  onPair: () => void;
}) {
  const [descriptor, setDescriptor] = useState<HostDescriptor>();
  const [offline, setOffline] = useState(false);
  const [phones, setPhones] = useState<number>();
  const [open, setOpen] = useState(false);
  const [update, setUpdate] = useState<SshSetup>();
  const [updateError, setUpdateError] = useState("");
  const [answer, setAnswer] = useState("");
  const [checked, setChecked] = useState(0);
  useEffect(() => {
    let disposed = false;
    void remoteRequest<HostDescriptor>(machine.id, "environment.describe", {
      supportedProviders: REMOTE_PROVIDERS,
    })
      .then((next) => {
        if (disposed) return;
        setDescriptor(next);
        setOffline(false);
        if (supportsPairing(next))
          void listDevices(machine.id)
            .then((devices) => {
              if (!disposed)
                setPhones(devices.filter((device) => device.kind === "mobile").length);
            })
            .catch(() => {});
      })
      .catch(() => {
        if (!disposed) setOffline(true);
      });
    return () => {
      disposed = true;
    };
  }, [machine.id, refresh, checked]);

  const updating = !!update && !update.done;
  const activeUpdate = useRef<string | undefined>(undefined);
  activeUpdate.current = updating ? update?.id : undefined;
  // Leaving Settings cancels an update in progress, as Connections does.
  useEffect(
    () => () => {
      if (activeUpdate.current)
        void invoke("remote_ssh_cancel", { jobId: activeUpdate.current }).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!update || update.done) return;
    const timer = setTimeout(() => {
      void invoke<SshSetup>("remote_ssh_poll", { jobId: update.id })
        .then((next) => {
          setUpdate(next);
          if (next.done) {
            if (next.error) setUpdateError(next.error);
            setChecked((value) => value + 1);
            refreshRemoteMachines();
          }
        })
        .catch((reason) => {
          setUpdateError(hostMessage(reason));
          setUpdate(undefined);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [update]);

  const pairable = supportsPairing(descriptor);
  const ssh = machine.ssh;
  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-4">
        <Internet className="size-5 shrink-0 text-content/45" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{machine.name}</div>
          <div className="mt-1 truncate text-[12px] text-content/45">
            {ssh ? `SSH · ${ssh.target}` : machine.endpoint}
          </div>
        </div>
        {offline ? (
          <StatusDot tone="off">Offline</StatusDot>
        ) : descriptor ? (
          <StatusDot tone="on">
            Online{descriptor.hostVersion ? ` ${descriptor.hostVersion}` : ""}
          </StatusDot>
        ) : (
          <StatusDot tone="off">Checking connection…</StatusDot>
        )}
      </div>
      {descriptor ? (
        <div className="flex flex-col gap-3 px-4 pb-4">
          {pairable ? (
            <div className="flex flex-wrap items-center gap-3">
              <button className={button} onClick={onPair}>
                Pair a phone
              </button>
              {phones !== undefined ? (
                <button
                  type="button"
                  aria-expanded={open}
                  className="text-[12px] text-content/50 hover:text-content"
                  onClick={() => setOpen((value) => !value)}
                >
                  {phones === 1 ? "1 phone" : `${phones} phones`}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-[12px] text-content/60">
              <span>Update the host to pair phones.</span>
              {ssh ? (
                <button
                  className={button}
                  disabled={updating}
                  title="Downloads the matching host package and restarts the host; active agent turns will be interrupted"
                  onClick={() => {
                    setUpdateError("");
                    void invoke<string>("remote_ssh_reconnect", {
                      machineId: machine.id,
                      upgrade: true,
                    })
                      .then((id) =>
                        setUpdate({ id, message: "Updating MonoCode Host…", done: false }),
                      )
                      .catch((reason) => setUpdateError(hostMessage(reason)));
                  }}
                >
                  Update Host
                </button>
              ) : (
                <span className="text-content/45">
                  On that machine, install the host from this MonoCode release,
                  then restart it.
                </span>
              )}
            </div>
          )}
          {updating && update ? (
            <div className="flex flex-col gap-3" role="status">
              <div className="flex items-center gap-2 text-[12px] text-content/60">
                <Loader className="size-3.5 animate-spin" />
                {update.message}
              </div>
              {update.prompt ? (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const prompt = update.prompt!;
                    void invoke("remote_ssh_answer", {
                      jobId: update.id,
                      promptId: prompt.id,
                      answer: prompt.confirm ? "yes" : answer,
                    })
                      .then(() => setAnswer(""))
                      .catch((reason) => setUpdateError(hostMessage(reason)));
                  }}
                >
                  <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-content/70">
                    {update.prompt.message}
                  </p>
                  {update.prompt.confirm ? null : (
                    <input
                      key={update.prompt.id}
                      autoFocus
                      type="password"
                      aria-label="SSH password or passphrase"
                      autoComplete="off"
                      className="w-full rounded-lg border border-content/15 bg-content/3 px-3 py-2 text-[13px] outline-none focus:border-content/35"
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                    />
                  )}
                  <button className={`${button} self-start`}>
                    {update.prompt.confirm ? "Trust host and continue" : "Continue"}
                  </button>
                </form>
              ) : null}
              <button
                type="button"
                className="self-start text-[12px] text-content/50 hover:text-content"
                onClick={() =>
                  void invoke("remote_ssh_cancel", { jobId: update.id }).catch(() => {})
                }
              >
                Cancel update
              </button>
            </div>
          ) : null}
          {updateError ? (
            <p role="alert" className={errorBox}>
              {updateError}
            </p>
          ) : null}
          {open && pairable ? (
            <DeviceList
              machine={machine}
              machineName={machine.name}
              refresh={refresh}
              onDevices={(devices) =>
                setPhones(devices.filter((device) => device.kind === "mobile").length)
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
