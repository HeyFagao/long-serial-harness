import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { assertSerialModelSelection, serialReasoningEffortLabel } from "../src/serial-model-selection.js";
import { getSerialModelCatalog, registerSerialModelsRoute, resolveSerialModelSelection } from "../src/serial-models.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

function fixture() {
  let current: unknown = { provider: "relay-a", model: "gpt-writing", reasoningEffort: "low" };
  const providers = [{ id: "relay-a", name: "我的中转站" }, { id: "relay-b", name: "另一中转站" }];
  const models = [{ provider: "relay-a", id: "gpt-writing", name: "GPT 写作" }, { provider: "relay-a", id: "claude-writing", name: "Claude 写作" }, { provider: "relay-b", id: "gemini-writing", name: "Gemini 写作" }];
  const efforts = [{ id: "low", name: "Low" }, { id: "high", name: "High" }];
  const llm = {
    listProviders: vi.fn(() => providers),
    listModels: vi.fn(async (provider: string) => models.filter(model => model.provider === provider)),
    resolveModelInfo: vi.fn(async (provider: string, model: string) => ({ provider, id: model, name: model,
      ...(model === "gemini-writing" ? {} : { reasoning: { efforts: model === "claude-writing" ? [{ id: "adaptive-careful", name: "Adaptive Careful" }] : efforts, defaultEffort: model === "claude-writing" ? "adaptive-careful" : "low" } }) })),
    resolveCallConfig: vi.fn(async (selection: { provider: string; model: string; reasoningEffort?: string }) => ({ ...selection,
      ...(selection.reasoningEffort !== undefined || selection.model === "gemini-writing" ? {} : { reasoningEffort: selection.model === "claude-writing" ? "adaptive-careful" : "low" }) })),
    stream: vi.fn()
  };
  const fs = { resolve: async (path: string) => path };
  const sandboxPolicy = { resolve: () => ({ mode: "workspace-write" }) };
  const agent = { session: { header: { cwd: "/books" } }, model: { current: () => current }, ctx: { llm, get: (name: string) => name === "fs" ? fs : name === "sandboxPolicy" ? sandboxPolicy : undefined } };
  const realm = { sessionId: "book", cwd: "/books", agent, fs, sandboxPolicy, root: "/books" } as unknown as WorkspaceRealm;
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  const context = { effect: (work: () => unknown) => work(), typert: { lookups: { get: () => ({ resolve: async () => agent }) } },
    webServer: { register: (route: { handler: typeof handler }) => { handler = route.handler; } } } as unknown as Context;
  registerSerialModelsRoute(context);
  return { realm, llm, providers, models, setCurrent: (value: unknown) => { current = value; }, request: async (method = "GET", host = "127.0.0.1") => {
    const request = { url: "/oh-story/models?sessionId=book", method, headers: { host } } as IncomingMessage;
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await handler!(request, response as unknown as ServerResponse);
    return { status: response.writeHead.mock.calls[0]?.[0], text: String(response.end.mock.calls[0]?.[0]) };
  } };
}

describe("native writing model catalog and selection", () => {
  it("lists configured routes and their native effort metadata without generation or connection details", async () => {
    const f = fixture();
    f.setCurrent({ provider: "relay-a", model: "gpt-writing", reasoningEffort: "high", apiKey: "PRIVATE_VALUE" });
    expect(await getSerialModelCatalog(f.realm)).toEqual({ current: { provider: "relay-a", model: "gpt-writing", reasoningEffort: "high" }, models: [
      { provider: "relay-a", providerLabel: "我的中转站", model: "gpt-writing", label: "GPT 写作", efforts: [{ id: "low", label: "低" }, { id: "high", label: "高" }], defaultEffort: "low" },
      { provider: "relay-a", providerLabel: "我的中转站", model: "claude-writing", label: "Claude 写作", efforts: [{ id: "adaptive-careful", label: "Adaptive Careful" }], defaultEffort: "adaptive-careful" },
      { provider: "relay-b", providerLabel: "另一中转站", model: "gemini-writing", label: "Gemini 写作", efforts: [] }
    ] });
    expect(f.llm.stream).not.toHaveBeenCalled(); expect(f.llm.resolveCallConfig).not.toHaveBeenCalled();
    expect((await f.request()).text).not.toContain("PRIVATE_VALUE");
  });
  it("captures the current effective effort and returns a detached explicit route", async () => {
    const f = fixture(); f.setCurrent({ provider: "relay-a", model: "gpt-writing" });
    expect(await resolveSerialModelSelection(f.realm)).toEqual({ provider: "relay-a", model: "gpt-writing", reasoningEffort: "low" });
    const choice = { provider: "relay-a", model: "claude-writing", reasoningEffort: "adaptive-careful" };
    const captured = await resolveSerialModelSelection(f.realm, choice);
    choice.model = "changed-after-start";
    expect(captured).toEqual({ provider: "relay-a", model: "claude-writing", reasoningEffort: "adaptive-careful" });
    expect(f.llm.stream).not.toHaveBeenCalled();
  });
  it("does not carry a previous model's effort onto a model without effort control", async () => {
    const f = fixture();
    expect(await resolveSerialModelSelection(f.realm, { provider: "relay-b", model: "gemini-writing" })).toEqual({ provider: "relay-b", model: "gemini-writing" });
    await expect(resolveSerialModelSelection(f.realm, { provider: "relay-b", model: "gemini-writing", reasoningEffort: "high" })).rejects.toThrow("不支持这个思考强度");
    expect(f.llm.resolveCallConfig).toHaveBeenCalledTimes(1);
  });
  it("refuses removed providers, unadvertised models and unsupported efforts without fallback", async () => {
    const f = fixture();
    await expect(resolveSerialModelSelection(f.realm, { provider: "missing", model: "gpt-writing" })).rejects.toThrow("已不可用");
    await expect(resolveSerialModelSelection(f.realm, { provider: "relay-a", model: "unlisted" })).rejects.toThrow("已不在 Harness");
    await expect(resolveSerialModelSelection(f.realm, { provider: "relay-a", model: "gpt-writing", reasoningEffort: "extreme" })).rejects.toThrow("不支持这个思考强度");
    expect(f.llm.resolveCallConfig).not.toHaveBeenCalled(); expect(f.llm.stream).not.toHaveBeenCalled();
  });
  it("rejects malformed selection and unknown keys before native validation", async () => {
    const f = fixture();
    for (const value of [null, [], {}, { provider: "", model: "x" }, { provider: "relay-a", model: "gpt-writing", apiKey: "PRIVATE_VALUE" }, { provider: "relay-a", model: "gpt-writing", reasoningEffort: "high\n" }]) await expect(resolveSerialModelSelection(f.realm, value)).rejects.toThrow("模型选择无效");
    f.setCurrent(undefined);
    await expect(resolveSerialModelSelection(f.realm)).rejects.toThrow("请先选择写作模型");
    expect(f.llm.resolveCallConfig).not.toHaveBeenCalled();
  });
  it("keeps available model groups when another adapter fails and redacts adapter diagnostics", async () => {
    const f = fixture(); f.llm.listModels.mockImplementation(async provider => {
      if (provider === "relay-b") throw new Error("PRIVATE_VALUE https://private-endpoint");
      return f.models.filter(model => model.provider === provider);
    });
    const catalog = await getSerialModelCatalog(f.realm);
    expect(catalog.models).toHaveLength(2); expect(catalog.warnings).toHaveLength(1);
    expect(JSON.stringify(catalog)).not.toMatch(/PRIVATE_VALUE|private-endpoint/u);
    f.llm.resolveCallConfig.mockRejectedValue(new Error("PRIVATE_VALUE"));
    await expect(resolveSerialModelSelection(f.realm)).rejects.toThrow("暂时不可用");
    try { await resolveSerialModelSelection(f.realm); } catch (error) { expect(String(error)).not.toContain("PRIVATE_VALUE"); }
  });
  it("protects the GET-only catalog route and does not expose unexpected backend failures", async () => {
    const f = fixture();
    expect((await f.request()).status).toBe(200);
    expect((await f.request("POST")).status).toBe(405);
    expect((await f.request("GET", "untrusted.example")).status).toBe(403);
    f.llm.listProviders.mockImplementation(() => { throw new Error("PRIVATE_VALUE"); });
    const result = await f.request(); expect(result.status).toBe(503); expect(result.text).not.toContain("PRIVATE_VALUE");
  });
  it("preserves opaque adapter ids and only translates display labels", () => {
    expect(serialReasoningEffortLabel("high", "High")).toBe("高");
    expect(serialReasoningEffortLabel("adaptive-careful", "Adaptive Careful")).toBe("Adaptive Careful");
    expect(() => assertSerialModelSelection({ provider: "my-relay", model: "Claude/Gemini", reasoningEffort: "adaptive-careful" })).not.toThrow();
  });
});
