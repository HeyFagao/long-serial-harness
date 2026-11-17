/** Credential-free, exact native route captured for one writing batch. */
export interface SerialModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface SerialModelCatalogEntry {
  readonly provider: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly label: string;
  readonly efforts: readonly { readonly id: string; readonly label: string }[];
  readonly defaultEffort?: string;
}

export interface SerialModelCatalog {
  readonly current?: SerialModelSelection;
  readonly models: readonly SerialModelCatalogEntry[];
  readonly warnings?: readonly string[];
}

/** Shape validation is separate from live adapter/catalog capability validation. */
export function assertSerialModelSelection(value: unknown): asserts value is SerialModelSelection {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const identifier = (item: unknown, max: number): item is string => typeof item === "string" && item.trim() !== "" && item.length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(item);
  if (record === undefined || Object.keys(record).some(key => key !== "provider" && key !== "model" && key !== "reasoningEffort") || !identifier(record.provider, 512) || !identifier(record.model, 512)
    || (record.reasoningEffort !== undefined && !identifier(record.reasoningEffort, 128))) {
    throw new Error("模型选择无效，请重新选择写作模型和思考强度。");
  }
}

/** Translate familiar labels while preserving the adapter-owned id on the wire. */
export function serialReasoningEffortLabel(id: string, fallback: string): string {
  const labels: Readonly<Record<string, string>> = { none: "关闭思考", off: "关闭思考", disabled: "关闭思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
  return labels[id] ?? fallback;
}
