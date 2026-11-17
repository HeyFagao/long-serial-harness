import type { Context } from "@deepseek-ai/cordis";
import type { AgentOptions, CreateAgentOptions, ModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertLibraryOwnerContext, captureLibraryOwnerContext, ensureLibraryBookRealm } from "../src/serial-library-native.js";
import { workspaceRealmForSession, type WorkspaceRealm } from "../src/workspace-route.js";

vi.mock("@deepseek-ai/dsh-agent", async importOriginal => ({
  ...await importOriginal<object>(), installModelSelection: vi.fn()
}));
vi.mock("../src/workspace-route.js", async importOriginal => ({
  ...await importOriginal<object>(), workspaceRealmForSession: vi.fn()
}));

function fixture() {
  const selected: ModelSelection = { provider: "relay-chosen", model: "chosen-model" };
  const parentState = { selection: selected as ModelSelection | undefined, mode: "workspace-write", approval: "ask", preset: "creator" };
  const appended: { type: string; data: unknown }[] = [];
  const state = { ...parentState };
  function agent(cwd: string, values: typeof parentState, options: AgentOptions = {}) {
    const session = { header: { cwd }, append: (type: string, data: { mode?: string; policy?: string }) => {
      appended.push({ type, data });
      if (data.mode !== undefined) values.mode = data.mode;
      if (data.policy !== undefined) values.approval = data.policy;
    } };
    return { session, options,
      model: { current: () => values.selection, select: vi.fn((selection: ModelSelection) => { values.selection = selection; }) },
      ctx: {
        llm: { resolveCallConfig: vi.fn(async () => ({})) },
        get: (name: string): unknown => ({
          agentPresets: { composedPreset: () => values.preset, composeFrom: () => parentState.preset },
          approval: { config: { policy: "ask" }, overrideOf: () => values.approval },
          permissionPresets: { current: () => values.mode, set: vi.fn() }
        })[name]
      }
    };
  }
  const fs = {
    resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
    contains: (parent: { targetKey: string }, child: { targetKey: string }) => child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`),
    stat: vi.fn(async () => ({ type: "directory" })), processPath: (target: { targetKey: string }) => target.targetKey,
    processPathFromHostPath: (path: string): string | undefined => path
  };
  const parent = agent("/library", parentState, { provider: "wrong-default", model: "wrong-default" });
  const child = agent("/library/book", state);
  const realm = (item: typeof parent, id: string, values: typeof parentState) => ({
    sessionId: id, agent: item, cwd: item.session.header.cwd, root: { targetKey: item.session.header.cwd }, fs,
    sandboxPolicy: { resolve: () => ({ mode: values.mode }) }
  } as unknown as WorkspaceRealm);
  const library = realm(parent, "library-owner", parentState);
  const book = realm(child, "book-owner", state);
  const dispose = vi.fn(async () => {});
  const workspace = { attachSession: vi.fn(async () => {}) };
  const registry = { resolveByPath: vi.fn(async () => workspace as typeof workspace | undefined) };
  const create = vi.fn(async (options: CreateAgentOptions) => {
    child.options = options.agentOptions ?? {};
    const setup = await options.setup?.(child.ctx as unknown as Context, child as unknown as WorkspaceRealm["agent"]);
    setup?.commit();
    return { agent: child, dispose };
  });
  const context = { get: (name: string) => name === "workspaceRegistry" ? registry : undefined,
    agents: { get: vi.fn(() => undefined), create },
    sessions: { flush: vi.fn(async () => {}) },
    sessionController: { projections: vi.fn(async () => null) }, effect: vi.fn()
  };
  vi.mocked(workspaceRealmForSession).mockResolvedValue(book);
  return { context: context as unknown as Context, raw: context, library, book, parent, parentState, child, state, create, dispose, fs, appended, registry, workspace };
}

describe("library book native owners", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("captures the pending local model rather than another global/default route", () => {
    const f = fixture();
    expect(captureLibraryOwnerContext(f.library)).toMatchObject({
      modelSelection: { provider: "relay-chosen", model: "chosen-model" }, presetId: "creator", sandboxMode: "workspace-write", approvalPolicy: "ask"
    });
  });

  it("creates a fresh ordinary owner with pinned model, exact preset, and durable access before publication", async () => {
    const f = fixture(); const snapshot = captureLibraryOwnerContext(f.library);
    await ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot);
    expect(f.create).toHaveBeenCalledOnce();
    const options = f.create.mock.calls[0]![0];
    expect(options.meta).toEqual({ cwd: "/library/book", agentPreset: "creator" });
    expect(options.agentOptions).toEqual({ provider: "relay-chosen", model: "chosen-model" });
    expect(f.child.model.select).toHaveBeenCalledWith(snapshot.modelSelection);
    expect(f.appended).toEqual([
      { type: "sandbox/mode", data: { mode: "workspace-write" } },
      { type: "approval/policy", data: { policy: "ask" } }
    ]);
    expect(f.raw.sessions.flush).toHaveBeenCalledOnce();
    expect(f.workspace.attachSession).toHaveBeenCalledWith("book-owner");
  });

  it("uses a batch-specific route and effort without changing the library's selected model", async () => {
    const f = fixture();
    f.parentState.selection = { provider: "parent-relay", model: "parent-model", reasoningEffort: ReasoningEffortId("high") };
    const selection = { provider: "claude-relay", model: "claude-writing", reasoningEffort: "low" };
    const snapshot = captureLibraryOwnerContext(f.library, selection);
    expect(snapshot.modelSelection).toEqual(selection);
    expect(snapshot.modelSelection).not.toBe(selection);
    await ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot);
    expect(f.create.mock.calls[0]![0].agentOptions).toEqual(selection);
    expect(f.parent.model.select).not.toHaveBeenCalled();
    expect(f.parentState.selection).toEqual({ provider: "parent-relay", model: "parent-model", reasoningEffort: "high" });
    expect(f.parent.ctx.llm.resolveCallConfig).toHaveBeenCalledWith(selection);
  });

  it("creates a pending owner from its saved route after the library switches models", async () => {
    const f = fixture();
    const snapshot = captureLibraryOwnerContext(f.library, { provider: "gpt-relay", model: "gpt-writing", reasoningEffort: "high" });
    f.parentState.selection = { provider: "gemini-relay", model: "gemini-writing", reasoningEffort: ReasoningEffortId("low") };
    await ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot);
    expect(f.create.mock.calls[0]![0].agentOptions).toEqual(snapshot.modelSelection);
    expect(f.child.model.current()).toEqual(snapshot.modelSelection);
    expect(f.parentState.selection).toEqual({ provider: "gemini-relay", model: "gemini-writing", reasoningEffort: "low" });
  });

  it("does not carry the parent's effort into an explicitly chosen model's automatic effort", async () => {
    const f = fixture();
    f.parentState.selection = { provider: "parent-relay", model: "parent-model", reasoningEffort: ReasoningEffortId("high") };
    const snapshot = captureLibraryOwnerContext(f.library, { provider: "gemini-relay", model: "gemini-writing" });
    await ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot);
    expect(f.create.mock.calls[0]![0].agentOptions).toEqual({ provider: "gemini-relay", model: "gemini-writing" });
    expect(snapshot.modelSelection).not.toHaveProperty("reasoningEffort");
  });

  it("validates the saved route before creating an owner and does not switch to the library's fallback", async () => {
    const f = fixture(); const snapshot = captureLibraryOwnerContext(f.library);
    f.parent.ctx.llm.resolveCallConfig.mockRejectedValue(new Error("模型不可用"));
    await expect(ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot)).rejects.toThrow("模型不可用");
    expect(f.create).not.toHaveBeenCalled(); expect(f.parent.model.select).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous calls for the reserved owner", async () => {
    const f = fixture(); const snapshot = captureLibraryOwnerContext(f.library);
    await Promise.all([1, 2].map(() => ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot)));
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("rejects a foreign path and the library root itself without creating a session", async () => {
    const f = fixture(); const snapshot = captureLibraryOwnerContext(f.library);
    for (const path of ["/other/book", "/library"]) {
      await expect(ensureLibraryBookRealm(f.context, f.library, path, "book-owner", snapshot)).rejects.toThrow("独立子目录");
    }
    expect(f.create).not.toHaveBeenCalled();
  });

  it("stops when the user has reduced the library's access", async () => {
    const f = fixture(); const snapshot = captureLibraryOwnerContext(f.library);
    f.parentState.mode = "read-only";
    await expect(ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot)).rejects.toThrow("更严格");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing owner whose model has changed", async () => {
    const f = fixture(); const snapshot = captureLibraryOwnerContext(f.library);
    f.raw.sessionController.projections.mockResolvedValue({} as never);
    f.state.selection = { provider: "another-relay", model: "another-model" };
    await expect(ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot)).rejects.toThrow("未覆盖原会话");
    expect(f.child.model.select).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });

  it("does not infer a default when no model has been chosen", () => {
    const f = fixture(); f.parentState.selection = undefined;
    expect(() => captureLibraryOwnerContext(f.library)).toThrow("不会自动改用默认线路");
  });

  it("requires prior native workspace registration and never creates one behind the Gateway", async () => {
    const f = fixture(); const snapshot = captureLibraryOwnerContext(f.library);
    f.registry.resolveByPath.mockResolvedValue(undefined);
    await expect(ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot)).rejects.toThrow("尚未登记为 Harness 工作区");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("idempotently attaches an existing matching owner to its registered book", async () => {
    const f = fixture(); const snapshot = captureLibraryOwnerContext(f.library);
    f.raw.sessionController.projections.mockResolvedValue({} as never);
    await ensureLibraryBookRealm(f.context, f.library, "/library/book", "book-owner", snapshot);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.workspace.attachSession).toHaveBeenCalledWith("book-owner");
  });

  it("rejects malformed persisted routing and permission snapshots", () => {
    const f = fixture(); const valid = captureLibraryOwnerContext(f.library);
    const invalid = [null, {}, { ...valid, modelSelection: { provider: "", model: "x" } },
      { ...valid, modelSelection: { ...valid.modelSelection, reasoningEffort: {} } },
      { ...valid, sandboxMode: "unrestricted" }, { ...valid, approvalPolicy: "always" }, { ...valid, sandboxMode: ["workspace-write"] },
      { ...valid, presetId: 42 }, { ...valid, permissionPreset: {} },
      { ...valid, maxTokens: Number.POSITIVE_INFINITY }, { ...valid, maxTokens: 0 }, { ...valid, maxTokens: 2.5 }];
    for (const value of invalid) expect(() => assertLibraryOwnerContext(value)).toThrow("模型或权限快照无效");
  });
});
