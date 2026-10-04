// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ProjectRail } from "./ProjectRail";
import { rememberRemoteProject } from "../../features/connections/model/remoteProjects";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: (path: string) => path,
}));
vi.mock("../../features/source-control/hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: vi.fn(() => null),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    if (command === "remote_machines")
      return [
        { id: "mini", name: "mac-mini", endpoint: "ssh://mini", environmentId: "mini-env" },
        {
          id: "local",
          name: "This computer",
          endpoint: "http://127.0.0.1:3774",
          environmentId: "local-env",
          local: true,
        },
      ];
    if (command === "remote_request") {
      const { machineId } = input as { machineId: string };
      return { protocolVersion: 1, environmentId: `${machineId}-env`, capabilities: [] };
    }
    return null;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("marks projects on This computer with a phone badge instead of the globe", async () => {
  const onPhone = rememberRemoteProject("local-env", { id: "a", name: "app", cwd: "/Users/me/app" });
  const remote = rememberRemoteProject("mini-env", { id: "b", name: "api", cwd: "/home/me/api" });
  await act(async () =>
    root.render(
      createElement(ProjectRail, {
        cwd: "~",
        recents: [
          { path: onPhone.key, openedAt: 2 },
          { path: remote.key, openedAt: 1 },
        ],
        onSelectProject: vi.fn(),
        onOpenProject: vi.fn(),
        onSelectChat: vi.fn(),
        chats: [],
      }),
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const badges = [...container.querySelectorAll<HTMLElement>('span[role="img"]')].filter(
    (badge) => badge.querySelector("svg"),
  );
  const local = badges.find((badge) =>
    badge.getAttribute("title")?.startsWith("On this computer’s host."),
  )!;
  expect(local.getAttribute("title")).toBe(
    "On this computer’s host. Available on your phone.",
  );
  expect(local.getAttribute("aria-label")).toContain("Available on your phone.");
  const globe = badges.find((badge) => badge !== local)!;
  expect(globe.getAttribute("title")).toBeNull();
  // Different glyphs: the phone outline versus the globe.
  expect(local.querySelector("svg")!.innerHTML).not.toBe(globe.querySelector("svg")!.innerHTML);
  expect(container.textContent).toContain("This computer");
  expect(container.textContent).toContain("mac-mini");
});
