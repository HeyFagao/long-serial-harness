import { describe, expect, it } from "vitest";
import type { SerialModelCatalog } from "../src/serial-model-selection.js";
import { chooseGenerationEffort, chooseGenerationModel, describeGenerationSelection, generationModelFields, generationModelProblem, modelForSelection, modelOptionKey } from "../src/client/generation-model-picker.js";

const catalog: SerialModelCatalog = {
  current: { provider: "relay", model: "gpt", reasoningEffort: "high" },
  models: [
    { provider: "relay", providerLabel: "我的中转站", model: "gpt", label: "GPT", efforts: [{ id: "low", label: "低" }, { id: "high", label: "高" }] },
    { provider: "relay", providerLabel: "我的中转站", model: "claude", label: "Claude", efforts: [{ id: "adaptive-high", label: "高（自适应）" }] },
    { provider: "second-relay", providerLabel: "另一中转站", model: "gemini", label: "Gemini", efforts: [] }
  ]
};

describe("per-batch native model choice", () => {
  it("copies the displayed session route rather than leaving a live inheritance sentinel", () => {
    expect(modelForSelection(catalog, undefined)?.model).toBe("gpt");
    expect(generationModelProblem(catalog, undefined, false)).toContain("正在准备");
    const copied = chooseGenerationModel(catalog, "");
    expect(copied).toEqual(catalog.current);
    expect(generationModelFields(copied)).toEqual({ modelSelection: { provider: "relay", model: "gpt", reasoningEffort: "high" } });
    const defaultEffort = chooseGenerationEffort(catalog, undefined, "");
    expect(defaultEffort).toEqual({ provider: "relay", model: "gpt" });
    expect(generationModelFields(defaultEffort)).toEqual({ modelSelection: { provider: "relay", model: "gpt" } });
  });
  it("clears the previous model's effort when switching GPT to Claude or Gemini", () => {
    const claude = chooseGenerationModel(catalog, modelOptionKey({ provider: "relay", model: "claude" }));
    expect(claude).toEqual({ provider: "relay", model: "claude" });
    expect(chooseGenerationEffort(catalog, claude, "adaptive-high")).toEqual({ ...claude, reasoningEffort: "adaptive-high" });
    const gemini = chooseGenerationModel(catalog, modelOptionKey({ provider: "second-relay", model: "gemini" }));
    expect(gemini).toEqual({ provider: "second-relay", model: "gemini" });
    expect(modelForSelection(catalog, gemini)?.efforts).toEqual([]);
    expect(generationModelProblem(catalog, gemini, false)).toBeUndefined();
  });
  it("passes provider-owned effort identifiers unchanged to a new batch", () => {
    const selected = chooseGenerationEffort(catalog, { provider: "relay", model: "claude" }, "adaptive-high");
    expect(generationModelFields(selected)).toEqual({ modelSelection: { provider: "relay", model: "claude", reasoningEffort: "adaptive-high" } });
    expect(chooseGenerationEffort(catalog, selected, "high")).toEqual(selected);
    expect(generationModelProblem(catalog, { provider: "relay", model: "claude", reasoningEffort: "high" }, false)).toContain("强度");
  });
  it("blocks stale selected routes or efforts after the native catalog changes", () => {
    expect(generationModelProblem(catalog, { provider: "removed-relay", model: "gpt" }, false)).toContain("已不可用");
    const changed: SerialModelCatalog = { ...catalog, models: catalog.models.map(model => ({ ...model, efforts: [] })) };
    expect(generationModelProblem(changed, catalog.current, false)).toContain("强度");
    const cleared = chooseGenerationEffort(changed, undefined, "");
    expect(cleared).toEqual({ provider: "relay", model: "gpt" });
    expect(generationModelProblem(changed, cleared, false)).toBeUndefined();
    expect(generationModelProblem(catalog, undefined, true)).toContain("正在读取");
    expect(generationModelProblem(catalog, undefined, false, "offline")).toContain("刷新模型列表");
  });
  it("posts the visible captured model even when the main chat changes before starting", () => {
    const displayed = chooseGenerationModel(catalog, "");
    const changedCatalog = { ...catalog, current: { provider: "second-relay", model: "gemini" } };
    expect(generationModelFields(displayed)).toEqual({ modelSelection: { provider: "relay", model: "gpt", reasoningEffort: "high" } });
    expect(chooseGenerationModel(changedCatalog, "")).toEqual(changedCatalog.current);
    expect(generationModelFields(chooseGenerationModel(changedCatalog, ""))).toEqual({ modelSelection: { provider: "second-relay", model: "gemini" } });
  });
  it("shows the captured model and effort independently of a later session model change", () => {
    const selection = { provider: "relay", model: "gpt", reasoningEffort: "high" };
    expect(describeGenerationSelection(selection)).toBe("gpt · relay · 思考强度：高");
    expect(describeGenerationSelection({ provider: "relay", model: "gemini" })).toContain("模型默认");
    expect(modelOptionKey({ provider: 'a/"b', model: "c:d" })).not.toBe(modelOptionKey({ provider: "a", model: '/"bc:d' }));
  });
});
