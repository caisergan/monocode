import { FlashList } from "@shopify/flash-list";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { InboxItem, SessionListItem } from "@monocode/core/wire";
import { TYPE } from "@monocode/design";
import { seenKey, useSeen } from "@/hosts/seen";
import { hostNotice, useReconnecting } from "@/hosts/status";
import { useAgents, useHosts } from "@/hosts/store";
import { visibleSessions, type ArchivedFilter } from "@/sync/paging";
import { listKey, loadMoreSessions, loadProjects, openSessionList, refreshSessions, useProjects } from "@/sync/projects";
import { Button, NoticeBar, SearchField, SectionLabel, ToggleChip } from "@/ui/components";
import { Segmented, type SegmentedOption } from "@/ui/Segmented";
import { cardFromSession, SessionCard, sessionCardHeight } from "@/ui/SessionCard";
import { useTokens } from "@/ui/theme";
import { ChangesPane, DiffStatText, hostCan } from "@/workspace/ChangesPane";
import { ExplorerPane } from "@/workspace/ExplorerPane";
import { useGitIndex } from "@/workspace/store";

type Row = { type: "label"; key: string; title: string } | { type: "session"; key: string; item: SessionListItem };

/** The desktop sidebar's tabs (11 §11.14). */
type Segment = "sessions" | "explorer" | "changes";

const LABEL_HEIGHT = 42;
const CARD_GAP = 4;

/** A project (11 §11.14): its sessions, pinned first, then newest, 50 a
 * page; Explorer and Changes for the project folder (11 §11.20). */
export default function ProjectScreen() {
  const { env, projectId } = useLocalSearchParams<{ env: string; projectId: string }>();
  const t = useTokens();
  const [archived, setArchived] = useState<ArchivedFilter>("exclude");
  const [query, setQuery] = useState("");
  const [pulled, setPulled] = useState(false);
  const key = listKey(env, projectId, archived);
  const state = useProjects((store) => store.lists[key]);
  const project = useProjects((store) => store.hosts[env]?.projects.find((item) => item.id === projectId));
  const record = useHosts((store) => store.records.find((item) => item.env === env));
  const hostState = useHosts((store) => store.states[env]);
  const reconnecting = useReconnecting(hostState);
  const agents = useAgents((store) => store.items);
  const seen = useSeen((store) => store.seen);
  const [segment, setSegment] = useState<Segment>("sessions");
  const [explorerPath, setExplorerPath] = useState("");
  const canExplore = hostCan(env, "files.list");
  const canChange = hostCan(env, "git.index");
  const changes = useGitIndex(env, projectId, undefined, canChange).value;

  useEffect(() => openSessionList(env, projectId, archived), [env, projectId, archived]);
  // Opened from a link before the Projects tab loaded this machine.
  const known = !!project;
  useEffect(() => {
    if (!known) void loadProjects(env);
  }, [env, known]);

  const inbox = useMemo(() => {
    const map = new Map<string, InboxItem>();
    for (const item of agents) if (item.env === env) map.set(item.sessionId, item);
    return map;
  }, [agents, env]);

  const rows = useMemo<Row[]>(() => {
    const { pinned, rest } = visibleSessions(state?.list, query);
    const toRow = (item: SessionListItem): Row => ({ type: "session", key: item.id, item });
    if (!pinned.length) return rest.map(toRow);
    return [
      { type: "label", key: "l:pinned", title: "Pinned" },
      ...pinned.map(toRow),
      ...(rest.length ? [{ type: "label" as const, key: "l:rest", title: "Sessions" }, ...rest.map(toRow)] : []),
    ];
  }, [state?.list, query]);

  const segments: SegmentedOption<Segment>[] = [
    { value: "sessions", label: "Sessions" },
    ...(canExplore ? [{ value: "explorer" as const, label: "Explorer" }] : []),
    ...(canChange
      ? [
          changes && (changes.additions > 0 || changes.deletions > 0)
            ? {
                value: "changes" as const,
                label: <DiffStatText additions={changes.additions} deletions={changes.deletions} size={13} />,
                accessibilityLabel: `Changes, ${changes.additions} added, ${changes.deletions} removed`,
              }
            : { value: "changes" as const, label: "Changes" },
        ]
      : []),
  ];

  const list = state?.list;
  const notice = record ? hostNotice(record, hostState) : undefined;
  const subline = [record?.label, list?.cached ? "Updating…" : reconnecting ? "Reconnecting…" : undefined].filter(Boolean).join(" · ");

  const refresh = () => {
    setPulled(true);
    void refreshSessions(env, projectId, archived).finally(() => setPulled(false));
  };

  const empty = !list ? (
    state?.error ? (
      <EmptyState text="Couldn’t load sessions" detail={state.error} action={{ label: "Retry", onPress: refresh }} />
    ) : (
      <View style={{ paddingTop: 48, alignItems: "center" }}>
        <ActivityIndicator color={t.text.faint} />
      </View>
    )
  ) : query.trim() ? (
    <EmptyState text="No matching sessions" />
  ) : archived === "only" ? (
    <EmptyState text="No sessions match these filters" />
  ) : state?.error && list.cached ? (
    <EmptyState text="Couldn’t load sessions" detail={state.error} action={{ label: "Retry", onPress: refresh }} />
  ) : (
    <EmptyState
      text="Sessions you start will show up here"
      action={{ label: "New session", onPress: () => router.push({ pathname: "/new", params: { env, projectId } }) }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.base }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: "center", maxWidth: 260 }}>
              <Text numberOfLines={1} style={{ color: t.content, fontSize: TYPE.screenTitle.size, fontWeight: "600" }}>
                {project?.name ?? "Project"}
              </Text>
              {subline ? (
                <Text numberOfLines={1} style={{ color: t.text.tertiary, fontSize: TYPE.meta.size }}>
                  {subline}
                </Text>
              ) : null}
            </View>
          ),
          headerRight: () => (
            <Pressable
              hitSlop={12}
              accessibilityLabel="New session"
              onPress={() => router.push({ pathname: "/new", params: { env, projectId } })}
            >
              <Text style={{ color: t.content, fontSize: 26, lineHeight: 28 }}>＋</Text>
            </Pressable>
          ),
        }}
      />
      {notice ? <NoticeBar text={notice} /> : null}
      {state?.error && list && !list.cached && segment === "sessions" ? <NoticeBar text={state.error} action={{ label: "Retry", onPress: refresh }} /> : null}
      {segments.length > 1 ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2 }}>
          <Segmented label="Project" options={segments} value={segment} onChange={setSegment} />
        </View>
      ) : null}
      {segment === "explorer" ? (
        <ExplorerPane env={env} projectId={projectId} rootLabel={project?.name ?? "Project"} path={explorerPath} onPath={setExplorerPath} />
      ) : segment === "changes" ? (
        <ChangesPane env={env} projectId={projectId} />
      ) : (
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
            <SearchField value={query} onChangeText={setQuery} placeholder="Search conversations..." />
            <ToggleChip label="Archived" selected={archived === "only"} onPress={() => setArchived((value) => (value === "only" ? "exclude" : "only"))} />
          </View>
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
              ) : (
                <View style={{ height: sessionCardHeight(false) + CARD_GAP, paddingBottom: CARD_GAP }}>
                  <SessionCard
                    card={cardFromSession(item.item, inbox.get(item.item.id))}
                    unseen={(item.item.finishedAt ?? item.item.updatedAt) > (seen[seenKey(env, item.item.id)] ?? 0)}
                    onPress={() => router.push({ pathname: "/m/[env]/s/[sessionId]", params: { env, sessionId: item.item.id } })}
                  />
                </View>
              )
            }
            onEndReached={() => void loadMoreSessions(env, projectId, archived)}
            onEndReachedThreshold={0.5}
            refreshing={pulled}
            onRefresh={refresh}
            ListEmptyComponent={empty}
            ListFooterComponent={
              state?.loadingMore ? (
                <View style={{ height: 48, alignItems: "center", justifyContent: "center" }}>
                  <ActivityIndicator color={t.text.faint} />
                </View>
              ) : null
            }
            contentContainerStyle={{ paddingBottom: 32 }}
          />
        </View>
      )}
    </View>
  );
}

function EmptyState({ text, detail, action }: { text: string; detail?: string; action?: { label: string; onPress: () => void } }) {
  const t = useTokens();
  return (
    <View style={{ alignItems: "center", gap: 10, paddingTop: 56, paddingHorizontal: 28 }}>
      <Text style={{ color: t.text.secondary, fontSize: 15, textAlign: "center" }}>{text}</Text>
      {detail ? <Text style={{ color: t.text.faint, fontSize: 13, textAlign: "center" }}>{detail}</Text> : null}
      {action ? <Button label={action.label} variant="ghost" onPress={action.onPress} /> : null}
    </View>
  );
}
