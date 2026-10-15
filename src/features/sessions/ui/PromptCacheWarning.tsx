import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import {
  promptCacheExpired,
  promptCacheTooltip,
  promptCacheWarnAt,
  type PromptCacheState,
} from "../model/promptCache";
import { Popover } from "../../../shared/ui/Popover";
import { CircleAlert } from "../../../shared/ui/icons";

/**
 * Whether the prompt cache has run out, flipping at the expiry moment.
 *
 * One timer per window instead of a ticking clock: an idle composer updates
 * the instant the cache lapses without re-rendering in between.
 */
export function usePromptCacheExpired(cache?: PromptCacheState): boolean {
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  const warnAt = cache ? promptCacheWarnAt(cache) : undefined;

  useEffect(() => {
    if (warnAt == null) return;
    const wait = warnAt - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(rerender, wait);
    return () => window.clearTimeout(timer);
  }, [warnAt]);

  return promptCacheExpired(cache, Date.now());
}

/** Amber `!` beside the send button once the cache has expired. */
export function PromptCacheWarning({
  cache,
  contextUsed,
}: {
  cache: PromptCacheState;
  contextUsed?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Read the clock at render so the idle time is current on every hover.
  const { headline, detail, consequence } = promptCacheTooltip(
    cache,
    Date.now(),
    contextUsed,
  );

  return (
    <div
      ref={root}
      className="relative grid size-6.5 shrink-0 place-items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        role="img"
        aria-label={`${headline}. ${detail} ${consequence}`}
        className="grid text-amber-400"
      >
        <CircleAlert className="size-3.5" strokeWidth={2} />
      </span>
      {hovered ? (
        <Popover
          anchor={root}
          side="top"
          align="end"
          className="pointer-events-none w-72 px-2.5 py-1.5"
        >
          <div className="text-[12px] leading-4 text-amber-400">{headline}</div>
          <div className="mt-0.5 text-[11px] leading-4 text-content/50">
            {detail}
          </div>
          <div className="mt-1 text-[11px] leading-4 text-content/50">
            {consequence}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * Asks before a send re-reads the whole context.
 *
 * "Send anyway" takes focus, so pressing Enter twice still sends; Escape or a
 * click outside cancels and leaves the draft in place.
 */
export function PromptCacheSendConfirm({
  anchor,
  cache,
  contextUsed,
  onSend,
  onCancel,
}: {
  anchor: RefObject<HTMLElement | null>;
  cache: PromptCacheState;
  contextUsed?: number;
  onSend: (skipForChat: boolean) => void;
  onCancel: () => void;
}) {
  const [skipForChat, setSkipForChat] = useState(false);
  const send = useRef<HTMLButtonElement>(null);
  const { detail, consequence } = promptCacheTooltip(
    cache,
    Date.now(),
    contextUsed,
  );

  // Popover measures its first pass while hidden, and a hidden button cannot
  // take focus, so wait a frame for it to land.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      send.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <Popover
      anchor={anchor}
      side="top"
      align="end"
      width={300}
      onDismiss={onCancel}
      role="alertdialog"
      aria-label="Prompt cache expired"
      className="flex flex-col gap-2 p-3 text-[12px]"
    >
      <div>
        <div className="font-medium text-content">Re-read the whole chat?</div>
        <p className="mt-1 text-[11px] leading-4 text-content/55">
          {detail} {consequence}
        </p>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-content/70">
        <input
          type="checkbox"
          checked={skipForChat}
          onChange={(e) => setSkipForChat(e.target.checked)}
          className="accent-accent"
        />
        Don't ask again for this chat
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1 hover:bg-content/8 active:scale-[0.97]"
        >
          Cancel
        </button>
        <button
          ref={send}
          type="button"
          onClick={() => onSend(skipForChat)}
          className="rounded-md bg-amber-500/20 px-2.5 py-1 font-medium text-amber-400 outline-none hover:bg-amber-500/30 focus-visible:ring-1 focus-visible:ring-amber-400 active:scale-[0.97]"
        >
          Send anyway
        </button>
      </div>
    </Popover>
  );
}
