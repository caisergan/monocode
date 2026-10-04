import { RADII, TYPE } from "@monocode/design";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useTokens } from "./theme";

export function Title({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
      <Text style={{ flex: 1, color: t.content, fontSize: 28, lineHeight: 34, fontWeight: "600" }}>{children}</Text>
      {right}
    </View>
  );
}

export function SectionLabel({ children, dot }: { children: ReactNode; dot?: string }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 }}>
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot, boxShadow: `0 0 8px ${dot}` }} /> : null}
      <Text style={{ color: t.text.secondary, fontSize: TYPE.secondary.size, lineHeight: TYPE.secondary.line, fontWeight: "500" }}>
        {children}
      </Text>
    </View>
  );
}

export function Body({ children, style, faint }: { children: ReactNode; style?: StyleProp<TextStyle>; faint?: boolean }) {
  const t = useTokens();
  return (
    <Text style={[{ color: faint ? t.text.tertiary : t.text.prose, fontSize: TYPE.secondary.size + 1, lineHeight: 20 }, style]}>
      {children}
    </Text>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTokens();
  const fill =
    variant === "primary" ? t.primary : variant === "secondary" ? t.fill.bubble : variant === "danger" ? "rgba(239,68,68,0.2)" : "transparent";
  const color = variant === "primary" ? t.primaryText : variant === "danger" ? "#fca5a5" : t.contentAlpha(0.85);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 44,
          paddingHorizontal: 16,
          borderRadius: RADII.md,
          backgroundColor: fill,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={color} size="small" /> : null}
      <Text style={{ color, fontSize: TYPE.row.size, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style, dashed }: { children: ReactNode; style?: StyleProp<ViewStyle>; dashed?: boolean }) {
  const t = useTokens();
  return (
    <View
      style={[
        {
          borderRadius: RADII.lg,
          borderWidth: 1,
          borderStyle: dashed ? "dashed" : "solid",
          borderColor: dashed ? t.border.dashed : t.border.default,
          backgroundColor: t.fill.code,
          padding: 12,
          gap: 8,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, minHeight: 28, alignItems: "center" }}>
      <Text style={{ color: t.text.secondary, fontSize: 14 }}>{label}</Text>
      <Text
        selectable
        style={{ color: t.contentAlpha(0.85), fontSize: mono ? 13 : 14, fontFamily: mono ? "Menlo" : undefined, flexShrink: 1, textAlign: "right" }}
      >
        {value}
      </Text>
    </View>
  );
}
