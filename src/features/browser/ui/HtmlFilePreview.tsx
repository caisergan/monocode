import { useEffect, useState } from "react";
import {
  allowBrowserPreviewRoot,
  browserPreviewUrl,
} from "../../../platform/tauri/browserPreview";
import { isEqualOrInside, parentPath } from "../../../shared/lib/paths";
import { BrowserFrame } from "./BrowserFrame";

type Props = {
  path: string;
  cwd: string;
  /** Changes whenever the file on disk does, to reload the page. */
  version: number;
};

/**
 * Renders a local HTML file the way a browser would open it from disk:
 * relative assets load from beside it, inside the project it belongs to.
 * The page shows the saved file, so edits appear once autosave writes them.
 */
export function HtmlFilePreview({ path, cwd, version }: Props) {
  const root = usePreviewRoot(path, cwd);
  if (root.status === "pending") return null;
  if (root.status === "error")
    return <PreviewRootError message={root.message} />;
  return (
    <div className="h-full pt-10">
      <BrowserFrame
        key={version}
        src={browserPreviewUrl(path)}
        title={`Preview of ${path}`}
      />
    </div>
  );
}

type PreviewRootState =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "error"; message: string };

/**
 * Register the directory the preview protocol may serve `path` from. Pass
 * null for pages that aren't local files; they need nothing registered.
 */
export function usePreviewRoot(
  path: string | null,
  cwd: string,
): PreviewRootState {
  const root = path === null ? null : previewRoot(path, cwd);
  const [state, setState] = useState<{
    root: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (root === null) return;
    let cancelled = false;
    allowBrowserPreviewRoot(root).then(
      () => {
        if (!cancelled) setState({ root });
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            root,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [root]);

  if (root === null) return { status: "ready" };
  if (state?.root !== root) return { status: "pending" };
  return state.error
    ? { status: "error", message: state.error }
    : { status: "ready" };
}

export function PreviewRootError({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-[12px] text-content/50">
      {message}
    </div>
  );
}

/** The project serves the page, as a dev server would; a stray file gets its folder. */
export function previewRoot(path: string, cwd: string): string {
  return cwd && cwd !== "~" && isEqualOrInside(path, cwd)
    ? cwd
    : parentPath(path);
}
