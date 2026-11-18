import type { Context } from "@deepseek-ai/cordis";
import type { FsVersion } from "@deepseek-ai/dsh-fs";
import { basename, dirname } from "node:path";
import { ensureLibraryOrder, listLibraryBooks, realmForLibraryBook, selectedLibraryIds, type LibraryBook, type LibrarySnapshot } from "./serial-library.js";
import { purgeLibraryBookFiles } from "./serial-library-delete.js";
import { getLibraryQueueRuntime } from "./serial-library-queue-route.js";
import { forgetDeletedBookRuntime, shutdownBookForDeletion } from "./serial-route.js";
import { markBookDeleting, withLibraryOperation } from "./serial-library-operations.js";
import { creativeTarget, readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "./workspace-route.js";

export const DELETION_JOURNAL = "追踪/书库删除任务.json";
interface DeletionJob { book: LibraryBook; status: "pending"; requestedAt: string; attempts?: number; nextRetryAt?: string; error?: string }
interface DeletionJournal { schemaVersion: 1; jobs: DeletionJob[] }
interface JournalRead { value: DeletionJournal; version?: FsVersion }
interface Worker { running: boolean; disposed: boolean; timer?: ReturnType<typeof setTimeout> }
const workers = new WeakMap<Context, Map<string, Worker>>();

export function deletionJobs(value: unknown): readonly DeletionJob[] {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value) || value.schemaVersion !== 1 || !("jobs" in value) || !Array.isArray(value.jobs)) throw new WorkspaceHttpError(409, "书库删除任务记录损坏，未继续删除。");
  const jobs = value.jobs as DeletionJob[];
  const ids = new Set<string>();
  for (const job of jobs) {
    if (typeof job !== "object" || job === null || job.status !== "pending" || typeof job.requestedAt !== "string"
      || typeof job.book !== "object" || job.book === null || typeof job.book.id !== "string" || !/^[a-f0-9]{64}$/u.test(job.book.id)
      || ids.has(job.book.id) || typeof job.book.relativePath !== "string" || !/^小说项目\/[^/\\]+$/u.test(job.book.relativePath)
      || typeof job.book.title !== "string" || typeof job.book.absolutePath !== "string"
      || (job.attempts !== undefined && (!Number.isSafeInteger(job.attempts) || job.attempts < 0))
      || (job.nextRetryAt !== undefined && !Number.isFinite(Date.parse(job.nextRetryAt)))) throw new WorkspaceHttpError(409, "书库删除目标记录无效，未删除文件。");
    ids.add(job.book.id);
  }
  return jobs;
}
async function load(realm: WorkspaceRealm): Promise<JournalRead> {
  const path = await creativeTarget(realm, DELETION_JOURNAL);
  if (await realm.fs.stat(path) === undefined) return { value: { schemaVersion: 1, jobs: [] } };
  const file = await readVersionedFile(realm.fs, path, 2_097_152);
  return { value: { schemaVersion: 1, jobs: [...deletionJobs(JSON.parse(file.content))] }, version: file.version };
}
async function save(realm: WorkspaceRealm, journal: JournalRead): Promise<void> {
  await realm.fs.writeText(await creativeTarget(realm, DELETION_JOURNAL), `${JSON.stringify(journal.value, null, 2)}\n`,
    journal.version === undefined ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version: journal.version }, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
}
async function receiptFlag(realm: WorkspaceRealm, book: LibraryBook): Promise<void> {
  const child = await realmForLibraryBook(realm, book.relativePath);
  const path = await creativeTarget(child, "追踪/书项目.json");
  if (await child.fs.stat(path) === undefined) return;
  const file = await readVersionedFile(child.fs, path, 2_097_152);
  const value = JSON.parse(file.content) as { id?: unknown; relativePath?: unknown; deletingAt?: string };
  if (value.id !== book.id || value.relativePath !== book.relativePath) throw new WorkspaceHttpError(409, "删除目标的项目身份已变化，未继续。");
  if (value.deletingAt !== undefined) return;
  value.deletingAt = new Date().toISOString();
  await child.fs.writeText(path, `${JSON.stringify(value, null, 2)}\n`, { kind: "replaceIfVersion", version: file.version }, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
}

/** Also protects an old book tab after a restart between journal acceptance and receipt flagging. */
export async function assertBookDeletionNotQueued(realm: WorkspaceRealm): Promise<void> {
  if (basename(dirname(realm.cwd)) !== "小说项目") return;
  const cwd = dirname(dirname(realm.cwd));
  const root = await realm.fs.resolve(cwd);
  const journal = await load({ ...realm, cwd, root });
  if (journal.value.jobs.some(job => job.book.absolutePath === realm.cwd)) throw new WorkspaceHttpError(409, "本书已删除，不能继续生成。");
}

export async function enqueueBookDeletion(context: Context, realm: WorkspaceRealm, ids: readonly string[]): Promise<LibrarySnapshot & { results: { id: string; ok: boolean; error?: string }[] }> {
  const results: { id: string; ok: boolean; error?: string }[] = [];
  await withLibraryOperation(context, realm.root.targetKey, async () => {
    await ensureLibraryOrder(realm);
    const snapshot = await listLibraryBooks(realm);
    if (snapshot.isBookProject) throw new WorkspaceHttpError(409, "请回到书库勾选需要删除的书。");
    const journal = await load(realm);
    const accepted: { book: LibraryBook; key: string }[] = [];
    for (const id of selectedLibraryIds(ids)) {
      try {
        const book = [...snapshot.books, ...(snapshot.archivedBooks ?? []), ...(snapshot.deletingBooks ?? [])].find(item => item.id === id);
        if (book === undefined) throw new WorkspaceHttpError(404, "该书已不在当前书库，请刷新后重试。");
        const child = await realmForLibraryBook(realm, book.relativePath);
        if (child.cwd !== book.absolutePath) throw new WorkspaceHttpError(409, "书项目目录已变化，未删除。");
        if (!journal.value.jobs.some(item => item.book.id === id)) journal.value.jobs.push({ book, status: "pending", requestedAt: new Date().toISOString() });
        accepted.push({ book, key: child.root.targetKey });
      } catch (error) { results.push({ id, ok: false, error: error instanceof Error ? error.message : "删除未提交，请再试一次。" }); }
    }
    if (accepted.length > 0) {
      // This single durable write is the acceptance boundary. Cleanup can never restore catalogue visibility.
      await save(realm, journal);
      for (const { book, key } of accepted) { markBookDeleting(context, key, true); results.push({ id: book.id, ok: true }); }
    }
  });
  const snapshot = await listLibraryBooks(realm);
  resumeBookDeletions(context, realm);
  return { ...snapshot, results };
}

/** One compact internal journal, with capped backoff; failures never return deleted books to the catalogue. */
async function finishAttempt(context: Context, realm: WorkspaceRealm, book: LibraryBook, error?: string): Promise<void> {
  await withLibraryOperation(context, realm.root.targetKey, async () => {
    const journal = await load(realm);
    const job = journal.value.jobs.find(item => item.book.id === book.id);
    if (job === undefined) return;
    if (error === undefined) journal.value.jobs = journal.value.jobs.filter(item => item.book.id !== book.id);
    else {
      job.attempts = (job.attempts ?? 0) + 1;
      job.error = error.slice(0, 2000);
      job.nextRetryAt = new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(job.attempts - 1, 6))).toISOString();
    }
    await save(realm, journal);
    if (error === undefined) {
      const child = await realmForLibraryBook(realm, book.relativePath);
      forgetDeletedBookRuntime(context, child);
      markBookDeleting(context, child.root.targetKey, false);
    }
  });
}

/** Host-owned, automatically resumed when the library opens, independent of browser lifetime. */
export function resumeBookDeletions(context: Context, realm: WorkspaceRealm): void {
  let registry = workers.get(context);
  if (registry === undefined) {
    registry = new Map(); workers.set(context, registry);
    const held = registry;
    context.effect(() => () => { for (const worker of held.values()) { worker.disposed = true; if (worker.timer !== undefined) clearTimeout(worker.timer); } }, "serial deletion workers");
  }
  let worker = registry.get(realm.root.targetKey);
  if (worker === undefined) { worker = { running: false, disposed: false }; registry.set(realm.root.targetKey, worker); }
  if (worker.disposed || worker.running) return;
  if (worker.timer !== undefined) { clearTimeout(worker.timer); delete worker.timer; }
  worker.running = true;
  const held = worker;
  let delay: number | undefined;
  const work = async () => {
    if ((await load(realm)).value.jobs.length === 0) return;
    await withLibraryOperation(context, realm.root.targetKey, () => ensureLibraryOrder(realm));
    while (!held.disposed) {
      const jobs = (await load(realm)).value.jobs;
      const job = jobs.find(item => item.nextRetryAt === undefined || Date.parse(item.nextRetryAt) <= Date.now());
      if (job === undefined) {
        if (jobs.length > 0) delay = Math.max(100, Math.min(...jobs.map(item => Date.parse(item.nextRetryAt!) - Date.now())));
        return;
      }
      let failure: string | undefined;
      try {
        const child = await realmForLibraryBook(realm, job.book.relativePath);
        if (child.cwd !== job.book.absolutePath) throw new WorkspaceHttpError(409, "书项目目录已变化，未清理该目录。");
        markBookDeleting(context, child.root.targetKey, true);
        // Cancellation can take time: never hold the HTTP admission lock while waiting for a model.
        const queue = await getLibraryQueueRuntime(context, realm);
        await queue.runtime.excludeBookForDeletion(job.book.id, () => shutdownBookForDeletion(context, child));
        await shutdownBookForDeletion(context, child);
        if (held.disposed) return;
        await receiptFlag(realm, job.book);
        if (await realm.fs.stat(child.root) !== undefined) await purgeLibraryBookFiles(realm, job.book, { allowEmptyReceiptMissing: true });
      } catch (error) { failure = error instanceof Error ? error.message : "后台清理暂未完成"; }
      await finishAttempt(context, realm, job.book, failure);
    }
  };
  void work().catch(() => { delay = 5000; }).finally(() => {
    held.running = false;
    if (!held.disposed && delay !== undefined) {
      held.timer = setTimeout(() => { delete held.timer; resumeBookDeletions(context, realm); }, delay);
      held.timer.unref();
    }
  });
}
