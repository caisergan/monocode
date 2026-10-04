// A native action sheet for in-content menus (11 §11.1: context menus become
// action sheets): UIActionSheet on iOS, an alert's buttons elsewhere.

import { ActionSheetIOS, Alert, Platform } from "react-native";

export type SheetAction = { label: string; onPress: () => void; disabled?: boolean; destructive?: boolean };

export function showActions(actions: readonly SheetAction[], title?: string): void {
  if (Platform.OS === "ios") {
    const labels = [...actions.map((action) => action.label), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: labels,
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.flatMap((action, index) => (action.destructive ? [index] : [])),
        disabledButtonIndices: actions.flatMap((action, index) => (action.disabled ? [index] : [])),
      },
      (index) => {
        if (index < actions.length && !actions[index].disabled) actions[index].onPress();
      },
    );
    return;
  }
  Alert.alert(title ?? "", undefined, [
    ...actions
      .filter((action) => !action.disabled)
      .map((action) => ({ text: action.label, style: action.destructive ? ("destructive" as const) : ("default" as const), onPress: action.onPress })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}
