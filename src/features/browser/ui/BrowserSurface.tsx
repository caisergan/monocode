import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState, type FormEvent } from "react";
import { openPathWithDefaultApp } from "../../../platform/tauri/fs";
import { browserPreviewPath } from "../../../platform/tauri/browserPreview";
import { ExternalLink, RefreshCw } from "../../../shared/ui/icons";
import { normalizeBrowserUrl } from "../model/browserUrl";
import { BrowserFrame } from "./BrowserFrame";
import { PreviewRootError, usePreviewRoot } from "./HtmlFilePreview";

type Props = {
  url: string;
  cwd: string;
  onNavigate: (url: string) => void;
};

/**
 * A browser tab. The page is cross-origin to the app, which can't see its
 * location or history: the address bar shows what was last entered, and
 * links followed inside the page don't update it. There is no back/forward
 * for the same reason.
 */
export function BrowserSurface({ url, cwd, onNavigate }: Props) {
  const [draft, setDraft] = useState(url);
  const [invalid, setInvalid] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const filePath = browserPreviewPath(url);
  const root = usePreviewRoot(filePath, cwd);

  useEffect(() => {
    setDraft(url);
    setInvalid(false);
  }, [url]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = normalizeBrowserUrl(draft);
    if (!next) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next === url) setReloadKey((key) => key + 1);
    else onNavigate(next);
  };

  const openExternally = () => {
    if (filePath) void openPathWithDefaultApp(filePath).catch(() => undefined);
    else void openUrl(url).catch(() => undefined);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <form
        onSubmit={submit}
        className="flex h-10 shrink-0 items-center gap-1.5 border-b border-stroke px-2"
      >
        <button
          type="button"
          title="Reload"
          aria-label="Reload"
          onClick={() => setReloadKey((key) => key + 1)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/55 hover:bg-content/10 hover:text-content"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
        <div
          className={`flex h-[26px] min-w-0 flex-1 items-center rounded-md border bg-content/[0.06] px-2 ${
            invalid ? "border-red-400/55" : "border-content/10"
          }`}
        >
          <input
            type="text"
            value={draft}
            aria-label="Address"
            aria-invalid={invalid}
            placeholder="localhost:5173"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setInvalid(false);
            }}
            onFocus={(event) => event.currentTarget.select()}
            autoFocus={!url}
            className="h-6 min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[12px] text-content outline-none"
          />
        </div>
        <button
          type="button"
          title="Open in Default Browser"
          aria-label="Open in Default Browser"
          disabled={!url}
          onClick={openExternally}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/55 hover:bg-content/10 hover:text-content disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
        </button>
      </form>
      <div className="relative min-h-0 flex-1">
        {!url ? (
          <p className="grid h-full place-items-center p-6 text-center text-[12px] text-content/45">
            Enter the address of a dev server or site. Sites that refuse to be
            embedded stay blank; open those in your browser.
          </p>
        ) : root.status === "error" ? (
          <PreviewRootError message={root.message} />
        ) : root.status === "ready" ? (
          <BrowserFrame key={`${url}:${reloadKey}`} src={url} title={url} />
        ) : null}
      </div>
    </div>
  );
}
