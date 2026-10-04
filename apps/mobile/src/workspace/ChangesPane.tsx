// Changes (11 §11.20), the desktop Changes panel: a header with "+N −M" and
// the branch, the commit area, and the changed files from `git.index` in the
// desktop's two lists, STAGED CHANGES and CHANGES, with stage and unstage
// per file and for all. Every Git write goes through the outbox's `mutate`
// (keyed and retried, 06 §6.8), one at a time, and is disabled while a
// session in the project runs; the host refuses them too, and a refusal
// shows as a toast.

import { FlashList } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { parseColor, RADII, rgba, TYPE } from "@monocode/design";
import { runtime } from "@/hosts/registry";
import { mutate } from "@/outbox";
import { showActions } from "@/ui/actions";
import { MONO } from "@/ui/CodeLine";
import { Button } from "@/ui/components";
import { FileTypeIcon } from "@/ui/FileTypeIcon";
import { Icon, type IconName } from "@/ui/icon";
import { showToast } from "@/ui/toast";
import { useTokens, type Tokens } from "@/ui/theme";
import { commitAndPush, commitState, stageChanges, stageState, type Mutate, type StageAction } from "./git";
import { changeLabel, changeRows, diffStat, formatCount, statusColor, statusLetter, statusWord, type ChangeRow as Row, type ChangeSide } from "./status";
import { makeScope, refreshIndex, useGitIndex, useProjectRunning } from "./store";
import type { GitChangedFile } from "./types";

export const CHANGE_ROW_HEIGHT = 44;
const CAPTION_HEIGHT = 36;

/** A host without the capability in its last welcome can't do it; before
 * the first welcome, assume it can. */
export function hostCan(env: string, capability: string): boolean {
  const host = runtime(env);
  return !host?.record.lastWelcome || host.has(capability);
}

/** Opens the diff viewer on one side; Prev and Next replace it instead of
 * stacking. */
export function openDiff(env: string, projectId: string, cwd: string | undefined, file: GitChangedFile, side: ChangeSide, replace = false): void {
  const params = { env, projectId, path: file.relative, staged: side === "staged" ? "true" : "false", ...(cwd ? { cwd } : {}) };
  if (replace) router.replace({ pathname: "/m/[env]/diff", params });
  else router.push({ pathname: "/m/[env]/diff", params });
}

/** `primary.disabled` (11 §11.2), which the palette doesn't carry yet. */
function primaryDisabled(t: Tokens): { fill: string; text: string } {
  return t.scheme === "dark"
    ? { fill: "rgba(255,255,255,0.3)", text: "rgba(0,0,0,0.4)" }
    : { fill: t.contentAlpha(0.25), text: rgba(parseColor(t.base), 0.75) };
}

/** The "+N −M" pair in the desktop's colours. */
export function DiffStatText({ additions, deletions, size = TYPE.meta.size }: { additions: number; deletions: number; size?: number }) {
  const t = useTokens();
  const stat = diffStat(additions, deletions);
  const style = { fontSize: size, fontWeight: "600" as const, fontVariant: ["tabular-nums" as const] };
  return (
    <Text numberOfLines={1}>
      {stat.added ? <Text style={[style, { color: t.status.done }]}>{stat.added}</Text> : null}
      {stat.added && stat.deleted ? " " : null}
      {stat.deleted ? <Text style={[style, { color: t.status.danger }]}>{stat.deleted}</Text> : null}
    </Text>
  );
}

export function ChangesPane({ env, projectId, cwd }: { env: string; projectId: string; cwd?: string }) {
  const t = useTokens();
  const readable = hostCan(env, "git.index");
  const state = useGitIndex(env, projectId, cwd, readable);
  const index = state.value;
  const running = useProjectRunning(env, projectId);
  const [message, setMessage] = useState("");
  /** The Git write in flight from this screen. */
  const [busy, setBusy] = useState<"commit" | "stage" | null>(null);
  const [focused, setFocused] = useState(false);
  const [pulled, setPulled] = useState(false);
  const capable = hostCan(env, "git.action");
  const { canCommit, canCommitPush } = commitState({ message, index, running, busy: busy !== null, capable });
  const { canStage, canStageAll, canUnstageAll } = stageState({ index, running, busy: busy !== null, capable });

  // Back from a diff or a session: files may have changed meanwhile.
  useFocusEffect(
    useCallback(() => {
      if (readable) void refreshIndex(makeScope(env, projectId, cwd));
    }, [readable, env, projectId, cwd]),
  );

  // A finished turn may have changed files.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && readable) void refreshIndex(makeScope(env, projectId, cwd));
    wasRunning.current = running;
  }, [running, readable, env, projectId, cwd]);

  // One Git write at a time: a second tap before the buttons disable must
  // not start another.
  const inFlight = useRef(false);
  const write = async <T,>(kind: "commit" | "stage", work: (send: Mutate, refresh: () => Promise<void>) => Promise<T>): Promise<T | undefined> => {
    const host = runtime(env);
    if (!host || inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(kind);
    const scope = makeScope(env, projectId, cwd);
    try {
      return await work(
        (method, params, timeoutMs) => mutate(host, method, params, timeoutMs),
        () => refreshIndex(scope, true),
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const run = async (push: boolean) => {
    if (!canCommit || (push && !canCommitPush)) return;
    const result = await write("commit", (send, refreshAfter) => commitAndPush(send, makeScope(env, projectId, cwd), message, push, refreshAfter));
    if (result?.committed) setMessage("");
    if (result?.error) showToast(result.error);
  };

  const stage = async (change: StageAction) => {
    const allowed = change.action === "stageAll" ? canStageAll : change.action === "unstageAll" ? canUnstageAll : canStage;
    if (!allowed) return;
    const result = await write("stage", (send, refreshAfter) => stageChanges(send, makeScope(env, projectId, cwd), change, refreshAfter));
    if (result?.error) showToast(result.error);
  };

  const refresh = () => {
    setPulled(true);
    void refreshIndex(makeScope(env, projectId, cwd)).finally(() => setPulled(false));
  };

  const files = index?.files;
  const rows = useMemo(() => changeRows(files ?? []), [files]);
  const primary = canCommit ? { fill: t.primary, text: t.primaryText } : primaryDisabled(t);
  const empty = index ? (
    <Text style={{ color: t.text.tertiary, fontSize: TYPE.secondary.size, paddingHorizontal: 16, paddingTop: 12 }}>No uncommitted changes</Text>
  ) : state.error ? (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 8, alignItems: "flex-start" }}>
      <Text style={{ color: t.text.secondary, fontSize: TYPE.secondary.size, lineHeight: TYPE.secondary.line }}>{state.error}</Text>
      <Button label="Retry" variant="ghost" onPress={refresh} />
    </View>
  ) : (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, flexDirection: "row", gap: 8, alignItems: "center" }}>
      <ActivityIndicator color={t.text.faint} size="small" />
      <Text style={{ color: t.text.tertiary, fontSize: TYPE.secondary.size }}>Loading changes…</Text>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ height: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, borderBottomWidth: 1, borderColor: t.stroke }}>
        <Text style={{ color: t.content, fontSize: TYPE.row.size, fontWeight: "600" }}>Changes</Text>
        {index ? <DiffStatText additions={index.additions} deletions={index.deletions} /> : null}
        <View style={{ flex: 1 }} />
        {index?.branch ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }} accessible accessibilityLabel={`Branch ${index.branch}`}>
            <Icon name="arrow.triangle.branch" size={12} color={t.text.secondary} />
            <Text numberOfLines={1} style={{ flexShrink: 1, color: t.text.secondary, fontSize: TYPE.meta.size }}>
              {index.branch}
            </Text>
            {index.ahead > 0 ? <Text style={{ color: t.text.faint, fontSize: TYPE.meta.size, fontVariant: ["tabular-nums"] }}>↑{index.ahead}</Text> : null}
            {index.behind > 0 ? <Text style={{ color: t.text.faint, fontSize: TYPE.meta.size, fontVariant: ["tabular-nums"] }}>↓{index.behind}</Text> : null}
          </View>
        ) : null}
      </View>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 8 }}>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder="Message"
          placeholderTextColor={t.text.faint}
          multiline
          editable={busy !== "commit"}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            minHeight: 44,
            maxHeight: 120,
            paddingHorizontal: 12,
            paddingTop: 12,
            paddingBottom: 10,
            borderRadius: RADII.md,
            borderWidth: 1,
            borderColor: focused ? t.border.focus : t.border.default,
            backgroundColor: t.fill.composer,
            color: t.content,
            fontSize: TYPE.row.size,
            lineHeight: TYPE.row.line,
          }}
        />
        <View style={{ flexDirection: "row", height: 44 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canCommit, busy: busy === "commit" }}
            disabled={!canCommit}
            onPress={() => void run(false)}
            style={({ pressed }) => ({
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              borderTopLeftRadius: RADII.md,
              borderBottomLeftRadius: RADII.md,
              backgroundColor: primary.fill,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            {busy === "commit" ? <ActivityIndicator size="small" color={primary.text} /> : <Icon name="checkmark" size={14} color={primary.text} />}
            <Text style={{ color: primary.text, fontSize: TYPE.row.size, fontWeight: "500" }}>Commit</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Commit options"
            accessibilityState={{ disabled: !canCommit }}
            disabled={!canCommit}
            onPress={() => showActions([{ label: "Commit and push", disabled: !canCommitPush, onPress: () => void run(true) }])}
            style={{
              width: 44,
              alignItems: "center",
              justifyContent: "center",
              marginLeft: 1,
              borderTopRightRadius: RADII.md,
              borderBottomRightRadius: RADII.md,
              backgroundColor: primary.fill,
            }}
          >
            <Icon name="chevron.down" size={14} color={primary.text} />
          </Pressable>
        </View>
      </View>
      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.type}
        extraData={{ canStage, canStageAll, canUnstageAll }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) =>
          item.type === "section" ? (
            <SectionRow
              row={item}
              disabled={item.side === "staged" ? !canUnstageAll : !canStageAll}
              onAction={() => void stage({ action: item.side === "staged" ? "unstageAll" : "stageAll" })}
            />
          ) : (
            <ChangeRow
              file={item.file}
              side={item.side}
              disabled={!canStage}
              onPress={(file, side) => openDiff(env, projectId, cwd, file, side)}
              onAction={(file, side) => void stage({ action: side === "staged" ? "unstage" : "stage", path: file.relative })}
            />
          )
        }
        refreshing={pulled}
        onRefresh={readable ? refresh : undefined}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: 32 }}
      />
    </View>
  );
}

/** A plain icon button with a 44 pt hit area, like the desktop's row and
 * section actions. */
function IconAction({ icon, label, height, disabled, onPress }: { icon: IconName; label: string; height: number; disabled: boolean; onPress: () => void }) {
  const t = useTokens();
  const slop = Math.max(0, (44 - height) / 2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: slop, bottom: slop }}
      style={({ pressed }) => ({
        width: 44,
        height,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: RADII.sm,
        backgroundColor: pressed ? t.selection.hover : "transparent",
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Icon name={icon} size={16} color={t.contentAlpha(0.55)} />
    </Pressable>
  );
}

const SECTION_TITLES: Record<ChangeSide, { caption: string; title: string }> = {
  staged: { caption: "STAGED CHANGES", title: "Staged Changes" },
  unstaged: { caption: "CHANGES", title: "Changes" },
};

/** A list's caption with its count pill, and Stage All or Unstage All. */
const SectionRow = memo(function SectionRow({ row, disabled, onAction }: { row: Extract<Row, { type: "section" }>; disabled: boolean; onAction: () => void }) {
  const t = useTokens();
  const titles = SECTION_TITLES[row.side];
  return (
    <View style={{ height: CAPTION_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16, paddingRight: 4 }}>
      <Text
        accessibilityRole="header"
        accessibilityLabel={`${titles.title}, ${row.count} ${row.count === 1 ? "file" : "files"}`}
        style={{ color: t.text.secondary, fontSize: TYPE.caption.size, fontWeight: "600", letterSpacing: TYPE.caption.size * 0.08 }}
      >
        {titles.caption}
      </Text>
      <View style={{ minWidth: 18, height: 16, paddingHorizontal: 5, borderRadius: RADII.full, backgroundColor: t.fill.chip, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: t.contentAlpha(0.7), fontSize: TYPE.caption.size, lineHeight: 14, fontVariant: ["tabular-nums"] }}>{formatCount(row.count)}</Text>
      </View>
      <View style={{ flex: 1 }} />
      {row.side === "staged" ? (
        <IconAction icon="minus" label="Unstage All Changes" height={CAPTION_HEIGHT} disabled={disabled} onPress={onAction} />
      ) : (
        <IconAction icon="plus" label="Stage All Changes" height={CAPTION_HEIGHT} disabled={disabled} onPress={onAction} />
      )}
    </View>
  );
});

/** A changed file: tap for its diff on this side; the trailing button
 * stages or unstages it. Two sibling buttons, so screen readers reach both. */
const ChangeRow = memo(function ChangeRow({
  file,
  side,
  disabled,
  onPress,
  onAction,
}: {
  file: GitChangedFile;
  side: ChangeSide;
  disabled: boolean;
  onPress: (file: GitChangedFile, side: ChangeSide) => void;
  onAction: (file: GitChangedFile, side: ChangeSide) => void;
}) {
  const t = useTokens();
  const { name, dir } = changeLabel(file);
  return (
    <View style={{ height: CHANGE_ROW_HEIGHT, flexDirection: "row", alignItems: "center", paddingRight: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}${dir ? `, in ${dir}` : ""}, ${statusWord(file.status)}${side === "staged" ? ", staged" : ""}`}
        onPress={() => onPress(file, side)}
        style={({ pressed }) => ({
          flex: 1,
          height: CHANGE_ROW_HEIGHT,
          paddingLeft: 16,
          paddingRight: 4,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: pressed ? t.fill.hover : "transparent",
        })}
      >
        <FileTypeIcon name={name} />
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: t.text.primary, fontSize: TYPE.row.size, lineHeight: TYPE.row.line }}>{name}</Text>
          {dir ? <Text style={{ color: t.text.tertiary, fontSize: TYPE.secondary.size }}>{`  ${dir}`}</Text> : null}
        </Text>
        <Text style={{ width: 16, textAlign: "right", color: statusColor(t, file.status), fontFamily: MONO, fontSize: TYPE.secondary.size, fontWeight: "600" }}>
          {statusLetter(file.status)}
        </Text>
      </Pressable>
      {side === "staged" ? (
        <IconAction icon="minus" label="Unstage Changes" height={CHANGE_ROW_HEIGHT} disabled={disabled} onPress={() => onAction(file, side)} />
      ) : (
        <IconAction icon="plus" label="Stage Changes" height={CHANGE_ROW_HEIGHT} disabled={disabled} onPress={() => onAction(file, side)} />
      )}
    </View>
  );
});
