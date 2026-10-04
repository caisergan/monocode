import { randomUUID } from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Block, HostSession } from "@monocode/core/session";
import { RADII, TYPE } from "@monocode/design";
import { MonoTranscript, type MonoTranscriptHandle } from "@transcript";
import { runtime } from "@/hosts/registry";
import { seenKey, useSeen } from "@/hosts/seen";
import { useHosts } from "@/hosts/store";
import { SessionWindow, type WindowState } from "@/sync/sessionWindow";
import { buildRows } from "@/transcript/rows";
import { modelLabel } from "@/ui/SessionCard";
import { transcriptTheme, useTokens } from "@/ui/theme";

type Header = { title: string; status: HostSession["status"]; runId?: string; model?: string; freshness: WindowState["freshness"]; error?: string };

/** One session (11 §11.15). The transcript is native and fed directly from
 * the sync window; React renders only the header and the composer. */
export default function SessionScreen() {
  const { env, sessionId } = useLocalSearchParams<{ env: string; sessionId: string }>();
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const theme = useMemo(() => transcriptTheme(t), [t]);
  const host = runtime(env);
  const hostLabel = useHosts((state) => state.records.find((record) => record.env === env)?.label ?? "");
  const markSeen = useSeen((state) => state.markSeen);
  const transcript = useRef<MonoTranscriptHandle>(null);
  const sessionRef = useRef<SessionWindow | undefined>(undefined);
  const open = useRef(new Set<string>());
  const sending = useRef(new Set<number>());
  const pending = useRef<Block[]>([]);
  const [header, setHeader] = useState<Header>({ title: "", status: "idle", freshness: "cached" });
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string>();

  const rebuild = useCallback(() => {
    const value = sessionRef.current?.state.value;
    if (!value) return;
    const known = new Set(value.session.blocks.map((block) => block.id));
    pending.current = pending.current.filter((block) => !known.has(block.id));
    const blocks = pending.current.length ? [...value.session.blocks, ...pending.current] : value.session.blocks;
    transcript.current?.setRows(
      buildRows(blocks, {
        live: value.status === "running",
        cwd: value.session.cwd,
        open: open.current,
        sending: sending.current,
        hasOlder: sessionRef.current?.hasOlder,
      }),
    );
  }, []);

  useEffect(() => {
    if (!host || !sessionId) return;
    const session = new SessionWindow(host, sessionId);
    sessionRef.current = session;
    session.open();
    const stop = session.subscribe((state) => {
      rebuild();
      const value = state.value;
      setHeader((previous) => {
        const next: Header = {
          title: value?.session.title ?? previous.title,
          status: value?.status ?? previous.status,
          runId: value?.runId,
          model: value?.session.model,
          freshness: state.freshness,
          error: state.error,
        };
        return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
      });
    });
    markSeen(seenKey(env, sessionId));
    return () => {
      stop();
      session.close();
      markSeen(seenKey(env, sessionId));
    };
  }, [host, env, sessionId, rebuild, markSeen]);

  const dispatch = async (command: Record<string, unknown>) => {
    if (!host) return;
    setNotice(undefined);
    try {
      await host.request("commands.dispatch", { commandId: randomUUID(), sessionId, ...command }, 60_000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const onAction = (rowId: string, actionId: string) => {
    if (actionId === "fold") {
      if (open.current.has(rowId)) open.current.delete(rowId);
      else open.current.add(rowId);
      rebuild();
      return;
    }
    if (actionId === "older") {
      void sessionRef.current?.loadOlder();
      return;
    }
    const [kind, request] = actionId.split(":");
    if ((kind === "allow" || kind === "deny") && header.runId) {
      const requestId = Number(request);
      sending.current.add(requestId);
      rebuild();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      dispatch({ type: "approve", runId: header.runId, requestId, decision: kind })
        .catch(() => undefined)
        .finally(() => {
          sending.current.delete(requestId);
          rebuild();
        });
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text || header.status === "running") return;
    const commandId = randomUUID();
    // Shown at once; replaced by the host's block with the same id.
    pending.current = [...pending.current, { id: commandId, role: "user", text, startedAt: Date.now() }];
    rebuild();
    setDraft("");
    transcript.current?.scrollToBottom(true);
    host
      ?.request("commands.dispatch", { type: "send", commandId, sessionId, text }, 60_000)
      .catch((error) => {
        pending.current = pending.current.filter((block) => block.id !== commandId);
        setDraft(text);
        setNotice(`Couldn’t send the message on ${hostLabel}. ${error instanceof Error ? error.message : ""}`);
        rebuild();
      });
  };

  const stop = () => {
    if (header.runId) void dispatch({ type: "cancel", runId: header.runId }).catch(() => undefined);
  };

  const running = header.status === "running";
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.base }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top + 44}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: "center", maxWidth: 260 }}>
              <Text numberOfLines={1} style={{ color: t.content, fontSize: TYPE.screenTitle.size, fontWeight: "600" }}>
                {header.title || "Session"}
              </Text>
              <Text numberOfLines={1} style={{ color: t.text.tertiary, fontSize: TYPE.meta.size }}>
                {[modelLabel(header.model), hostLabel].filter(Boolean).join(" · ")}
                {header.freshness === "cached" ? " · Updating…" : ""}
              </Text>
            </View>
          ),
        }}
      />
      {notice || header.error ? (
        <View style={{ borderBottomWidth: 1, borderColor: t.stroke, paddingHorizontal: 16, paddingVertical: 8, flexDirection: "row", gap: 8 }}>
          <Text style={{ flex: 1, color: t.contentAlpha(0.65), fontSize: 12 }}>{notice ?? header.error}</Text>
          <Pressable onPress={() => setNotice(undefined)} hitSlop={8}>
            <Text style={{ color: t.contentAlpha(0.65), fontSize: 12 }}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}
      <MonoTranscript
        ref={transcript}
        theme={theme}
        style={{ flex: 1 }}
        bottomInset={12}
        onAction={onAction}
        onNeedOlder={() => void sessionRef.current?.loadOlder()}
      />
      <View
        style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8), backgroundColor: t.base }}
      >
        <View
          style={{
            borderRadius: RADII.md,
            borderWidth: 1,
            borderColor: t.border.default,
            backgroundColor: t.fill.composer,
            paddingHorizontal: 12,
            paddingTop: 8,
            paddingBottom: 8,
            gap: 6,
          }}
        >
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Ask, build, / for commands..."
            placeholderTextColor={t.text.faint}
            multiline
            style={{ color: t.content, fontSize: TYPE.composer.size, lineHeight: TYPE.composer.line, maxHeight: 6 * TYPE.composer.line, minHeight: TYPE.composer.line }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            <Text style={{ flex: 1, color: t.text.faint, fontSize: TYPE.meta.size }}>{running ? "Working..." : ""}</Text>
            {running ? (
              <Pressable
                accessibilityLabel="Stop"
                onPress={stop}
                style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: t.fill.bubble, alignItems: "center", justifyContent: "center" }}
              >
                <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.content }} />
              </Pressable>
            ) : (
              <Pressable
                accessibilityLabel="Send"
                onPress={send}
                disabled={!draft.trim()}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  backgroundColor: draft.trim() ? t.primary : t.contentAlpha(0.25),
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: t.primaryText, fontSize: 18, fontWeight: "700", marginTop: -2 }}>↑</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
