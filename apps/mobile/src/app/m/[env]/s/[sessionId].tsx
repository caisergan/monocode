import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostCommand, HostSession, RemoteProvider, Session, UserQuestionPrompt } from "@monocode/core/session";
import { TYPE } from "@monocode/design";
import { MonoTranscript, type MonoTranscriptHandle } from "@transcript";
import { composeCommand, buildPlanPrompt } from "@/compose/command";
import { Composer, type SendInput } from "@/compose/Composer";
import { sameConfig, type ComposerConfig } from "@/compose/models";
import { queueCardState, shouldQueue } from "@/compose/queue";
import { QuestionForm, QueueCard, UsageTab } from "@/compose/tabs";
import { runtime } from "@/hosts/registry";
import { seenKey, useSeen } from "@/hosts/seen";
import { hostNotice, useReconnecting } from "@/hosts/status";
import { useHosts } from "@/hosts/store";
import { discardEntry, enqueue, isLocalSession, newCommandId, resolveOutbox, retryEntry, useOutbox, useSessionOutbox } from "@/outbox";
import { failureText } from "@/outbox/policy";
import type { OutboxEntry } from "@/storage/repo";
import { SessionWindow, type WindowState } from "@/sync/sessionWindow";
import { optimisticBlocks, pendingMarks, sendingApprovals } from "@/transcript/optimistic";
import { ATTACHMENT_ACTION, BUILD_ACTION, buildRows, DRAFT_ACTION, OUTBOX_ACTION, TOOL_ACTION } from "@/transcript/rows";
import { NoticeBar } from "@/ui/components";
import { useFocusedSession } from "@/ui/focus";
import { Icon } from "@/ui/icon";
import { modelLabel } from "@/ui/SessionCard";
import { transcriptTheme, useTokens } from "@/ui/theme";
import { hostCan } from "@/workspace/ChangesPane";

type Header = {
  title: string;
  status: HostSession["status"];
  runId?: string;
  freshness: WindowState["freshness"];
  error?: string;
  projectId?: string;
  config?: ComposerConfig;
  queue?: Pick<Session, "queuedMessages" | "queueStatus" | "usageLimit">;
  question?: UserQuestionPrompt;
  branch?: string;
  worktree: boolean;
  /** The session's working copy, for Explorer and Changes. */
  cwd?: string;
};

/** An approval's buttons keep reading "Sending…" this long after the
 * receipt, until the sync shows it decided. */
const DECIDED_GRACE_MS = 5_000;

const configOf = (session: Session): ComposerConfig => ({
  harness: session.harness as RemoteProvider,
  model: session.model,
  modelSettings: session.modelSettings ?? {},
  runtimeMode: session.runtimeMode,
});

function headerOf(value: HostSession | undefined, state: WindowState, previous: Header): Header {
  if (!value) return { ...previous, freshness: state.freshness, error: state.error };
  const session = value.session;
  return {
    title: session.title,
    status: value.status,
    runId: value.runId,
    freshness: state.freshness,
    error: state.error,
    projectId: value.projectId,
    config: configOf(session),
    queue: { queuedMessages: session.queuedMessages, queueStatus: session.queueStatus, usageLimit: session.usageLimit },
    question: session.pendingQuestion,
    branch: session.branch,
    worktree: !!session.worktreeCwd,
    cwd: session.cwd,
  };
}

const markApproving = (approving: Map<number, number>, requestId: number) => approving.set(requestId, Date.now());

/** A failed command that has no bubble of its own to show it on. */
const bubbleless = (entry: OutboxEntry) => !["send", "draft", "create", "queue"].includes(entry.command.type);

/** One session (11 §11.15). The transcript is native and fed directly from
 * the sync window and the outbox; React renders the header and composer. */
export default function SessionScreen() {
  const { env, sessionId: routeId } = useLocalSearchParams<{ env: string; sessionId: string }>();
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const theme = useMemo(() => transcriptTheme(t), [t]);
  const host = runtime(env);
  const record = useHosts((state) => state.records.find((item) => item.env === env));
  const hostLabel = record?.label ?? "";
  const hostState = useHosts((state) => state.states[env]);
  const online = hostState?.kind === "online";
  const reconnecting = useReconnecting(hostState);
  const markSeen = useSeen((state) => state.markSeen);

  // New session docks here with a local id; the create's receipt names the
  // host's session, and the route follows.
  const local = isLocalSession(routeId);
  const created = useOutbox((state) => state.created[`${env}/${routeId}`]);
  useEffect(() => {
    if (local && created) router.setParams({ sessionId: created });
  }, [local, created]);
  const sessionId = local ? undefined : routeId;
  const entries = useSessionOutbox(env, routeId);
  const createEntry = entries.find((entry) => entry.command.type === "create");

  const transcript = useRef<MonoTranscriptHandle>(null);
  const sessionRef = useRef<SessionWindow | undefined>(undefined);
  const entriesRef = useRef<OutboxEntry[]>(entries);
  const machineRef = useRef({ label: hostLabel, online });
  const open = useRef(new Set<string>());
  const approving = useRef(new Map<number, number>());
  const [header, setHeader] = useState<Header>({ title: "", status: "idle", freshness: "cached", worktree: false });
  const [pendingConfig, setPendingConfig] = useState<ComposerConfig>();
  const pendingRef = useRef<{ config?: ComposerConfig; sent?: string }>({});
  const [usageDismissed, setUsageDismissed] = useState(false);
  const [notice, setNotice] = useState<string>();

  const rebuild = useCallback(() => {
    const value = sessionRef.current?.state.value;
    const outbox = entriesRef.current;
    const blocks = value?.session.blocks ?? [];
    const known = new Set(blocks.map((block) => block.id));
    const sending = sendingApprovals(outbox);
    const now = Date.now();
    for (const [requestId, at] of approving.current) {
      const block = blocks.find((item) => item.approval?.requestId === requestId);
      if (!block || block.approval?.decided || (!sending.has(requestId) && now - at > DECIDED_GRACE_MS)) approving.current.delete(requestId);
      else sending.add(requestId);
    }
    const extra = optimisticBlocks(outbox, known);
    if (!value && !extra.length) return;
    transcript.current?.setRows(
      buildRows(extra.length ? [...blocks, ...extra] : blocks, {
        live: value?.status === "running",
        cwd: value?.session.cwd,
        open: open.current,
        sending,
        hasOlder: sessionRef.current?.hasOlder,
        loadingOlder: sessionRef.current?.state.loadingOlder,
        pending: pendingMarks(outbox, machineRef.current.label, machineRef.current.online),
        canBuild: !!value && value.status !== "running" && !!runtime(env)?.has("sessions.plan"),
      }),
    );
  }, [env]);

  // The outbox changes outside the window: rebuild with it.
  useEffect(() => {
    entriesRef.current = entries;
    machineRef.current = { label: hostLabel, online };
    rebuild();
  }, [entries, hostLabel, online, rebuild]);

  useEffect(() => {
    if (!host || !sessionId) return;
    const session = new SessionWindow(host, sessionId);
    sessionRef.current = session;
    session.open();
    const stop = session.subscribe((state) => {
      rebuild();
      const value = state.value;
      // The host has these blocks and queued items: their outbox copies can go.
      if (value) {
        const optimistic = entriesRef.current.filter((entry) => ["send", "queue", "create"].includes(entry.command.type));
        if (optimistic.length) {
          const ids = new Set([...value.session.blocks.map((block) => block.id), ...(value.session.queuedMessages ?? []).map((item) => item.id)]);
          if (optimistic.some((entry) => ids.has(entry.commandId))) resolveOutbox(env, ids);
        }
      }
      setHeader((previous) => {
        const next = headerOf(value, state, previous);
        return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
      });
      // The host now runs the configuration the person picked.
      const picked = pendingRef.current.config;
      if (picked && value && sameConfig(picked, configOf(value.session))) {
        pendingRef.current = {};
        setPendingConfig(undefined);
      }
    });
    markSeen(seenKey(env, sessionId));
    useFocusedSession.setState({ key: `${env}/${sessionId}` });
    host.setPresence({ visible: true, focusedSessionId: sessionId });
    return () => {
      stop();
      session.close();
      sessionRef.current = undefined;
      markSeen(seenKey(env, sessionId));
      if (useFocusedSession.getState().key === `${env}/${sessionId}`) useFocusedSession.setState({ key: undefined });
      host.setPresence({ visible: true });
    };
  }, [host, env, sessionId, rebuild, markSeen]);

  // The session id commands go to: the host's, or the local one while the
  // create is on its way (those commands wait for it).
  const target = sessionId ?? created ?? routeId;
  const creating = isLocalSession(target);
  const dispatch = (command: HostCommand) =>
    void enqueue(env, command, creating && createEntry ? { localSessionId: target, dependsOn: createEntry.commandId } : undefined);

  // Model and access changes apply as `configure` when idle; while a turn
  // runs they wait for it to settle ("Changes apply to the next turn").
  const sessionConfig = header.config ?? createConfig(createEntry);
  const config = pendingConfig ?? sessionConfig;
  const pickConfig = (next: ComposerConfig) => {
    pendingRef.current = { ...pendingRef.current, config: next };
    setPendingConfig(next);
  };
  useEffect(() => {
    if (!pendingConfig || !sessionId || header.status === "running" || !header.config) return;
    const key = JSON.stringify(pendingConfig);
    if (sameConfig(pendingConfig, header.config) || pendingRef.current.sent === key) return;
    pendingRef.current = { ...pendingRef.current, sent: key };
    void enqueue(env, { type: "configure", commandId: newCommandId(), sessionId, ...pendingConfig });
  }, [pendingConfig, sessionId, header.status, header.config, env]);

  const onAction = (rowId: string, actionId: string) => {
    if (actionId === "fold") {
      if (open.current.has(rowId)) open.current.delete(rowId);
      else open.current.add(rowId);
      rebuild();
      return;
    }
    if (actionId === "older") {
      void sessionRef.current?.loadOlder();
      return;
    }
    if (actionId.startsWith(OUTBOX_ACTION)) {
      offerRetry(actionId.slice(OUTBOX_ACTION.length));
      return;
    }
    if (!sessionId) return;
    if (actionId.startsWith(DRAFT_ACTION)) {
      const draftBlockId = actionId.slice(DRAFT_ACTION.length);
      Alert.alert("Draft", undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => dispatch({ type: "removeDraft", commandId: newCommandId(), sessionId, draftBlockId }) },
        ...(header.status === "running"
          ? []
          : [{ text: "Send", onPress: () => dispatch({ type: "send", commandId: newCommandId(), sessionId, text: "", draftBlockId }) }]),
      ]);
      return;
    }
    // Tool, thinking and trail rows open their detail sheet.
    if (actionId === TOOL_ACTION || actionId === "open") {
      router.push({ pathname: "/m/[env]/s/[sessionId]/tool", params: { env, sessionId, blockId: rowId } });
      return;
    }
    if (actionId.startsWith(ATTACHMENT_ACTION)) {
      router.push({ pathname: "/m/[env]/s/[sessionId]/attachment", params: { env, sessionId, id: actionId.slice(ATTACHMENT_ACTION.length) } });
      return;
    }
    if (actionId.startsWith(BUILD_ACTION)) {
      const plan = sessionRef.current?.block(actionId.slice(BUILD_ACTION.length));
      if (!plan || header.status === "running") return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      dispatch({ type: "send", commandId: newCommandId(), sessionId, text: buildPlanPrompt(plan.text), intent: "build", planBlockId: plan.id });
      return;
    }
    const [kind, request] = actionId.split(":");
    if ((kind === "allow" || kind === "deny") && header.runId) {
      const requestId = Number(request);
      markApproving(approving.current, requestId);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      dispatch({ type: "approve", commandId: newCommandId(), sessionId, runId: header.runId, requestId, decision: kind });
      rebuild();
    }
  };

  const offerRetry = (commandId: string) => {
    const entry = entriesRef.current.find((item) => item.commandId === commandId);
    if (!entry) return;
    const discard = () => {
      // A dropped configure leaves the session as the host has it.
      if (entry.command.type === "configure") {
        pendingRef.current = {};
        setPendingConfig(undefined);
      }
      void discardEntry(commandId);
      // A dropped create leaves nothing to show.
      if (entry.command.type === "create" && local) router.back();
    };
    Alert.alert(failureText(entry.error, hostLabel), undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: discard },
      { text: "Retry", onPress: () => void retryEntry(commandId) },
    ]);
  };

  const running = header.status === "running";
  const canQueue = !!host?.has("sessions.queue");

  const send = ({ text, attachments, mode }: SendInput): boolean => {
    setNotice(undefined);
    if (creating && !createEntry) {
      setNotice("This session was never created.");
      return false;
    }
    const result = composeCommand({
      commandId: newCommandId(),
      sessionId: target,
      text,
      attachments,
      mode,
      // While the first turn starts, a follow-up waits in the queue.
      queue: (creating && canQueue) || shouldQueue(header.queue, header.status),
      running,
      capabilities: { queue: canQueue },
    });
    if ("error" in result) {
      setNotice(result.error);
      return false;
    }
    dispatch(result.command);
    transcript.current?.scrollToBottom(true);
    return true;
  };

  const stop = () => {
    if (header.runId && sessionId) dispatch({ type: "cancel", commandId: newCommandId(), sessionId, runId: header.runId });
  };

  const queue = queueCardState({ session: header.queue, status: header.status, runId: header.runId, entries });
  const question = header.question;
  const answering = !!question && entries.some((entry) => entry.command.type === "answer" && entry.command.requestId === question.requestId && entry.state !== "failed");
  const failed = entries.find((entry) => entry.state === "failed" && bubbleless(entry));
  const unsent = entries.some((entry) => entry.state === "pending" || entry.state === "sending");
  const offline = record ? hostNotice(record, hostState) : undefined;

  const above = (
    <>
      {question && header.runId && sessionId ? (
        <QuestionForm
          key={question.requestId}
          prompt={question}
          sending={answering}
          onSubmit={(reply) =>
            dispatch({ type: "answer", commandId: newCommandId(), sessionId, runId: header.runId!, requestId: question.requestId, reply })
          }
        />
      ) : null}
      {header.queue?.usageLimit && !usageDismissed ? (
        <UsageTab
          resetsAt={header.queue.usageLimit.resetsAt}
          onResume={canQueue && sessionId ? () => dispatch({ type: "resumeQueue", commandId: newCommandId(), sessionId }) : undefined}
          onDismiss={() => setUsageDismissed(true)}
        />
      ) : null}
      {queue ? (
        // While the session is being created only its pending rows show,
        // and those offer nothing but Retry and Discard.
        <QueueCard
          state={queue}
          onSteer={(queuedId) =>
            header.runId && dispatch({ type: "steer", commandId: newCommandId(), sessionId: target, queuedId, runId: header.runId })
          }
          onEdit={(queuedId, text) => dispatch({ type: "editQueued", commandId: newCommandId(), sessionId: target, queuedId, text })}
          onRemove={(queuedId) => dispatch({ type: "unqueue", commandId: newCommandId(), sessionId: target, queuedId })}
          onResume={() => dispatch({ type: "resumeQueue", commandId: newCommandId(), sessionId: target })}
          onRetry={(commandId) => void retryEntry(commandId)}
          onDiscard={(commandId) => void discardEntry(commandId)}
        />
      ) : null}
    </>
  );

  const topBar = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 2 }}>
      <Icon name={header.worktree ? "folder.badge.gearshape" : "folder"} size={13} color={t.text.secondary} />
      <Text style={{ color: t.text.secondary, fontSize: TYPE.meta.size }}>{header.worktree ? "Worktree" : "Current checkout"}</Text>
      {header.branch ? (
        <>
          <Icon name="arrow.triangle.branch" size={12} color={t.contentAlpha(0.55)} />
          <Text numberOfLines={1} style={{ flex: 1, color: t.contentAlpha(0.55), fontSize: TYPE.meta.size, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) }}>
            {header.branch}
          </Text>
        </>
      ) : null}
    </View>
  );

  // Explorer and Changes for this session's working copy (11 §11.20).
  const openWorkspace = (screen: "explorer" | "changes") => {
    if (!header.projectId) return;
    router.push({
      pathname: screen === "explorer" ? "/m/[env]/explorer" : "/m/[env]/changes",
      params: { env, projectId: header.projectId, ...(header.cwd ? { cwd: header.cwd } : {}) },
    });
  };

  const title = header.title || (local ? "New session" : "Session");
  const subline = [modelLabel(config?.model), hostLabel].filter(Boolean).join(" · ");
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.base }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top + 44}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: "center", maxWidth: 260 }}>
              <Text numberOfLines={1} style={{ color: t.content, fontSize: TYPE.screenTitle.size, fontWeight: "600" }}>
                {title}
              </Text>
              <Text numberOfLines={1} style={{ color: t.text.tertiary, fontSize: TYPE.meta.size }}>
                {subline}
                {reconnecting ? " · Reconnecting…" : local ? " · Starting…" : header.freshness === "cached" ? " · Updating…" : ""}
              </Text>
            </View>
          ),
        }}
      />
      {sessionId && header.projectId ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Session menu">
            <Stack.Toolbar.MenuAction icon="folder" hidden={!hostCan(env, "files.list")} onPress={() => openWorkspace("explorer")}>
              Explorer
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="plusminus" hidden={!hostCan(env, "git.index")} onPress={() => openWorkspace("changes")}>
              Changes
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      {notice || header.error ? (
        <NoticeBar text={(notice ?? header.error)!} action={{ label: "Dismiss", onPress: () => setNotice(undefined) }} />
      ) : failed ? (
        <NoticeBar text={failureText(failed.error, hostLabel)} action={{ label: "Retry", onPress: () => offerRetry(failed.commandId) }} />
      ) : offline && unsent && hostState?.kind === "offline" ? (
        <NoticeBar text={`${hostLabel} is offline. Messages you send will go out when it’s back.`} />
      ) : offline ? (
        <NoticeBar text={offline} />
      ) : null}
      <MonoTranscript
        ref={transcript}
        theme={theme}
        style={{ flex: 1 }}
        bottomInset={12}
        onAction={onAction}
        onNeedOlder={() => void sessionRef.current?.loadOlder()}
      />
      <View style={{ paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8), backgroundColor: t.base }}>
        <Composer
          host={host}
          draftKey={target}
          projectId={header.projectId ?? (createEntry?.command.type === "create" ? createEntry.command.projectId : undefined)}
          config={config}
          onConfig={pickConfig}
          providers={(record?.lastWelcome?.providers ?? []) as RemoteProvider[]}
          harnessLocked
          running={running}
          canQueue={canQueue}
          onSend={send}
          onStop={running ? stop : undefined}
          topBar={sessionId ? topBar : undefined}
          above={above}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

/** The configuration a session being created will have. */
function createConfig(entry: OutboxEntry | undefined): ComposerConfig | undefined {
  const command = entry?.command;
  if (command?.type !== "create") return undefined;
  return { harness: command.harness, model: command.model, modelSettings: command.modelSettings ?? {}, runtimeMode: command.runtimeMode };
}
