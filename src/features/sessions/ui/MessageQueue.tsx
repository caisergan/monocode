import { useEffect, useRef, useState } from "react";
import {
  Check,
  CornerDownRight,
  ListEnd,
  Pause,
  Pencil,
  Play,
  Trash2,
  X,
} from "../../../shared/ui/icons";
import { isImeComposition } from "../../../shared/lib/keyboard";
import type { MessageQueueStatus, QueuedMessage } from "../model/session";

/** Matches the row and card fold in index.css. */
const EXIT_MS = 220;

type QueueRow = {
  message: QueuedMessage;
  /** Sent or removed; folds away before it is dropped. */
  leaving: boolean;
  /** Joined a queue already on screen, so it grows in on its own. */
  entering: boolean;
};

function sameMessages(a: QueuedMessage[], b: QueuedMessage[]) {
  return a.length === b.length && a.every((message, i) => message === b[i]);
}

/**
 * The rows to draw: the queue as it is now, plus rows that just left it,
 * kept in place long enough to fold away instead of vanishing.
 */
export function mergeQueueRows(
  previous: QueueRow[],
  messages: QueuedMessage[],
): QueueRow[] {
  const current = new Map(messages.map((message) => [message.id, message]));
  const known = new Set(previous.map((row) => row.message.id));
  const shown = previous.some((row) => !row.leaving);
  const placed = new Set<string>();
  const rows: QueueRow[] = [];
  let next = 0;
  const placeUpTo = (id?: string) => {
    while (next < messages.length) {
      const message = messages[next++];
      if (placed.has(message.id)) continue;
      placed.add(message.id);
      const before = previous.find((row) => row.message.id === message.id);
      rows.push({
        message,
        leaving: false,
        entering: before ? before.entering : shown && !known.has(message.id),
      });
      if (message.id === id) return;
    }
  };
  for (const row of previous) {
    if (current.has(row.message.id)) {
      if (!placed.has(row.message.id)) placeUpTo(row.message.id);
    } else {
      rows.push({ ...row, leaving: true });
    }
  }
  placeUpTo();
  return rows;
}

function useQueueRows(messages: QueuedMessage[]): QueueRow[] {
  const [state, setState] = useState(() => ({
    messages,
    rows: messages.map((message) => ({
      message,
      leaving: false,
      entering: false,
    })),
  }));
  let rows = state.rows;
  if (!sameMessages(state.messages, messages)) {
    rows = mergeQueueRows(state.rows, messages);
    setState({ messages, rows });
  }
  const leaving = rows
    .filter((row) => row.leaving)
    .map((row) => row.message.id)
    .join(" ");
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(
      () =>
        setState((previous) => ({
          ...previous,
          rows: previous.rows.filter((row) => !row.leaving),
        })),
      EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return rows;
}

export function MessageQueue({
  messages,
  status,
  onDelete,
  onEdit,
  onEditingChange,
  onSteer,
  onResume,
  variant = "queue",
  sendingId,
}: {
  messages: QueuedMessage[];
  status?: MessageQueueStatus;
  onDelete?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => void;
  onEditingChange?: (messageId?: string) => void;
  onSteer?: (messageId: string) => void;
  onResume?: () => void;
  variant?: "queue" | "messages";
  sendingId?: string;
}) {
  const [editingId, setEditingId] = useState<string>();
  const [editDraft, setEditDraft] = useState("");
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  useEffect(() => {
    return () => {
      if (editingIdRef.current) onEditingChangeRef.current?.();
    };
  }, []);
  const rows = useQueueRows(messages);
  if (rows.length === 0) return null;
  const open = messages.length > 0;
  const paused = open && status === "paused";
  const failed = messages.some((message) => message.error);

  const startEdit = (message: QueuedMessage) => {
    setEditingId(message.id);
    setEditDraft(message.text);
    onEditingChange?.(message.id);
  };
  const cancelEdit = () => {
    setEditingId(undefined);
    setEditDraft("");
    onEditingChange?.();
  };
  const saveEdit = (message: QueuedMessage) => {
    if (!editDraft.trim() && message.attachments.length === 0) return;
    onEdit?.(message.id, editDraft);
    setEditingId(undefined);
    setEditDraft("");
  };

  return (
    <div
      className="message-queue px-2 text-content/55"
      data-open={open}
      data-message-queue
    >
      <div>
        <div
          className="relative z-0 rounded-t-[10px] border border-b-0 border-content/10 bg-content/3 px-2 py-1"
          data-message-queue-card
        >
          {paused ? (
            <div className="flex h-7 items-center gap-2 border-b border-stroke text-[12px]">
              <Pause className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">
                {failed
                  ? "A message couldn't be sent"
                  : variant === "messages"
                    ? "Messages paused"
                    : "Queue paused because you interrupted"}
              </span>
              <button
                type="button"
                onClick={onResume}
                className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-content/10 hover:text-content"
              >
                <Play className="size-3.5" />
                {failed ? "Retry" : "Resume"}
              </button>
            </div>
          ) : null}
          {variant === "messages" && open && !paused ? (
            <div role="status" className="py-1 text-[11px] text-content/50">
              {sendingId ? "Sending…" : "Waiting to send"}
            </div>
          ) : null}
          {rows.map(({ message, leaving, entering }, index) => {
            const sending = sendingId === message.id;
            const editing = editingId === message.id;
            const label =
              (message.monoSessionCompletion
                ? message.monoSessionCompletion.sessionCount
                  ? `${message.monoSessionCompletion.sessionCount} sessions finished`
                  : `Session ${message.monoSessionCompletion.status}: ${message.monoSessionCompletion.title}`
                : message.text.trim()) ||
              message.noteCard?.title ||
              message.handoffCard?.brief ||
              `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
            return (
              <div
                key={message.id}
                className="message-queue-row"
                data-leaving={leaving || undefined}
                data-entering={entering || undefined}
                inert={leaving}
              >
                <div>
                  <div
                    className={`flex min-h-7 items-center gap-2 text-[12px] ${
                      index > 0 ? "border-t border-stroke" : ""
                    }`}
                  >
                    <ListEnd className="size-3.5 shrink-0" />
                    {editing ? (
                      <>
                        <textarea
                          autoFocus
                          aria-label="Edit queued message"
                          value={editDraft}
                          rows={1}
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (isImeComposition(event.nativeEvent)) return;
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelEdit();
                            } else if (
                              event.key === "Enter" &&
                              !event.shiftKey
                            ) {
                              event.preventDefault();
                              saveEdit(message);
                            }
                          }}
                          className="min-h-6 min-w-0 flex-1 resize-none rounded-md border border-content/15 bg-content/5 px-1.5 py-0.5 text-[12px] text-content outline-none focus:border-content/30"
                        />
                        <button
                          type="button"
                          title="Save queued message"
                          aria-label="Save queued message"
                          disabled={
                            !editDraft.trim() &&
                            message.attachments.length === 0
                          }
                          onClick={() => saveEdit(message)}
                          className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-content/10 hover:text-content disabled:opacity-30"
                        >
                          <Check className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Cancel queued message edit"
                          aria-label="Cancel queued message edit"
                          onClick={cancelEdit}
                          className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-content/10 hover:text-content"
                        >
                          <X className="size-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1 py-1">
                          <div
                            className="truncate text-content/80"
                            title={label}
                          >
                            {label}
                          </div>
                          {message.error ? (
                            <p role="alert" className="text-red-400">
                              {message.error}
                            </p>
                          ) : null}
                        </div>
                        {onSteer && !message.monoSessionCompletion ? (
                          <button
                            type="button"
                            disabled={sending}
                            onClick={() => onSteer?.(message.id)}
                            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-content/10 hover:text-content"
                          >
                            <CornerDownRight className="size-3.5" />
                            Steer
                          </button>
                        ) : null}
                        <button
                          type="button"
                          title="Edit queued message"
                          aria-label="Edit queued message"
                          disabled={sending || !!message.monoSessionCompletion}
                          onClick={() => startEdit(message)}
                          className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-content/10 hover:text-content"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Remove queued message"
                          aria-label="Remove queued message"
                          disabled={sending}
                          onClick={() => onDelete?.(message.id)}
                          className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-content/10 hover:text-content"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
