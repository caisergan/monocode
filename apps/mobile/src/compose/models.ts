// Model choices for the composer (11 §11.17): the session's harness, model,
// model settings and access mode, and the desktop's rules for showing them.

import type { HostModelCatalog, RemoteProvider, RuntimeMode } from "@monocode/core/session";

export type ComposerConfig = {
  harness: RemoteProvider;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
};

export type CatalogModel = NonNullable<HostModelCatalog["models"][RemoteProvider]>[number];
export type ModelSetting = NonNullable<CatalogModel["settings"]>[number];

/** The desktop's settings order: fast, effort, reasoning, … context. */
const SETTING_ORDER = ["fast", "effort", "reasoning", "reasoningEffort", "serviceTier", "thinking", "variant", "context"];
const EFFORT_IDS = new Set(["effort", "reasoning", "reasoningEffort", "thinking", "variant"]);

export function orderedSettings(model: CatalogModel | undefined): ModelSetting[] {
  const rank = (id: string) => {
    const index = SETTING_ORDER.indexOf(id);
    return index < 0 ? SETTING_ORDER.length : index;
  };
  return [...(model?.settings ?? [])].sort((a, b) => rank(a.id) - rank(b.id));
}

/** A model's defaults, keeping compatible current values. */
export function mergeSettings(model: CatalogModel | undefined, current: Record<string, string> = {}): Record<string, string> {
  const next: Record<string, string> = {};
  for (const setting of model?.settings ?? []) {
    const value = current[setting.id];
    next[setting.id] = value !== undefined && setting.options.some((option) => option.value === value) ? value : setting.value;
  }
  return next;
}

/** "High" for the effort setting, as the model chip shows it. */
export function effortLabel(model: CatalogModel | undefined, settings: Record<string, string>): string | undefined {
  const setting = model?.settings?.find((item) => item.kind === "select" && EFFORT_IDS.has(item.id));
  if (!setting) return undefined;
  const value = settings[setting.id] ?? setting.value;
  return setting.options.find((option) => option.value === value)?.label ?? value;
}

export function findModel(catalog: HostModelCatalog | undefined, harness: RemoteProvider, id: string): CatalogModel | undefined {
  return catalog?.models[harness]?.find((model) => model.id === id);
}

/** "Opus 4.6" from "claude:opus-4-6" when the catalog hasn't loaded. */
export function fallbackModelName(id: string): string {
  return id.replace(/^[^:]+:/, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function modelChipLabel(catalog: HostModelCatalog | undefined, config: ComposerConfig): string {
  const model = findModel(catalog, config.harness, config.model);
  const name = model?.name ?? fallbackModelName(config.model);
  const effort = effortLabel(model, config.modelSettings);
  return effort ? `${name} · ${effort}` : name;
}

export const sameConfig = (a: ComposerConfig, b: ComposerConfig) =>
  a.harness === b.harness &&
  a.model === b.model &&
  a.runtimeMode === b.runtimeMode &&
  JSON.stringify(a.modelSettings) === JSON.stringify(b.modelSettings);
