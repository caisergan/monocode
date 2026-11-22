import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

type NativeLink = {
  execute(input: string): Promise<string>;
  hideScrollEdgeEffects?(testID: string): Promise<boolean>;
  nativeTranscriptVersion?: number;
  typingPostureVersion?: number;
};
const module = requireOptionalNativeModule<NativeLink>("MonocodeLink");
// Older development builds and Android retain the existing transcript.
export const hasNativeTranscript =
  Platform.OS === "ios" && module?.nativeTranscriptVersion === 1;

export const hasTypingPosture =
  Platform.OS === "ios" && module?.typingPostureVersion === 1;

export type Identity = { certificate: string; privateKey: string };
export type Address = { host: string; port: number };
export type Desktop = {
  name: string;
  /** A desktop's certificate fingerprint; for a machine, its host's ID. Keys
   *  everything the phone keeps for the connection. */
  fingerprint: string;
  addresses: Address[];
  deviceId: string;
  /** Set for a MonoCode host on another machine, reached through Tailscale
   *  rather than a desktop's direct link. */
  machine?: { url: string; environmentId: string };
};
/** Either a desktop, which pins its certificate and checks this phone's, or a
 *  machine's host, which takes this phone's credential. */
export type Pairing = {
  desktop: Desktop;
  identity?: Identity;
  /** A machine's credential, from the phone's secure storage. */
  token?: string;
};

/** Where a native call goes, as the link expects it. */
export function linkFor(pairing: Pairing): object {
  const machine = pairing.desktop.machine;
  if (machine) return { host: { url: machine.url, token: pairing.token ?? "" } };
  return {
    identity: pairing.identity,
    pin: pairing.desktop.fingerprint,
    addresses: pairing.desktop.addresses,
  };
}

/** Whether the phone is paired with a machine's host, not a desktop. */
export function isMachine(pairing: Pairing | null | undefined): boolean {
  return !!pairing?.desktop.machine;
}

export async function nativeCall<T>(input: object): Promise<T> {
  if (!module)
    throw new Error("Rebuild the mobile app to enable desktop connections.");
  const response = JSON.parse(await module.execute(JSON.stringify(input)));
  if (!response.ok)
    throw new Error(response.error ?? "Desktop connection failed");
  return response.result as T;
}
export function request<T>(
  pairing: Pairing,
  method: string,
  params: object = {},
  id = makeCommandId(),
): Promise<T> {
  return nativeCall({
    operation: "exchange",
    ...linkFor(pairing),
    request: { version: 1, id, method, params },
  });
}
/**
 * Opens a watch: the desktop keeps the request's stream open and writes each
 * change to it. Pull them with `nextUpdates`; `closeWatch` stops it.
 */
export async function openWatch(
  pairing: Pairing,
  method: string,
  params: object,
): Promise<number> {
  const { watchId } = await nativeCall<{ watchId: number }>({
    operation: "watch",
    ...linkFor(pairing),
    request: { version: 1, id: makeCommandId(), method, params },
  });
  return watchId;
}
/** The updates that arrived, waiting up to `timeoutMs` for the first; throws once the watch ended. */
export async function nextUpdates<T>(
  watchId: number,
  timeoutMs: number,
): Promise<T[]> {
  const { updates } = await nativeCall<{ updates: T[] }>({
    operation: "next",
    watchId,
    timeoutMs,
  });
  return updates;
}
export function closeWatch(watchId: number) {
  return nativeCall({ operation: "unwatch", watchId }).catch(() => {});
}
export function makeCommandId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
export { parseInvitation } from "./invitation";

/**
 * Turns off iOS's scroll edge effects on the scroll view tagged `testID`, so
 * only the screen's own gradual blur shows under its header (see
 * ScrollEdgeEffects). Call once the scroll view is laid out.
 */
export function hideScrollEdgeEffects(testID: string) {
  void module?.hideScrollEdgeEffects?.(testID);
}
