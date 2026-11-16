/** Host-side adaptation of the portable app's seven-column dossier and settings_slices. */
export interface OriginalContextSection { readonly name: string; readonly content: string }
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function originalNumber(value: unknown): string { return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "None"; }

/** Same labels and limits as novel.state.dossier; supplied state notes are not cut to 160 chars. */
export function renderOriginalDossier(value: unknown, chapter: number, totalChapters: number): string {
  const state = record(value) ?? {};
  const lines = [`【读档包｜写第 ${String(chapter)} 章前】`, `一、当前进度：已写到第 ${String(chapter - 1)} 章，本章为第 ${String(chapter)} 章，全书共 ${String(totalChapters)} 章。`];
  const characters = record(state.characters) ?? {};
  const notes = Object.entries(characters).flatMap(([name, info]) => {
    const note = text(record(info)?.note);
    return note !== "" && note !== "未登场" ? [`${name}：${note}`] : [];
  });
  lines.push("二、人物状态（只列已登场，含各自已知/未知）：", ...(notes.length === 0 ? ["尚无人物状态，按设定集初始卡执行。"] : notes.slice(-14)));
  lines.push("三、伏笔台账（编号/状态/计划）：");
  for (const [id, value] of Object.entries(record(state.fb) ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const info = record(value) ?? {};
    lines.push(`${id}｜${text(info.status, "未埋")}｜埋设章 ${originalNumber(info.plant_chapter)}｜计划回收 ${originalNumber(info.planned_reap)}｜实际回收 ${originalNumber(info.reap_chapter)}`);
  }
  lines.push("四、本章必须接住的事：" + text(state.pending, "无"), "五、最近章节摘要：");
  const recent = (Array.isArray(state.recent) ? state.recent : []).slice(-10).flatMap(value => { const item = record(value); return item === undefined ? [] : [item]; });
  for (const item of recent) lines.push(`第${originalNumber(item.n)}章《${text(item.title)}》：${text(item.summary)}`);
  lines.push("六、最近章节钩子类型（相邻两章不得同类型）：");
  for (const item of recent) lines.push(`第${originalNumber(item.n)}章：${text(item.hook_type, "未标注")}`);
  const deviations = (Array.isArray(state.deviations) ? state.deviations : []).filter((value): value is string => typeof value === "string");
  if (deviations.length > 0) lines.push("七、正文与章纲的已登记偏差（以正文为准）：", ...deviations.slice(-6));
  return lines.join("\n");
}

function chapterCharacters(chapterRaw: string): string[] {
  const line = chapterRaw.split(/\r?\n/u).map(line => line.replaceAll("**", "")).find(line => /^\s*(?:[-*◆▶●▪>+]\s*)?(?:本章出场人物|出场人物|出场顺序)\s*[:：]/u.test(line));
  const value = line?.replace(/^.*?[:：]/u, "") ?? "";
  return [...new Set(value.split(/[、,，;；/|→]+/u).map(value => value.trim().replace(/[（(][^）)]*[）)]/gu, "").trim()).filter(Boolean))];
}

/** Original first-two-paragraph selection, preserving whole paragraphs instead of the old 700-char cut. */
export function buildOriginalSettingsSlices(chapterRaw: string, sections: readonly OriginalContextSection[], stylePrompt?: string): string {
  const corpus = sections.filter(section => /设定|核心|大纲规划/u.test(section.name) && section.content !== stylePrompt).map(section => section.content).join("\n\n");
  const paragraphs = corpus.split(/\r?\n\s*\r?\n/u).map(part => part.trim()).filter(Boolean);
  const names = chapterCharacters(chapterRaw);
  const ids = [...new Set(chapterRaw.match(/FB\d+/gu) ?? [])];
  const slices = [...names, ...ids].flatMap(key => {
    const matches = paragraphs.filter(paragraph => paragraph.includes(key)).slice(0, 2);
    return matches.length === 0 ? [] : [`◆ ${key}\n${matches.join("\n\n")}`];
  });
  return slices.join("\n\n");
}
