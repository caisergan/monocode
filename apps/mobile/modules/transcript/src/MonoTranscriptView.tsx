import { requireNativeViewManager } from "expo-modules-core";
import { forwardRef, useEffect, useImperativeHandle, useRef, type ComponentType, type Ref } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { diffRows } from "./diff";
import type { BenchmarkResult, RowSpec, TranscriptOp, TranscriptTheme } from "./spec";

type NativeHandle = {
  apply(ops: string): Promise<void>;
  setTheme(theme: string): Promise<void>;
  scrollToBottom(animated: boolean): Promise<void>;
  setFollowTail(on: boolean): Promise<void>;
  runBenchmark(durationMs: number, speed: number): Promise<void>;
};

type NativeProps = {
  style?: StyleProp<ViewStyle>;
  bottomInset?: number;
  topInset?: number;
  onAction?: (event: { nativeEvent: { rowId: string; actionId: string } }) => void;
  onLink?: (event: { nativeEvent: { rowId: string; href: string } }) => void;
  onAtBottomChange?: (event: { nativeEvent: { atBottom: boolean } }) => void;
  onNeedOlder?: () => void;
  onBenchmark?: (event: { nativeEvent: BenchmarkResult }) => void;
  onReady?: (event: { nativeEvent: { rows: number } }) => void;
};

const NativeView = requireNativeViewManager("MonoTranscript") as unknown as ComponentType<
  NativeProps & { ref?: Ref<NativeHandle> }
>;

export type MonoTranscriptHandle = {
  /** Sends rows without a React render: the streaming path. */
  setRows(rows: readonly RowSpec[]): void;
  scrollToBottom(animated?: boolean): void;
  setFollowTail(on: boolean): void;
  runBenchmark(durationMs: number, speed: number): void;
};

export type MonoTranscriptProps = {
  rows?: readonly RowSpec[];
  theme: TranscriptTheme;
  style?: StyleProp<ViewStyle>;
  bottomInset?: number;
  topInset?: number;
  onAction?: (rowId: string, actionId: string) => void;
  onLink?: (rowId: string, href: string) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onNeedOlder?: () => void;
  onBenchmark?: (result: BenchmarkResult) => void;
  onReady?: (rows: number) => void;
};

/** Sends row changes to the native transcript as ops, at most once per
 * frame. React re-renders only when `rows` identity changes; nothing in the
 * transcript is drawn by React. */
export const MonoTranscript = forwardRef<MonoTranscriptHandle, MonoTranscriptProps>(function MonoTranscript(
  props,
  ref,
) {
  const native = useRef<NativeHandle>(null);
  const sent = useRef<readonly RowSpec[]>([]);
  const pending = useRef<readonly RowSpec[] | null>(null);
  const frame = useRef<number | null>(null);
  const themeKey = useRef("");

  const push = (rows: readonly RowSpec[]) => {
    pending.current = rows;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const next = pending.current;
      pending.current = null;
      if (!next || next === sent.current) return;
      const ops: TranscriptOp[] = diffRows(sent.current, next);
      sent.current = next;
      if (ops.length) void native.current?.apply(JSON.stringify(ops));
    });
  };

  useImperativeHandle(ref, () => ({
    setRows: push,
    scrollToBottom: (animated = true) => void native.current?.scrollToBottom(animated),
    setFollowTail: (on) => void native.current?.setFollowTail(on),
    runBenchmark: (durationMs, speed) => void native.current?.runBenchmark(durationMs, speed),
  }));

  useEffect(() => {
    const key = JSON.stringify(props.theme);
    if (key === themeKey.current) return;
    themeKey.current = key;
    void native.current?.setTheme(key);
  }, [props.theme]);

  useEffect(() => {
    if (props.rows) push(props.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.rows]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return (
    <NativeView
      ref={native}
      style={props.style}
      bottomInset={props.bottomInset ?? 0}
      topInset={props.topInset ?? 0}
      onAction={(event) => props.onAction?.(event.nativeEvent.rowId, event.nativeEvent.actionId)}
      onLink={(event) => props.onLink?.(event.nativeEvent.rowId, event.nativeEvent.href)}
      onAtBottomChange={(event) => props.onAtBottomChange?.(event.nativeEvent.atBottom)}
      onNeedOlder={() => props.onNeedOlder?.()}
      onBenchmark={(event) => props.onBenchmark?.(event.nativeEvent)}
      onReady={(event) => props.onReady?.(event.nativeEvent.rows)}
    />
  );
});
