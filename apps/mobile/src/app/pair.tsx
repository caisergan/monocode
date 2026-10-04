import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { formatCode, fromBase64Url, hostFingerprint, type Offer } from "@monocode/channel";
import { RADII } from "@monocode/design";
import { offerError, pair, readOffer, type PairingStep } from "@/pairing/pair";
import { Body, Button, Card, Row } from "@/ui/components";
import { useTokens } from "@/ui/theme";

type Stage = { kind: "intro" } | { kind: "scan" } | { kind: "review"; offer: Offer } | PairingStep;

function reachable(offer: Offer): string {
  const kinds = new Set((offer.direct ?? []).map((endpoint) => endpoint.kind));
  return [kinds.has("lan") && "Local network", kinds.has("tailscale") && "Tailscale", kinds.has("manual") && "Custom address", offer.relay && "Relay"]
    .filter(Boolean)
    .join(" · ");
}

/** Pairing (11 §11.11, 04 §4.7): scan or paste, review, confirm the code. */
export default function Pair() {
  const t = useTokens();
  const [stage, setStage] = useState<Stage>({ kind: "intro" });
  const [error, setError] = useState<string>();
  const [name, setName] = useState(Device.deviceName ?? "iPhone");
  const [permission, requestPermission] = useCameraPermissions();
  const cancel = useRef<() => void>(undefined);
  const scanned = useRef(false);

  const accept = (text: string) => {
    try {
      const offer = readOffer(text);
      setError(undefined);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStage({ kind: "review", offer });
    } catch (failure) {
      setError(offerError(failure));
      scanned.current = false;
    }
  };

  // A pairing link opened from the camera app or Safari. The same sources as
  // `Linking.useURL()`, read in their callbacks.
  useEffect(() => {
    const open = (url: string | null) => {
      if (url?.includes("#o=")) accept(url);
    };
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", ({ url }) => open(url));
    return () => subscription.remove();
  }, []);

  useEffect(() => () => cancel.current?.(), []);

  const connect = (offer: Offer) => {
    cancel.current = pair(offer, name, (step) => {
      setStage(step);
      if (step.kind === "paired") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    });
  };

  const scan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setError("MonoCode needs the camera to scan pairing codes. You can paste the link instead.");
        return;
      }
    }
    scanned.current = false;
    setStage({ kind: "scan" });
  };

  if (stage.kind === "scan") {
    return (
      <View style={{ flex: 1, backgroundColor: "black" }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            if (scanned.current) return;
            scanned.current = true;
            accept(data);
          }}
        />
        <View pointerEvents="none" style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 240, height: 240, borderRadius: RADII.lg, borderWidth: 2, borderColor: "rgba(235,235,235,0.7)" }} />
        </View>
        <View style={{ position: "absolute", left: 16, right: 16, bottom: 48, gap: 8 }}>
          {error ? <Text style={{ color: "#fca5a5", textAlign: "center" }}>{error}</Text> : null}
          <Button label="Cancel" variant="secondary" onPress={() => setStage({ kind: "intro" })} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.base }} contentContainerStyle={{ padding: 20, gap: 16 }} keyboardShouldPersistTaps="handled">
      {stage.kind === "intro" ? (
        <>
          <Text style={{ color: t.content, fontSize: 20, fontWeight: "500" }}>Pair with a computer</Text>
          <Body>On your Mac, run this in a terminal while the host is running:</Body>
          <Card>
            <Text selectable style={{ color: t.contentAlpha(0.9), fontFamily: "Menlo", fontSize: 13 }}>
              monocode-host pair --mobile
            </Text>
          </Card>
          <Button label="Scan code" onPress={() => void scan()} />
          <Button
            label="Paste link"
            variant="secondary"
            onPress={async () => accept(await Clipboard.getStringAsync())}
          />
          {error ? <Text style={{ color: t.status.danger }}>{error}</Text> : null}
        </>
      ) : null}

      {stage.kind === "review" ? (
        <>
          <Text style={{ color: t.content, fontSize: 20, fontWeight: "500" }}>Connect to {stage.offer.name}?</Text>
          <Card>
            <Row label="Fingerprint" value={hostFingerprint(fromBase64Url(stage.offer.key))} mono />
            <Row label="Reachable through" value={reachable(stage.offer)} />
            <View style={{ gap: 6 }}>
              <Text style={{ color: t.text.secondary, fontSize: 14 }}>Phone name</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                style={{
                  color: t.content,
                  fontSize: 16,
                  borderWidth: 1,
                  borderColor: t.border.default,
                  borderRadius: RADII.md,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              />
            </View>
          </Card>
          <Body faint>
            This phone will be able to run agents and read files on {stage.offer.name} with the same access as its user account.
          </Body>
          <Button label="Connect" onPress={() => connect(stage.offer)} />
        </>
      ) : null}

      {stage.kind === "connecting" ? (
        <View style={{ gap: 12, paddingTop: 40, alignItems: "center" }}>
          <Button label="Connecting…" variant="ghost" busy />
          <Button label="Cancel" variant="secondary" onPress={() => { cancel.current?.(); setStage({ kind: "intro" }); }} />
        </View>
      ) : null}

      {stage.kind === "confirm" ? (
        <View style={{ gap: 16, paddingTop: 32, alignItems: "center" }}>
          <Text style={{ color: t.content, fontFamily: "Menlo", fontSize: 34, letterSpacing: 2.7 }}>{formatCode(stage.code)}</Text>
          <Body style={{ textAlign: "center" }}>Check that your computer shows the same code, then allow the connection there.</Body>
          <Button label="Cancel" variant="secondary" onPress={() => { cancel.current?.(); setStage({ kind: "intro" }); }} />
        </View>
      ) : null}

      {stage.kind === "paired" ? (
        <View style={{ gap: 16, paddingTop: 32 }}>
          <Text style={{ color: t.status.done, fontSize: 40, textAlign: "center" }}>✓</Text>
          <Text style={{ color: t.content, fontSize: 20, textAlign: "center", fontWeight: "500" }}>{stage.record.label} is ready.</Text>
          <Button label="Continue" onPress={() => router.dismissTo("/")} />
        </View>
      ) : null}

      {stage.kind === "failed" ? (
        <View style={{ gap: 16, paddingTop: 32 }}>
          <Text style={{ color: t.status.danger, fontSize: 16, textAlign: "center" }}>{stage.message}</Text>
          <Button label="Try again" onPress={() => setStage({ kind: "intro" })} />
        </View>
      ) : null}
    </ScrollView>
  );
}
