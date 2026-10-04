import { randomUUID } from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { HostModelCatalog, HostProject, RemoteProvider, RuntimeMode } from "@monocode/core/session";
import { RUNTIME_MODES, RUNTIME_MODE_LABEL } from "@monocode/core/session";
import { RADII, TYPE } from "@monocode/design";
import { runtime } from "@/hosts/registry";
import { useHosts } from "@/hosts/store";
import { Body, Button, SectionLabel } from "@/ui/components";
import { useTokens } from "@/ui/theme";

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const t = useTokens();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        minHeight: 34,
        justifyContent: "center",
        borderRadius: RADII.sm,
        backgroundColor: selected ? t.selection.hover : t.fill.chip,
        borderWidth: 1,
        borderColor: selected ? t.border.focus : "transparent",
      }}
    >
      <Text style={{ color: selected ? t.content : t.contentAlpha(0.7), fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

/** New session (11 §11.19), minimal: machine, project, provider, model,
 * access, and the first message. One create, then the first send. */
export default function NewSession() {
  const t = useTokens();
  const { records, states } = useHosts();
  const [env, setEnv] = useState(records[0]?.env);
  const host = env ? runtime(env) : undefined;
  const [projects, setProjects] = useState<HostProject[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [folder, setFolder] = useState("");
  const [catalog, setCatalog] = useState<HostModelCatalog>();
  const [provider, setProvider] = useState<RemoteProvider>();
  const [model, setModel] = useState<string>();
  const [mode, setMode] = useState<RuntimeMode>("supervised");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const providers = (host?.record.lastWelcome?.providers ?? []) as RemoteProvider[];

  useEffect(() => {
    if (!host) return;
    host.request<HostProject[]>("projects.list").then((list) => {
      setProjects(list);
      setProjectId((current) => current ?? list[0]?.id);
    }).catch((failure) => setError(failure.message));
    setProvider((current) => current ?? (providers.includes("claude") ? "claude" : providers[0]));
  }, [host, states[env ?? ""]?.kind]);

  useEffect(() => {
    if (!host || !projectId) return;
    setCatalog(undefined);
    host.request<HostModelCatalog>("models.list", { projectId }, 60_000).then(setCatalog).catch((failure) => setError(`Couldn’t load models: ${failure.message}`));
  }, [host, projectId]);

  const models = useMemo(() => (provider ? catalog?.models[provider] ?? [] : []), [catalog, provider]);
  useEffect(() => {
    if (models.length && !models.some((item) => item.id === model)) setModel(models[0].id);
  }, [models, model]);

  const openFolder = async () => {
    if (!host || !folder.trim()) return;
    try {
      const project = await host.request<HostProject>("projects.open", { cwd: folder.trim() });
      setProjects((list) => (list.some((item) => item.id === project.id) ? list : [...list, project]));
      setProjectId(project.id);
      setFolder("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const start = async () => {
    if (!host || !projectId || !provider || !model || !prompt.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await host.request<{ sessionId: string }>(
        "commands.dispatch",
        { type: "create", commandId: randomUUID(), projectId, harness: provider, model, runtimeMode: mode },
        60_000,
      );
      await host.request("commands.dispatch", { type: "send", commandId: randomUUID(), sessionId: created.sessionId, text: prompt.trim() }, 60_000);
      router.replace({ pathname: "/m/[env]/s/[sessionId]", params: { env: env!, sessionId: created.sessionId } });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const project = projects.find((item) => item.id === projectId);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.base }} contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: t.content, fontSize: TYPE.emptyHeading.size, lineHeight: TYPE.emptyHeading.line, fontWeight: "500", marginBottom: 8 }}>
        What should we work on{project ? ` in ${project.name}` : ""}?
      </Text>
      {records.length > 1 ? (
        <>
          <SectionLabel>Machine</SectionLabel>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {records.map((record) => (
              <Chip key={record.env} label={record.label} selected={record.env === env} onPress={() => setEnv(record.env)} />
            ))}
          </View>
        </>
      ) : null}
      <SectionLabel>Project</SectionLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {projects.map((item) => (
          <Chip key={item.id} label={item.name} selected={item.id === projectId} onPress={() => setProjectId(item.id)} />
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          value={folder}
          onChangeText={setFolder}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Open folder on the machine: /Users/me/code/app"
          placeholderTextColor={t.text.faint}
          style={{ flex: 1, color: t.content, fontSize: 14, fontFamily: "Menlo", borderWidth: 1, borderColor: t.border.default, borderRadius: RADII.md, paddingHorizontal: 10, paddingVertical: 10 }}
        />
        <Button label="Open" variant="secondary" onPress={() => void openFolder()} disabled={!folder.trim()} />
      </View>
      <SectionLabel>Provider</SectionLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {providers.map((item) => (
          <Chip key={item} label={item} selected={item === provider} onPress={() => setProvider(item)} />
        ))}
      </View>
      <SectionLabel>Model</SectionLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {catalog ? (
          models.map((item) => <Chip key={item.id} label={item.name} selected={item.id === model} onPress={() => setModel(item.id)} />)
        ) : (
          <Body faint>{projectId ? "Loading models…" : "Choose a project first."}</Body>
        )}
        {catalog && provider && catalog.errors[provider] ? <Body faint>{catalog.errors[provider]}</Body> : null}
      </View>
      <SectionLabel>Access</SectionLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {RUNTIME_MODES.filter((item) => item !== "full-access").map((item) => (
          <Chip key={item} label={RUNTIME_MODE_LABEL[item]} selected={item === mode} onPress={() => setMode(item)} />
        ))}
      </View>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder="Ask, build, / for commands..."
        placeholderTextColor={t.text.faint}
        style={{
          marginTop: 16,
          minHeight: 96,
          color: t.content,
          fontSize: TYPE.composer.size,
          lineHeight: TYPE.composer.line,
          borderWidth: 1,
          borderColor: t.border.default,
          borderRadius: RADII.md,
          padding: 12,
          backgroundColor: t.fill.composer,
          textAlignVertical: "top",
        }}
      />
      {error ? <Text style={{ color: t.status.danger, fontSize: 13 }}>{error}</Text> : null}
      <Button label="Start" busy={busy} disabled={!projectId || !model || !prompt.trim()} onPress={() => void start()} style={{ marginTop: 8 }} />
    </ScrollView>
  );
}
