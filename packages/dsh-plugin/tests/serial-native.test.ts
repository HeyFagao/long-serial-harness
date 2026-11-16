import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { describe, expect, it, vi } from "vitest";
import { childExecution, createNativeSerialController, finalChapterText, parentHasNewInput, plainAssistantText } from "../src/serial-native.js";
import type { SerialActive } from "../src/serial-runtime.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

function events(values: unknown[]): SessionEvent[] { return values.map((event, seq) => ({ seq, ...(event as object) })) as SessionEvent[]; }
const initial = { id: "initial", source: { kind: "user" }, content: [{ type: "text", text: "chapter" }] };

describe("fresh native chapter execution", () => {
  it("correlates the initial spawn input and ignores injected tool context", () => {
    const result = childExecution(events([
      { type: "agent/inbox/spliced", data: { inserted: [initial] } },
      { type: "turn/start", data: { turn: 0 } },
      { type: "user/message", data: initial },
      { type: "user/message", data: { id: "context", source: { kind: "injected" }, content: [] } },
      { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } }
    ]));
    expect(result).toEqual({ initialMessageId: "initial", foreignInput: false, lastTurnReason: "completed" });
  });

  it("does not confuse a later human repair with the initial aborted attempt", () => {
    const result = childExecution(events([
      { type: "turn/start", data: { turn: 0 } }, { type: "user/message", data: initial },
      { type: "turn/end", data: { turn: 0, reason: { kind: "aborted", reason: { kind: "user" } } } },
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { ...initial, id: "human-repair", source: { kind: "user", rpcId: "human" } } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
    ]));
    expect(result.foreignInput).toBe(true); expect(result.lastTurnReason).toBe("aborted");
  });

  it("detects parent human input at durable insertion, before a parent model turn", () => {
    expect(parentHasNewInput(events([{ type: "agent/inbox/spliced", data: { inserted: [initial] } }]), { queue: [] })).toBe(true);
    expect(parentHasNewInput(events([{ type: "subagent/catalog", data: {} }]), { queue: [] })).toBe(false);
  });

  function fixture() {
    let settled!: (value: { stopReason: "completed" | "aborted"; output: ContentBlock[] }) => void;
    const result = new Promise<{ stopReason: "completed" | "aborted"; output: ContentBlock[] }>(resolve => { settled = resolve; });
    let parentEvent: ((session: { id: string }, event: SessionEvent) => void) | undefined;
    let created: ((payload: unknown) => void) | undefined;
    const dispose = vi.fn(async () => { settled({ stopReason: "aborted", output: [] }); });
    const activation = { childId: "child-1", result, dispose };
    const restrictTools = vi.fn();
    const startActivation = vi.fn(async (spec: unknown) => {
      expect(spec).toBeTypeOf("object");
      created?.({ agent: { id: "child-1", ctx: { get: () => ({ definitions: () => [], restrict: restrictTools }) } } });
      return activation;
    });
    const runtime = { startActivation, interrupt: vi.fn() };
    const parent = { id: "owner", session: { header: {} }, model: { current: () => ({ provider: "selected-relay", model: "selected-model", reasoningEffort: "medium" }) }, options: { maxTokens: 16000 }, ctx: { get: (key: string) => key === "subagents" ? runtime : { get: () => ({}) }, on: (_: string, callback: (payload: unknown) => void) => { created = callback; return () => {}; } } };
    const context = {
      effect: vi.fn(), on: (_: string, callback: typeof parentEvent) => { parentEvent = callback; return () => { parentEvent = undefined; }; },
      sessions: { flush: vi.fn(async () => true) },
      sessionController: {
        state: vi.fn(async () => ({ running: false, pendingInput: [], queue: [], cursor: -1 })),
        projections: vi.fn(async () => null),
        events: vi.fn(async () => ({ records: [], hasMore: false })),
        wait: vi.fn(async (): Promise<{ reason: "idle" | "timeout"; state: { running: boolean; pendingInput: never[]; queue: never[] } }> => ({ reason: "idle", state: { running: false, pendingInput: [], queue: [] } })),
        prompt: vi.fn(), cancel: vi.fn()
      }
    };
    const realm = { sessionId: "owner", agent: parent, cwd: "/book" } as unknown as WorkspaceRealm;
    const controller = createNativeSerialController(context as unknown as Context, async () => realm);
    const active: SerialActive = { chapter: 1, sessionId: "child-1", requestId: "request-1", attempt: 1, dispatched: false, baselineSeq: -1 };
    return { context, realm, controller, active, runtime, startActivation, dispose, settled, restrictTools,
      human: () => { parentEvent?.({ id: "owner" }, events([{ type: "agent/inbox/spliced", data: { inserted: [initial] } }])[0]!); } };
  }

  it("starts spawn with a reserved independent child and caller-only delivery", async () => {
    const f = fixture(); await f.controller.dispatch(f.active, "only chapter one");
    const spec = f.startActivation.mock.calls[0]![0] as Record<string, unknown>;
    expect(spec).toMatchObject({ provider: "spawn", childId: "child-1", parent: f.realm.agent, delivery: "caller", prompt: [{ type: "text", text: "only chapter one" }] });
    expect(spec).toMatchObject({ agentOptions: { provider: "selected-relay", model: "selected-model", reasoningEffort: "medium", maxTokens: 16000 }, request: { agentOptions: { provider: "selected-relay", model: "selected-model" } } });
    expect(f.restrictTools).toHaveBeenCalledWith({ allow: [] });
    expect(spec).not.toHaveProperty("history"); expect(spec).not.toHaveProperty("seed");
    expect(f.context.sessionController.prompt).not.toHaveBeenCalled();
    await f.controller.dispatch(f.active, "repeat transport"); expect(f.startActivation).toHaveBeenCalledTimes(1);
    await f.controller.cancel(f.active); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.context.sessionController.cancel).not.toHaveBeenCalled();
  });

  it("cancels the published child when the parent receives new human work", async () => {
    const f = fixture(); await f.controller.dispatch(f.active, "chapter one"); f.human();
    await Promise.resolve(); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.context.sessionController.cancel).not.toHaveBeenCalled();
  });

  it("rejects a shared owner identity before touching the model", async () => {
    const f = fixture(); await expect(f.controller.dispatch({ ...f.active, sessionId: "owner" }, "chapter")).rejects.toThrow("独立原生会话");
    expect(f.startActivation).not.toHaveBeenCalled();
  });

  it("does not fall back to a default route when the parent has no selected model", async () => {
    const f = fixture(); vi.spyOn(f.realm.agent.model, "current").mockReturnValue(undefined);
    await expect(f.controller.dispatch(f.active, "chapter")).rejects.toThrow("未调用默认线路");
    expect(f.startActivation).not.toHaveBeenCalled();
  });

  it("exposes final text only after successful completion and never folds reasoning or tool results", async () => {
    const f = fixture(); await f.controller.dispatch(f.active, "chapter one");
    f.settled({ stopReason: "completed", output: [{ type: "text", text: "正文\n【状态变更】" }] });
    await Promise.resolve();
    expect(await f.controller.state(f.active)).toMatchObject({ lastTurnReason: "completed", finalText: "正文\n【状态变更】" });
    const blocks = [{ type: "reasoning", text: "private reasoning" }, { type: "text", text: "正文" }] as unknown as ContentBlock[];
    expect(plainAssistantText(blocks)).toBe("正文");
    expect(finalChapterText(events([
      { type: "assistant/attempt", data: { stream: [{ text: "partial stream" }] } },
      { type: "assistant/message", data: { message: { content: blocks } } },
      { type: "tool/result", data: { content: [{ type: "text", text: "tool result" }] } },
      { type: "assistant/message", data: { message: { content: [] } } }
    ]))).toBe("正文");
    expect(finalChapterText(events([{ type: "assistant/attempt", data: { stream: [{ text: "incomplete" }] } }]))).toBeUndefined();
  });

  it("never exposes an aborted output for manuscript settlement", async () => {
    const f = fixture(); await f.controller.dispatch(f.active, "chapter one");
    f.settled({ stopReason: "aborted", output: [{ type: "text", text: "写到一半" }] });
    await Promise.resolve();
    const observation = await f.controller.state(f.active);
    expect(observation.lastTurnReason).toBe("aborted"); expect(observation.finalText).toBeUndefined();
  });

  it("waits for a restored native child to actually settle after interruption", async () => {
    const f = fixture(); let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    f.context.sessionController.wait.mockImplementation(async () => { await stopped; return { reason: "idle", state: { running: false, pendingInput: [], queue: [] } }; });
    let returned = false; const cancelling = f.controller.cancel(f.active).then(() => { returned = true; });
    await vi.waitFor(() => { expect(f.context.sessionController.wait).toHaveBeenCalledOnce(); });
    expect(f.runtime.interrupt).toHaveBeenCalledWith("child-1", { kind: "ancestor", agent: f.realm.agent });
    expect(returned).toBe(false); release(); await cancelling;
    expect(returned).toBe(true); expect(f.context.sessionController.cancel).not.toHaveBeenCalled();
  });

  it("reports restored-child stop timeouts instead of claiming completion", async () => {
    const f = fixture(); f.context.sessionController.wait.mockResolvedValue({ reason: "timeout", state: { running: true, pendingInput: [], queue: [] } });
    await expect(f.controller.cancel(f.active)).rejects.toThrow("尚未停止完成");
  });
});
