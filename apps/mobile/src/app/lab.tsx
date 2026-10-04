import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Block } from "@monocode/core/session";
import { MonoTranscript, type BenchmarkResult, type MonoTranscriptHandle } from "@transcript";
import { fixtureSession, streamScript } from "@/transcript/fixtures";
import { buildRows } from "@/transcript/rows";
import { Button } from "@/ui/components";
import { transcriptTheme, useTokens } from "@/ui/theme";

const STREAM_CHARS_PER_SECOND = 90;
const TOOL_EVENTS_PER_SECOND = 5;

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** The transcript lab and benchmark (15 §15.6): fixtures, a simulated
 * stream, and the native fling benchmark with its hitch ratio. */
export default function Lab() {
  const t = useTokens();
  const theme = useMemo(() => transcriptTheme(t), [t]);
  const transcript = useRef<MonoTranscriptHandle>(null);
  const blocks = useRef<Block[]>([]);
  const open = useRef(new Set<string>());
  const [scenario, setScenario] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState<BenchmarkResult>();
  const [jsStats, setJsStats] = useState("");
  const deltaMs = useRef<number[]>([]);
  const stream = useRef<{ timer?: ReturnType<typeof setInterval>; offset: number; text: string; tick: number }>({ offset: 0, text: "", tick: 0 });

  const push = (live: boolean) => {
    const started = performance.now();
    const rows = buildRows(blocks.current, { live, open: open.current });
    transcript.current?.setRows(rows);
    return { ms: performance.now() - started, rows: rows.length };
  };

  const load = (turns: number, name: string) => {
    stopStream();
    blocks.current = fixtureSession(turns);
    const { ms, rows } = push(false);
    setScenario(`${name}: ${turns} turns, ${rows} rows, JS build ${ms.toFixed(1)} ms`);
    setResult(undefined);
  };

  const stopStream = () => {
    clearInterval(stream.current.timer);
    stream.current.timer = undefined;
    setStreaming(false);
  };

  const startStream = () => {
    if (!blocks.current.length) blocks.current = fixtureSession(1000);
    const script = streamScript();
    const turn = blocks.current.length;
    blocks.current = [
      ...blocks.current,
      { id: `live-u${turn}`, role: "user", text: "Stream a long answer with tool calls", startedAt: Date.now() },
      { id: `live-a${turn}`, role: "assistant", text: "", streaming: true },
    ];
    stream.current = { offset: 0, text: script.text, tick: 0 };
    deltaMs.current = [];
    setStreaming(true);
    const started = Date.now();
    stream.current.timer = setInterval(() => {
      const state = stream.current;
      state.tick++;
      const target = Math.floor(((Date.now() - started) / 1000) * STREAM_CHARS_PER_SECOND);
      const list = blocks.current;
      const last = list[list.length - 1];
      let next = list;
      if (target > state.offset) {
        state.offset = Math.min(state.text.length, target);
        next = [...list.slice(0, -1), { ...last, text: state.text.slice(0, state.offset) }];
      }
      // Tool events land in the trail just above the streaming answer.
      if (state.tick % Math.round(60 / TOOL_EVENTS_PER_SECOND) === 0) {
        const file = script.files[state.tick % script.files.length];
        const tool: Block = { id: `live-t${state.tick}`, role: "tool", text: `Read ${file}`, tool: { kind: "read", status: "completed", preview: { kind: "read", path: file } } };
        next = [...next.slice(0, -1), tool, next[next.length - 1]];
      }
      if (next === list) return;
      blocks.current = next;
      const { ms } = push(true);
      deltaMs.current.push(ms);
      if (deltaMs.current.length % 60 === 0)
        setJsStats(`JS per delta p50 ${percentile(deltaMs.current, 0.5).toFixed(2)} ms · p95 ${percentile(deltaMs.current, 0.95).toFixed(2)} ms`);
      if (state.offset >= state.text.length) stopStream();
    }, 16);
  };

  useEffect(() => () => clearInterval(stream.current.timer), []);

  // monocode-dev://lab?run=huge or ?run=huge-stream runs the benchmark
  // unattended; results land in Documents/benchmarks/latest.json.
  const { run } = useLocalSearchParams<{ run?: string }>();
  useEffect(() => {
    if (run !== "huge" && run !== "huge-stream" && run !== "big") return;
    load(run === "big" ? 120 : 1000, run);
    const timers = [
      setTimeout(() => {
        if (run === "huge-stream") startStream();
      }, 2_000),
      setTimeout(() => transcript.current?.runBenchmark(10_000, 6_000), 3_500),
      setTimeout(stopStream, 14_000),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  return (
    <View style={{ flex: 1, backgroundColor: t.base }}>
      <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, padding: 8 }}>
        <Button label="120 turns" variant="secondary" onPress={() => load(120, "big")} />
        <Button label="1,000 turns" variant="secondary" onPress={() => load(1000, "huge")} />
        <Button label={streaming ? "Stop stream" : "Stream"} variant="secondary" onPress={() => (streaming ? stopStream() : startStream())} />
        <Button label="Fling 10 s" onPress={() => transcript.current?.runBenchmark(10_000, 6_000)} />
      </ScrollView>
      <View style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
        <Text style={{ color: t.text.tertiary, fontSize: 12 }}>{scenario || "Load a fixture."}</Text>
        {jsStats ? <Text style={{ color: t.text.tertiary, fontSize: 12 }}>{jsStats}</Text> : null}
        {result ? (
          <Text selectable style={{ color: result.hitchRatio === 0 ? t.status.done : t.status.attention, fontSize: 12, fontFamily: "Menlo" }}>
            {`hitch ${result.hitchRatio.toFixed(2)} ms/s (${result.hitches} in ${result.frames} frames @${result.expectedFrameMs.toFixed(1)} ms)\n` +
              `frame p50 ${result.frameP50.toFixed(1)} p95 ${result.frameP95.toFixed(1)} p99 ${result.frameP99.toFixed(1)} max ${result.frameMax.toFixed(1)} ms\n` +
              `rows ${result.rows} · height ${Math.round(result.contentHeight)} pt · sync draws ${result.syncDraws}\n` +
              `cold first ${result.coldFirstMs.toFixed(0)} ms · cold all ${result.coldTotalMs.toFixed(0)} ms (${result.coldRows} rows)\n` +
              `measure p50 ${result.measureP50.toFixed(3)} p95 ${result.measureP95.toFixed(3)} ms · tail relayout p95 ${result.tailUpdateP95.toFixed(3)} ms (${result.tailUpdates})\n` +
              `raster p50 ${result.rasterP50.toFixed(2)} p95 ${result.rasterP95.toFixed(2)} ms (${result.rasterCount})`}
          </Text>
        ) : null}
      </View>
      <MonoTranscript
        ref={transcript}
        theme={theme}
        style={{ flex: 1 }}
        bottomInset={24}
        onAction={(rowId, actionId) => {
          if (actionId !== "fold") return;
          if (open.current.has(rowId)) open.current.delete(rowId);
          else open.current.add(rowId);
          push(streaming);
        }}
        onBenchmark={(value) => {
          setResult(value);
          console.log(`[bench] ${JSON.stringify(value)}`);
        }}
      />
    </View>
  );
}
