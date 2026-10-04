import { randomUUID } from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CreateWorktree, HostCommand, HostProject, RemoteProvider } from "@monocode/core/session";
import { HARNESS_LABEL } from "@monocode/core/session";
import { RADII, TYPE } from "@monocode/design";
import { useCatalog } from "@/compose/catalog";
import { Composer, type SendInput } from "@/compose/Composer";
import { mergeSettings, type ComposerConfig } from "@/compose/models";
import { runtime } from "@/hosts/registry";
import type { HostRuntime } from "@/hosts/runtime";
import { hostDot } from "@/hosts/status";
import { useHosts } from "@/hosts/store";
import { enqueue, LOCAL_PREFIX, mutate, newCommandId } from "@/outbox";
import { openCache } from "@/storage/cache";
import { useProjects, watchProjects } from "@/sync/projects";
import { Button } from "@/ui/components";
import { Icon, type IconName } from "@/ui/icon";
import { Sheet, SheetCaption, SheetRow } from "@/ui/sheet";
import { useTokens } from "@/ui/theme";

type Branches = { current: string | null; branches: string[] };
/** `git.worktrees` (the desktop's `HostWorktree`). */
type Worktree = { path: string; branch: string | null; head: string; isMain: boolean; missing: boolean };
/** Last machine and project, and the model and access per project (11 §11.19). */
type Remembered = { env?: string; projectId?: string; configs: Record<string, ComposerConfig> };

const REMEMBERED_KEY = "newSession";

/** A read from the host for the current inputs; undefined until it answers. */
function useHostRead<T>(host: HostRuntime | undefined, method: string, params: Record<string, unknown> | undefined): T | undefined {
  const json = params ? JSON.stringify(params) : undefined;
  const key = host && json ? `${host.env}|${method}|${json}` : "";
  const [result, setResult] = useState<{ key: string; value: T }>();
  useEffect(() => {
    if (!host || !json) return;
    let live = true;
    host
      .request<T>(method, JSON.parse(json) as Record<string, unknown>, 60_000)
      .then((value) => {
        if (live) setResult({ key: `${host.env}|${method}|${json}`, value });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [host, method, json]);
  return result?.key === key ? result.value : undefined;
}

function TopBarItem({ icon, label, onPress, mono }: { icon: IconName; label: string; onPress?: () => void; mono?: boolean }) {
  const t = useTokens();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10 }}
      style={{ flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 220 }}
    >
      <Icon name={icon} size={12} color={t.text.secondary} />
      <Text
        numberOfLines={1}
        style={{ color: t.contentAlpha(onPress ? 0.7 : 0.55), fontSize: TYPE.meta.size, fontFamily: mono ? Platform.select({ ios: "Menlo", default: "monospace" }) : undefined }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** New session (11 §11.19): the desktop's empty session with the quick
 * composer. Send writes one `create` with `initial` and `worktree` to the
 * outbox and docks into the session, which shows the first message at once. */
export default function NewSession() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const records = useHosts((state) => state.records);
  const states = useHosts((state) => state.states);
  // The Project screen's + preselects its machine and project (11 §11.10).
  const params = useLocalSearchParams<{ env?: string; projectId?: string }>();
  const [remembered, setRemembered] = useState<Remembered>({ configs: {} });
  const [chosenEnv, setChosenEnv] = useState<string>();
  const [chosenProject, setChosenProject] = useState<string>();
  const [chosenConfig, setChosenConfig] = useState<ComposerConfig>();
  const [worktree, setWorktree] = useState<CreateWorktree>({ mode: "current" });
  const [sheet, setSheet] = useState<"place" | "workspace" | "branch">();
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void openCache().then(async (cache) => {
      const value = await cache?.drafts.get<Remembered>("app", REMEMBERED_KEY).catch(() => undefined);
      if (live && value) setRemembered({ ...value, configs: value.configs ?? {} });
    });
    return () => {
      live = false;
    };
  }, []);

  const env =
    chosenEnv ??
    params.env ??
    (remembered.env && records.some((record) => record.env === remembered.env) ? remembered.env : undefined) ??
    records[0]?.env;
  const host = env ? runtime(env) : undefined;
  const record = records.find((item) => item.env === env);
  // Reloads whenever the machine comes online.
  useEffect(() => (env ? watchProjects(env) : undefined), [env]);
  const projects: HostProject[] = useProjects((state) => (env ? state.hosts[env]?.projects : undefined)) ?? [];
  const projectId =
    chosenProject ??
    (params.env === env ? params.projectId : undefined) ??
    (remembered.env === env && projects.some((project) => project.id === remembered.projectId) ? remembered.projectId : undefined) ??
    projects[0]?.id;
  const project = projects.find((item) => item.id === projectId);

  const catalog = useCatalog(host, projectId);
  const providers = (host?.record.lastWelcome?.providers ?? []) as RemoteProvider[];
  const rememberedConfig = env && projectId ? remembered.configs[`${env}/${projectId}`] : undefined;
  const config = chosenConfig ?? (rememberedConfig && providers.includes(rememberedConfig.harness) ? rememberedConfig : defaultConfig(providers, catalog.catalog));

  const worktrees = useHostRead<Worktree[]>(host, "git.worktrees", projectId ? { projectId } : undefined);
  const branches = useHostRead<Branches>(host, "git.branches", projectId ? { projectId } : undefined);
  const existing = (worktrees ?? []).filter((item) => !item.isMain && !item.missing);
  const createWithPrompt = !!host?.has("sessions.createWithPrompt");

  const pickEnv = (next: string) => {
    setChosenEnv(next);
    setChosenProject(undefined);
    setChosenConfig(undefined);
    setWorktree({ mode: "current" });
  };
  const pickProject = (next: string) => {
    setChosenProject(next);
    setChosenConfig(undefined);
    setWorktree({ mode: "current" });
    setSheet(undefined);
  };

  const openFolder = async () => {
    if (!host || !folder.trim()) return;
    try {
      const opened = await mutate<HostProject>(host, "projects.open", { cwd: folder.trim() });
      useProjects.setState((state) => {
        const current = state.hosts[host.env] ?? { projects: [], freshness: "live" as const, loading: false };
        const projects = current.projects.some((item) => item.id === opened.id) ? current.projects : [...current.projects, opened];
        return { hosts: { ...state.hosts, [host.env]: { ...current, projects } } };
      });
      setFolder("");
      pickProject(opened.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const start = ({ text, attachments, mode }: SendInput): boolean => {
    if (!host || !env || !projectId || !config) return false;
    if (!createWithPrompt && worktree.mode === "new") {
      setError("Update this machine’s host to start in a new worktree from your phone.");
      return false;
    }
    const commandId = newCommandId();
    const local = `${LOCAL_PREFIX}${randomUUID()}`;
    const base = {
      type: "create" as const,
      commandId,
      projectId,
      harness: config.harness,
      model: config.model,
      modelSettings: config.modelSettings,
      runtimeMode: config.runtimeMode,
    };
    const intent = mode === "plan" ? "plan" : "default";
    if (createWithPrompt) {
      const create: HostCommand = {
        ...base,
        worktree,
        initial: { text: text.trim(), ...(attachments.length ? { attachments } : {}), intent },
      };
      void enqueue(env, create, { localSessionId: local });
    } else {
      // Older hosts: a plain create, then the first message once it exists.
      const create: HostCommand = { ...base, ...(worktree.mode === "existing" ? { worktreeCwd: worktree.cwd } : {}) };
      void enqueue(env, create, { localSessionId: local }).then(() =>
        enqueue(
          env,
          {
            type: "send",
            commandId: newCommandId(),
            sessionId: local,
            text: text.trim(),
            ...(attachments.length ? { attachments } : {}),
            ...(mode === "plan" ? { intent: "plan" as const } : {}),
          },
          { localSessionId: local, dependsOn: commandId },
        ),
      );
    }
    const next: Remembered = { env, projectId, configs: { ...remembered.configs, [`${env}/${projectId}`]: config } };
    void openCache().then((cache) => cache?.drafts.put("app", REMEMBERED_KEY, next).catch(() => undefined));
    router.replace({ pathname: "/m/[env]/s/[sessionId]", params: { env, sessionId: local } });
    return true;
  };

  const workspaceLabel =
    worktree.mode === "new"
      ? "New worktree"
      : worktree.mode === "existing"
        ? `Worktree · ${existing.find((item) => item.path === worktree.cwd)?.branch ?? worktree.cwd.split("/").pop()}`
        : "Current checkout";
  const branchLabel = worktree.mode === "new" ? (worktree.base ?? branches?.current ?? "HEAD") : (worktree.mode === "existing" ? undefined : branches?.current);
  const harnessName = config ? HARNESS_LABEL[config.harness] : undefined;

  const topBar = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 6, paddingHorizontal: 2 }}>
      <TopBarItem icon="folder" label={[project?.name ?? "Choose a project", record?.label].filter(Boolean).join(" · ")} onPress={() => setSheet("place")} />
      {project ? (
        <TopBarItem icon={worktree.mode === "current" ? "folder" : "folder.badge.gearshape"} label={workspaceLabel} onPress={() => setSheet("workspace")} />
      ) : null}
      {project && branchLabel ? (
        <TopBarItem icon="arrow.triangle.branch" label={branchLabel} mono onPress={worktree.mode === "new" ? () => setSheet("branch") : undefined} />
      ) : null}
    </View>
  );

  const providerError = config ? catalog.catalog?.errors[config.harness] : undefined;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.base }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top + 44}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingVertical: 24 }} keyboardShouldPersistTaps="handled">
        <Text
          style={{
            color: t.content,
            fontSize: TYPE.emptyHeading.size,
            lineHeight: TYPE.emptyHeading.line,
            fontWeight: "500",
            textAlign: "center",
            paddingHorizontal: 24,
            marginBottom: 20,
          }}
        >
          What should we work on{project ? ` in ${project.name}` : ""}?
        </Text>
        {!records.length ? (
          <View style={{ paddingHorizontal: 24 }}>
            <Button label="Pair with a computer" onPress={() => router.replace("/pair")} />
          </View>
        ) : (
          <Composer
            key={`${env}/${projectId ?? ""}`}
            host={host}
            draftKey={`new:${projectId ?? ""}`}
            projectId={projectId}
            config={config}
            onConfig={setChosenConfig}
            providers={providers}
            harnessLocked={false}
            running={false}
            canQueue={false}
            onSend={start}
            topBar={topBar}
            isNew
            emptyPlaceholder={harnessName && project ? `Start a ${harnessName} session in ${project.name}…` : undefined}
          />
        )}
        {error || providerError || (!providers.length && record) ? (
          <Text style={{ color: t.status.danger, fontSize: 13, paddingHorizontal: 20, paddingTop: 10 }}>
            {error ??
              providerError ??
              `No agents found on ${record?.label}. Install one on ${record?.label}, or restart the host if it is already installed.`}
          </Text>
        ) : null}
      </ScrollView>

      <Sheet visible={sheet === "place"} onClose={() => setSheet(undefined)} title="Machine and project">
        {records.length > 1 ? <SheetCaption>Machines</SheetCaption> : null}
        {records.length > 1
          ? records.map((item) => (
              <SheetRow
                key={item.env}
                icon="desktopcomputer"
                iconColor={hostDot(states[item.env]) === "online" ? t.status.done : t.contentAlpha(0.45)}
                label={item.label}
                checked={item.env === env}
                onPress={() => pickEnv(item.env)}
              />
            ))
          : null}
        <SheetCaption>Projects on {record?.label}</SheetCaption>
        {projects.map((item) => (
          <SheetRow key={item.id} icon="folder" label={item.name} hint={item.cwd} checked={item.id === projectId} onPress={() => pickProject(item.id)} />
        ))}
        <SheetCaption>Open folder on a machine…</SheetCaption>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingHorizontal: 16 }}>
          <TextInput
            value={folder}
            onChangeText={setFolder}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="/Users/me/code/app"
            placeholderTextColor={t.text.faint}
            style={{
              flex: 1,
              color: t.content,
              fontSize: 14,
              fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
              borderWidth: 1,
              borderColor: t.border.default,
              borderRadius: RADII.md,
              paddingHorizontal: 10,
              paddingVertical: 10,
            }}
          />
          <Button label="Open" variant="secondary" onPress={() => void openFolder()} disabled={!folder.trim()} />
        </View>
      </Sheet>

      <Sheet visible={sheet === "workspace"} onClose={() => setSheet(undefined)} title="Workspace">
        <SheetRow
          icon="folder"
          label="Current checkout"
          hint={branches?.current ?? undefined}
          checked={worktree.mode === "current"}
          onPress={() => {
            setWorktree({ mode: "current" });
            setSheet(undefined);
          }}
        />
        {existing.map((item) => (
          <View key={item.path} style={{ paddingLeft: 20 }}>
            <SheetRow
              icon="folder.badge.gearshape"
              label={item.branch ?? item.path.split("/").pop() ?? item.path}
              hint={item.path}
              checked={worktree.mode === "existing" && worktree.cwd === item.path}
              onPress={() => {
                setWorktree({ mode: "existing", cwd: item.path });
                setSheet(undefined);
              }}
            />
          </View>
        ))}
        <SheetRow
          icon="plus.rectangle.on.folder"
          label="New worktree"
          hint={createWithPrompt ? "A fresh worktree on a new branch" : "Update this machine’s host to create worktrees from your phone"}
          disabled={!createWithPrompt}
          checked={worktree.mode === "new"}
          onPress={() => {
            setWorktree({ mode: "new", ...(branches?.current ? { base: branches.current } : {}) });
            setSheet(undefined);
          }}
        />
      </Sheet>

      <Sheet visible={sheet === "branch"} onClose={() => setSheet(undefined)} title="Base branch">
        {(branches?.branches ?? []).map((branch) => (
          <SheetRow
            key={branch}
            icon="arrow.triangle.branch"
            label={branch}
            hint={branch === branches?.current ? "Current branch" : undefined}
            checked={worktree.mode === "new" && (worktree.base ?? branches?.current) === branch}
            onPress={() => {
              setWorktree({ mode: "new", base: branch });
              setSheet(undefined);
            }}
          />
        ))}
        {!branches ? <SheetCaption>Loading branches…</SheetCaption> : null}
      </Sheet>
    </KeyboardAvoidingView>
  );
}

/** Claude when installed, else the first provider; its first model. */
function defaultConfig(providers: RemoteProvider[], catalog: ReturnType<typeof useCatalog>["catalog"]): ComposerConfig | undefined {
  const harness = providers.includes("claude") ? "claude" : providers[0];
  const model = harness ? catalog?.models[harness]?.[0] : undefined;
  if (!harness || !model) return undefined;
  return { harness, model: model.id, modelSettings: mergeSettings(model), runtimeMode: "supervised" };
}
