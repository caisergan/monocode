import { FlashList } from "@shopify/flash-list";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { TYPE } from "@monocode/design";
import { runtime } from "@/hosts/registry";
import { useHosts } from "@/hosts/store";
import { CodeLine, codeColors, contentWidth, DIFF_METRICS, gutterWidth, wrapColumns } from "@/ui/CodeLine";
import { Button, ToggleChip } from "@/ui/components";
import { useTokens } from "@/ui/theme";
import { HeaderTitle, Toolbar, ToolButton } from "@/ui/toolbar";
import { fileDiff } from "@/workspace/api";
import { DiffStatText, hostCan, openDiff } from "@/workspace/ChangesPane";
import { fileDiffModel, type DiffRow } from "@/workspace/diff";
import { highlightDiff, highlightKey, useDeferredHighlight } from "@/workspace/highlight";
import { columnsOf, displayText } from "@/workspace/lines";
import { basename, dirname } from "@/workspace/paths";
import { neighbours, type ChangeSide } from "@/workspace/status";
import { makeScope, useGitIndex } from "@/workspace/store";
import type { GitFileDiff } from "@/workspace/types";

/** The last wrap choice, kept for the next diff while the app runs. */
const prefs = { wrap: false };

type Loaded = { diff?: GitFileDiff; error?: string; loading: boolean };

type Item = { key: string; text: string; tone?: "add" | "del" | "hunk"; number: number | null; label: string };

function item(row: DiffRow): Item {
  const text = displayText(row.text);
  if (row.kind === "hunk") return { key: row.key, text, tone: "hunk", number: null, label: text };
  if (row.kind === "add") return { key: row.key, text, tone: "add", number: row.newNumber, label: `Added line ${row.newNumber}: ${row.text}` };
  if (row.kind === "del") return { key: row.key, text, tone: "del", number: row.oldNumber, label: `Deleted line ${row.oldNumber}: ${row.text}` };
  return { key: row.key, text, number: row.newNumber, label: `Line ${row.newNumber}: ${row.text}` };
}

/** The diff viewer (11 §11.20): the desktop's unified diff from
 * `git.fileDiff`, 22 pt rows with highlighting, Prev and Next file within
 * the list it was opened from (staged or not), and a wrap toggle. */
export default function DiffScreen() {
  const { env, projectId, path, cwd, staged } = useLocalSearchParams<{ env: string; projectId: string; path: string; cwd?: string; staged?: string }>();
  const t = useTokens();
  const colors = useMemo(() => codeColors(t), [t]);
  const known = useHosts((store) => store.records.some((record) => record.env === env));
  const index = useGitIndex(env, projectId, cwd, hostCan(env, "git.index")).value;
  const [loaded, setLoaded] = useState<Loaded>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(prefs.wrap);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const host = runtime(env);
    if (!known || !host) return;
    let current = true;
    fileDiff(host, makeScope(env, projectId, cwd), path, staged === "true").then(
      (diff) => {
        if (current) setLoaded({ diff, loading: false });
      },
      (error: unknown) => {
        if (current) setLoaded({ error: error instanceof Error ? error.message : String(error), loading: false });
      },
    );
    return () => {
      current = false;
    };
  }, [env, projectId, cwd, path, staged, known, attempt]);

  const diff = loaded.diff;
  const model = useMemo(() => (diff && !diff.binary && !diff.tooLarge ? fileDiffModel(diff.original, diff.current) : undefined), [diff]);
  const items = useMemo(() => model?.rows.map(item) ?? [], [model]);
  // Plain first; tokens for both whole sides arrive after the plain rows have painted.
  const key = useMemo(() => (diff && model ? highlightKey(t.scheme, path, diff.original, diff.current) : null), [diff, model, t.scheme, path]);
  const highlight = useCallback(async () => (diff && model ? highlightDiff(diff, model.rows, path, t.scheme) : null), [diff, model, path, t.scheme]);
  const tokens = useDeferredHighlight(key, highlight, wrap);
  const maxNumber = useMemo(() => items.reduce((max, row) => Math.max(max, row.number ?? 0), 0), [items]);
  const maxColumns = useMemo(() => items.reduce((max, row) => Math.max(max, columnsOf(row.text)), 0), [items]);
  const gutter = gutterWidth(maxNumber);
  const columns = wrap && size.width ? wrapColumns(size.width, gutter, DIFF_METRICS) : undefined;
  const inner = wrap ? size.width : Math.max(size.width, contentWidth(maxColumns, gutter, DIFF_METRICS));

  const side: ChangeSide = staged === "true" ? "staged" : "unstaged";
  const { previous, next } = neighbours(index?.files ?? [], path, side);

  const toggleWrap = () => {
    prefs.wrap = !wrap;
    setWrap(!wrap);
  };

  const retry = () => {
    setLoaded({ loading: true });
    setAttempt((value) => value + 1);
  };

  const list = (
    <FlashList
      data={items}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.tone ?? "context"}
      extraData={{ columns, gutter, tokens }}
      renderItem={({ item: row, index }) => (
        <CodeLine
          text={row.text}
          tokens={tokens?.[index]}
          number={row.number}
          gutter={gutter}
          metrics={DIFF_METRICS}
          wrap={columns}
          tone={row.tone}
          colors={colors}
          accessibilityLabel={row.label}
        />
      )}
      contentContainerStyle={{ paddingBottom: 40 }}
    />
  );

  const note = (text: string) => <Text style={{ color: t.text.tertiary, fontSize: TYPE.secondary.size, padding: 16 }}>{text}</Text>;
  let body;
  if (loaded.loading) {
    body = (
      <View style={{ paddingTop: 48, alignItems: "center" }}>
        <ActivityIndicator color={t.text.faint} />
      </View>
    );
  } else if (loaded.error) {
    body = (
      <View style={{ padding: 16, gap: 8, alignItems: "flex-start" }}>
        <Text style={{ color: t.text.secondary, fontSize: TYPE.secondary.size, lineHeight: TYPE.secondary.line }}>{loaded.error}</Text>
        <Button label="Retry" variant="ghost" onPress={retry} />
      </View>
    );
  } else if (diff?.binary) {
    body = note("Binary file changed");
  } else if (diff?.tooLarge) {
    body = note("Diff is too large to display");
  } else if (!items.length) {
    body = note("No textual diff");
  } else if (!size.width) {
    body = null;
  } else if (wrap) {
    body = list;
  } else {
    body = (
      <ScrollView horizontal bounces={false} contentContainerStyle={{ width: inner }}>
        <View style={{ width: inner, height: size.height }}>{list}</View>
      </ScrollView>
    );
  }

  const folder = dirname(path);
  return (
    <View style={{ flex: 1, backgroundColor: t.base }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <HeaderTitle
              title={basename(path)}
              subline={
                <Text numberOfLines={1} style={{ color: t.text.tertiary, fontSize: TYPE.meta.size }}>
                  {model ? <DiffStatText additions={model.additions} deletions={model.deletions} /> : null}
                  {model && (model.additions || model.deletions) && folder ? "  " : null}
                  {folder}
                </Text>
              }
            />
          ),
        }}
      />
      <Toolbar>
        <ToolButton
          icon="chevron.left"
          label="Prev"
          accessibilityLabel="Previous file"
          disabled={!previous}
          onPress={() => previous && openDiff(env, projectId, cwd, previous, side, true)}
        />
        <ToolButton icon="chevron.right" iconAfter label="Next" accessibilityLabel="Next file" disabled={!next} onPress={() => next && openDiff(env, projectId, cwd, next, side, true)} />
        <View style={{ flex: 1 }} />
        <ToggleChip label="Wrap" selected={wrap} onPress={toggleWrap} />
      </Toolbar>
      <View style={{ flex: 1 }} onLayout={(event) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
        {body}
      </View>
    </View>
  );
}
