import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useTokens } from "@/ui/theme";
import { useAgents } from "@/hosts/store";

export default function TabsLayout() {
  const t = useTokens();
  const needsInput = useAgents((state) => state.needsInput);
  return (
    <NativeTabs tintColor={t.accent}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.text.bubble.right", selected: "bubble.left.and.text.bubble.right.fill" }} md="forum" />
        {needsInput > 0 ? <NativeTabs.Trigger.Badge>{String(needsInput)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
