import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId, type Session } from "@deepseek-ai/dsh-session";
import { workspaceRealmForSession, WorkspaceHttpError, type WorkspaceRealm } from "./workspace-route.js";
import { assertSerialModelSelection, type SerialModelSelection } from "./serial-model-selection.js";

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "ask" | "never";

/** Detached, credential-free choices captured when a library batch starts. */
export interface LibraryOwnerContext {
  readonly modelSelection: Readonly<ModelSelection>;
  readonly presetId?: string;
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalPolicy;
  readonly permissionPreset?: string;
  readonly maxTokens?: number;
}

interface Presets {
  composedPreset(context: Context): string | undefined;
  composeFrom(context: Context, parent: Context): string | undefined;
}
interface Approval {
  readonly config: { readonly policy?: ApprovalPolicy };
  overrideOf(session: Session): ApprovalPolicy | undefined;
}
interface Permissions {
  current(session: Session): string;
  set(session: Session, name: string): void;
}
interface PolicyLog {
  append(type: "approval/policy", data: { readonly policy: ApprovalPolicy }): unknown;
}
interface RegisteredWorkspace {
  attachSession(sessionId: SessionId): Promise<void>;
}
interface WorkspaceRegistry {
  resolveByPath(path: string): Promise<RegisteredWorkspace | undefined>;
}

const ownedAgents = new WeakMap<Context, Map<string, AgentHandle>>();
const pendingAgents = new WeakMap<Context, Map<string, Promise<WorkspaceRealm>>>();

/** Validate a persisted batch snapshot before passing any value to a native selector or policy setter. */
export function assertLibraryOwnerContext(value: unknown): asserts value is LibraryOwnerContext {
  const record = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);
  const text = (item: unknown): item is string => typeof item === "string" && item.trim() !== "";
  if (!record(value) || !record(value.modelSelection)
    || !text(value.modelSelection.provider) || !text(value.modelSelection.model)
    || (value.modelSelection.reasoningEffort !== undefined && !text(value.modelSelection.reasoningEffort))
    || (value.presetId !== undefined && !text(value.presetId))
    || (value.permissionPreset !== undefined && !text(value.permissionPreset))
    || typeof value.sandboxMode !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(value.sandboxMode)
    || typeof value.approvalPolicy !== "string" || !["ask", "never"].includes(value.approvalPolicy)
    || (value.maxTokens !== undefined && (typeof value.maxTokens !== "number" || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1))) {
    throw new WorkspaceHttpError(409, "本批模型或权限快照无效，请检查保存的任务记录后重新开始。");
  }
  assertSerialModelSelection(value.modelSelection);
}

function presetsOf(agent: Agent): Presets | undefined {
  const service: unknown = agent.ctx.get("agentPresets");
  return service as Presets | undefined;
}
function approvalOf(agent: Agent): Approval | undefined {
  const service: unknown = agent.ctx.get("approval");
  return service as Approval | undefined;
}
function permissionsOf(agent: Agent): Permissions | undefined {
  const service: unknown = agent.ctx.get("permissionPresets");
  return service as Permissions | undefined;
}

/** Capture the selected route, including a pending choice before its first model request. */
export function captureLibraryOwnerContext(realm: WorkspaceRealm, modelSelection?: SerialModelSelection): LibraryOwnerContext {
  const model = modelSelection ?? realm.agent.model.current();
  if (model === undefined || model.provider === "" || model.model === "") {
    throw new WorkspaceHttpError(409, "请先为书库选择模型，批量任务不会自动改用默认线路。");
  }
  assertSerialModelSelection(model);
  const approval = approvalOf(realm.agent);
  if (approval === undefined) throw new WorkspaceHttpError(503, "Harness 审批策略尚未就绪，未建立小说会话。");
  const presetId = presetsOf(realm.agent)?.composedPreset(realm.agent.ctx);
  const permissionPreset = permissionsOf(realm.agent)?.current(realm.agent.session);
  const maxTokens = realm.agent.options.maxTokens;
  return {
    modelSelection: { provider: model.provider, model: model.model,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) },
    ...(presetId === undefined ? {} : { presetId }),
    sandboxMode: realm.sandboxPolicy.resolve({ session: realm.agent.session }).mode,
    approvalPolicy: approval.overrideOf(realm.agent.session) ?? approval.config.policy ?? "ask",
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(maxTokens === undefined ? {} : { maxTokens })
  };
}

function sameModel(left: Readonly<ModelSelection>, right: Readonly<ModelSelection>): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}

function checkExisting(realm: WorkspaceRealm, path: string, snapshot: LibraryOwnerContext): void {
  const current = captureLibraryOwnerContext(realm);
  if (realm.cwd !== path || !sameModel(current.modelSelection, snapshot.modelSelection)
    || current.presetId !== snapshot.presetId || current.sandboxMode !== snapshot.sandboxMode
    || current.approvalPolicy !== snapshot.approvalPolicy || current.permissionPreset !== snapshot.permissionPreset
    || current.maxTokens !== snapshot.maxTokens) {
    throw new WorkspaceHttpError(409, "已保存的小说会话与本批工作目录、模型或权限不一致，已停止，未覆盖原会话。");
  }
}

function handles(context: Context): Map<string, AgentHandle> {
  const current = ownedAgents.get(context);
  if (current !== undefined) return current;
  const created = new Map<string, AgentHandle>();
  ownedAgents.set(context, created);
  context.effect(() => async () => {
    await Promise.allSettled([...created.values()].map(handle => handle.dispose()));
    created.clear();
  }, "oh-story: library book owner lifecycle");
  return created;
}

async function bookPathWithinLibrary(realm: WorkspaceRealm, path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new WorkspaceHttpError(400, "小说项目必须是书库内的绝对目录。");
  const target = await realm.fs.resolve(path);
  if (!realm.fs.contains(realm.root, target) || realm.fs.contains(target, realm.root)) {
    throw new WorkspaceHttpError(403, "小说项目必须是当前书库的独立子目录。");
  }
  if ((await realm.fs.stat(target))?.type !== "directory") throw new WorkspaceHttpError(404, "小说项目目录不存在。");
  const processPath = realm.fs.processPath(target);
  const mapped = realm.fs.processPathFromHostPath(path);
  if (mapped === undefined || (await realm.fs.resolve(mapped)).targetKey !== target.targetKey) {
    throw new WorkspaceHttpError(409, "当前文件系统没有可供 Harness 工作区使用的本地路径映射。");
  }
  return processPath;
}

async function ensureBook(
  context: Context, library: WorkspaceRealm, bookPath: string, ownerSessionId: string, snapshot: LibraryOwnerContext
): Promise<WorkspaceRealm> {
  assertLibraryOwnerContext(snapshot);
  if (ownerSessionId === "" || ownerSessionId === library.sessionId) throw new WorkspaceHttpError(400, "每本小说必须有独立的主会话标识。");
  const path = await bookPathWithinLibrary(library, bookPath);
  const registryService: unknown = context.get("workspaceRegistry");
  const workspace = await (registryService as WorkspaceRegistry | undefined)?.resolveByPath(path);
  if (workspace === undefined) {
    throw new WorkspaceHttpError(409, "本书尚未登记为 Harness 工作区，请在书库点击登记后继续。");
  }
  const current = captureLibraryOwnerContext(library, snapshot.modelSelection);
  // A user reducing the library's standing access stops a resumed batch; it cannot recreate broader owners.
  const rank: Record<SandboxMode, number> = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
  if (rank[current.sandboxMode] < rank[snapshot.sandboxMode]
    || (current.approvalPolicy === "ask" && snapshot.approvalPolicy === "never")) {
    throw new WorkspaceHttpError(403, "书库当前权限比本批开始时更严格，请检查任务后重新开始，不会恢复较宽权限。");
  }
  const id = SessionId(ownerSessionId);
  const present = context.agents.get(id) !== undefined
    || await context.sessionController.projections({ sessionId: id }, new AbortController().signal) !== null;
  if (present) {
    const realm = await workspaceRealmForSession(context, ownerSessionId);
    checkExisting(realm, path, snapshot);
    await workspace.attachSession(id);
    return realm;
  }
  if (current.presetId !== snapshot.presetId) {
    throw new WorkspaceHttpError(409, "书库 Agent 预设已改变，请恢复本批预设后继续，未切换小说使用的预设。");
  }
  // This is configuration validation only, not a model request or a global default mutation.
  await library.agent.ctx.llm.resolveCallConfig(snapshot.modelSelection);
  const handle = await context.agents.create({
    sessionId: id,
    meta: { cwd: path, ...(snapshot.presetId === undefined ? {} : { agentPreset: snapshot.presetId }) },
    agentOptions: { ...snapshot.modelSelection, ...(snapshot.maxTokens === undefined ? {} : { maxTokens: snapshot.maxTokens }) },
    setup: (childContext, child) => {
      installModelSelection(childContext);
      const inherited = presetsOf(library.agent)?.composeFrom(childContext, library.agent.ctx);
      if (inherited !== snapshot.presetId) throw new WorkspaceHttpError(409, "书库预设在创建小说会话时发生变化，已停止。");
      const permissions = permissionsOf(child);
      if (snapshot.permissionPreset !== undefined && snapshot.permissionPreset !== "custom") {
        if (permissions === undefined) throw new WorkspaceHttpError(503, "小说会话的权限预设服务不可用。");
        permissions.set(child.session, snapshot.permissionPreset);
      }
      // Canonical policy setters append only this new Session's durable facts, before agent/created.
      setSandboxMode(child.session, snapshot.sandboxMode);
      (child.session as unknown as PolicyLog).append("approval/policy", { policy: snapshot.approvalPolicy });
      child.model.select(snapshot.modelSelection);
      return { commit: () => {
        const latest = captureLibraryOwnerContext(library, snapshot.modelSelection);
        if (latest.presetId !== snapshot.presetId
          || latest.sandboxMode !== current.sandboxMode || latest.approvalPolicy !== current.approvalPolicy) {
          throw new WorkspaceHttpError(409, "书库模型或权限在创建期间发生变化，未发布小说会话。");
        }
      } };
    }
  });
  handles(context).set(ownerSessionId, handle);
  try {
    await context.sessions.flush(handle.agent.session);
    const realm = await workspaceRealmForSession(context, ownerSessionId);
    checkExisting(realm, path, snapshot);
    await workspace.attachSession(id);
    return realm;
  } catch (error) {
    handles(context).delete(ownerSessionId);
    await handle.dispose();
    throw error;
  }
}

/** Create or resume the batch-reserved ordinary book owner without changing global model settings. */
export function ensureLibraryBookRealm(
  context: Context, library: WorkspaceRealm, bookPath: string, ownerSessionId: string, snapshot: LibraryOwnerContext
): Promise<WorkspaceRealm> {
  let pending = pendingAgents.get(context);
  if (pending === undefined) { pending = new Map(); pendingAgents.set(context, pending); }
  const existing = pending.get(ownerSessionId);
  if (existing !== undefined) return existing.then(async realm => {
    assertLibraryOwnerContext(snapshot);
    checkExisting(realm, await bookPathWithinLibrary(library, bookPath), snapshot);
    return realm;
  });
  const operation = ensureBook(context, library, bookPath, ownerSessionId, snapshot).finally(() => { pending.delete(ownerSessionId); });
  pending.set(ownerSessionId, operation);
  return operation;
}
