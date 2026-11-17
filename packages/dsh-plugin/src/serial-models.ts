import type { Context } from "@deepseek-ai/cordis";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertSerialModelSelection, serialReasoningEffortLabel, type SerialModelCatalog, type SerialModelCatalogEntry, type SerialModelSelection } from "./serial-model-selection.js";
import { isTrustedWorkspaceRequest } from "./workspace-request-trust.js";
import { send, workspaceRealmForSession, WorkspaceHttpError, type WorkspaceRealm } from "./workspace-route.js";

function detached(value: SerialModelSelection): SerialModelSelection {
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) };
}

/** Use the host's registered model catalog; settings, endpoints and keys never enter this reply. */
export async function getSerialModelCatalog(realm: WorkspaceRealm): Promise<SerialModelCatalog> {
  const llm = realm.agent.ctx.llm;
  const providers = llm.listProviders();
  const warnings: string[] = [];
  const groups = await Promise.all(providers.map(async provider => {
    let listed;
    try { listed = await llm.listModels(provider.id); }
    catch { warnings.push(`“${provider.name}”的模型列表暂时无法读取，请刷新或在 Harness 设置中检查。`); return []; }
    const entries = await Promise.all(listed.map(async model => {
      if (model.provider !== provider.id || (model.inputModalities !== undefined && !model.inputModalities.includes("text"))) return undefined;
      try {
        const info = await llm.resolveModelInfo(provider.id, model.id);
        const entry: SerialModelCatalogEntry = {
          provider: provider.id, providerLabel: provider.name, model: model.id, label: model.name,
          efforts: info.reasoning?.efforts.map(effort => ({ id: effort.id, label: serialReasoningEffortLabel(effort.id, effort.name) })) ?? [],
          ...(info.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort })
        };
        return entry;
      } catch { warnings.push(`“${provider.name} / ${model.name}”的模型能力暂时无法读取。`); return undefined; }
    }));
    return entries.filter((entry): entry is SerialModelCatalogEntry => entry !== undefined);
  }));
  const current = realm.agent.model.current();
  return { ...(current === undefined ? {} : { current: detached(current) }), models: groups.flat(), ...(warnings.length === 0 ? {} : { warnings }) };
}

/** Validate the exact native model and effort without issuing a generation request. */
export async function resolveSerialModelSelection(realm: WorkspaceRealm, value?: unknown): Promise<SerialModelSelection> {
  const selected: unknown = value === undefined ? realm.agent.model.current() : value;
  if (selected === undefined) throw new WorkspaceHttpError(409, "请先选择写作模型，任务不会自动切换到其他线路。");
  try { assertSerialModelSelection(selected); }
  catch { throw new WorkspaceHttpError(400, "模型选择无效，请重新选择写作模型和思考强度。"); }
  const selection = detached(selected);
  const llm = realm.agent.ctx.llm;
  try {
    if (!llm.listProviders().some(provider => provider.id === selection.provider)) throw new WorkspaceHttpError(409, "所选中转站或模型提供商已不可用，请刷新模型列表后重新选择。");
    const advertised = await llm.listModels(selection.provider);
    const model = advertised.find(model => model.provider === selection.provider && model.id === selection.model);
    if (model === undefined || (model.inputModalities !== undefined && !model.inputModalities.includes("text"))) throw new WorkspaceHttpError(409, "所选写作模型已不在 Harness 模型列表中，请刷新后重新选择。");
    const info = await llm.resolveModelInfo(selection.provider, selection.model);
    if (selection.reasoningEffort !== undefined && !info.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new WorkspaceHttpError(400, "所选模型不支持这个思考强度，请重新选择；未改用其他模型。");
    const resolved = await llm.resolveCallConfig({ provider: selection.provider, model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }) });
    return { provider: selection.provider, model: selection.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) };
  } catch (error) {
    if (error instanceof WorkspaceHttpError) throw error;
    throw new WorkspaceHttpError(409, "所选模型或思考强度暂时不可用，请刷新模型列表或检查中转站设置；未切换其他线路。");
  }
}

export function registerSerialModelsRoute(context: Context, options: { readonly trustedHosts?: readonly string[] } = {}): void {
  context.effect(() => context.webServer.register({ kind: "exact", path: "/oh-story/models", async handler(request: IncomingMessage, response: ServerResponse) {
    try {
      if (!isTrustedWorkspaceRequest(request, options.trustedHosts ?? [])) throw new WorkspaceHttpError(403, "请求来源不受信任。");
      if (request.method !== "GET") throw new WorkspaceHttpError(405, "模型列表仅支持 GET。");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const realm = await workspaceRealmForSession(context, url.searchParams.get("sessionId") ?? "");
      send(response, 200, await getSerialModelCatalog(realm));
    } catch (error) {
      if (error instanceof WorkspaceHttpError) send(response, error.status, { error: error.message });
      else send(response, 503, { error: "Harness 模型列表暂时无法读取，请刷新或检查模型设置。" });
    }
  } }), "serial native model catalog API");
}
