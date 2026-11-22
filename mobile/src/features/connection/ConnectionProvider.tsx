import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import type {
  ApprovalPrompt,
  Project,
  Mono,
  SessionSummary,
  Message,
  QuestionPrompt,
  UsageLimitState,
  Turn,
} from "@/features/workspace/types";
import {
  nativeCall,
  parseInvitation,
  request,
  type Pairing,
  type Desktop,
  type Identity,
} from "./nativeLink";
import type { MachineInvitation } from "./invitation";
import { normalizeSelection, type MobileSelection } from "./selection";

export type Catalog = {
  projects: Project[];
  monos: Mono[];
  sessions: SessionSummary[];
  addresses?: Desktop["addresses"];
  /** The desktop answers Mono profiles, editing, reset, delete and create;
   *  the older desktop app sends no such flag. */
  monoTools?: boolean;
  /** The desktop sends this phone push notifications once it registers;
   *  the older desktop app doesn't, and the phone posts its own. */
  push?: boolean;
  /** The desktop reads and saves a Mono's soul and memory for the phone. */
  monoFiles?: boolean;
  /** Sends the approval an agent waits on, for the phone to answer; a
   *  machine's host does, a desktop leaves approvals to itself. */
  approvals?: boolean;
};
const EMPTY: Catalog = { projects: [], monos: [], sessions: [] };
/** The connection in use, as older builds kept their one desktop. */
const PAIRING = "monocode.mobile.pairing";
/** Every desktop and machine paired, most recently used first. */
const CONNECTIONS = "monocode.mobile.connections";
const IDENTITY = "monocode.mobile.identity";
const key = (fingerprint: string, kind: string) =>
  `monocode.mobile.${fingerprint}.${kind}`;
/** A machine's credential, kept as this installation's identity is. */
const tokenKey = (environmentId: string) => `monocode.mobile.machine.${environmentId}`;
const SECURE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
type Connection = {
  restoring: boolean;
  pairing: Pairing | null;
  /** Everything this phone is paired with, the one in use first. */
  connections: Desktop[];
  catalog: Catalog;
  selection: MobileSelection | null;
  connected: boolean;
  working: boolean;
  error: string | null;
  /** Pairs with a desktop's or a machine's code and switches to it; true once paired. */
  pair: (text: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  select: (selection: MobileSelection) => Promise<void>;
  /** Uses another paired desktop or machine, by its fingerprint. */
  switchTo: (fingerprint: string) => Promise<void>;
  /** Unpairs the one in use, then carries on with the next one paired. */
  disconnect: () => Promise<void>;
  command: <T>(method: string, params?: object, id?: string) => Promise<T>;
};
const Context = createContext<Connection | null>(null);
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [restoring, setRestoring] = useState(true);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [connections, setConnections] = useState<Desktop[]>([]);
  const connectionsRef = useRef(connections);
  useLayoutEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY);
  const [selection, setSelection] = useState<MobileSelection | null>(null);
  const [connected, setConnected] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<Pairing | null>(null);
  const refreshing = useRef(false);
  const lastCatalog = useRef<string | null>(null);
  const pairingNow = useRef(false);
  const generation = useRef(0);
  /** Makes `desktop` the connection in use, with its saved choices and workspace. */
  const activate = useCallback(async (desktop: Desktop, identity?: Identity) => {
    const value: Pairing = desktop.machine
      ? { desktop, token: (await SecureStore.getItemAsync(tokenKey(desktop.machine.environmentId))) ?? "" }
      : {
          desktop,
          identity: identity ?? JSON.parse((await SecureStore.getItemAsync(IDENTITY)) ?? "null"),
        };
    if (desktop.machine ? !value.token : !value.identity)
      throw new Error(`Pair with ${desktop.name} again.`);
    const [chosen, saved] = await Promise.all([
      Storage.getItem(key(desktop.fingerprint, "selection")),
      Storage.getItem(key(desktop.fingerprint, "catalog")),
    ]);
    generation.current++;
    active.current = value;
    lastCatalog.current = null;
    setPairing(value);
    setConnected(false);
    setError(null);
    setSelection(chosen ? normalizeSelection(JSON.parse(chosen)) : null);
    setCatalog(saved ? JSON.parse(saved) : EMPTY);
    await Storage.setItem(PAIRING, JSON.stringify(desktop));
    return value;
  }, []);
  /** Saves the list, the one in use first. */
  const remember = useCallback(async (list: Desktop[]) => {
    connectionsRef.current = list;
    setConnections(list);
    await Storage.setItem(CONNECTIONS, JSON.stringify(list));
  }, []);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [desktop, saved] = await Promise.all([
          Storage.getItem(PAIRING),
          Storage.getItem(CONNECTIONS),
        ]);
        // An older build kept its one desktop only.
        const current: Desktop | null = desktop ? JSON.parse(desktop) : null;
        let list: Desktop[] = saved ? JSON.parse(saved) : [];
        if (current && !list.some((entry) => entry.fingerprint === current.fingerprint))
          list = [current, ...list];
        if (disposed) return;
        setConnections(list);
        if (!saved && list.length) await Storage.setItem(CONNECTIONS, JSON.stringify(list));
        if (!current || disposed) return;
        await activate(current);
      } catch {
        if (!disposed)
          setError("Could not restore the connection. Connect again.");
      } finally {
        if (!disposed) setRestoring(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [activate]);
  const refresh = useCallback(async () => {
    const value = active.current;
    if (!value || refreshing.current) return;
    const version = generation.current;
    refreshing.current = true;
    try {
      const next = await request<Catalog>(value, "workspace.list");
      if (active.current !== value || version !== generation.current) return;
      if (
        !Array.isArray(next.projects) ||
        !Array.isArray(next.monos) ||
        !Array.isArray(next.sessions)
      )
        throw new Error(`${value.desktop.machine ? "Machine" : "Desktop"} sent an invalid workspace`);
      if (next.addresses?.length && !value.desktop.machine) {
        value.desktop.addresses = next.addresses;
        await Storage.setItem(PAIRING, JSON.stringify(value.desktop));
        // The saved list too, so switching back reaches it where it is now.
        await remember(
          connectionsRef.current.map((entry) =>
            entry.fingerprint === value.desktop.fingerprint ? value.desktop : entry,
          ),
        );
      }
      // The poll repeats every few seconds; only a changed workspace is saved
      // and re-rendered.
      const { addresses: _, ...workspace } = next;
      const serialized = JSON.stringify(workspace);
      if (serialized !== lastCatalog.current) {
        await Storage.setItem(key(value.desktop.fingerprint, "catalog"), serialized);
        if (active.current !== value) return;
        lastCatalog.current = serialized;
        setCatalog((previous) => withUnchanged(previous, next));
      }
      setConnected(true);
      setError(null);
    } catch (reason) {
      if (active.current === value) {
        setConnected(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      refreshing.current = false;
    }
  }, [remember]);
  useEffect(() => {
    if (!pairing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (AppState.currentState === "active") await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [pairing, refresh]);
  const pair = useCallback(async (text: string) => {
    if (pairingNow.current) return false;
    pairingNow.current = true;
    setWorking(true);
    setError(null);
    try {
      const invitation = parseInvitation(text);
      if (invitation.kind === "host") {
        const desktop = await enrollMachine(invitation);
        await remember([desktop, ...connectionsRef.current.filter((entry) => entry.fingerprint !== desktop.fingerprint)]);
        await activate(desktop);
        await refresh();
        return true;
      }
      const existing = await SecureStore.getItemAsync(IDENTITY);
      const identity = existing
        ? (JSON.parse(existing) as Identity)
        : await nativeCall<Identity>({ operation: "identity" });
      await SecureStore.setItemAsync(IDENTITY, JSON.stringify(identity), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      const fingerprint = await nativeCall<string>({
        operation: "fingerprint",
        identity: invitation.identity,
      });
      const proof = await nativeCall<string>({
        operation: "proof",
        identity,
        invitation: fingerprint,
      });
      const desktop = await nativeCall<Desktop>({
        operation: "exchange",
        identity: invitation.identity,
        pin: invitation.fingerprint,
        addresses: invitation.addresses,
        request: {
          version: 1,
          id: "enroll",
          method: "device.enroll",
          params: {
            certificate: identity.certificate,
            proof,
            name: deviceName(),
          },
        },
      });
      await remember([desktop, ...connectionsRef.current.filter((entry) => entry.fingerprint !== desktop.fingerprint)]);
      await activate(desktop, identity);
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      pairingNow.current = false;
      setWorking(false);
    }
  }, [activate, refresh, remember]);
  const switchTo = useCallback(async (fingerprint: string) => {
    const desktop = connectionsRef.current.find((entry) => entry.fingerprint === fingerprint);
    if (!desktop || active.current?.desktop.fingerprint === fingerprint) return;
    // The one left keeps its workspace for next time.
    const previous = active.current?.desktop.fingerprint;
    if (previous && lastCatalog.current)
      await Storage.setItem(key(previous, "catalog"), lastCatalog.current);
    await remember([desktop, ...connectionsRef.current.filter((entry) => entry !== desktop)]);
    await activate(desktop);
    void refresh();
  }, [activate, refresh, remember]);
  const select = useCallback(async (value: MobileSelection) => {
    const pairing = active.current;
    if (!pairing) return;
    await Storage.setItem(
      key(pairing.desktop.fingerprint, "selection"),
      JSON.stringify(value),
    );
    if (active.current === pairing) setSelection(value);
  }, []);
  const disconnect = useCallback(async () => {
    const value = active.current;
    generation.current++;
    active.current = null;
    setPairing(null);
    setConnected(false);
    setCatalog(EMPTY);
    lastCatalog.current = null;
    setSelection(null);
    setError(null);
    await Storage.removeItem(PAIRING);
    const rest = connectionsRef.current.filter(
      (entry) => entry.fingerprint !== value?.desktop.fingerprint,
    );
    await remember(rest);
    if (value) {
      // Told before its credential goes, so a machine revokes it.
      void request(value, "device.leave")
        .catch(() => {})
        .finally(() => {
          const machine = value.desktop.machine;
          if (machine) void SecureStore.deleteItemAsync(tokenKey(machine.environmentId));
        });
      await Storage.removeItem(key(value.desktop.fingerprint, "catalog"));
    }
    // Keep this installation's identity, so a new invitation can recover cleanly.
    // Carry on with the next one paired, if there is one.
    if (rest[0]) {
      await activate(rest[0]).catch(() => undefined);
      void refresh();
    }
  }, [activate, refresh, remember]);
  const command = useCallback(
    async <T,>(
      method: string,
      params: object = {},
      id?: string,
    ): Promise<T> => {
      const value = active.current;
      if (!value) throw new Error("Connect to your desktop or a machine first");
      return request<T>(value, method, params, id);
    },
    [],
  );
  // Every screen reads this; a new object each render would re-render them all.
  const value = useMemo(
    () => ({
      restoring,
      pairing,
      connections,
      catalog,
      selection,
      connected,
      working,
      error,
      pair,
      refresh,
      select,
      switchTo,
      disconnect,
      command,
    }),
    [
      restoring,
      pairing,
      connections,
      catalog,
      selection,
      connected,
      working,
      error,
      pair,
      refresh,
      select,
      switchTo,
      disconnect,
      command,
    ],
  );
  return <Context value={value}>{children}</Context>;
}
/**
 * The new catalog, keeping the projects, monos and sessions that did not
 * change as they were, so rows memoized on them skip re-rendering.
 */
function withUnchanged(previous: Catalog, next: Catalog): Catalog {
  return {
    ...next,
    projects: sameItems(previous.projects, next.projects),
    monos: sameItems(previous.monos, next.monos),
    sessions: sameItems(previous.sessions, next.sessions),
  };
}
function sameItems<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const known = new Map(previous.map((item) => [item.id, item]));
  const merged = next.map((item) => {
    const before = known.get(item.id);
    return before && JSON.stringify(before) === JSON.stringify(item) ? before : item;
  });
  return merged.length === previous.length && merged.every((item, i) => item === previous[i])
    ? previous
    : merged;
}
export function useConnection() {
  const value = use(Context);
  if (!value) throw new Error("ConnectionProvider is missing");
  return value;
}
export type Conversation = {
  id: string;
  messages: Message[];
  /** Missing from desktops that predate turn-shaped transcripts. */
  turns?: Turn[];
  busy: boolean;
  /** What the agent waits on the user to answer; absent from an older desktop. */
  question?: QuestionPrompt | null;
  usageLimit?: UsageLimitState | null;
  /** What the agent waits on the user to allow; only a machine sends it. */
  approval?: ApprovalPrompt | null;
};

/**
 * Pairs with a machine's host: its one-use code buys this phone a credential,
 * kept in secure storage. The machine is then saved as a desktop is, keyed by
 * its host's ID, and reached at its Tailscale address.
 */
async function enrollMachine(invitation: MachineInvitation): Promise<Desktop> {
  const enrolled = await nativeCall<{
    token: string;
    deviceId: string;
    name: string;
    environmentId: string;
  }>({
    operation: "exchange",
    host: { url: invitation.url, token: "" },
    request: {
      version: 1,
      id: "enroll",
      method: "device.enroll",
      params: { code: invitation.code, name: deviceName() },
    },
  });
  if (enrolled.environmentId !== invitation.environmentId)
    throw new Error("That address answered as a different machine. Make a new code.");
  await SecureStore.setItemAsync(tokenKey(enrolled.environmentId), enrolled.token, SECURE);
  return {
    name: enrolled.name || invitation.name,
    fingerprint: `machine-${enrolled.environmentId}`,
    addresses: [],
    deviceId: enrolled.deviceId,
    machine: { url: invitation.url, environmentId: enrolled.environmentId },
  };
}

/** What the desktop lists this phone as, e.g. "Nick's iPhone". */
function deviceName() {
  return (
    Constants.deviceName?.trim() || (Platform.OS === "ios" ? "iPhone" : "Phone")
  );
}

/** What the phone is connected to, for its wording: "desktop" or "machine". */
export function useLinkNoun(): "desktop" | "machine" {
  return useConnection().pairing?.desktop.machine ? "machine" : "desktop";
}

/** Whether the desktop can show and change a Mono's profile, reset or delete
 *  it, and make new ones; where it can't, the phone leaves them out. */
export function useMonoTools() {
  return useConnection().catalog.monoTools === true;
}

/** Whether the desktop lets the phone edit a Mono's soul and memory. */
export function useMonoFiles() {
  return useConnection().catalog.monoFiles === true;
}
