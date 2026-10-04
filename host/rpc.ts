// One method table for every way into the host: the desktop's HTTP `/rpc`
// and phone channels (spec 09 §9.2). Handlers are transport-independent.

import { hostname, homedir } from "node:os";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import {
  HOST_PROTOCOL_VERSION,
  type HostModelCatalog,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";
import type { HostEngine } from "./engine";
import { writeAttachmentChunk, readAttachmentChunk } from "./attachments";
import type { LinkedWorkItem } from "../src/features/sessions/model/session";
import { parseGithubWorkItemUrl } from "../src/features/sessions/model/sessionWorkItem";
import { SyncTransfers } from "./sync-transfer";
import { browseHostDirectories } from "./browse";
import { createHostBranch, hostBranches, switchHostBranch } from "./git-branches";
import { createHostWorktree, hostWorktrees, resolveHostWorktreeAsync } from "./git-worktrees";
import {
  createHostPath,
  hostFileDiff,
  hostGitAction,
  hostGitIndex,
  indexHostFiles,
  listHostFiles,
  readHostFile,
  searchHostContent,
  searchHostFiles,
  writeHostFile,
} from "./workspace";
import { WorkspaceCommands } from "./workspace-commands";
import { discoverCodexModels } from "../src/integrations/harness/providers/codex/codexCatalog";
import { discoverClaudeModels } from "../src/integrations/harness/providers/claude/claudeCatalog";
import { discoverCursorModels } from "../src/integrations/harness/providers/cursor/cursorCatalog";
import { discoverGrokModels } from "../src/integrations/harness/providers/grok/grokCatalog";
import { discoverOpenCodeModels } from "../src/integrations/harness/providers/opencode/opencodeCatalog";
import { discoverPiModels, discoverOmpModels } from "../src/integrations/harness/providers/pi/piCatalog";
import { discoverFxModels } from "../src/integrations/harness/providers/fx/fxCatalog";
import { discoverHermesModels } from "../src/integrations/harness/providers/hermes/hermesCatalog";
import { discoverAntigravityModels } from "../src/integrations/harness/providers/antigravity/antigravityCatalog";
import { setHarnessModels, type AgentModel } from "../src/features/sessions/model/models";
import {
  resolveAntigravityBinary,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveCursorBinary,
  resolveFxBinary,
  resolveGrokBinary,
  resolveHermesBinary,
  resolveOmpBinary,
  resolveOpenCodeBinary,
  resolvePiBinary,
} from "../src/integrations/harness/core/child";
import { HostError, toHostError } from "./errors";
import type { Principal, Role, Via } from "./devices";
import { DEFAULT_TAIL_TURNS } from "@monocode/core/window";

const exec = promisify(execFile);
// Providers also add models server-side, without a CLI update.
const CATALOG_MAX_AGE_MS = 5 * 60_000;
const resolveBinary: Record<RemoteProvider, () => Promise<{ path: string }>> = {
  codex: () => resolveCodexBinary(),
  claude: () => resolveClaudeBinary(),
  cursor: () => resolveCursorBinary(),
  grok: () => resolveGrokBinary(),
  opencode: () => resolveOpenCodeBinary(),
  pi: () => resolvePiBinary(),
  omp: () => resolveOmpBinary(),
  fx: () => resolveFxBinary(),
  hermes: () => resolveHermesBinary(),
  antigravity: () => resolveAntigravityBinary(),
};
const discoverModels: Record<RemoteProvider, (cwd: string) => Promise<AgentModel[]>> = {
  codex: discoverCodexModels,
  claude: discoverClaudeModels,
  cursor: discoverCursorModels,
  grok: discoverGrokModels,
  opencode: discoverOpenCodeModels,
  pi: discoverPiModels,
  omp: discoverOmpModels,
  fx: discoverFxModels,
  hermes: discoverHermesModels,
  antigravity: discoverAntigravityModels,
};

/** Capabilities `environment.describe` has always listed. */
export const BASE_CAPABILITIES = [
  "sessions",
  "projects.browse",
  "models.list",
  "approvals",
  "questions",
  "diff",
  "git.branches",
  "git.switch",
  "git.createBranch",
  "git.worktrees",
  "git.worktreeCreate",
  "files.read",
  "files.list",
  "files.index",
  "workspace.run",
  "files.search",
  "files.searchContent",
  "files.create",
  "files.write",
  "git.index",
  "git.fileDiff",
  "git.action",
  "attachments.upload",
  "attachments.read",
  "sessions.draft",
  "sessions.plan",
];

/** Added for phones; listed in the channel welcome (spec 06 §6.4). */
export const CHANNEL_CAPABILITIES = [
  "channel.watch",
  "sessions.window",
  "sessions.page",
  "inbox",
  "devices",
];

export type CallContext = {
  principal: Principal;
  transport: Via;
  /** The connection itself, for channel-only methods. */
  channel?: unknown;
};

export type MethodSpec = {
  kind: "read" | "mutating" | "command";
  roles: Role[];
  /** Large results go to the lowest-priority queue on a channel. */
  bulk?: boolean;
  /** Only callable on a phone channel (watch.set, pair.claim). */
  channelOnly?: boolean;
  handler: (params: Record<string, unknown>, ctx: CallContext) => unknown;
};

const ANY: Role[] = ["admin", "member"];
const ADMIN: Role[] = ["admin"];

/** Providers this host has, limited to the ones the client can render. */
export function clientProviders(available: RemoteProvider[], supported: unknown): RemoteProvider[] {
  return available.filter((provider) =>
    Array.isArray(supported)
      ? supported.includes(provider)
      : // Older clients validate this list against Codex and Claude only.
        provider === "codex" || provider === "claude",
  );
}

/** Identifies each installed provider CLI. An update changes its real path or
 * modification time, which invalidates the catalog the old version reported. */
async function providerBinaries(providers: RemoteProvider[]): Promise<string> {
  const binaries = await Promise.all(
    providers.map(async (provider) => {
      try {
        const file = await realpath((await resolveBinary[provider]()).path);
        return `${file}:${(await stat(file)).mtimeMs}`;
      } catch {
        return "";
      }
    }),
  );
  return binaries.join("\n");
}

const optionalCount = (value: unknown, fallback: number) =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;

export function createHostRpc(engine: HostEngine, providers: RemoteProvider[]) {
  const catalogs = new Map<
    string,
    { binaries: string; probed: number; catalog: Promise<HostModelCatalog> }
  >();
  const transfers = new SyncTransfers();
  const workspace = new WorkspaceCommands(engine.store, (projectId, action) =>
    engine.withIdleProject(projectId, action),
  );
  const store = engine.store;
  const project = (params: Record<string, unknown>) => store.project(String(params.projectId ?? ""));
  const projectCwd = async (params: Record<string, unknown>) =>
    resolveHostWorktreeAsync(project(params).cwd, params.cwd);

  const models = async (projectId?: unknown) => {
    const cwd = typeof projectId === "string" ? store.project(projectId).cwd : homedir();
    const binaries = await providerBinaries(providers);
    const cached = catalogs.get(cwd);
    let catalog =
      cached?.binaries === binaries && Date.now() - cached.probed < CATALOG_MAX_AGE_MS
        ? cached.catalog
        : undefined;
    if (!catalog) {
      catalog = (async () => {
        const result: HostModelCatalog = { models: {}, errors: {} };
        await Promise.all(
          providers.map(async (provider) => {
            try {
              const discovered = await discoverModels[provider](cwd);
              result.models[provider] = discovered;
              if (discovered.length) setHarnessModels(provider, discovered);
            } catch (error) {
              result.errors[provider] = error instanceof Error ? error.message : String(error);
            }
          }),
        );
        return result;
      })().then(
        (result) => {
          if (Object.keys(result.errors).length && catalogs.get(cwd)?.catalog === catalog)
            catalogs.delete(cwd);
          return result;
        },
        (error) => {
          if (catalogs.get(cwd)?.catalog === catalog) catalogs.delete(cwd);
          throw error;
        },
      );
      catalogs.set(cwd, { binaries, probed: Date.now(), catalog });
    }
    return catalog;
  };

  const methods: Record<string, MethodSpec> = {
    "environment.describe": {
      kind: "read",
      roles: ANY,
      handler: (params) => ({
        protocolVersion: HOST_PROTOCOL_VERSION,
        environmentId: store.environmentId,
        name: hostname(),
        platform: process.platform,
        providers: clientProviders(providers, params.supportedProviders),
        capabilities: BASE_CAPABILITIES,
      }),
    },
    "projects.list": { kind: "read", roles: ANY, handler: () => store.projects() },
    "projects.browse": {
      kind: "read",
      roles: ANY,
      handler: (params) => browseHostDirectories(params.path),
    },
    "projects.open": {
      kind: "mutating",
      roles: ANY,
      handler: (params) => engine.openProject(String(params.cwd ?? "")),
    },
    "models.list": { kind: "read", roles: ANY, handler: (params) => models(params.projectId) },
    "sessions.list": {
      kind: "read",
      roles: ANY,
      handler: async (params) => {
        const projectId = String(params.projectId ?? "");
        const owner = store.project(projectId);
        const summaries = store.summaries(projectId);
        const paths = [...new Set(summaries.map((session) => session.cwd ?? owner.cwd))];
        const branches = new Map(
          await Promise.all(
            paths.map(async (cwd) => {
              const branch = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
                cwd,
                timeout: 2_000,
              })
                .then(({ stdout }) => stdout.trim())
                .catch(() => "");
              return [cwd, branch] as const;
            }),
          ),
        );
        return summaries.map((session) => ({
          ...session,
          repo: owner.name,
          branch: branches.get(session.cwd ?? owner.cwd) || undefined,
          worktreeCwd: session.cwd && session.cwd !== owner.cwd ? session.cwd : undefined,
        }));
      },
    },
    "sessions.page": {
      kind: "read",
      roles: ANY,
      handler: (params) =>
        store.page(String(params.projectId ?? ""), {
          archived:
            params.archived === "only" || params.archived === "include"
              ? params.archived
              : "exclude",
          limit: optionalCount(params.limit, 50),
          cursor: typeof params.cursor === "string" ? params.cursor : undefined,
        }),
    },
    "inbox.list": {
      kind: "read",
      roles: ANY,
      handler: (params) => ({ boot: BOOT_ID, ...store.inbox(optionalCount(params.limit, 200)) }),
    },
    "sessions.update": {
      kind: "mutating",
      roles: ANY,
      handler: (params) => {
        const sessionId = String(params.sessionId ?? "");
        const current = store.session(sessionId);
        if (current.projectId !== params.projectId)
          throw new Error("Session does not belong to this project");
        const patch: {
          title?: string;
          archived?: boolean;
          pinned?: boolean;
          linkedWorkItem?: LinkedWorkItem | null;
        } = {};
        if (params.title !== undefined) {
          if (typeof params.title !== "string") throw new Error("Invalid session title");
          patch.title = params.title;
        }
        if (params.archived !== undefined) {
          if (typeof params.archived !== "boolean") throw new Error("Invalid archive value");
          patch.archived = params.archived;
        }
        if (params.pinned !== undefined) {
          if (typeof params.pinned !== "boolean") throw new Error("Invalid pin value");
          patch.pinned = params.pinned;
        }
        if (params.linkedWorkItem !== undefined) {
          const item = params.linkedWorkItem;
          const parsed =
            item && typeof item === "object" && !Array.isArray(item)
              ? parseGithubWorkItemUrl(String((item as LinkedWorkItem).url ?? ""))
              : null;
          if (
            item !== null &&
            (typeof item !== "object" ||
              Array.isArray(item) ||
              !parsed ||
              parsed.kind !== (item as LinkedWorkItem).kind ||
              parsed.repo !== (item as LinkedWorkItem).repo ||
              parsed.number !== (item as LinkedWorkItem).number ||
              parsed.url !== (item as LinkedWorkItem).url)
          )
            throw new Error("Invalid linked work item");
          patch.linkedWorkItem = item as LinkedWorkItem | null;
        }
        if (Object.keys(patch).length === 0) throw new Error("No session changes supplied");
        return engine.updateSession(sessionId, patch);
      },
    },
    "sessions.delete": {
      kind: "mutating",
      roles: ANY,
      handler: (params) => {
        const sessionId = String(params.sessionId ?? "");
        const current = store.session(sessionId);
        if (current.projectId !== params.projectId)
          throw new Error("Session does not belong to this project");
        store.deleteSession(sessionId);
        return { deleted: true };
      },
    },
    "sessions.sync": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: (params) => {
        const sessionId = String(params.sessionId ?? "");
        const revision = Number.isSafeInteger(params.revision) ? Number(params.revision) : undefined;
        // No window keeps exactly the desktop's behaviour.
        if (params.window === undefined && params.maxBlockChars === undefined)
          return transfers.respond(sessionId, store.sync(sessionId, revision));
        const window =
          params.window && typeof params.window === "object" && !Array.isArray(params.window)
            ? (params.window as { anchor?: unknown; tailTurns?: unknown })
            : {};
        return store.windowedSync(
          sessionId,
          revision,
          {
            ...(typeof window.anchor === "string" ? { anchor: window.anchor } : {}),
            tailTurns: optionalCount(window.tailTurns, DEFAULT_TAIL_TURNS),
          },
          optionalCount(params.maxBlockChars, 0) || undefined,
        );
      },
    },
    "sessions.blocks": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: (params) =>
        store.olderBlocks(
          String(params.sessionId ?? ""),
          String(params.before ?? ""),
          optionalCount(params.turns, DEFAULT_TAIL_TURNS),
          optionalCount(params.maxBlockChars, 0) || undefined,
        ),
    },
    "sessions.block": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: (params) => store.block(String(params.sessionId ?? ""), String(params.blockId ?? "")),
    },
    "sessions.syncChunk": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: (params) =>
        transfers.chunk(
          String(params.sessionId ?? ""),
          String(params.transfer ?? ""),
          Number(params.offset),
        ),
    },
    "sessions.get": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: (params) => {
        const value = store.session(String(params.sessionId ?? ""));
        return value.revision === params.revision ? null : value;
      },
    },
    "events.read": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: (params) => {
        if (!Number.isSafeInteger(params.after) || Number(params.after) < 0)
          throw new Error("Invalid event cursor");
        return store.events(String(params.sessionId ?? ""), Number(params.after));
      },
    },
    "commands.dispatch": {
      kind: "command",
      roles: ANY,
      handler: (params) => engine.command(params),
    },
    "attachments.upload": {
      kind: "mutating",
      roles: ANY,
      handler: (params) => writeAttachmentChunk(store, params),
    },
    "attachments.read": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: (params) => readAttachmentChunk(store, params),
    },
    "devices.revokeSelf": {
      kind: "mutating",
      roles: ANY,
      // Only the caller's own credential. Sessions and other devices are
      // unaffected; the host keeps running.
      handler: (_params, ctx) => ({ revoked: store.devices.revoke(ctx.principal.deviceId, ctx.principal.deviceId) }),
    },
    "devices.list": {
      kind: "read",
      roles: ANY,
      handler: (_params, ctx) => {
        const all = store.devices.list(ctx.principal.deviceId);
        return ctx.principal.role === "admin" ? all : all.filter((device) => device.current);
      },
    },
    "devices.rename": {
      kind: "mutating",
      roles: ANY,
      handler: (params, ctx) => {
        const deviceId = String(params.deviceId ?? "");
        if (ctx.principal.role !== "admin" && deviceId !== ctx.principal.deviceId)
          throw new HostError("forbidden", "Only an admin can rename other devices");
        store.devices.rename(deviceId, String(params.name ?? ""));
        return store.devices.get(deviceId, ctx.principal.deviceId);
      },
    },
    "devices.revoke": {
      kind: "mutating",
      roles: ANY,
      handler: (params, ctx) => {
        const deviceId = String(params.deviceId ?? "");
        if (ctx.principal.role !== "admin" && deviceId !== ctx.principal.deviceId)
          throw new HostError("forbidden", "Only an admin can remove other devices");
        return { revoked: store.devices.revoke(deviceId, ctx.principal.deviceId) };
      },
    },
    "devices.events": {
      kind: "read",
      roles: ADMIN,
      handler: (params) => store.devices.events(optionalCount(params.limit, 100)),
    },
    "git.diff": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: async (params) => {
        const diff = await exec(
          "git",
          ["-c", "core.pager=cat", "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
          { cwd: await projectCwd(params), timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
        );
        return diff.stdout;
      },
    },
    "git.branches": {
      kind: "read",
      roles: ANY,
      handler: async (params) => hostBranches(await projectCwd(params)),
    },
    "git.switch": {
      kind: "mutating",
      roles: ANY,
      handler: async (params) => {
        const owner = project(params);
        const cwd = await resolveHostWorktreeAsync(owner.cwd, params.cwd);
        return engine.withIdleProject(owner.id, () =>
          switchHostBranch(cwd, params.branch, params.remote),
        );
      },
    },
    "git.createBranch": {
      kind: "mutating",
      roles: ANY,
      handler: async (params) => {
        const owner = project(params);
        const cwd = await resolveHostWorktreeAsync(owner.cwd, params.cwd);
        return engine.withIdleProject(owner.id, () => createHostBranch(cwd, params.branch));
      },
    },
    "git.worktrees": {
      kind: "read",
      roles: ANY,
      handler: (params) => hostWorktrees(project(params).cwd),
    },
    "git.worktreeCreate": {
      kind: "mutating",
      roles: ANY,
      handler: async (params) => {
        const owner = project(params);
        const cwd = await resolveHostWorktreeAsync(owner.cwd, params.cwd);
        const result = await engine.withIdleProject(owner.id, () =>
          createHostWorktree(owner.cwd, params.branch, params.base, params.existing, cwd),
        );
        workspace.invalidateRoots();
        return result;
      },
    },
    "files.read": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: async (params) => readHostFile(await projectCwd(params), params.path),
    },
    "files.list": {
      kind: "read",
      roles: ANY,
      handler: async (params) => listHostFiles(await projectCwd(params), params.path),
    },
    "files.index": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: async (params) => indexHostFiles(await projectCwd(params)),
    },
    "workspace.run": {
      kind: "mutating",
      roles: ANY,
      handler: async (params) => (await workspace.run(params.command, params.args)) ?? null,
    },
    "files.search": {
      kind: "read",
      roles: ANY,
      handler: async (params) => searchHostFiles(await projectCwd(params), params.query),
    },
    "files.searchContent": {
      kind: "read",
      roles: ANY,
      handler: async (params) => searchHostContent(await projectCwd(params), params),
    },
    "files.create": {
      kind: "mutating",
      roles: ANY,
      handler: async (params) =>
        createHostPath(await projectCwd(params), params.parent, params.name, params.isDir),
    },
    "files.write": {
      kind: "mutating",
      roles: ANY,
      handler: async (params) =>
        (await writeHostFile(await projectCwd(params), params.path, params.expected, params.content)) ??
        null,
    },
    "git.index": {
      kind: "read",
      roles: ANY,
      handler: async (params) => hostGitIndex(await projectCwd(params)),
    },
    "git.fileDiff": {
      kind: "read",
      roles: ANY,
      bulk: true,
      handler: async (params) =>
        hostFileDiff(await projectCwd(params), params.path, params.staged === true),
    },
    "git.action": {
      kind: "mutating",
      roles: ANY,
      handler: async (params) => {
        const owner = project(params);
        const cwd = await resolveHostWorktreeAsync(owner.cwd, params.cwd);
        return (
          (await engine.withIdleProject(owner.id, () =>
            hostGitAction(cwd, params.action, params.path, params.message, params.content),
          )) ?? null
        );
      },
    },
  };

  return {
    methods,
    register(name: string, spec: MethodSpec): void {
      methods[name] = spec;
    },
    /** Looks up, checks the caller's role, runs, and maps errors to codes. */
    async dispatch(method: string, params: Record<string, unknown>, ctx: CallContext): Promise<unknown> {
      const spec = Object.hasOwn(methods, method) ? methods[method] : undefined;
      try {
        if (!spec || (spec.channelOnly && ctx.transport === "http"))
          throw new HostError("method_not_found", "Unsupported host method");
        if (!spec.roles.includes(ctx.principal.role))
          throw new HostError("forbidden", "This device can't do that on this host");
        return await spec.handler(params, ctx);
      } catch (error) {
        throw toHostError(error);
      }
    },
  };
}

export type HostRpc = ReturnType<typeof createHostRpc>;

/** Random per host process; phones compare `(boot, revision)`. */
export const BOOT_ID = crypto.randomUUID();
