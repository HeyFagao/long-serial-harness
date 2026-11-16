/** Packaged novel library: real DSH/native sessions/browser, local text-only model, no paid API. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { chromium, type Browser, type Page, type Response as BrowserResponse } from "@playwright/test";
import { ORIGINAL_SYSTEM_PROMPT, ORIGINAL_SYSTEM_PROMPT_SHA256 } from "../packages/dsh-plugin/src/original-prompts.js";
import type { LibraryBook, LibrarySnapshot } from "../packages/dsh-plugin/src/serial-library.js";
import type { LibraryTask } from "../packages/dsh-plugin/src/serial-library-runtime.js";
import { deterministicNativeOutput } from "./serial-fixtures/native-output.js";
import { authorizeDsh, dshFetch, freePort, isolateFirstUseWorkspace, rpc, stopDshProcess } from "./native-dsh-helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.DSH_TEST_VERSION ?? "0.2.2-rc.3";
const evidence = resolve(process.env.LIBRARY_EVIDENCE_DIR ?? join(root, "..", "library-evidence"));
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sleep = (milliseconds: number): Promise<void> => new Promise(done => setTimeout(done, milliseconds));
const keys = Array.from({ length: 10 }, (_, index) => `SMOKEBOOK${String(index + 1).padStart(2, "0")}`);
const totalFor = (key: string): number => keys.indexOf(key) < 2 ? 32 : 11;
const chapterPath = (chapter: number): string => `正文/第${String(chapter).padStart(3, "0")}章.md`;
const titleFor = (key: string): string => `回归小说${key.slice(-2)}`;
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
interface ModelFixture { server: Server; baseURL: string; books: Map<string, LibraryBook>; answers: Answer[]; waiting: Set<string>; holds: Set<string>; failures: string[]; requests: number; shortDraft?: { readonly text: string; readonly sessionId: string }; rewritePassed: boolean }
function blocks(message: WireMessage): readonly Block[] { return Array.isArray(message.content) ? message.content as Block[] : typeof message.content === "string" ? [{ type: "text", text: message.content }] : []; }
async function assertPrompt(book: LibraryBook, key: string, chapter: number, prompt: string): Promise<void> {
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
  const model: ModelFixture = { server: undefined as unknown as Server, baseURL: "", books: new Map(), answers: [], waiting: new Set(), holds: new Set(), failures: [], requests: 0, rewritePassed: false };
  const server = createServer((request, response) => {
    let body = "";
    // Full Chinese prose spans HTTP chunks; the streaming decoder preserves split UTF-8 codepoints.
    request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", async () => {
      try {
        if (request.method !== "POST" || !request.url?.endsWith("/v1/messages")) { response.writeHead(404).end(); return; }
        model.requests += 1;
        const payload = JSON.parse(body) as { readonly messages?: readonly WireMessage[] };
        const messages = payload.messages ?? [];
        const matching = messages.filter(message => message.role === "user").map(message => blocks(message).map(block => block.text ?? "").join("\n")).filter(text => /本轮只完成当前工作区这本书的第 \d+ 章/u.test(text));
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
          if (key === keys[0] && chapter === 3 && model.shortDraft === undefined) {
            text = deterministicNativeOutput({ bookKey: key, chapter, minChars: 400 });
            model.shortDraft = { text, sessionId };
          } else {
            if (key === keys[0] && chapter === 3) {
              assert(model.shortDraft !== undefined && model.shortDraft.sessionId !== sessionId, "Repair reused the failed writing conversation");
              for (const originalText of ["下面是你上一版章节正文与状态变更，程序检测发现以下问题：", "请通读原文，只针对上述问题做最小修改，保留其余内容、人物与剧情走向不变。", "【上一版原文】"]) assert(prompt.includes(originalText), "The original REWRITE template was replaced");
              const split = model.shortDraft.text.indexOf("【状态变更】");
              assert(prompt.includes(model.shortDraft.text.slice(0, split).trim()) && prompt.includes(model.shortDraft.text.slice(split).trim()), "Repair did not receive both original output blocks");
              model.rewritePassed = true;
            }
            text = deterministicNativeOutput({ bookKey: key, chapter });
            model.answers.push({ key, chapter, sessionId, text });
          }
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
  const response = page.waitForResponse(item => item.url().includes("/oh-story/library/queue?") && item.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name, exact: true }).click({ timeout: 20_000 }); assert.equal((await response).status(), 200);
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
async function checkBook(book: LibraryBook, key: string): Promise<void> {
  const total = totalFor(key);
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
  }
}
async function checkNativeChildren(home: string, model: ModelFixture): Promise<void> {
  const directory = join(home, "sessions"); const files = await readdir(directory, { recursive: true });
  assert.equal(new Set(model.answers.map(answer => answer.sessionId)).size, 152);
  for (const answer of model.answers) {
    const file = files.find(path => path.endsWith(`${answer.sessionId}/session.v4.jsonl.zstd`)); assert(file !== undefined);
    const lines = zstdDecompressSync(await readFile(join(directory, file))).toString("utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!) as { readonly parentSession: string; readonly origin: string; readonly isSeeded: boolean; readonly agentPreset: string; readonly cwd?: string };
    assert.equal(header.origin, "subagent"); assert.equal(header.isSeeded, false); assert.equal(header.agentPreset, "standard"); assert(header.parentSession.length > 0);
    const bookPath = await realpath(model.books.get(answer.key)!.absolutePath); assert(header.cwd !== undefined); assert.equal(await realpath(header.cwd), bookPath, "Native chapter was attached to the wrong book directory");
    const parentFile = files.find(path => path.endsWith(`${header.parentSession}/session.v4.jsonl.zstd`)); assert(parentFile !== undefined);
    const parentHeader = JSON.parse(zstdDecompressSync(await readFile(join(directory, parentFile))).toString("utf8").split("\n")[0]!) as { readonly cwd: string; readonly isSeeded: boolean };
    assert.equal(await realpath(parentHeader.cwd), bookPath); assert.equal(parentHeader.isSeeded, false);
    const events = lines.slice(1).map(line => JSON.parse(line) as { readonly type: string; readonly seq: number; readonly data: Record<string, unknown> });
    assert.equal(events[0]?.seq, 0); assert.equal(events[0]?.type, "subagent/descriptor"); assert.equal(events[0]?.data.agentProvider, "deepseek-official"); assert.equal(events[0]?.data.agentModel, "deepseek-flash");
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
    const configuredTarball = process.env.SERIAL_PLUGIN_TARBALL; assert(configuredTarball !== undefined, "Set SERIAL_PLUGIN_TARBALL to the exact frozen novel-only package; this smoke never repacks");
    const tarball = resolve(configuredTarball); const pluginSha256 = digest(await readFile(tarball)); await cp(tarball, join(evidence, "novel-plugin-tested.tgz"));
    const entries = command("tar", ["-tzf", tarball]).trim().split("\n");
    assert(!entries.some(path => /(?:\/SKILL\.md$|\/roles\/|\/skills\/|\/knowledge\/|\/drama\/|\/novel-to-game\/|\/video-recap\/|\.map$)/u.test(path)), "Novel package still contains removed knowledge or source maps");
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
    await page.screenshot({ path: join(evidence, "library-import.png"), animations: "disabled" });
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
    await page.getByRole("button", { name: "所有项目新增 10 章", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await assertImportContainment(origin, sessionId, libraryPath, temporary);
    if (process.env.LIBRARY_IMPORT_ONLY === "1") {
      const report = { ok: true, phase: "import-only", dshVersion: version, pluginSha256, importedBooks: 10, registeredNativeWorkspaces: 10, separateProjectDirectories: 10, sourceBytesExact: true, outsideSymlinkImport: "rejected-without-outside-writes", novelOnlyPackageAndUI: "passed", nativeOwnerTurn: "passed", chapterGeneration: "not run", realPaidModel: false };
      for (const name of ["library-failure.log", "library-failure.png", "library-failure-aria.txt"]) await rm(join(evidence, name), { force: true });
      await writeFile(join(evidence, "library-import-smoke.json"), `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report)}\n`); passed = true; return;
    }
    const blocked = model.books.get(keys[9]!)!; const blockedStyle = join(blocked.absolutePath, "设定/文风.md"); const style = await readFile(blockedStyle); await rm(blockedStyle);
    model.holds.add(`${keys[0]!}/1`); await clickQueue(page, "所有项目新增 10 章");
    const started = (await queue(origin, sessionId))!; assert.equal(started.count, 10);
    const repeated = await Promise.allSettled([queue(origin, sessionId, { action: "start", count: 10 }), queue(origin, sessionId, { action: "start", count: 10 })]); assert(repeated.every(result => result.status === "rejected" || result.value?.id === started.id));
    await waitNativeRequest(origin, sessionId, model, `${keys[0]!}/1`);
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
    model.holds.add(`${keys[0]!}/11`);
    const secondStarted = (await queue(origin, sessionId, { action: "start", count: 20 }))!;
    await waitNativeRequest(origin, sessionId, model, `${keys[0]!}/11`);
    await queue(origin, sessionId, { action: "stop" }); await waitQueue(origin, sessionId, task => task.status === "stopped");
    await waitFor(async () => !model!.waiting.has(`${keys[0]!}/11`), "stopped native model response cancellation"); assert.equal(model.answers.length, 100);
    model.holds.delete(`${keys[0]!}/11`);
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
      const text = await exported.text(); assert(!text.includes("【状态变更】")); assert(text.includes(`第${String(totalFor(key))}章 ${key}的账册`));
      assert.deepEqual([...new Set(text.match(/SMOKEBOOK\d{2}/gu))], [key]);
    }
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
    await reopened.screenshot({ path: join(evidence, "library-complete.png"), animations: "disabled" }); assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
    const report = { ok: true, dshVersion: version, pluginSha256, provider: "local-deterministic-text-fixture", realPaidModel: false, importedBooks: 10, registeredNativeWorkspaces: 10, separateProjectDirectories: 10, batches: [{ count: 10, accepted: 100 }, { count: 20, accepted: 48 }, { count: "all", accepted: 4 }], acceptedChapters: 152, freshNativeChapterSessions: 152, hostCommittedTextAndState: "passed", originalSystemSha256: ORIGINAL_SYSTEM_PROMPT_SHA256, originalRewriteAndBackup: "passed", fullStyleAndPreviousTen: "passed", bookIsolation: "passed", exportedBooks: 10, failedBookIsolationAndRetry: "passed", pauseResume: "passed", stopResumeFixedTargets: "passed", duplicateStart: "passed", nativeHostRestart: "passed", browserCloseAndReopen: "passed", novelOnlyPackageAndUI: "passed", outsideSymlinkImport: "rejected-without-outside-writes", modelToolCalls: 0, literaryQuality: "not assessed" };
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
