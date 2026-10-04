// The desktop's segmented control (`Segmented` in SettingsView.tsx and the
// sidebar's Sessions / Explorer / Changes tabs): a hairline box, options in
// equal columns, the selected one on `sel`. 32 pt visual, 44 pt hit (M2).

import { RADII, TYPE } from "@monocode/design";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTokens } from "./theme";

export type SegmentedOption<T extends string> = {
  value: T;
  /** A string, or a custom label such as the Changes segment's "+N −M". */
  label: ReactNode;
  accessibilityLabel?: string;
};

export const SEGMENTED_HEIGHT = 32;

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers. */
  label: string;
}) {
  const t = useTokens();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{
        height: SEGMENTED_HEIGHT,
        flexDirection: "row",
        gap: 2,
        padding: 2,
        borderRadius: RADII.md,
        borderWidth: 1,
        borderColor: t.border.default,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.accessibilityLabel ?? (typeof option.label === "string" ? option.label : undefined)}
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              borderRadius: RADII.sm,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: selected ? t.selection.normal : pressed ? t.fill.hover : "transparent",
            })}
          >
            {typeof option.label === "string" ? (
              <Text
                numberOfLines={1}
                style={{ color: selected ? t.content : t.text.secondary, fontSize: TYPE.secondary.size, lineHeight: TYPE.secondary.line, fontWeight: "500" }}
              >
                {option.label}
              </Text>
            ) : (
              option.label
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
