import "@/polyfills";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { startHosts } from "@/hosts/registry";
import { useTokens } from "@/ui/theme";

export default function RootLayout() {
  const scheme = useColorScheme();
  const t = useTokens();
  useEffect(() => {
    void startHosts();
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
        <Stack.Screen name="m/[env]/s/[sessionId]" options={{ title: "" }} />
      </Stack>
    </ThemeProvider>
  );
}
