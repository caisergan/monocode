import { Image } from "expo-image";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from "react-native";
import { TYPE } from "@monocode/design";
import { runtime } from "@/hosts/registry";
import { attachmentUri, readAttachment, type ReadChunk } from "@/sync/attachments";
import { openWindow } from "@/sync/sessionWindow";
import { useTokens } from "@/ui/theme";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** An image the person attached, read from the machine (12 §12.10). */
export default function AttachmentSheet() {
  const { env, sessionId, id } = useLocalSearchParams<{ env: string; sessionId: string; id: string }>();
  const t = useTokens();
  const { width, height } = useWindowDimensions();
  const [meta] = useState(() =>
    openWindow(env, sessionId)
      ?.state.value?.session.blocks.flatMap((block) => block.attachments ?? [])
      .find((attachment) => attachment.id === id),
  );
  const [uri, setUri] = useState<string>();
  const [progress, setProgress] = useState<{ read: number; size: number }>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const host = runtime(env);
    if (!host) return;
    let live = true;
    const read = (onProgress: (read: number, size: number) => void) =>
      readAttachment((params) => host.request<ReadChunk>("attachments.read", params, 60_000), sessionId, id, onProgress);
    attachmentUri(`${env}/${id}`, meta?.mimeType ?? "image/png", read, (done, size) => {
      if (live) setProgress({ read: done, size });
    })
      .then((value) => {
        if (live) setUri(value);
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      live = false;
    };
  }, [env, sessionId, id, meta?.mimeType, attempt]);

  // Images always have explicit sizes (15 §15.3).
  const box = { width: width - 32, height: Math.round(height * 0.55) };
  return (
    <View style={{ flex: 1, backgroundColor: t.base, padding: 16, paddingTop: 24, gap: 12 }}>
      <View style={{ gap: 2 }}>
        <Text numberOfLines={1} style={{ color: t.content, fontSize: TYPE.screenTitle.size, fontWeight: "600" }}>
          {meta?.name ?? "Image"}
        </Text>
        {meta ? <Text style={{ color: t.text.tertiary, fontSize: TYPE.meta.size }}>{formatSize(meta.size)}</Text> : null}
      </View>
      <View style={{ ...box, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: t.fill.code, overflow: "hidden" }}>
        {uri ? (
          <Image
            source={{ uri, cacheKey: `${env}/${id}` }}
            style={box}
            contentFit="contain"
            transition={150}
            accessibilityLabel={meta?.name ?? "Attached image"}
          />
        ) : error ? (
          <View style={{ alignItems: "center", gap: 10, paddingHorizontal: 24 }}>
            <Text style={{ color: t.contentAlpha(0.65), fontSize: 13, textAlign: "center" }}>Couldn’t load the image. {error}</Text>
            <Pressable
              hitSlop={12}
              onPress={() => {
                setError(undefined);
                setAttempt((value) => value + 1);
              }}
            >
              <Text style={{ color: t.contentAlpha(0.75), fontSize: 13, fontWeight: "500" }}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ alignItems: "center", gap: 8 }}>
            <ActivityIndicator color={t.text.faint} />
            {progress && progress.size ? (
              <Text style={{ color: t.text.faint, fontSize: TYPE.meta.size, fontVariant: ["tabular-nums"] }}>
                {Math.round((progress.read / progress.size) * 100)}%
              </Text>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}
