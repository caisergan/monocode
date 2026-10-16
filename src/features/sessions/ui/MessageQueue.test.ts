// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { monoSessionCompletionMessage } from "../../monos/model/monoSessionCompletion";
import type { QueuedMessage } from "../model/session";
import { MessageQueue, mergeQueueRows } from "./MessageQueue";

it("labels a pending completion and offers removal without editing or steering it", () => {
  const message = monoSessionCompletionMessage({
    sessionId: "worker",
    requestId: "app-mono-monitor",
    project: "/code/project",
    prompt: "Review",
    session: undefined,
    outcome: { status: "completed", text: "Done" },
  });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(MessageQueue, {
      messages: [message],
      onSteer: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      variant: "messages",
    }),
  );
  expect(container.textContent).toContain("Session completed: Agent session");
  expect(container.textContent).not.toContain(
    "MonoCode completion notification",
  );
  expect(container.textContent).not.toContain("Steer");
  expect(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]',
    )?.disabled,
  ).toBe(true);
  expect(
    container.querySelector('[aria-label="Remove queued message"]'),
  ).not.toBeNull();
});

it("labels a combined report without exposing the app prompt", () => {
  const message = monoSessionCompletionMessage({
    sessionId: "worker",
    requestId: "request",
    project: "/code/project",
    prompt: "Review",
    outcome: { status: "completed", text: "Done" },
  });
  message.monoSessionCompletion!.sessionCount = 3;
  const markup = renderToStaticMarkup(
    createElement(MessageQueue, { messages: [message] }),
  );
  expect(markup).toContain("3 sessions finished");
  expect(markup).not.toContain("MonoCode completion notification");
});

function queued(id: string): QueuedMessage {
  return { id, text: id, attachments: [] };
}

it("keeps a sent row in place while it folds away", () => {
  const [a, b, c] = ["a", "b", "c"].map(queued);
  const shown = mergeQueueRows([], [a, b]);
  expect(shown.map((row) => row.entering)).toEqual([false, false]);

  const rows = mergeQueueRows(shown, [b, c]);
  expect(
    rows.map(({ message, leaving, entering }) => [
      message.id,
      leaving,
      entering,
    ]),
  ).toEqual([
    ["a", true, false],
    ["b", false, false],
    ["c", false, true],
  ]);
});

it("keeps a removed middle row between its neighbours", () => {
  const [a, b, c] = ["a", "b", "c"].map(queued);
  const rows = mergeQueueRows(mergeQueueRows([], [a, b, c]), [a, c]);
  expect(rows.map((row) => [row.message.id, row.leaving])).toEqual([
    ["a", false],
    ["b", true],
    ["c", false],
  ]);
});

it("shows an edited message in its row", () => {
  const a = queued("a");
  const edited = { ...a, text: "changed" };
  const rows = mergeQueueRows(mergeQueueRows([], [a]), [edited]);
  expect(rows).toEqual([{ message: edited, leaving: false, entering: false }]);
});
