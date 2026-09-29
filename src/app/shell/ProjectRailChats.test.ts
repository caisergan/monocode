// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectlessChat } from "../../features/sessions/model/projectlessChats";
import { ProjectRail } from "./ProjectRail";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: (path: string) => path,
}));
vi.mock("../../features/source-control/hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: vi.fn(() => null),
}));

const NOW = new Date("2026-09-29T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function chats(count: number): ProjectlessChat[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `chat-${index}`,
    title: `Chat ${index}`,
    harness: "claude",
    updatedAt: NOW - (index + 1) * HOUR,
    busy: false,
  }));
}

async function renderRail(props: {
  chats: ProjectlessChat[];
  activeSessionId?: string;
  onSelectChat?: (id: string) => void;
  onRenameChat?: (id: string, title: string) => void;
  onArchiveChat?: (id: string) => void;
  onDeleteChat?: (id: string) => void;
}) {
  await act(async () =>
    root.render(
      createElement(ProjectRail, {
        cwd: "~",
        recents: [{ path: "/work/site", openedAt: 1 }],
        onSelectProject: vi.fn(),
        onOpenProject: vi.fn(),
        onSelectChat: props.onSelectChat ?? vi.fn(),
        onRenameChat: props.onRenameChat,
        onArchiveChat: props.onArchiveChat,
        onDeleteChat: props.onDeleteChat,
        chats: props.chats,
        activeSessionId: props.activeSessionId,
      }),
    ),
  );
}

function chatRows(): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Chats"] button.project-reorder-item',
    ),
  ];
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) =>
      item.getAttribute("aria-label") === label || item.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}

describe("ProjectRail chats", () => {
  it("has no Chats section until a chat exists", async () => {
    await renderRail({ chats: [] });
    expect(container.textContent).not.toContain("Chats");
  });

  it("lists the newest chats and opens the one clicked", async () => {
    const select = vi.fn();
    await renderRail({
      chats: chats(7),
      activeSessionId: "chat-1",
      onSelectChat: select,
    });

    const rows = chatRows();
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Chat 0",
      "Chat 1",
      "Chat 2",
      "Chat 3",
      "Chat 4",
    ]);
    expect(rows[0].textContent).toContain("1h");
    expect(rows[1].getAttribute("aria-current")).toBe("true");

    await act(async () => rows[2].click());
    expect(select).toHaveBeenCalledWith("chat-2");

    await act(async () => button("Show 2 more").click());
    expect(chatRows()).toHaveLength(7);
    await act(async () => button("Show less").click());
    expect(chatRows()).toHaveLength(5);
  });

  it("hides the chats from the header and remembers it", async () => {
    await renderRail({ chats: chats(2) });
    const toggle = button("Hide chats");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await act(async () => toggle.click());
    expect(chatRows()).toHaveLength(0);
    expect(button("Show chats").getAttribute("aria-expanded")).toBe("false");

    act(() => root.unmount());
    root = createRoot(container);
    await renderRail({ chats: chats(2) });
    expect(chatRows()).toHaveLength(0);

    await act(async () => button("Show chats").click());
    expect(chatRows()).toHaveLength(2);
  });

  it("shows titles without the harness prefix they are stored with", async () => {
    await renderRail({
      chats: [{ ...chats(1)[0], title: "claude · Tidy dotfiles" }],
    });
    expect(chatRows()[0].getAttribute("aria-label")).toBe("Tidy dotfiles");
  });

  it("renames, archives and deletes a chat from its menu", async () => {
    const rename = vi.fn();
    const archive = vi.fn();
    const remove = vi.fn();
    await renderRail({
      chats: chats(2),
      onRenameChat: rename,
      onArchiveChat: archive,
      onDeleteChat: remove,
    });
    const openMenu = async (index: number) => {
      await act(async () => {
        chatRows()[index].dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
      });
    };
    const pick = async (label: string) => {
      const item = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((element) => element.textContent?.includes(label));
      expect(item, label).toBeDefined();
      await act(async () => item!.click());
    };

    await openMenu(0);
    await pick("Archive");
    expect(archive).toHaveBeenCalledWith("chat-0");

    await openMenu(1);
    await pick("Delete");
    expect(remove).toHaveBeenCalledWith("chat-1");

    await openMenu(1);
    await pick("Rename");
    const field = container.querySelector<HTMLInputElement>(
      'input[aria-label="Chat name"]',
    )!;
    expect(field.value).toBe("Chat 1");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, "Renamed");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(rename).toHaveBeenCalledWith("chat-1", "Renamed");
    expect(container.querySelector('input[aria-label="Chat name"]')).toBeNull();
  });
});
