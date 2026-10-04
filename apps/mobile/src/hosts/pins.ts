import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";

// Project pins are the phone's own (11 §11.13), as the desktop keeps its
// own. A small preference, so it lives in the key-value store.
const KEY = "mc.projects.pinned";

export const pinKey = (env: string, projectId: string) => `${env}/${projectId}`;

function read(): string[] {
  try {
    const value = JSON.parse(Storage.getItemSync(KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

type PinsState = { pins: string[]; toggle: (key: string) => void };

export const usePins = create<PinsState>((set, get) => ({
  pins: read(),
  toggle: (key) => {
    const current = get().pins;
    const pins = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
    set({ pins });
    void Storage.setItem(KEY, JSON.stringify(pins)).catch(() => undefined);
  },
}));
