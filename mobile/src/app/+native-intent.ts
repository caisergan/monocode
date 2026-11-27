import { isPairingLink, offerPairingLink } from "@/features/connection/pairingLink";

/**
 * A pairing link, `monocode://pair?i=…`, is no screen: it goes to the
 * connection to pair with, and the app opens at home or stays where it was.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (!isPairingLink(path)) return path;
  offerPairingLink(path);
  return initial ? "/" : null;
}
