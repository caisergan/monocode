// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../../../platform/tauri/clipboard";
import { AUTO_RENEWALS, PairPhoneDialog } from "./PairPhoneDialog";
import { rememberPairOptions, type PairingStatus } from "../model/mobile";
import type { RemoteMachine } from "../../connections/model/protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../platform/tauri/clipboard", () => ({
  copyText: vi.fn(async () => {}),
}));

const machine: RemoteMachine = {
  id: "local",
  name: "This computer",
  endpoint: "http://127.0.0.1:3774",
  environmentId: "env",
};
const phone = { id: "phone", name: "Ege's iPhone", platform: "ios", model: "iPhone 16 Pro" };

let root: Root;
let container: HTMLDivElement;
let offers: number;
/** What `pairing.status` answers next for the current offer. */
let statuses: (Partial<PairingStatus> | string)[];
let calls: { method: string; params: Record<string, unknown> }[];
let onClose: ReturnType<typeof vi.fn>;
let onPaired: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  localStorage.clear();
  offers = 0;
  statuses = [];
  calls = [];
  onClose = vi.fn(() => act(() => root.unmount()));
  onPaired = vi.fn();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    if (command !== "remote_request") throw new Error(`Unexpected ${command}`);
    const { method, params } = input as {
      method: string;
      params: Record<string, unknown>;
    };
    calls.push({ method, params });
    const status = (patch: Partial<PairingStatus>): PairingStatus => ({
      offerId: `offer-${offers}`,
      status: "open",
      expiresAt: Date.now() + 600_000,
      ...patch,
    });
    if (method === "host.config.get")
      return {
        relay: { enabled: false, url: "wss://relay.usemono.dev", status: "disabled" },
        direct: { mode: "private", port: 3775, listening: ["192.168.1.20"], advertise: [] },
        push: { enabled: true, allowPrivateGateways: false },
        pairing: { requireConfirmation: true, linkBase: "monocode-dev://pair" },
      };
    if (method === "host.config.set") return {};
    if (method === "pairing.create") {
      offers++;
      return {
        offerId: `offer-${offers}`,
        url: `monocode-dev://pair#o=offer-${offers}`,
        expiresAt: Date.now() + 600_000,
        fingerprint: "7G2K-9QXM-4TNB-WR8C-D1PZ",
        reachable: { lan: true, tailscale: true, manual: false, relay: false },
      };
    }
    if (method === "pairing.status") {
      const next = statuses.shift() ?? {};
      if (typeof next === "string") throw next;
      return status(next);
    }
    if (method === "pairing.decide")
      return status({ status: params.allow ? "approved" : "denied", device: phone });
    if (method === "pairing.cancel") return status({ status: "cancelled" });
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
const called = (method: string) => calls.filter((call) => call.method === method);
async function render() {
  await act(async () =>
    root.render(
      createElement(PairPhoneDialog, {
        machine,
        machineName: "this computer",
        onClose,
        onPaired,
      }),
    ),
  );
  await tick(0);
}
async function tick(ms = 1_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("asks how the phone connects once, with the relay's consent, then shows the code", async () => {
  await render();
  expect(document.body.textContent).toContain(
    "How should your phone reach this computer?",
  );
  expect(called("pairing.create")).toHaveLength(0);
  const relay = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1];
  await act(async () => relay.click());
  expect(document.body.textContent).toContain("end-to-end encrypted");
  expect(document.body.textContent).toContain(
    "The relay is run by the MonoCode project.",
  );
  await act(async () => button("Continue")!.click());
  await tick(0);
  expect(called("host.config.set")[0].params).toEqual({ relay: { enabled: true } });
  expect(called("pairing.create")).toHaveLength(1);
  const qr = document.body.querySelector('svg[aria-label="Pairing code"]')!;
  expect(qr.getAttribute("class")).toContain("size-[280px]");
  expect(qr.querySelector("path")!.getAttribute("d")!.length).toBeGreaterThan(100);
  expect(document.body.textContent).toContain("7G2K-9QXM-4TNB-WR8C-D1PZ");
  expect(document.body.textContent).toContain("Expires in 10:00");
  expect(document.body.textContent).toContain(
    "Reachable through: local network · Tailscale.",
  );
  expect(document.body.textContent).toContain(
    "Anyone who scans this code can ask for access. Keep it private.",
  );
  await act(async () => button("Copy link")!.click());
  expect(copyText).toHaveBeenCalledWith("monocode-dev://pair#o=offer-1");
  expect(button("Copied")).toBeTruthy();
  await tick(1_000);
  expect(document.body.textContent).toContain("Expires in 9:59");

  // The next time, the code appears straight away.
  act(() => root.unmount());
  root = createRoot(container);
  calls = [];
  await render();
  expect(called("host.config.get")).toHaveLength(0);
  expect(called("pairing.create")).toHaveLength(1);
});

it("confirms the code the phone shows, then allows it", async () => {
  rememberPairOptions("env");
  statuses = [{}, { status: "claimed", device: phone, code: "482913" }];
  await render();
  await tick();
  expect(document.body.textContent).toContain("Waiting for your phone…");
  await tick();
  expect(document.body.textContent).toContain(
    "Ege's iPhone (iPhone 16 Pro, ios) wants to connect to this computer.",
  );
  expect(document.body.textContent).toContain("Check that your phone shows 482 913.");
  expect(called("pairing.decide")).toHaveLength(0);
  await act(async () => button("Allow")!.click());
  expect(called("pairing.decide")[0].params).toEqual({ offerId: "offer-1", allow: true });
  expect(document.body.textContent).toContain("Ege's iPhone can now use this computer.");
  expect(onPaired).toHaveBeenCalledTimes(1);
  await act(async () => button("Done")!.click());
  expect(onClose).toHaveBeenCalled();
  // An approved code is not cancelled on close.
  expect(called("pairing.cancel")).toHaveLength(0);
});

it("denies a phone and offers a new code", async () => {
  rememberPairOptions("env");
  statuses = [{ status: "claimed", device: phone, code: "482913" }];
  await render();
  await tick();
  await act(async () => button("Deny")!.click());
  expect(called("pairing.decide")[0].params.allow).toBe(false);
  expect(document.body.textContent).toContain("Denied. The phone was not paired.");
  await act(async () => button("Generate new code")!.click());
  await tick(0);
  expect(called("pairing.create")).toHaveLength(2);
});

it(`renews a code that expires while open ${AUTO_RENEWALS} times, then asks`, async () => {
  rememberPairOptions("env");
  statuses = Array.from({ length: 10 }, () => ({ status: "expired" as const }));
  await render();
  for (let i = 0; i < AUTO_RENEWALS + 1; i++) await tick();
  expect(called("pairing.create")).toHaveLength(AUTO_RENEWALS + 1);
  expect(document.body.textContent).toContain("Code expired");
  await tick(5_000);
  expect(called("pairing.create")).toHaveLength(AUTO_RENEWALS + 1);
  await act(async () => button("Generate new code")!.click());
  await tick(0);
  expect(called("pairing.create")).toHaveLength(AUTO_RENEWALS + 2);
});

it("says when nobody decided in time", async () => {
  rememberPairOptions("env");
  statuses = [{ status: "claimed", device: phone, code: "482913" }, { status: "expired" }];
  await render();
  await tick();
  await tick();
  expect(document.body.textContent).toContain("Request expired");
  expect(called("pairing.create")).toHaveLength(1);
});

it("replaces a code a restarted host forgot, and stops after repeated failures", async () => {
  rememberPairOptions("env");
  statuses = ["Host rejected request: This code expired. Generate a new one."];
  await render();
  await tick();
  expect(called("pairing.create")).toHaveLength(2);
  statuses = Array.from({ length: 5 }, () => "Machine is unreachable. Check the host and SSH tunnel, then reconnect.");
  for (let i = 0; i < 5; i++) await tick();
  expect(document.body.textContent).toContain("Machine is unreachable.");
  expect(button("Try again")).toBeTruthy();
});

it("cancels the open code when the dialog closes", async () => {
  rememberPairOptions("env");
  await render();
  await tick();
  await act(async () =>
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
  );
  expect(onClose).toHaveBeenCalled();
  expect(called("pairing.cancel")[0].params).toEqual({ offerId: "offer-1" });
  const polls = called("pairing.status").length;
  await tick(3_000);
  expect(called("pairing.status")).toHaveLength(polls);
});
