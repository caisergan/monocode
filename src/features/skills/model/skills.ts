import {
  createPath,
  homeDir,
  listSkills,
  readTextFile,
  writeTextFile,
  type DiscoveredSkill,
} from "../../../platform/tauri/fs";
import { invalidateProjectFiles } from "../../files/model/fileIndex";
import { joinPath } from "../../../shared/lib/paths";
import { isLocalProject, normalizeProjectPath } from "../../projects/model/recents";
import { isMarkdownBlockquotePosition } from "../../sessions/model/quoteDraft";
import type { HarnessId } from "../../sessions/model/session";
import { getHarness } from "../../../integrations/harness/core/registry";
import type { NativeCommand } from "../../../integrations/harness/core/nativeCommands";
import {
  CREATE_SKILL_BODY,
  CREATE_SKILL_DESCRIPTION,
  CREATE_SKILL_NAME,
} from "./createSkill";

export {
  rankSkills,
  replaceSlashToken,
  slashTokenAt,
  type SlashToken,
} from "./slashCommands";

const DISABLED_SKILL_PATHS_KEY = "monocode.disabledSkillPaths";

/** Fired on `window` when a skill is enabled or disabled in Settings. */
export const SKILLS_CHANGE_EVENT = "monocode:skills-change";

export function loadDisabledSkillPaths(): string[] {
  try {
    const raw = localStorage.getItem(DISABLED_SKILL_PATHS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    // private mode / quota
    return [];
  }
}

export function saveDisabledSkillPaths(paths: string[]): void {
  try {
    localStorage.setItem(DISABLED_SKILL_PATHS_KEY, JSON.stringify(paths));
  } catch {
    throw new Error("Could not save skill preferences");
  }
  // The composer catalog caches per context; drop it so the next picker or
  // prompt sees the change immediately.
  invalidateSkills();
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SKILLS_CHANGE_EVENT));
}

function disabledSkillPathSet(): Set<string> {
  return new Set(loadDisabledSkillPaths());
}

export type SkillScope = "project" | "user" | "builtin";
export type SkillSource =
  | "agents"
  | "claude"
  | "cursor"
  | "codex"
  | "opencode"
  | "pi"
  | "omp"
  | "fx"
  | "grok"
  | "hermes"
  | "antigravity"
  | "monocode";

type SkillCommon = {
  name: string;
  description: string;
  invocation: string;
};

export type FileSkill = SkillCommon & {
  kind: "file";
  path: string;
  scope: Exclude<SkillScope, "builtin">;
  source: SkillSource;
};

export type BuiltinSkill = SkillCommon & {
  kind: "builtin";
  scope: "builtin";
  source: "monocode";
};

export type NativeSkill = NativeCommand & {
  kind: "native";
};

export type Skill = FileSkill | BuiltinSkill | NativeSkill;

export const BUILTIN_CREATE_SKILL: BuiltinSkill = {
  kind: "builtin",
  name: CREATE_SKILL_NAME,
  description: CREATE_SKILL_DESCRIPTION,
  invocation: CREATE_SKILL_NAME,
  scope: "builtin",
  source: "monocode",
};

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_TOKEN_RE =
  /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?)(?=\s|$)/g;
const NATIVE_SKILL_TTL_MS = 30_000;
const NATIVE_SKILL_RETRY_MS = 5_000;

export type SkillCatalogContext = {
  harness: HarnessId;
  cwd: string;
  sessionId?: string;
};

type CatalogRequest = {
  generation: number;
  promise: Promise<Skill[]>;
};

type CatalogEntry = {
  cwd: string;
  skills: Skill[] | null;
  loadedAt: number;
  retryAt: number;
  generation: number;
  inFlight: CatalogRequest | null;
};

const catalogEntries = new Map<string, CatalogEntry>();

export function skillCatalogKey(context: SkillCatalogContext): string {
  const provider = getHarness(context.harness)?.commands;
  const sessionScoped = !!provider?.subscribe && !provider.alongsideSkills;
  return `${context.harness}\0${normalizeProjectPath(context.cwd)}${sessionScoped && context.sessionId ? `\0${context.sessionId}` : ""}`;
}

/** True when the harness's own commands replace MonoCode's skills. */
export function hasNativeCommands(harness: HarnessId): boolean {
  const provider = getHarness(harness)?.commands;
  return !!provider && !provider.alongsideSkills;
}

/** True when the harness lists commands of its own, with or without skills. */
export function listsNativeCommands(harness: HarnessId): boolean {
  return !!getHarness(harness)?.commands;
}

/**
 * A prompt the harness runs as its own slash command, so it is sent as typed.
 * Next to MonoCode's skills only a command the harness listed counts; a skill
 * of the same name keeps being injected.
 */
export function isNativeCommandPrompt(
  text: string,
  context: SkillCatalogContext,
): boolean {
  const provider = getHarness(context.harness)?.commands;
  if (provider?.rawSlashCommands !== true) return false;
  const name = /^\s*\/([^\s/\\]+)(?=\s|$)/.exec(text)?.[1];
  if (!name) return false;
  if (!provider.alongsideSkills) return true;
  const catalog = peekSkills(context) ?? [];
  const named = catalog.find((skill) => skill.invocation === name);
  if (named) return named.kind === "native";
  return catalog.some(
    (skill) => skill.kind === "native" && skill.aliases?.includes(name),
  );
}

/** A live update supersedes any cold probe already in flight. */
export function subscribeSkills(
  context: SkillCatalogContext,
  onSkills: (skills: Skill[]) => void,
): () => void {
  const provider = getHarness(context.harness)?.commands;
  if (provider?.alongsideSkills) {
    // The commands are one part of the catalog; reload it as a whole.
    return (
      provider.subscribe?.(context, () => {
        void loadSkills(context, { refresh: true }).then(onSkills);
      }) ?? (() => undefined)
    );
  }
  return (
    provider?.subscribe?.(context, (commands) => {
      const key = skillCatalogKey(context);
      const previous = catalogEntries.get(key);
      const skills: Skill[] = commands.map((command) => ({
        ...command,
        kind: "native",
      }));
      catalogEntries.set(key, {
        cwd: normalizeProjectPath(context.cwd),
        skills,
        loadedAt: Date.now(),
        retryAt: 0,
        generation: (previous?.generation ?? 0) + 1,
        inFlight: null,
      });
      onSkills(skills);
    }) ?? (() => undefined)
  );
}

export function peekSkills(context: SkillCatalogContext): Skill[] | null {
  return catalogEntries.get(skillCatalogKey(context))?.skills ?? null;
}

export function invalidateSkills(context?: { cwd: string }) {
  if (!context) {
    catalogEntries.clear();
    return;
  }
  const cwd = normalizeProjectPath(context.cwd);
  for (const entry of catalogEntries.values()) {
    if (entry.cwd !== cwd) continue;
    entry.generation += 1;
    entry.loadedAt = 0;
    entry.retryAt = 0;
    entry.inFlight = null;
  }
}

export function loadSkills(
  context: SkillCatalogContext,
  options?: { refresh?: boolean },
): Promise<Skill[]> {
  const normalized = {
    harness: context.harness,
    cwd: normalizeProjectPath(context.cwd),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  } satisfies SkillCatalogContext;
  const key = skillCatalogKey(normalized);
  let entry = catalogEntries.get(key);
  if (!entry) {
    entry = {
      cwd: normalized.cwd,
      skills: null,
      loadedAt: 0,
      retryAt: 0,
      generation: 0,
      inFlight: null,
    };
    catalogEntries.set(key, entry);
  }

  const now = Date.now();
  if (options?.refresh) {
    if (entry.inFlight?.generation === entry.generation) {
      return entry.inFlight.promise;
    }
    entry.generation += 1;
    entry.retryAt = 0;
    return startCatalogLoad(key, entry, normalized);
  }

  if (entry.inFlight?.generation === entry.generation) {
    return entry.inFlight.promise;
  }
  if (!hasNativeCommands(normalized.harness) && entry.skills) {
    return Promise.resolve(entry.skills);
  }
  if (
    hasNativeCommands(normalized.harness) &&
    entry.skills &&
    now - entry.loadedAt < NATIVE_SKILL_TTL_MS
  ) {
    return Promise.resolve(entry.skills);
  }
  if (hasNativeCommands(normalized.harness) && now < entry.retryAt) {
    return Promise.resolve(entry.skills ?? []);
  }
  return startCatalogLoad(key, entry, normalized);
}

function startCatalogLoad(
  key: string,
  entry: CatalogEntry,
  context: SkillCatalogContext,
): Promise<Skill[]> {
  const generation = entry.generation;
  const promise = loadCatalog(context)
    .then((skills) => {
      if (
        catalogEntries.get(key) !== entry ||
        entry.generation !== generation
      ) {
        return catalogEntries.get(key)?.skills ?? [];
      }
      entry.skills = skills;
      entry.loadedAt = Date.now();
      entry.retryAt = 0;
      return skills;
    })
    .catch(() => {
      if (
        catalogEntries.get(key) !== entry ||
        entry.generation !== generation
      ) {
        return catalogEntries.get(key)?.skills ?? [];
      }
      if (hasNativeCommands(context.harness)) {
        entry.retryAt = Date.now() + NATIVE_SKILL_RETRY_MS;
        return entry.skills ?? [];
      }
      const fallback = mergeCatalog([]);
      entry.skills = fallback;
      entry.loadedAt = Date.now();
      return fallback;
    })
    .finally(() => {
      if (
        catalogEntries.get(key) === entry &&
        entry.generation === generation &&
        entry.inFlight?.promise === promise
      ) {
        entry.inFlight = null;
      }
    });
  entry.inFlight = { generation, promise };
  return promise;
}

async function loadCatalog(context: SkillCatalogContext): Promise<Skill[]> {
  const provider = getHarness(context.harness)?.commands;
  if (provider && !provider.alongsideSkills) {
    const commands = await provider.discover(context);
    return commands.map((command): NativeSkill => ({
      kind: "native",
      ...command,
    }));
  }
  const disabledPaths = loadDisabledSkillPaths();
  // The harness's commands are an extra: skills still load if it cannot list them.
  const [discovered, commands, unfiltered] = await Promise.all([
    listSkills(context.cwd, disabledPaths),
    provider?.discover(context).catch(() => []) ?? [],
    provider && disabledPaths.length ? listSkills(context.cwd, []) : [],
  ]);
  const disabled = disabledSkillPathSet();
  const catalog = mergeCatalog(
    discovered.filter((skill) => !disabled.has(skill.path)),
  );
  // A skill keeps its name; the harness command of the same name is left out.
  const taken = new Set(catalog.map((skill) => skill.name));
  // The harness lists its own copy of a skill switched off in Settings.
  const switchedOff = new Set(
    unfiltered
      .filter((skill) => disabled.has(skill.path))
      .map((skill) => skill.name),
  );
  for (const command of commands) {
    if (taken.has(command.name)) continue;
    if (!command.origin && switchedOff.has(command.name)) continue;
    taken.add(command.name);
    catalog.push({ kind: "native", ...command });
  }
  return catalog;
}

export function mergeCatalog(discovered: DiscoveredSkill[]): Skill[] {
  const out = new Map<string, Skill>();
  const add = (skill: Skill) => {
    if (!skill.name || out.has(skill.name)) return;
    out.set(skill.name, skill);
  };
  for (const skill of discovered) {
    if (skill.source === "agents") add(asSkill(skill));
  }
  add(BUILTIN_CREATE_SKILL);
  for (const skill of discovered) {
    if (skill.source !== "agents") add(asSkill(skill));
  }
  return [...out.values()];
}

function asSkill(skill: DiscoveredSkill): FileSkill {
  return {
    kind: "file",
    name: skill.name,
    description: skill.description,
    invocation: skill.name,
    path: skill.path,
    scope: skill.scope === "user" ? "user" : "project",
    source: skill.source === "monocode" ? "monocode" : skill.source,
  };
}

export function skillNamesInText(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  SKILL_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_TOKEN_RE.exec(text))) {
    const name = match[2];
    const start = match.index + (match[1]?.length ?? 0);
    if (!name || seen.has(name) || isMarkdownBlockquotePosition(text, start)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

export type SkillTextPart = {
  text: string;
  skill: boolean;
};

/** Split composer text so known `/skill` tokens can be highlighted. */
export function skillTextParts(
  text: string,
  names: ReadonlySet<string>,
): SkillTextPart[] {
  if (!text) return [];
  if (names.size === 0) return [{ text, skill: false }];

  const parts: SkillTextPart[] = [];
  const push = (value: string, skill: boolean) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && last.skill === skill) {
      last.text += value;
      return;
    }
    parts.push({ text: value, skill });
  };

  SKILL_TOKEN_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_TOKEN_RE.exec(text))) {
    const name = match[2];
    const lead = match[1] ?? "";
    const start = match.index + lead.length;
    if (
      !name ||
      !names.has(name) ||
      isMarkdownBlockquotePosition(text, start)
    ) {
      continue;
    }
    const end = start + 1 + name.length;
    push(text.slice(cursor, start), false);
    push(text.slice(start, end), true);
    cursor = end;
  }
  push(text.slice(cursor), false);
  return parts;
}

export function injectSkillPrompt(
  text: string,
  skills: Skill[],
  bodies: Record<string, string>,
): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    const body = bodies[skill.name]?.trim();
    if (!body) continue;
    blocks.push(`## /${skill.name}\n\n${body}`);
  }
  if (blocks.length === 0) return text;
  return [
    "The user invoked skill(s) with /name. Follow every instruction in each skill body.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
    "",
    text,
  ].join("\n");
}

export async function applySkillsToTurn(
  text: string,
  context: SkillCatalogContext,
): Promise<string> {
  if (hasNativeCommands(context.harness)) return text;
  const names = skillNamesInText(text);
  if (names.length === 0) return text;
  const catalog = await loadSkills(context);
  const picked: Array<FileSkill | BuiltinSkill> = [];
  for (const name of names) {
    const skill = catalog.find((item) => item.name === name);
    if (skill?.kind === "file" || skill?.kind === "builtin") {
      picked.push(skill);
    }
  }
  if (picked.length === 0) return text;
  const bodies: Record<string, string> = {};
  await Promise.all(
    picked.map(async (skill) => {
      bodies[skill.name] = await readSkillBody(skill);
    }),
  );
  return injectSkillPrompt(text, picked, bodies);
}

type SkillLoader = typeof loadSkills;

export function warmNativeSkills(
  context: SkillCatalogContext,
  load: SkillLoader = loadSkills,
): void {
  if (!listsNativeCommands(context.harness)) return;
  void load(context).catch(() => undefined);
}

export async function readSkillBody(
  skill: FileSkill | BuiltinSkill,
): Promise<string> {
  if (skill.kind === "builtin") return CREATE_SKILL_BODY;
  try {
    return await readTextFile(skill.path);
  } catch {
    return `Skill "${skill.name}" could not be read from ${skill.path}.`;
  }
}

export function slugSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && name.length <= 64;
}

export function titleFromSkillName(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function blankSkillMarkdown(name: string): string {
  const title = titleFromSkillName(name);
  const words = name.replace(/-/g, " ");
  return `---
name: ${name}
description: ${title}. Use when the user asks to ${words}.
---

# ${title}

## Instructions

`;
}

export async function createBlankSkill(input: {
  cwd: string;
  name: string;
  scope: "project" | "user";
}): Promise<string> {
  const name = slugSkillName(input.name);
  if (!isValidSkillName(name)) {
    throw new Error("Use a lowercase name with letters, numbers, and hyphens.");
  }
  const root =
    input.scope === "user" || !isLocalProject(input.cwd)
      ? await homeDir()
      : input.cwd;
  const relative = `.agents/skills/${name}`;
  await createPath(root, relative, true);
  const path = joinPath(root, `${relative}/SKILL.md`);
  await writeTextFile(path, blankSkillMarkdown(name));
  invalidateSkills({ cwd: input.cwd });
  invalidateProjectFiles(input.cwd);
  return path;
}
