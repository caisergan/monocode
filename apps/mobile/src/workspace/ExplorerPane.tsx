// Explorer (11 §11.20): a folder's entries from `files.list`, folders first,
// under breadcrumbs, with Go to file (`files.search`) above. Rows are 44 pt.
// The folder being shown belongs to the caller, so it survives segment
// switches on the Project screen.

import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { memo, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { TYPE } from "@monocode/design";
import { Button, SearchField } from "@/ui/components";
import { FileTypeIcon } from "@/ui/FileTypeIcon";
import { Icon } from "@/ui/icon";
import { useTokens } from "@/ui/theme";
import { breadcrumbs, dirname, isGitMetadata } from "./paths";
import { makeScope, refreshDirectory, useDirectory, useFileSearch } from "./store";
import type { FileEntry } from "./types";

export const EXPLORER_ROW_HEIGHT = 44;
const CRUMBS_HEIGHT = 36;

/** Opens the file viewer for a file in this working copy. */
export function openFile(env: string, projectId: string, cwd: string | undefined, path: string): void {
  router.push({ pathname: "/m/[env]/file", params: { env, projectId, path, ...(cwd ? { cwd } : {}) } });
}

export function ExplorerPane({
  env,
  projectId,
  cwd,
  rootLabel,
  path,
  onPath,
}: {
  env: string;
  projectId: string;
  cwd?: string;
  /** The first breadcrumb: the project or working copy name. */
  rootLabel: string;
  path: string;
  onPath: (path: string) => void;
}) {
  const t = useTokens();
  const [query, setQuery] = useState("");
  const listing = useDirectory(env, projectId, cwd, path);
  const search = useFileSearch(env, projectId, cwd, query);
  const searching = !!query.trim();
  const shown = searching ? search : listing;
  const crumbs = useMemo(() => breadcrumbs(path, rootLabel), [path, rootLabel]);
  const crumbScroll = useRef<ScrollView>(null);
  const [pulled, setPulled] = useState(false);

  const refresh = () => {
    setPulled(true);
    void refreshDirectory(makeScope(env, projectId, cwd), path).finally(() => setPulled(false));
  };

  const open = (entry: FileEntry) => {
    if (isGitMetadata(entry.path)) return;
    if (entry.isDir) {
      setQuery("");
      onPath(entry.path);
    } else openFile(env, projectId, cwd, entry.path);
  };

  const empty = shown.value ? (
    <Text style={{ color: t.text.tertiary, fontSize: TYPE.secondary.size, paddingHorizontal: 16, paddingTop: 16 }}>
      {searching ? "No matching files" : "No files found"}
    </Text>
  ) : shown.error ? (
    <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 8, alignItems: "flex-start" }}>
      <Text style={{ color: t.text.secondary, fontSize: TYPE.secondary.size, lineHeight: TYPE.secondary.line }}>{shown.error}</Text>
      {!searching ? <Button label="Retry" variant="ghost" onPress={refresh} /> : null}
    </View>
  ) : (
    <View style={{ paddingTop: 32, alignItems: "center" }}>
      <ActivityIndicator color={t.text.faint} />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Go to File" />
      </View>
      {searching ? null : (
        <ScrollView
          ref={crumbScroll}
          horizontal
          showsHorizontalScrollIndicator={false}
          onContentSizeChange={() => crumbScroll.current?.scrollToEnd({ animated: false })}
          style={{ flexGrow: 0, height: CRUMBS_HEIGHT }}
          contentContainerStyle={{ paddingHorizontal: 16, alignItems: "center", gap: 4 }}
        >
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <View key={crumb.path} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                {index > 0 ? <Icon name="chevron.right" size={10} color={t.text.faintest} /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={last ? `${crumb.label}, current folder` : `Go to ${crumb.label}`}
                  disabled={last}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  onPress={() => onPath(crumb.path)}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      color: last ? t.text.primary : t.text.secondary,
                      fontSize: TYPE.secondary.size,
                      lineHeight: TYPE.secondary.line,
                      fontWeight: last ? "500" : "400",
                      maxWidth: 220,
                    }}
                  >
                    {crumb.label}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      )}
      <FlashList
        data={shown.value ?? []}
        keyExtractor={(entry) => entry.path}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => <EntryRow entry={item} showDir={searching} onPress={open} />}
        refreshing={pulled}
        onRefresh={searching ? undefined : refresh}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: 32 }}
      />
    </View>
  );
}

const EntryRow = memo(function EntryRow({ entry, showDir, onPress }: { entry: FileEntry; showDir: boolean; onPress: (entry: FileEntry) => void }) {
  const t = useTokens();
  const dir = showDir ? dirname(entry.path) : "";
  // Shown like the desktop's, but the host won't open it.
  const closed = isGitMetadata(entry.path);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.isDir ? `${entry.name}, folder` : dir ? `${entry.name}, in ${dir}` : entry.name}
      accessibilityState={{ disabled: closed }}
      disabled={closed}
      onPress={() => onPress(entry)}
      style={({ pressed }) => ({
        height: EXPLORER_ROW_HEIGHT,
        paddingHorizontal: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: pressed ? t.fill.hover : "transparent",
      })}
    >
      <FileTypeIcon name={entry.name} isDir={entry.isDir} faded={entry.ignored} />
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: entry.ignored ? t.text.tertiary : t.text.primary, fontSize: TYPE.row.size, lineHeight: TYPE.row.line }}>{entry.name}</Text>
        {dir ? <Text style={{ color: t.text.tertiary, fontSize: TYPE.secondary.size }}>{`  ${dir}`}</Text> : null}
      </Text>
      {entry.isDir && !closed ? <Icon name="chevron.right" size={12} color={t.text.faintest} /> : null}
    </Pressable>
  );
});
