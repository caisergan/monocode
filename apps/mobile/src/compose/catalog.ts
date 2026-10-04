// Model catalogs per host and project (12 §12.5 `catalogs`), in memory.
// `models.list` can be slow (providers are probed), so one load serves every
// composer on that project.

import { useEffect } from "react";
import { create } from "zustand";
import type { HostModelCatalog } from "@monocode/core/session";
import type { HostRuntime } from "@/hosts/runtime";

type Entry = { catalog?: HostModelCatalog; error?: string; loading: boolean };

const useCatalogs = create<{ byKey: Record<string, Entry> }>(() => ({ byKey: {} }));

const keyOf = (env: string, projectId: string) => `${env}/${projectId}`;

export function loadCatalog(host: HostRuntime, projectId: string, force = false): void {
  const key = keyOf(host.env, projectId);
  const existing = useCatalogs.getState().byKey[key];
  if (existing?.loading || (existing?.catalog && !force)) return;
  const set = (entry: Entry) => useCatalogs.setState((state) => ({ byKey: { ...state.byKey, [key]: entry } }));
  set({ ...existing, loading: true, error: undefined });
  host
    .request<HostModelCatalog>("models.list", { projectId }, 60_000)
    .then((catalog) => set({ catalog, loading: false }))
    .catch(() => set({ ...existing, loading: false, error: `Couldn’t load models from ${host.record.label}.` }));
}

/** The project's catalog, loaded on first use. */
export function useCatalog(host: HostRuntime | undefined, projectId: string | undefined): Entry {
  const key = host && projectId ? keyOf(host.env, projectId) : "";
  const entry = useCatalogs((state) => state.byKey[key]);
  useEffect(() => {
    if (host && projectId) loadCatalog(host, projectId);
  }, [host, projectId]);
  return entry ?? { loading: !!key };
}
