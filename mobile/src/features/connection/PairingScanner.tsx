import { CameraView, useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { Alert, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { themedStyles, useColors } from "@/ui/theme";
import { PairingLinkSheet } from "./PairingLinkSheet";

/**
 * The two ways to pair: scanning the code a desktop shows in Settings →
 * Connections, for itself or one of its machines, or pasting its link.
 * `scan` opens the camera, asking for it first; `paste` the link sheet.
 */
export function usePairingScanner(onLink: (link: string) => void) {
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const scan = async () => {
    const result = permission?.granted ? permission : await requestPermission();
    if (result.granted) {
      setCameraError("");
      setScanning(true);
    } else
      setCameraError(
        "Allow camera access in your phone’s settings, or paste a pairing link.",
      );
  };
  const elements = (
    <>
      <PairingLinkSheet
        isPresented={pasting}
        onDismiss={() => setPasting(false)}
        onConnect={(link) => {
          setPasting(false);
          onLink(link);
        }}
      />
      <Modal
        visible={scanning}
        animationType="slide"
        onRequestClose={() => setScanning(false)}
      >
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          {scanning ? (
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                setScanning(false);
                onLink(data);
              }}
            />
          ) : null}
          <View style={{ padding: 24, paddingBottom: insets.bottom + 24 }}>
            <Text style={styles.hint}>
              Scan the code in desktop Settings → Connections
            </Text>
            <Pressable onPress={() => setScanning(false)}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
  return {
    scan,
    paste: () => setPasting(true),
    /** Asks which way, as Settings pairs another desktop or machine. */
    ask: () =>
      Alert.alert("Pair a desktop or machine", "Use the code from desktop Settings → Connections.", [
        { text: "Scan code", onPress: () => void scan() },
        { text: "Paste link", onPress: () => setPasting(true) },
        { text: "Cancel", style: "cancel" },
      ]),
    cameraError,
    elements,
  };
}

// As the connection screens' subtitle and secondary action.
const useStyles = themedStyles((colors) => ({
  hint: { color: colors.muted, fontSize: 16, lineHeight: 24, textAlign: "center" },
  cancel: { color: colors.accent, textAlign: "center", padding: 14, fontSize: 16 },
}));
