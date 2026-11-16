import { normalizeOriginalFbId, parseOriginalChapterPlan } from "./original-outline-plan.js";

/**
 * State fields from the original green workbench's novel.state module.
 * Only model-reported changes are applied: an outline's planned date is not
 * evidence that a character appeared or a foreshadowing was resolved.
 */
export interface OriginalCharacterState {
  note: string;
}

export interface OriginalForeshadowState {
  content: string;
  plant_chapter: number | null;
  planned_reap: number | null;
  status: string;
  reap_chapter: number | null;
  next: string;
}

export interface OriginalState {
  title: string;
  next_chapter: number;
  total_chapters: number;
  characters: Record<string, OriginalCharacterState>;
  fb: Record<string, OriginalForeshadowState>;
  recent: { n: number; title: string; summary: string; hook_type: string }[];
  hook_type_counts: Record<string, number>;
  pending: string;
  tail: string;
  deviations: string[];
  chapter_meta: Record<string, { chars: number; hook_type: string; time?: string }>;
  updated?: string;
}

const FIELDS = ["本章摘要", "实际字数", "章尾钩类型", "人物", "伏笔", "时间", "与章纲不同的地方及原因", "下一章必须接住的事"] as const;
const EMPTY_VALUE = /^(?:无|无变化|暂无|没有)[。.!！]?$/u;
const CHARACTER_DETAILS: ReadonlySet<string> = new Set(["位置", "伤病", "物品", "关系", "认知", "认知变化", "已知", "未知"]);

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

/** Read the whole field block, not just its first line or a fixed-size prefix. */
export function extractOriginalField(change: string, name: string): string {
  const names = [...new Set<string>([...FIELDS, name])].map(escaped).join("|");
  const heading = new RegExp(`^[ \\t]*(?:[-*•][ \\t]*)?(?:\\*\\*)?(${names})(?:\\*\\*)?[ \\t]*[：:][ \\t]*(.*)$`, "u");
  const values: string[] = [];
  let selected = false;
  for (const line of change.replace(/\r\n?/gu, "\n").split("\n")) {
    const match = heading.exec(line);
    if (match !== null) {
      selected = match[1] === name;
      if (selected) values.push(match[2] ?? "");
    } else if (selected) values.push(line);
  }
  return values.join("\n").trim();
}

export function emptyOriginalState(totalChapters: number): OriginalState {
  if (!Number.isSafeInteger(totalChapters) || totalChapters < 0) throw new Error("总章数无效。");
  return {
    title: "", next_chapter: 1, total_chapters: totalChapters,
    characters: {}, fb: {}, recent: [], hook_type_counts: {},
    pending: "第 1 章：按细纲开场，直接切入冲突现场。", tail: "", deviations: [], chapter_meta: {}
  };
}

/**
 * Faithful init_state plan population, using the lossless importer's chapter
 * boundaries. Planned dates initialize the dossier but never change status.
 */
export function initializeOriginalState(
  chapters: readonly { readonly number: number; readonly content: string }[],
  totalChapters: number,
  bookTitle = ""
): OriginalState {
  const state = emptyOriginalState(totalChapters);
  state.title = bookTitle;
  const names = new Set<string>();
  for (const chapter of chapters) {
    if (!Number.isSafeInteger(chapter.number) || chapter.number < 1) throw new Error("初始化计划的章号无效。");
    const plan = parseOriginalChapterPlan(chapter.content);
    for (const name of plan.characters) if (safeName(name)) names.add(name);
    for (const id of plan.fb_plant) {
      const item = state.fb[id] ?? { content: plan.focus, plant_chapter: chapter.number, planned_reap: null, status: "未埋", reap_chapter: null, next: "" };
      item.plant_chapter = item.plant_chapter === null ? chapter.number : Math.min(item.plant_chapter, chapter.number);
      state.fb[id] = item;
    }
    for (const id of plan.fb_reap) {
      const item = state.fb[id] ?? { content: plan.focus, plant_chapter: null, planned_reap: chapter.number, status: "未埋", reap_chapter: null, next: "" };
      item.planned_reap = item.planned_reap === null ? chapter.number : Math.min(item.planned_reap, chapter.number);
      state.fb[id] = item;
    }
  }
  for (const name of [...names].sort()) state.characters[name] = { note: "未登场" };
  return state;
}

function safeName(name: string): boolean {
  return name !== "__proto__" && name !== "prototype" && name !== "constructor";
}

function applyCharacters(state: OriginalState, field: string): void {
  if (field === "" || EMPTY_VALUE.test(field)) return;
  let current: string | undefined;
  for (const raw of field.split("\n")) {
    const line = raw.replace(/^\s*[-*•]\s*/u, "").trim();
    if (line === "") continue;
    const match = /^([^：:｜|]{1,80})[：:｜|]\s*(.+)$/u.exec(line);
    const name = match?.[1]?.trim().replace(/^\*\*|\*\*$/gu, "");
    if (name !== undefined && !CHARACTER_DETAILS.has(name) && safeName(name)) {
      current = name;
      state.characters[name] = { note: line };
    } else if (current !== undefined) {
      state.characters[current]!.note += `\n${line}`;
    }
  }
}

type ForeshadowAction = "新埋" | "埋设" | "推进" | "回收";

/** Require an explicit action and event description; schedules and negatives cannot resolve a thread. */
function reportedAction(line: string, prefix: string, details: string, group?: ForeshadowAction): ForeshadowAction | undefined {
  const after = /^[：:｜|\s]*(?:已)?(新埋|埋设|推进|回收)(?:[：:,，、\s]+|$)(.*)$/u.exec(details);
  const before = /(?:^|[：:,，、\s])(?:已)?(新埋|埋设|推进|回收)[：:,，、\s]*$/u.exec(prefix);
  const action = (after?.[1] ?? before?.[1] ?? group) as ForeshadowAction | undefined;
  if (action === undefined) return undefined;
  if (/(?:尚未|未曾|没有|不曾|不要|无需|未|不|计划|预计|将于|待|拟).{0,12}(?:新埋|埋设|推进|回收)/u.test(line)) return undefined;
  const evidence = (after?.[2] ?? details).replace(/^[：:｜|,，、\s]+/u, "").trim();
  if (evidence.length < 2 || EMPTY_VALUE.test(evidence) || /^(?:计划|预计|下章|后续|待|将|拟|准备|尚未|未)/u.test(evidence)) return undefined;
  return action;
}

function applyForeshadows(state: OriginalState, field: string, chapter: number): void {
  if (field === "" || EMPTY_VALUE.test(field)) return;
  let group: ForeshadowAction | undefined;
  for (const raw of field.split("\n")) {
    const line = raw.replace(/^\s*[-*•]\s*/u, "").trim();
    const header = /^(新埋|埋设|推进|回收)\s*[：:]\s*(.*)$/u.exec(line);
    if (header !== null) group = header[1] as ForeshadowAction;
    const matches = [...line.matchAll(/\bFB\s*(\d+)\b/giu)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      const id = normalizeOriginalFbId(match[1]!);
      const start = match.index;
      const end = matches[index + 1]?.index ?? line.length;
      const details = line.slice(start + match[0].length, end).trim();
      const action = reportedAction(line.slice(index === 0 ? 0 : start, end), line.slice(0, start), details, group);
      const existing = state.fb[id];
      // An unknown, unactionable mention does not create an invented story fact.
      if (existing === undefined && action === undefined) continue;
      const item = existing ?? { content: "", plant_chapter: null, planned_reap: null, status: "未埋", reap_chapter: null, next: "" };
      item.next = line;
      if (action === "回收") {
        item.status = "已回收";
        item.reap_chapter = chapter;
      } else if ((action === "新埋" || action === "埋设") && item.status !== "已回收") {
        item.status = "已埋未收";
        item.plant_chapter ??= chapter;
      } else if (action === "推进" && item.status !== "已回收") item.status = "推进中";
      state.fb[id] = item;
    }
  }
}

export interface OriginalChangeInput {
  readonly chapter: number;
  readonly title: string;
  readonly change: string;
  readonly body: string;
  readonly chars: number;
}

/** Pure sequential application. The host's receipt owns idempotency and persistence. */
export function applyOriginalChange(previous: OriginalState, input: OriginalChangeInput): OriginalState {
  const { chapter, title, change, body, chars } = input;
  if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter !== previous.next_chapter) throw new Error("状态变更章号与已提交进度不一致，不会重复记账或跳章。");
  if (previous.total_chapters > 0 && chapter > previous.total_chapters) throw new Error("状态变更超过已导入的总章数。");
  if (!Number.isSafeInteger(chars) || chars < 0) throw new Error("实际字数无效。");
  const state = structuredClone(previous);
  const summary = extractOriginalField(change, "本章摘要");
  const hookType = extractOriginalField(change, "章尾钩类型");
  applyCharacters(state, extractOriginalField(change, "人物"));
  applyForeshadows(state, extractOriginalField(change, "伏笔"), chapter);
  state.recent = [...state.recent, { n: chapter, title, summary, hook_type: hookType }].slice(-12);
  if (hookType !== "" && safeName(hookType)) state.hook_type_counts[hookType] = (state.hook_type_counts[hookType] ?? 0) + 1;
  const pending = extractOriginalField(change, "下一章必须接住的事");
  if (pending !== "") state.pending = pending;
  const deviation = extractOriginalField(change, "与章纲不同的地方及原因");
  if (deviation !== "" && !EMPTY_VALUE.test(deviation)) state.deviations.push(`第${String(chapter)}章：${deviation}`);
  const time = extractOriginalField(change, "时间");
  state.chapter_meta[String(chapter)] = { chars, hook_type: hookType, ...(time === "" ? {} : { time }) };
  state.tail = body.replace(/\r\n?/gu, "\n").split("\n").map(line => line.trim()).filter(line => line !== "").slice(-3).join("\n");
  state.next_chapter = chapter + 1;
  return state;
}
