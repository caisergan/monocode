import { router } from "expo-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { useConnection } from "./ConnectionProvider";
import {
  pendingPairingLink,
  subscribePairingLink,
  takePairingLink,
} from "./pairingLink";

/**
 * Pairs with a link opened from outside the app, as scanning its code in the
 * app does. Before the first pairing the connect screen shows how it goes;
 * paired already, the app starts over in the new one, as pairing from
 * Settings does, and says so if it fails.
 */
export function PairingLinks() {
  const { restoring, pairing, pair, working, error } = useConnection();
  const link = useSyncExternalStore(subscribePairingLink, pendingPairingLink);
  // Set before pairing starts, so its error can't come in unnoticed.
  const reportError = useRef(false);
  useEffect(() => {
    if (!link || restoring) return;
    takePairingLink(link);
    const wasPaired = !!pairing;
    reportError.current = wasPaired;
    void pair(link).then((paired) => {
      if (!paired) return;
      reportError.current = false;
      if (wasPaired) router.replace("/");
    });
  }, [link, restoring, pairing, pair]);
  useEffect(() => {
    if (!reportError.current || working || !error) return;
    reportError.current = false;
    Alert.alert("Could not pair", error);
  }, [working, error]);
  return null;
}
