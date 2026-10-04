// Tells hosts which of their sessions this desktop shows, so they hold back
// phone notifications for what the person is already watching (spec 08 §8.3,
// 10 §10.6). Hosts treat a desktop report as current for 60 s.

import { useCallback, useEffect, useId } from "react";
import { remoteRequest } from "../../connections/model/connections";

/** While visible, the focused machine hears from this desktop this often. */
export const PRESENCE_INTERVAL_MS = 30_000;
/** No input for this long counts as away, even with the window focused. */
export const IDLE_MS = 120_000;
/** Focus changes closer together than this send one update per machine. */
export const SEND_THROTTLE_MS = 1_000;
const INPUT_THROTTLE_MS = 1_000;

export type PresenceUpdate = { visible: boolean; focusedSessionId?: string };
type Focus = { machineId: string; sessionId: string };

export type PresenceOptions = {
  send: (machineId: string, update: PresenceUpdate) => Promise<unknown>;
  now?: () => number;
  target?: Window;
  hasFocus?: () => boolean;
};

export function createPresence({
  send,
  now = Date.now,
  target = window,
  hasFocus = () => document.hasFocus(),
}: PresenceOptions) {
  // Insertion order: the last claim is the focused pane.
  const claims = new Map<string, Focus>();
  const outbox = new Map<
    string,
    { at: number; update?: PresenceUpdate; timer?: ReturnType<typeof setTimeout> }
  >();
  let focused: Focus | undefined;
  let windowFocused = hasFocus();
  let lastInput = now();
  let lastInputMark = -Infinity;
  let visible = windowFocused;
  let interval: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const flush = (machineId: string) => {
    const entry = outbox.get(machineId);
    if (!entry?.update) return;
    const update = entry.update;
    entry.update = undefined;
    entry.timer = undefined;
    entry.at = now();
    void send(machineId, update).catch(() => {
      /* presence is advisory; the next report replaces it */
    });
  };
  const queue = (machineId: string, update: PresenceUpdate) => {
    const entry = outbox.get(machineId) ?? { at: -Infinity };
    outbox.set(machineId, entry);
    entry.update = update;
    const wait = entry.at + SEND_THROTTLE_MS - now();
    if (wait <= 0) flush(machineId);
    else entry.timer ??= setTimeout(() => flush(machineId), wait);
  };
  const announce = () => {
    if (focused)
      queue(focused.machineId, { visible, focusedSessionId: focused.sessionId });
  };
  const keepAnnouncing = () => {
    clearInterval(interval);
    interval =
      focused && visible
        ? setInterval(announce, PRESENCE_INTERVAL_MS)
        : undefined;
  };
  const watchIdle = () => {
    clearTimeout(idle);
    idle = visible
      ? setTimeout(recheck, Math.max(0, lastInput + IDLE_MS - now()))
      : undefined;
  };
  function recheck() {
    const next = windowFocused && now() - lastInput < IDLE_MS;
    if (next !== visible) {
      visible = next;
      announce();
      keepAnnouncing();
    }
    watchIdle();
  }
  const refocus = () => {
    const next = [...claims.values()].at(-1);
    if (
      next?.machineId === focused?.machineId &&
      next?.sessionId === focused?.sessionId
    )
      return;
    const previous = focused;
    focused = next;
    // That machine's session is no longer on screen.
    if (previous && previous.machineId !== next?.machineId)
      queue(previous.machineId, { visible });
    announce();
    keepAnnouncing();
  };

  const onFocus = () => {
    windowFocused = true;
    lastInput = now();
    recheck();
  };
  const onBlur = () => {
    windowFocused = false;
    recheck();
  };
  const onInput = () => {
    const at = now();
    if (at - lastInputMark < INPUT_THROTTLE_MS) return;
    lastInputMark = at;
    lastInput = at;
    if (!visible) recheck();
  };
  target.addEventListener("focus", onFocus);
  target.addEventListener("blur", onBlur);
  for (const type of ["keydown", "pointerdown", "wheel"])
    target.addEventListener(type, onInput, { capture: true, passive: true });
  watchIdle();

  return {
    /** A host session is the focused pane's, newest claim first. */
    claim(key: string, focus: Focus) {
      claims.delete(key);
      claims.set(key, focus);
      refocus();
    },
    release(key: string) {
      if (claims.delete(key)) refocus();
    },
    dispose() {
      target.removeEventListener("focus", onFocus);
      target.removeEventListener("blur", onBlur);
      for (const type of ["keydown", "pointerdown", "wheel"])
        target.removeEventListener(type, onInput, { capture: true });
      clearInterval(interval);
      clearTimeout(idle);
      for (const entry of outbox.values()) clearTimeout(entry.timer);
    },
  };
}

let shared: ReturnType<typeof createPresence> | undefined;
const presence = () =>
  (shared ??= createPresence({
    send: (machineId, update) =>
      remoteRequest(machineId, "presence.update", update),
  }));

/** Reports a visible host session while `active`, and returns a callback the
 * pane calls when it takes focus, so the most recently used pane wins. */
export function useHostPresence(
  machineId: string,
  sessionId: string | undefined,
  active: boolean,
): () => void {
  const key = useId();
  const enabled = active && !!sessionId;
  useEffect(() => {
    if (!enabled || !sessionId) return;
    presence().claim(key, { machineId, sessionId });
    return () => presence().release(key);
  }, [key, machineId, sessionId, enabled]);
  return useCallback(() => {
    if (enabled && sessionId) presence().claim(key, { machineId, sessionId });
  }, [key, machineId, sessionId, enabled]);
}
