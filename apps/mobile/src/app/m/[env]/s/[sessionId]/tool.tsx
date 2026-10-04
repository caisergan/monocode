import { useLocalSearchParams } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { ChannelRequestError } from "@monocode/channel";
import type { Block } from "@monocode/core/session";
import { toolCallLabel, toolCallState } from "@monocode/core/transcript";
import { RADII, TYPE } from "@monocode/design";
import { runtime } from "@/hosts/registry";
import { openWindow } from "@/sync/sessionWindow";
import { useTokens } from "@/ui/theme";

/** Output beyond this shows only its tail until asked (11 §11.23). */
const OUTPUT_TAIL = 10_000;
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });
const STATE_LABEL = { pending: "Running", accepted: "Completed", rejected: "Failed" } as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.text.secondary, fontSize: TYPE.secondary.size, fontWeight: "500" }}>{title}</Text>
      {children}
    </View>
  );
}

function Code({ text }: { text: string }) {
  const t = useTokens();
  return (
    <View style={{ borderRadius: RADII.block, borderWidth: 1, borderColor: t.border.default, backgroundColor: t.fill.code, padding: 10 }}>
      <Text selectable style={{ color: t.contentAlpha(0.85), fontFamily: MONO, fontSize: TYPE.code.size, lineHeight: TYPE.code.line }}>
        {text}
      </Text>
    </View>
  );
}

/** A tool, thinking or trail row in full (11 §11.15): the window's copy at
 * once, then the whole block from `sessions.block`. */
export default function ToolSheet() {
  const { env, sessionId, blockId } = useLocalSearchParams<{ env: string; sessionId: string; blockId: string }>();
  const t = useTokens();
  const [initial] = useState(() => openWindow(env, sessionId)?.block(blockId));
  const [cwd] = useState(() => openWindow(env, sessionId)?.state.value?.session.cwd);
  const [full, setFull] = useState<Block>();
  const [error, setError] = useState<{ message: string; tooLarge: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const host = runtime(env);
    if (!host) return;
    let live = true;
    host
      .request<{ block: Block; revision: number }>("sessions.block", { sessionId, blockId }, 60_000)
      .then((result) => {
        if (live) setFull(result.block);
      })
      .catch((failure: unknown) => {
        if (!live) return;
        const tooLarge = failure instanceof ChannelRequestError && failure.code === "payload_too_large";
        setError({ message: failure instanceof Error ? failure.message : String(failure), tooLarge });
      });
    return () => {
      live = false;
    };
  }, [env, sessionId, blockId, attempt]);

  const block = full ?? initial;
  const truncated = !full && !!(initial as (Block & { truncated?: unknown }) | undefined)?.truncated;
  const title = !block
    ? "Details"
    : block.role === "tool"
      ? toolCallLabel(block, cwd)
      : block.role === "reasoning"
        ? "Thinking"
        : block.text.split("\n")[0] || block.role;
  const state = block?.role === "tool" ? STATE_LABEL[toolCallState(block)] : undefined;
  const output = block?.tool?.preview?.output;
  const cut = !!output && output.length > OUTPUT_TAIL && !showAll;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.base }} contentContainerStyle={{ padding: 20, paddingTop: 24, gap: 16, paddingBottom: 48 }}>
      <View style={{ gap: 4 }}>
        <Text selectable style={{ color: t.content, fontSize: TYPE.screenTitle.size, lineHeight: TYPE.screenTitle.line, fontWeight: "600" }}>
          {title}
        </Text>
        {state ? (
          <Text style={{ color: state === "Failed" ? t.status.danger : t.text.tertiary, fontSize: TYPE.meta.size }}>{state}</Text>
        ) : null}
      </View>

      {!block && !error ? <ActivityIndicator color={t.text.faint} /> : null}
      {truncated && !error ? <Text style={{ color: t.text.faint, fontSize: TYPE.meta.size }}>Loading the full output…</Text> : null}
      {error ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text style={{ flex: 1, color: t.contentAlpha(0.65), fontSize: 12 }}>
            {error.tooLarge ? "This output is too large for the phone. Open the session on your computer to see it." : `Couldn’t load the full block. ${error.message}`}
          </Text>
          {error.tooLarge ? null : (
            <Pressable
              hitSlop={12}
              onPress={() => {
                setError(undefined);
                setAttempt((value) => value + 1);
              }}
            >
              <Text style={{ color: t.contentAlpha(0.65), fontSize: 12, fontWeight: "500" }}>Retry</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {block?.tool?.detail ? (
        <Section title="Input">
          <Code text={block.tool.detail} />
        </Section>
      ) : null}

      {block?.tool?.preview?.lines?.length ? (
        <Section title={block.tool.preview.path ?? "Changes"}>
          <View style={{ borderRadius: RADII.block, borderWidth: 1, borderColor: t.border.default, backgroundColor: t.fill.code, paddingVertical: 8 }}>
            {block.tool.preview.lines.map((line, index) => (
              <Text
                key={index}
                selectable
                style={{
                  paddingHorizontal: 10,
                  fontFamily: MONO,
                  fontSize: TYPE.code.size,
                  lineHeight: TYPE.code.line,
                  color: line.kind === "add" ? t.status.done : line.kind === "del" ? t.status.danger : t.contentAlpha(0.7),
                }}
              >
                {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
                {line.text}
              </Text>
            ))}
          </View>
        </Section>
      ) : null}

      {output ? (
        <Section title="Output">
          {cut ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Text style={{ flex: 1, color: t.text.faint, fontSize: TYPE.meta.size }}>Showing the last 10,000 characters.</Text>
              <Pressable hitSlop={12} onPress={() => setShowAll(true)}>
                <Text style={{ color: t.contentAlpha(0.75), fontSize: TYPE.meta.size, fontWeight: "500" }}>Load full output</Text>
              </Pressable>
            </View>
          ) : null}
          <Code text={cut ? output.slice(-OUTPUT_TAIL) : output} />
        </Section>
      ) : null}

      {block && block.role !== "tool" && block.text ? (
        <Text selectable style={{ color: block.role === "reasoning" ? t.text.reasoning : t.text.prose, fontSize: TYPE.prose.size, lineHeight: TYPE.prose.line }}>
          {block.text}
        </Text>
      ) : null}
    </ScrollView>
  );
}
