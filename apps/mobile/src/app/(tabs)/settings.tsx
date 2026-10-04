import { router } from "expo-router";
import Constants from "expo-constants";
import { Alert, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { removeHost, runtime } from "@/hosts/registry";
import { useHosts } from "@/hosts/store";
import type { HostConnState } from "@/hosts/types";
import { Button, Card, Row, SectionLabel, Title } from "@/ui/components";
import { useTokens } from "@/ui/theme";

function describe(state: HostConnState | undefined): { text: string; color: "done" | "attention" | "danger" | "faint" } {
  switch (state?.kind) {
    case "online":
      return { text: `Direct · ${state.via === "lan" ? "Wi-Fi" : state.via === "tailscale" ? "Tailscale" : "Custom"} · ${state.rttMs} ms`, color: "done" };
    case "connecting":
      return { text: "Connecting…", color: "faint" };
    case "reconnecting":
      return { text: "Reconnecting…", color: "attention" };
    case "offline":
      return { text: "Offline", color: "faint" };
    case "blocked":
      return {
        text: state.reason === "device_revoked" ? "This phone was removed" : state.reason === "protocol_incompatible" ? "Host needs an update" : "Identity changed; pair again",
        color: "danger",
      };
    default:
      return { text: "Not connected", color: "faint" };
  }
}

export default function Settings() {
  const t = useTokens();
  const { records, states } = useHosts();
  const colors = { done: t.status.done, attention: t.status.attention, danger: t.status.danger, faint: t.text.faint };
  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: t.base }}>
      <Title>Settings</Title>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40, gap: 10 }}>
        <SectionLabel>Machines</SectionLabel>
        {records.map((record) => {
          const status = describe(states[record.env]);
          return (
            <Card key={record.env}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors[status.color] }} />
                <Text style={{ color: t.content, fontSize: 15, fontWeight: "600", flex: 1 }}>{record.label}</Text>
              </View>
              <Row label="Status" value={status.text} />
              <Row label="Fingerprint" value={record.fingerprint} mono />
              <Row label="Addresses" value={record.endpoints.map((endpoint) => endpoint.addr).join(", ")} mono />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button label="Reconnect" variant="secondary" style={{ flex: 1 }} onPress={() => runtime(record.env)?.onForeground()} />
                <Button
                  label="Remove"
                  variant="danger"
                  style={{ flex: 1 }}
                  onPress={() =>
                    Alert.alert(`Remove ${record.label}?`, "This phone will no longer reach it. You can pair again later.", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => void removeHost(record.env) },
                    ])
                  }
                />
              </View>
            </Card>
          );
        })}
        <Button label="Pair a computer" onPress={() => router.push("/pair")} />
        <SectionLabel>Developer</SectionLabel>
        <Button label="Transcript lab" variant="secondary" onPress={() => router.push("/lab")} />
        <Text style={{ color: t.text.faint, fontSize: 12, textAlign: "center", marginTop: 12 }}>
          {Constants.expoConfig?.name} {Constants.expoConfig?.version}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
