import { extractOriginalField } from "./original-state.js";
import { countSerialVisibleChars } from "./serial-outline.js";
import { originalOutputIssues, splitOriginalOutput } from "./serial-output.js";

/**
 * Host-side recovery for two production deadlocks:
 * a repeated chapter-end hook, and a repair reply that is only an edit note.
 * The original writing prompts stay unchanged. This module decides which draft
 * to keep and applies the smallest text change that lets acceptance continue.
 */
export const HOOK_TYPES = ["突然揭示", "紧急危机", "未完成动作", "身份反转", "两难抉择", "神秘物品", "倒计时", "承诺威胁", "离奇消失", "隐藏含义", "意象钩子", "回声钩子", "留白钩子", "系统激活", "选择型", "情感转折", "信息差", "时间跳跃"] as const;
const FIELD_NAMES = ["本章摘要", "实际字数", "章尾钩类型", "人物", "伏笔", "时间", "与章纲不同的地方及原因", "下一章必须接住的事"];
const FIELD_HEADING = new RegExp(`^[ \\t]*(?:[-*•][ \\t]*)?(?:\\*\\*)?(${FIELD_NAMES.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})(?:\\*\\*)?[ \\t]*[：:][ \\t]*(.*)$`, "u");
const ADVISORY = /建议(?:最小)?修改|建议采用|最小修改上一版|状态变更中改为|保留前文不动|将章尾[\s\S]{0,16}改为|我先核对工作区|当前任务是最小修订/u;
const ENGINEERING_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["上一章", "上一段日子"],
  ["前文", "先前"],
  ["本章", "眼下"],
  ["细纲", "原先的安排"],
  ["伏笔", "旧事"],
  ["读者", "看的人"]
];
const SUSPEND = "这一步停在做到一半的地方，结果还没有出来。";
const UNSTATED = "还有一处没有说开，在场的人暂时对不上。";

export interface ChapterDraft { readonly prose: string; readonly change: string }

export function stripChapterPreamble(text: string): string {
  const normalized = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  const heading = /第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*章/u.exec(normalized);
  if (heading === null || heading.index === 0) return normalized;
  const prefix = normalized.slice(0, heading.index).trim();
  if (prefix.length > 500 || !/^(?:我先|当前任务|下面是|建议)/u.test(prefix)) return normalized;
  return normalized.slice(heading.index).trim();
}

export function isAdvisoryChapterReply(text: string): boolean {
  const stripped = stripChapterPreamble(text);
  const prose = splitOriginalOutput(stripped).prose;
  const head = stripped.slice(0, 80);
  if (!ADVISORY.test(head) && !ADVISORY.test(stripped)) return false;
  return countSerialVisibleChars(prose) < 1501;
}

export function issuesAreLocallyRecoverable(issues: readonly string[]): boolean {
  return issues.length > 0 && issues.every(issue => /^(?:章尾钩类型「.+」与上一章重复|正文出现写作工程词「(?:本章|上一章|前文|伏笔|细纲|读者)」)/u.test(issue));
}

function setField(change: string, name: string, value: string): string {
  const lines = change.replace(/\r\n?/gu, "\n").split("\n");
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const match = FIELD_HEADING.exec(lines[index] ?? "");
    if (match === null) continue;
    if (start < 0) {
      if (match[1] === name) start = index;
      continue;
    }
    end = index;
    break;
  }
  const replacement = `- ${name}：${value}`;
  if (start < 0) return `${change.replace(/\s*$/u, "")}\n${replacement}`;
  return [...lines.slice(0, start), replacement, ...lines.slice(end)].join("\n");
}

function replaceEngineeringWords(prose: string): string {
  let next = prose;
  for (const [word, replacement] of ENGINEERING_REPLACEMENTS) next = next.replaceAll(word, replacement);
  return next;
}

function replacementHook(previousHook: string, hinted?: string): string {
  if (hinted !== undefined && (HOOK_TYPES as readonly string[]).includes(hinted) && hinted !== previousHook) return hinted;
  return previousHook === "未完成动作" ? "信息差" : "未完成动作";
}

function retargetHook(prose: string, change: string, previousHook: string, hinted?: string): ChapterDraft {
  const hook = replacementHook(previousHook, hinted);
  const sentence = hook === "未完成动作" ? SUSPEND : UNSTATED;
  const nextProse = prose.includes(sentence) ? prose : `${prose.replace(/\s*$/u, "")}\n${sentence}`;
  let nextChange = setField(change, "章尾钩类型", hook);
  const pending = extractOriginalField(nextChange, "下一章必须接住的事").replace(/\s+/gu, " ").trim();
  const follow = hook === "未完成动作" ? "先做完章尾停住的动作。" : "把还没有说开的那一处对上。";
  if (!pending.includes(follow)) nextChange = setField(nextChange, "下一章必须接住的事", pending === "" ? follow : `${follow}${pending.slice(0, 40)}`);
  const note = extractOriginalField(nextChange, "与章纲不同的地方及原因").trim();
  const extra = `相邻章钩子原为「${previousHook}」，已改为「${hook}」，避免连续两章使用同一种章尾钩。`;
  if (!note.includes("相邻章钩子")) {
    const empty = note === "" || /^(?:无|无变化|暂无|没有)[。.!！]?$/u.test(note);
    nextChange = setField(nextChange, "与章纲不同的地方及原因", empty ? extra : `${note} ${extra}`);
  }
  return { prose: nextProse, change: nextChange };
}

/** Repair only a repeated adjacent hook and engineering words. Any other defect stays unchanged. */
export function repairChapterDraft(prose: string, change: string, previousHook: string, requiredPlants: readonly string[] = []): { prose: string; change: string; issues: string[] } {
  const current = { prose: prose.trim(), change: change.trim() };
  const original = originalOutputIssues(current.prose, current.change, 1501, Number.MAX_SAFE_INTEGER, previousHook, requiredPlants);
  if (!issuesAreLocallyRecoverable(original)) return { ...current, issues: original };
  let next: ChapterDraft = { prose: replaceEngineeringWords(current.prose), change: current.change };
  const hook = extractOriginalField(next.change, "章尾钩类型");
  if (previousHook !== "" && hook === previousHook) next = retargetHook(next.prose, next.change, previousHook);
  const issues = originalOutputIssues(next.prose, next.change, 1501, Number.MAX_SAFE_INTEGER, previousHook, requiredPlants);
  return issues.length === 0 ? { ...next, issues } : { ...current, issues: original };
}

export function spliceAdvisoryEnding(previous: ChapterDraft, advice: string): ChapterDraft | undefined {
  if (!isAdvisoryChapterReply(advice)) return undefined;
  const hinted = /章尾钩类型[：:]\s*([^\s，。；\n]+)/u.exec(advice)?.[1];
  const nextPromise = /下一章必须接住的事[：:]\s*(.+)/u.exec(advice)?.[1]?.trim();
  const body = advice.split(/状态变更中改为|【状态变更】/u)[0] ?? advice;
  const cued = /将章尾[\s\S]{0,16}?改为[：:]/u.exec(body);
  const after = cued === null ? body : body.slice((cued.index ?? 0) + cued[0].length);
  const paragraphs = after.split(/\n+/u).map(line => line.trim()).filter(line => line !== ""
    && !/^(?:建议|状态变更|[-*•]?\s*(?:章尾钩类型|下一章必须接住的事))/u.test(line)
    && !ADVISORY.test(line));
  if (paragraphs.length === 0 || [...paragraphs.join("")].length < 12) return undefined;
  const blocks = previous.prose.trim().split(/\n{2,}/u).filter(block => block.trim() !== "");
  const usable = blocks.length > 1 ? blocks : previous.prose.trim().split(/\n/u).filter(line => line.trim() !== "");
  if (usable.length < 2) return undefined;
  const replaceCount = Math.min(paragraphs.length, usable.length - 1);
  let change = previous.change;
  if (hinted !== undefined && hinted !== "") change = setField(change, "章尾钩类型", hinted);
  if (nextPromise !== undefined && nextPromise !== "") change = setField(change, "下一章必须接住的事", nextPromise);
  return { prose: [...usable.slice(0, usable.length - replaceCount), ...paragraphs].join("\n\n"), change };
}

function draftRank(draft: ChapterDraft | undefined): number {
  if (draft === undefined) return Number.NEGATIVE_INFINITY;
  if (isAdvisoryChapterReply(`${draft.prose}\n\n${draft.change}`)) return -1;
  const chars = countSerialVisibleChars(draft.prose);
  let score = chars;
  if (!draft.change.includes("【状态变更】")) score -= 10_000;
  if (chars < 1501) score -= 5_000;
  return score;
}

/**
 * Prefer a complete acceptable chapter. An edit note must not replace a longer draft,
 * and a repeated hook or engineering word must not be the reason a full chapter is dropped.
 */
export function selectChapterDraft(options: {
  readonly incoming: string;
  readonly previous?: ChapterDraft;
  readonly previousHook: string;
  readonly requiredPlants?: readonly string[];
}): { prose: string; change: string; issues: string[] } {
  const plants = options.requiredPlants ?? [];
  const incoming = splitOriginalOutput(stripChapterPreamble(options.incoming));
  const incomingDraft: ChapterDraft = { prose: incoming.prose.trim(), change: incoming.change.trim() };
  const previous = options.previous === undefined ? undefined : { prose: options.previous.prose.trim(), change: options.previous.change.trim() };
  const spliced = previous === undefined ? undefined : spliceAdvisoryEnding(previous, options.incoming);
  const cleanOf = (draft: ChapterDraft | undefined) => draft === undefined ? undefined : repairChapterDraft(draft.prose, draft.change, options.previousHook, plants);
  const chosen = [cleanOf(incomingDraft), cleanOf(spliced), cleanOf(previous)].find(draft => draft !== undefined && draft.issues.length === 0);
  if (chosen !== undefined) return chosen;
  const raw = [incomingDraft, spliced, previous].filter((draft): draft is ChapterDraft => draft !== undefined);
  const best = raw.reduce((left, right) => draftRank(right) > draftRank(left) ? right : left);
  return { ...best, issues: originalOutputIssues(best.prose, best.change, 1501, Number.MAX_SAFE_INTEGER, options.previousHook, plants) };
}
