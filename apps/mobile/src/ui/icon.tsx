import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { View } from "react-native";

export type IconName = Extract<SymbolViewProps["name"], string>;

/** An SF Symbol; an empty box of the same size where symbols don't exist. */
export function Icon({ name, size = 16, color }: { name: IconName; size?: number; color: string }) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      style={{ width: size, height: size }}
      fallback={<View style={{ width: size, height: size }} />}
    />
  );
}
