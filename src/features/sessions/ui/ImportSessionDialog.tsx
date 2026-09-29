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
  IMPORTABLE_HARNESSES,
  listAgentSessions,
  type AgentSessionListing,
  type AgentSessionSummary,
} from "../../../platform/tauri/agentSessions";
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
import {
  agentImportPlan,
  importAgentSession,
} from "../model/agentSessionImport";
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

/** Where a home-folder session goes: a chat that belongs to no project. */
const NO_PROJECT: FolderIdentity = { label: "No project" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lists sessions started in a terminal with a coding agent, and imports the
 * chosen one as a MonoCode session that resumes the same conversation. Reads like the sessions list: same search box, filter menu,
 * row and empty states.
 */
export function ImportSessionDialog({
  cwd: initialCwd,
  projects,
  onClose,
  onOpen,
}: Props) {
  const [scope, setScope] = useState(initialCwd);
  // Only sessions that import as chats without a project.
  const [chatsOnly, setChatsOnly] = useState(false);
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
  const [listing, setListing] = useState<AgentSessionListing | null>(null);
  const [fetching, setFetching] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [importError, setImportError] = useState("");
  const [hiddenCount, setHiddenCount] = useState(0);
  const sentinel = useRef<HTMLLIElement>(null);
  // Each listing supersedes the last, so a fast typist doesn't queue reads.
  const owner = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const hiddenHarnessesKey = filters.hiddenHarnesses.join(",");
  useEffect(() => {
    let active = true;
    setFetching(true);
    // The time filter goes to the listing, so a page and "more" count only
    // matching rows; filtering here instead kept loading hidden pages.
    const since = timeFilterStart(filters.time, Date.now());
    const hidden = new Set<string>(hiddenHarnessesKey.split(","));
    void listAgentSessions({
      ...(hiddenHarnessesKey
        ? {
            harnesses: IMPORTABLE_HARNESSES.filter(
              (harness) => !hidden.has(harness),
            ),
          }
        : {}),
      cwd: chatsOnly ? undefined : scope,
      ...(chatsOnly ? { projectless: true } : {}),
      query: search || undefined,
      limit: PAGE_LIMITS[page],
      includeImported,
      owner,
      ...(since > 0 ? { since } : {}),
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
  }, [
    scope,
    chatsOnly,
    search,
    page,
    includeImported,
    reload,
    owner,
    filters.time,
    hiddenHarnessesKey,
  ]);

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
  const sessions = listing?.sessions ?? [];
  const filtersActive = hasActiveSessionFilters(filters);

  const pick = (session: AgentSessionSummary) => {
    if (importing) return;
    if (session.monocodeSessionId) {
      onOpen(session.monocodeSessionId, agentImportPlan(session).cwd);
      return;
    }
    if (now - session.updatedAt < RECENT_MS && confirming !== session.id) {
      setConfirming(session.id);
      return;
    }
    setImporting(session.id);
    setImportError("");
    void importAgentSession(session)
      .then((result) => onOpen(result.sessionId, result.cwd))
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

  const projectScoped = !!scope && !chatsOnly;
  const views: {
    id: string;
    label: string;
    active: boolean;
    pick: () => void;
  }[] = [
    {
      id: "all",
      label: "All folders",
      active: !scope && !chatsOnly,
      pick: () => {
        setScope(undefined);
        setChatsOnly(false);
      },
    },
    ...(initialCwd
      ? [
          {
            id: "project",
            label: identity(initialCwd).label,
            active: projectScoped,
            pick: () => {
              setScope(initialCwd);
              setChatsOnly(false);
            },
          },
        ]
      : []),
    {
      id: "chats",
      label: "Chats",
      active: chatsOnly,
      pick: () => setChatsOnly(true),
    },
  ];

  return (
    <Modal
      title="Import session"
      description="Pick up a session you started in the terminal"
      onClose={onClose}
      className="h-[min(72vh,640px)]"
    >
      {/*
        Only the list scrolls. The search bar sits above it rather than
        sticking inside it, so rows never pass behind the translucent sheet.
      */}
      <div className="flex h-full flex-col">
        <div
          // While the box holds a query or the filter menu is open, Escape
          // belongs to them rather than closing the sheet.
          data-dialog-popover={query || filterMenu ? "" : undefined}
          className="mt-2 flex h-9 shrink-0 items-center gap-1 border-y border-stroke px-2"
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

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none">
          <div
            role="group"
            aria-label="Which sessions"
            className="flex items-center gap-1 px-3 pt-2 text-[12px]"
          >
            {views.map((view, index) => (
              <span key={view.id} className="flex items-center gap-1">
                {index > 0 ? <span className="text-content/30">·</span> : null}
                <button
                  type="button"
                  aria-pressed={view.active}
                  title={
                    view.id === "chats"
                      ? "Sessions without a project: started in your home folder, or in a folder that no longer exists"
                      : undefined
                  }
                  onClick={() => {
                    if (view.active) return;
                    view.pick();
                    setPage(0);
                  }}
                  className={
                    view.active
                      ? "text-content"
                      : "text-content/50 hover:text-content"
                  }
                >
                  {view.label}
                </button>
              </span>
            ))}
          </div>

          {importError ? (
            <p role="alert" className="px-3 pt-2 text-[12px] text-red-400">
              {importError}
            </p>
          ) : null}

          {/*
          The first load stays blank, like the sessions list: it resolves in
          a moment and a placeholder would only flash.
        */}
          {loadError ? (
            <p role="alert" className="px-3 pt-2 text-[12px] text-content/50">
              Couldn’t load terminal sessions
            </p>
          ) : null}

          {!listing ? null : sessions.length === 0 ? (
            search ? (
              <p className="px-3 py-2 text-[12px] text-content/50">
                No matching sessions
              </p>
            ) : filtersActive ? (
              <p className="px-3 py-2 text-[12px] text-content/50">
                No sessions match these filters
              </p>
            ) : chatsOnly && !(hiddenCount > 0 && !includeImported) ? (
              <p className="px-3 py-2 text-[12px] text-content/50">
                No sessions without a project
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
                  folder={projectScoped ? null : rowFolder(session, identity)}
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

          {/* The count covers every session, so a search would contradict it. */}
          {listing && !search && (hiddenCount > 0 || includeImported) ? (
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
      </div>

      {filterMenu ? (
        <SessionFiltersMenu
          x={filterMenu.x}
          y={filterMenu.y}
          harnesses={[...IMPORTABLE_HARNESSES]}
          filters={filters}
          onChange={(next) => {
            setFilters(next);
            setPage(0);
          }}
          onClose={() => setFilterMenu(null)}
          archivedOption={false}
          statusOptions={false}
        />
      ) : null}
    </Modal>
  );
}

/** Where a row's session ran, as the project rail names it. */
function rowFolder(
  session: AgentSessionSummary,
  identity: (cwd: string) => FolderIdentity,
): FolderIdentity {
  if (session.folder === "home") return NO_PROJECT;
  if (session.folder === "missing") return { label: prettyCwd(session.cwd) };
  return identity(agentImportPlan(session).cwd);
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
  session: AgentSessionSummary;
  /** Where the session ran; omitted when the sheet is scoped to one project. */
  folder: FolderIdentity | null;
  now: number;
  importing: boolean;
  confirming: boolean;
  disabled: boolean;
  onPick: (session: AgentSessionSummary) => void;
}) {
  const title = session.title || session.firstPrompt;
  const missing = session.folder === "missing";
  const tooltip = [
    title,
    session.lastPrompt !== title ? session.lastPrompt : "",
  ]
    .filter(Boolean)
    .join("\n");
  const note = confirming
    ? "May still be open in the terminal. Click again to import."
    : session.monocodeSessionId
      ? "Already in MonoCode"
      : missing
        ? "Folder no longer exists · imports without resuming"
        : null;

  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(session)}
        className="relative flex w-full cursor-default select-none flex-col rounded-md border border-transparent px-2.5 py-2 text-left text-content/80 outline-none hover:bg-content/5 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/50 disabled:hover:bg-transparent"
      >
        <span className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <HarnessIcon
              harness={session.harness}
              className="size-3.5 shrink-0"
            />
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
          // Only the title carries the full prompts: on the whole row, one
          // shown tooltip made every row it crossed pop its own at once.
          title={tooltip}
          className="mt-1 min-w-0 line-clamp-1 text-[13px] font-semibold leading-snug text-content"
        >
          {title}
        </span>
        {note ? (
          <span
            className={`mt-1 min-w-0 truncate text-[11px] ${
              confirming ? "text-amber-400" : "text-content/45"
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
