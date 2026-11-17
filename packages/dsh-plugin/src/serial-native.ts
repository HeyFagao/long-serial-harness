import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { SessionAddress, SessionState } from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import { ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { SubagentResult } from "@deepseek-ai/dsh-subagent";
import type { SerialActive, SerialAdapter, SerialObservation } from "./serial-runtime.js";
import type { WorkspaceRealm } from "./workspace-route.js";
import type { SerialModelSelection } from "./serial-model-selection.js";
import { resolveSerialModelSelection } from "./serial-models.js";

interface FreshActivation {
  readonly childId: SessionId;
  readonly messageId?: string;
  readonly result: Promise<SubagentResult>;
  dispose(): Promise<void>;
}
interface FreshTask {
  readonly parent: Agent;
  readonly prompt: ContentBlock[];
  readonly maxDepth: number;
  readonly agentOptions: AgentOptions;
}
/** The compatibility shape used by Oh Story Roles: rc.1 reads request, rc.3 reads the flat task. */
interface FreshSpec extends FreshTask {
  readonly provider: "spawn";
  readonly childId: SessionId;
  readonly label: string;
  readonly request: FreshTask;
  readonly signal: AbortSignal;
  readonly delivery: "caller";
}
interface FreshRuntime {
  startActivation(spec: FreshSpec): Promise<FreshActivation>;
  interrupt(id: SessionId, authority: { readonly kind: "ancestor"; readonly agent: Agent }): void;
}
interface ActivationState {
  readonly activation: FreshActivation;
  result?: Pick<SubagentResult, "stopReason" | "diagnostic">;
  failure?: string;
  finalText?: string;
}

/** A settled writer returns prose, not tool invocations or reasoning blocks. */
export function plainAssistantText(blocks: readonly ContentBlock[]): string | undefined {
  const text = blocks.filter(block => block.type === "text").map(block => block.text).join("");
  return text.trim() === "" ? undefined : text;
}

/** Durable recovery uses assembled messages only; an interrupted stream cannot become a chapter. */
export function finalChapterText(events: readonly SessionEvent[]): string | undefined {
  let result: string | undefined;
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    const candidate = plainAssistantText(event.data.message.content);
    if (candidate !== undefined) result = candidate;
  }
  return result;
}

function humanSource(source: unknown): boolean {
  return typeof source === "object" && source !== null && "kind" in source && (source.kind === "user" || source.kind === "user-rpc");
}

/** Read only the chosen journal interval, using the public paged native API. */
async function journal(context: Context, address: SessionAddress, after: number, through: number): Promise<SessionEvent[]> {
  if (after >= through) return [];
  const events: SessionEvent[] = [];
  let beforeSeq: number | undefined;
  while (true) {
    const page = await context.sessionController.events({ address, throughSeq: through, maxMessages: 200,
      ...(beforeSeq === undefined ? {} : { beforeSeq }) }, new AbortController().signal);
    const records = page.records.map(record => record.event).filter(event => event.seq > after);
    events.unshift(...records as unknown as SessionEvent[]);
    const first = page.records[0]?.event.seq;
    if (!page.hasMore || first === undefined || first <= after) return events;
    if (beforeSeq !== undefined && first >= beforeSeq) throw new Error("原生章节会话游标没有推进，已停止读取。");
    beforeSeq = first;
  }
}

export function parentHasNewInput(events: readonly SessionEvent[], native: Pick<SessionState, "queue">): boolean {
  if ((native.queue ?? []).some(item => item.placement !== "context")) return true;
  return events.some(event => event.type === "user/message" ? humanSource(event.data.source)
    : event.type === "agent/inbox/spliced" && event.data.inserted.some(message => humanSource(message.source)));
}

/** The initial spawn prompt is the child's first human message; later human messages are steering. */
export function childExecution(events: readonly SessionEvent[]): {
  readonly initialMessageId?: string;
  readonly foreignInput: boolean;
  readonly lastTurnReason?: string;
  readonly lastTurnError?: string;
} {
  let initialMessageId: string | undefined;
  let foreignInput = false;
  let currentTurn: number | undefined;
  const ownTurns = new Set<number>();
  let lastTurnReason: string | undefined;
  let lastTurnError: string | undefined;
  for (const event of events) {
    if (event.type === "turn/start") currentTurn = event.data.turn;
    if (event.type === "agent/inbox/spliced") {
      for (const message of event.data.inserted) {
        if (!humanSource(message.source)) continue;
        initialMessageId ??= message.id;
        if (message.id !== initialMessageId) foreignInput = true;
      }
    }
    if (event.type === "user/message" && humanSource(event.data.source)) {
      initialMessageId ??= event.data.id;
      if (event.data.id !== initialMessageId) foreignInput = true;
      else if (currentTurn !== undefined) ownTurns.add(currentTurn);
    }
    if (event.type === "turn/end" && ownTurns.has(event.data.turn)) {
      lastTurnReason = event.data.reason.kind;
      lastTurnError = event.data.reason.kind === "error" ? event.data.reason.error.message : undefined;
    }
  }
  return { foreignInput, ...(initialMessageId === undefined ? {} : { initialMessageId }),
    ...(lastTurnReason === undefined ? {} : { lastTurnReason }), ...(lastTurnError === undefined ? {} : { lastTurnError }) };
}

/** Native spawn starts every chapter in empty context and inherits DSH model, preset and permissions. */
export function createNativeSerialController(
  context: Context,
  getOwnerRealm: () => Promise<WorkspaceRealm>,
  label = "长篇连载",
  getModelSelection?: () => Readonly<SerialModelSelection> | undefined
): Pick<SerialAdapter, "state" | "dispatch" | "cancel"> {
  const activations = new Map<string, ActivationState>();
  context.effect(() => async () => { await Promise.allSettled([...activations.values()].map(item => item.activation.dispose())); }, "oh-story: fresh serial child lifecycle");
  const parentState = async (realm: WorkspaceRealm, active?: SerialActive) => {
    const native = await context.sessionController.state({ sessionId: SessionId(realm.sessionId) }, new AbortController().signal);
    const events = await journal(context, { kind: "session", sessionId: SessionId(realm.sessionId) }, active?.baselineSeq ?? native.cursor, native.cursor);
    return { native, externalInput: parentHasNewInput(events, native) };
  };
  const childState = async (realm: WorkspaceRealm, active: SerialActive) => {
    const sessionId = SessionId(active.sessionId);
    const live = activations.get(active.sessionId);
    const stored = live === undefined ? await context.sessionController.projections({ sessionId }, new AbortController().signal) : true;
    if (stored === null) return undefined;
    const native = await context.sessionController.state({ sessionId }, new AbortController().signal);
    const events = await journal(context, { kind: "subagent", parentSessionId: SessionId(realm.sessionId), childSessionId: sessionId, mode: "continuable" }, -1, native.cursor);
    const execution = childExecution(events);
    return { native, execution, live, finalText: finalChapterText(events) };
  };
  return {
    async state(active): Promise<SerialObservation> {
      const realm = await getOwnerRealm();
      const owner = await parentState(realm, active);
      const base = { cursor: owner.native.cursor, externalInput: owner.externalInput };
      if (active === undefined || active.requestId === "") {
        return { ...base, running: owner.native.running, pendingInput: owner.native.pendingInput.length > 0 };
      }
      if (active.sessionId === realm.sessionId) throw new Error("旧版连载记录使用共享写作会话，不能自动迁移；请停止旧批次后新建逐章独立会话任务。");
      const child = await childState(realm, active);
      if (child === undefined) return { ...base, running: owner.native.running, pendingInput: owner.native.pendingInput.length > 0, requestKnown: false };
      const ownQueued = (child.native.queue ?? []).some(item => item.id === child.execution.initialMessageId);
      const live = child.live;
      const unsettled = live !== undefined && live.result === undefined && live.failure === undefined;
      const lastTurnReason = live?.result?.stopReason ?? (live?.failure === undefined ? child.execution.lastTurnReason : "error");
      const lastTurnError = live?.result?.diagnostic ?? live?.failure ?? child.execution.lastTurnError;
      const finalText = live?.finalText ?? child.finalText;
      return {
        ...base, externalInput: owner.externalInput || child.execution.foreignInput,
        running: owner.native.running || child.native.running || unsettled,
        pendingInput: owner.native.pendingInput.length > 0 || child.native.pendingInput.length > 0,
        ownQueued, requestKnown: true,
        ...(lastTurnReason === undefined ? {} : { lastTurnReason }),
        ...(lastTurnError === undefined ? {} : { lastTurnError }),
        ...(lastTurnReason !== "completed" || finalText === undefined ? {} : { finalText })
      };
    },
    async dispatch(active, prompt): Promise<void> {
      const realm = await getOwnerRealm();
      if (active.sessionId === realm.sessionId || active.requestId === "") throw new Error("每章必须使用独立原生会话。");
      if (activations.has(active.sessionId)) return;
      for (const [id, previous] of activations) {
        if (previous.result === undefined && previous.failure === undefined) continue;
        await previous.activation.dispose();
        activations.delete(id);
      }
      const existing = await childState(realm, active);
      if (existing !== undefined) throw new Error("这个章节会话已经存在。为避免重复写作，请核对已保存正文后点继续。");
      const owner = await parentState(realm, active);
      if (owner.externalInput || owner.native.running || owner.native.pendingInput.length > 0) throw new Error("主会话正在处理新工作，连载已保留进度，请完成后继续。");
      const runtime = realm.agent.ctx.get("subagents") as unknown as FreshRuntime | undefined;
      if (runtime === undefined || !("startActivation" in runtime)) throw new Error("当前 Harness 未提供原生 spawn 子会话，请启用官方子智能体功能后继续。");
      const controller = new AbortController();
      let published: FreshActivation | undefined;
      // The parent stays idle, but a human can submit new work while native creation awaits.
      // That input cancels only this child; it is never removed from the parent's inbox.
      const unobserve = context.on("session/event", (session, event) => {
        if (session.id !== realm.sessionId || event.seq <= (active.baselineSeq ?? -1)) return;
        const human = event.type === "user/message" ? humanSource(event.data.source)
          : event.type === "agent/inbox/spliced" && event.data.inserted.some(message => humanSource(message.source));
        if (!human) return;
        controller.abort(new Error("主会话收到新工作，已停止当前章节子会话。"));
        if (published !== undefined) void published.dispose().catch(() => undefined);
      });
      const restrict = realm.agent.ctx.on("agent/created", ({ agent }) => {
        if (agent.id !== active.sessionId) return;
        const childTools = agent.ctx.get("tools");
        if (childTools === undefined) throw new Error("原生章节会话缺少工具服务。");
        // The original writer's contract is text + 状态变更. The host saves files;
        // no chapter can edit reference material or perform unrelated actions.
        childTools.restrict({ allow: [] });
      }, { global: true });
      try {
        const guardedOwner = await parentState(realm, active);
        if (guardedOwner.externalInput || guardedOwner.native.running || guardedOwner.native.pendingInput.length > 0) controller.abort(new Error("主会话状态已变化，未创建写作子会话。"));
        controller.signal.throwIfAborted();
        const captured = getModelSelection?.();
        const selected = captured === undefined ? realm.agent.model.current() : await resolveSerialModelSelection(realm, captured);
        controller.signal.throwIfAborted();
        if (selected === undefined) throw new Error("当前主会话尚未选择可用模型，未调用默认线路。请先选择模型后继续。");
        const agentOptions: AgentOptions = { provider: selected.provider, model: selected.model,
          // Native spawn merges the parent's latest request options. An own
          // undefined is required to clear its effort even on the same route.
          reasoningEffort: selected.reasoningEffort === undefined ? undefined : ReasoningEffortId(selected.reasoningEffort),
          ...(realm.agent.options.maxTokens === undefined ? {} : { maxTokens: realm.agent.options.maxTokens }) };
        const task: FreshTask = { parent: realm.agent, prompt: [{ type: "text", text: prompt }], maxDepth: 2, agentOptions };
        published = await runtime.startActivation({ provider: "spawn", childId: SessionId(active.sessionId),
          label: `${label} · 第${String(active.chapter)}章 · 第${String(active.attempt)}次`, ...task, request: task, signal: controller.signal, delivery: "caller" });
        const activation = published;
        if (activation.childId !== active.sessionId) { await activation.dispose(); throw new Error("原生子会话没有采用已保存的章节身份，已停止本次写作。"); }
        const state: ActivationState = { activation };
        activations.set(active.sessionId, state);
        void activation.result.then(result => {
          state.result = { stopReason: result.stopReason, ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }) };
          const finalText = plainAssistantText(result.output);
          if (finalText !== undefined) state.finalText = finalText;
          unobserve();
        }, (error: unknown) => { state.failure = error instanceof Error ? error.message : String(error); unobserve(); });
        if (controller.signal.aborted) await activation.dispose();
      } catch (error) { unobserve(); throw error; }
      finally { restrict(); }
      // Native child creation writes the parent's catalog; flush its durable membership before acknowledgement.
      await context.sessions.flush(realm.agent.session);
    },
    async cancel(active): Promise<void> {
      const realm = await getOwnerRealm();
      if (active.sessionId === realm.sessionId) throw new Error("拒绝用连载停止按钮取消主会话。");
      const live = activations.get(active.sessionId);
      if (live !== undefined) { await live.activation.dispose(); return; }
      // A restored child belongs to the native tree; ancestor authority cannot touch unrelated sessions.
      const runtime = realm.agent.ctx.get("subagents") as unknown as FreshRuntime | undefined;
      if (runtime === undefined) throw new Error("当前 Harness 无法停止章节子会话，请恢复原生子会话服务后重试停止。");
      runtime.interrupt(SessionId(active.sessionId), { kind: "ancestor", agent: realm.agent });
      // interrupt() sends a signal; wait() is the official settlement boundary.
      // Returning early here could let a multi-book queue start its next writer.
      const stopped = await context.sessionController.wait({ sessionId: SessionId(active.sessionId), timeoutMs: 30_000, maxMessages: 1 }, new AbortController().signal);
      if (stopped.reason !== "idle" || stopped.state.running || stopped.state.pendingInput.length > 0
        || (stopped.state.queue ?? []).some(item => item.placement !== "context")) throw new Error("章节子会话尚未停止完成，请稍后重试停止；未派发下一章。");
    }
  };
}
