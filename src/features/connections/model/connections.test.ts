// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  isLocalMachine,
  orderMachines,
  remoteMachineFor,
  useRemoteMachines,
  type ManagedMachine,
} from "./connections";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const machine = (id: string, local = false): ManagedMachine => ({
  id,
  name: local ? "This computer" : id,
  endpoint: local ? "http://127.0.0.1:3774" : `ssh://${id}`,
  environmentId: `${id}-env`,
  ...(local ? { local: true } : {}),
});

it("lists This computer first, then machines in the order they were added", () => {
  const ordered = orderMachines([
    machine("mini"),
    machine("box"),
    machine("local", true),
  ]);
  expect(ordered.map((entry) => entry.id)).toEqual(["local", "mini", "box"]);
  expect(isLocalMachine(ordered[0])).toBe(true);
  expect(isLocalMachine(ordered[1])).toBe(false);
  // Stores saved before This computer existed have no flag.
  expect(isLocalMachine({ ...machine("old"), local: undefined })).toBe(false);
  expect(isLocalMachine(undefined)).toBe(false);
});

it("keeps every machine list in that order", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockResolvedValue([machine("mini"), machine("local", true)]);
  expect((await remoteMachineFor("local-env"))?.id).toBe("local");
  const seen: string[][] = [];
  const Probe = () => {
    const { machines } = useRemoteMachines();
    seen.push(machines.map((entry) => entry.id));
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  expect(seen.at(-1)).toEqual(["local", "mini"]);
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
