import { RADII, TYPE } from "@monocode/design";
import type { Attention, InboxItem, SessionListItem } from "@monocode/core/wire";
import { memo } from "react";
import { Linking, Pressable, Text, View } from "react-native";
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

/** What a card shows, from an inbox row or a `sessions.page` item. */
export type CardItem = {
  title: string;
  harness: string;
  model?: string;
  status: "idle" | "running" | "interrupted";
  attention: Attention;
  pinned?: boolean;
  draft?: boolean;
  updatedAt: number;
  /** The third line: where the session runs. */
  where: string;
  /** An optional extra line (Agents): the approval, or the last reply. */
  detail?: { text: string; attention: boolean };
  workItem?: { label: string; url: string };
};

export function cardFromInbox(item: AgentRow): CardItem {
  const needs = item.attention === "approval" || item.attention === "question";
  const detail =
    needs && item.approval
      ? { text: `Approve: ${item.approval.title}`, attention: true }
      : item.lastText && (item.status === "running" || item.attention === "finished")
        ? { text: item.lastText, attention: false }
        : undefined;
  return {
    title: item.title,
    harness: item.harness,
    model: item.model,
    status: item.status,
    attention: item.attention,
    pinned: item.pinned,
    updatedAt: item.updatedAt,
    where: [item.projectName, item.hostLabel, item.branch ? `⑂ ${item.branch}` : undefined].filter(Boolean).join(" · "),
    detail,
  };
}

/** A project list card. The inbox row, when the session has one, knows the
 * attention reason the summary lacks (question vs approval, failures, done).
 * Sessions outside the inbox's week show their time, never a stale "Done". */
export function cardFromSession(item: SessionListItem, inbox?: InboxItem): CardItem {
  const live = !!inbox && inbox.revision >= item.revision;
  const attention: Attention = live ? inbox.attention : item.needsInput ? "approval" : null;
  return {
    title: item.title,
    harness: item.harness,
    model: item.model,
    status: live ? inbox.status : item.status,
    attention,
    pinned: item.pinned,
    draft: item.draft,
    updatedAt: Math.max(item.updatedAt, inbox?.updatedAt ?? 0),
    where: item.branch ? `⑂ ${item.branch}` : (item.lastText ?? ""),
    workItem: item.linkedWorkItem ? { label: `#${item.linkedWorkItem.number}`, url: item.linkedWorkItem.url } : undefined,
  };
}

const BORDER = 1;
const PAD_Y = 10;
const GAP = 3;

/** Cards have fixed heights from the type scale, never from layout (15 §15.3). */
export function sessionCardHeight(detail: boolean): number {
  const lines = [TYPE.meta.line, TYPE.row.line, TYPE.meta.line, ...(detail ? [TYPE.secondary.line] : [])];
  return BORDER * 2 + PAD_Y * 2 + lines.reduce((sum, line) => sum + line, 0) + GAP * (lines.length - 1);
}

/** The desktop session card at mobile sizes (11 §11.14). */
export const SessionCard = memo(function SessionCard({
  card,
  unseen,
  onPress,
}: {
  card: CardItem;
  unseen: boolean;
  onPress: () => void;
}) {
  const t = useTokens();
  const needs = card.attention === "approval" || card.attention === "question";
  const status = needs
    ? { text: card.attention === "question" ? "Needs input" : "Need approval", color: t.status.attention }
    : card.status === "running"
      ? { text: "Working...", color: t.accent }
      : card.attention === "error" || card.attention === "interrupted"
        ? { text: card.attention === "error" ? "Failed" : "Interrupted", color: t.status.danger }
        : card.attention === "usage_limit"
          ? { text: "Usage limit", color: t.status.attention }
          : card.attention === "finished" && unseen
            ? { text: "Done", color: t.status.done }
            : card.draft
              ? { text: "Draft", color: t.text.faint }
              : { text: relativeTime(card.updatedAt), color: t.text.faint };
  const dashed = needs || card.draft;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}, ${status.text}`}
      style={({ pressed }) => ({
        height: sessionCardHeight(!!card.detail),
        marginHorizontal: 8,
        paddingHorizontal: 12,
        paddingVertical: PAD_Y,
        borderRadius: RADII.sm,
        borderWidth: BORDER,
        borderStyle: dashed ? "dashed" : "solid",
        borderColor: needs ? t.border.dashed : card.draft ? t.contentAlpha(0.25) : "transparent",
        backgroundColor: pressed ? t.fill.hover : needs ? t.contentAlpha(0.04) : "transparent",
        gap: GAP,
        overflow: "hidden",
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: TYPE.meta.line }}>
        <Text numberOfLines={1} style={{ flex: 1, color: t.text.secondary, fontSize: TYPE.meta.size, lineHeight: TYPE.meta.line }}>
          {card.harness} · {modelLabel(card.model)}
        </Text>
        <Text style={{ color: status.color, fontSize: TYPE.meta.size, lineHeight: TYPE.meta.line, fontVariant: ["tabular-nums"] }}>{status.text}</Text>
      </View>
      <Text numberOfLines={1} style={{ color: t.contentAlpha(0.9), fontSize: TYPE.row.size, lineHeight: TYPE.row.line, fontWeight: "600" }}>
        {card.pinned ? "📌 " : ""}
        {card.title}
      </Text>
      {card.detail ? (
        <Text
          numberOfLines={1}
          style={{ color: card.detail.attention ? t.status.attention : t.text.tertiary, fontSize: TYPE.secondary.size, lineHeight: TYPE.secondary.line }}
        >
          {card.detail.text}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: TYPE.meta.line }}>
        <Text numberOfLines={1} style={{ flex: 1, color: t.text.tertiary, fontSize: TYPE.meta.size, lineHeight: TYPE.meta.line }}>
          {card.where}
        </Text>
        {card.workItem ? (
          <Text
            onPress={() => void Linking.openURL(card.workItem!.url)}
            suppressHighlighting
            style={{ color: t.accent, fontSize: TYPE.meta.size, lineHeight: TYPE.meta.line, fontVariant: ["tabular-nums"] }}
          >
            {card.workItem.label}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});
