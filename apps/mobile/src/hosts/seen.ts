import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

// Read state is the phone's own (06 §6.10): "Done" shows until the session
// is opened here. Kept small: the newest 500 entries.
const KEY = "mc.seen";

type SeenState = { seen: Record<string, number>; markSeen: (key: string) => void };

export const useSeen = create<SeenState>((set, get) => ({
  seen: (() => {
    try {
      return JSON.parse(SecureStore.getItem(KEY) ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  })(),
  markSeen: (key) => {
    const entries = Object.entries({ ...get().seen, [key]: Date.now() })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500);
    const seen = Object.fromEntries(entries);
    set({ seen });
    void SecureStore.setItemAsync(KEY, JSON.stringify(seen));
  },
}));

export const seenKey = (env: string, sessionId: string) => `${env}/${sessionId}`;
