import { invoke } from "@tauri-apps/api/core";
import { REMOTE_PATH_PREFIX } from "../../shared/lib/remotePaths";
import { IS_WIN } from "./platform";

const SCHEME = "monocode-preview";
/** Files of a project on a connected machine, read through its host. */
const REMOTE_SCHEME = "monocode-remote";

/**
 * URL for a file served to the in-app browser: `monocode-preview` for a local
 * file, `monocode-remote` for a `remote://` file on a connected machine.
 *
 * The path stays as real segments rather than one encoded blob, so the
 * page's relative links resolve next to it the way they would from `file://`.
 * Windows webviews reach custom schemes as `http://<scheme>.localhost`.
 */
export function browserPreviewUrl(path: string, windows = IS_WIN): string {
  const remote = path.startsWith(REMOTE_PATH_PREFIX);
  // `remote://<environment>/<host path>` keeps the environment as the first segment.
  const local = remote ? path.slice(REMOTE_PATH_PREFIX.length) : path;
  const segments = local
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    // Keep a drive letter's colon readable: `C:` must survive as a segment.
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"));
  const scheme = remote ? REMOTE_SCHEME : SCHEME;
  const origin = windows
    ? `http://${scheme}.localhost`
    : `${scheme}://localhost`;
  return `${origin}/${segments.join("/")}`;
}

function isSchemeUrl(url: string, scheme: string): boolean {
  return (
    url.startsWith(`${scheme}://`) ||
    url.startsWith(`http://${scheme}.localhost/`) ||
    url.startsWith(`https://${scheme}.localhost/`)
  );
}

/** Whether a URL points at a file served by either preview protocol. */
export function isBrowserPreviewUrl(url: string): boolean {
  return isSchemeUrl(url, SCHEME) || isSchemeUrl(url, REMOTE_SCHEME);
}

/** Let the preview protocol serve files under this project directory. */
export function allowBrowserPreviewRoot(root: string): Promise<void> {
  return invoke<void>("browser_preview_allow_root", { root });
}

/** The file behind a preview URL (`remote://` for a remote one), or null for any other URL. */
export function browserPreviewPath(url: string): string | null {
  if (!isBrowserPreviewUrl(url)) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (isSchemeUrl(url, REMOTE_SCHEME))
    return `${REMOTE_PATH_PREFIX}${pathname.replace(/^\/+/, "")}`;
  // `/C:/site/index.html` → `C:/site/index.html`
  return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
}
