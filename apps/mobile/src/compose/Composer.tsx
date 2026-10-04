// The composer (11 §11.17): the desktop's anatomy with the quick composer's
// type size. Tabs (question form, usage limit, queue card) stack above the
// box; the box has the top bar, attachment chips, the input with its slash
// picker, and the chip row (+, mode pill, model, access, Send/Stop). Drafts
// are kept per session in the encrypted cache.

import { randomUUID } from "expo-crypto";
import { Image } from "expo-image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { RUNTIME_MODE_LABEL, type RemoteAttachment, type RemoteProvider } from "@monocode/core/session";
import { RADII, TYPE } from "@monocode/design";
import type { HostRuntime } from "@/hosts/runtime";
import { mutate } from "@/outbox";
import { openCache } from "@/storage/cache";
import { MAX_ATTACHMENTS, uploadBase64 } from "@/sync/upload";
import { Icon } from "@/ui/icon";
import { Chip } from "@/ui/sheet";
import { useTokens } from "@/ui/theme";
import { useCatalog } from "./catalog";
import { slashCommands, slashMatches, type ComposerMode } from "./command";
import { modelChipLabel, type ComposerConfig } from "./models";
import { pickPhotos, takePhoto, type PickedImage } from "./pick";
import { loadFavorites, toggleFavorite, useFavorites } from "./prefs";
import { ACCESS_ICON, AccessSheet, AddSheet, ModelSheet } from "./sheets";

type Attachment = PickedImage & {
  /** The upload id the host files it under. */
  id: string;
  offset: number;
  state: "uploading" | "done" | "failed";
};

type Draft = { text: string; mode: ComposerMode };

const DRAFT_SAVE_MS = 500;

export type SendInput = { text: string; attachments: RemoteAttachment[]; mode: ComposerMode };

export function Composer({
  host,
  draftKey,
  projectId,
  config,
  onConfig,
  providers,
  harnessLocked,
  running,
  canQueue,
  onSend,
  onStop,
  topBar,
  above,
  placeholder = "Ask, build, / for commands...",
  emptyPlaceholder,
  isNew,
}: {
  host: HostRuntime | undefined;
  /** A session id, or `new:<projectId>`. */
  draftKey: string;
  projectId: string | undefined;
  config: ComposerConfig | undefined;
  onConfig: (config: ComposerConfig) => void;
  providers: RemoteProvider[];
  harnessLocked: boolean;
  running: boolean;
  /** The host has `sessions.queue`: Send queues while a turn runs. */
  canQueue: boolean;
  /** Returns false to keep the message in the composer. */
  onSend: (input: SendInput) => boolean;
  onStop?: () => void;
  topBar?: ReactNode;
  /** Question form, usage tab and queue card, top to bottom. */
  above?: ReactNode;
  placeholder?: string;
  /** Shown while focused on an empty prompt (New session). */
  emptyPlaceholder?: string;
  isNew?: boolean;
}) {
  const t = useTokens();
  const env = host?.env ?? "";
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ComposerMode>("default");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState<"model" | "access" | "add">();
  const catalog = useCatalog(host, projectId);
  const favorites = useFavorites((state) => state.ids);
  const restored = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const capabilities = {
    plan: !!host?.has("sessions.plan"),
    draft: !isNew && !!host?.has("sessions.draft"),
    attach: !!host?.has("attachments.upload"),
  };

  // Restore this session's draft once, then save it as it changes.
  useEffect(() => {
    loadFavorites();
    let live = true;
    void openCache().then(async (cache) => {
      const draft = await cache?.drafts.get<Draft>(env, draftKey).catch(() => undefined);
      if (!live) return;
      restored.current = true;
      if (!draft) return;
      setText((current) => current || draft.text);
      setMode((current) => (current === "default" ? draft.mode : current));
    });
    return () => {
      live = false;
    };
  }, [env, draftKey]);

  const persist = (next: Draft) => {
    if (!restored.current || host?.record.demo) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void openCache().then((cache) =>
        next.text.trim() || next.mode !== "default"
          ? cache?.drafts.put(env, draftKey, next).catch(() => undefined)
          : cache?.drafts.delete(env, draftKey).catch(() => undefined),
      );
    }, DRAFT_SAVE_MS);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const changeText = (value: string) => {
    // A typed `/plan ` or `/draft ` turns into the mode pill.
    const typed = /^\/(plan|draft)\s+/.exec(value);
    const typedMode = typed?.[1] as "plan" | "draft" | undefined;
    const allowed = typedMode === "plan" ? capabilities.plan : typedMode === "draft" ? capabilities.draft : false;
    const next = typed && allowed ? value.slice(typed[0].length) : value;
    const nextMode = typedMode && allowed ? typedMode : mode;
    setText(next);
    if (nextMode !== mode) setMode(nextMode);
    persist({ text: next, mode: nextMode });
  };

  const changeMode = (next: ComposerMode) => {
    setMode(next);
    persist({ text, mode: next });
  };

  // ── Attachments (12 §12.10) ─────────────────────────────────────────────

  const patchAttachment = (id: string, patch: Partial<Attachment>) =>
    setAttachments((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const upload = (item: Attachment) => {
    if (!host) return;
    patchAttachment(item.id, { state: "uploading" });
    let acked = item.offset;
    uploadBase64((params) => mutate<{ offset: number }>(host, "attachments.upload", params), item, {
      from: item.offset,
      onProgress: (offset) => {
        acked = offset;
        patchAttachment(item.id, { offset });
      },
    })
      .then(() => patchAttachment(item.id, { state: "done" }))
      // Resumes from the last acknowledged offset when tapped.
      .catch(() => patchAttachment(item.id, { state: "failed", offset: acked }));
  };

  const addPictures = async (pick: () => Promise<PickedImage[]>) => {
    setSheet(undefined);
    try {
      const room = MAX_ATTACHMENTS - attachments.length;
      if (room <= 0) {
        Alert.alert("Up to 20 files", "Remove an attachment to add another.");
        return;
      }
      const picked = (await pick()).slice(0, room);
      const items: Attachment[] = picked.map((image) => ({ ...image, id: randomUUID(), offset: 0, state: "uploading" }));
      setAttachments((list) => [...list, ...items]);
      items.forEach(upload);
    } catch (error) {
      Alert.alert("Couldn’t add the photo", error instanceof Error ? error.message : String(error));
    }
  };

  const uploading = attachments.some((item) => item.state !== "done");

  // ── Send / Stop ──────────────────────────────────────────────────────────

  const hasContent = !!text.trim() || attachments.length > 0;
  const blockedByRun = running && (mode === "draft" || !canQueue);
  const send = () => {
    if (!hasContent || uploading || blockedByRun) return;
    const files: RemoteAttachment[] = attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, kind: "image", size }));
    if (!onSend({ text, attachments: files, mode })) return;
    setText("");
    setAttachments([]);
    setMode("default");
    clearTimeout(saveTimer.current);
    void openCache().then((cache) => cache?.drafts.delete(env, draftKey).catch(() => undefined));
  };

  const matches = focused ? slashMatches(text, slashCommands(capabilities)) : undefined;
  const pickSlash = (name: string) => {
    if (name === "/plan" || name === "/draft") {
      setText("");
      changeMode(name === "/plan" ? "plan" : "draft");
    } else changeText(name);
  };

  const stopMode = running && !hasContent && !!onStop;
  const primaryDisabled = stopMode ? false : !hasContent || uploading || blockedByRun;
  const accessMode = config?.runtimeMode ?? "supervised";

  return (
    <View style={{ paddingHorizontal: 8 }}>
      {above}
      {matches ? (
        <View
          style={{
            borderTopLeftRadius: RADII.block,
            borderTopRightRadius: RADII.block,
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: t.border.default,
            backgroundColor: t.base,
          }}
        >
          {matches.length ? (
            matches.map((command) => (
              <Pressable
                key={command.name}
                onPress={() => pickSlash(command.name)}
                style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 12, justifyContent: "center", backgroundColor: pressed ? t.fill.hover : "transparent" })}
              >
                <Text style={{ color: t.skill, fontSize: TYPE.row.size, fontWeight: "500" }}>{command.name}</Text>
                <Text numberOfLines={1} style={{ color: t.text.secondary, fontSize: TYPE.secondary.size }}>
                  {command.description}
                </Text>
              </Pressable>
            ))
          ) : (
            <Text style={{ color: t.text.secondary, fontSize: TYPE.secondary.size, padding: 12 }}>No matching commands or skills</Text>
          )}
        </View>
      ) : null}
      <View
        style={{
          borderRadius: RADII.md,
          borderWidth: 1,
          borderColor: focused ? t.border.focus : t.border.default,
          backgroundColor: t.fill.composer,
          paddingHorizontal: 10,
          paddingTop: 8,
          paddingBottom: 8,
          gap: 6,
        }}
      >
        {!focused && topBar ? topBar : null}
        {attachments.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 4 }}>
            {attachments.map((item) => (
              <Pressable
                key={item.id}
                accessibilityLabel={`${item.name}, ${item.state === "failed" ? "upload failed, tap to retry" : item.state === "uploading" ? "uploading" : "attached"}`}
                onPress={() => (item.state === "failed" ? upload(item) : undefined)}
                style={{ width: 44, height: 44 }}
              >
                <Image source={{ uri: item.uri }} style={{ width: 44, height: 44, borderRadius: RADII.md, opacity: item.state === "done" ? 1 : 0.55 }} />
                {item.state === "uploading" ? (
                  <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
                    <ActivityIndicator size="small" color={t.content} />
                  </View>
                ) : item.state === "failed" ? (
                  <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="arrow.clockwise" size={16} color={t.status.danger} />
                  </View>
                ) : null}
                <Pressable
                  accessibilityLabel={`Remove ${item.name}`}
                  hitSlop={8}
                  onPress={() => setAttachments((list) => list.filter((other) => other.id !== item.id))}
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -6,
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    backgroundColor: t.base,
                    borderWidth: 1,
                    borderColor: t.border.default,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name="xmark" size={9} color={t.content} />
                </Pressable>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <TextInput
          value={text}
          onChangeText={changeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={focused && !text && emptyPlaceholder ? emptyPlaceholder : placeholder}
          placeholderTextColor={t.text.faint}
          multiline
          style={{
            color: t.content,
            fontSize: TYPE.composer.size,
            lineHeight: TYPE.composer.line,
            maxHeight: 6 * TYPE.composer.line,
            minHeight: TYPE.composer.line,
            paddingHorizontal: 2,
          }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ gap: 6, alignItems: "center" }}>
            <Chip icon="plus" accessibilityLabel="Add to message" tone="selected" onPress={() => setSheet("add")} />
            {mode !== "default" ? (
              <Chip
                icon={mode === "plan" ? "lightbulb" : "circle.dashed"}
                label={mode === "plan" ? "Plan" : "Draft"}
                tone={mode}
                onClear={() => changeMode("default")}
              />
            ) : null}
            {config ? (
              <Chip label={modelChipLabel(catalog.catalog, config)} icon="chevron.down" onPress={() => setSheet("model")} accessibilityLabel="Model" />
            ) : null}
            {config ? (
              <Chip
                icon={ACCESS_ICON[accessMode]}
                iconColor={accessMode === "full-access" ? t.status.attention : undefined}
                label={RUNTIME_MODE_LABEL[accessMode]}
                onPress={() => setSheet("access")}
                accessibilityLabel={`Access: ${RUNTIME_MODE_LABEL[accessMode]}`}
              />
            ) : null}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={stopMode ? "Stop" : mode === "draft" ? "Save draft" : running && canQueue ? "Queue" : "Send"}
            accessibilityState={{ disabled: primaryDisabled }}
            disabled={primaryDisabled}
            onPress={stopMode ? onStop : send}
            hitSlop={6}
            style={{
              width: 32,
              height: 32,
              borderRadius: RADII.sm,
              backgroundColor: stopMode || !primaryDisabled ? t.primary : t.contentAlpha(0.2),
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {stopMode ? (
              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.primaryText }} />
            ) : uploading && hasContent ? (
              <ActivityIndicator size="small" color={t.primaryText} />
            ) : (
              <Icon name="arrow.up" size={16} color={t.primaryText} />
            )}
          </Pressable>
        </View>
        {blockedByRun && hasContent ? (
          <Text style={{ color: t.text.faint, fontSize: TYPE.meta.size }}>Wait for the agent to finish, or stop it.</Text>
        ) : null}
      </View>
      <AddSheet
        visible={sheet === "add"}
        onClose={() => setSheet(undefined)}
        canAttach={capabilities.attach}
        canPlan={capabilities.plan}
        canDraft={capabilities.draft}
        onCamera={() => void addPictures(takePhoto)}
        onLibrary={() => void addPictures(() => pickPhotos(MAX_ATTACHMENTS - attachments.length))}
        onPlan={() => {
          changeMode("plan");
          setSheet(undefined);
        }}
        onDraft={() => {
          changeMode("draft");
          setSheet(undefined);
        }}
      />
      {config ? (
        <ModelSheet
          visible={sheet === "model"}
          onClose={() => setSheet(undefined)}
          catalog={catalog.catalog}
          loading={catalog.loading}
          error={catalog.error}
          providers={providers}
          harnessLocked={harnessLocked}
          config={config}
          onChange={onConfig}
          running={running}
          favorites={favorites}
          onFavorite={toggleFavorite}
        />
      ) : null}
      {config ? (
        <AccessSheet
          visible={sheet === "access"}
          onClose={() => setSheet(undefined)}
          value={accessMode}
          onChange={(runtimeMode) => onConfig({ ...config, runtimeMode })}
          running={running}
        />
      ) : null}
    </View>
  );
}
