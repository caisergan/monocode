import { RADII, TYPE } from "@monocode/design";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
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

/** The rail's search row (11 §11.13, §11.14). */
export function SearchField({ value, onChangeText, placeholder }: { value: string; onChangeText: (text: string) => void; placeholder: string }) {
  const t = useTokens();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={t.text.faint}
      autoCapitalize="none"
      autoCorrect={false}
      clearButtonMode="while-editing"
      returnKeyType="search"
      style={{
        flex: 1,
        height: 36,
        paddingHorizontal: 12,
        borderRadius: RADII.md,
        backgroundColor: t.fill.chip,
        color: t.content,
        fontSize: TYPE.row.size,
      }}
    />
  );
}

/** A filter toggle: 28 pt visual, 44 pt hit (11 §11.9). */
export function ToggleChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const t = useTokens();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      hitSlop={8}
      style={{
        height: 28,
        paddingHorizontal: 10,
        justifyContent: "center",
        borderRadius: RADII.md,
        backgroundColor: selected ? t.selection.hover : t.fill.chip,
        borderWidth: 1,
        borderColor: selected ? t.border.focus : "transparent",
      }}
    >
      <Text style={{ color: selected ? t.content : t.contentAlpha(0.7), fontSize: TYPE.meta.size + 1 }}>{label}</Text>
    </Pressable>
  );
}

/** The desktop's remote notice bar (11 §11.15): one line, one action. */
export function NoticeBar({ text, action }: { text: string; action?: { label: string; onPress: () => void } }) {
  const t = useTokens();
  return (
    <View style={{ borderBottomWidth: 1, borderColor: t.stroke, paddingHorizontal: 16, paddingVertical: 8, flexDirection: "row", gap: 8 }}>
      <Text style={{ flex: 1, color: t.contentAlpha(0.65), fontSize: 12 }}>{text}</Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={12}>
          <Text style={{ color: t.contentAlpha(0.65), fontSize: 12, fontWeight: "500" }}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
