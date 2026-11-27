/**
 * A pairing link opened from outside the app, tapped in a message or scanned
 * with the Camera app, kept until the connection takes it. The router hands
 * it over (see `app/+native-intent.ts`) before the app may be ready for it.
 */
let pending: string | null = null;
const listeners = new Set<() => void>();

/** Whether `path`, a URL the system opened the app with, is a pairing link. */
export function isPairingLink(path: string): boolean {
  return /^monocode:\/\/pair(?:[/?#]|$)/i.test(path.trim());
}

export function offerPairingLink(link: string) {
  pending = link;
  for (const listener of listeners) listener();
}

/** The link waiting to be paired with, if any. */
export function pendingPairingLink(): string | null {
  return pending;
}

/** Takes `link` off the waiting list, unless a newer one replaced it. */
export function takePairingLink(link: string) {
  if (pending !== link) return;
  pending = null;
  for (const listener of listeners) listener();
}

export function subscribePairingLink(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
