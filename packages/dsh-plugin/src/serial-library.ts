import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { parseSerialOutline } from "./serial-outline.js";
import { importSerialOutline } from "./serial-route.js";
import { jsonBody, mapFsError, readVersionedFile, send, workspaceRealmForSession, WorkspaceHttpError, type WorkspaceRealm } from "./workspace-route.js";
import { isTrustedWorkspaceRequest } from "./workspace-request-trust.js";

export const LIBRARY_DIRECTORY = "小说项目";
const BOOK_RECEIPT = "追踪/书项目.json";
export const LIBRARY_LIMITS = { maxFiles: 50, maxBytesPerFile: 2_097_152, maxTotalBytes: 33_554_432 } as const;

export interface LibraryInputFile { readonly filename: string; readonly text: string; readonly title?: string }
export interface LibraryBook {
  readonly id: string;
  readonly title: string;
  readonly filename: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly totalChapters: number;
  readonly completedChapters: number;
  readonly status: string;
  readonly error?: string;
}
interface BookReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly filename: string;
  readonly sourceSha256: string;
  readonly libraryPath: string;
  readonly relativePath: string;
  readonly totalChapters: number;
  readonly status: "importing" | "ready";
}
export interface LibrarySnapshot {
  readonly libraryPath: string;
  readonly parentLibraryPath?: string;
  readonly isBookProject: boolean;
  readonly books: readonly LibraryBook[];
  readonly limits: typeof LIBRARY_LIMITS;
}
export interface LibraryImportResult {
  readonly filename: string;
  readonly status: "imported" | "existing" | "failed";
  readonly book?: LibraryBook;
  readonly error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Every target, including book directories and receipt files, stays in the original authorized library. */
async function containedTarget(realm: WorkspaceRealm, relativePath: string): Promise<FsTarget> {
  if (relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.split("/").some(part => part === ".." || part === "." || part === "")) throw new WorkspaceHttpError(400, "书项目路径无效。");
  const target = await realm.fs.resolve(relativePath, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "书项目路径离开了当前书库，请检查是否有指向外部的快捷方式或符号链接。");
  return target;
}

async function readJson(realm: WorkspaceRealm, relativePath: string): Promise<{ value: Record<string, unknown>; version: FsVersion } | undefined> {
  const target = await containedTarget(realm, relativePath);
  if (await realm.fs.stat(target) === undefined) return undefined;
  const file = await readVersionedFile(realm.fs, target, 2_097_152);
  try {
    const value = record(JSON.parse(file.content));
    if (value === undefined) throw new Error();
    return { value, version: file.version };
  } catch { throw new WorkspaceHttpError(409, `${relativePath} 不是有效的项目记录，已保留原文件。`); }
}

function receiptOf(value: Record<string, unknown>): BookReceipt {
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[a-f0-9]{64}$/u.test(value.id)
    || typeof value.title !== "string" || typeof value.filename !== "string" || typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceSha256)
    || typeof value.libraryPath !== "string" || typeof value.relativePath !== "string"
    || !Number.isSafeInteger(value.totalChapters) || Number(value.totalChapters) < 1
    || (value.status !== "ready" && value.status !== "importing")) throw new WorkspaceHttpError(409, "书项目记录格式无效，未改动已有内容。");
  return value as unknown as BookReceipt;
}

export async function realmForLibraryBook(library: WorkspaceRealm, relativePath: string): Promise<WorkspaceRealm> {
  if (!relativePath.startsWith(`${LIBRARY_DIRECTORY}/`) || relativePath.split("/").length !== 2) throw new WorkspaceHttpError(400, "书项目必须是当前书库内的独立目录。");
  const root = await containedTarget(library, relativePath);
  return { ...library, cwd: library.fs.processPath(root), root };
}

async function bookView(realm: WorkspaceRealm, receipt: BookReceipt): Promise<LibraryBook> {
  const state = await readJson(realm, "追踪/_tracking-state.json");
  const task = await readJson(realm, "追踪/连载任务.json");
  const completed = state?.value.last_committed_chapter;
  const completedChapters = typeof completed === "number" && Number.isSafeInteger(completed) && completed >= 0 ? completed : 0;
  return {
    id: receipt.id, title: receipt.title, filename: receipt.filename, absolutePath: realm.cwd,
    relativePath: receipt.relativePath, totalChapters: receipt.totalChapters, completedChapters,
    status: receipt.status !== "ready" ? "incomplete" : typeof task?.value.status === "string" ? task.value.status : "ready",
    ...(typeof task?.value.error === "string" ? { error: task.value.error } : {})
  };
}

/** Disk receipts, rather than browser state, are the durable book catalogue. */
export async function listLibraryBooks(realm: WorkspaceRealm): Promise<LibrarySnapshot> {
  const own = await readJson(realm, BOOK_RECEIPT);
  if (own !== undefined) {
    const receipt = receiptOf(own.value);
    return { libraryPath: realm.cwd, parentLibraryPath: receipt.libraryPath, isBookProject: true, books: [await bookView(realm, receipt)], limits: LIBRARY_LIMITS };
  }
  const directory = await containedTarget(realm, LIBRARY_DIRECTORY);
  const stat = await realm.fs.stat(directory);
  if (stat === undefined) return { libraryPath: realm.cwd, isBookProject: false, books: [], limits: LIBRARY_LIMITS };
  if (stat.type !== "directory") throw new WorkspaceHttpError(409, "小说项目不是目录，请先处理同名文件。");
  const books: LibraryBook[] = [];
  for (const entry of await realm.fs.listDir(directory)) {
    if (entry.type !== "directory") continue;
    if (!realm.fs.contains(realm.root, entry.target)) continue;
    let child: WorkspaceRealm | undefined;
    try {
      child = await realmForLibraryBook(realm, `${LIBRARY_DIRECTORY}/${entry.name}`);
      const stored = await readJson(child, BOOK_RECEIPT);
      if (stored === undefined) continue;
      const receipt = receiptOf(stored.value);
      if (receipt.relativePath !== `${LIBRARY_DIRECTORY}/${entry.name}`) throw new WorkspaceHttpError(409, "书项目记录与目录不一致，请先核对移动过的项目。");
      books.push(await bookView(child, receipt));
    } catch (error) {
      books.push({ id: createHash("sha256").update(`${realm.cwd}/${entry.name}`).digest("hex"), title: entry.name, filename: "", absolutePath: child?.cwd ?? "",
        relativePath: `${LIBRARY_DIRECTORY}/${entry.name}`, totalChapters: 0, completedChapters: 0, status: "blocked",
        error: error instanceof Error ? error.message : "本书记录不可读，请先处理此项目。" });
    }
  }
  return { libraryPath: realm.cwd, isBookProject: false, books: books.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN") || a.id.localeCompare(b.id)), limits: LIBRARY_LIMITS };
}

export function validateLibraryInputs(value: unknown): readonly LibraryInputFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIBRARY_LIMITS.maxFiles) throw new WorkspaceHttpError(400, `每批请选择 1—${String(LIBRARY_LIMITS.maxFiles)} 个最终输出文件。`);
  let totalBytes = 0;
  const files: LibraryInputFile[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (item === undefined || typeof item.filename !== "string" || item.filename.trim() === "" || item.filename.length > 255
      || typeof item.text !== "string" || (item.title !== undefined && (typeof item.title !== "string" || item.title.length > 200))) throw new WorkspaceHttpError(400, "每个导入项目必须包含文件名和完整文本，可选书名最多 200 字。");
    const bytes = Buffer.byteLength(item.text, "utf8");
    if (bytes > LIBRARY_LIMITS.maxBytesPerFile) throw new WorkspaceHttpError(413, `${item.filename} 超过 2 MB。`);
    totalBytes += bytes;
    files.push({ filename: item.filename, text: item.text, ...(item.title === undefined ? {} : { title: item.title }) });
  }
  if (totalBytes > LIBRARY_LIMITS.maxTotalBytes) throw new WorkspaceHttpError(413, "本次文件合计超过 32 MB，请分批导入。");
  return files;
}

function folderTitle(title: string): string {
  const printable = [...title.normalize("NFC")].map(char => char.charCodeAt(0) < 32 ? "_" : char).join("");
  const safe = [...printable.replace(/[<>:"/\\|?*]/gu, "_").replace(/[. ]+$/u, "").trim()].slice(0, 48).join("");
  return safe === "" || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(safe) ? `小说_${safe}` : safe;
}

async function importBook(realm: WorkspaceRealm, file: LibraryInputFile): Promise<LibraryImportResult> {
  const parsed = parseSerialOutline(file.text);
  const errors = parsed.diagnostics.filter(issue => issue.severity === "error");
  if (errors.length > 0) throw new WorkspaceHttpError(422, errors.map(issue => `第 ${String(issue.line)} 行：${issue.message}`).join("\n"));
  const filenameTitle = file.filename.replace(/\.(?:txt|md)$/iu, "");
  const title = file.title?.trim() || (parsed.title === "未命名长篇" ? filenameTitle : parsed.title);
  if (title.length > 200) throw new WorkspaceHttpError(422, "解析得到的书名超过 200 字，请修改原文件书名或指定较短的项目名后重试。");
  const sourceSha256 = createHash("sha256").update(file.text, "utf8").digest("hex");
  const id = createHash("sha256").update(JSON.stringify([sourceSha256, title]), "utf8").digest("hex");
  const relativePath = `${LIBRARY_DIRECTORY}/${folderTitle(title)}--${id.slice(0, 12)}`;
  const child = await realmForLibraryBook(realm, relativePath);
  const previous = await readJson(child, BOOK_RECEIPT);
  if (previous === undefined && await realm.fs.stat(child.root) !== undefined) throw new WorkspaceHttpError(409, "目标目录已经存在但不是此书的导入项目，未覆盖其文件。");
  const receipt: BookReceipt = { schemaVersion: 1, id, title, filename: file.filename, sourceSha256, libraryPath: realm.cwd, relativePath, totalChapters: parsed.chapters.length, status: "importing" };
  if (previous !== undefined) {
    const stored = receiptOf(previous.value);
    if (stored.id !== id || stored.sourceSha256 !== sourceSha256 || stored.relativePath !== relativePath) throw new WorkspaceHttpError(409, "目标项目与当前输入不同，已保留原项目。");
    if (stored.status === "ready") return { filename: file.filename, status: "existing", book: await bookView(child, stored) };
  } else {
    await realm.fs.writeText(await containedTarget(child, BOOK_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { kind: "createIfAbsent" }, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
  }
  await importSerialOutline(child, file.text, title);
  const checkpoint = await readJson(child, BOOK_RECEIPT);
  if (checkpoint === undefined || checkpoint.value.id !== id) throw new WorkspaceHttpError(409, "导入记录已变化，请刷新后核对。");
  const ready: BookReceipt = { ...receipt, status: "ready" };
  await realm.fs.writeText(await containedTarget(child, BOOK_RECEIPT), `${JSON.stringify(ready, null, 2)}\n`, { kind: "replaceIfVersion", version: checkpoint.version }, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
  return { filename: file.filename, status: "imported", book: await bookView(child, ready) };
}

/** A failed book stays isolated; retrying identical inputs reuses completed projects and fills incomplete ones. */
export async function importLibraryBooks(realm: WorkspaceRealm, files: readonly LibraryInputFile[]): Promise<LibrarySnapshot & { readonly results: readonly LibraryImportResult[] }> {
  validateLibraryInputs(files);
  if (await readJson(realm, BOOK_RECEIPT) !== undefined) throw new WorkspaceHttpError(409, "当前是单本小说，请先回到书库再批量导入新项目。");
  const results: LibraryImportResult[] = [];
  for (const file of files) {
    try { results.push(await importBook(realm, file)); }
    catch (reason) {
      const mapped = reason instanceof WorkspaceHttpError ? reason : mapFsError(reason);
      results.push({ filename: file.filename, status: "failed", error: mapped?.message ?? (reason instanceof Error ? reason.message : "本书导入失败。") });
    }
  }
  return { ...await listLibraryBooks(realm), results };
}

export function registerLibraryRoute(context: Context, options: { readonly trustedHosts?: readonly string[] } = {}): void {
  const locks = new Map<string, Promise<unknown>>();
  context.effect(() => context.webServer.register({ kind: "exact", path: "/oh-story/library", async handler(request: IncomingMessage, response: ServerResponse) {
    try {
      if (!isTrustedWorkspaceRequest(request, options.trustedHosts ?? [])) throw new WorkspaceHttpError(403, "请求来源不受信任。");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const realm = await workspaceRealmForSession(context, url.searchParams.get("sessionId") ?? "");
      if (request.method === "GET") { send(response, 200, await listLibraryBooks(realm)); return; }
      if (request.method !== "POST") throw new WorkspaceHttpError(405, "仅支持 GET 和 POST。");
      const input = await jsonBody(request, LIBRARY_LIMITS.maxTotalBytes * 3 + 65536);
      const files = validateLibraryInputs(input.files);
      const key = realm.root.targetKey;
      const previous = locks.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => importLibraryBooks(realm, files));
      locks.set(key, current);
      try { send(response, 200, await current); }
      finally { if (locks.get(key) === current) locks.delete(key); }
    } catch (error) {
      const mapped = error instanceof WorkspaceHttpError ? error : mapFsError(error);
      send(response, mapped?.status ?? 409, { error: mapped?.message ?? (error instanceof Error ? error.message : "书库操作失败。") });
    }
  } }), "serial novel library import");
}
