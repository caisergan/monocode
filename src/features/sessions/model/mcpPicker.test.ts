import { expect, it } from "vitest";
import {
  isConnectedMcpStatus,
  keepMcpPickerOrder,
  mcpContextText,
  mcpPickerKey,
  mcpPickerServers,
  mcpReconnectError,
  mcpTagParts,
  newMcpTag,
  taggedMcpServers,
  withLiveMcpServers,
} from "./mcpPicker";
import type { McpConnection } from "../../settings/model/mcp";

const servers: McpConnection[] = [
  {
    provider: "cursor",
    name: "other",
    scope: "user",
    configPath: "/cursor",
    transport: "stdio",
  },
  {
    provider: "claude",
    name: "needs-login",
    scope: "user",
    configPath: "/claude",
    transport: "http",
  },
  {
    provider: "claude",
    name: "docs",
    scope: "project",
    configPath: "/repo/.mcp.json",
    transport: "stdio",
  },
];

it("prioritizes usable servers while retaining authentication and other providers", () => {
  const ranked = mcpPickerServers(
    servers,
    "claude",
    new Map([["needs-login", "Needs authentication"]]),
    "",
  );
  expect(ranked.map((server) => [server.name, server.availability])).toEqual([
    ["docs", "available"],
    ["needs-login", "authentication"],
    ["other", "unavailable"],
  ]);
  expect(
    mcpPickerServers(servers, "claude", new Map(), "cursor").map(
      (server) => server.name,
    ),
  ).toEqual(["other"]);
});

it("adds only selected server names to outgoing context", () => {
  expect(mcpContextText([servers[2]], "Find the docs")).toContain(
    '"docs" (claude)',
  );
  expect(mcpContextText([], "Find the docs")).toBe("Find the docs");
});

it("makes disabled provider entries unselectable even when health says Connected", () => {
  for (const provider of ["claude", "codex", "opencode"] as const) {
    const [server] = mcpPickerServers(
      [{ ...servers[2], provider, enabled: false }],
      provider,
      new Map([["docs", "Connected"]]),
      "",
    );
    expect(server.availability).toBe("unavailable");
    expect(server.detail).toBe("Disabled in provider configuration");
  }
});

it("keeps MCP references inline and only uses tags still in the draft", () => {
  const docs = newMcpTag(servers[2], []);
  const anotherDocs = newMcpTag({ ...servers[2], provider: "cursor" }, [docs]);
  expect(docs.token).toBe("@mcp/docs");
  expect(anotherDocs.token).toBe("@mcp/cursor/docs");
  const text = `Ask ${docs.token} about this, then ${anotherDocs.token}.`;
  expect(
    mcpTagParts(text, [docs, anotherDocs]).filter((part) => part.tag),
  ).toHaveLength(2);
  expect(taggedMcpServers(text, [docs, anotherDocs])).toHaveLength(2);
  expect(taggedMcpServers(`Ask ${docs.token}2 about this`, [docs])).toEqual([]);
  expect(taggedMcpServers("Ask about this", [docs])).toEqual([]);
});

it("offers a reconnect only for Claude servers that failed or need sign-in", () => {
  const ranked = mcpPickerServers(
    [
      ...servers,
      {
        provider: "claude",
        name: "broken",
        scope: "user",
        configPath: "/claude",
        transport: "http",
      },
      {
        provider: "claude",
        name: "off",
        scope: "user",
        configPath: "/claude",
        transport: "http",
      },
    ],
    "claude",
    new Map([
      ["needs-login", "Needs authentication"],
      ["broken", "Failed to connect"],
      ["off", "Disabled"],
    ]),
    "",
  );
  expect(
    ranked.map((server) => [
      server.name,
      server.availability,
      server.reconnectable,
    ]),
  ).toEqual([
    ["docs", "available", false],
    ["needs-login", "authentication", true],
    // A server Claude can reconnect comes before another provider's.
    ["broken", "unavailable", true],
    ["off", "unavailable", false],
    ["other", "unavailable", false],
  ]);
  expect(ranked.find((server) => server.name === "off")?.detail).toBe(
    "Disabled in provider configuration",
  );
  // Another harness cannot reconnect Claude's servers.
  expect(
    mcpPickerServers(
      servers,
      "codex",
      new Map([["needs-login", "Needs authentication"]]),
      "",
    ).some((server) => server.reconnectable),
  ).toBe(false);
});

it("takes Claude's live statuses and lists servers no config file holds", () => {
  const merged = withLiveMcpServers(
    [
      ...servers,
      // A row an earlier health check added for a server it could not place.
      {
        provider: "claude",
        name: "linear",
        scope: "local",
        configPath: "",
        transport: "",
      },
    ],
    [
      { name: "docs", status: "connected", scope: "project" },
      { name: "needs-login", status: "needs-auth", scope: "user" },
      { name: "linear", status: "failed", scope: "user" },
      { name: "claude.ai Gmail", status: "pending", scope: "claudeai" },
      { name: "plugin:tools:db", status: "disabled", scope: "dynamic" },
    ],
  );
  expect(Object.fromEntries(merged.status)).toEqual({
    docs: "Connected",
    "needs-login": "Needs authentication",
    linear: "Failed to connect",
    "claude.ai Gmail": "Connecting",
    "plugin:tools:db": "Disabled",
  });
  expect(
    merged.connections.map((server) => [
      server.name,
      server.scope,
      server.scopeLabel,
    ]),
  ).toEqual([
    ["other", "user", undefined],
    ["needs-login", "user", undefined],
    ["docs", "project", undefined],
    ["linear", "user", "user"],
    ["claude.ai Gmail", "user", "claude.ai"],
    ["plugin:tools:db", "user", "dynamic"],
  ]);
  // A configured server the running Claude has not loaded cannot be used yet.
  const late = withLiveMcpServers(servers, [
    { name: "docs", status: "connected", scope: "project" },
  ]);
  expect(late.status.get("needs-login")).toBe("Not loaded");
  const lateRow = mcpPickerServers(
    late.connections,
    "claude",
    late.status,
    "",
  ).find((server) => server.name === "needs-login");
  expect([
    lateRow?.availability,
    lateRow?.detail,
    lateRow?.reconnectable,
  ]).toEqual(["unavailable", "Loads when the session restarts", false]);
  const ranked = mcpPickerServers(
    merged.connections,
    "claude",
    merged.status,
    "claude.ai",
  );
  expect(ranked.map((server) => [server.name, server.availability])).toEqual([
    ["claude.ai Gmail", "available"],
  ]);
});

it("keeps rows in place once a reconnect was asked for", () => {
  const before = mcpPickerServers(
    servers,
    "claude",
    new Map([["needs-login", "Needs authentication"]]),
    "",
  );
  const after = mcpPickerServers(servers, "claude", new Map(), "");
  expect(after.map((server) => server.name)).toEqual([
    "docs",
    "needs-login",
    "other",
  ]);
  const reordered = [after[1], after[0], after[2]];
  expect(
    keepMcpPickerOrder(reordered, before.map(mcpPickerKey)).map(
      (server) => server.name,
    ),
  ).toEqual(before.map((server) => server.name));
  // A row that was not listed before goes last.
  expect(
    keepMcpPickerOrder(after, [mcpPickerKey(after[2])]).map(
      (server) => server.name,
    ),
  ).toEqual(["other", "docs", "needs-login"]);
});

it("reads health text for reconnect outcomes", () => {
  expect(isConnectedMcpStatus("✓ Connected")).toBe(true);
  expect(isConnectedMcpStatus("Disconnected")).toBe(false);
  expect(isConnectedMcpStatus("✗ Failed to connect")).toBe(false);
  expect(isConnectedMcpStatus(undefined)).toBe(false);
  expect(mcpReconnectError("Needs authentication")).toContain("Sign in");
  expect(mcpReconnectError("✗ Failed to connect")).toBe("✗ Failed to connect");
  expect(mcpReconnectError(undefined)).toBe(
    "Claude Code did not list this server",
  );
});
