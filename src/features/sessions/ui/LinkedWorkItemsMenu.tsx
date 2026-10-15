import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { MOD } from "../../../platform/tauri/platform";
import {
  CircleDot,
  ExternalLink,
  GitPullRequest,
  Plus,
} from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import {
  githubWorkItem,
  peekGithubWorkItem,
  type GithubWorkItem,
} from "../../inbox/model/githubTasks";
import { inboxStatusMark } from "../../inbox/ui/inboxStatusMark";
import type { LinkedWorkItem } from "../model/session";

const MENU_WIDTH = 320;

function openOnGithub(item: LinkedWorkItem) {
  void openUrl(item.url).catch(() => undefined);
}

function kindLabel(item: LinkedWorkItem): string {
  return item.kind === "pr" ? "PR" : "issue";
}

/** "Linked PRs", "Linked issues", or "GitHub links" when a session has both. */
function linksLabel(items: readonly LinkedWorkItem[]): string {
  if (items.every((item) => item.kind === "pr")) return "Linked PRs";
  if (items.every((item) => item.kind === "issue")) return "Linked issues";
  return "GitHub links";
}

function KindIcon({
  item,
  className,
}: {
  item: LinkedWorkItem;
  className: string;
}) {
  return item.kind === "pr" ? (
    <GitPullRequest className={className} strokeWidth={1.75} />
  ) : (
    <CircleDot className={className} strokeWidth={1.75} />
  );
}

/** The link's state as the Inbox shows it, or its kind until that loads. */
export function LinkedWorkItemMark({
  item,
  known,
}: {
  item: LinkedWorkItem;
  known?: GithubWorkItem;
}) {
  const status = known ? inboxStatusMark({ ...known, provider: "github" }) : null;
  return status ? (
    <status.Icon
      className={`size-3.5 shrink-0 ${status.className}`}
      strokeWidth={1.75}
    />
  ) : (
    <KindIcon item={item} className="size-3.5 shrink-0 text-content/45" />
  );
}

/**
 * The session card's link badge. One link opens beside the session; with
 * more, the badge shows the newest and a count, and opens a menu of them all.
 */
export function LinkedWorkItemsBadge({
  items,
  menuOpen,
  onOpen,
  onToggleMenu,
}: {
  /** Every link, newest first. */
  items: readonly LinkedWorkItem[];
  menuOpen: boolean;
  /** Opens a link beside the session; without it links open on GitHub. */
  onOpen?: (item: LinkedWorkItem) => void;
  onToggleMenu?: (anchor: HTMLElement) => void;
}) {
  const [first] = items;
  if (!first) return null;
  const more = items.length - 1;
  const ref = `${kindLabel(first)} #${first.number}`;

  if (more === 0 || !onToggleMenu) {
    return (
      <button
        type="button"
        data-no-drag
        data-tauri-drag-region="false"
        title={`Open ${ref} beside this session (${MOD}-click for GitHub)`}
        aria-label={`Open ${ref}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.metaKey || event.ctrlKey || !onOpen) openOnGithub(first);
          else onOpen(first);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          event.stopPropagation();
          openOnGithub(first);
        }}
        className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-0.5 text-[11px] tabular-nums text-accent hover:underline"
      >
        <KindIcon item={first} className="size-3" />
        <span>#{first.number}</span>
      </button>
    );
  }

  const label = `Show ${items.length} ${linksLabel(items).toLowerCase().replace("github", "GitHub")}`;
  return (
    <button
      type="button"
      data-no-drag
      data-tauri-drag-region="false"
      title={`${label} (${MOD}-click opens ${ref} on GitHub)`}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey) openOnGithub(first);
        else onToggleMenu(event.currentTarget);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        openOnGithub(first);
      }}
      onKeyDown={(event) => {
        if (menuOpen || event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        onToggleMenu(event.currentTarget);
      }}
      className="-mr-0.5 flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-[11px] tabular-nums text-accent hover:bg-accent/10 aria-expanded:bg-accent/10"
    >
      <span className="flex items-center gap-0.5">
        <KindIcon item={first} className="size-3" />
        <span>#{first.number}</span>
      </span>
      <span className="rounded-[4px] bg-accent/15 px-1 text-[10px] font-medium leading-[14px]">
        +{more}
      </span>
    </button>
  );
}

/** Title and state for each link: cached ones at once, the rest on open. */
export function useWorkItemDetails(
  items: readonly LinkedWorkItem[],
  cwd: string,
): ReadonlyMap<string, GithubWorkItem> {
  const [details, setDetails] = useState<ReadonlyMap<string, GithubWorkItem>>(
    () => {
      const cached = new Map<string, GithubWorkItem>();
      for (const item of items) {
        const known = peekGithubWorkItem(item.repo, item.kind, item.number);
        if (known) cached.set(item.url, known);
      }
      return cached;
    },
  );

  // The caller rebuilds the list on every render; refetch only when it changes.
  const itemsKey = items.map((item) => item.url).join(" ");
  useEffect(() => {
    let cancelled = false;
    for (const item of items) {
      if (peekGithubWorkItem(item.repo, item.kind, item.number)) continue;
      githubWorkItem(cwd, item.repo, item.kind, item.number).then(
        (known) => {
          if (cancelled) return;
          setDetails((current) => new Map(current).set(item.url, known));
        },
        // Without gh or access, the row keeps showing the repo name.
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, cwd]);

  return details;
}

/** Every link on a session, opened from its card's badge. */
export function LinkedWorkItemsMenu({
  anchor,
  items,
  cwd,
  onOpen,
  onEdit,
  onClose,
}: {
  anchor: HTMLElement;
  /** Every link, newest first. */
  items: readonly LinkedWorkItem[];
  cwd: string;
  /** Opens a link beside the session; without it links open on GitHub. */
  onOpen?: (item: LinkedWorkItem) => void;
  /** Opens the dialog that adds and removes links. */
  onEdit?: () => void;
  /** `restoreFocus` is set when the menu closes from the keyboard. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const details = useWorkItemDetails(items, cwd);
  const [active, setActive] = useState(0);
  const count = items.length + (onEdit ? 1 : 0);
  const surface = useRef<HTMLDivElement>(null);

  // Popover focuses its surface while it is still hidden for measuring, so
  // focus again once it is placed; the arrow keys need it.
  useEffect(() => {
    const frame = requestAnimationFrame(() => surface.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const choose = (item: LinkedWorkItem, onGithub: boolean) => {
    onClose(false);
    if (onGithub || !onOpen) openOnGithub(item);
    else onOpen(item);
  };

  const edit = () => {
    onClose(false);
    onEdit?.();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      Home: -count,
      End: count,
    };
    if (event.key in step) {
      event.preventDefault();
      setActive((index) =>
        Math.min(count - 1, Math.max(0, index + step[event.key])),
      );
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const item = items[active];
    if (item) choose(item, event.metaKey || event.ctrlKey);
    else if (onEdit) edit();
  };

  const onAuxClick = (event: ReactMouseEvent, item: LinkedWorkItem) => {
    if (event.button !== 1) return;
    event.preventDefault();
    choose(item, true);
  };

  return (
    <Popover
      ref={surface}
      anchor={anchor}
      side="bottom"
      align="end"
      gap={4}
      width={MENU_WIDTH}
      maxHeight={360}
      autoFocus
      tabIndex={-1}
      onDismiss={(reason) => onClose(reason === "escape")}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
      aria-label={linksLabel(items)}
      className="overflow-y-auto overscroll-none p-1 outline-none"
    >
      <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-content/40">
        {linksLabel(items)}
      </div>
      {items.map((item, index) => {
        const known = details.get(item.url);
        const status = known
          ? inboxStatusMark({ ...known, provider: "github" })
          : null;
        const highlighted = index === active;
        const ref = `${kindLabel(item)} #${item.number}`;
        return (
          <div
            key={item.url}
            role="none"
            className="relative"
            onMouseEnter={() => setActive(index)}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              title={`${item.repo}#${item.number}${known ? `\n${known.title}` : ""}\nOpen beside this session (${MOD}-click for GitHub)`}
              aria-label={`${status ? `${status.label} ` : ""}${ref}${known ? `: ${known.title}` : ` in ${item.repo}`}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => choose(item, event.metaKey || event.ctrlKey)}
              onAuxClick={(event) => onAuxClick(event, item)}
              className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-lg pl-2 pr-8 text-left text-[13px] leading-none text-content ${
                highlighted ? "bg-selection" : ""
              }`}
            >
              <LinkedWorkItemMark item={item} known={known} />
              <span className="shrink-0 text-[12px] tabular-nums text-content/55">
                #{item.number}
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${known ? "" : "text-content/45"}`}
              >
                {known?.title || item.repo}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              title="Open on GitHub"
              aria-label={`Open ${ref} on GitHub`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item, true)}
              className={`absolute right-1 top-1 grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content ${
                highlighted ? "opacity-100" : "opacity-0"
              }`}
            >
              <ExternalLink className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
      {onEdit ? (
        <>
          <div role="separator" className="my-1 h-px bg-content/10" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(items.length)}
            onClick={edit}
            className={`flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-none ${
              active === items.length
                ? "bg-selection text-content"
                : "text-content/70"
            }`}
          >
            <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">
              Link another issue or PR…
            </span>
          </button>
        </>
      ) : null}
    </Popover>
  );
}
