import { isBrowserPreviewUrl } from "../../../platform/tauri/browserPreview";
import { basename } from "../../../platform/tauri/fs";

/**
 * Turn what was typed in the address bar into a URL the frame may load, or
 * null. Bare hosts get a scheme the way a browser would guess one: local
 * addresses are dev servers on plain http, anything else is https.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (isBrowserPreviewUrl(text)) return text;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  const candidate = scheme
    ? text
    : `${isLocalHost(text) ? "http" : "https"}://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!scheme && !isLocalHost(text) && !url.hostname.includes(".")) return null;
  return url.href;
}

function isLocalHost(text: string): boolean {
  return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(
    text,
  );
}

/**
 * Sandbox flags for a frame showing `url`.
 *
 * A real site keeps its own origin, so its storage and cookies work: that
 * origin is never the app's, and Tauri only hands the IPC key to the main
 * frame. Two cases stay opaque instead. Preview-protocol pages, because the
 * app counts its own custom schemes as local. And a page on the app's own
 * origin (the dev server), which could otherwise lift its own sandbox.
 */
export function browserFrameSandbox(url: string, appOrigin: string): string {
  const base = "allow-scripts allow-forms allow-modals";
  if (isBrowserPreviewUrl(url)) return base;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return base;
  }
  if (origin === "null" || origin === appOrigin) return base;
  return `${base} allow-same-origin`;
}

/** Tab label: the file for a previewed page, the host for a site. */
export function browserTabLabel(url: string): string {
  if (isBrowserPreviewUrl(url)) {
    try {
      return decodeURIComponent(basename(new URL(url).pathname)) || url;
    } catch {
      return url;
    }
  }
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
