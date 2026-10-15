import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "../../../shared/ui/icons";
import { Modal } from "../../../shared/ui/Modal";
import { sameLinkedWorkItem, type LinkedWorkItem } from "../model/session";
import { parseGithubWorkItemUrl } from "../model/sessionWorkItem";
import { LinkedWorkItemMark, useWorkItemDetails } from "./LinkedWorkItemsMenu";

export function LinkSessionWorkItemDialog({
  initial,
  cwd,
  sessionTitle,
  onSave,
  onClose,
}: {
  /** The session's links, newest first. */
  initial: readonly LinkedWorkItem[];
  cwd: string;
  sessionTitle: string;
  /** Every link to keep, newest first. An empty list removes them all. */
  onSave: (items: LinkedWorkItem[]) => void;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<LinkedWorkItem[]>(() => [...initial]);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const details = useWorkItemDetails(initial, cwd);
  const editing = initial.length > 0;
  const input = useRef<HTMLInputElement>(null);

  // Modal focuses its close button after this mounts; the URL field is the
  // reason the dialog is open.
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = url.trim();
    if (!text) {
      if (!editing) {
        setError("Enter a valid GitHub issue or pull request URL.");
      } else if (links.length === initial.length) {
        onClose();
      } else {
        onSave(links);
      }
      return;
    }
    const item = parseGithubWorkItemUrl(text);
    if (!item) {
      setError("Enter a valid GitHub issue or pull request URL.");
      return;
    }
    if (links.some((linked) => sameLinkedWorkItem(linked, item))) {
      setError("This conversation is already linked to it.");
      return;
    }
    onSave([item, ...links]);
  };

  return (
    <Modal
      title={editing ? "GitHub links" : "Link GitHub issue or PR"}
      description={sessionTitle}
      size="sm"
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-4 text-[12px]">
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-content/80">Linked</span>
            {links.length > 0 ? (
              <ul className="flex flex-col rounded-md border border-content/10">
                {links.map((item) => {
                  const known = details.get(item.url);
                  return (
                    <li
                      key={item.url}
                      title={`${item.repo}#${item.number}`}
                      className="flex h-8 min-w-0 items-center gap-2 border-t border-content/10 pl-2.5 pr-1 first:border-t-0"
                    >
                      <LinkedWorkItemMark item={item} known={known} />
                      <span className="shrink-0 text-[12px] tabular-nums text-content/55">
                        #{item.number}
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate text-[13px] ${known ? "text-content" : "text-content/45"}`}
                      >
                        {known?.title || item.repo}
                      </span>
                      <button
                        type="button"
                        title="Remove link"
                        aria-label={`Remove ${item.kind === "pr" ? "PR" : "issue"} #${item.number}`}
                        onClick={() =>
                          setLinks((current) =>
                            current.filter((linked) => linked !== item),
                          )
                        }
                        className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content active:scale-[0.97]"
                      >
                        <X className="size-3.5" strokeWidth={1.75} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="text-[11px] text-content/45">
                Every link will be removed when you save.
              </span>
            )}
          </div>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-content/80">
            {editing ? "Add an issue or pull request" : "Issue or pull request URL"}
          </span>
          <input
            ref={input}
            autoFocus
            type="url"
            value={url}
            aria-label="GitHub issue or pull request URL"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "linked-work-item-error" : undefined}
            placeholder="https://github.com/owner/repo/pull/123"
            onChange={(event) => {
              setUrl(event.target.value);
              if (error) setError("");
            }}
            className={`h-9 rounded-md border bg-content/5 px-2.5 text-[13px] text-content outline-none placeholder:text-content/30 focus:border-content/30 ${
              error ? "border-red-400/60" : "border-content/10"
            }`}
          />
          {error ? (
            <span
              id="linked-work-item-error"
              role="alert"
              className="text-[11px] text-red-400"
            >
              {error}
            </span>
          ) : (
            <span className="text-[11px] text-content/45">
              Paste the full github.com URL. The newest link shows on the
              session card.
            </span>
          )}
        </label>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 hover:bg-content/8 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:brightness-110 active:scale-[0.97]"
          >
            {editing ? "Save" : "Link"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
