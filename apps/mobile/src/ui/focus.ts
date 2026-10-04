import { create } from "zustand";

/** The session on screen, as `${env}/${sessionId}`: the approval banner
 * skips it, and presence reports it. */
export const useFocusedSession = create<{ key?: string }>(() => ({}));
