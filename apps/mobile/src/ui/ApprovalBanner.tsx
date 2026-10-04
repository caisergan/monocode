// The approval banner (11 §11.18): the desktop's approval toast, for a
// session that isn't on screen. A dashed glass card at the top; Allow and
// Deny for approvals, a tap on the body opens the session. It stays until
// the request is resolved or swiped away.

import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Animated, PanResponder, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HARNESS_LABEL } from "@monocode/core/session";
import { RADII } from "@monocode/design";
import { useAgents, type AgentRow } from "@/hosts/store";
import { enqueue, newCommandId, useOutbox } from "@/outbox";
import { useFocusedSession } from "./focus";
import { Icon } from "./icon";
import { useTokens } from "./theme";

const requestKey = (item: AgentRow) =>
  `${item.env}/${item.sessionId}/${item.approval?.requestId ?? item.question?.requestId ?? ""}`;

export function ApprovalBanner() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const items = useAgents((state) => state.items);
  const focused = useFocusedSession((state) => state.key);
  const outbox = useOutbox((state) => state.byEnv);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  const item = useMemo(
    () =>
      items.find(
        (row) =>
          (row.attention === "approval" || row.attention === "question") &&
          `${row.env}/${row.sessionId}` !== focused &&
          !dismissed.has(requestKey(row)),
      ),
    [items, focused, dismissed],
  );
  const key = item ? requestKey(item) : undefined;
  const sending =
    !!item?.approval &&
    (outbox[item.env] ?? []).some(
      (entry) => entry.command.type === "approve" && entry.command.requestId === item.approval!.requestId && entry.state !== "failed",
    );

  // Enters with translateY −8 and scale .98 over 180 ms.
  const [enter] = useState(() => new Animated.Value(0));
  const [dragX] = useState(() => new Animated.Value(0));
  const [dragY] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!key) return;
    enter.setValue(0);
    dragX.setValue(0);
    dragY.setValue(0);
    Animated.timing(enter, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [key, enter, dragX, dragY]);

  // Swiped sideways or up: gone until the next request.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > 12 || gesture.dy < -12,
        onPanResponderMove: (_event, gesture) => {
          dragX.setValue(Math.abs(gesture.dx) > Math.abs(gesture.dy) ? gesture.dx : 0);
          dragY.setValue(Math.abs(gesture.dy) >= Math.abs(gesture.dx) ? Math.min(0, gesture.dy) : 0);
        },
        onPanResponderRelease: (_event, gesture) => {
          if (key && (Math.abs(gesture.dx) > 80 || gesture.dy < -40)) setDismissed((set) => new Set(set).add(key));
          else
            Animated.parallel([
              Animated.spring(dragX, { toValue: 0, useNativeDriver: true }),
              Animated.spring(dragY, { toValue: 0, useNativeDriver: true }),
            ]).start();
        },
      }),
    [key, dragX, dragY],
  );

  if (!item) return null;
  const decide = (decision: "allow" | "deny") => {
    if (!item.approval || !item.runId) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void enqueue(item.env, {
      type: "approve",
      commandId: newCommandId(),
      sessionId: item.sessionId,
      runId: item.runId,
      requestId: item.approval.requestId,
      decision,
    });
  };
  const isApproval = item.attention === "approval";
  const label = isApproval ? item.approval?.title : (item.question?.title ?? "Question");
  return (
    <Animated.View
      {...pan.panHandlers}
      style={{
        position: "absolute",
        top: insets.top + 6,
        left: 12,
        right: 12,
        opacity: enter,
        transform: [
          { translateX: dragX },
          { translateY: Animated.add(enter.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }), dragY) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) },
        ],
      }}
    >
      <View
        style={{
          borderRadius: RADII.lg,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: t.border.dashed,
          backgroundColor: t.base,
          padding: 12,
          gap: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.title}, ${isApproval ? "approval" : "question"}: ${label ?? ""}. Opens the session.`}
          onPress={() => router.push({ pathname: "/m/[env]/s/[sessionId]", params: { env: item.env, sessionId: item.sessionId } })}
          style={{ gap: 4 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, color: t.content, fontSize: 15, fontWeight: "600" }}>
              {item.title}
            </Text>
            <Icon name="exclamationmark.circle" size={12} color={t.status.attention} />
            <Text style={{ color: t.status.attention, fontSize: 12 }}>{isApproval ? "Approval" : "Question"}</Text>
          </View>
          {label ? (
            <Text numberOfLines={3} style={{ color: t.contentAlpha(0.7), fontSize: 14, lineHeight: 21 }}>
              {label}
            </Text>
          ) : null}
          <Text style={{ color: t.text.faint, fontSize: 12 }}>
            {HARNESS_LABEL[item.harness]} · {item.hostLabel}
          </Text>
        </Pressable>
        {isApproval && item.approval && item.runId ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            {sending ? (
              <Text style={{ flex: 1, color: t.text.secondary, fontSize: 13, textAlign: "center", paddingVertical: 9 }}>Sending…</Text>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => decide("deny")}
                  style={{ flex: 1, height: 36, borderRadius: RADII.md, backgroundColor: t.fill.bubble, alignItems: "center", justifyContent: "center" }}
                >
                  <Text style={{ color: t.contentAlpha(0.7), fontSize: 13, fontWeight: "500" }}>Deny</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => decide("allow")}
                  style={{ flex: 1, height: 36, borderRadius: RADII.md, backgroundColor: t.content, alignItems: "center", justifyContent: "center" }}
                >
                  <Text style={{ color: t.base, fontSize: 13, fontWeight: "500" }}>Allow</Text>
                </Pressable>
              </>
            )}
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}
