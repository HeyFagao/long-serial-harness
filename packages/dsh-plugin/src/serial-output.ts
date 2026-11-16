import { createHash } from "node:crypto";
import type { FsVersion } from "@deepseek-ai/dsh-fs";
import { countSerialVisibleChars, parseSerialOutline } from "./serial-outline.js";
import type { SerialActive } from "./serial-runtime.js";
import { applyOriginalChange, initializeOriginalState, extractOriginalField, type OriginalState } from "./original-state.js";
import { normalizeOriginalFbId, parseOriginalChapterPlan } from "./original-outline-plan.js";
import { creativeTarget, readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "./workspace-route.js";

const TRACKING = "追踪/_tracking-state.json";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const BANNED_WORDS = ["铁锈味", "血腥味", "腥甜", "甜腻", "黏腻", "湿冷", "阴冷", "霉味", "土腥味", "呼吸一滞", "眸光一闪", "瞳孔骤缩", "心头一紧", "笑意凝固", "神色一凛", "骤然", "猛然", "旋即", "顿时", "愈发", "陡然", "极致", "幽幽"];
const ENGINEERING_WORDS = ["本章", "上一章", "前文", "伏笔", "细纲", "读者"];

interface WordcountReceipt {
  metric: "visible_chars_v1";
  actual: number;
  body_sha256: string;
  resolution: "within_user_band";
  taskId: string;
  childSessionId: string;
  change_sha256: string;
  record_sha256: string;
}
export interface OriginalPendingChapter {
  taskId: string;
  childSessionId: string;
  prosePath: string;
  body_sha256: string;
  change_sha256: string;
  record_sha256: string;
  issues: string[];
}
export interface OriginalTrackingLedger {
  kind: "serial-original";
  schema_version: 1;
  last_committed_chapter: number;
  state_revision: number;
  wordcount_records: Record<string, WordcountReceipt>;
  pending_chapters: Record<string, OriginalPendingChapter>;
  original_state: OriginalState;
}
export interface OriginalOutputOptions {
  readonly active: SerialActive;
  readonly taskId: string;
  readonly text: string | undefined;
  readonly minChars?: number;
  readonly maxChars?: number;
  readonly totalChapters: number;
  readonly title?: string;
  readonly bookTitle?: string;
  readonly chapterRaw?: string;
  readonly outlineSource?: string;
}
interface FileSnapshot { content: string; version: FsVersion; sha256: string }
interface OutputFile { path: string; content: string; sha256: string; beforeSha256: string | null }
interface OutputTransaction {
  kind: "serial-original-output";
  schemaVersion: 1;
  taskId: string;
  childSessionId: string;
  requestId: string;
  chapter: number;
  textSha256: string;
  trackingBeforeSha256: string | null;
  files: OutputFile[];
  ledger: OriginalTrackingLedger;
  issues: string[];
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function object(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

export function isOriginalTrackingLedger(value: unknown): value is OriginalTrackingLedger {
  const row = object(value);
  return row?.kind === "serial-original" && row.schema_version === 1
    && Number.isSafeInteger(row.last_committed_chapter) && Number(row.last_committed_chapter) >= 0
    && Number.isSafeInteger(row.state_revision) && Number(row.state_revision) >= 0
    && object(row.wordcount_records) !== undefined && object(row.pending_chapters) !== undefined
    && object(row.original_state) !== undefined;
}

/** The original split_output contract: the state marker and everything after it stay out of prose. */
export function splitOriginalOutput(text: string): { prose: string; change: string } {
  const split = text.indexOf("【状态变更】");
  return split < 0 ? { prose: text.trim(), change: "" } : { prose: text.slice(0, split).trim(), change: text.slice(split).trim() };
}

/** Programmatic checks retained from the original workbench, not a second model/rewriting prompt. */
export function originalOutputIssues(prose: string, change: string, minChars: number, maxChars: number, previousHook = "", requiredPlants: readonly string[] = []): string[] {
  const issues: string[] = [];
  const chars = countSerialVisibleChars(prose);
  if (chars < minChars || chars > maxChars) issues.push(maxChars === Number.MAX_SAFE_INTEGER ? `正文字数 ${String(chars)}，需超过1500字。` : `字数 ${String(chars)} 不在 ${String(minChars)}-${String(maxChars)} 区间，需增删到区间内。`);
  if (change === "") issues.push("缺少【状态变更】区块，必须按字段补齐。");
  if (extractOriginalField(change, "本章摘要") === "") issues.push("状态变更缺少「本章摘要」。");
  const hook = extractOriginalField(change, "章尾钩类型");
  if (hook === "") issues.push("状态变更缺少「章尾钩类型」。");
  for (const word of ENGINEERING_WORDS) if (prose.includes(word)) issues.push(`正文出现写作工程词「${word}」，改成角色可感知的事件锚点或相对时间。`);
  for (const word of BANNED_WORDS) if (prose.includes(word)) issues.push(`正文命中去AI味禁词「${word}」，删除或改写该句。`);
  if (prose.includes("——") || prose.includes("—") || prose.includes("––")) issues.push("叙述中出现破折号，改用逗号、句号或拆句（对话被打断除外）。");
  if (/\*\*|__|^\s*#{1,6}\s/mu.test(prose)) issues.push("正文含 Markdown 加粗或标题符号，去掉标记，保留纯文本。");
  if (/^\s*```|<\/?(?:think|analysis)>|^\s*(?:Traceback \(most recent call last\)|Error:)/mu.test(prose)) issues.push("正文混入代码、模型分析或运行日志。");
  if (previousHook !== "" && previousHook === hook) issues.push(`章尾钩类型「${hook}」与上一章重复，换一种钩子写法与类型。`);
  // Same original required-plant check, with zero-padding normalized so FB1,
  // FB01 and FB001 cannot accidentally become three different story threads.
  const reported = new Set([...change.matchAll(/FB\s*0*(\d+)/gu)].map(match => normalizeOriginalFbId(match[1]!)));
  for (const id of requiredPlants) if (!reported.has(id)) issues.push(`细纲要求埋设 ${id}，状态变更伏笔栏未见记录，请补写落点并登记。`);
  return issues;
}

async function read(realm: WorkspaceRealm, path: string): Promise<FileSnapshot | undefined> {
  const target = await creativeTarget(realm, path);
  if (await realm.fs.stat(target) === undefined) return undefined;
  const current = await readVersionedFile(realm.fs, target, MAX_OUTPUT_BYTES * 4);
  return { ...current, sha256: sha256(current.content) };
}
async function write(realm: WorkspaceRealm, path: string, content: string, previous?: FileSnapshot): Promise<void> {
  await realm.fs.writeText(await creativeTarget(realm, path), content,
    previous === undefined ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version: previous.version },
    undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
}

async function prosePath(realm: WorkspaceRealm, chapter: number): Promise<string> {
  const root = await realm.fs.resolve("正文", { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, root)) throw new WorkspaceHttpError(403, "正文目录离开了当前小说项目。");
  const names: string[] = [];
  const info = await realm.fs.stat(root);
  if (info !== undefined && info.type !== "directory") throw new WorkspaceHttpError(409, "正文路径不是目录。");
  if (info !== undefined) {
    for (const file of await realm.fs.listDir(root)) {
      if (file.type !== "file" || !realm.fs.contains(realm.root, file.target)) continue;
      const match = /^第0*(\d+)章.*\.(?:md|txt)$/u.exec(file.name);
      if (match !== null && Number(match[1]) === chapter) names.push(`正文/${file.name}`);
    }
  }
  if (names.length > 1) throw new WorkspaceHttpError(409, `第 ${String(chapter)} 章存在多份正文，请先核对，宿主不会任意覆盖。`);
  return names[0] ?? `正文/第${String(chapter).padStart(3, "0")}章.md`;
}

function parseLedger(snapshot: FileSnapshot | undefined, options: OriginalOutputOptions): OriginalTrackingLedger {
  if (snapshot === undefined) {
    const chapters = options.outlineSource === undefined ? [] : parseSerialOutline(options.outlineSource).chapters;
    const originalState = initializeOriginalState(chapters, options.totalChapters, options.bookTitle);
    return { kind: "serial-original", schema_version: 1, last_committed_chapter: 0, state_revision: 0, wordcount_records: {}, pending_chapters: {}, original_state: originalState };
  }
  const parsed: unknown = JSON.parse(snapshot.content);
  if (isOriginalTrackingLedger(parsed)) return structuredClone(parsed);
  const legacy = object(parsed);
  // An empty old setup has no committed prose or narrative memory to migrate.
  if (legacy?.schema_version === 4 && legacy.last_committed_chapter === 0) return parseLedger(undefined, options);
  throw new WorkspaceHttpError(409, "已有旧版追踪正文需要先完成明确迁移；原账本已保留，不会猜测人物状态或覆盖旧稿。");
}

function transactionOf(raw: string): OutputTransaction {
  const value = object(JSON.parse(raw));
  if (value?.kind !== "serial-original-output" || value.schemaVersion !== 1 || !Array.isArray(value.files)
    || !isOriginalTrackingLedger(value.ledger) || !Array.isArray(value.issues)) throw new WorkspaceHttpError(409, "本章落盘事务损坏，已保留原文件。");
  return value as unknown as OutputTransaction;
}

/** Host-owned transaction: manuscript + original state text first; the acceptance ledger is always last. */
export async function commitOriginalOutput(realm: WorkspaceRealm, options: OriginalOutputOptions): Promise<{ accepted: boolean; issues: readonly string[]; prosePath: string }> {
  const { active, taskId } = options;
  if (![taskId, active.sessionId, active.requestId].every(id => /^[A-Za-z0-9_-]{1,128}$/u.test(id))) throw new WorkspaceHttpError(400, "本章输出事务身份无效。");
  if (!Number.isSafeInteger(active.chapter) || active.chapter < 1) throw new WorkspaceHttpError(400, "本章输出章号无效。");
  if (options.text === undefined || options.text.trim() === "") throw new WorkspaceHttpError(409, "章节会话结束但没有可保存的最终正文，请查看该章原生会话。");
  if (Buffer.byteLength(options.text, "utf8") > MAX_OUTPUT_BYTES) throw new WorkspaceHttpError(413, "本章输出超过 2 MB，已停止落盘，不会截断内容。");
  const transactionPath = `追踪/连载输出/${taskId}/${active.sessionId}.json`;
  let transactionSnapshot = await read(realm, transactionPath);
  let transaction: OutputTransaction;
  if (transactionSnapshot !== undefined) {
    transaction = transactionOf(transactionSnapshot.content);
    if (transaction.taskId !== taskId || transaction.childSessionId !== active.sessionId || transaction.requestId !== active.requestId
      || transaction.chapter !== active.chapter || transaction.textSha256 !== sha256(options.text)) throw new WorkspaceHttpError(409, "同一章节会话的最终输出发生变化，已保留首次输出，不会替换落盘事务。");
  } else {
    const tracking = await read(realm, TRACKING);
    const ledger = parseLedger(tracking, options);
    if (ledger.last_committed_chapter >= active.chapter) throw new WorkspaceHttpError(409, "本章已经验收，拒绝用其他章节会话覆盖已完成正文。");
    if (ledger.last_committed_chapter !== active.chapter - 1) throw new WorkspaceHttpError(409, "前章尚未验收，不能跳章保存本章输出。");
    const { prose, change } = splitOriginalOutput(options.text);
    if (prose === "") throw new WorkspaceHttpError(409, "最终回复只有状态变更，没有正文，未覆盖任何文件。");
    const chars = countSerialVisibleChars(prose);
    const lastHook = ledger.original_state.recent.at(-1)?.hook_type ?? "";
    const requiredPlants = parseOriginalChapterPlan(options.chapterRaw ?? "").fb_plant;
    const issues = originalOutputIssues(prose, change, 1501, Number.MAX_SAFE_INTEGER, lastHook, requiredPlants);
    const title = options.title?.trim() || `第${String(active.chapter)}章`;
    const path = await prosePath(realm, active.chapter);
    const suffix = `第${String(active.chapter).padStart(3, "0")}章.md`;
    const body = `${prose}\n`;
    const changeText = change === "" ? "" : `${change}\n`;
    const summary = extractOriginalField(change, "本章摘要") || "待补齐本章摘要";
    const pending = extractOriginalField(change, "下一章必须接住的事") || "待补齐下一章承接事项";
    const record = `# 第${String(active.chapter).padStart(3, "0")}章 · ${title}\n\n- 结果：${summary.replace(/\n/gu, " ")}\n- 下一章承诺：${pending.replace(/\n/gu, " ")}\n\n${changeText}`;
    const previous = ledger.pending_chapters[String(active.chapter)];
    if (previous !== undefined && (previous.taskId !== taskId || active.repairIssues === undefined)) throw new WorkspaceHttpError(409, "本章现稿属于另一次待验收输出；只有明确修订轮次可以替换它。");
    const proposed = [
      { path, content: body, ownerHash: previous?.body_sha256 },
      { path: `追踪/状态变更/${suffix}`, content: changeText, ownerHash: previous?.change_sha256 },
      { path: `追踪/逐章记录/${suffix}`, content: record, ownerHash: previous?.record_sha256 }
    ];
    const files: OutputFile[] = [];
    for (const item of proposed) {
      const existing = await read(realm, item.path);
      if (existing !== undefined && (item.ownerHash === undefined || existing.sha256 !== item.ownerHash)) throw new WorkspaceHttpError(409, `${item.path} 不是本次可修订的原稿，已停止，现有文件未覆盖。`);
      files.push({ path: item.path, content: item.content, sha256: sha256(item.content), beforeSha256: existing?.sha256 ?? null });
    }
    const candidate: OriginalPendingChapter = { taskId, childSessionId: active.sessionId, prosePath: path,
      body_sha256: files[0]!.sha256, change_sha256: files[1]!.sha256, record_sha256: files[2]!.sha256, issues };
    if (issues.length === 0) {
      ledger.original_state = applyOriginalChange(ledger.original_state, { chapter: active.chapter, title, change, body: prose, chars });
      ledger.last_committed_chapter = active.chapter;
      ledger.state_revision += 1;
      ledger.wordcount_records[String(active.chapter)] = { metric: "visible_chars_v1", actual: chars,
        body_sha256: candidate.body_sha256, resolution: "within_user_band", taskId, childSessionId: active.sessionId,
        change_sha256: candidate.change_sha256, record_sha256: candidate.record_sha256 };
      delete ledger.pending_chapters[String(active.chapter)];
    } else ledger.pending_chapters[String(active.chapter)] = candidate;
    transaction = { kind: "serial-original-output", schemaVersion: 1, taskId, childSessionId: active.sessionId,
      requestId: active.requestId, chapter: active.chapter, textSha256: sha256(options.text),
      trackingBeforeSha256: tracking?.sha256 ?? null, files, ledger, issues };
    await write(realm, transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
    transactionSnapshot = await read(realm, transactionPath);
    if (transactionSnapshot === undefined) throw new WorkspaceHttpError(409, "本章落盘事务未能持久保存。");
  }
  const expectedLedger = `${JSON.stringify(transaction.ledger, null, 2)}\n`;
  const existingLedger = await read(realm, TRACKING);
  const alreadyApplied = existingLedger?.content === expectedLedger;
  if (!alreadyApplied && (existingLedger?.sha256 ?? null) !== transaction.trackingBeforeSha256) throw new WorkspaceHttpError(409, "追踪账本在本章落盘期间已变化，未覆盖正文或进度，请核对后继续。");
  // Preflight all outputs before writing the first one. A crash between writes is safe to replay.
  for (const file of transaction.files) {
    if (sha256(file.content) !== file.sha256) throw new WorkspaceHttpError(409, "本章落盘事务内容哈希不一致。");
    const current = await read(realm, file.path);
    if (alreadyApplied && current?.sha256 !== file.sha256) throw new WorkspaceHttpError(409, `${file.path} 在落盘后已被修改或删除，保留作者操作，不重写已记录稿件。`);
    if (current?.sha256 !== file.sha256 && (current?.sha256 ?? null) !== file.beforeSha256) throw new WorkspaceHttpError(409, `${file.path} 已被修改，停止恢复以保留作者改稿。`);
  }
  for (const file of transaction.files) {
    const current = await read(realm, file.path);
    if (current?.sha256 === file.sha256) continue;
    if ((current?.sha256 ?? null) !== file.beforeSha256) throw new WorkspaceHttpError(409, `${file.path} 在落盘期间变化，已停止。`);
    await write(realm, file.path, file.content, current);
  }
  if (!alreadyApplied) await write(realm, TRACKING, expectedLedger, existingLedger);
  return { accepted: transaction.issues.length === 0, issues: transaction.issues, prosePath: transaction.files[0]!.path };
}
