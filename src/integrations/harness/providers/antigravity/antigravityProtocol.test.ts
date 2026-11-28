import { describe, expect, it } from "vitest";
import { harnessSupportsAttachments, RUNTIME_MODES } from "../../../../features/sessions/model/session";
import { ATTACHMENT_ONLY_PROMPT } from "../../../../features/sessions/model/attachments";
import * as antigravity from "./antigravityProtocol";

const providers = [
  { id: "antigravity", protocol: antigravity, mode: antigravity.antigravityModeId,
    blocks: antigravity.antigravityPromptBlocks,
    modes: ["default", "accept-edits", "auto", "auto"], plan: "plan" },
] as const;

describe.each(providers)("$id ACP protocol", ({ id, protocol, mode, blocks, modes, plan }) => {
  it("maps every runtime mode and overrides full access for planning", () => {
    expect(RUNTIME_MODES.map((runtimeMode) => mode(runtimeMode))).toEqual(modes);
    for (const runtimeMode of RUNTIME_MODES) expect(mode(runtimeMode, true)).toBe(plan);
  });

  it("delivers image-only prompts and leaves attachments enabled", () => {
    const image = {
      id: "image", name: "image.png", kind: "image", mimeType: "image/png",
      size: 4, data: "aGV5",
    } as const;
    expect(harnessSupportsAttachments(id)).toBe(true);
    expect(blocks("", [image])).toEqual([
      { type: "text", text: ATTACHMENT_ONLY_PROMPT },
      { type: "image", mimeType: "image/png", data: "aGV5" },
    ]);
    expect(blocks(" hi ")).toEqual([{ type: "text", text: "hi" }]);
    expect(blocks("  ")).toEqual([]);
  });

  it("extracts session IDs and rejects malformed IDs", () => {
    for (const key of ["sessionId", "session_id", "id"]) {
      expect(protocol.sessionIdFromResult({ [key]: " S1 " })).toBe("S1");
    }
    for (const raw of [null, {}, { sessionId: " " }, { sessionId: 42 }]) {
      expect(protocol.sessionIdFromResult(raw)).toBeUndefined();
    }
  });

  it("resolves config IDs by category without selecting the provider", () => {
    const options = protocol.readConfigOptions([
      null, {}, { id: "provider", category: "model" },
      { id: "model_picker", category: "model", currentValue: "gemini-m1" },
      { id: "thinking", category: "thought_level", currentValue: "high" },
    ]);
    expect(options).toHaveLength(3);
    expect(protocol.extractModelConfigId(options)).toBe("model_picker");
    expect(protocol.extractModelConfigId([])).toBe("model");
    expect(protocol.resolveSettingConfigId(options, "effort")).toBe("thinking");
    expect(protocol.resolveSettingConfigId(options, "reasoning")).toBe("thinking");
    expect(protocol.resolveSettingConfigId(options, "THINKING")).toBe("thinking");
    expect(protocol.resolveSettingConfigId(options, "missing")).toBeUndefined();
  });

  it("discovers live models and thinking levels, including grouped choices", () => {
    const models = protocol.modelsFromSessionNew({ configOptions: [
      { id: "model", category: "model", options: [
        { group: "provider", options: [
          { value: "gemini-m1", name: "Model One" }, { value: "gemini-m2", name: "Model Two" },
        ] },
      ] },
      { id: "thinking", category: "thought_level", currentValue: "high", options: [
        { value: "low", name: "Low" }, { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ] },
    ] });
    expect(models.map((model) => model.id)).toEqual([`${id}:gemini-m1`, `${id}:gemini-m2`]);
    expect(models[0]).toMatchObject({ harness: id, name: "Model One", nativeId: "gemini-m1",
      settings: [{ id: "effort", value: "high", options: [
        { value: "low", label: "Low" }, { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ] }],
    });
    expect(protocol.modelsFromSessionNew(null)).toEqual([]);
  });

  it("falls back to top-level ACP models without inventing reasoning controls", () => {
    expect(protocol.modelsFromSessionNew({ models: { availableModels: [
      { modelId: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
    ] } })).toEqual([{
      id: `${id}:gemini-pro-agent`, harness: id, nativeId: "gemini-pro-agent",
      name: "Gemini 3.1 Pro (High)",
    }]);
  });

  it("uses opaque permission IDs by semantic kind and never fabricates an ID", () => {
    const request = protocol.permissionRequestFromAcp({
      toolCall: { toolCallId: "t1", title: "Write file", kind: "edit" },
      options: [
        { optionId: "yes-7", kind: "allow_once" },
        { optionId: "no-9", kind: "reject_once" },
      ],
    });
    expect(request).toMatchObject({ callId: "t1", kind: "edit" });
    expect(protocol.permissionOptionId("allow", request.optionIds, request.optionKinds)).toBe("yes-7");
    expect(protocol.permissionOptionId("deny", request.optionIds, request.optionKinds)).toBe("no-9");
    expect(protocol.permissionOptionId("deny", ["allow_once"])).toBeNull();
    expect(protocol.permissionOptionId("allow", [])).toBeNull();
    expect(protocol.autoPermissionOption("supervised", "edit", request.optionIds, request.optionKinds)).toBeNull();
    expect(protocol.autoPermissionOption("auto", "execute", request.optionIds, request.optionKinds)).toBeNull();
    expect(protocol.autoPermissionOption("auto-accept-edits", "execute", request.optionIds, request.optionKinds)).toBeNull();
    expect(protocol.autoPermissionOption("auto-accept-edits", "edit", request.optionIds, request.optionKinds)).toBe("yes-7");
    expect(protocol.autoPermissionOption("full-access", "execute", request.optionIds, request.optionKinds)).toBe("yes-7");
  });

  it("maps text, reasoning, tools and plans without fx-specific result decoding", () => {
    const parse = (update: unknown) => protocol.eventsFromAcpUpdate({ update });
    expect(parse({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }))
      .toEqual([{ type: "message.delta", text: "hi" }]);
    expect(parse({ sessionUpdate: "agent_thought_chunk", content: { text: "think" } }))
      .toEqual([{ type: "reasoning.delta", text: "think" }]);
    expect(parse({ sessionUpdate: "tool_call", toolCallId: "t", title: "Read file", kind: "read", status: "completed" }))
      .toMatchObject([{ type: "tool.updated", callId: "t", kind: "read", status: "completed" }]);
    expect(parse({ sessionUpdate: "plan", entries: [{ content: "Check code", status: "pending" }] }))
      .toMatchObject([{ type: "tasks.updated", items: [{ text: "Check code" }] }]);
    expect(parse({ sessionUpdate: "available_commands_update", availableCommands: [] })).toEqual([]);
  });
});

describe("antigravity model rule", () => {
  it("keeps third-party models out of the catalog and the turn", () => {
    const models = antigravity.modelsFromSessionNew({
      configOptions: [{ id: "model", category: "model", currentValue: "claude-opus-5-5", options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B" },
      ] }],
    });
    expect(models.map((model) => model.nativeId)).toEqual(["gemini-4-neon"]);
    const option = antigravity.readConfigOptions([{ id: "model", currentValue: "claude-opus-5-5",
      options: [{ value: "claude-opus-5-5" }, { value: "gemini-4-carbon" }] }])[0];
    expect(antigravity.antigravityModelChoice("gemini-4-neon", option)).toBe("gemini-4-neon");
    expect(antigravity.antigravityModelChoice("claude-opus-5-5", option)).toBe("gemini-4-carbon");
    expect(antigravity.antigravityModelChoice("", { id: "model", currentValue: "gemini-4-argon" }))
      .toBe("gemini-4-argon");
    expect(antigravity.antigravityModelChoice("claude-opus-5-5", { id: "model" })).toBeUndefined();
  });

  it("narrows per-model effort levels from availableModels and strips them on orchestrators", () => {
    const models = antigravity.modelsFromSessionNew({
      models: {
        currentModelId: "gemini-4-neon-high",
        availableModels: [
          { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
          { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
          { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
          { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
          { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
          { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
          { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
          { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
        ],
      },
      configOptions: [
        {
          id: "model",
          category: "model",
          currentValue: "gemini-4-neon",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
            { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
          ],
        },
        {
          id: "thought_level",
          category: "thought_level",
          currentValue: "xhigh",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra" },
          ],
        },
      ],
    });
    expect(models.map((m) => m.nativeId)).toEqual([
      "gemini-4-neon",
      "gemini-4-carbon",
      "gemini-pro-orchestrator-neon",
    ]);
    expect(models[0].settings?.[0]).toEqual({
      id: "effort",
      label: "Effort",
      kind: "select",
      value: "xhigh",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
    });
    expect(models[1].settings?.[0]).toEqual({
      id: "effort",
      label: "Effort",
      kind: "select",
      value: "high",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    });
    expect(models[2].settings).toBeUndefined();
    expect(antigravity.nearestAntigravityEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(antigravity.nearestAntigravityEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
  });
});
