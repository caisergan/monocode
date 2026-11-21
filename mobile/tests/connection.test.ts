import { describe, expect, it, vi } from "vitest";

// The native link module is absent outside the app.
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
import {
  normalizeSelection,
  selectedWorkspace,
} from "@/features/connection/selection";
import { parseInvitation } from "@/features/connection/invitation";
const catalog = {
  projects: [{ id: "a" }, { id: "b" }],
  monos: [{ id: "m" }, { id: "n" }],
  sessions: [
    { id: "s1", projectId: "a" },
    { id: "s2", projectId: "b" },
    { id: "s3", projectId: "b", monoId: "m" },
  ],
};
describe("mobile workspace choices", () => {
  it("shows the picked projects and monos, with their sessions", () => {
    const selected = selectedWorkspace(catalog, {
      projectIds: ["a"],
      monoIds: ["m"],
    });
    expect(selected.projects).toEqual([{ id: "a" }]);
    expect(selected.monos).toEqual([{ id: "m" }]);
    // A mono's session counts even in a project left out.
    expect(selected.sessions.map((session) => session.id)).toEqual(["s1", "s3"]);
  });
  it("preserves an explicit empty choice on restore", () => {
    const restored = normalizeSelection(
      JSON.parse(JSON.stringify({ projectIds: [], monoIds: [] })),
    );
    expect(restored).toEqual({ projectIds: [], monoIds: [] });
    expect(selectedWorkspace(catalog, restored).projects).toEqual([]);
    expect(normalizeSelection({ projectIds: "all", monoIds: [] })).toBeNull();
  });
  it("retains unavailable choices so they can reappear when a desktop project returns", () => {
    const chosen = normalizeSelection({
      projectIds: ["a", "a", 5, "later"],
      monoIds: ["m"],
    });
    expect(chosen?.projectIds).toEqual(["a", "later"]);
    expect(chosen?.monoIds).toEqual(["m"]);
    expect(
      selectedWorkspace(
        { ...catalog, projects: [...catalog.projects, { id: "later" }] },
        chosen,
      ).projects,
    ).toEqual([{ id: "a" }, { id: "later" }]);
  });
});
const invitation = {
  version: 1,
  name: "Desktop 🖥",
  fingerprint: "a".repeat(64),
  addresses: [{ host: "desktop.example", port: 38416 }],
  identity: { certificate: "certificate", privateKey: "temporary-key" },
  expires: Date.now() / 1000 + 900,
};
function link(value: unknown) {
  return (
    "monocode://pair?i=" +
    Buffer.from(JSON.stringify(value)).toString("base64url")
  );
}
describe("QR invitation", () => {
  it("accepts the one-use desktop scheme and UTF-8 names", () =>
    expect(parseInvitation(link(invitation))).toEqual(invitation));
  it("rejects expired codes, foreign links and invalid endpoints before pairing", () => {
    expect(() => parseInvitation(link({ ...invitation, expires: 1 }))).toThrow(
      "expired",
    );
    expect(() => parseInvitation("https://example.com/?i=abc")).toThrow();
    expect(() =>
      parseInvitation(
        link({ ...invitation, addresses: [{ host: "host", port: 0 }] }),
      ),
    ).toThrow();
    expect(() =>
      parseInvitation(link({ ...invitation, fingerprint: "bad" })),
    ).toThrow();
  });
});

const machine = {
  version: 1,
  kind: "host",
  name: "instance-20261117",
  environmentId: "3779c3c2-6cf7-4506-84d7-9bee2bc38942",
  url: "http://instance-20261117.tailb56a5a.ts.net:3774",
  code: "c".repeat(32),
  expires: Date.now() / 1000 + 900,
};
describe("a machine's QR invitation", () => {
  it("reads where the machine answers and its one-use code", () =>
    expect(parseInvitation(link(machine))).toEqual(machine));
  it("takes HTTPS anywhere but HTTP only inside a tailnet", () => {
    expect(parseInvitation(link({ ...machine, url: "https://box.example.com" }))).toMatchObject({
      kind: "host",
    });
    expect(parseInvitation(link({ ...machine, url: "http://100.110.106.27:3774" }))).toMatchObject({
      kind: "host",
    });
    expect(() => parseInvitation(link({ ...machine, url: "http://192.168.1.9:3774" }))).toThrow();
    expect(() => parseInvitation(link({ ...machine, url: "ftp://box.ts.net" }))).toThrow();
    expect(() => parseInvitation(link({ ...machine, code: "short" }))).toThrow();
    expect(() => parseInvitation(link({ ...machine, expires: 1 }))).toThrow("expired");
  });
});

describe("where a request goes", () => {
  it("pins a desktop by its fingerprint, and sends a machine its credential", async () => {
    const { linkFor, isMachine } = await import("@/features/connection/nativeLink");
    const identity = { certificate: "c", privateKey: "k" };
    const desktop = {
      desktop: {
        name: "Mac",
        fingerprint: "f".repeat(64),
        addresses: [{ host: "mac.local", port: 38416 }],
        deviceId: "d",
      },
      identity,
    };
    expect(linkFor(desktop)).toEqual({
      identity,
      pin: "f".repeat(64),
      addresses: [{ host: "mac.local", port: 38416 }],
    });
    expect(isMachine(desktop)).toBe(false);
    const paired = {
      desktop: {
        name: "box",
        fingerprint: `machine-${machine.environmentId}`,
        addresses: [],
        deviceId: "phone",
        machine: { url: machine.url, environmentId: machine.environmentId },
      },
      token: "t".repeat(43),
    };
    expect(linkFor(paired)).toEqual({ host: { url: machine.url, token: "t".repeat(43) } });
    expect(isMachine(paired)).toBe(true);
  });
});
