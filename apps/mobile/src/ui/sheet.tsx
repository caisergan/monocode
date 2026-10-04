// Native page sheets for the composer's pickers (11 §11.17): a React Native
// Modal in the iOS page-sheet style, with the quick composer's row layout
// (16 pt icon, 15 pt label, 13 pt hint, accent check).

import { RADII, TYPE } from "@monocode/design";
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { Icon, type IconName } from "./icon";
import { useTokens } from "./theme";

export function Sheet({
  visible,
  onClose,
  title,
  children,
  scroll = true,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  scroll?: boolean;
}) {
  const t = useTokens();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.base }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
          <Text style={{ flex: 1, color: t.text.secondary, fontSize: TYPE.meta.size, fontWeight: "600", letterSpacing: 0.6 }}>
            {title.toUpperCase()}
          </Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={{ color: t.content, fontSize: TYPE.row.size, fontWeight: "500" }}>Done</Text>
          </Pressable>
        </View>
        {scroll ? (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
            {children}
          </ScrollView>
        ) : (
          children
        )}
      </View>
    </Modal>
  );
}

export function SheetRow({
  icon,
  iconColor,
  label,
  hint,
  checked,
  disabled,
  right,
  onPress,
}: {
  icon?: IconName;
  iconColor?: string;
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  right?: ReactNode;
  onPress?: () => void;
}) {
  const t = useTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: checked, disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        paddingHorizontal: 16,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: pressed ? t.fill.hover : "transparent",
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={16} color={iconColor ?? t.contentAlpha(0.7)} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.content, fontSize: TYPE.row.size, fontWeight: "500" }}>{label}</Text>
        {hint ? <Text style={{ color: t.contentAlpha(0.45), fontSize: TYPE.secondary.size, lineHeight: TYPE.secondary.line }}>{hint}</Text> : null}
      </View>
      {right}
      {checked ? <Icon name="checkmark" size={15} color={t.accent} /> : null}
    </Pressable>
  );
}

export function SheetSwitch({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (value: boolean) => void }) {
  return <SheetRow label={label} hint={hint} right={<Switch value={value} onValueChange={onChange} />} />;
}

export function SheetCaption({ children }: { children: ReactNode }) {
  const t = useTokens();
  return (
    <Text style={{ color: t.text.faint, fontSize: TYPE.meta.size, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 }}>{children}</Text>
  );
}

/** A 26 pt chip in a 44 pt hit area (11 §11.17 chip row). */
export function Chip({
  label,
  icon,
  iconColor,
  onPress,
  onClear,
  tone = "default",
  accessibilityLabel,
}: {
  label?: string;
  icon?: IconName;
  iconColor?: string;
  onPress?: () => void;
  onClear?: () => void;
  tone?: "default" | "plan" | "draft" | "selected";
  accessibilityLabel?: string;
}) {
  const t = useTokens();
  const fill =
    tone === "plan" ? "rgba(253,224,71,0.14)" : tone === "draft" ? t.fill.chip : tone === "selected" ? t.selection.hover : t.fill.chip;
  const border = tone === "plan" ? "rgba(253,224,71,0.35)" : tone === "draft" ? t.border.dashed : "transparent";
  const color = tone === "plan" ? "rgba(253,224,71,0.9)" : t.contentAlpha(0.75);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={{ top: 9, bottom: 9 }}
      style={{
        height: 26,
        paddingHorizontal: label ? 9 : 0,
        width: label ? undefined : 26,
        borderRadius: RADII.sm,
        backgroundColor: fill,
        borderWidth: 1,
        borderStyle: tone === "draft" ? "dashed" : "solid",
        borderColor: border,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
      }}
    >
      {icon ? <Icon name={icon} size={13} color={iconColor ?? color} /> : null}
      {label ? (
        <Text numberOfLines={1} style={{ color, fontSize: 13, maxWidth: 180 }}>
          {label}
        </Text>
      ) : null}
      {onClear ? (
        <Pressable accessibilityLabel={`Remove ${label ?? ""}`} onPress={onClear} hitSlop={10}>
          <Icon name="xmark" size={10} color={color} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}
