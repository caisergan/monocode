// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MobileSettings } from "./MobileSettings";
import type {
  Device,
  HostConfigView,
  LocalHostJob,
  LocalHostStatus,
} from "../model/mobile";
import type { ManagedMachine } from "../../connections/model/connections";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const local: ManagedMachine = {
  id: "local",
  name: "This computer",
  endpoint: "http://127.0.0.1:3774",
  environmentId: "local-env",
  ssh: null,
  local: true,
};
const mini: ManagedMachine = {
  id: "mini",
  name: "mac-mini",
  endpoint: "ssh://me@mini",
  environmentId: "mini-env",
  ssh: { target: "me@mini", remotePort: 3774 },
};
const box: ManagedMachine = {
  id: "box",
  name: "build-box",
  endpoint: "https://box.example.com",
  environmentId: "box-env",
  ssh: null,
};
const phone: Device = {
  id: "phone",
  name: "Ege's iPhone",
  kind: "mobile",
  role: "member",
  status: "active",
  platform: "ios",
  createdAt: Date.UTC(2026, 9, 4),
  current: false,
  push: true,
};

let root: Root;
let container: HTMLDivElement;
let machines: ManagedMachine[];
let status: LocalHostStatus;
let job: LocalHostJob;
let config: HostConfigView;
let capabilities: Record<string, string[]>;
let running: boolean;
let calls: { command: string; input: Record<string, unknown> }[];

const runningStatus = (patch: Partial<LocalHostStatus> = {}): LocalHostStatus => ({
  installed: true,
  running: true,
  version: "0.9.0",
  port: 3774,
  machineId: "local",
  appVersion: "0.9.0",
  dataDir: "/Users/me/.monocode-host",
  ...patch,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  localStorage.clear();
  machines = [];
  status = runningStatus({ installed: false, running: false, version: null, machineId: null });
  job = { id: "job", message: "Downloading MonoCode Host…", step: "download", done: false };
  config = {
    relay: { enabled: false, url: "wss://relay.usemono.dev", status: "disabled" },
    direct: { mode: "private", port: 3775, listening: ["192.168.1.20"], advertise: [] },
    push: { enabled: true, allowPrivateGateways: false },
    pairing: { requireConfirmation: true, linkBase: "monocode-dev://pair" },
  };
  capabilities = { local: ["host.config", "presence"], mini: ["host.config"], box: [] };
  running = false;
  calls = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, raw) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    calls.push({ command, input });
    switch (command) {
      case "remote_machines":
        return machines.map((machine) => ({ ...machine }));
      case "local_host_status":
        return { ...status };
      case "local_host_setup":
      case "local_host_update":
      case "local_host_restart":
      case "local_host_remove":
        return "job";
      case "local_host_poll":
        return { ...job };
      case "local_host_start":
      case "local_host_cancel":
      case "reveal_path":
        return undefined;
      case "local_host_doctor":
        return {
          v: 1,
          hostVersion: "0.9.0",
          ok: false,
          checks: [
            {
              id: "host",
              status: "fail",
              detail: "running.json exists, but the host didn't answer: timed out",
              fix: "Run monocode-host stop, then monocode-host start",
            },
            { id: "disk", status: "ok", detail: "40.0 GiB free", fix: null },
          ],
        };
      case "remote_ssh_reconnect":
        return "ssh-job";
      case "remote_ssh_poll":
        return { id: "ssh-job", message: "Updating MonoCode Host on the machine…", done: false };
    }
    if (command !== "remote_request") throw new Error(`Unexpected ${command}`);
    const machineId = String(input.machineId);
    const method = String(input.method);
    const params = (input.params ?? {}) as Record<string, unknown>;
    if (method === "environment.describe")
      return {
        protocolVersion: 1,
        environmentId: machines.find((machine) => machine.id === machineId)?.environmentId,
        name: machineId,
        providers: ["codex"],
        capabilities: capabilities[machineId] ?? [],
        hostVersion: "0.9.0",
      };
    if (method === "devices.list")
      return [
        { ...phone, id: "desk", name: "MonoCode on MacBook", kind: "desktop", role: "admin", current: true },
        phone,
      ];
    if (method === "host.config.get") return config;
    if (method === "host.config.set") {
      const patch = params as { relay?: { enabled: boolean }; direct?: { mode: "off" | "private" } };
      config = {
        ...config,
        relay: { ...config.relay, ...patch.relay },
        direct: { ...config.direct, ...patch.direct },
      };
      return config;
    }
    if (method === "projects.list") return [{ id: "project", cwd: "/repo", name: "repo" }];
    if (method === "sessions.list") return [{ id: "s", status: running ? "running" : "idle" }];
    throw new Error(`Unexpected ${method}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === name,
  );
const toggle = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)!;
const invoked = (command: string) => calls.filter((call) => call.command === command);
const requested = (method: string) =>
  calls
    .filter((call) => call.command === "remote_request" && call.input.method === method)
    .map((call) => call.input.params);
async function render() {
  await act(async () => root.render(createElement(MobileSettings)));
  await wait(0);
}
async function wait(ms = 400) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("sets up this computer with a live step list", async () => {
  await render();
  expect(container.textContent).toContain(
    "Use this computer from your phone. MonoCode installs a background host on this computer.",
  );
  await act(async () => button("Set up")!.click());
  await wait(0);
  expect(invoked("local_host_setup")).toHaveLength(1);
  const steps = () =>
    [...container.querySelectorAll("li[data-state]")].map((item) => [
      item.textContent,
      item.getAttribute("data-state"),
    ]);
  expect(steps()[0]).toEqual(["Download host 0.9.0", "active"]);
  job = { ...job, step: "install", message: "Installing the background service…" };
  await wait();
  expect(steps().slice(0, 4)).toEqual([
    ["Download host 0.9.0", "done"],
    ["Verify checksum", "done"],
    ["Install background service", "active"],
    ["Start", "pending"],
  ]);
  machines = [local];
  status = runningStatus();
  job = { ...job, step: "done", done: true, message: "This computer is ready.", machine: local };
  await wait();
  await wait(0);
  expect(container.textContent).toContain("This computer is ready.");
  expect(container.textContent).toContain("MonoCode Host 0.9.0 is running.");
  expect(container.textContent).toContain("Running 0.9.0");
});

it("shows a failed step's error and output, and retries", async () => {
  job = {
    ...job,
    done: true,
    error: "The MonoCode Host package for version 0.9.0 is unavailable.",
    output: "curl: (22) The requested URL returned error: 404",
  };
  await render();
  await act(async () => button("Set up")!.click());
  await wait(0);
  expect(container.querySelector('li[data-state="failed"]')?.textContent).toBe(
    "Download host 0.9.0",
  );
  expect(container.textContent).toContain(
    "The MonoCode Host package for version 0.9.0 is unavailable.",
  );
  expect(container.querySelector("details pre")?.textContent).toContain("404");
  await act(async () => button("Retry")!.click());
  expect(invoked("local_host_setup")).toHaveLength(2);
});

it("turns direct connections and the relay on and off, asking before the relay", async () => {
  machines = [local];
  status = runningStatus();
  await render();
  expect(toggle("Direct connections on your network").getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle("Direct connections on your network").click());
  expect(requested("host.config.set")).toEqual([{ direct: { mode: "off" } }]);

  const relay = "Relay (reach this computer from anywhere)";
  await act(async () => toggle(relay).click());
  expect(document.body.textContent).toContain("Use the relay?");
  expect(document.body.textContent).toContain(
    "the relay sees only when you connect and how much data moves, never your code or messages.",
  );
  expect(document.body.textContent).toContain("The relay is run by the MonoCode project.");
  await act(async () => button("Not now")!.click());
  expect(requested("host.config.set")).toHaveLength(1);
  await act(async () => toggle(relay).click());
  await act(async () => button("Use relay")!.click());
  expect(requested("host.config.set")[1]).toEqual({ relay: { enabled: true } });
  expect(toggle(relay).getAttribute("aria-checked")).toBe("true");
});

it("lists the phones paired with this computer", async () => {
  machines = [local];
  status = runningStatus();
  await render();
  expect(container.textContent).toContain("Phones and devices on this computer");
  expect(container.textContent).toContain("Ege's iPhone");
  expect(container.textContent).toContain("this desktop · admin");
  await act(async () => button("Pair a phone")!.click());
  await wait(0);
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
    "With this computer",
  );
});

it("updates an older host at once when agents are idle", async () => {
  machines = [local];
  status = runningStatus({ version: "0.8.2" });
  await render();
  expect(container.textContent).toContain("Host 0.8.2 is older than this app (0.9.0).");
  await act(async () => button("Update now")!.click());
  expect(invoked("local_host_update")).toHaveLength(1);
});

it("waits for running agents before updating", async () => {
  machines = [local];
  status = runningStatus({ version: "0.8.2" });
  running = true;
  await render();
  expect(container.textContent).toContain("Will update when agents are idle");
  expect(button("Update now")).toBeUndefined();
  running = false;
  await wait(5 * 60_000);
  expect(invoked("local_host_update")).toHaveLength(1);
});

it("starts a stopped host and runs diagnostics", async () => {
  machines = [local];
  status = runningStatus({ running: false });
  await render();
  expect(container.textContent).toContain("The host isn’t responding.");
  await act(async () => button("Diagnostics")!.click());
  expect(invoked("local_host_doctor")).toHaveLength(1);
  expect(container.textContent).toContain("some checks failed");
  expect(container.textContent).toContain("Run monocode-host stop, then monocode-host start");
  expect(container.querySelector('[data-status="fail"]')).not.toBeNull();
  await act(async () => button("Start")!.click());
  expect(invoked("local_host_start")).toHaveLength(1);
});

it("restarts, and removes the host in either mode", async () => {
  machines = [local];
  status = runningStatus();
  await render();
  const more = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="More for this computer’s host"]')!;
  await act(async () => more().click());
  await act(async () => button("Restart host")!.click());
  expect(invoked("local_host_restart")).toHaveLength(1);
  job = { ...job, done: true, step: "done", message: "MonoCode Host restarted." };
  await wait();
  await act(async () => more().click());
  await act(async () => button("Remove host…")!.click());
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Stop sharing with phones");
  expect(dialog.textContent).toContain("Remove the host from this computer");
  expect(dialog.textContent).toContain("/Users/me/.monocode-host");
  await act(async () => button("Show folder")!.click());
  expect(invoked("reveal_path")[0].input).toEqual({ path: "/Users/me/.monocode-host" });
  await act(async () => button("Stop sharing")!.click());
  expect(invoked("local_host_remove")[0].input).toEqual({ mode: "stopSharing" });
});

it("pairs phones with other machines, or asks for a host update", async () => {
  capabilities.box = [];
  const old: ManagedMachine = { ...mini, id: "old", name: "old-mac", environmentId: "old-env" };
  machines = [local, mini, box, old];
  status = runningStatus();
  await render();
  await wait(0);
  const rows = [...container.querySelectorAll("section")].find((section) =>
    section.textContent?.startsWith("Other machines"),
  )!;
  expect(rows.textContent).toContain("mac-mini");
  expect(rows.textContent).toContain("Online 0.9.0");
  expect(rows.textContent).toContain("1 phone");
  expect(rows.textContent).toContain("build-box");
  expect(rows.textContent).toContain("Update the host to pair phones.");
  expect(rows.textContent).toContain("install the host from this MonoCode release");
  const update = [...rows.querySelectorAll("button")].find(
    (element) => element.textContent === "Update Host",
  )!;
  await act(async () => update.click());
  expect(invoked("remote_ssh_reconnect")[0].input).toEqual({ machineId: "old", upgrade: true });
  const pair = [...rows.querySelectorAll("button")].find(
    (element) => element.textContent === "Pair a phone",
  )!;
  await act(async () => pair.click());
  await wait(0);
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
    "With mac-mini",
  );
});
