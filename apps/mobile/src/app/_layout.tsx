import "@/polyfills";
import { Image } from "expo-image";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform, useColorScheme } from "react-native";
import { startHosts } from "@/hosts/registry";
import { startOutbox } from "@/outbox";
import { ApprovalBanner } from "@/ui/ApprovalBanner";
import { useTokens } from "@/ui/theme";
import { Toasts } from "@/ui/toast";

export default function RootLayout() {
  const scheme = useColorScheme();
  const t = useTokens();
  useEffect(() => {
    // Commands queued in an earlier launch go out once the hosts are back.
    void startHosts().then(() => startOutbox());
    // The image disk cache budget (12 §12.6); configurable on iOS only.
    if (Platform.OS === "ios") Image.configureCache({ maxDiskSize: 200 * 1024 * 1024 });
  }, []);
  const base = scheme === "light" ? DefaultTheme : DarkTheme;
  return (
    <ThemeProvider
      value={{
        ...base,
        colors: { ...base.colors, background: t.base, card: t.base, text: t.content, border: t.stroke, primary: t.accent },
      }}
    >
      <StatusBar style={scheme === "light" ? "dark" : "light"} />
      <Stack screenOptions={{ contentStyle: { backgroundColor: t.base } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Pair a computer", presentation: "modal" }} />
        <Stack.Screen name="lab" options={{ title: "Transcript lab" }} />
        <Stack.Screen name="new" options={{ title: "New session", presentation: "modal" }} />
        <Stack.Screen name="m/[env]/p/[projectId]" options={{ title: "" }} />
        <Stack.Screen name="m/[env]/s/[sessionId]" options={{ title: "" }} />
        <Stack.Screen name="m/[env]/explorer" options={{ title: "" }} />
        <Stack.Screen name="m/[env]/changes" options={{ title: "" }} />
        <Stack.Screen name="m/[env]/file" options={{ title: "" }} />
        <Stack.Screen name="m/[env]/diff" options={{ title: "" }} />
        <Stack.Screen
          name="m/[env]/s/[sessionId]/tool"
          options={{ presentation: "formSheet", sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true, headerShown: false }}
        />
        <Stack.Screen
          name="m/[env]/s/[sessionId]/attachment"
          options={{ presentation: "formSheet", sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true, headerShown: false }}
        />
      </Stack>
      <ApprovalBanner />
      <Toasts />
    </ThemeProvider>
  );
}
