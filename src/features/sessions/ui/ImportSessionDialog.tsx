import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Modal } from "../../../shared/ui/Modal";
import { GitBranch, ListFilter, RefreshCw } from "../../../shared/ui/icons";
import { prettyCwd, projectKey, projectName } from "../../../shared/lib/paths";
import { formatRelative } from "../../../shared/lib/relativeTime";
import {
  listClaudeSessions,
  type ClaudeSessionListing,
  type ClaudeSessionSummary,
} from "../../../platform/tauri/claudeSessions";
import { sameProjectPath } from "../../projects/model/recents";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupMascot,
} from "../../workspace/model/tabGroups";
import { importClaudeSession } from "../model/claudeSessionImport";
import {
  DEFAULT_SESSION_SIDEBAR_FILTERS,
  hasActiveSessionFilters,
  timeFilterStart,
  type SessionSidebarFilters,
} from "../model/sessionFilters";
import { HarnessIcon } from "./HarnessIcon";
import { SessionFiltersMenu } from "./SessionFiltersMenu";
import { SessionsEmpty } from "./SessionsEmpty";
import { SessionsHeaderButton, SessionsSearchField } from "./SessionsSearchBar";
import { TerminalSpinner } from "./TerminalSpinner";

type Props = {
  /** Start on this project's sessions; the sheet can widen to every folder. */
  cwd?: string;
  /** Folders already in the project rail. */
  projects: readonly string[];
  onClose: () => void;
  /** Called with the MonoCode session to open, imported or already there. */
  onOpen: (sessionId: string, cwd: string) => void;
};

/** Rows fetched per page as the list scrolls. */
const PAGE_LIMITS = [15, 45, 90, 200];
const SEARCH_DEBOUNCE_MS = 200;
/** A transcript this fresh may still be open in the terminal. */
const RECENT_MS = 2 * 60 * 1000;

type FolderIdentity = {
  label: string;
  mascot?: { seed: string; color: string; name: string | null | undefined };
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lists Claude Code sessions started in the terminal and imports the chosen
 * one as a MonoCode session that resumes the same conversation. Reads like
 * the sessions list: same search box, filter menu, row and empty states.
 */
export function ImportSessionDialog({
  cwd: initialCwd,
  projects,
  onClose,
  onOpen,
}: Props) {
  const [scope, setScope] = useState(initialCwd);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<SessionSidebarFilters>(
    DEFAULT_SESSION_SIDEBAR_FILTERS,
  );
  const [filterMenu, setFilterMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [page, setPage] = useState(0);
  const [includeImported, setIncludeImported] = useState(false);
  const [reload, setReload] = useState(0);
  const [listing, setListing] = useState<ClaudeSessionListing | null>(null);
  const [fetching, setFetching] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [importError, setImportError] = useState("");
  const [hiddenCount, setHiddenCount] = useState(0);
  const sentinel = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  useEffect(() => {
    let active = true;
    setFetching(true);
    void listClaudeSessions({
      cwd: scope,
      query: search || undefined,
      limit: PAGE_LIMITS[page],
      includeImported,
    })
      .then((next) => {
        if (!active) return;
        if (!includeImported) setHiddenCount(next.importedCount);
        setListing(next);
        setLoadError(false);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setFetching(false);
      });
    return () => {
      active = false;
    };
  }, [scope, search, page, includeImported, reload]);

  const canLoadMore =
    !!listing?.hasMore && page < PAGE_LIMITS.length - 1 && !fetching;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canLoadMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setPage((current) => Math.min(current + 1, PAGE_LIMITS.length - 1));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canLoadMore]);

  const identity = useFolderIdentity(projects);
  const now = Date.now();
  const since = timeFilterStart(filters.time, now);
  const sessions = (listing?.sessions ?? []).filter(
    (session) => session.updatedAt >= since,
  );
  const filtersActive = hasActiveSessionFilters(filters);

  const pick = (session: ClaudeSessionSummary) => {
    if (importing || session.folder !== "ok") return;
    if (session.monocodeSessionId) {
      onOpen(session.monocodeSessionId, session.cwd);
      return;
    }
    if (now - session.updatedAt < RECENT_MS && confirming !== session.id) {
      setConfirming(session.id);
      return;
    }
    setImporting(session.id);
    setImportError("");
    void importClaudeSession(session.cwd, session.id)
      .then((result) => onOpen(result.sessionId, session.cwd))
      .catch((reason: unknown) => setImportError(errorText(reason)))
      .finally(() => {
        setImporting(null);
        setConfirming(null);
      });
  };

  const onFilterButtonClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (filterMenu) {
      setFilterMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setFilterMenu({ x: rect.right - 228, y: rect.bottom + 2 });
  };

  const refresh = () => {
    setPage(0);
    setReload((n) => n + 1);
  };

  const scopeLabel = scope ? identity(scope).label : "";

  return (
    <Modal
      title="Import session"
      description="Pick up a session you started in the terminal"
      onClose={onClose}
      className="h-[min(72vh,640px)]"
    >
      <div className="flex min-h-full flex-col">
        <div
          // While the box holds a query or the filter menu is open, Escape
          // belongs to them rather than closing the sheet.
          data-dialog-popover={query || filterMenu ? "" : undefined}
          className="sticky top-0 z-10 mt-2 flex h-9 shrink-0 items-center gap-1 border-y border-stroke bg-background-base/80 px-2 backdrop-blur"
        >
          <SessionsSearchField
            value={query}
            onChange={setQuery}
            autoFocus
            releaseEmptyEscape
          />
          <SessionsHeaderButton
            label="Filter sessions"
            active={filtersActive}
            open={!!filterMenu}
            hasPopup
            onClick={onFilterButtonClick}
          >
            <ListFilter className="size-3" strokeWidth={1.75} />
          </SessionsHeaderButton>
          <SessionsHeaderButton
            label="Refresh"
            disabled={fetching}
            onClick={refresh}
          >
            <RefreshCw
              className={`size-3 ${fetching && listing ? "motion-safe:animate-spin" : ""}`}
              strokeWidth={1.75}
            />
          </SessionsHeaderButton>
        </div>

        {scope ? (
          <p className="px-3 pt-2 text-[12px] text-content/50">
            In {scopeLabel} ·{" "}
            <button
              type="button"
              onClick={() => {
                setScope(undefined);
                setPage(0);
              }}
              className="text-content/70 hover:text-content"
            >
              Show all
            </button>
          </p>
        ) : null}

        {importError ? (
          <p role="alert" className="px-3 pt-2 text-[12px] text-red-400">
            {importError}
          </p>
        ) : null}

        {/*
          The first load stays blank, like the sessions list: it resolves in
          a moment and a placeholder would only flash.
        */}
        {!listing ? (
          loadError ? (
            <p className="px-3 py-2 text-[12px] text-content/50">
              Couldn’t load Claude Code sessions
            </p>
          ) : null
        ) : sessions.length === 0 ? (
          search ? (
            <p className="px-3 py-2 text-[12px] text-content/50">
              No matching sessions
            </p>
          ) : filtersActive ? (
            <p className="px-3 py-2 text-[12px] text-content/50">
              No sessions match these filters
            </p>
          ) : hiddenCount > 0 && !includeImported ? (
            <p className="px-3 py-2 text-[12px] text-content/50">
              Every recent session is already in MonoCode
            </p>
          ) : (
            <div className="flex-1">
              <SessionsEmpty message="Sessions you start in the terminal will show up here" />
            </div>
          )
        ) : (
          <ul className="flex flex-col gap-0.5 p-1.5" aria-label="Sessions">
            {sessions.map((session) => (
              <ImportSessionRow
                key={session.id}
                session={session}
                folder={scope ? null : identity(session.cwd)}
                now={now}
                importing={importing === session.id}
                confirming={confirming === session.id}
                disabled={importing != null}
                onPick={pick}
              />
            ))}
            {canLoadMore ? <li ref={sentinel} className="h-px" /> : null}
          </ul>
        )}

        {listing && (hiddenCount > 0 || includeImported) ? (
          <p className="mt-auto px-3 py-2 text-[12px] text-content/50">
            {includeImported
              ? "Showing sessions already in MonoCode · "
              : `${hiddenCount} already in MonoCode · `}
            <button
              type="button"
              onClick={() => {
                setIncludeImported((value) => !value);
                setPage(0);
              }}
              className="text-content/70 hover:text-content"
            >
              {includeImported ? "Hide" : "Show"}
            </button>
          </p>
        ) : null}
      </div>

      {filterMenu ? (
        <SessionFiltersMenu
          x={filterMenu.x}
          y={filterMenu.y}
          harnesses={[]}
          filters={filters}
          onChange={setFilters}
          onClose={() => setFilterMenu(null)}
          archivedOption={false}
          statusOptions={false}
        />
      ) : null}
    </Modal>
  );
}

/** One session, laid out like a row of the sessions list. */
function ImportSessionRow({
  session,
  folder,
  now,
  importing,
  confirming,
  disabled,
  onPick,
}: {
  session: ClaudeSessionSummary;
  /** Where the session ran; omitted when the sheet is scoped to one project. */
  folder: FolderIdentity | null;
  now: number;
  importing: boolean;
  confirming: boolean;
  disabled: boolean;
  onPick: (session: ClaudeSessionSummary) => void;
}) {
  const title = session.title || session.firstPrompt;
  const unavailable =
    session.folder === "home"
      ? "No project folder"
      : session.folder === "missing"
        ? "Folder was not found"
        : null;
  const tooltip = [title, session.lastPrompt !== title ? session.lastPrompt : ""]
    .filter(Boolean)
    .join("\n");
  const note = unavailable
    ? unavailable
    : confirming
      ? "May still be open in the terminal. Click again to import."
      : session.monocodeSessionId
        ? "Already in MonoCode"
        : null;

  return (
    <li>
      <button
        type="button"
        title={tooltip}
        disabled={disabled || !!unavailable}
        onClick={() => onPick(session)}
        className={`relative flex w-full cursor-default select-none flex-col rounded-md border border-transparent px-2.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${
          unavailable
            ? "text-content/30"
            : "text-content/80 hover:bg-content/5 hover:text-content disabled:hover:bg-transparent"
        }`}
      >
        <span className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <HarnessIcon harness="claude" className="size-3.5 shrink-0" />
            {folder ? (
              <>
                {folder.mascot ? (
                  <ProjectMascot
                    project={folder.mascot.seed}
                    color={folder.mascot.color}
                    name={folder.mascot.name}
                    className="size-2 shrink-0"
                  />
                ) : null}
                <span className="min-w-0 truncate text-[11px] text-content/50">
                  {folder.label}
                </span>
              </>
            ) : null}
          </span>
          <span
            className={`flex shrink-0 items-center gap-1 text-[11px] tabular-nums ${
              importing ? "text-accent" : "text-content/45"
            }`}
          >
            {importing ? (
              <>
                <TerminalSpinner className="inline-block w-3 select-none text-center text-[11px] leading-none text-accent" />
                <span>Importing...</span>
              </>
            ) : (
              <span>{formatRelative(session.updatedAt, now)}</span>
            )}
          </span>
        </span>
        <span
          className={`mt-1 min-w-0 line-clamp-1 text-[13px] font-semibold leading-snug ${
            unavailable ? "" : "text-content"
          }`}
        >
          {title}
        </span>
        {note ? (
          <span
            className={`mt-1 min-w-0 truncate text-[11px] ${
              confirming && !unavailable ? "text-amber-400" : "text-content/45"
            }`}
          >
            {note}
          </span>
        ) : session.gitBranch ? (
          <span className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-content/45">
            <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate">{session.gitBranch}</span>
          </span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * Name and mascot a folder has in the project rail, or its path when it is
 * not a project yet.
 */
function useFolderIdentity(
  projects: readonly string[],
): (cwd: string) => FolderIdentity {
  const appearance = useMemo(
    () => ({
      labels: loadTabGroupLabels(),
      colors: loadTabGroupColors(),
      custom: loadTabGroupCustomColors(),
      mascots: loadTabGroupMascots(),
    }),
    [],
  );
  return useCallback(
    (cwd: string) => {
      const seed = projectName(cwd);
      if (!projects.some((path) => sameProjectPath(path, cwd))) {
        return { label: prettyCwd(cwd) };
      }
      const key = projectKey(cwd);
      return {
        label: resolveTabGroupLabel(key, appearance.labels, seed),
        mascot: {
          seed,
          color: resolveTabGroupColor(
            key,
            appearance.colors,
            appearance.custom,
            seed,
          ),
          name: resolveTabGroupMascot(key, appearance.mascots),
        },
      };
    },
    [appearance, projects],
  );
}
