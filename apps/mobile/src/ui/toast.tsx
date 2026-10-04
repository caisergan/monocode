// Quiet notices (11 §11.23): a 12 pt glass pill for 2 s, e.g. "Answered on
// another device". Anything can show one; the root layout renders them.

import { useEffect, useState } from "react";
import { Animated, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";
import { RADII } from "@monocode/design";
import { useTokens } from "./theme";

const VISIBLE_MS = 2_000;

type ToastState = { text?: string; id: number };

const useToast = create<ToastState>(() => ({ id: 0 }));

export function showToast(text: string): void {
  useToast.setState((state) => ({ text, id: state.id + 1 }));
}

export function Toasts() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const { text, id } = useToast();
  const [opacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!text) return;
    opacity.setValue(0);
    const show = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(VISIBLE_MS),
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]);
    show.start(({ finished }) => {
      if (finished) useToast.setState({ text: undefined });
    });
    return () => show.stop();
  }, [text, id, opacity]);

  if (!text) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 96, alignItems: "center" }}>
      <Animated.View
        accessibilityLiveRegion="polite"
        style={{
          opacity,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: RADII.full,
          backgroundColor: t.base,
          borderWidth: 1,
          borderColor: t.border.default,
        }}
      >
        <Text style={{ color: t.contentAlpha(0.85), fontSize: 12 }}>{text}</Text>
      </Animated.View>
    </View>
  );
}
