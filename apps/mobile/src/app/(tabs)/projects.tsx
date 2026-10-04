import { FlashList } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { projectColor, TYPE } from "@monocode/design";
import type { HostProject } from "@monocode/core/session";
import { pinKey, usePins } from "@/hosts/pins";
import { hostDot, hostNotice, useReconnecting } from "@/hosts/status";
import { useAgents, useHosts } from "@/hosts/store";
import type { HostConnState, HostRecord } from "@/hosts/types";
import { useProjects, watchProjects } from "@/sync/projects";
import { Body, Button, SearchField, SectionLabel, Title } from "@/ui/components";
import { useTokens } from "@/ui/theme";

type Row =
  | { type: "label"; key: string; title: string }
  | { type: "machine"; key: string; record: HostRecord }
  | { type: "project"; key: string; env: string; project: HostProject; working: number; pinned: boolean };

// Fixed row heights (11 §11.13); FlashList never waits on layout to place them.
const LABEL_HEIGHT = 42;
const MACHINE_HEIGHT = 44;
const PROJECT_HEIGHT = 52;

function openFolder() {
  router.push("/new");
}

function chooseAction(title: string, options: { label: string; run: () => void }[]) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...options.map((option) => option.label), "Cancel"], cancelButtonIndex: options.length },
      (index) => options[index]?.run(),
    );
    return;
  }
  Alert.alert(title, undefined, [...options.map((option) => ({ text: option.label, onPress: option.run })), { text: "Cancel", style: "cancel" }]);
}

function MachineRow({ record, state }: { record: HostRecord; state: HostConnState | undefined }) {
  const t = useTokens();
  const reconnecting = useReconnecting(state);
  const dot = hostDot(state);
  const color = dot === "online" ? t.status.done : dot === "connecting" ? t.status.attention : t.contentAlpha(0.35);
  const note = reconnecting ? "Reconnecting…" : state?.kind === "offline" ? "Offline" : state?.kind === "blocked" ? "Unavailable" : "";
  return (
    <View style={{ height: MACHINE_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 8 }}>
      <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color }} />
      <Text numberOfLines={1} style={{ flex: 1, color: t.text.secondary, fontSize: TYPE.secondary.size, fontWeight: "500" }}>
        {record.label}
      </Text>
      {note ? <Text style={{ color: t.text.faint, fontSize: TYPE.meta.size }}>{note}</Text> : null}
    </View>
  );
}

function ProjectRow({ row, hostLabel }: { row: Extract<Row, { type: "project" }>; hostLabel: string }) {
  const t = useTokens();
  const toggle = usePins((state) => state.toggle);
  const { env, project } = row;
  const menu = () =>
    chooseAction(project.name, [
      { label: row.pinned ? "Unpin" : "Pin", run: () => toggle(pinKey(env, project.id)) },
      { label: "New session", run: () => router.push({ pathname: "/new", params: { env, projectId: project.id } }) },
      { label: "Copy path", run: () => void Clipboard.setStringAsync(project.cwd) },
    ]);
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/m/[env]/p/[projectId]", params: { env, projectId: project.id } })}
      onLongPress={menu}
      accessibilityRole="button"
      accessibilityLabel={`${project.name} on ${hostLabel}${row.working ? `, ${row.working} working` : ""}`}
      style={({ pressed }) => ({
        height: PROJECT_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        opacity: pressed || row.working ? 1 : 0.65,
      })}
    >
      {/* The mascot slot: the project's colour until mascots ship as assets. */}
      <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: projectColor(project.id) }} />
      </View>
      <Text numberOfLines={1} style={{ flex: 1, color: t.content, fontSize: TYPE.row.size, lineHeight: TYPE.row.line, fontWeight: "500" }}>
        {project.name}
      </Text>
      {row.working ? (
        <Text style={{ color: t.accent, fontSize: TYPE.meta.size, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{row.working} working</Text>
      ) : null}
    </Pressable>
  );
}

/** The phone's project rail (11 §11.13): every machine's projects. */
export default function Projects() {
  const t = useTokens();
  const records = useHosts((state) => state.records);
  const states = useHosts((state) => state.states);
  const hosts = useProjects((state) => state.hosts);
  const agents = useAgents((state) => state.items);
  const pins = usePins((state) => state.pins);
  const [query, setQuery] = useState("");
  const envs = records.map((record) => record.env).join(",");

  useEffect(() => {
    const stops = envs ? envs.split(",").map((env) => watchProjects(env)) : [];
    return () => stops.forEach((stop) => stop());
  }, [envs]);

  const rows = useMemo<Row[]>(() => {
    const needle = query.trim().toLowerCase();
    const working = new Map<string, number>();
    for (const item of agents)
      if (item.status === "running") working.set(`${item.env}/${item.projectId}`, (working.get(`${item.env}/${item.projectId}`) ?? 0) + 1);
    const projectRow = (env: string, project: HostProject): Extract<Row, { type: "project" }> => ({
      type: "project",
      key: `p:${env}/${project.id}`,
      env,
      project,
      working: working.get(`${env}/${project.id}`) ?? 0,
      pinned: pins.includes(pinKey(env, project.id)),
    });
    const all = records.flatMap((record) =>
      (hosts[record.env]?.projects ?? [])
        .filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.cwd.toLowerCase().includes(needle))
        .map((project) => projectRow(record.env, project)),
    );
    const pinned = all.filter((row) => row.pinned);
    const out: Row[] = pinned.length ? [{ type: "label", key: "l:pinned", title: "Pinned" }, ...pinned] : [];
    if (records.length > 1) {
      for (const record of records) {
        const group = all.filter((row) => row.env === record.env && !row.pinned);
        if (group.length || !needle) out.push({ type: "machine", key: `m:${record.env}`, record }, ...group);
      }
    } else {
      const rest = all.filter((row) => !row.pinned);
      if (rest.length) out.push({ type: "label", key: "l:projects", title: "Projects" }, ...rest);
    }
    return out;
  }, [records, hosts, agents, pins, query]);

  const anyProjects = records.some((record) => hosts[record.env]?.projects.length);
  const loading = records.some((record) => hosts[record.env]?.loading);
  const updating = records.some((record) => hosts[record.env]?.freshness === "cached" && hosts[record.env]?.projects.length);
  const notices = records.flatMap((record) => {
    const text = hostNotice(record, states[record.env]) ?? (hosts[record.env]?.error && !hosts[record.env]?.projects.length ? `Couldn’t load projects from ${record.label}.` : undefined);
    return text ? [{ env: record.env, text }] : [];
  });

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: t.base }}>
      <Title
        right={
          records.length ? (
            <Pressable
              hitSlop={12}
              accessibilityLabel="Add a project"
              onPress={() => chooseAction("Projects", [{ label: "Open folder on a machine…", run: openFolder }])}
            >
              <Text style={{ color: t.content, fontSize: 28, lineHeight: 30 }}>＋</Text>
            </Pressable>
          ) : null
        }
      >
        Projects
      </Title>
      {updating ? <Text style={{ color: t.text.faint, fontSize: 12, paddingHorizontal: 16, marginTop: -8, paddingBottom: 6 }}>Updating…</Text> : null}
      {notices.map((notice) => (
        <View key={notice.env} style={{ borderBottomWidth: 1, borderColor: t.stroke, paddingHorizontal: 16, paddingVertical: 8 }}>
          <Text style={{ color: t.contentAlpha(0.65), fontSize: 12 }}>{notice.text}</Text>
        </View>
      ))}
      {records.length ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search projects..." />
        </View>
      ) : null}
      {!anyProjects && !loading ? (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12, paddingHorizontal: 28 }}>
          <Text style={{ color: t.text.secondary, fontSize: 15 }}>No projects yet</Text>
          {records.length ? (
            <Button label="Open folder on a machine…" variant="ghost" onPress={openFolder} />
          ) : (
            <Body faint>Pair a computer to see its projects.</Body>
          )}
        </View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.type}
          keyboardDismissMode="on-drag"
          renderItem={({ item }) =>
            item.type === "label" ? (
              <View style={{ height: LABEL_HEIGHT }}>
                <SectionLabel>{item.title}</SectionLabel>
              </View>
            ) : item.type === "machine" ? (
              <MachineRow record={item.record} state={states[item.record.env]} />
            ) : (
              <ProjectRow row={item} hostLabel={records.find((record) => record.env === item.env)?.label ?? ""} />
            )
          }
          ListEmptyComponent={
            query ? (
              <Text style={{ color: t.text.faint, fontSize: 14, textAlign: "center", marginTop: 32 }}>No matching projects</Text>
            ) : null
          }
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}
    </SafeAreaView>
  );
}
