// The viewers' tool row: a 44 pt bar under the navigation bar holding small
// buttons and toggles (28 pt visual, 44 pt hit, 11 §11.5).

import { RADII, TYPE } from "@monocode/design";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, type IconName } from "./icon";
import { useTokens } from "./theme";

export const TOOLBAR_HEIGHT = 44;

export function Toolbar({ children }: { children: ReactNode }) {
  const t = useTokens();
  return (
    <View
      style={{
        height: TOOLBAR_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderColor: t.stroke,
      }}
    >
      {children}
    </View>
  );
}

export function ToolButton({
  icon,
  label,
  iconAfter,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  icon?: IconName;
  label?: string;
  /** Draw the icon after the label ("Next ›"). */
  iconAfter?: boolean;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const t = useTokens();
  const color = t.contentAlpha(0.75);
  const glyph = icon ? <Icon name={icon} size={13} color={color} /> : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        height: 28,
        minWidth: 28,
        paddingHorizontal: label ? 10 : 0,
        borderRadius: RADII.md,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        backgroundColor: pressed ? t.selection.hover : t.fill.chip,
        opacity: disabled ? 0.4 : 1,
      })}
    >
      {iconAfter ? null : glyph}
      {label ? <Text style={{ color, fontSize: TYPE.meta.size + 1 }}>{label}</Text> : null}
      {iconAfter ? glyph : null}
    </Pressable>
  );
}

/** A screen title with a subline, as on the Project and Session screens. */
export function HeaderTitle({ title, subline }: { title: string; subline?: ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ alignItems: "center", maxWidth: 260 }}>
      <Text numberOfLines={1} style={{ color: t.content, fontSize: TYPE.screenTitle.size, fontWeight: "600" }}>
        {title}
      </Text>
      {subline ? (
        typeof subline === "string" ? (
          <Text numberOfLines={1} style={{ color: t.text.tertiary, fontSize: TYPE.meta.size }}>
            {subline}
          </Text>
        ) : (
          subline
        )
      ) : null}
    </View>
  );
}
