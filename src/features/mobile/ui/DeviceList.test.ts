// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DeviceList } from "./DeviceList";
import type { Device } from "../model/mobile";
import type { RemoteMachine } from "../../connections/model/protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const machine: RemoteMachine = {
  id: "mini",
  name: "mac-mini",
  endpoint: "ssh://me@mini",
  environmentId: "env",
  ssh: { target: "me@mini", remotePort: 3774 },
};
const desktop: Device = {
  id: "desk",
  name: "MonoCode on MacBook",
  kind: "desktop",
  role: "admin",
  status: "active",
  createdAt: Date.UTC(2026, 9, 1),
  current: true,
  push: false,
};
const phone: Device = {
  id: "phone",
  name: "Ege's iPhone",
  kind: "mobile",
  role: "member",
  status: "active",
  platform: "ios",
  model: "iPhone 16 Pro",
  createdAt: Date.UTC(2026, 9, 4),
  lastSeenVia: "direct",
  current: false,
  push: true,
};

let root: Root;
let container: HTMLDivElement;
let devices: Device[];
let calls: { method: string; params: Record<string, unknown> }[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  devices = [desktop, phone];
  calls = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (_command, input) => {
    const { method, params } = input as {
      method: string;
      params: Record<string, unknown>;
    };
    calls.push({ method, params });
    if (method === "devices.list") return devices.map((device) => ({ ...device }));
    if (method === "devices.rename") {
      devices = devices.map((device) =>
        device.id === params.deviceId ? { ...device, name: String(params.name) } : device,
      );
      return devices.find((device) => device.id === params.deviceId);
    }
    if (method === "devices.revoke") {
      devices = devices.filter((device) => device.id !== params.deviceId);
      return { revoked: true };
    }
    if (method === "devices.events")
      return [{ at: Date.UTC(2026, 9, 4), deviceId: "phone", type: "approved" }];
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
  vi.unstubAllGlobals();
});

const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === name,
  );
const called = (method: string) => calls.filter((call) => call.method === method);
async function render() {
  await act(async () =>
    root.render(createElement(DeviceList, { machine, machineName: "mac-mini" })),
  );
}
async function openMenu(name: string) {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`button[aria-label="More for ${name}"]`)!
      .click(),
  );
}

it("lists the machine's phones and desktops", async () => {
  await render();
  expect(container.textContent).toContain("Ege's iPhone");
  expect(container.textContent).toContain("iPhone 16 Pro · paired");
  expect(container.textContent).toContain("never connected");
  expect(container.textContent).toContain("MonoCode on MacBook");
  expect(container.textContent).toContain("this desktop · admin");
});

it("renames a device", async () => {
  await render();
  await openMenu("Ege's iPhone");
  await act(async () => button("Rename")!.click());
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="New name for Ege\'s iPhone"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Work phone",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save")!.click());
  expect(called("devices.rename")[0].params).toEqual({
    deviceId: "phone",
    name: "Work phone",
  });
  expect(container.textContent).toContain("Work phone");
});

it("revokes a phone only after confirmation", async () => {
  await render();
  await openMenu("Ege's iPhone");
  await act(async () => button("Revoke…")!.click());
  expect(container.textContent).toContain(
    "Ege's iPhone will lose access to mac-mini immediately.",
  );
  expect(called("devices.revoke")).toHaveLength(0);
  await act(async () => button("Revoke")!.click());
  expect(called("devices.revoke")[0].params).toEqual({ deviceId: "phone" });
  expect(container.textContent).not.toContain("Ege's iPhone");
  expect(container.textContent).toContain("No phones yet.");
});

it("never offers to revoke this desktop here", async () => {
  await render();
  await openMenu("MonoCode on MacBook");
  expect(button("Rename")).toBeTruthy();
  expect(button("Revoke…")).toBeUndefined();
});

it("shows recent activity on request", async () => {
  await render();
  expect(called("devices.events")).toHaveLength(0);
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(called("devices.events")).toHaveLength(1);
  expect(container.textContent).toContain("Ege's iPhone was allowed");
});
