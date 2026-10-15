import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Chatting,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  type IconComponent,
} from "../../../shared/ui/icons";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { formatRelative } from "../../../shared/lib/relativeTime";
import { copyText } from "../../../platform/tauri/clipboard";
import {
  gitCheckout,
  isCheckoutBlockedByChanges,
  notifyGitChanged,
  subscribeGitChanged,
} from "../../../platform/tauri/fs";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import {
  ExplorerMenu,
  type ExplorerMenuItem,
} from "../../files/ui/ExplorerMenu";
import {
  PULL_REQUEST_MAX,
  PULL_REQUEST_PAGE,
  PULL_REQUEST_STATES,
  canCheckOutPullRequest,
  fetchPullRequests,
  githubCliHint,
  isCurrentBranchPullRequest,
  isPullRequestListUnsupported,
  orderPullRequests,
  peekPullRequests,
  pullRequestReview,
  pullRequestTime,
  type ProjectPullRequest,
  type PullRequestState,
} from "../model/pullRequests";

type Props = {
  cwd: string;
  enabled: boolean;
  expanded: boolean;
  /** Checked-out branch, so its pull request can lead the Open list. */
  branch: string | null;
  /** The pull request showing in the side panel, highlighted in the list. */
  activePullRequest?: { repo: string; number: number } | null;
  linkedSessions?: readonly SessionSummary[];
  onToggleExpanded: () => void;
  onOpenPullRequest: (pr: ProjectPullRequest, repo: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onStartSession?: (pr: ProjectPullRequest, repo: string) => void;
  /** The checkout has no GitHub remote; the parent hides the section. */
  onUnsupported: () => void;
};

const STATE_LABEL: Record<PullRequestState, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

/** Lists change on GitHub, not on disk; refetch at most this often. */
const STALE_AFTER_FOCUS_MS = 60_000;
const STALE_AFTER_GIT_MS = 15_000;

let rememberedState: PullRequestState = "open";

export function GitPullRequests({
  cwd,
  enabled,
  expanded,
  branch,
  activePullRequest,
  linkedSessions = [],
  onToggleExpanded,
  onOpenPullRequest,
  onOpenSession,
  onStartSession,
  onUnsupported,
}: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const [state, setState] = useState<PullRequestState>(rememberedState);
  const [, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    pr: ProjectPullRequest;
    x: number;
    y: number;
  } | null>(null);
  const request = useRef(0);
  const onUnsupportedRef = useRef(onUnsupported);
  onUnsupportedRef.current = onUnsupported;

  const list = peekPullRequests(cwd, state);
  const openList = peekPullRequests(cwd, "open");
  const usable = enabled && !!cwd && cwd !== "~";

  const load = useCallback(
    (target: PullRequestState, limit: number, force = false) => {
      if (!usable) return;
      const cached = peekPullRequests(cwd, target);
      if (!force && cached && cached.limit >= limit) {
        const age = Date.now() - cached.fetchedAt;
        if (age < STALE_AFTER_GIT_MS) return;
      }
      const id = ++request.current;
      setLoading(true);
      void fetchPullRequests(cwd, target, limit)
        .then(() => {
          if (request.current !== id) return;
          setError(null);
          setRevision((value) => value + 1);
        })
        .catch((reason: unknown) => {
          if (request.current !== id) return;
          if (isPullRequestListUnsupported(cwd)) {
            onUnsupportedRef.current();
            return;
          }
          // Keep a list that is already showing; only say the refresh failed.
          if (peekPullRequests(cwd, target)) {
            setStatus("Couldn't refresh pull requests");
            return;
          }
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (request.current === id) setLoading(false);
        });
    },
    [cwd, usable],
  );

  // A visible list loads on open and tab change, then follows the checkout.
  useEffect(() => {
    if (!usable || !expanded) return;
    const cached = peekPullRequests(cwd, state);
    load(state, cached?.limit ?? PULL_REQUEST_PAGE);
    const refreshIfStale = (maxAge: number) => {
      const current = peekPullRequests(cwd, state);
      if (current && Date.now() - current.fetchedAt < maxAge) return;
      load(state, current?.limit ?? PULL_REQUEST_PAGE, true);
    };
    const onResume = () => {
      if (!document.hidden) refreshIfStale(STALE_AFTER_FOCUS_MS);
    };
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    const unsubscribe = subscribeGitChanged(() =>
      refreshIfStale(STALE_AFTER_GIT_MS),
    );
    return () => {
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      unsubscribe();
    };
  }, [cwd, expanded, load, state, usable]);

  // The collapsed header still shows how many are open.
  useEffect(() => {
    if (!usable || expanded || peekPullRequests(cwd, "open")) return;
    load("open", PULL_REQUEST_PAGE);
  }, [cwd, expanded, load, usable]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const selectState = (next: PullRequestState) => {
    rememberedState = next;
    setError(null);
    setState(next);
  };

  const items = useMemo(
    () =>
      list
        ? state === "open"
          ? orderPullRequests(list.items, branch)
          : list.items
        : [],
    [branch, list, state],
  );
  const repo = list?.repo ?? openList?.repo ?? "";
  const openCount = openList
    ? `${openList.items.length}${openList.items.length >= openList.limit ? "+" : ""}`
    : null;
  const canShowMore =
    !!list &&
    list.items.length >= list.limit &&
    list.limit < PULL_REQUEST_MAX;

  const sessionsFor = useCallback(
    (pr: ProjectPullRequest, prRepo: string) =>
      linkedSessions.filter((session) => {
        const linked = session.linkedWorkItem;
        return (
          linked?.kind === "pr" &&
          linked.number === pr.number &&
          linked.repo.toLowerCase() === prRepo.toLowerCase()
        );
      }),
    [linkedSessions],
  );

  const checkOut = async (pr: ProjectPullRequest) => {
    setStatus(`Checking out ${pr.headRef}…`);
    try {
      await gitCheckout(cwd, pr.headRef);
      notifyGitChanged();
      setStatus(`On ${pr.headRef}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setStatus(
        isCheckoutBlockedByChanges(message)
          ? "Commit or stash your changes before checking out"
          : /already (checked out|used by worktree)/i.test(message)
            ? `${pr.headRef} is checked out in another worktree`
            : message,
      );
    }
  };

  const menuItems = (pr: ProjectPullRequest): ExplorerMenuItem[] => {
    const sessions = sessionsFor(pr, repo);
    const checkout = canCheckOutPullRequest(pr, branch);
    return [
      { kind: "item", id: "github", label: "Open on GitHub" },
      { kind: "item", id: "copy-link", label: "Copy link" },
      {
        kind: "item",
        id: "copy-branch",
        label: "Copy branch name",
        disabled: !pr.headRef,
      },
      { kind: "sep" },
      {
        kind: "item",
        id: "checkout",
        label: "Check out branch",
        disabled: !checkout,
        ...(checkout
          ? {}
          : {
              description: isCurrentBranchPullRequest(pr, branch)
                ? "Already checked out"
                : pr.crossRepository
                  ? "Branch is in another repository"
                  : pr.state !== "open"
                    ? "Pull request is not open"
                    : undefined,
            }),
      },
      ...(onStartSession
        ? [{ kind: "item" as const, id: "session", label: "Start session" }]
        : []),
      ...(sessions.length > 0 && onOpenSession
        ? [
            {
              kind: "item" as const,
              id: "linked-session",
              label:
                sessions.length > 1
                  ? `Open linked session (${sessions.length})`
                  : "Open linked session",
            },
          ]
        : []),
    ];
  };

  const onPick = (pr: ProjectPullRequest, id: string) => {
    if (id === "github") void openUrl(pr.url).catch(() => undefined);
    else if (id === "copy-link") void copyText(pr.url);
    else if (id === "copy-branch") void copyText(pr.headRef);
    else if (id === "checkout") void checkOut(pr);
    else if (id === "session") onStartSession?.(pr, repo);
    else if (id === "linked-session") {
      const session = sessionsFor(pr, repo)[0];
      if (session) onOpenSession?.(session.id);
    }
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[data-pr-row]",
      ),
    ];
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : index < 0
            ? 0
            : Math.min(
                rows.length - 1,
                Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)),
              );
    rows[next]?.focus();
  };

  const now = Date.now();
  const hint = error ? githubCliHint(error) : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse pull requests" : "Expand pull requests"}
        title={repo || undefined}
        className={`flex w-full shrink-0 items-center gap-1.5 px-3 text-left leading-none hover:bg-content/5 ${
          expanded ? "h-7" : "h-full"
        }`}
      >
        <span className="text-[10px] font-semibold tracking-[0.04em] text-content/55 uppercase">
          Pull requests
        </span>
        {!expanded && openCount && openCount !== "0" ? (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-content/10 px-1 text-[10px] tabular-nums text-content/60">
            {openCount}
          </span>
        ) : null}
        {expanded && repo ? (
          <span className="min-w-0 truncate text-[10px] text-content/35">
            {repo}
          </span>
        ) : null}
        {expanded ? (
          <ChevronDown
            className="ml-auto size-3.5 shrink-0 text-content/50"
            strokeWidth={1.75}
          />
        ) : (
          <ChevronRight
            className="ml-auto size-3.5 shrink-0 text-content/50"
            strokeWidth={1.75}
          />
        )}
      </button>
      {expanded ? (
        <>
          <div className="flex h-8 shrink-0 items-center gap-0.5 px-2">
            <div
              role="tablist"
              aria-label="Pull request state"
              className="flex min-w-0 items-center gap-0.5"
            >
              {PULL_REQUEST_STATES.map((option) => {
                const selected = option === state;
                return (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => selectState(option)}
                    className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] leading-none ${
                      selected
                        ? "bg-selection text-content"
                        : "text-content/50 hover:bg-content/5 hover:text-content"
                    }`}
                  >
                    {STATE_LABEL[option]}
                    {option === "open" && openCount ? (
                      <span
                        className={`tabular-nums ${selected ? "text-content/50" : "text-content/35"}`}
                      >
                        {openCount}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              title="Refresh pull requests"
              aria-label="Refresh pull requests"
              disabled={!usable}
              onClick={() =>
                load(state, list?.limit ?? PULL_REQUEST_PAGE, true)
              }
              className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content disabled:opacity-40"
            >
              {loading ? (
                <LoaderCircle
                  className="size-3.5 animate-spin"
                  strokeWidth={1.75}
                />
              ) : (
                <RefreshCw className="size-3.5" strokeWidth={1.75} />
              )}
            </button>
          </div>
          {status ? (
            <p
              role="status"
              className="shrink-0 truncate px-3 pb-1 text-[11px] text-content/55"
              title={status}
            >
              {status}
            </p>
          ) : null}
          <div
            ref={lockOverscroll}
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none"
          >
            {!usable ? (
              <p className="px-3 py-2 text-[12px] text-content/45">
                No project folder
              </p>
            ) : error && items.length === 0 ? (
              <div className="flex flex-col items-start gap-1.5 px-3 py-2">
                <p
                  role="alert"
                  className="line-clamp-3 text-[12px] text-content/50"
                  title={error}
                >
                  {hint ?? error}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    load(state, list?.limit ?? PULL_REQUEST_PAGE, true)
                  }
                  className="rounded-md px-1.5 py-0.5 text-[11px] text-content/60 hover:bg-content/10 hover:text-content"
                >
                  Try again
                </button>
              </div>
            ) : !list ? (
              <PullRequestSkeleton />
            ) : items.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-content/45">
                No {STATE_LABEL[state].toLowerCase()} pull requests
              </p>
            ) : (
              <ul
                aria-label={`${STATE_LABEL[state]} pull requests`}
                onKeyDown={onListKeyDown}
                className="flex min-w-0 flex-col py-0.5"
              >
                {items.map((pr) => (
                  <PullRequestRow
                    key={pr.number}
                    pr={pr}
                    now={now}
                    viewer={list.viewer}
                    current={state === "open" && isCurrentBranchPullRequest(pr, branch)}
                    active={
                      !!activePullRequest &&
                      activePullRequest.number === pr.number &&
                      activePullRequest.repo.toLowerCase() ===
                        list.repo.toLowerCase()
                    }
                    sessions={sessionsFor(pr, list.repo)}
                    onOpen={() => onOpenPullRequest(pr, list.repo)}
                    onOpenSession={onOpenSession}
                    onMenu={(event) => {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({
                        pr,
                        x: event.type === "contextmenu" ? event.clientX : rect.right,
                        y: event.type === "contextmenu" ? event.clientY : rect.bottom,
                      });
                    }}
                  />
                ))}
                {canShowMore ? (
                  <li>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() =>
                        load(
                          state,
                          Math.min(PULL_REQUEST_MAX, list.limit + PULL_REQUEST_PAGE),
                          true,
                        )
                      }
                      className="flex h-7 w-full items-center justify-center gap-1.5 text-[11px] text-content/50 hover:bg-content/5 hover:text-content disabled:opacity-60"
                    >
                      {loading ? (
                        <LoaderCircle
                          className="size-3 animate-spin"
                          strokeWidth={1.75}
                        />
                      ) : null}
                      Show more
                    </button>
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </>
      ) : null}
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={`Pull request #${menu.pr.number} actions`}
          items={menuItems(menu.pr)}
          onPick={(id) => {
            const pr = menu.pr;
            setMenu(null);
            onPick(pr, id);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

type StatusMark = { Icon: IconComponent; label: string; className: string };

export function pullRequestStatusMark(pr: ProjectPullRequest): StatusMark {
  if (pr.state === "merged") {
    return { Icon: GitMerge, label: "Merged", className: "text-violet-400/90" };
  }
  if (pr.state === "closed") {
    return {
      Icon: GitPullRequestClosed,
      label: "Closed",
      className: "text-rose-400/90",
    };
  }
  if (pr.draft) {
    return {
      Icon: GitPullRequestDraft,
      label: "Draft",
      className: "text-content/45",
    };
  }
  return {
    Icon: GitPullRequest,
    label: "Open",
    className: "text-emerald-400/90",
  };
}

const CHECKS_LABEL: Record<Exclude<ProjectPullRequest["checks"], "">, string> = {
  pass: "Checks passing",
  fail: "Checks failing",
  pending: "Checks running",
};

function PullRequestRow({
  pr,
  now,
  viewer,
  current,
  active,
  sessions,
  onOpen,
  onOpenSession,
  onMenu,
}: {
  pr: ProjectPullRequest;
  now: number;
  viewer: string;
  current: boolean;
  active: boolean;
  sessions: readonly SessionSummary[];
  onOpen: () => void;
  onOpenSession?: (sessionId: string) => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const mark = pullRequestStatusMark(pr);
  const review = pullRequestReview(pr);
  const time = formatRelative(Date.parse(pullRequestTime(pr)), now);
  const mine = !!viewer && pr.author.toLowerCase() === viewer.toLowerCase();
  const checks = pr.checks ? CHECKS_LABEL[pr.checks] : "";
  const summary = [
    `#${pr.number} ${pr.title}`,
    [
      pr.headRef && pr.baseRef ? `${pr.headRef} → ${pr.baseRef}` : pr.headRef,
      pr.author && !mine ? `by ${pr.author}` : "",
      mark.label,
      checks,
      review?.label ?? "",
    ]
      .filter(Boolean)
      .join(" · "),
  ].join("\n");

  return (
    <li
      className={`group relative min-w-0 ${
        active ? "bg-selection" : "hover:bg-content/5"
      }`}
    >
      <button
        type="button"
        data-pr-row
        title={summary}
        aria-label={summary.replace("\n", ", ")}
        aria-current={active || undefined}
        onClick={onOpen}
        onContextMenu={onMenu}
        className="absolute inset-0 z-0 rounded-none outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset"
      />
      <div className="pointer-events-none relative flex min-w-0 items-start gap-2 py-1.5 pr-2.5 pl-3">
        <mark.Icon
          aria-hidden
          className={`mt-px size-3.5 shrink-0 ${mark.className}`}
          strokeWidth={1.75}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-[12px] leading-4 ${
                current ? "font-medium text-content" : "text-content/90"
              }`}
            >
              {pr.title}
            </span>
            <span className="shrink-0 text-[11px] leading-4 tabular-nums text-content/40 group-focus-within:invisible group-hover:invisible">
              #{pr.number}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-content/45">
            {pr.author && !mine ? (
              <AuthorAvatar login={pr.author} url={pr.authorAvatarUrl} />
            ) : null}
            {current ? (
              <GitBranch
                aria-hidden
                className="size-3 shrink-0 text-accent"
                strokeWidth={2}
              />
            ) : null}
            <span
              className={`min-w-0 truncate ${current ? "text-content/70" : ""}`}
            >
              {pr.headRef || "—"}
            </span>
            {pr.draft && pr.state === "open" ? (
              <span className="shrink-0">Draft</span>
            ) : null}
            {review ? (
              <span
                className={`shrink-0 ${
                  review.tone === "approved"
                    ? "text-emerald-400/80"
                    : "text-amber-400/90"
                }`}
              >
                {review.label}
              </span>
            ) : null}
            {pr.checks ? <ChecksDot checks={pr.checks} /> : null}
            {sessions.length > 0 && onOpenSession ? (
              <button
                type="button"
                title={
                  sessions.length > 1
                    ? `${sessions.length} linked sessions`
                    : `Open “${sessions[0]!.title}”`
                }
                aria-label="Open linked session"
                onClick={() => onOpenSession(sessions[0]!.id)}
                className="pointer-events-auto relative z-10 -my-0.5 flex shrink-0 items-center gap-0.5 rounded px-0.5 text-content/50 hover:bg-content/10 hover:text-content"
              >
                <Chatting className="size-3" strokeWidth={1.75} />
                {sessions.length > 1 ? (
                  <span className="tabular-nums">{sessions.length}</span>
                ) : null}
              </button>
            ) : null}
            <span className="ml-auto shrink-0 pl-1 tabular-nums text-content/35">
              {time}
            </span>
          </div>
        </div>
      </div>
      <button
        type="button"
        aria-label={`Actions for pull request #${pr.number}`}
        title="More actions"
        onClick={onMenu}
        className="invisible absolute top-1 right-1.5 z-10 grid size-5 place-items-center rounded-md text-content/55 group-focus-within:visible group-hover:visible hover:bg-content/10 hover:text-content focus-visible:visible"
      >
        <MoreHorizontal className="size-3.5" strokeWidth={2} />
      </button>
    </li>
  );
}

function ChecksDot({
  checks,
}: {
  checks: Exclude<ProjectPullRequest["checks"], "">;
}) {
  return (
    <span
      aria-label={CHECKS_LABEL[checks]}
      className={`size-1.5 shrink-0 rounded-full ${
        checks === "pass"
          ? "bg-emerald-400/90"
          : checks === "fail"
            ? "bg-rose-400/90"
            : "animate-pulse bg-amber-400/90"
      }`}
    />
  );
}

function AuthorAvatar({ login, url }: { login: string; url: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <span
        aria-hidden
        className="grid size-3.5 shrink-0 place-items-center rounded-full bg-content/10 text-[8px] uppercase text-content/60"
      >
        {login.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-3.5 shrink-0 rounded-full bg-content/10 object-cover"
    />
  );
}

function PullRequestSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col gap-1 py-1.5">
      {[72, 56, 64].map((width) => (
        <li key={width} className="flex items-start gap-2 px-3 py-1">
          <span className="mt-0.5 size-3.5 shrink-0 animate-pulse rounded-full bg-content/8" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              className="h-2.5 animate-pulse rounded bg-content/8"
              style={{ width: `${width}%` }}
            />
            <span className="h-2 w-2/5 animate-pulse rounded bg-content/6" />
          </span>
        </li>
      ))}
    </ul>
  );
}
