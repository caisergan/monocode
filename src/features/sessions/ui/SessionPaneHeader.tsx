import { GripVertical, X } from "../../../shared/ui/icons";
import type { PointerEvent as ReactPointerEvent } from "react";
import { MOD } from "../../../platform/tauri/platform";

/** The strip above a session in a split: drag handle, title, close. */
export function SessionPaneHeader({
  sessionId,
  title,
  focused,
  onClose,
  onPaneDragStart,
}: {
  sessionId: string;
  title: string;
  focused: boolean;
  onClose: (sessionId: string) => void;
  onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <div
      className={`flex h-9 shrink-0 touch-none items-center gap-1.5 border-b border-stroke px-2 select-none ${
        onPaneDragStart ? "cursor-grab active:cursor-grabbing" : ""
      }`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !onPaneDragStart) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        onPaneDragStart(event);
      }}
    >
      {onPaneDragStart ? (
        <GripVertical
          className="size-3.5 shrink-0 text-content/35"
          strokeWidth={1.75}
        />
      ) : null}
      <span
        className={`size-2 shrink-0 rounded-full ${focused ? "bg-accent" : "bg-transparent"}`}
      />
      <span
        className="min-w-0 flex-1 truncate text-xs text-content"
        title={title}
      >
        {title}
      </span>
      <button
        type="button"
        title={`Close Pane (${MOD}W)`}
        aria-label="Close pane"
        data-no-drag
        className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(sessionId);
        }}
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}
