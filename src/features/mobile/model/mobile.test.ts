// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  compareVersions,
  createPairing,
  deviceDetail,
  eventLabel,
  formatCode,
  formatCountdown,
  hostBusy,
  hostMessage,
  localHostState,
  pairOptionsSeen,
  reachableThrough,
  relayOperator,
  rememberPairOptions,
  removeLocalHost,
  setupSteps,
  stepState,
  supportsPairing,
  updateCopy,
  type Device,
  type LocalHostJob,
  type LocalHostStatus,
} from "./mobile";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockReset();
});
afterEach(() => localStorage.clear());

const status = (patch: Partial<LocalHostStatus> = {}): LocalHostStatus => ({
  installed: true,
  running: true,
  version: "0.9.0",
  port: 3774,
  machineId: "local",
  appVersion: "0.9.0",
  dataDir: "/Users/me/.monocode-host",
  ...patch,
});

it("maps the host's status to the This computer states", () => {
  expect(localHostState(undefined).kind).toBe("loading");
  expect(localHostState(status({ machineId: null })).kind).toBe("notSetUp");
  // A host another desktop set up is still offered to this one.
  expect(localHostState(status({ machineId: null, running: true })).kind).toBe(
    "notSetUp",
  );
  expect(localHostState(status({ running: false })).kind).toBe("stopped");
  expect(
    localHostState(status({ installed: false, running: false })).kind,
  ).toBe("notSetUp");
  expect(localHostState(status())).toEqual({ kind: "running", version: "0.9.0" });
  expect(localHostState(status({ version: "0.8.2" }))).toEqual({
    kind: "updateAvailable",
    version: "0.8.2",
    appVersion: "0.9.0",
  });
});

it("compares host and app versions", () => {
  expect(compareVersions("0.8.2", "0.9.0")).toBe(-1);
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  expect(updateCopy("0.8.2", "0.9.0")).toBe(
    "Host 0.8.2 is older than this app (0.9.0).",
  );
  expect(updateCopy("1.0.0", "0.9.0")).toContain("newer");
});

it("shows each setup step's progress, and where it failed", () => {
  const job = (patch: Partial<LocalHostJob>): LocalHostJob => ({
    id: "job",
    message: "",
    step: "verify",
    done: false,
    ...patch,
  });
  const states = (value: LocalHostJob) =>
    setupSteps("0.9.0").map(({ step }) => stepState(value, step));
  expect(setupSteps("0.9.0")[0].label).toBe("Download host 0.9.0");
  expect(states(job({}))).toEqual([
    "done",
    "active",
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  expect(states(job({ done: true, error: "checksum mismatch" }))[1]).toBe(
    "failed",
  );
  expect(states(job({ step: "done", done: true }))).toEqual(
    Array(6).fill("done"),
  );
});

it("knows which hosts can pair phones", () => {
  const descriptor = (capabilities: string[]) => ({
    protocolVersion: 1 as const,
    environmentId: "env",
    name: "host",
    providers: [],
    capabilities,
  });
  expect(supportsPairing(descriptor(["sessions"]))).toBe(false);
  expect(supportsPairing(descriptor(["pairing"]))).toBe(true);
  // Hosts that registered pairing before listing it over HTTP.
  expect(supportsPairing(descriptor(["host.config", "presence"]))).toBe(true);
  expect(supportsPairing(undefined)).toBe(false);
});

it("names who operates the relay", () => {
  expect(relayOperator("wss://relay.usemono.dev")).toBe(
    "The relay is run by the MonoCode project.",
  );
  expect(relayOperator("wss://relay.example.com/room")).toBe(
    "This relay is run by whoever operates relay.example.com.",
  );
});

it("formats pairing details as the phone shows them", () => {
  expect(formatCode("482913")).toBe("482 913");
  expect(formatCountdown(9 * 60_000 + 42_000)).toBe("9:42");
  expect(formatCountdown(-5)).toBe("0:00");
  expect(
    reachableThrough({ lan: true, tailscale: true, manual: false, relay: true }),
  ).toBe("local network · Tailscale · relay");
  expect(
    reachableThrough({ lan: false, tailscale: false, manual: false, relay: false }),
  ).toBe("");
  expect(hostMessage("Host rejected request: This code expired.")).toBe(
    "This code expired.",
  );
});

it("describes devices for the list", () => {
  const now = Date.UTC(2026, 9, 4, 12);
  const phone: Device = {
    id: "phone",
    name: "Ege's iPhone",
    kind: "mobile",
    role: "member",
    status: "active",
    platform: "ios",
    model: "iPhone 16 Pro",
    createdAt: now - 86_400_000,
    lastSeenAt: now - 2 * 60_000,
    lastSeenVia: "relay",
    current: false,
    push: true,
  };
  expect(deviceDetail(phone, now)).toMatch(
    /^iPhone 16 Pro · paired .+ · last seen 2 min ago \(relay\)$/,
  );
  expect(deviceDetail({ ...phone, lastSeenAt: undefined }, now)).toContain(
    "never connected",
  );
  expect(deviceDetail({ ...phone, status: "pending" }, now)).toBe(
    "Waiting for approval",
  );
  expect(
    deviceDetail({ ...phone, kind: "desktop", role: "admin", current: true }, now),
  ).toBe("this desktop · admin");
  expect(
    eventLabel({ at: now, deviceId: "phone", type: "revoked" }, [phone]),
  ).toBe("Ege's iPhone was removed");
});

it("shows the pairing options once per machine", () => {
  expect(pairOptionsSeen("env")).toBe(false);
  rememberPairOptions("env");
  rememberPairOptions("env");
  expect(pairOptionsSeen("env")).toBe(true);
  expect(pairOptionsSeen("other")).toBe(false);
});

it("sends this desktop's look with a new pairing code", async () => {
  vi.mocked(invoke).mockResolvedValue({ offerId: "o" });
  await createPairing("machine");
  expect(invoke).toHaveBeenCalledWith("remote_request", {
    machineId: "machine",
    method: "pairing.create",
    params: {
      ui: {
        theme: expect.any(String),
        hue: expect.any(Number),
        sat: expect.any(Number),
        dark: expect.any(Number),
        accent: null,
      },
    },
  });
});

it("routes removal modes to the native job", async () => {
  vi.mocked(invoke).mockResolvedValue("job");
  await removeLocalHost("stopSharing");
  expect(invoke).toHaveBeenCalledWith("local_host_remove", {
    mode: "stopSharing",
  });
});

it("waits for idle agents across every project before updating", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, input) => {
    const { method, params } = input as {
      method: string;
      params: { projectId?: string };
    };
    if (method === "projects.list")
      return [
        { id: "a", cwd: "/a", name: "a" },
        { id: "b", cwd: "/b", name: "b" },
      ];
    return params.projectId === "b"
      ? [{ id: "s", status: "running" }]
      : [{ id: "t", status: "idle" }];
  });
  expect(await hostBusy("machine")).toBe(true);
});
