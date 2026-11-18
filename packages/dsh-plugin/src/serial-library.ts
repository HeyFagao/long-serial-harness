import { createChapterZip, safeExportName } from "./serial-export.js";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { parseSerialOutline } from "./serial-outline.js";
import { zipSync, strToU8 } from "fflate";
import { exportSerialChapters, importSerialOutline } from "./serial-route.js";
import { jsonBody, mapFsError, readVersionedFile, send, workspaceRealmForSession, WorkspaceHttpError, type WorkspaceRealm } from "./workspace-route.js";
import { isTrustedWorkspaceRequest } from "./workspace-request-trust.js";
import { DELETION_JOURNAL, deletionJobs, enqueueBookDeletion, resumeBookDeletions } from "./serial-library-deletion-jobs.js";
import { withLibraryOperation } from "./serial-library-operations.js";
import { syncNativeLibrarySidebarOrder } from "./serial-sidebar-order.js";
import { assignLibraryOrder, compareLibraryInputFilenames, extendLibraryOrder, LIBRARY_ORDER_PATH, moveLibraryDisplayOrder, parseLibraryOrder, resetLibraryDisplayOrder, type LibraryBookMove, type LibraryOrder } from "./serial-library-order.js";

import { addFolder, availableFolderName, dropFolder, emptyFiling, requireFolder, settleFiling, type LibraryFiling, type LibraryFolder } from "./serial-library-folders.js";
export type { LibraryFolder } from "./serial-library-folders.js";

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
  readonly sequence?: number;
  readonly folderId?: string;
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
  readonly archivedAt?: string;
  readonly deletingAt?: string;
}
export interface LibrarySnapshot {
  readonly libraryPath: string;
  readonly parentLibraryPath?: string;
  readonly isBookProject: boolean;
  readonly books: readonly LibraryBook[];
  readonly limits: typeof LIBRARY_LIMITS;
  readonly orderCustomized?: true;
  readonly folders?: readonly LibraryFolder[];
  readonly archivedBooks?: readonly LibraryBook[];
  readonly deletingBooks?: readonly LibraryBook[];
}
export interface LibraryImportResult {
  readonly filename: string;
  readonly status: "imported" | "existing" | "failed";
  readonly resumed?: true;
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

async function readLibraryOrder(realm: WorkspaceRealm): Promise<{ readonly order: LibraryOrder; readonly version: FsVersion } | undefined> {
  try {
    const stored = await readJson(realm, LIBRARY_ORDER_PATH);
    return stored === undefined ? undefined : { order: parseLibraryOrder(stored.value), version: stored.version };
  } catch { throw new WorkspaceHttpError(409, "书库顺序记录损坏或无法读取，已保留原文件，未重新编号。"); }
}

async function writeLibraryOrder(realm: WorkspaceRealm, order: LibraryOrder, version: FsVersion | undefined): Promise<void> {
  await realm.fs.writeText(await containedTarget(realm, LIBRARY_ORDER_PATH), `${JSON.stringify(order, null, 2)}\n`,
    version === undefined ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version }, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
}

function allLibraryBooks(snapshot: LibrarySnapshot): LibraryBook[] {
  return [...snapshot.books, ...(snapshot.archivedBooks ?? []), ...(snapshot.deletingBooks ?? [])];
}

/** Called inside the library mutation lock, before adding, hiding or removing catalogue identities. */
export async function ensureLibraryOrder(realm: WorkspaceRealm, reserveIds: readonly string[] = []): Promise<LibraryOrder> {
  const stored = await readLibraryOrder(realm);
  const snapshot = await listLibraryBooks(realm);
  if (snapshot.isBookProject) throw new WorkspaceHttpError(409, "请回到书库总览管理书籍顺序。");
  const books = allLibraryBooks(snapshot);
  const derived = assignLibraryOrder(books, stored?.order).order;
  const extended = extendLibraryOrder(derived, reserveIds);
  const filing = settleFiling(extended.filing ?? emptyFiling, books);
  const recovered = extended.filing !== undefined && filing !== extended.filing;
  const next = recovered ? { ...extended, filing } : extended;
  if ((stored === undefined && Object.keys(next.sequences).length > 0) || (stored !== undefined && (next.nextSequence !== stored.order.nextSequence || recovered))) {
    await writeLibraryOrder(realm, next, stored?.version);
  }
  return next;
}

interface ImportFolderOptions { readonly folderId?: string; readonly folderName?: string }
interface ImportFolderBatch { readonly name?: string; folderId?: string; assigned: boolean }

function importFolderBatch(options: ImportFolderOptions, filing: LibraryFiling): ImportFolderBatch {
  if (options.folderId !== undefined && options.folderName !== undefined) throw new WorkspaceHttpError(400, "请选择已有文件夹，或为新文件夹命名。");
  if (options.folderId !== undefined) return { folderId: requireFolder(filing, options.folderId).id, assigned: false };
  return options.folderName === undefined ? { assigned: false } : { name: availableFolderName(filing, options.folderName), assigned: false };
}

async function reserveImportedBook(realm: WorkspaceRealm, id: string, batch: ImportFolderBatch): Promise<void> {
  const stored = await readLibraryOrder(realm);
  const order = extendLibraryOrder(stored?.order, [id]);
  let filing = order.filing ?? emptyFiling;
  let folderId = batch.folderId;
  if (folderId === undefined) {
    const created = addFolder(filing, randomUUID(), batch.name, true);
    filing = created.filing;
    folderId = created.folder.id;
  } else requireFolder(filing, folderId);
  const next = { ...order, filing: { ...filing, memberships: { ...filing.memberships, [id]: folderId } } };
  await writeLibraryOrder(realm, next, stored?.version);
  batch.folderId = folderId;
  batch.assigned = true;
}

export type LibraryFolderChange =
  | { readonly action: "createFolder"; readonly name: unknown }
  | { readonly action: "renameFolder"; readonly folderId: unknown; readonly name: unknown }
  | { readonly action: "moveToFolder"; readonly folderId: unknown; readonly ids: readonly string[] }
  | { readonly action: "deleteEmptyFolder"; readonly folderId: unknown };

export async function changeLibraryFolders(realm: WorkspaceRealm, change: LibraryFolderChange): Promise<LibrarySnapshot & { createdFolderId?: string }> {
  await ensureLibraryOrder(realm);
  const stored = await readLibraryOrder(realm);
  const snapshot = await listLibraryBooks(realm);
  const order = stored?.order ?? extendLibraryOrder(undefined, []);
  const filing = order.filing ?? emptyFiling;
  let next: LibraryFiling;
  let createdFolderId: string | undefined;
  if (change.action === "createFolder") {
    const created = addFolder(filing, randomUUID(), availableFolderName(filing, change.name));
    next = created.filing;
    createdFolderId = created.folder.id;
  } else if (change.action === "moveToFolder") {
    const target = change.folderId === null ? null : requireFolder(filing, change.folderId).id;
    const ids = selectedLibraryIds(change.ids);
    const visible = new Set(snapshot.books.map(book => book.id));
    if (ids.some(id => !visible.has(id))) throw new WorkspaceHttpError(409, "选中的书已发生变化，请刷新后重新勾选。");
    const memberships = { ...filing.memberships };
    for (const id of ids) {
      if (target === null) delete memberships[id];
      else memberships[id] = target;
    }
    next = { ...filing, memberships };
  } else {
    const folder = requireFolder(filing, change.folderId);
    if (change.action === "deleteEmptyFolder") {
      if (allLibraryBooks(snapshot).some(book => book.folderId === folder.id)) throw new WorkspaceHttpError(409, "这个文件夹还有书籍或正在清理的项目，移空后才能删除文件夹。");
      next = dropFolder(filing, folder.id);
    } else {
      const name = availableFolderName(filing, change.name, folder.id);
      next = { ...filing, folders: filing.folders.map(item => item.id === folder.id ? { ...item, name } : item) };
    }
  }
  await writeLibraryOrder(realm, { ...order, filing: next }, stored?.version);
  return { ...await listLibraryBooks(realm), ...(createdFolderId === undefined ? {} : { createdFolderId }) };
}

/** Display edits leave the assigned book numbers and export order intact. */
export async function changeLibraryBookOrder(realm: WorkspaceRealm, move?: LibraryBookMove): Promise<LibrarySnapshot> {
  const snapshot = await listLibraryBooks(realm);
  if (snapshot.isBookProject) throw new WorkspaceHttpError(409, "请回到书库总览调整顺序。");
  if (move !== undefined) {
    const moving = snapshot.books.find(book => book.id === move.id);
    const target = snapshot.books.find(book => book.id === move.targetId);
    if (!moving || !target) throw new WorkspaceHttpError(409, "要调整的书不在当前书库列表中，请刷新后重试。");
    if (moving.folderId !== target.folderId) throw new WorkspaceHttpError(409, "两本书已分属不同文件夹，请刷新后在同一文件夹内整理顺序。");
  }
  const stored = await readLibraryOrder(realm);
  const current = assignLibraryOrder(allLibraryBooks(snapshot), stored?.order).order;
  const next = move === undefined ? resetLibraryDisplayOrder(current) : moveLibraryDisplayOrder(current, move);
  if (next === current) return snapshot;
  await writeLibraryOrder(realm, next, stored?.version);
  return listLibraryBooks(realm);
}

export async function realmForLibraryBook(library: WorkspaceRealm, relativePath: string): Promise<WorkspaceRealm> {
  if (!relativePath.startsWith(`${LIBRARY_DIRECTORY}/`) || relativePath.split("/").length !== 2) throw new WorkspaceHttpError(400, "书项目必须是当前书库内的独立目录。");
  const root = await containedTarget(library, relativePath);
  return { ...library, cwd: library.fs.processPath(root), root };
}

async function bookView(realm: WorkspaceRealm, receipt: BookReceipt): Promise<LibraryBook> {
  const base = { id: receipt.id, title: receipt.title, filename: receipt.filename, absolutePath: realm.cwd,
    relativePath: receipt.relativePath, totalChapters: receipt.totalChapters, completedChapters: 0 };
  if (receipt.deletingAt !== undefined) return { ...base, status: "deleting" };
  try {
  const state = await readJson(realm, "追踪/_tracking-state.json");
  const task = await readJson(realm, "追踪/连载任务.json");
  const completed = state?.value.last_committed_chapter;
  const completedChapters = typeof completed === "number" && Number.isSafeInteger(completed) && completed >= 0 ? completed : 0;
  return {
    id: receipt.id, title: receipt.title, filename: receipt.filename, absolutePath: realm.cwd,
    relativePath: receipt.relativePath, totalChapters: receipt.totalChapters, completedChapters,
    status: receipt.archivedAt !== undefined ? "archived" : receipt.status !== "ready" ? "incomplete" : typeof task?.value.status === "string" ? task.value.status : "ready",
    ...(typeof task?.value.error === "string" ? { error: task.value.error } : {})
  };
  } catch (error) {
    // Broken generation records must not replace the durable identity needed for deletion.
    return { ...base, status: receipt.archivedAt === undefined ? "blocked" : "archived", error: error instanceof Error ? error.message : "本书生成记录不可读。" };
  }
}

/** Disk receipts, rather than browser state, are the durable book catalogue. */
export async function listLibraryBooks(realm: WorkspaceRealm): Promise<LibrarySnapshot> {
  const own = await readJson(realm, BOOK_RECEIPT);
  if (own !== undefined) {
    const receipt = receiptOf(own.value);
    return { libraryPath: realm.cwd, parentLibraryPath: receipt.libraryPath, isBookProject: true, books: [await bookView(realm, receipt)], limits: LIBRARY_LIMITS };
  }
  const directory = await containedTarget(realm, LIBRARY_DIRECTORY);
  const journal = await readJson(realm, DELETION_JOURNAL);
  const deletingBooks: LibraryBook[] = journal === undefined ? [] : deletionJobs(journal.value).map(job => ({ ...job.book, status: "deleting" }));
  const hiddenPaths = new Set(deletingBooks.map(book => book.relativePath));
  const stat = await realm.fs.stat(directory);
  if (stat !== undefined && stat.type !== "directory") throw new WorkspaceHttpError(409, "小说项目不是目录，请先处理同名文件。");
  const entries = stat === undefined ? [] : await realm.fs.listDir(directory);
  const books: LibraryBook[] = [];
  for (const entry of entries) {
    if (entry.type !== "directory") continue;
    if (hiddenPaths.has(`${LIBRARY_DIRECTORY}/${entry.name}`)) continue;
    if (!realm.fs.contains(realm.root, entry.target)) continue;
    let child: WorkspaceRealm | undefined;
    try {
      child = await realmForLibraryBook(realm, `${LIBRARY_DIRECTORY}/${entry.name}`);
      const stored = await readJson(child, BOOK_RECEIPT);
      if (stored === undefined) continue;
      const receipt = receiptOf(stored.value);
      if (receipt.relativePath !== `${LIBRARY_DIRECTORY}/${entry.name}`) throw new WorkspaceHttpError(409, "书项目记录与目录不一致，请先核对移动过的项目。");
      const book = await bookView(child, receipt);
      if (book.status === "deleting") deletingBooks.push(book); else books.push(book);
    } catch (error) {
      books.push({ id: createHash("sha256").update(`${realm.cwd}/${entry.name}`).digest("hex"), title: entry.name, filename: "", absolutePath: child?.cwd ?? "",
        relativePath: `${LIBRARY_DIRECTORY}/${entry.name}`, totalChapters: 0, completedChapters: 0, status: "blocked",
        error: error instanceof Error ? error.message : "本书记录不可读，请先处理此项目。" });
    }
  }
  // Imports save the assigned number before creating a receipt. Read the order last
  // so a view that discovers new receipts cannot temporarily invent a different order.
  const order = await readLibraryOrder(realm);
  const catalogue = [...books, ...deletingBooks];
  const filing = settleFiling(order?.order.filing ?? emptyFiling, catalogue);
  const ordered = assignLibraryOrder(catalogue, order?.order).books.map(book => {
    const folderId = filing.memberships[book.id];
    return folderId === undefined ? book : { ...book, folderId };
  });
  return {
    libraryPath: realm.cwd,
    isBookProject: false,
    folders: filing.folders,
    books: ordered.filter(book => book.status !== "archived" && book.status !== "deleting"),
    ...(stat === undefined ? {} : { archivedBooks: ordered.filter(book => book.status === "archived") }),
    deletingBooks: ordered.filter(book => book.status === "deleting"),
    limits: LIBRARY_LIMITS,
    ...(order?.order.displayOrder === undefined ? {} : { orderCustomized: true })
  };
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

async function importBook(realm: WorkspaceRealm, file: LibraryInputFile, batch: ImportFolderBatch): Promise<LibraryImportResult> {
  const parsed = parseSerialOutline(file.text);
  const errors = parsed.diagnostics.filter(issue => issue.severity === "error");
  if (errors.length > 0) throw new WorkspaceHttpError(422, errors.map(issue => `第 ${String(issue.line)} 行：${issue.message}`).join("\n"));
  const filenameTitle = file.filename.replace(/\.(?:txt|md)$/iu, "");
  const title = file.title?.trim() || (parsed.title === "未命名长篇" ? filenameTitle : parsed.title);
  if (title.length > 200) throw new WorkspaceHttpError(422, "解析得到的书名超过 200 字，请修改原文件书名或指定较短的项目名后重试。");
  const sourceSha256 = createHash("sha256").update(file.text, "utf8").digest("hex");
  const id = createHash("sha256").update(JSON.stringify([sourceSha256, title]), "utf8").digest("hex");
  const relativePath = `${LIBRARY_DIRECTORY}/${safeExportName(title)}--${id.slice(0, 12)}`;
  const deletionJournal = await readJson(realm, DELETION_JOURNAL);
  if (deletionJournal !== undefined && deletionJobs(deletionJournal.value).some(job => job.book.id === id)) throw new WorkspaceHttpError(409, "这本书正在后台清理，请稍后重新导入。");
  const child = await realmForLibraryBook(realm, relativePath);
  const previous = await readJson(child, BOOK_RECEIPT);
  if (previous === undefined && await realm.fs.stat(child.root) !== undefined) throw new WorkspaceHttpError(409, "目标目录已经存在但不是此书的导入项目，未覆盖其文件。");
  const receipt: BookReceipt = { schemaVersion: 1, id, title, filename: file.filename, sourceSha256, libraryPath: realm.cwd, relativePath, totalChapters: parsed.chapters.length, status: "importing" };
  if (previous !== undefined) {
    const stored = receiptOf(previous.value);
    if (stored.deletingAt !== undefined) throw new WorkspaceHttpError(409, "这本书正在后台清理，请稍后重新导入。");
    if (stored.id !== id || stored.sourceSha256 !== sourceSha256 || stored.relativePath !== relativePath) throw new WorkspaceHttpError(409, "目标项目与当前输入不同，已保留原项目。");
    if (stored.archivedAt !== undefined) throw new WorkspaceHttpError(409, "这本书已在回收站，请先恢复；重复导入不会覆盖或新建成稿。");
    if (stored.status === "ready") return { filename: file.filename, status: "existing", book: await bookView(child, stored) };
  } else {
    await reserveImportedBook(realm, id, batch);
    await realm.fs.writeText(await containedTarget(child, BOOK_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { kind: "createIfAbsent" }, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
  }
  await importSerialOutline(child, file.text, title);
  const checkpoint = await readJson(child, BOOK_RECEIPT);
  if (checkpoint === undefined || checkpoint.value.id !== id) throw new WorkspaceHttpError(409, "导入记录已变化，请刷新后核对。");
  const ready: BookReceipt = { ...receipt, status: "ready" };
  await realm.fs.writeText(await containedTarget(child, BOOK_RECEIPT), `${JSON.stringify(ready, null, 2)}\n`, { kind: "replaceIfVersion", version: checkpoint.version }, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
  return { filename: file.filename, status: "imported", ...(previous === undefined ? {} : { resumed: true }), book: await bookView(child, ready) };
}

/** A failed book stays isolated; retrying identical inputs reuses completed projects and fills incomplete ones. */
export async function importLibraryBooks(realm: WorkspaceRealm, files: readonly LibraryInputFile[], options: ImportFolderOptions = {}): Promise<LibrarySnapshot & { readonly results: readonly LibraryImportResult[]; readonly importedFolderId?: string }> {
  validateLibraryInputs(files);
  if (await readJson(realm, BOOK_RECEIPT) !== undefined) throw new WorkspaceHttpError(409, "当前是单本小说，请先回到书库再批量导入新项目。");
  const initial = await ensureLibraryOrder(realm);
  const batch = importFolderBatch(options, initial.filing ?? emptyFiling);
  const results: LibraryImportResult[] = [];
  for (const file of [...files].sort(compareLibraryInputFilenames)) {
    try { results.push(await importBook(realm, file, batch)); }
    catch (reason) {
      const mapped = reason instanceof WorkspaceHttpError ? reason : mapFsError(reason);
      results.push({ filename: file.filename, status: "failed", error: mapped?.message ?? (reason instanceof Error ? reason.message : "本书导入失败。") });
    }
  }
  if (batch.assigned && options.folderId === undefined) await ensureLibraryOrder(realm);
  const snapshot = await listLibraryBooks(realm);
  const importedFolderId = batch.assigned && snapshot.folders?.some(folder => folder.id === batch.folderId) ? batch.folderId : undefined;
  return { ...snapshot, ...(importedFolderId === undefined ? {} : { importedFolderId }), results: results.map(result => result.book === undefined ? result : { ...result, book: snapshot.books.find(book => book.id === result.book!.id) ?? result.book }) };
}

export function selectedLibraryIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(id => typeof id === "string" && /^[a-f0-9]{64}$/u.test(id))) throw new WorkspaceHttpError(400, "请先勾选书项目。");
  return [...new Set(value as string[])];
}

/** Reversible deletion: only mark the catalogue receipt; manuscripts and native sessions remain intact. */
export async function recycleLibraryBooks(realm: WorkspaceRealm, ids: readonly string[], restore = false): Promise<LibrarySnapshot & { results: { id: string; ok: boolean; error?: string }[] }> {
  await ensureLibraryOrder(realm);
  const library = await listLibraryBooks(realm);
  if (library.isBookProject) throw new WorkspaceHttpError(409, "请回到书库总览管理书项目。");
  const queue = await readJson(realm, "追踪/书库任务.json");
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of selectedLibraryIds(ids)) {
    try {
      const book = [...library.books, ...(library.archivedBooks ?? [])].find(item => item.id === id);
      if (book === undefined) throw new WorkspaceHttpError(404, "书项目不在当前书库。");
      const child = await realmForLibraryBook(realm, book.relativePath);
      const stored = await readJson(child, BOOK_RECEIPT);
      if (stored === undefined || stored.value.id !== id) throw new WorkspaceHttpError(409, "书项目记录已变化，请刷新后重试。");
      const receipt = receiptOf(stored.value);
      if (!restore) {
        const task = await readJson(child, "追踪/连载任务.json");
        if (task !== undefined && !["completed", "stopped"].includes(String(task.value.status))) throw new WorkspaceHttpError(409, "本书还有未结束的生成任务，请先停止该任务再移入回收站。");
        const reserved = Array.isArray(queue?.value.books) ? queue.value.books.map(record).find(item => item?.id === id) : undefined;
        if (queue !== undefined && !["completed", "stopped"].includes(String(queue.value.status)) && ["pending", "running"].includes(String(reserved?.status))) throw new WorkspaceHttpError(409, "本书已加入书库生成批次，请先停止该批次再移入回收站。");
      }
      const updated = { ...receipt };
      if (restore) delete updated.archivedAt;
      else updated.archivedAt ??= new Date().toISOString();
      await realm.fs.writeText(await containedTarget(child, BOOK_RECEIPT), `${JSON.stringify(updated, null, 2)}\n`, { kind: "replaceIfVersion", version: stored.version }, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
      results.push({ id, ok: true });
    } catch (error) { results.push({ id, ok: false, error: error instanceof Error ? error.message : "操作失败，原稿保留。" }); }
  }
  return { ...await listLibraryBooks(realm), results };
}

/** TXT snapshots contain only committed chapters; failed/empty books are named in the download manifest. */
async function buildLibraryExport(realm: WorkspaceRealm, ids: readonly string[]): Promise<{ readonly data: Uint8Array; readonly downloadName: string }> {
  await ensureLibraryOrder(realm);
  const library = await listLibraryBooks(realm);
  if (library.isBookProject) throw new WorkspaceHttpError(409, "请回到书库总览批量导出。");
  const entries: Record<string, Uint8Array> = {};
  const notes = ["批量导出说明", "仅导出已保存并通过校验的章节正文。生成中的后续章节不包含在本次快照中。", "导出不删除原稿。", ""];
  let total = 0;
  let exported = 0;
  const selected = selectedLibraryIds(ids);
  const candidates = [...library.books, ...(library.archivedBooks ?? [])];
  const booksById = new Map(candidates.map(book => [book.id, book]));
  const folderNames = new Map(library.folders?.map(folder => [folder.id, folder.name]));
  const selectedFolders = new Set(selected.map(id => booksById.get(id)?.folderId));
  const [firstFolder] = selectedFolders;
  const sharedFolderName = selectedFolders.size === 1 && firstFolder !== undefined ? folderNames.get(firstFolder) : undefined;
  const downloadName = sharedFolderName === undefined ? "小说正文_TXT合集.zip" : `${safeExportName(sharedFolderName)}_小说正文_TXT合集.zip`;
  const orderedIds = [...selected].sort((left, right) => (booksById.get(left)?.sequence ?? Number.MAX_SAFE_INTEGER) - (booksById.get(right)?.sequence ?? Number.MAX_SAFE_INTEGER));
  for (const id of orderedIds) {
    const book = booksById.get(id);
    if (book === undefined) { notes.push(`跳过未知项目 ${id.slice(0, 12)}`); continue; }
    try {
      const text = await exportSerialChapters(await realmForLibraryBook(realm, book.relativePath));
      const complete = text.chapters.length >= book.totalChapters;
      const filename = `${String(book.sequence).padStart(3, "0")}_${safeExportName(book.title)}_${complete ? "全本" : `未完结_已保存${String(text.chapters.length)}章`}.zip`;
      const data = createChapterZip(text);
      total += text.chapters.reduce((sum, chapter) => sum + Buffer.byteLength(chapter.prose), 0);
      if (total > 128 * 1024 * 1024) throw new WorkspaceHttpError(413, "本次正文合计超过128 MB，请减少勾选数量分批导出。");
      entries[filename] = data; exported += 1;
      const folderName = book.folderId === undefined ? "未分组" : folderNames.get(book.folderId) ?? "未分组";
      notes.push(`【${folderName}】${filename}：第1—${String(text.chapters.length)}章，共${String(book.totalChapters)}章大纲${complete ? "，已完本" : "，尚未完本"}。`);
    } catch (error) {
      if (error instanceof WorkspaceHttpError && error.status === 413) throw error;
      notes.push(`未导出《${book.title}》：${error instanceof Error ? error.message : "读取失败"}`);
    }
  }
  if (exported === 0) throw new WorkspaceHttpError(409, `所选书没有可导出的正文。${notes.slice(4).join("；")}`);
  entries["导出说明.txt"] = strToU8(`\uFEFF${notes.join("\r\n")}\r\n`);
  return { data: zipSync(entries, { level: 0 }), downloadName };
}

export async function exportLibraryBooks(realm: WorkspaceRealm, ids: readonly string[]): Promise<Uint8Array> {
  return (await buildLibraryExport(realm, ids)).data;
}

export function registerLibraryRoute(context: Context, options: { readonly trustedHosts?: readonly string[] } = {}): void {
  context.effect(() => context.webServer.register({ kind: "exact", path: "/oh-story/library", async handler(request: IncomingMessage, response: ServerResponse) {
    try {
      if (!isTrustedWorkspaceRequest(request, options.trustedHosts ?? [])) throw new WorkspaceHttpError(403, "请求来源不受信任。");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const realm = await workspaceRealmForSession(context, url.searchParams.get("sessionId") ?? "");
      if (request.method === "GET") {
        const snapshot = await listLibraryBooks(realm);
        if (!snapshot.isBookProject) resumeBookDeletions(context, realm);
        send(response, 200, snapshot); return;
      }
      if (request.method !== "POST") throw new WorkspaceHttpError(405, "仅支持 GET 和 POST。");
      const input = await jsonBody(request, LIBRARY_LIMITS.maxTotalBytes * 3 + 65536);
      const files = input.action === undefined ? validateLibraryInputs(input.files) : undefined;
      if (input.action === "delete") { send(response, 200, await enqueueBookDeletion(context, realm, selectedLibraryIds(input.ids))); return; }
      const result = await withLibraryOperation(context, realm.root.targetKey, async () => {
        if (files !== undefined) {
          if ((input.folderId !== undefined && typeof input.folderId !== "string") || (input.folderName !== undefined && typeof input.folderName !== "string")) throw new WorkspaceHttpError(400, "导入文件夹无效，请重新选择。");
          return importLibraryBooks(realm, files, { ...(input.folderId === undefined ? {} : { folderId: input.folderId }), ...(input.folderName === undefined ? {} : { folderName: input.folderName }) });
        }
        if (input.action === "createFolder") return changeLibraryFolders(realm, { action: input.action, name: input.name });
        if (input.action === "renameFolder") return changeLibraryFolders(realm, { action: input.action, folderId: input.folderId, name: input.name });
        if (input.action === "moveToFolder") return changeLibraryFolders(realm, { action: input.action, folderId: input.folderId, ids: selectedLibraryIds(input.ids) });
        if (input.action === "deleteEmptyFolder") return changeLibraryFolders(realm, { action: input.action, folderId: input.folderId });
        if (input.action === "syncSidebarOrder") {
          await syncNativeLibrarySidebarOrder(context, await listLibraryBooks(realm), realm.fs.processPath(realm.root));
          return { ok: true };
        }
        if (input.action === "resetOrder") return changeLibraryBookOrder(realm);
        if (input.action === "move") {
          const { id, targetId, position } = input;
          selectedLibraryIds([id, targetId]);
          if (typeof id !== "string" || typeof targetId !== "string" || (position !== "before" && position !== "after")) {
            throw new WorkspaceHttpError(400, "请指定要移动的书和放置位置。");
          }
          return changeLibraryBookOrder(realm, { id, targetId, position });
        }
        const ids = selectedLibraryIds(input.ids);
        if (input.action === "export") return buildLibraryExport(realm, ids);
        if (input.action === "archive" || input.action === "restore") return recycleLibraryBooks(realm, ids, input.action === "restore");
        throw new WorkspaceHttpError(400, "未知书库管理操作。");
      });
      if ("downloadName" in result) {
        const encodedName = encodeURIComponent(Buffer.from(result.downloadName, "utf8").toString("utf8")).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        response.writeHead(200, { "content-type": "application/zip", "content-length": result.data.length, "content-disposition": `attachment; filename="novels-txt.zip"; filename*=UTF-8''${encodedName}`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(result.data);
      } else send(response, 200, result);
    } catch (error) {
      const mapped = error instanceof WorkspaceHttpError ? error : mapFsError(error);
      send(response, mapped?.status ?? 409, { error: mapped?.message ?? (error instanceof Error ? error.message : "书库操作失败。") });
    }
  } }), "serial novel library import");
}
