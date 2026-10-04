import { RADII, TYPE } from "@monocode/design";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import type { AgentRow } from "@/hosts/store";
import { useTokens } from "./theme";

export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function modelLabel(model?: string): string {
  if (!model) return "";
  return model.replace(/^[^:]+:/, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The desktop session card at mobile sizes (11 §11.14). */
export const SessionCard = memo(function SessionCard({
  item,
  unseen,
  onPress,
}: {
  item: AgentRow;
  unseen: boolean;
  onPress: () => void;
}) {
  const t = useTokens();
  const needs = item.attention === "approval" || item.attention === "question";
  const status = needs
    ? { text: item.attention === "question" ? "Needs input" : "Need approval", color: t.status.attention }
    : item.status === "running"
      ? { text: "Working...", color: t.accent }
      : item.attention === "error" || item.attention === "interrupted"
        ? { text: item.attention === "error" ? "Failed" : "Interrupted", color: t.status.danger }
        : item.attention === "usage_limit"
          ? { text: "Usage limit", color: t.status.attention }
          : item.attention === "finished" && unseen
            ? { text: "Done", color: t.status.done }
            : { text: relativeTime(item.updatedAt), color: t.text.faint };
  const where = [item.projectName, item.hostLabel, item.branch ? `⑂ ${item.branch}` : undefined].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: RADII.sm,
        borderWidth: 1,
        borderStyle: needs ? "dashed" : "solid",
        borderColor: needs ? t.border.dashed : "transparent",
        backgroundColor: pressed ? t.fill.hover : needs ? t.contentAlpha(0.04) : "transparent",
        gap: 3,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, color: t.text.secondary, fontSize: TYPE.meta.size, lineHeight: TYPE.meta.line }}>
          {item.harness} · {modelLabel(item.model)}
        </Text>
        <Text style={{ color: status.color, fontSize: TYPE.meta.size, fontVariant: ["tabular-nums"] }}>{status.text}</Text>
      </View>
      <Text numberOfLines={1} style={{ color: t.contentAlpha(0.9), fontSize: TYPE.row.size, lineHeight: TYPE.row.line, fontWeight: "600" }}>
        {item.pinned ? "📌 " : ""}
        {item.title}
      </Text>
      {needs && item.approval ? (
        <Text numberOfLines={1} style={{ color: t.status.attention, fontSize: TYPE.secondary.size }}>
          Approve: {item.approval.title}
        </Text>
      ) : item.lastText && (item.status === "running" || item.attention === "finished") ? (
        <Text numberOfLines={1} style={{ color: t.text.tertiary, fontSize: TYPE.secondary.size }}>
          {item.lastText}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={{ color: t.text.tertiary, fontSize: TYPE.meta.size, lineHeight: TYPE.meta.line }}>
        {where}
      </Text>
    </Pressable>
  );
});
