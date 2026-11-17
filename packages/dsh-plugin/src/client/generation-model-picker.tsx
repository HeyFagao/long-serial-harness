import { useEffect, useId, useRef, useState } from "react";
import { serialReasoningEffortLabel, type SerialModelCatalog, type SerialModelSelection } from "../serial-model-selection.js";
import { endpoint } from "./workbench-ui.js";
import modelStyles from "./generation-model-picker.css?inline";

type CatalogModel = SerialModelCatalog["models"][number];
export function modelOptionKey(model: Pick<SerialModelSelection, "provider" | "model">): string { return JSON.stringify([model.provider, model.model]); }
export function modelForSelection(catalog: SerialModelCatalog | undefined, selection: SerialModelSelection | undefined): CatalogModel | undefined {
  const chosen = selection ?? catalog?.current;
  return chosen === undefined ? undefined : catalog?.models.find(model => model.provider === chosen.provider && model.model === chosen.model);
}
export function chooseGenerationModel(catalog: SerialModelCatalog, key: string): SerialModelSelection | undefined {
  if (key === "") return catalog.current === undefined ? undefined : { ...catalog.current };
  const chosen = catalog.models.find(model => modelOptionKey(model) === key);
  // A model change always starts at its own default; another model's effort is never carried over.
  return chosen === undefined ? undefined : { provider: chosen.provider, model: chosen.model };
}
export function chooseGenerationEffort(catalog: SerialModelCatalog, selection: SerialModelSelection | undefined, effort: string): SerialModelSelection | undefined {
  const chosen = modelForSelection(catalog, selection);
  if (chosen === undefined || (effort !== "" && !chosen.efforts.some(item => item.id === effort))) return selection;
  return { provider: chosen.provider, model: chosen.model, ...(effort === "" ? {} : { reasoningEffort: effort }) };
}
export function generationModelProblem(catalog: SerialModelCatalog | undefined, selection: SerialModelSelection | undefined, loading: boolean, error?: string): string | undefined {
  if (loading) return "正在读取可用模型，请稍候。";
  if (error !== undefined) return "模型列表未能读取，请点击“刷新模型列表”重试。";
  if (selection === undefined && catalog?.current !== undefined) return "正在准备当前会话配置，请稍候。";
  const chosen = modelForSelection(catalog, selection);
  if (chosen === undefined) return selection === undefined ? "当前会话尚无可用模型，请选择写作模型或先在 Harness 设置中添加。" : "所选模型已不可用，请重新选择。";
  const effort = (selection ?? catalog?.current)?.reasoningEffort;
  if (effort !== undefined && !chosen.efforts.some(item => item.id === effort)) return "所选模型不再支持当前思考强度，请重新选择强度。";
  return undefined;
}
export function generationModelFields(selection: SerialModelSelection | undefined): { modelSelection?: SerialModelSelection } {
  return selection === undefined ? {} : { modelSelection: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) } };
}
export function effortLabel(id: string, label = id): string { return serialReasoningEffortLabel(id, label); }
export function describeGenerationSelection(selection: SerialModelSelection): string {
  return `${selection.model} · ${selection.provider} · 思考强度：${selection.reasoningEffort === undefined ? "模型默认" : effortLabel(selection.reasoningEffort)}`;
}

/** Reads the native catalog only. It neither changes the main chat nor makes a model request. */
export function GenerationModelPicker({ sessionId, value, onChange, onProblem, disabled = false }: {
  readonly sessionId: string;
  readonly value: SerialModelSelection | undefined;
  readonly onChange: (selection: SerialModelSelection | undefined) => void;
  readonly onProblem: (problem: string | undefined) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  const [catalog, setCatalog] = useState<SerialModelCatalog>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const selectedRef = useRef(value); selectedRef.current = value;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch(endpoint("models", sessionId), { signal: controller.signal }).then(async response => {
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(typeof body === "object" && body !== null && "error" in body ? String(body.error) : `请求失败（HTTP ${String(response.status)}）`);
      return body as SerialModelCatalog;
    }).then(body => { if (!controller.signal.aborted) { setCatalog(body); if (selectedRef.current === undefined && body.current !== undefined) changeRef.current({ ...body.current }); setError(undefined); setLoading(false); } }).catch((reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    return () => { controller.abort(); };
  }, [revision, sessionId]);
  const problem = generationModelProblem(catalog, value, loading, error);
  useEffect(() => { onProblem(problem); }, [onProblem, problem]);
  const model = modelForSelection(catalog, value);
  const selected = value ?? catalog?.current;
  const providers = [...new Map((catalog?.models ?? []).map(item => [item.provider, item.providerLabel])).entries()];
  const inheritedLabel = catalog?.current === undefined ? "使用当前会话配置" : `使用当前会话配置（${catalog.current.model} · ${catalog.current.reasoningEffort === undefined ? "模型默认" : effortLabel(catalog.current.reasoningEffort)}）`;
  const effort = selected?.reasoningEffort ?? "";
  return <section className="generation-model-picker" aria-label="本次生成模型设置">
    <style>{modelStyles}</style>
    <div className="generation-model-fields">
      <label htmlFor={`${id}-model`}>写作模型<select id={`${id}-model`} aria-label="本次写作模型" disabled={disabled || loading || catalog === undefined} value={value === undefined ? "" : modelOptionKey(value)} onChange={event => { if (catalog !== undefined) { const selection = chooseGenerationModel(catalog, event.target.value); if (selection !== undefined) onChange(selection); } }}>
        <option value="">{inheritedLabel}</option>
        {value !== undefined && model === undefined && <option value={modelOptionKey(value)}>已不可用：{value.model}</option>}
        {providers.map(([provider, label]) => <optgroup key={provider} label={label}>{catalog?.models.filter(item => item.provider === provider).map(item => <option key={modelOptionKey(item)} value={modelOptionKey(item)}>{item.label}</option>)}</optgroup>)}
      </select></label>
      <label htmlFor={`${id}-effort`}>思考强度<select id={`${id}-effort`} aria-label="思考强度" disabled={disabled || loading || model === undefined || (model.efforts.length === 0 && effort === "")} value={effort} onChange={event => { if (catalog !== undefined) onChange(chooseGenerationEffort(catalog, value, event.target.value)); }}>
        <option value="">模型默认</option>
        {effort !== "" && !model?.efforts.some(item => item.id === effort) && <option value={effort}>已不支持：{effortLabel(effort)}</option>}
        {model?.efforts.map(item => <option key={item.id} value={item.id}>{effortLabel(item.id, item.label)}</option>)}
      </select></label>
      <button type="button" disabled={disabled || loading} onClick={() => { setRevision(current => current + 1); }}>刷新模型列表</button>
    </div>
    {problem !== undefined ? <p className={error === undefined ? "generation-model-note" : "generation-model-error"} role={error === undefined ? "status" : "alert"}>{error ?? problem}</p> : model?.efforts.length === 0 && <p className="generation-model-note">此模型不支持调节思考强度，使用模型默认设置。</p>}
    {catalog?.warnings !== undefined && catalog.warnings.length > 0 && <p className="generation-model-note">{catalog.warnings.join("；")}</p>}
    <p className="generation-model-note">模型列表读取时会复制当前会话配置，启动使用上方已选设置；之后切换聊天模型不会改变本批。正文与独立标题均使用此设置，继续原批次时沿用原模型和强度。</p>
  </section>;
}
