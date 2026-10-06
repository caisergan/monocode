import { invoke } from "@tauri-apps/api/core";
import { IS_WIN } from "./platform";

const SCHEME = "monocode-preview";

/**
 * URL for a local file served by the `monocode-preview` protocol.
 *
 * The path stays as real segments rather than one encoded blob, so the
 * page's relative links resolve next to it the way they would from `file://`.
 * Windows webviews reach custom schemes as `http://<scheme>.localhost`.
 */
export function browserPreviewUrl(path: string, windows = IS_WIN): string {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    // Keep a drive letter's colon readable: `C:` must survive as a segment.
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"));
  const origin = windows
    ? `http://${SCHEME}.localhost`
    : `${SCHEME}://localhost`;
  return `${origin}/${segments.join("/")}`;
}

/** Whether a URL points at a file served by the preview protocol. */
export function isBrowserPreviewUrl(url: string): boolean {
  return (
    url.startsWith(`${SCHEME}://`) ||
    url.startsWith(`http://${SCHEME}.localhost/`) ||
    url.startsWith(`https://${SCHEME}.localhost/`)
  );
}

/** Let the preview protocol serve files under this project directory. */
export function allowBrowserPreviewRoot(root: string): Promise<void> {
  return invoke<void>("browser_preview_allow_root", { root });
}

/** The local file behind a preview URL, or null for any other URL. */
export function browserPreviewPath(url: string): string | null {
  if (!isBrowserPreviewUrl(url)) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  // `/C:/site/index.html` → `C:/site/index.html`
  return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
}
