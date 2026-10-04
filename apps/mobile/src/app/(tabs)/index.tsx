import { router } from "expo-router";
import { useEffect, useMemo } from "react";
import { Pressable, SectionList, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { addDemoHost, allRuntimes } from "@/hosts/registry";
import { seenKey, useSeen } from "@/hosts/seen";
import { useAgents, useHosts, type AgentRow } from "@/hosts/store";
import { Body, Button, SectionLabel, Title } from "@/ui/components";
import { SessionCard } from "@/ui/SessionCard";
import { useTokens } from "@/ui/theme";

type Section = { key: string; title: string; dot?: string; data: AgentRow[] };

/** The cross-machine home (11 §11.12): the desktop's "Working" card. */
export default function Agents() {
  const t = useTokens();
  const items = useAgents((state) => state.items);
  const { records, states, loaded } = useHosts();
  const seen = useSeen((state) => state.seen);

  useEffect(() => {
    const stops = allRuntimes().map((host) => host.watchInbox());
    return () => stops.forEach((stop) => stop());
  }, [records.length]);

  const sections = useMemo<Section[]>(() => {
    const unseen = (item: AgentRow) => (item.finishedAt ?? item.updatedAt) > (seen[seenKey(item.env, item.sessionId)] ?? 0);
    const needs = items.filter((item) => item.attention === "approval" || item.attention === "question");
    const working = items.filter((item) => item.status === "running" && !needs.includes(item));
    const problems = items.filter((item) => ["error", "interrupted", "usage_limit"].includes(String(item.attention)));
    const done = items.filter((item) => item.attention === "finished" && item.status !== "running" && unseen(item));
    const used = new Set([...needs, ...working, ...problems, ...done]);
    const recent = items.filter((item) => !used.has(item)).slice(0, 50);
    const label = needs.every((item) => item.attention === "question") ? "Needs input" : "Need approval";
    return [
      { key: "needs", title: label, data: needs },
      { key: "working", title: "Working", dot: t.accent, data: working },
      { key: "problems", title: "Problems", data: problems },
      { key: "done", title: "Done", data: done },
      { key: "recent", title: "Recent", data: recent },
    ].filter((section) => section.data.length);
  }, [items, seen, t.accent]);

  const offline = records.filter((record) => {
    const state = states[record.env];
    return state?.kind === "offline" || state?.kind === "blocked";
  });

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: t.base }}>
      <Title
        right={
          records.length ? (
            <Pressable hitSlop={12} onPress={() => router.push("/new")} accessibilityLabel="New session">
              <Text style={{ color: t.content, fontSize: 28, lineHeight: 30 }}>＋</Text>
            </Pressable>
          ) : null
        }
      >
        Agents
      </Title>
      {offline.map((record) => {
        const state = states[record.env];
        return (
          <View key={record.env} style={{ borderBottomWidth: 1, borderColor: t.stroke, paddingHorizontal: 16, paddingVertical: 8 }}>
            <Text style={{ color: t.contentAlpha(0.65), fontSize: 12 }}>
              {state?.kind === "blocked"
                ? state.reason === "device_revoked"
                  ? `This phone was removed from ${record.label}.`
                  : `Can't verify ${record.label}. Pair again.`
                : `${record.label} is offline.`}
            </Text>
          </View>
        );
      })}
      {loaded && !records.length ? (
        <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 28, gap: 14 }}>
          <Text style={{ color: t.content, fontSize: 20, lineHeight: 26, fontWeight: "500" }}>Your agents, wherever you are.</Text>
          <Body faint>Approve, answer and start coding agents on your computers.</Body>
          <Button label="Pair with a computer" onPress={() => router.push("/pair")} />
          <Button label="Try the demo" variant="ghost" onPress={() => addDemoHost()} />
        </View>
      ) : sections.length === 0 ? (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12, paddingHorizontal: 28 }}>
          <Text style={{ color: t.text.secondary, fontSize: 15 }}>Nothing needs your attention</Text>
          <Button label="Start a session" variant="ghost" onPress={() => router.push("/new")} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => `${item.env}/${item.sessionId}`}
          renderSectionHeader={({ section }) => <SectionLabel dot={section.dot}>{section.title}</SectionLabel>}
          renderItem={({ item }) => (
            <SessionCard
              item={item}
              unseen={(item.finishedAt ?? item.updatedAt) > (seen[seenKey(item.env, item.sessionId)] ?? 0)}
              onPress={() => router.push({ pathname: "/m/[env]/s/[sessionId]", params: { env: item.env, sessionId: item.sessionId } })}
            />
          )}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: 32 }}
          contentInsetAdjustmentBehavior="automatic"
        />
      )}
    </SafeAreaView>
  );
}
