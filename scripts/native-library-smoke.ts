/** Packaged novel library: real DSH/native sessions/browser, local text-only model, no paid API. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { chromium, type Browser, type Page, type Response as BrowserResponse } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { ORIGINAL_SYSTEM_PROMPT, ORIGINAL_SYSTEM_PROMPT_SHA256 } from "../packages/dsh-plugin/src/original-prompts.js";
import { AUTHOR_CHAPTER_TITLE_PROMPT } from "../packages/dsh-plugin/src/wechat-title-author-prompt.js";
import type { LibraryBook, LibrarySnapshot } from "../packages/dsh-plugin/src/serial-library.js";
import type { LibraryTask } from "../packages/dsh-plugin/src/serial-library-runtime.js";
import type { SerialTask } from "../packages/dsh-plugin/src/serial-runtime.js";
import type { SerialModelSelection, SerialModelCatalog } from "../packages/dsh-plugin/src/serial-model-selection.js";
import { deterministicNativeOutput } from "./serial-fixtures/native-output.js";
import { authorizeDsh, dshFetch, freePort, isolateFirstUseWorkspace, rpc, stopDshProcess } from "./native-dsh-helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.DSH_TEST_VERSION ?? "0.2.2-rc.3";
const evidence = resolve(process.env.LIBRARY_EVIDENCE_DIR ?? join(root, "..", "library-evidence"));
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sleep = (milliseconds: number): Promise<void> => new Promise(done => setTimeout(done, milliseconds));
const keys = Array.from({ length: 10 }, (_, index) => `SMOKEBOOK${String(index + 1).padStart(2, "0")}`);
const deletionKeys = ["SMOKEBOOK11", "SMOKEBOOK12"] as const;
const selectionKeys = ["SMOKEBOOK13", "SMOKEBOOK14", "SMOKEBOOK15"] as const;
const selectionTotals: Readonly<Record<string, number>> = { SMOKEBOOK13: 12, SMOKEBOOK14: 3, SMOKEBOOK15: 2 };
const selectionAccepted: Readonly<Record<string, number>> = { SMOKEBOOK13: 10, SMOKEBOOK14: 3, SMOKEBOOK15: 2 };
const baseChapters = 152;
const selectedChapters = 15;
const totalAcceptedChapters = baseChapters + selectedChapters;
const totalFor = (key: string): number => process.env.LIBRARY_MODEL_ONLY === "1" && key === keys[1] ? 2
  : process.env.LIBRARY_MODEL_ONLY === "1" && key === keys[2] ? 1
  : selectionTotals[key] ?? (keys.includes(key) && keys.indexOf(key) < 2 ? 32 : 11);
const chapterPath = (chapter: number): string => `正文/第${String(chapter).padStart(3, "0")}章.md`;
const titleFor = (key: string): string => `回归小说${key.slice(-2)}`;
function titleCandidates(chapter: number): readonly string[] {
  const candidates = [`第${String(chapter)}本账刚核清，无名信却送来了原始契约`, `她合上第${String(chapter)}本账册，一封无名信让旧案再起波澜`,
    `第${String(chapter)}次核账刚结束，她寻找的契约竟被送上门`, `沈宁核清第${String(chapter)}本旧账，无名来信藏着关键物证`, `第${String(chapter)}本账册背后，那张失踪的契约终于出现`];
  assert(candidates.every(title => [...title].length >= 15 && [...title].length <= 25));
  return candidates;
}
function checkExportedTitle(text: string): void {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  assert.equal(lines[0], "本章备选标题（任选一个用于发布）", "TXT must begin with the five saved title options");
  const number = /^1\. 第(\d+)本账刚核清/u.exec(lines[1] ?? "")?.[1]; assert(number !== undefined, "TXT is missing its numbered candidate titles");
  assert.deepEqual(lines.slice(1, 6), titleCandidates(Number(number)).map((title, index) => `${String(index + 1)}. ${title}`));
  assert(!/coreHook|titleStrategy|topThree|candidates|番茄标签配置|【最终标签】/u.test(text), "Title analysis or tags leaked into the chapter TXT");
}
function redact(value: string): string { return value.replace(/([?&]token=)[^\s"'<>]+/gu, "$1[REDACTED]"); }
function command(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(program, args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`${program} failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function sourceFor(key: string): string {
  return ["&&&开书信息&&&", `书本名称：${titleFor(key)}`, "简介：确定性多书集成样本。", "&&&核心设定&&&", `${key}的主人公沿河核对账册。`,
    "&&&文风&&&", `文风唯一标记 ${key}_STYLE_START：具体动作推进调查，保持账目和人物认知连续。`, `完整文风末尾标记 ${key}_STYLE_END。`, "&&&章纲&&&",
    ...Array.from({ length: totalFor(key) }, (_, index) => [`第${String(index + 1)}章：${key}第${String(index + 1)}次核账`, "本章出场人物：沈宁", "▶ 剧情点一：沈宁核对旧账发现一条遗漏的记录。", "▶ 剧情点二：沈宁当面核查凭据，确认经手人的地址。", "◆ 情绪变化曲线：疑惑 → 专注 → 决断", "本章钩子：信封里出现另一张契约。", "◆ 写作重点：用行动推进，保留人物认知边界。", "字数目标：2400", "字数范围：2300-2500", ""].join("\n"))].join("\n");
}
interface WireMessage { readonly role?: string; readonly content?: unknown }
interface Block { readonly type?: string; readonly text?: string }
interface Answer { readonly key: string; readonly chapter: number; readonly sessionId: string; readonly text: string }
interface WireSelection { readonly key: string; readonly chapter: number; readonly kind: "body" | "title"; readonly sessionId: string; readonly model: string; readonly reasoningEffort?: string }
interface ModelFixture { server: Server; baseURL: string; books: Map<string, LibraryBook>; answers: Answer[]; titles: Answer[]; titleRetried: boolean; waiting: Set<string>; holds: Set<string>; failures: string[]; requests: number; wireSelections: WireSelection[]; shortDraft?: { readonly text: string; readonly sessionId: string }; rewritePassed: boolean }
function blocks(message: WireMessage): readonly Block[] { return Array.isArray(message.content) ? message.content as Block[] : typeof message.content === "string" ? [{ type: "text", text: message.content }] : []; }
function fixtureOutput(bookKey: string, chapter: number, minChars?: number): string {
  const text = deterministicNativeOutput({ bookKey, chapter, ...(minChars === undefined ? {} : { minChars }) });
  return process.env.LIBRARY_UPGRADE_ONLY === "1" ? text.replace(/^第\d+章[^\n]*/u, `第${String(chapter)}章 核账`) : text;
}
async function assertPrompt(book: LibraryBook, key: string, chapter: number, prompt: string): Promise<void> {
  assert(!prompt.includes("【微信公众号小说长标题】") && !prompt.includes("【微信公众号小说章节标题】") && !prompt.includes("【独立标题任务】")
    && !prompt.includes(AUTHOR_CHAPTER_TITLE_PROMPT.slice(0, 120)), "Title instructions leaked into writing request");
  assert(prompt.startsWith(ORIGINAL_SYSTEM_PROMPT), "The original SYSTEM prompt was replaced or shortened");
  assert.equal(digest(ORIGINAL_SYSTEM_PROMPT), ORIGINAL_SYSTEM_PROMPT_SHA256);
  assert(prompt.includes("【本章细纲】") && prompt.includes("【发散等级】"), "Original USER template missing");
  assert(!/story-long-write|narrative-writer|build_writer_prompt|storyctl\.py/u.test(prompt), "Upstream writing instructions leaked into the original-prompt task");
  assert.deepEqual([...new Set(prompt.match(/SMOKEBOOK\d{2}/gu))], [key], "The new chapter received another book's context");
  const style = await readFile(join(book.absolutePath, "设定/文风.md"), "utf8");
  assert(prompt.includes(style), `Complete style missing for ${key}/${String(chapter)}`);
  assert.equal(prompt.split(`${key}_STYLE_START`).length - 1, 1, "Style was duplicated instead of loaded once");
  for (const label of ["一、当前进度", "二、人物状态", "三、伏笔台账", "四、本章必须接住的事", "五、最近章节摘要", "六、最近章节钩子类型"]) assert(prompt.includes(label), `Original dossier field missing: ${label}`);
  if (chapter > 1) {
    assert(prompt.includes(`第${String(chapter - 1)}章《${key}第${String(chapter - 1)}次核账》`), "Prior chapter state is absent or has the book title");
    assert(prompt.includes(`核查${key}契约的来路。`), "Pending continuity promise was not loaded");
    const ledger = JSON.parse(await readFile(join(book.absolutePath, "追踪/_tracking-state.json"), "utf8")) as { readonly last_committed_chapter: number };
    assert.equal(ledger.last_committed_chapter, chapter - 1, "The host advanced narrative state before accepting this chapter");
  }
  const attachment = prompt.slice(prompt.indexOf("## 宿主已核验的本章参考全文"));
  assert(attachment.startsWith("## 宿主已核验的本章参考全文"));
  const recent = Array.from({ length: Math.min(chapter - 1, 10) }, (_, index) => Math.max(1, chapter - 10) + index);
  const paths = [...attachment.matchAll(/^### 参考文件：([^\r\n]+)$/gmu)].map(match => match[1]!);
  assert.deepEqual(paths, recent.map(chapterPath), `Wrong prior-chapter window for ${key}/${String(chapter)}`);
  const line = attachment.split("\n").find(value => value.startsWith('{"schemaVersion":1,"chapter":'));
  assert(line !== undefined);
  const manifest = JSON.parse(line) as { readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[]; readonly range: { readonly from: number; readonly to: number } };
  assert.deepEqual(manifest.range, { from: Math.max(1, chapter - 10), to: chapter - 1 });
  assert.deepEqual(manifest.files.map(file => file.path), ["设定/文风.md", ...paths]);
  for (const file of manifest.files) {
    const original = await readFile(join(book.absolutePath, file.path), "utf8");
    assert.equal(file.bytes, Buffer.byteLength(original)); assert.equal(file.sha256, digest(original));
    assert(prompt.includes(original), `${key}/${String(chapter)} reference ${file.path} was truncated`);
  }
  if (chapter > 11) assert(!attachment.includes(`沈宁抵达城南的第${String(chapter - 11)}天，`), "Older prose escaped the ten-chapter window");
}
async function startModel(): Promise<ModelFixture> {
  const model: ModelFixture = { server: undefined as unknown as Server, baseURL: "", books: new Map(), answers: [], titles: [], titleRetried: false, waiting: new Set(), holds: new Set(), failures: [], requests: 0, wireSelections: [], rewritePassed: false };
  const server = createServer((request, response) => {
    let body = "";
    // Full Chinese prose spans HTTP chunks; the streaming decoder preserves split UTF-8 codepoints.
    request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", async () => {
      try {
        if (request.method !== "POST" || !request.url?.endsWith("/v1/messages")) { response.writeHead(404).end(); return; }
        model.requests += 1;
        const payload = JSON.parse(body) as { readonly model?: string; readonly messages?: readonly WireMessage[]; readonly output_config?: { readonly effort?: string }; readonly thinking?: { readonly type?: string } };
        const messages = payload.messages ?? [];
        const matching = messages.filter(message => message.role === "user").map(message => blocks(message).map(block => block.text ?? "").join("\n")).filter(text => /本轮只完成当前工作区这本书的第 \d+ 章/u.test(text));
        const titlePrompts = messages.filter(message => message.role === "user").map(message => blocks(message).map(block => block.text ?? "").join("\n")).filter(text => text.includes("【独立标题任务】"));
        let text = "LIBRARY_SMOKE_READY";
        if (matching.length > 0) {
          assert.equal(matching.length, 1, "A fresh chapter inherited a prior chapter's prompt");
          const prompt = matching[0]!;
          const chapter = Number(/本轮只完成当前工作区这本书的第 (\d+) 章/u.exec(prompt)?.[1]);
          const key = /SMOKEBOOK\d{2}/u.exec(prompt)?.[0];
          assert(key !== undefined && model.books.has(key));
          const identity = `${key}/${String(chapter)}`;
          model.waiting.add(identity);
          while (model.holds.has(identity) && !response.destroyed) await sleep(50);
          model.waiting.delete(identity);
          if (response.destroyed) return;
          await assertPrompt(model.books.get(key)!, key, chapter, prompt);
          const sessionId = request.headers["x-deepseek-harness-session-id"];
          assert(typeof sessionId === "string" && sessionId !== "");
          assert(typeof payload.model === "string");
          model.wireSelections.push({ key, chapter, kind: "body", sessionId, model: payload.model,
            ...(payload.thinking?.type === "disabled" ? { reasoningEffort: "off" } : payload.output_config?.effort === undefined ? {} : { reasoningEffort: payload.output_config.effort }) });
          if (key === keys[0] && chapter === 3 && model.shortDraft === undefined) {
            text = fixtureOutput(key, chapter, 400);
            model.shortDraft = { text, sessionId };
          } else {
            if (key === keys[0] && chapter === 3) {
              assert(model.shortDraft !== undefined && model.shortDraft.sessionId !== sessionId, "Repair reused the failed writing conversation");
              for (const originalText of ["下面是你上一版章节正文与状态变更，程序检测发现以下问题：", "请通读原文，只针对上述问题做最小修改，保留其余内容、人物与剧情走向不变。", "【上一版原文】"]) assert(prompt.includes(originalText), "The original REWRITE template was replaced");
              const split = model.shortDraft.text.indexOf("【状态变更】");
              assert(prompt.includes(model.shortDraft.text.slice(0, split).trim()) && prompt.includes(model.shortDraft.text.slice(split).trim()), "Repair did not receive both original output blocks");
              model.rewritePassed = true;
            }
            text = fixtureOutput(key, chapter);
            model.answers.push({ key, chapter, sessionId, text });
          }
        }
        if (titlePrompts.length > 0) {
          assert.equal(titlePrompts.length, 1); assert.equal(matching.length, 0);
          const prompt = titlePrompts[0]!;
          assert(!prompt.includes(ORIGINAL_SYSTEM_PROMPT) && !prompt.includes("【本章细纲】") && !prompt.includes("_STYLE_START"), "Title request inherited writing context");
          assert(prompt.includes(AUTHOR_CHAPTER_TITLE_PROMPT.replace("{{步骤 1.output}}", "本次材料见下方 chapter_body 内的当前章正文。")), "Author-supplied title prompt was omitted or rewritten");
          const key = /SMOKEBOOK\d{2}/u.exec(prompt)?.[0]; assert(key !== undefined && model.books.has(key));
          const chapter = Number(/章号：(\d+)/u.exec(prompt)?.[1]);
          const prose = await readFile(join(model.books.get(key)!.absolutePath, chapterPath(chapter)), "utf8");
          const attached = prompt.slice(prompt.indexOf("<chapter_body>\n") + "<chapter_body>\n".length, prompt.lastIndexOf("\n</chapter_body>"));
          assert.equal(attached, prose, "Title task must receive only this saved chapter in full");
          const sessionId = request.headers["x-deepseek-harness-session-id"]; assert(typeof sessionId === "string");
          assert(typeof payload.model === "string");
          model.wireSelections.push({ key, chapter, kind: "title", sessionId, model: payload.model,
            ...(payload.thinking?.type === "disabled" ? { reasoningEffort: "off" } : payload.output_config?.effort === undefined ? {} : { reasoningEffort: payload.output_config.effort }) });
          assert(!model.answers.some(item => item.sessionId === sessionId));
          if (!model.titleRetried) { text = "模拟标题格式失败"; model.titleRetried = true; }
          else {
            const candidates = titleCandidates(chapter);
            text = JSON.stringify({ coreHook: "核清旧账后收到一直寻找的原始契约", titleStrategy: "用无名来信与关键物证制造悬念", candidates, topThree: candidates.slice(0, 3),
              tags: { category: "悬疑惊悚", plots: ["推理", "大女主"], roles: ["女配", "女总裁"], emotion: "爽文", background: "古代" },
              evidence: [prose.split("\n").find(line => line.includes("账册合拢时"))!.slice(0, 80)] });
            model.titles.push({ key, chapter, sessionId, text });
          }
          assert.equal(await readFile(join(model.books.get(key)!.absolutePath, chapterPath(chapter)), "utf8"), prose);
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const events = [
          { type: "message_start", message: { id: crypto.randomUUID(), type: "message", role: "assistant", model: "local-novel-fixture", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2000 } }, { type: "message_stop" }
        ];
        for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      } catch (error) { model.failures.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
    });
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert(address !== null && typeof address !== "string");
  Object.assign(model, { server, baseURL: `http://127.0.0.1:${String(address.port)}` }); return model;
}
async function api<T>(origin: string, path: string, sessionId: string, input?: object): Promise<T> {
  const response = await dshFetch(`${origin}/oh-story/${path}?sessionId=${encodeURIComponent(sessionId)}`, input === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const result: unknown = await response.json(); assert(response.ok, `${path} HTTP ${String(response.status)}: ${JSON.stringify(result)}`); return result as T;
}
async function waitFor(condition: () => Promise<boolean>, description: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await sleep(100); }
  throw new Error(`Timed out: ${description}`);
}
async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return true; throw error; }
}
async function queue(origin: string, sessionId: string, input?: object): Promise<LibraryTask | null> { return (await api<{ readonly task: LibraryTask | null }>(origin, "library/queue", sessionId, input)).task; }
async function waitQueue(origin: string, sessionId: string, accept: (task: LibraryTask) => boolean): Promise<LibraryTask> {
  let last = ""; let result: LibraryTask | null = null;
  await waitFor(async () => {
    result = await queue(origin, sessionId); if (result === null) return false;
    const chapters = result.books.reduce((sum, book) => sum + book.completedChapters, 0);
    const mark = `${result.status}/${String(Math.floor(chapters / 10))}`;
    if (mark !== last) { process.stdout.write(`library ${result.status} accepted=${String(chapters)} books=${String(result.books.filter(book => book.status === "completed").length)}\n`); last = mark; }
    if (accept(result)) return true;
    assert(result.status !== "blocked" && result.status !== "stopped", `Unexpected queue state: ${JSON.stringify(result)}`);
    return false;
  }, "library queue condition", 600_000);
  return result!;
}
async function waitNativeRequest(origin: string, sessionId: string, model: ModelFixture, identity: string): Promise<void> {
  await waitFor(async () => {
    if (model.waiting.has(identity)) return true;
    const task = await queue(origin, sessionId);
    assert(task !== null && ["running", "pausing"].includes(task.status), `Queue ended before native request ${identity}: ${JSON.stringify(task)}`);
    return false;
  }, `native text request ${identity}`);
}
async function clickQueue(page: Page, name: string): Promise<void> {
  if (["本章后暂停所有项目", "继续本批项目", "停止所有项目"].includes(name)) {
    const details = page.locator("details.book-library-queue");
    await details.waitFor({ state: "attached", timeout: 20_000 });
    if (await details.getAttribute("open") === null) await details.locator("summary").first().click();
  }
  const response = page.waitForResponse(item => item.url().includes("/oh-story/library/queue?") && item.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name, exact: true }).click({ timeout: 20_000 }); assert.equal((await response).status(), 200);
}
async function checkLibraryLayout(page: Page): Promise<void> {
  const layout = page.locator('.novel-layout[data-view="library"]');
  const bounds = await layout.boundingBox(); const controls = await layout.locator(":scope > .novel-controls").boundingBox();
  assert(bounds !== null && controls !== null && controls.width >= bounds.width - 2, "Library controls remained in the narrow book-editor sidebar");
  await page.getByRole("list", { name: "小说项目列表" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "library-import.png"), animations: "disabled" });
  await page.setViewportSize({ width: 720, height: 1000 });
  await waitFor(async () => await layout.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "narrow library without horizontal overflow");
  await page.getByRole("list", { name: "小说项目列表" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "library-import-narrow.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function checkReadonlyLibraryRecords(page: Page): Promise<void> {
  const records = page.locator("details.novel-library-records");
  await records.waitFor({ state: "attached", timeout: 20_000 });
  assert.equal(await records.getAttribute("open"), null, "Internal records opened automatically");
  assert.equal(await records.locator('button[aria-current="true"]').count(), 0, "An internal JSON record was selected automatically");
  await records.locator(":scope > summary").click();
  const tracking = records.locator("nav > details");
  if (await tracking.getAttribute("open") === null) await tracking.locator(":scope > summary").click();
  await records.getByRole("button", { name: "追踪/书库任务.json", exact: true }).click();
  await records.getByText("只读记录 · 工作台自动维护", { exact: true }).waitFor({ state: "visible" });
  await records.locator(".novel-prose").waitFor({ state: "visible" });
  assert.equal(await records.getByRole("button", { name: "编辑", exact: true }).count(), 0);
  assert.equal(await records.getByRole("button", { name: "保存", exact: true }).count(), 0);
  assert.equal(await records.locator("textarea").count(), 0);
  await page.screenshot({ path: join(evidence, "library-readonly-records.png"), animations: "disabled" });
  await records.locator(":scope > summary").click();
  assert.equal(await records.getAttribute("open"), null);
}
async function assertImportContainment(origin: string, sessionId: string, library: string, temporary: string): Promise<void> {
  const outside = join(temporary, "outside-import-target"); await mkdir(outside);
  await writeFile(join(outside, "sentinel.txt"), "outside directory must remain untouched\n");
  const text = sourceFor(keys[0]!); const title = "外部逃逸";
  const id = digest(JSON.stringify([digest(text), title]));
  const link = join(library, "小说项目", `${title}--${id.slice(0, 12)}`);
  await symlink(outside, link, "dir");
  try {
    const response = await dshFetch(`${origin}/oh-story/library?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: [{ filename: "outside-symlink.txt", text, title }] }) });
    const result = await response.json() as { readonly results?: readonly { readonly status: string }[] };
    assert(!response.ok || (result.results?.length === 1 && result.results[0]?.status === "failed"), "Import followed an outside symlink");
    assert.deepEqual(await readdir(outside), ["sentinel.txt"]); assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "outside directory must remain untouched\n");
  } finally { await rm(link); }
}
async function checkBook(book: LibraryBook, key: string, total = totalFor(key)): Promise<void> {
  const ledger = JSON.parse(await readFile(join(book.absolutePath, "追踪/_tracking-state.json"), "utf8")) as { readonly kind: string; readonly schema_version: number; readonly last_committed_chapter: number; readonly wordcount_records: Record<string, { readonly actual: number; readonly body_sha256: string }>; readonly original_state: { readonly recent: readonly { readonly n: number; readonly title: string }[] } };
  assert.equal(ledger.kind, "serial-original"); assert.equal(ledger.schema_version, 1); assert.equal(ledger.last_committed_chapter, total); assert.equal(Object.keys(ledger.wordcount_records).length, total);
  assert.deepEqual([...new Set(JSON.stringify(ledger.original_state).match(/SMOKEBOOK\d{2}/gu))], [key], "Another book contaminated the state ledger");
  for (const recent of ledger.original_state.recent) assert.equal(recent.title, `${key}第${String(recent.n)}次核账`, "Recent state used a book title instead of the actual chapter title");
  for (let chapter = 1; chapter <= total; chapter += 1) {
    const prose = await readFile(join(book.absolutePath, chapterPath(chapter)), "utf8");
    const change = await readFile(join(book.absolutePath, `追踪/状态变更/第${String(chapter).padStart(3, "0")}章.md`), "utf8");
    assert(prose.includes(key) && !prose.includes("【状态变更】")); assert(change.startsWith("【状态变更】") && change.includes(key));
    assert.deepEqual([...new Set(prose.match(/SMOKEBOOK\d{2}/gu))], [key]);
    const record = ledger.wordcount_records[String(chapter)]!; assert(record.actual >= 2300 && record.actual <= 2500); assert.equal(record.body_sha256, digest(prose));
    const headline = JSON.parse(await readFile(join(book.absolutePath, `追踪/公众号标题/第${String(chapter).padStart(3, "0")}章.json`), "utf8")) as { readonly title: string; readonly candidates: readonly string[]; readonly topThree: readonly string[]; readonly bodySha256: string };
    assert.deepEqual(headline.candidates, titleCandidates(chapter)); assert.deepEqual(headline.topThree, titleCandidates(chapter).slice(0, 3));
    assert.equal(headline.title, titleCandidates(chapter)[0]); assert.equal(headline.bodySha256, digest(prose));
  }
}
async function checkNativeChildren(home: string, model: ModelFixture, total = baseChapters, selections?: ReadonlyMap<string, SerialModelSelection>): Promise<void> {
  const directory = join(home, "sessions"); const files = await readdir(directory, { recursive: true });
  assert.equal(new Set(model.answers.map(answer => answer.sessionId)).size, total);
  assert.equal(new Set([...model.answers, ...model.titles].map(answer => answer.sessionId)).size, total * 2);
  for (const answer of [...model.answers, ...model.titles]) {
    const file = files.find(path => path.endsWith(`${answer.sessionId}/session.v4.jsonl.zstd`)); assert(file !== undefined);
    const lines = zstdDecompressSync(await readFile(join(directory, file))).toString("utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!) as { readonly parentSession: string; readonly origin: string; readonly isSeeded: boolean; readonly agentPreset: string; readonly cwd?: string };
    assert.equal(header.origin, "subagent"); assert.equal(header.isSeeded, false); assert.equal(header.agentPreset, "standard"); assert(header.parentSession.length > 0);
    const bookPath = await realpath(model.books.get(answer.key)!.absolutePath); assert(header.cwd !== undefined); assert.equal(await realpath(header.cwd), bookPath, "Native chapter was attached to the wrong book directory");
    const parentFile = files.find(path => path.endsWith(`${header.parentSession}/session.v4.jsonl.zstd`)); assert(parentFile !== undefined);
    const parentHeader = JSON.parse(zstdDecompressSync(await readFile(join(directory, parentFile))).toString("utf8").split("\n")[0]!) as { readonly cwd: string; readonly isSeeded: boolean };
    assert.equal(await realpath(parentHeader.cwd), bookPath); assert.equal(parentHeader.isSeeded, false);
    const events = lines.slice(1).map(line => JSON.parse(line) as { readonly type: string; readonly seq: number; readonly data: Record<string, unknown> });
    const selected = selections?.get(answer.key) ?? { provider: "deepseek-official", model: "deepseek-flash" };
    assert.equal(events[0]?.seq, 0); assert.equal(events[0]?.type, "subagent/descriptor"); assert.equal(events[0]?.data.agentProvider, selected.provider); assert.equal(events[0]?.data.agentModel, selected.model);
    if (selections !== undefined) {
      const headers = events.filter(event => event.type === "request/header").map(event => event.data.header as { readonly config: SerialModelSelection });
      assert(headers.length > 0, "Native child did not persist its effective request header");
      for (const saved of headers) {
        assert.equal(saved.config.provider, selected.provider); assert.equal(saved.config.model, selected.model); assert.equal(saved.config.reasoningEffort, selected.reasoningEffort);
      }
    }
    assert.equal(events.filter(event => event.type === "tool/call").length, 0, "The prose-only writer called a tool");
  }
}

async function main(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "novel-library-smoke-"));
  const home = join(temporary, "home"); const libraryPath = join(temporary, "书库集成测试");
  const installation = resolve(process.env.DSH_SMOKE_INSTALLATION ?? join(temporary, "installation"));
  const bin = join(installation, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  const logs: string[] = []; const pageErrors: string[] = [];
  let child: ChildProcess | undefined; let browser: Browser | undefined; let model: ModelFixture | undefined; let passed = false;
  try {
    await mkdir(evidence, { recursive: true }); await mkdir(libraryPath, { recursive: true });
    const librarySentinel = join(libraryPath, "书库原始资料_不得删除.txt");
    const sentinelText = "Only selected book project directories may be removed. Preserve this library source.\n";
    await writeFile(librarySentinel, sentinelText);
    const configuredTarball = process.env.SERIAL_PLUGIN_TARBALL; assert(configuredTarball !== undefined, "Set SERIAL_PLUGIN_TARBALL to the exact frozen novel-only package; this smoke never repacks");
    const tarball = resolve(configuredTarball); const pluginSha256 = digest(await readFile(tarball)); await cp(tarball, join(evidence, "novel-plugin-tested.tgz"));
    const entries = command("tar", ["-tzf", tarball]).trim().split("\n");
    assert(!entries.some(path => /(?:\/SKILL\.md$|\/roles\/|\/skills\/|\/knowledge\/|\/drama\/|\/novel-to-game\/|\/video-recap\/|\.map$)/u.test(path)), "Novel package still contains removed knowledge or source maps");
    const pluginMetadata = JSON.parse(command("tar", ["-xOf", tarball, "package/package.json"])) as { readonly version: string };
    assert(typeof pluginMetadata.version === "string" && pluginMetadata.version !== "");
    assert(command("tar", ["-xOf", tarball, "package/README.md"]).includes(pluginMetadata.version), "Packaged README does not document this plugin version");
    try { await readFile(bin); } catch {
      await mkdir(installation, { recursive: true }); await writeFile(join(installation, "package.json"), JSON.stringify({ private: true, dependencies: { "@deepseek-ai/dsh": version } }));
      await writeFile(join(installation, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\nallowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': false\n  koffi: true\n  node-addon-require-builtin: false\n  node-pty: true\n  protobufjs: false\n");
      command("pnpm", ["--dir", installation, "install", "--offline"]);
    }
    model = await startModel();
    const env = { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: "0", DSH_HOME: home, DSH_AGENTS_HOME: join(temporary, "agents"), DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "library-local-fixture", DEEPSEEK_BASE_URL: model.baseURL };
    command(process.execPath, [bin, "plugin", "--profile", "web", "add", tarball], env);
    await isolateFirstUseWorkspace(home, join(temporary, "documents"));
    const patch = join(home, "profiles/web/cordis.patch.yml"); await writeFile(patch, `${await readFile(patch, "utf8")}\n- id: permission\n  config:\n    defaultPreset: danger-full-access\n`);
    const origin = `http://127.0.0.1:${String(await freePort())}`;
    const launch = (): ChildProcess => {
      const process = spawn(globalThis.process.execPath, [bin, "web", "--no-open", "--port", new URL(origin).port], { cwd: libraryPath, env, stdio: ["ignore", "pipe", "pipe"] });
      process.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8"))); process.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8"))); return process;
    };
    child = launch(); let tokenURL = await authorizeDsh(origin, logs);
    const workspace = await rpc<{ readonly workspace: { readonly workspaceId: string } }>(origin, "workspace/create", { request: { path: libraryPath } });
    await rpc(origin, "session/create", { request: { workspaceId: workspace.workspace.workspaceId } });
    browser = await chromium.launch({ channel: process.env.DSH_SMOKE_BROWSER_CHANNEL ?? "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on("pageerror", error => pageErrors.push(error.message));
    const registered = new Map<string, string>(); const registrations: Promise<void>[] = [];
    const observeRegistration = (response: BrowserResponse): void => {
      if (!response.url().endsWith("/api/workspace/create")) return;
      registrations.push((async () => {
        const input = response.request().postDataJSON() as { readonly payload: { readonly args: { readonly request: { readonly path: string } } } };
        const envelope = await response.json() as { readonly result: { readonly ok: boolean; readonly value: { readonly workspace: { readonly workspaceId: string } } } };
        assert(envelope.result.ok); registered.set(await realpath(input.payload.args.request.path), envelope.result.value.workspace.workspaceId);
      })());
    };
    page.on("response", observeRegistration);
    await page.goto(tokenURL, { waitUntil: "networkidle" });
    const notice = page.getByRole("button", { name: /^(?:Continue|继续)$/u }); if (await notice.isVisible()) await notice.click();
    await page.getByLabel("批量选择最终输出文件", { exact: true }).waitFor({ state: "attached", timeout: 20_000 });
    const sessionId = await page.locator("[data-conversation-session]").first().getAttribute("data-conversation-session"); assert(sessionId !== null);
    await rpc(origin, "session/selectModel", { request: { sessionId, provider: "deepseek-official", model: "deepseek-flash" } });
    const beforeReady = model.requests;
    await rpc(origin, "session/prompt", { request: { requestId: crypto.randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: "LIBRARY_SMOKE_READY: reply ready without tools." }] } });
    await waitFor(async () => model!.requests > beforeReady && !(await rpc<{ readonly running: boolean }>(origin, "session/state", { request: { sessionId } })).running, "native library owner ready");
    await rpc(origin, "session/rename", { request: { sessionId, title: "书库验收会话" } });
    const openWorkbench = page.getByRole("button", { name: "打开长篇工作台", exact: true }); if (await openWorkbench.isVisible()) await openWorkbench.click();
    const inputFiles = join(temporary, "inputs"); await mkdir(inputFiles);
    const filenames = await Promise.all(keys.map(async key => { const file = join(inputFiles, `${key}.txt`); await writeFile(file, sourceFor(key)); return file; }));
    await page.getByLabel("批量选择最终输出文件", { exact: true }).setInputFiles(filenames);
    const importResponse = page.waitForResponse(response => response.url().includes("/oh-story/library?") && response.request().method() === "POST", { timeout: 60_000 });
    await page.getByRole("button", { name: "导入并创建 10 本小说", exact: true }).click(); assert.equal((await importResponse).status(), 200);
    await page.getByText(/新建 10 本，已有 0 本/u).waitFor({ state: "visible", timeout: 60_000 }); await Promise.all(registrations); page.off("response", observeRegistration);
    const snapshot = await api<LibrarySnapshot>(origin, "library", sessionId); assert.equal(snapshot.books.length, 10); assert.equal(new Set(snapshot.books.map(book => book.absolutePath)).size, 10);
    for (const book of snapshot.books) {
      const key = book.filename.replace(/\.txt$/u, ""); assert(keys.includes(key)); model.books.set(key, book);
      assert(registered.has(await realpath(book.absolutePath)), "UI failed to register an imported native workspace");
      assert.equal(await readFile(join(book.absolutePath, "大纲/导入原稿.md"), "utf8"), sourceFor(key));
    }
    assert.equal(new Set(registered.values()).size, 10); assert.equal(await page.getByRole("list", { name: "小说项目列表" }).getByRole("listitem").count(), 10);
    for (const name of ["短剧", "游戏", "视频"]) assert.equal(await page.getByRole("tab", { name, exact: true }).count(), 0);
    await checkLibraryLayout(page);
    await page.getByRole("list", { name: "小说项目列表" }).getByRole("listitem").filter({ hasText: titleFor(keys[0]!) }).getByRole("button", { name: "打开", exact: true }).click();
    await page.getByRole("button", { name: "← 回到书库总览", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    const openedBookSession = await page.locator("[data-conversation-session]").first().getAttribute("data-conversation-session"); assert(openedBookSession !== null && openedBookSession !== sessionId);
    const openedWorkspace = await api<{ readonly cwd: string }>(origin, "workspace", openedBookSession); assert.equal(await realpath(openedWorkspace.cwd), await realpath(model.books.get(keys[0]!)!.absolutePath));
    await page.screenshot({ path: join(evidence, "book-project.png"), animations: "disabled" });
    await page.getByRole("button", { name: "← 回到书库总览", exact: true }).click();
    // Workspace navigation legitimately selects a fresh blank session. Return to
    // the already materialized owner before testing that owner's durable queue.
    await page.getByRole("treeitem").filter({ hasText: "书库验收会话" }).first().click();
    await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByRole("button", { name: "开始批量生成", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await assertImportContainment(origin, sessionId, libraryPath, temporary);
    if (process.env.LIBRARY_MODEL_ONLY === "1") {
      const singleBook = model.books.get(keys[0]!)!; const firstBook = model.books.get(keys[1]!)!; const appendedBook = model.books.get(keys[2]!)!;
      const parentChoice: SerialModelSelection = { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" };
      const singleChoice: SerialModelSelection = { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "low" };
      const firstChoice: SerialModelSelection = { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high" };
      const appendedChoice: SerialModelSelection = { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "low" };
      const changedParent: SerialModelSelection = { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "max" };
      const serial = async (owner: string, input?: object) => (await api<{ readonly task: SerialTask | null }>(origin, "serial", owner, input)).task;
      const waitSerial = async (owner: string, status: SerialTask["status"]) => {
        let result: SerialTask | null = null;
        await waitFor(async () => {
          result = await serial(owner); assert(result?.status !== "blocked" && result?.status !== "stopped", `Unexpected selected-model task state: ${JSON.stringify(result)}`);
          return result?.status === status;
        }, `single selected-model book ${status}`, 120_000);
        return result!;
      };
      await rpc(origin, "session/selectModel", { request: { sessionId, ...parentChoice } });
      await rpc(origin, "session/selectModel", { request: { sessionId: openedBookSession, ...parentChoice } });
      const catalog = await api<SerialModelCatalog>(origin, "models", sessionId);
      assert.deepEqual(catalog.current, parentChoice);
      for (const choice of [singleChoice, firstChoice, appendedChoice, changedParent]) {
        const advertised = catalog.models.find(entry => entry.provider === choice.provider && entry.model === choice.model);
        assert(advertised !== undefined, "The native model picker omitted an advertised model");
        assert(advertised.efforts.some(effort => effort.id === choice.reasoningEffort), "Native reasoning capabilities were not exposed");
      }
      const rejectedRequests = model.requests;
      const rejected = await dshFetch(`${origin}/oh-story/serial?sessionId=${encodeURIComponent(openedBookSession)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", count: 1, modelSelection: { ...singleChoice, reasoningEffort: "unsupported-native-effort" } }) });
      assert.equal(rejected.status, 400); assert.equal(model.requests, rejectedRequests); assert.equal(await serial(openedBookSession), null);
      const beforeBookReady = model.requests;
      await rpc(origin, "session/prompt", { request: { requestId: crypto.randomUUID(), sessionId: openedBookSession, mode: "queue", content: [{ type: "text", text: "LIBRARY_SMOKE_READY: reply ready without tools." }] } });
      await waitFor(async () => model!.requests > beforeBookReady && !(await rpc<{ readonly running: boolean }>(origin, "session/state", { request: { sessionId: openedBookSession } })).running, "single selected-model owner ready");
      await rpc(origin, "session/rename", { request: { sessionId: openedBookSession, title: "模型选择验收" } });
      const singleWorkspace = page.getByRole("treeitem").filter({ hasText: titleFor(keys[0]!) }).first();
      if (await singleWorkspace.getAttribute("aria-expanded") !== "true") await singleWorkspace.click();
      await page.getByRole("treeitem").filter({ hasText: "模型选择验收" }).first().click();
      await page.locator(`[data-conversation-session="${openedBookSession}"]`).waitFor({ state: "visible", timeout: 20_000 });
      await page.getByLabel("本次写作模型", { exact: true }).selectOption(JSON.stringify([singleChoice.provider, singleChoice.model]));
      await page.getByLabel("思考强度", { exact: true }).selectOption(singleChoice.reasoningEffort!);
      await page.locator("details.oh-serial-settings > summary").click();
      await page.getByRole("button", { name: "只试写 1 章", exact: true }).click();
      const singleStart = page.waitForResponse(response => response.url().includes("/oh-story/serial?") && response.request().method() === "POST");
      await page.getByRole("button", { name: "一键生成 · 1 章", exact: true }).click();
      const singleStarted = await singleStart; assert.equal(singleStarted.status(), 200);
      assert.deepEqual((singleStarted.request().postDataJSON() as { readonly modelSelection: SerialModelSelection }).modelSelection, singleChoice);
      const singleTask = await serial(openedBookSession);
      assert.deepEqual(singleTask?.modelSelection, singleChoice);
      await waitSerial(openedBookSession, "completed");
      assert.deepEqual((await api<SerialModelCatalog>(origin, "models", openedBookSession)).current, parentChoice, "Single-book generation changed its parent Session selection");
      model.holds.add(`${keys[1]!}/1`);
      await page.getByRole("button", { name: "← 回到书库总览", exact: true }).click();
      await page.getByRole("treeitem").filter({ hasText: "书库验收会话" }).first().click();
      await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ state: "visible", timeout: 20_000 });
      await page.getByRole("button", { name: "取消选择", exact: true }).click();
      await page.getByRole("checkbox", { name: `选择 ${titleFor(keys[1]!)}`, exact: true }).check();
      await page.getByLabel("本次写作模型", { exact: true }).selectOption(JSON.stringify([firstChoice.provider, firstChoice.model]));
      await page.getByLabel("思考强度", { exact: true }).selectOption(firstChoice.reasoningEffort!);
      await page.getByLabel("书间并发模式").selectOption("custom"); await page.getByLabel("同时生成的书数").fill("1");
      await page.getByRole("radio", { name: "新增 10 章", exact: true }).check();
      await page.screenshot({ path: join(evidence, "batch-model-picker.png"), animations: "disabled" });
      await clickQueue(page, "开始批量生成");
      const started = (await queue(origin, sessionId))!;
      assert.deepEqual(started.books[0]?.generation?.modelSelection, firstChoice);
      await waitNativeRequest(origin, sessionId, model, `${keys[1]!}/1`);
      const appended = (await queue(origin, sessionId, { action: "start", count: 10, concurrency: 1, ids: [appendedBook.id], modelSelection: appendedChoice }))!;
      assert.equal(appended.id, started.id);
      assert.deepEqual(appended.books.find(book => book.id === firstBook.id)?.generation?.modelSelection, firstChoice);
      assert.deepEqual(appended.books.find(book => book.id === appendedBook.id)?.generation?.modelSelection, appendedChoice);
      assert(!model.answers.some(answer => answer.key === keys[2]!));
      assert.deepEqual((await api<SerialModelCatalog>(origin, "models", sessionId)).current, parentChoice, "Adding different-model books changed the library Session selection");
      await queue(origin, sessionId, { action: "pause" }); model.holds.delete(`${keys[1]!}/1`);
      const paused = await waitQueue(origin, sessionId, task => task.status === "paused" && task.books.find(book => book.id === firstBook.id)?.completedChapters === 1);
      assert.equal(paused.books.find(book => book.id === appendedBook.id)?.status, "pending");
      await rpc(origin, "session/selectModel", { request: { sessionId, ...changedParent } });
      await browser.close(); browser = undefined; await stopDshProcess(child); child = undefined;
      logs.length = 0; child = launch(); tokenURL = await authorizeDsh(origin, logs);
      const restored = (await queue(origin, sessionId))!; assert.equal(restored.id, started.id);
      assert.deepEqual((await api<SerialModelCatalog>(origin, "models", sessionId)).current, changedParent);
      await queue(origin, sessionId, { action: "resume" });
      const finished = await waitQueue(origin, sessionId, task => task.status === "completed");
      assert(finished.books.every(book => book.status === "completed"));
      assert.deepEqual((await api<SerialModelCatalog>(origin, "models", sessionId)).current, changedParent, "Resume changed the parent Session selection");
      assert.equal(model.answers.length, 4); assert.equal(model.titles.length, 4); assert.equal(model.failures.length, 0, model.failures.join("\n"));
      const expected = new Map([[keys[0]!, singleChoice], [keys[1]!, firstChoice], [keys[2]!, appendedChoice]]);
      for (const captured of model.wireSelections) {
        const selection = expected.get(captured.key); assert(selection !== undefined);
        assert.equal(captured.model, selection.model, `Wrong wire model for ${captured.key}/${String(captured.chapter)}/${captured.kind}`);
        assert.equal(captured.reasoningEffort, selection.reasoningEffort, `Wrong wire effort for ${captured.key}/${String(captured.chapter)}/${captured.kind}`);
      }
      await checkNativeChildren(home, model, 4, expected);
      await checkBook(singleBook, keys[0]!, 1); await checkBook(firstBook, keys[1]!, 2); await checkBook(appendedBook, keys[2]!, 1);
      browser = await chromium.launch({ channel: process.env.DSH_SMOKE_BROWSER_CHANNEL ?? "chrome", headless: true });
      const modelsPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); modelsPage.on("pageerror", error => pageErrors.push(error.message));
      await modelsPage.goto(tokenURL, { waitUntil: "networkidle" });
      const modelsNotice = modelsPage.getByRole("button", { name: /^(?:Continue|继续)$/u }); if (await modelsNotice.isVisible()) await modelsNotice.click();
      const libraryWorkspace = modelsPage.getByRole("treeitem").filter({ hasText: "书库集成测试" }).first();
      await libraryWorkspace.waitFor({ state: "visible", timeout: 20_000 }); if (await libraryWorkspace.getAttribute("aria-expanded") !== "true") await libraryWorkspace.click();
      await modelsPage.getByRole("treeitem").filter({ hasText: "书库验收会话" }).first().click();
      await modelsPage.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ state: "visible", timeout: 20_000 });
      await modelsPage.locator(".novel-version").filter({ hasText: `运行版本：${pluginMetadata.version}` }).waitFor({ state: "visible", timeout: 20_000 });
      await modelsPage.screenshot({ path: join(evidence, "batch-model-selection.png"), animations: "disabled" });
      assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
      const report = {
        ok: true, phase: "batch-model-selection", dshVersion: version, pluginVersion: pluginMetadata.version, pluginSha256,
        provider: "local-deterministic-text-fixture", realPaidModel: false,
        nativeCatalog: "passed-two-native-models-and-supported-efforts", invalidEffort: "rejected-before-model-request-and-task-write",
        singleBookSelection: "passed-different-model-and-effort-from-parent", libraryAppendSelection: "passed-two-books-with-independent-models-and-efforts",
        coldResumeSelection: "passed-pending-and-active-books-kept-snapshots-after-parent-model-change", parentSelection: "not-mutated-by-start-append-or-resume",
        bodyAndTitleWireSelection: "passed-model-and-effort", durableNativeRequestHeaders: "passed-provider-model-reasoning-effort", uiModelAndEffortSelection: "passed-single-book-and-library-start",
        selectedBooks: 3, acceptedChapters: 4, freshNativeChapterSessions: 4, independentTitleSessions: 4,
        modelSelections: [...expected].map(([key, selection]) => ({ book: key, ...selection })),
        originalSystemSha256: ORIGINAL_SYSTEM_PROMPT_SHA256, fullStyleAndPreviousTen: "passed", modelToolCalls: 0, literaryQuality: "not assessed"
      };
      await writeFile(join(evidence, "model-selection-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(report)}\n`); passed = true; return;
    }
    if (process.env.LIBRARY_UPGRADE_ONLY === "1") {
      const singleBook = model.books.get(keys[0]!)!;
      const queuedBook = model.books.get(keys[1]!)!;
      const serial = async (owner: string, input?: object) => (await api<{ readonly task: SerialTask | null }>(origin, "serial", owner, input)).task;
      const waitSerial = async (owner: string, status: SerialTask["status"]) => {
        let result: SerialTask | null = null;
        await waitFor(async () => {
          result = await serial(owner);
          assert(result?.status !== "blocked" && result?.status !== "stopped", `Unexpected single task state: ${JSON.stringify(result)}`);
          return result?.status === status;
        }, `single book ${status}`, 120_000);
        return result!;
      };
      // Establish an ordinary saved chapter, then use only isolated fixture
      // files to emulate a pre-title-workflow task and a legacy library queue.
      await rpc(origin, "session/selectModel", { request: { sessionId: openedBookSession, provider: "deepseek-official", model: "deepseek-flash" } });
      const beforeBookReady = model.requests;
      await rpc(origin, "session/prompt", { request: { requestId: crypto.randomUUID(), sessionId: openedBookSession, mode: "queue", content: [{ type: "text", text: "LIBRARY_SMOKE_READY: reply ready without tools." }] } });
      await waitFor(async () => model!.requests > beforeBookReady && !(await rpc<{ readonly running: boolean }>(origin, "session/state", { request: { sessionId: openedBookSession } })).running, "native single book owner ready");
      await serial(openedBookSession, { action: "start", count: 1 });
      await waitSerial(openedBookSession, "completed");
      await rpc(origin, "session/rename", { request: { sessionId: openedBookSession, title: "旧书续写验收" } });
      model.holds.add(`${keys[1]!}/1`);
      await queue(origin, sessionId, { action: "start", count: 10, concurrency: 1, ids: [queuedBook.id] });
      await waitNativeRequest(origin, sessionId, model, `${keys[1]!}/1`);
      await queue(origin, sessionId, { action: "pause" });
      model.holds.delete(`${keys[1]!}/1`);
      await waitQueue(origin, sessionId, task => task.status === "paused" && task.books[0]?.completedChapters === 1);
      await browser.close(); browser = undefined;
      await stopDshProcess(child); child = undefined;
      const originalProse = new Map<string, string>();
      const originalTitles = new Map<string, string>();
      for (const book of [singleBook, queuedBook]) {
        originalProse.set(book.id, await readFile(join(book.absolutePath, chapterPath(1)), "utf8"));
        const taskFile = join(book.absolutePath, "追踪/连载任务.json");
        const legacy = JSON.parse(await readFile(taskFile, "utf8")) as SerialTask;
        legacy.status = "paused"; legacy.nextChapter = 2; legacy.targetChapter = 3; legacy.maxAttempts = 3;
        delete legacy.phase; delete legacy.titleActive; delete legacy.titleAttemptLimit; delete legacy.active;
        await writeFile(taskFile, `${JSON.stringify(legacy, null, 2)}\n`);
        const titleFile = join(book.absolutePath, "追踪/公众号标题/第001章.json");
        const oldTitle = JSON.parse(await readFile(titleFile, "utf8")) as Record<string, unknown>;
        oldTitle.title = "旧章";
        for (const field of ["candidates", "topThree", "coreHook", "titleStrategy", "tags"]) delete oldTitle[field];
        const oldText = `${JSON.stringify(oldTitle, null, 2)}\n`;
        await writeFile(titleFile, oldText); originalTitles.set(book.id, oldText);
      }
      const queueFile = join(libraryPath, "追踪/书库任务.json");
      const legacyQueue = JSON.parse(await readFile(queueFile, "utf8")) as LibraryTask;
      legacyQueue.status = "paused";
      for (const book of legacyQueue.books) {
        book.status = "running"; book.targetChapter = 3;
        delete book.count; delete book.generation; delete book.ownerContext;
      }
      await writeFile(queueFile, `${JSON.stringify(legacyQueue, null, 2)}\n`);
      logs.length = 0; child = launch(); tokenURL = await authorizeDsh(origin, logs);
      const restoredSingle = await serial(openedBookSession); assert.equal(restoredSingle?.nextChapter, 2); assert.equal(restoredSingle.targetChapter, 3);
      const activeWorkspace = await api<{ readonly pluginVersion?: string }>(origin, "workspace", openedBookSession); assert.equal(activeWorkspace.pluginVersion, pluginMetadata.version, "The running backend is not the frozen upgraded plugin");
      const restoredQueue = (await queue(origin, sessionId))!; assert.equal(restoredQueue.id, legacyQueue.id);
      await serial(openedBookSession, { action: "resume" });
      await queue(origin, sessionId, { action: "resume" });
      const finishedSingle = await waitSerial(openedBookSession, "completed");
      const finishedQueue = await waitQueue(origin, sessionId, task => task.status === "completed");
      assert.equal(finishedSingle.targetChapter, 3); assert.equal(finishedSingle.nextChapter, 4);
      assert.equal(finishedQueue.books[0]?.targetChapter, 3); assert.equal(finishedQueue.books[0]?.completedChapters, 3);
      assert.equal(model.answers.length, 6); assert.equal(model.titles.length, 6); assert.equal(model.failures.length, 0, model.failures.join("\n"));
      for (const book of [singleBook, queuedBook]) {
        assert.equal(await readFile(join(book.absolutePath, chapterPath(1)), "utf8"), originalProse.get(book.id), "Upgrade rewrote the old body");
        assert.equal(await readFile(join(book.absolutePath, "追踪/公众号标题/第001章.json"), "utf8"), originalTitles.get(book.id), "Upgrade rewrote the old title");
        for (const chapter of [2, 3]) {
          const title = JSON.parse(await readFile(join(book.absolutePath, `追踪/公众号标题/第00${String(chapter)}章.json`), "utf8")) as { readonly candidates: readonly string[]; readonly bodySha256: string };
          assert.deepEqual(title.candidates, titleCandidates(chapter));
          assert(title.candidates.every(candidate => [...candidate].length >= 15 && [...candidate].length <= 25));
          assert.equal(title.bodySha256, digest(await readFile(join(book.absolutePath, chapterPath(chapter)), "utf8")));
        }
      }
      const inspectExport = (raw: Uint8Array): number => {
        const zip = unzipSync(raw); const names = Object.keys(zip).filter(name => name.startsWith("第")); assert.equal(names.length, 3);
        for (const name of names) {
          const text = strFromU8(zip[name]!); const number = Number(/^第0*(\d+)章/u.exec(name)?.[1]);
          if (number === 1) assert(text.replace(/^\uFEFF/u, "").startsWith("旧章\r\n书名：")); else checkExportedTitle(text);
          assert(text.includes("书名：《") && !text.includes("【状态变更】"));
        }
        return names.length;
      };
      const singleExport = await dshFetch(`${origin}/oh-story/serial/export?sessionId=${encodeURIComponent(openedBookSession)}`); assert.equal(singleExport.status, 200);
      const singleBytes = new Uint8Array(await singleExport.arrayBuffer()); assert.equal(inspectExport(singleBytes), 3);
      await writeFile(join(evidence, "title-upgrade-single-export.zip"), singleBytes);
      const batchExport = await dshFetch(`${origin}/oh-story/library?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "export", ids: [singleBook.id, queuedBook.id] }) }); assert.equal(batchExport.status, 200);
      const batchBytes = new Uint8Array(await batchExport.arrayBuffer()); const batchZip = unzipSync(batchBytes);
      const books = Object.keys(batchZip).filter(name => name.endsWith(".zip")); assert.equal(books.length, 2);
      assert.equal(books.reduce((count, name) => count + inspectExport(batchZip[name]!), 0), 6);
      await writeFile(join(evidence, "title-upgrade-batch-export.zip"), batchBytes);
      await checkNativeChildren(home, model, 6);
      browser = await chromium.launch({ channel: process.env.DSH_SMOKE_BROWSER_CHANNEL ?? "chrome", headless: true });
      const upgradedPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      upgradedPage.on("pageerror", error => pageErrors.push(error.message));
      await upgradedPage.goto(tokenURL, { waitUntil: "networkidle" });
      const upgradedNotice = upgradedPage.getByRole("button", { name: /^(?:Continue|继续)$/u }); if (await upgradedNotice.isVisible()) await upgradedNotice.click();
      const bookWorkspace = upgradedPage.getByRole("treeitem").filter({ hasText: titleFor(keys[0]!) }).first();
      await bookWorkspace.waitFor({ state: "visible", timeout: 20_000 }); if (await bookWorkspace.getAttribute("aria-expanded") !== "true") await bookWorkspace.click();
      await upgradedPage.getByRole("treeitem").filter({ hasText: "旧书续写验收" }).first().click();
      await upgradedPage.locator(`[data-conversation-session="${openedBookSession}"]`).waitFor({ state: "visible", timeout: 20_000 });
      await upgradedPage.locator(".novel-version").filter({ hasText: `运行版本：${pluginMetadata.version} · 界面 ${pluginMetadata.version}` }).waitFor({ state: "visible", timeout: 20_000 });
      await upgradedPage.getByRole("button", { name: "正文/第002章.md", exact: true }).click();
      const titleCard = upgradedPage.getByRole("region", { name: "公众号备选标题", exact: true });
      await waitFor(async () => await titleCard.locator("ol li").count() === 5, "chapter preview five independent title candidates");
      assert.deepEqual(await titleCard.locator("ol li").allTextContents(), titleCandidates(2));
      assert((await readFile(join(singleBook.absolutePath, chapterPath(2)), "utf8")).startsWith("第2章 核账\n"), "The raw chapter heading was unexpectedly replaced by a marketing title");
      await upgradedPage.screenshot({ path: join(evidence, "title-upgrade-preview.png"), animations: "disabled" });
      assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
      const report = {
        ok: true, phase: "legacy-title-upgrade", dshVersion: version, pluginVersion: pluginMetadata.version, pluginSha256,
        provider: "local-deterministic-text-fixture", realPaidModel: false,
        legacyBooks: 2, seedChapters: 2, newlyGeneratedChapters: 4, freshNativeChapterSessions: 6, independentTitleSessions: 6,
        legacySingleTask: "passed-cold-resume-no-title-phase", legacyLibraryQueue: "passed-cold-resume-no-per-book-settings",
        oldShortTitleAndBody: "preserved-byte-for-byte", originalTargets: "preserved-through-chapter-3",
        newTitleCandidates: "passed-five-distinct-15-to-25-characters", authorTitlePromptPreserved: "passed", titleContextIsolation: "passed-current-chapter-only",
        singleChapterTxtExport: "passed-five-numbered-candidates-at-start", batchChapterTxtExport: "passed-two-books-six-txts",
        runningBackendVersion: activeWorkspace.pluginVersion, uiAndBackendVersion: "matched", chapterPreviewTitles: "passed-five-long-candidates-beside-short-raw-heading",
        originalSystemSha256: ORIGINAL_SYSTEM_PROMPT_SHA256, fullStyleAndPreviousTen: "passed", modelToolCalls: 0, literaryQuality: "not assessed"
      };
      await writeFile(join(evidence, "title-upgrade-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(report)}\n`); passed = true; return;
    }
    if (process.env.LIBRARY_IMPORT_ONLY === "1") {
      const report = { ok: true, phase: "import-only", dshVersion: version, pluginSha256, importedBooks: 10, registeredNativeWorkspaces: 10, separateProjectDirectories: 10, sourceBytesExact: true, outsideSymlinkImport: "rejected-without-outside-writes", novelOnlyPackageAndUI: "passed", nativeOwnerTurn: "passed", chapterGeneration: "not run", realPaidModel: false };
      for (const name of ["library-failure.log", "library-failure.png", "library-failure-aria.txt"]) await rm(join(evidence, name), { force: true });
      await writeFile(join(evidence, "library-import-smoke.json"), `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report)}\n`); passed = true; return;
    }
    await page.getByLabel("书间并发模式").selectOption("custom");
    await page.getByLabel("同时生成的书数").fill("1");
    await page.getByLabel("生成范围", { exact: true }).selectOption("all");
    await page.getByRole("radio", { name: "新增 10 章", exact: true }).check();
    const blocked = model.books.get(keys[9]!)!; const blockedStyle = join(blocked.absolutePath, "设定/文风.md"); const style = await readFile(blockedStyle); await rm(blockedStyle);
    model.holds.add(`${keys[0]!}/1`); await clickQueue(page, "开始批量生成");
    const started = (await queue(origin, sessionId))!; assert.equal(started.count, 10);
    const repeated = await Promise.allSettled([queue(origin, sessionId, { action: "start", count: 10 }), queue(origin, sessionId, { action: "start", count: 10 })]); assert(repeated.every(result => result.status === "rejected" || result.value?.id === started.id));
    await waitNativeRequest(origin, sessionId, model, `${keys[0]!}/1`);
    await checkReadonlyLibraryRecords(page);
    await clickQueue(page, "本章后暂停所有项目"); model.holds.delete(`${keys[0]!}/1`);
    const paused = await waitQueue(origin, sessionId, task => task.status === "paused"); assert.equal(paused.books.reduce((sum, book) => sum + book.completedChapters, 0), 1);
    await sleep(400); assert.equal(model.answers.length, 1);
    model.holds.add(`${keys[0]!}/2`); await clickQueue(page, "继续本批项目"); await waitNativeRequest(origin, sessionId, model, `${keys[0]!}/2`);
    await browser.close(); browser = undefined;
    const crashed = child; await new Promise<void>(done => { crashed!.once("exit", () => done()); crashed!.kill("SIGKILL"); });
    logs.length = 0; child = launch(); tokenURL = await authorizeDsh(origin, logs);
    const recovered = (await queue(origin, sessionId))!; assert.equal(recovered.status, "paused"); assert.deepEqual(recovered.books.map(book => [book.id, book.startChapter, book.targetChapter]), started.books.map(book => [book.id, book.startChapter, book.targetChapter]));
    model.holds.delete(`${keys[0]!}/2`); await queue(origin, sessionId, { action: "resume" });
    const partial = await waitQueue(origin, sessionId, task => task.status === "completed"); assert.equal(partial.books.filter(book => book.status === "failed").length, 1); assert.equal(model.answers.length, 90);
    assert.equal(partial.books.find(book => book.status === "failed")?.id, blocked.id);
    await writeFile(blockedStyle, style); await queue(origin, sessionId, { action: "resume" });
    const firstDone = await waitQueue(origin, sessionId, task => task.status === "completed"); assert(firstDone.books.every(book => book.status === "completed" && book.completedChapters === 10)); assert.equal(model.answers.length, 100);
    for (const key of keys) model.holds.add(`${key}/11`);
    const secondStarted = (await queue(origin, sessionId, { action: "start", count: 20, concurrency: "all" }))!;
    await waitNativeRequest(origin, sessionId, model, `${keys[0]!}/11`);
    await waitFor(async () => keys.every(key => model!.waiting.has(`${key}/11`)), "ten simultaneous native chapter requests");
    await queue(origin, sessionId, { action: "stop" }); await waitQueue(origin, sessionId, task => task.status === "stopped");
    await waitFor(async () => !model!.waiting.has(`${keys[0]!}/11`), "stopped native model response cancellation"); assert.equal(model.answers.length, 100);
    for (const key of keys) model.holds.delete(`${key}/11`);
    const secondResumed = (await queue(origin, sessionId, { action: "resume" }))!;
    assert.equal(secondResumed.id, secondStarted.id); assert.deepEqual(secondResumed.books.map(book => [book.id, book.startChapter, book.targetChapter]), secondStarted.books.map(book => [book.id, book.startChapter, book.targetChapter]));
    const secondDone = await waitQueue(origin, sessionId, task => task.status === "completed"); assert(secondDone.books.every(book => book.startChapter === 11)); assert.equal(model.answers.length, 148);
    await queue(origin, sessionId, { action: "start", count: "all" });
    const allDone = await waitQueue(origin, sessionId, task => task.status === "completed"); assert.equal(allDone.books.filter(book => book.status === "completed").length, 2); assert.equal(allDone.books.filter(book => book.status === "skipped").length, 8); assert.equal(model.answers.length, 152);
    assert.equal(model.failures.length, 0, model.failures.join("\n")); assert.equal(new Set(model.answers.map(answer => `${answer.key}/${String(answer.chapter)}`)).size, 152);
    for (const key of keys) {
      assert.deepEqual(model.answers.filter(answer => answer.key === key).map(answer => answer.chapter), Array.from({ length: totalFor(key) }, (_, index) => index + 1));
      const book = model.books.get(key)!; await checkBook(book, key);
      const serialTask = JSON.parse(await readFile(join(book.absolutePath, "追踪/连载任务.json"), "utf8")) as { readonly ownerSessionId: string };
      const exported = await dshFetch(`${origin}/oh-story/serial/export?sessionId=${encodeURIComponent(serialTask.ownerSessionId)}`); assert.equal(exported.status, 200);
      assert.equal(exported.headers.get("content-type"), "application/zip");
      const chapterZip = unzipSync(new Uint8Array(await exported.arrayBuffer()));
      const chapterFiles = Object.keys(chapterZip).filter(name => name.startsWith("第")); assert.equal(chapterFiles.length, totalFor(key));
      for (const name of chapterFiles) {
        const text = strFromU8(chapterZip[name]!); assert(!text.includes("【状态变更】"));
        assert(text.includes(`书名：《${titleFor(key)}》`)); checkExportedTitle(text);
        assert.deepEqual([...new Set(text.match(/SMOKEBOOK\d{2}/gu))], [key]);
      }
    }
    assert.equal(model.titles.length, 152); assert(model.titleRetried);
    await checkNativeChildren(home, model);
    assert(model.rewritePassed && model.shortDraft !== undefined);
    const backupRoot = join(model.books.get(keys[0]!)!.absolutePath, "追踪/连载修订");
    const backups = (await readdir(backupRoot, { recursive: true })).filter(path => path.endsWith("-正文.md"));
    const originalDraft = model.shortDraft.text.split("【状态变更】")[0]!.trim();
    assert((await Promise.all(backups.map(path => readFile(join(backupRoot, path), "utf8")))).some(text => text.trim() === originalDraft), "The failed original draft was not backed up before repair");
    browser = await chromium.launch({ channel: process.env.DSH_SMOKE_BROWSER_CHANNEL ?? "chrome", headless: true });
    const reopened = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); reopened.on("pageerror", error => pageErrors.push(error.message)); await reopened.goto(tokenURL, { waitUntil: "networkidle" });
    const continued = reopened.getByRole("button", { name: /^(?:Continue|继续)$/u }); if (await continued.isVisible()) await continued.click();
    const workspaceRow = reopened.getByRole("treeitem").filter({ hasText: "书库集成测试" }).first(); await workspaceRow.waitFor({ state: "visible", timeout: 20_000 }); if (await workspaceRow.getAttribute("aria-expanded") !== "true") await workspaceRow.click();
    await reopened.getByRole("treeitem").filter({ hasText: "书库验收会话" }).first().click();
    await reopened.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ state: "visible", timeout: 20_000 });
    await waitFor(async () => await reopened.getByRole("list", { name: "小说项目列表" }).getByRole("listitem").count() === 10, "reopened persistent library");
    await reopened.getByRole("button", { name: "选择已完本", exact: true }).click();
    const downloadPromise = reopened.waitForEvent("download");
    await reopened.getByRole("button", { name: "批量导出 TXT", exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = join(evidence, "library-txt-export.zip"); await download.saveAs(downloadPath);
    const zip = unzipSync(await readFile(downloadPath));
    const txtNames = Object.keys(zip).filter(name => name !== "导出说明.txt"); assert.equal(txtNames.length, 10);
    let chapterTxtCount = 0;
    for (const name of txtNames) {
      assert(name.endsWith("_全本.zip")); const chapters = unzipSync(zip[name]!);
      const names = Object.keys(chapters).filter(filename => filename.startsWith("第")); chapterTxtCount += names.length;
      for (const filename of names) {
        const txt = strFromU8(chapters[filename]!);
        const bookKeys = [...new Set(txt.match(/SMOKEBOOK\d{2}/gu))]; assert.equal(bookKeys.length, 1);
        assert(txt.includes("书名：《")); checkExportedTitle(txt); assert(!txt.includes("【状态变更】"));
      }
    }
    assert.equal(chapterTxtCount, 152);
    const proseBefore = await Promise.all(keys.map(key => readFile(join(model!.books.get(key)!.absolutePath, chapterPath(1)), "utf8")));
    const librarySnapshot = async (): Promise<LibrarySnapshot> => {
      const response = await dshFetch(`${origin}/oh-story/library?sessionId=${encodeURIComponent(sessionId)}`); assert.equal(response.status, 200); return await response.json() as LibrarySnapshot;
    };

    // Selected generation must never pick up another imported book. Short
    // outlines cap ancillary work; book13 still proves an exact +10 target.
    for (const key of selectionKeys) await writeFile(join(inputFiles, `${key}.txt`), sourceFor(key));
    const selectedImport = await api<LibrarySnapshot>(origin, "library", sessionId, { files: selectionKeys.map(key => ({ filename: `${key}.txt`, text: sourceFor(key) })) });
    assert.equal(selectedImport.books.length, 13);
    for (const key of selectionKeys) {
      const book = selectedImport.books.find(item => item.filename === `${key}.txt`); assert(book !== undefined);
      await rpc(origin, "workspace/create", { request: { path: book.absolutePath } });
      model.books.set(key, book);
    }
    const selectedIds = selectionKeys.map(key => model!.books.get(key)!.id);
    const firstSelected = selectionKeys[0]; const secondSelected = selectionKeys[1]; const appendedSelected = selectionKeys[2];
    for (const identity of [`${firstSelected}/1`, `${firstSelected}/2`, `${secondSelected}/1`, `${secondSelected}/2`, `${secondSelected}/3`, `${appendedSelected}/1`]) model.holds.add(identity);
    await waitFor(async () => await reopened.getByRole("list", { name: "小说项目列表" }).getByRole("listitem").count() === 13, "three selected-scope fixture books visible");
    await reopened.getByRole("button", { name: "取消选择", exact: true }).click();
    await reopened.getByRole("checkbox", { name: `选择 ${titleFor(firstSelected)}`, exact: true }).check();
    await reopened.getByRole("checkbox", { name: `选择 ${titleFor(secondSelected)}`, exact: true }).check();
    await reopened.getByLabel("生成范围", { exact: true }).selectOption("selected");
    await reopened.getByRole("radio", { name: "新增 10 章", exact: true }).check();
    await reopened.getByLabel("书间并发模式").selectOption("all");
    await clickQueue(reopened, "开始批量生成");
    const selectedStart = (await queue(origin, sessionId))!;
    assert.deepEqual(selectedStart.books.map(book => book.id).sort(), selectedIds.slice(0, 2).sort());
    assert.equal(selectedStart.books.find(book => book.id === selectedIds[0])?.targetChapter, 10);
    assert.equal(selectedStart.books.find(book => book.id === selectedIds[1])?.targetChapter, 3);
    await waitNativeRequest(origin, sessionId, model, `${firstSelected}/1`);
    await waitNativeRequest(origin, sessionId, model, `${secondSelected}/1`);
    assert(!model.answers.some(answer => answer.key === appendedSelected) && !model.waiting.has(`${appendedSelected}/1`));
    assert(await absent(join(model.books.get(appendedSelected)!.absolutePath, "追踪/连载任务.json")), "Unselected book received a serial task");

    await clickQueue(reopened, `暂停 ${titleFor(firstSelected)}`);
    model.holds.delete(`${firstSelected}/1`); model.holds.delete(`${secondSelected}/1`);
    await waitQueue(origin, sessionId, task => task.books.find(book => book.id === selectedIds[0])?.status === "paused"
      && task.books.find(book => book.id === selectedIds[1])?.status === "running");
    await waitNativeRequest(origin, sessionId, model, `${secondSelected}/2`);
    model.holds.delete(`${secondSelected}/2`);
    await waitNativeRequest(origin, sessionId, model, `${secondSelected}/3`);
    const individuallyPaused = (await queue(origin, sessionId))!;
    assert.equal(individuallyPaused.books.find(book => book.id === selectedIds[0])?.completedChapters, 1);
    assert.equal(individuallyPaused.books.find(book => book.id === selectedIds[1])?.completedChapters, 2);
    assert(!model.waiting.has(`${firstSelected}/2`), "An individually paused book kept dispatching chapters");
    assert(await absent(join(model.books.get(appendedSelected)!.absolutePath, "追踪/连载任务.json")));

    // The third book is admitted only on this explicit selection, while book14
    // is still writing. count50 is accepted and capped to its two-chapter outline.
    const appended = (await queue(origin, sessionId, { action: "start", count: 50, concurrency: "all", ids: [selectedIds[2]] }))!;
    assert.equal(appended.id, selectedStart.id);
    assert.equal(appended.books.find(book => book.id === selectedIds[0])?.targetChapter, 10);
    assert.equal(appended.books.find(book => book.id === selectedIds[0])?.status, "paused");
    assert.equal(appended.books.find(book => book.id === selectedIds[2])?.targetChapter, 2);
    await waitNativeRequest(origin, sessionId, model, `${appendedSelected}/1`);
    model.holds.delete(`${appendedSelected}/1`);
    await waitQueue(origin, sessionId, task => task.books.find(book => book.id === selectedIds[2])?.status === "completed");
    assert.equal(model.answers.filter(answer => answer.key === firstSelected).length, 1, "Appending another book resumed a paused book");

    await clickQueue(reopened, `继续 ${titleFor(firstSelected)}`);
    const selectedResume = (await queue(origin, sessionId))!;
    assert.equal(selectedResume.books.find(book => book.id === selectedIds[0])?.startChapter, 1);
    assert.equal(selectedResume.books.find(book => book.id === selectedIds[0])?.targetChapter, 10, "Resume extended the selected +10 target");
    await waitNativeRequest(origin, sessionId, model, `${firstSelected}/2`);
    model.holds.delete(`${firstSelected}/2`); model.holds.delete(`${secondSelected}/3`);
    const selectedDone = await waitQueue(origin, sessionId, task => task.status === "completed");
    assert.equal(selectedDone.books.length, 3);
    for (const key of selectionKeys) {
      const count = selectionAccepted[key]!;
      assert.deepEqual(model.answers.filter(answer => answer.key === key).map(answer => answer.chapter), Array.from({ length: count }, (_, index) => index + 1));
      await checkBook(model.books.get(key)!, key, count);
    }
    assert(await absent(join(model.books.get(firstSelected)!.absolutePath, chapterPath(11))), "Selected +10 wrote an eleventh chapter");
    assert.equal(model.answers.filter(answer => keys.includes(answer.key)).length, baseChapters);
    assert.equal(model.answers.length, totalAcceptedChapters); assert.equal(model.titles.length, totalAcceptedChapters);
    await checkNativeChildren(home, model, totalAcceptedChapters);
    const selectedExport = await dshFetch(`${origin}/oh-story/library?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "export", ids: selectedIds }) });
    assert.equal(selectedExport.status, 200);
    const selectedExportBytes = new Uint8Array(await selectedExport.arrayBuffer());
    await writeFile(join(evidence, "library-selection-export.zip"), selectedExportBytes);
    const selectedZip = unzipSync(selectedExportBytes);
    const selectedZipNames = Object.keys(selectedZip).filter(name => name.endsWith(".zip")); assert.equal(selectedZipNames.length, 3);
    let selectedTxtCount = 0;
    for (const name of selectedZipNames) {
      const chapters = unzipSync(selectedZip[name]!);
      for (const filename of Object.keys(chapters).filter(filename => filename.startsWith("第"))) {
        const txt = strFromU8(chapters[filename]!); checkExportedTitle(txt); selectedTxtCount += 1;
        const identities = [...new Set(txt.match(/SMOKEBOOK\d{2}/gu))]; assert.equal(identities.length, 1);
        assert(selectionKeys.some(key => key === identities[0]));
      }
    }
    assert.equal(selectedTxtCount, selectedChapters);
    const selectedCleanup = await api<LibrarySnapshot & { readonly results: readonly { readonly ok: boolean }[] }>(origin, "library", sessionId, { action: "delete", ids: selectedIds });
    assert(selectedCleanup.results.every(result => result.ok)); assert.equal(selectedCleanup.books.length, 10);
    await waitFor(async () => (await Promise.all(selectionKeys.map(key => absent(model!.books.get(key)!.absolutePath)))).every(Boolean)
      && ((await librarySnapshot()).deletingBooks?.length ?? 0) === 0, "selected-generation fixture projects removed", 60_000);
    process.stdout.write(`selected-scope passed: ${String(selectedChapters)} extra chapters, independent pause/resume, append and count50 cap\n`);

    // Keep all completed-book assertions above; only these disposable additions
    // exercise deletion while one native request runs and another book waits.
    const additions = await api<LibrarySnapshot>(origin, "library", sessionId, { files: deletionKeys.map(key => ({ filename: `${key}.txt`, text: sourceFor(key) })) });
    assert.equal(additions.books.length, 12);
    for (const key of deletionKeys) {
      const book = additions.books.find(item => item.filename === `${key}.txt`); assert(book !== undefined);
      // API import creates files; the UI normally performs native registration.
      const additionWorkspace = await rpc<{ readonly workspace: { readonly workspaceId: string } }>(origin, "workspace/create", { request: { path: book.absolutePath } });
      assert(additionWorkspace.workspace.workspaceId !== "");
      model.books.set(key, book); model.holds.add(`${key}/1`);
    }
    const deletionOutside = join(temporary, "outside-delete-target"); await mkdir(deletionOutside);
    const deletionSentinel = join(deletionOutside, "sentinel.txt");
    await writeFile(deletionSentinel, "outside deletion target must remain untouched\n");
    const transientDeletionLink = join(model.books.get(deletionKeys[1])!.absolutePath, "临时清理阻塞");
    await symlink(deletionOutside, transientDeletionLink, "junction");
    await queue(origin, sessionId, { action: "start", count: "all", concurrency: 1 });
    await waitNativeRequest(origin, sessionId, model, `${deletionKeys[0]}/1`);
    const deletionIds = deletionKeys.map(key => model!.books.get(key)!.id);
    const reserved = (await queue(origin, sessionId))!;
    assert.equal(reserved.concurrency, 1);
    assert.equal(reserved.books.find(book => book.id === deletionIds[0])?.status, "running");
    assert.equal(reserved.books.find(book => book.id === deletionIds[1])?.status, "pending");
    assert(!model.waiting.has(`${deletionKeys[1]}/1`), "The pending deletion fixture was dispatched early");
    const deletionStart = Date.now();
    const acceptedDeletion = await api<LibrarySnapshot & { readonly results: readonly { readonly id: string; readonly ok: boolean }[] }>(origin, "library", sessionId, { action: "delete", ids: deletionIds });
    const deletionAcknowledgmentMs = Date.now() - deletionStart;
    assert(deletionAcknowledgmentMs < 5000, `Deletion waited for background cleanup: ${String(deletionAcknowledgmentMs)} ms`);
    assert.deepEqual(acceptedDeletion.results.map(item => [item.id, item.ok]), deletionIds.map(id => [id, true]));
    assert.deepEqual(acceptedDeletion.books.map(book => book.id).sort(), snapshot.books.map(book => book.id).sort(), "Accepted deletion must immediately hide both selected books");
    await waitFor(async () => {
      assert(!(await librarySnapshot()).books.some(book => deletionIds.includes(book.id)), "A cleanup failure made an accepted deletion visible again");
      const journal = JSON.parse(await readFile(join(libraryPath, "追踪/书库删除任务.json"), "utf8")) as { readonly jobs: readonly { readonly book: { readonly id: string }; readonly status: string; readonly attempts?: number; readonly error?: string; readonly nextRetryAt?: string }[] };
      const job = journal.jobs.find(item => item.book.id === deletionIds[1]);
      if ((job?.attempts ?? 0) < 1) return false;
      assert.equal(job!.status, "pending"); assert(job!.error?.includes("链接"));
      assert(Number.isFinite(Date.parse(job!.nextRetryAt ?? "")), "Failed cleanup has no automatic retry scheduled");
      return true;
    }, "hidden failed deletion automatically scheduled for retry", 60_000);
    assert.deepEqual(await readdir(deletionOutside), ["sentinel.txt"]);
    assert.equal(await readFile(deletionSentinel, "utf8"), "outside deletion target must remain untouched\n");
    await rm(transientDeletionLink);
    const removedAdditions = (): Promise<boolean[]> => Promise.all(deletionKeys.map(key => absent(model!.books.get(key)!.absolutePath)));
    await waitFor(async () => {
      const visible = (await librarySnapshot()).books;
      assert(!visible.some(book => deletionIds.includes(book.id)), "An accepted deletion reappeared during cleanup");
      return (await removedAdditions()).every(Boolean);
    }, "physical deletion of running and pending projects", 60_000);
    await waitFor(async () => deletionKeys.every(key => !model!.waiting.has(`${key}/1`)), "deleted native model request cancellation");
    const afterDeletion = (await queue(origin, sessionId))!;
    assert(!afterDeletion.books.some(book => deletionIds.includes(book.id)), "Deleted books remained reserved in the queue");
    assert.equal(afterDeletion.status, "completed");
    const resumeDeleted = await dshFetch(`${origin}/oh-story/library/queue?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume" }) });
    assert.equal(resumeDeleted.status, 409, "A completed queue must not resume a deleted reservation");
    for (const key of deletionKeys) model.holds.delete(`${key}/1`);
    await queue(origin, sessionId, { action: "start", count: 10, concurrency: "all" });
    const afterRestart = await waitQueue(origin, sessionId, task => task.status === "completed");
    assert.equal(afterRestart.books.length, 10); assert(afterRestart.books.every(book => book.status === "skipped"));
    assert(!afterRestart.books.some(book => deletionIds.includes(book.id)));
    assert((await removedAdditions()).every(Boolean), "A stopped writer recreated a deleted book");
    assert.deepEqual(await readdir(deletionOutside), ["sentinel.txt"]);
    assert.equal(await readFile(deletionSentinel, "utf8"), "outside deletion target must remain untouched\n");
    assert.equal(model.answers.length, totalAcceptedChapters); assert.equal(model.titles.length, totalAcceptedChapters);
    assert.equal(model.failures.length, 0, model.failures.join("\n"));
    assert.deepEqual(await Promise.all(keys.map(key => readFile(join(model!.books.get(key)!.absolutePath, chapterPath(1)), "utf8"))), proseBefore);
    for (const key of keys) await checkBook(model.books.get(key)!, key);
    await waitFor(async () => await reopened.getByRole("list", { name: "小说项目列表" }).getByRole("listitem").count() === 10, "only original ten books remain visible");
    await reopened.screenshot({ path: join(evidence, "library-complete.png"), animations: "disabled" }); assert.equal(pageErrors.length, 0, pageErrors.join("\n"));

    // A user may reopen the library in a fresh conversation after generation.
    // Deletion is authorized by the same workspace, without taking queue ownership.
    const deletionSession = await rpc<{ readonly sessionId: string }>(origin, "session/create", { request: { workspaceId: workspace.workspace.workspaceId, sessionId: crypto.randomUUID() } });
    assert.notEqual(deletionSession.sessionId, sessionId);
    await rpc(origin, "session/selectModel", { request: { sessionId: deletionSession.sessionId, provider: "deepseek-official", model: "deepseek-flash" } });
    const beforeDeletionReady = model.requests;
    await rpc(origin, "session/prompt", { request: { requestId: crypto.randomUUID(), sessionId: deletionSession.sessionId, mode: "queue", content: [{ type: "text", text: "LIBRARY_SMOKE_READY: reply ready without tools." }] } });
    await waitFor(async () => model!.requests > beforeDeletionReady && !(await rpc<{ readonly running: boolean }>(origin, "session/state", { request: { sessionId: deletionSession.sessionId } })).running, "fresh library deletion session ready");
    await rpc(origin, "session/rename", { request: { sessionId: deletionSession.sessionId, title: "书库删除验收新会话" } });
    await reopened.getByRole("treeitem").filter({ hasText: "书库删除验收新会话" }).first().click({ timeout: 20_000 });
    await reopened.locator(`[data-conversation-session="${deletionSession.sessionId}"]`).waitFor({ state: "visible", timeout: 20_000 });
    const reopenDeletionWorkbench = reopened.getByRole("button", { name: "打开长篇工作台", exact: true }); if (await reopenDeletionWorkbench.isVisible()) await reopenDeletionWorkbench.click();
    await waitFor(async () => await reopened.getByRole("list", { name: "小说项目列表" }).getByRole("listitem").count() === 10, "completed books visible from the fresh library session");
    assert.equal((await queue(origin, deletionSession.sessionId))?.ownerSessionId, sessionId, "Opening the library silently took ownership of its completed queue");
    const nativeDialogs: string[] = [];
    reopened.on("dialog", async dialog => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
    await reopened.getByRole("button", { name: "选择已完本", exact: true }).click();
    const deleteResponse = reopened.waitForResponse(response => response.url().includes("/oh-story/library?") && response.request().method() === "POST" && (response.request().postDataJSON() as { action?: string }).action === "delete", { timeout: 10_000 });
    await reopened.getByRole("button", { name: "删除所选书", exact: true }).click();
    await waitFor(async () => await reopened.getByRole("list", { name: "小说项目列表" }).getByRole("listitem").count() === 0, "selected projects immediately hidden without a confirmation dialog", 5000);
    assert.equal((await deleteResponse).status(), 200); assert.deepEqual(nativeDialogs, []);
    assert.equal(await reopened.getByRole("button", { name: /确认.*(?:删除|回收)/u }).count(), 0);
    await waitFor(async () => {
      assert.equal((await librarySnapshot()).books.length, 0, "Accepted completed-book deletion reappeared");
      return (await Promise.all(keys.map(key => absent(model!.books.get(key)!.absolutePath)))).every(Boolean);
    }, "physical deletion of all ten completed book roots", 90_000);
    await waitFor(async () => (await librarySnapshot()).deletingBooks?.length === 0, "completed deletion jobs removed from the durable journal");
    const finalSnapshot = await librarySnapshot();
    assert.equal(finalSnapshot.books.length, 0); assert.equal(finalSnapshot.archivedBooks?.length ?? 0, 0);
    assert.equal(finalSnapshot.deletingBooks?.length ?? 0, 0);
    assert.deepEqual(await readdir(join(libraryPath, "小说项目")), []);
    assert.equal(await readFile(librarySentinel, "utf8"), sentinelText);
    for (const key of [...keys, ...selectionKeys]) assert.equal(await readFile(join(inputFiles, `${key}.txt`), "utf8"), sourceFor(key));
    assert.equal(await absent(join(libraryPath, "追踪/书库任务.json")), false, "Shared library state was removed with a selected book");
    assert.equal((await queue(origin, deletionSession.sessionId))?.ownerSessionId, sessionId, "Deletion took ownership of another session's completed queue");
    assert.equal(model.answers.length, totalAcceptedChapters); assert.equal(model.titles.length, totalAcceptedChapters); assert.equal(model.failures.length, 0, model.failures.join("\n"));
    await reopened.screenshot({ path: join(evidence, "library-deleted.png"), animations: "disabled" }); assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
    const report = {
      ok: true, simultaneousNativeRequests: 10, dshVersion: version, pluginVersion: pluginMetadata.version, pluginSha256,
      provider: "local-deterministic-text-fixture", realPaidModel: false,
      importedBooks: 15, baseBooks: 10, selectedFixtureBooks: 3, deletionFixtureBooks: 2,
      registeredNativeWorkspaces: 15, separateProjectDirectories: 15,
      batches: [{ count: 10, accepted: 100 }, { count: 20, accepted: 48 }, { count: "all", accepted: 4 }],
      baseAcceptedChapters: baseChapters, selectedAcceptedChapters: selectedChapters,
      acceptedChapters: totalAcceptedChapters, freshNativeChapterSessions: totalAcceptedChapters, independentTitleSessions: totalAcceptedChapters,
      authorTitlePromptPreserved: "passed", fiveTitleCandidatesAndRanking: "passed", selectedTitleLength: "passed-15-to-25-characters",
      titleContextIsolation: "passed-current-chapter-only", titleRetryWithoutRewritingProse: "passed", chapterTxtFiles: totalAcceptedChapters,
      selectedUiStart: "passed-only-two-checked-books", unselectedBookDispatch: "none-before-explicit-selection",
      selectedTenChapterTarget: "passed-exactly-10-of-12", individualPause: "passed-other-book-continued", individualResume: "passed-original-target-unchanged",
      appendSelectedWhileRunning: "passed", selectedCount50: "passed-capped-to-two-chapter-outline",
      hostCommittedTextAndState: "passed", originalSystemSha256: ORIGINAL_SYSTEM_PROMPT_SHA256, originalRewriteAndBackup: "passed",
      fullStyleAndPreviousTen: "passed", bookIsolation: "passed", exportedBooks: 13,
      batchTxtZipDownload: "passed-10-book-zips-152-chapter-txts", selectedBookExport: "passed-3-book-zips-15-chapter-txts",
      backgroundDeletion: "passed-running-and-pending-books-physically-removed", deletionAcknowledgmentMs,
      failedDeletionAutoRetry: "passed-hidden-symlink-failure-then-automatic-recovery", outsideDeletionTarget: "preserved",
      deletedQueueResurrection: "prevented-on-resume-and-new-batch", uiPermanentDeletion: "passed-10-books-no-confirmation-no-recycle",
      crossSessionCompletedBookDeletion: "passed-without-taking-queue-ownership", libraryAndOriginalInputPreservation: "passed",
      failedBookIsolationAndRetry: "passed", pauseResume: "passed", stopResumeFixedTargets: "passed", duplicateStart: "passed",
      nativeHostRestart: "passed", browserCloseAndReopen: "passed", novelOnlyPackageAndUI: "passed",
      fullWidthLibrary: "passed", narrowLibraryOverflow: "none", advancedRecordsDefault: "collapsed-without-auto-selected-json", internalRecordEditor: "read-only",
      outsideSymlinkImport: "rejected-without-outside-writes", modelToolCalls: 0, literaryQuality: "not assessed"
    };
    await writeFile(join(evidence, "library-smoke.json"), `${JSON.stringify(report, null, 2)}\n`); for (const name of ["library-failure.log", "library-failure.png", "library-failure-aria.txt"]) await rm(join(evidence, name), { force: true });
    process.stdout.write(`${JSON.stringify(report)}\n`); passed = true;
  } catch (error) {
    if (browser !== undefined) { const page = browser.contexts()[0]?.pages()[0]; if (page !== undefined) { await page.screenshot({ path: join(evidence, "library-failure.png") }).catch(() => undefined); await writeFile(join(evidence, "library-failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => undefined); } }
    const failure = redact(`${String(error)}\nFixture failures: ${JSON.stringify(model?.failures)}\nTemporary: ${temporary}\n${logs.join("").slice(-16000)}`); await writeFile(join(evidence, "library-failure.log"), failure);
    // eslint-disable-next-line preserve-caught-error -- Native startup can contain token URLs; only redacted diagnostics may escape.
    throw new Error(failure);
  } finally {
    if (browser !== undefined) await browser.close(); if (child !== undefined) await stopDshProcess(child);
    if (model !== undefined) { model.server.closeAllConnections(); await new Promise<void>(done => model?.server.close(() => done())); }
    if (passed && process.env.LIBRARY_SMOKE_KEEP !== "1") await rm(temporary, { recursive: true, force: true }); else process.stdout.write(`Retained test workspace: ${temporary}\n`);
  }
}
await main();
