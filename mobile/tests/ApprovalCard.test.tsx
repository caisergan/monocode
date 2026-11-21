import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useConversation, useWorkspace, WorkspaceProvider } from "@/features/workspace/WorkspaceProvider";
import { ApprovalCard } from "@/features/sessions/ApprovalCard";

const workspace = vi.hoisted(() => ({
  alert: vi.fn(),
  nativeTranscript: false,
  connected: true,
  pairing: { desktop: { fingerprint: "machine-box", machine: { url: "https://box.ts.net", environmentId: "box" } } },
  command: vi.fn(),
  nextUpdates: vi.fn(),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    View,
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <button disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
    Alert: { alert: workspace.alert },
    StyleSheet: { absoluteFill: {}, hairlineWidth: 1 },
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <section>{children}</section> },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock("@/ui/LiquidView", () => ({ LiquidView: () => null }));
vi.mock("@/ui/Icon", () => ({ Icon: () => null }));
vi.mock("@/ui/theme", () => ({
  radii: { card: 22, row: 12, pill: 999 },
  themedStyles: () => () => new Proxy({}, { get: () => ({}) }),
  useColors: () => new Proxy({}, { get: () => "#000" }),
}));
vi.mock("@/features/connection/ConnectionProvider", () => ({
  useConnection: () => ({
    pairing: workspace.pairing,
    connected: workspace.connected,
    catalog: { projects: [], monos: [], sessions: [] },
    selection: { projectIds: [], monoIds: [] },
    command: workspace.command,
    refresh: async () => {},
  }),
}));
vi.mock("@/features/connection/nativeLink", () => ({
  get hasNativeTranscript() { return workspace.nativeTranscript; },
  makeCommandId: () => "command",
  openWatch: async () => 1,
  nextUpdates: workspace.nextUpdates,
  closeWatch: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("@/features/sessions/attachments", () => ({ toWire: () => [] }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const approval = {
  requestId: 7,
  title: "Run npm run deploy",
  detail: "npm run deploy -- --prod",
  kind: "shell",
};

describe("approval card", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((element) => element.textContent === label);

  beforeEach(() => {
    vi.clearAllMocks();
    workspace.nativeTranscript = false;
    workspace.connected = true;
    vi.stubGlobal("__DEV__", false);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("shows the machine's request and allows it, then stays gone (native: %s)", async (native) => {
    workspace.nativeTranscript = native;
    workspace.command.mockResolvedValue({ sessionId: "session" });
    let deliver!: (frames: object[]) => void;
    workspace.nextUpdates.mockImplementation(() => new Promise<object[]>((resolve) => { deliver = resolve; }));
    let provider!: ReturnType<typeof useWorkspace>;
    function ConversationCard() {
      provider = useWorkspace();
      const { approval: shown } = useConversation("session");
      return shown ? <ApprovalCard conversationId="session" approval={shown} /> : null;
    }
    await act(async () => root.render(<WorkspaceProvider><ConversationCard /></WorkspaceProvider>));
    const status = { busy: true, error: null, hasTurns: true, userCount: 1, pendingId: null };
    await act(async () => {
      if (native) provider.nativeTranscriptStatus("session", { ...status, approval });
      else deliver([{ busy: true, approval }]);
    });
    expect(host.textContent).toContain("Needs your approval");
    expect(host.textContent).toContain("Run npm run deploy");
    expect(host.textContent).toContain("npm run deploy -- --prod");

    await act(async () => button("Allow")!.click());
    expect(workspace.command).toHaveBeenCalledWith(
      "session.approve",
      { conversationId: "session", requestId: 7, decision: "allow" },
      "command",
    );
    expect(host.textContent).not.toContain("Run npm run deploy");
    // A frame sent before the machine took the answer doesn't bring it back.
    await act(async () => {
      if (native) provider.nativeTranscriptStatus("session", { ...status, approval });
      else {
        workspace.nextUpdates.mockImplementation(() => new Promise<object[]>((resolve) => { deliver = resolve; }));
        deliver([{ approval }]);
      }
    });
    expect(host.textContent).not.toContain("Run npm run deploy");
  });

  it("keeps the card and says why when the machine refuses", async () => {
    workspace.command.mockRejectedValue(new Error("This request was already answered"));
    function Card() {
      return <ApprovalCard conversationId="session" approval={approval} />;
    }
    await act(async () => root.render(<WorkspaceProvider><Card /></WorkspaceProvider>));
    await act(async () => button("Deny")!.click());
    expect(workspace.alert).toHaveBeenCalledWith("Not denied", "This request was already answered");
    expect(button("Deny")).toBeTruthy();
  });

  it("waits for the machine to answer while it can't be reached", async () => {
    workspace.connected = false;
    await act(async () =>
      root.render(
        <WorkspaceProvider>
          <ApprovalCard conversationId="session" approval={approval} />
        </WorkspaceProvider>,
      ),
    );
    expect(host.textContent).toContain("Reconnect to answer");
    expect(button("Allow")!.disabled).toBe(true);
  });
});
