import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useConnection } from "@/features/connection/ConnectionProvider";
import type { ApprovalPrompt } from "@/features/workspace/types";
import { useWorkspace } from "@/features/workspace/WorkspaceProvider";
import { Icon, type IconName } from "@/ui/Icon";
import { LiquidView } from "@/ui/LiquidView";
import { radii, themedStyles, useColors } from "@/ui/theme";

/** As the question card's inset, so the two line up. */
const MARGIN = 12;
/** A long command scrolls inside the card, keeping Deny and Allow in reach. */
const DETAIL_MAX = 160;

const ICONS: Record<string, IconName> = {
  shell: "terminal",
  execute: "terminal",
  edit: "edit",
  write: "edit",
  read: "file",
  fetch: "globe",
};

/**
 * What a machine's agent waits on the user to allow, over the composer, as
 * the desktop's approval row asks it: the action, and Deny or Allow. Shown
 * for a machine only; a desktop answers its own.
 */
export function ApprovalCard({
  conversationId,
  approval,
}: {
  conversationId: string;
  approval: ApprovalPrompt;
}) {
  return (
    <ApprovalForm
      key={`${conversationId}:${approval.requestId}`}
      conversationId={conversationId}
      approval={approval}
    />
  );
}

function ApprovalForm({
  conversationId,
  approval,
}: {
  conversationId: string;
  approval: ApprovalPrompt;
}) {
  const styles = useStyles();
  const colors = useColors();
  const { approve } = useWorkspace();
  const { connected } = useConnection();
  const [sending, setSending] = useState<"allow" | "deny" | null>(null);
  const decide = async (decision: "allow" | "deny") => {
    setSending(decision);
    try {
      await approve(conversationId, approval.requestId, decision);
    } catch (reason) {
      Alert.alert(
        decision === "allow" ? "Not allowed" : "Not denied",
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setSending(null);
    }
  };
  const disabled = sending !== null || !connected;
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      style={styles.card}
      accessibilityLiveRegion="polite"
    >
      <LiquidView fill row={false} borderRadius={radii.card} style={StyleSheet.absoluteFill}>
        <View />
      </LiquidView>
      <View style={styles.header}>
        <Icon name={ICONS[approval.kind ?? ""] ?? "shield"} size={14} color={colors.muted} />
        <Text style={styles.label} numberOfLines={1}>
          Needs your approval
        </Text>
      </View>
      <Text style={styles.title} numberOfLines={4}>
        {approval.title}
      </Text>
      {approval.detail ? (
        <ScrollView style={styles.detail} contentContainerStyle={styles.detailContent} nestedScrollEnabled>
          <Text style={styles.detailText} selectable>
            {approval.detail}
          </Text>
        </ScrollView>
      ) : null}
      <View style={styles.footer}>
        {!connected ? (
          <Text style={styles.offline} numberOfLines={1}>
            Reconnect to answer
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => void decide("deny")}
          hitSlop={8}
          style={({ pressed }) => [styles.deny, (pressed || disabled) && styles.pressed]}
        >
          <Text style={styles.denyLabel}>{sending === "deny" ? "Denying…" : "Deny"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => void decide("allow")}
          style={({ pressed }) => [
            styles.allow,
            disabled && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.allowLabel}>{sending === "allow" ? "Allowing…" : "Allow"}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const useStyles = themedStyles((colors) => ({
  card: {
    marginHorizontal: MARGIN,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  label: {
    flex: 1,
    color: colors.muted,
    fontSize: 13,
  },
  title: {
    color: colors.content,
    fontSize: 15,
    fontWeight: "500",
    lineHeight: 20,
  },
  detail: {
    maxHeight: DETAIL_MAX,
    borderRadius: radii.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.stroke,
  },
  detailContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  detailText: {
    color: colors.content,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12.5,
    lineHeight: 18,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 16,
    marginTop: 6,
  },
  offline: {
    flex: 1,
    color: colors.muted,
    fontSize: 12,
  },
  deny: {
    paddingVertical: 4,
  },
  denyLabel: {
    color: colors.muted,
    fontSize: 14,
  },
  allow: {
    height: 34,
    paddingHorizontal: 16,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.content,
  },
  allowLabel: {
    color: colors.inverse,
    fontSize: 14,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.6,
  },
}));
