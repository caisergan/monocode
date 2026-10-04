import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, TextInput, View, type ViewToken } from "react-native";
import { RADII, TYPE } from "@monocode/design";
import { MonoTranscript, type MonoTranscriptHandle } from "@transcript";
import { runtime } from "@/hosts/registry";
import { useHosts } from "@/hosts/store";
import { markdownRows } from "@/transcript/markdown";
import { CODE_PAD, CodeLine, codeColors, contentWidth, FILE_METRICS, gutterWidth, wrapColumns } from "@/ui/CodeLine";
import { Button, ToggleChip } from "@/ui/components";
import { transcriptTheme, useTokens } from "@/ui/theme";
import { HeaderTitle, Toolbar, TOOLBAR_HEIGHT, ToolButton } from "@/ui/toolbar";
import { CANT_SHOW, cantShowError, readFile, viewableText } from "@/workspace/api";
import { splitLines } from "@/workspace/diff";
import { findCounter, findMatches, marksByLine, matchFrom, stepMatch, type FindMatch } from "@/workspace/find";
import { highlightFile, highlightKey, useDeferredHighlight } from "@/workspace/highlight";
import { columnsOf, displayText, monoWidth } from "@/workspace/lines";
import { basename, dirname, isMarkdown } from "@/workspace/paths";
import { makeScope } from "@/workspace/store";

/** The last wrap choice, kept for the next file while the app runs. */
const prefs = { wrap: false };

type Loaded = { text?: string; error?: string; failed: boolean; loading: boolean };
type Find = { open: boolean; query: string; matches: FindMatch[]; index: number };

const CLOSED: Find = { open: false, query: "", matches: [], index: 0 };

/** The file viewer (11 §11.20): `files.read` text up to 1 MiB in mono 13 / 19
 * with line numbers, highlighting, a wrap toggle, find, and Preview for
 * Markdown. */
export default function FileScreen() {
  const { env, projectId, path, cwd } = useLocalSearchParams<{ env: string; projectId: string; path: string; cwd?: string }>();
  const t = useTokens();
  const colors = useMemo(() => codeColors(t), [t]);
  const theme = useMemo(() => transcriptTheme(t), [t]);
  const known = useHosts((store) => store.records.some((record) => record.env === env));
  const [loaded, setLoaded] = useState<Loaded>({ failed: false, loading: true });
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(prefs.wrap);
  const [preview, setPreview] = useState(false);
  const [find, setFind] = useState<Find>(CLOSED);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const list = useRef<FlashListRef<string>>(null);
  const across = useRef<ScrollView>(null);
  const previewRef = useRef<MonoTranscriptHandle>(null);
  const topLine = useRef(0);

  useEffect(() => {
    const host = runtime(env);
    if (!known || !host) return;
    let current = true;
    readFile(host, makeScope(env, projectId, cwd), path).then(
      (value) => {
        if (!current) return;
        const text = viewableText(value);
        setLoaded(text === undefined ? { failed: true, loading: false } : { text, failed: false, loading: false });
      },
      (error: unknown) => {
        if (!current) return;
        // Oversized and binary files only get the "can't be shown" line.
        if (cantShowError(error)) setLoaded({ failed: true, loading: false });
        else setLoaded({ failed: true, error: error instanceof Error ? error.message : String(error), loading: false });
      },
    );
    return () => {
      current = false;
    };
  }, [env, projectId, cwd, path, known, attempt]);

  // Preview opens at the top, not at the transcript's live tail.
  useEffect(() => {
    if (preview) previewRef.current?.setFollowTail(false);
  }, [preview]);

  const raw = useMemo(() => (loaded.text === undefined ? [] : splitLines(loaded.text)), [loaded.text]);
  const lines = useMemo(() => raw.map(displayText), [raw]);
  // Plain first; tokens arrive after the plain rows have painted.
  const key = useMemo(() => (loaded.text === undefined ? null : highlightKey(t.scheme, path, loaded.text)), [t.scheme, path, loaded.text]);
  const highlight = useCallback(() => highlightFile(loaded.text ?? "", raw, path, t.scheme), [loaded.text, raw, path, t.scheme]);
  const tokens = useDeferredHighlight(key, highlight, wrap);
  const maxColumns = useMemo(() => lines.reduce((max, line) => Math.max(max, columnsOf(line)), 0), [lines]);
  const gutter = gutterWidth(lines.length);
  const columns = wrap && size.width ? wrapColumns(size.width, gutter, FILE_METRICS) : undefined;
  const inner = wrap ? size.width : Math.max(size.width, contentWidth(maxColumns, gutter, FILE_METRICS));
  const marks = useMemo(() => marksByLine(find.matches, find.index), [find.matches, find.index]);
  const rows = useMemo(() => (preview && loaded.text !== undefined ? markdownRows(loaded.text, "preview") : undefined), [preview, loaded.text]);
  const markdown = isMarkdown(path);

  const onViewable = useCallback(({ viewableItems }: { viewableItems: ViewToken<string>[] }) => {
    topLine.current = viewableItems[0]?.index ?? 0;
  }, []);

  /** Scrolls the match into view, across too when lines don't wrap. */
  const reveal = (match: FindMatch | undefined) => {
    if (!match) return;
    void list.current?.scrollToIndex({ index: match.line, viewPosition: 0.3, animated: true });
    if (!wrap) {
      const x = gutter + CODE_PAD + monoWidth(columnsOf(lines[match.line].slice(0, match.start)), FILE_METRICS.size) - size.width / 3;
      across.current?.scrollTo({ x: Math.max(0, x), animated: true });
    }
  };

  const search = (query: string) => {
    const matches = findMatches(lines, query);
    const index = matchFrom(matches, topLine.current);
    setFind({ open: true, query, matches, index });
    reveal(matches[index]);
  };

  const step = (delta: 1 | -1) => {
    if (!find.matches.length) return;
    const index = stepMatch(find.index, find.matches.length, delta);
    setFind({ ...find, index });
    reveal(find.matches[index]);
  };

  const toggleWrap = () => {
    prefs.wrap = !wrap;
    setWrap(!wrap);
  };

  const retry = () => {
    setLoaded({ failed: false, loading: true });
    setAttempt((value) => value + 1);
  };

  const code = (
    <FlashList
      ref={list}
      data={lines}
      keyExtractor={(_, index) => String(index)}
      extraData={{ columns, marks, gutter, tokens }}
      renderItem={({ item, index }) => (
        <CodeLine
          text={item}
          tokens={tokens?.[index]}
          number={index + 1}
          gutter={gutter}
          metrics={FILE_METRICS}
          wrap={columns}
          marks={marks.get(index)}
          colors={colors}
        />
      )}
      onViewableItemsChanged={onViewable}
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingTop: 6, paddingBottom: 40 }}
    />
  );

  let body;
  if (loaded.loading) {
    body = (
      <View style={{ paddingTop: 48, alignItems: "center" }}>
        <ActivityIndicator color={t.text.faint} />
      </View>
    );
  } else if (loaded.failed) {
    body = (
      <View style={{ paddingTop: 56, paddingHorizontal: 28, alignItems: "center", gap: 10 }}>
        <Text style={{ color: t.text.secondary, fontSize: TYPE.row.size, lineHeight: TYPE.row.line, textAlign: "center" }}>{CANT_SHOW}</Text>
        {loaded.error ? (
          <Text style={{ color: t.text.faint, fontSize: TYPE.secondary.size, lineHeight: TYPE.secondary.line, textAlign: "center" }}>{loaded.error}</Text>
        ) : null}
        {loaded.error ? <Button label="Retry" variant="ghost" onPress={retry} /> : null}
      </View>
    );
  } else if (!lines.length) {
    body = <Text style={{ color: t.text.tertiary, fontSize: TYPE.secondary.size, padding: 16 }}>Empty file</Text>;
  } else if (preview && markdown) {
    body = (
      <MonoTranscript
        ref={previewRef}
        rows={rows}
        theme={theme}
        style={{ flex: 1 }}
        topInset={8}
        bottomInset={32}
        onLink={(_, href) => {
          if (/^(https?:|mailto:)/i.test(href)) void Linking.openURL(href);
        }}
      />
    );
  } else if (!size.width) {
    body = null;
  } else if (wrap) {
    body = code;
  } else {
    body = (
      <ScrollView ref={across} horizontal bounces={false} contentContainerStyle={{ width: inner }}>
        <View style={{ width: inner, height: size.height }}>{code}</View>
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.base }}>
      <Stack.Screen options={{ headerTitle: () => <HeaderTitle title={basename(path)} subline={dirname(path) || undefined} /> }} />
      {loaded.text === undefined || !lines.length ? null : find.open ? (
        <View style={{ height: TOOLBAR_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, borderBottomWidth: 1, borderColor: t.stroke }}>
          <TextInput
            autoFocus
            value={find.query}
            onChangeText={search}
            placeholder="Find in file"
            placeholderTextColor={t.text.faint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            submitBehavior="submit"
            onSubmitEditing={() => step(1)}
            style={{ flex: 1, height: 32, paddingHorizontal: 10, borderRadius: RADII.md, backgroundColor: t.fill.chip, color: t.content, fontSize: TYPE.row.size }}
          />
          {find.query ? (
            <Text accessibilityLiveRegion="polite" style={{ color: t.text.secondary, fontSize: TYPE.meta.size, fontVariant: ["tabular-nums"] }}>
              {findCounter(find.index, find.matches.length)}
            </Text>
          ) : null}
          <ToolButton icon="chevron.up" accessibilityLabel="Previous match" disabled={!find.matches.length} onPress={() => step(-1)} />
          <ToolButton icon="chevron.down" accessibilityLabel="Next match" disabled={!find.matches.length} onPress={() => step(1)} />
          <Pressable accessibilityRole="button" hitSlop={12} onPress={() => setFind(CLOSED)}>
            <Text style={{ color: t.content, fontSize: TYPE.row.size, fontWeight: "500" }}>Done</Text>
          </Pressable>
        </View>
      ) : (
        <Toolbar>
          {preview ? null : <ToggleChip label="Wrap" selected={wrap} onPress={toggleWrap} />}
          {markdown ? <ToggleChip label="Preview" selected={preview} onPress={() => setPreview((value) => !value)} /> : null}
          <View style={{ flex: 1 }} />
          {preview ? null : <ToolButton icon="magnifyingglass" accessibilityLabel="Find in file" onPress={() => setFind({ ...CLOSED, open: true })} />}
        </Toolbar>
      )}
      <View style={{ flex: 1 }} onLayout={(event) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
        {body}
      </View>
    </View>
  );
}
