import { posix } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertBookDeletionNotQueued, DELETION_JOURNAL, deletionJobs, enqueueBookDeletion, resumeBookDeletions } from "../src/serial-library-deletion-jobs.js";
import { importLibraryBooks, listLibraryBooks, realmForLibraryBook, type LibraryBook, type LibraryInputFile } from "../src/serial-library.js";
import { assertBookNotDeleting } from "../src/serial-library-operations.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import type * as SerialRouteModule from "../src/serial-route.js";
import { LIBRARY_ORDER_PATH } from "../src/serial-library-order.js";

const native = vi.hoisted(() => ({ queue: vi.fn(), exclude: vi.fn(), shutdown: vi.fn(), purge: vi.fn() }));
vi.mock("../src/serial-library-queue-route.js", () => ({ getLibraryQueueRuntime: native.queue }));
vi.mock("../src/serial-route.js", async original => ({ ...await original<typeof SerialRouteModule>(), shutdownBookForDeletion: native.shutdown }));
vi.mock("../src/serial-library-delete.js", () => ({ purgeLibraryBookFiles: native.purge }));

const disposers: (() => void)[] = [];
function host() {
  const effects: (() => void)[] = [];
  const context = { effect(work: () => (() => void) | void) { const cleanup = work(); if (cleanup !== undefined) effects.push(cleanup); } } as unknown as Context;
  const dispose = () => { for (const cleanup of effects.splice(0)) cleanup(); };
  disposers.push(dispose);
  return { context, dispose };
}

/** Real import/catalogue code on an isolated, versioned provider fixture. No user paths are accessed. */
function library() {
  const files = new Map<string, string>(); const versions = new Map<string, string>();
  let sequence = 0; let failOnce = "";
  const target = (path: string) => ({ targetKey: path, displayPath: path });
  const fs = {
    resolve: async (path: string, options?: { cwd?: string }) => target(posix.resolve(options?.cwd ?? "/books", path)),
    processPath: (entry: { displayPath: string }) => entry.displayPath,
    contains: (root: { displayPath: string }, entry: { displayPath: string }) => entry.displayPath === root.displayPath || entry.displayPath.startsWith(`${root.displayPath}/`),
    stat: async (entry: { displayPath: string }) => files.has(entry.displayPath)
      ? { type: "file", size: Buffer.byteLength(files.get(entry.displayPath)!), version: versions.get(entry.displayPath) }
      : [...files.keys()].some(path => path.startsWith(`${entry.displayPath}/`)) ? { type: "directory", version: "dir" } : undefined,
    readBytes: async (entry: { displayPath: string }) => Buffer.from(files.get(entry.displayPath)!),
    listDir: async (root: { displayPath: string }) => {
      const prefix = `${root.displayPath}/`;
      const names = [...new Set([...files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split("/")[0]!))];
      return names.map(name => ({ name, type: files.has(`${prefix}${name}`) ? "file" : "directory", target: target(`${prefix}${name}`) }));
    },
    writeText: async (entry: { displayPath: string }, text: string, expected: { kind: string; version?: string }, _signal: unknown, policy: { cwd: string }) => {
      expect(entry.displayPath.startsWith(`${policy.cwd}/`)).toBe(true);
      if (failOnce !== "" && entry.displayPath.endsWith(failOnce)) { failOnce = ""; throw new Error("simulated disk failure"); }
      if (expected.kind === "createIfAbsent" && files.has(entry.displayPath)) throw new Error("conflict");
      if (expected.kind === "replaceIfVersion" && expected.version !== versions.get(entry.displayPath)) throw new Error("stale version");
      const version = `v${String(++sequence)}`; files.set(entry.displayPath, text); versions.set(entry.displayPath, version); return { version };
    }
  };
  const realm = { cwd: "/books", root: target("/books"), fs, sessionId: "library", agent: { session: {} }, sandboxPolicy: { resolve: () => ({ cwd: "/books" }) } } as unknown as WorkspaceRealm;
  const jobs = () => deletionJobs(JSON.parse(files.get(`/books/${DELETION_JOURNAL}`) ?? '{"schemaVersion":1,"jobs":[]}'));
  const purge = async (_realm: WorkspaceRealm, book: LibraryBook) => {
    for (const path of [...files.keys()]) if (path.startsWith(`${book.absolutePath}/`)) { files.delete(path); versions.delete(path); }
  };
  return { realm, files, jobs, purge, fail: (path: string) => { failOnce = path; } };
}
const source = (number: number): LibraryInputFile => ({ filename: `书${String(number)}.txt`, text: `书名：第${String(number)}本书\n第1章：钥匙\n只有书${String(number)}的角色出场。\n第2章：门开了\n书${String(number)}的独有伏笔被保留。` });
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) { if (await check()) return; await Promise.resolve(); }
  throw new Error("deletion worker did not settle");
}
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  native.queue.mockResolvedValue({ runtime: { excludeBookForDeletion: native.exclude } });
  native.exclude.mockResolvedValue(undefined); native.shutdown.mockResolvedValue(undefined); native.purge.mockResolvedValue(undefined);
});
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("durable background book deletion", () => {
  it("does not bootstrap or write catalogue order when no deletion job exists", async () => {
    const test = library(); const app = host();
    await importLibraryBooks(test.realm, [source(1), source(2)]);
    test.files.delete(`/books/${LIBRARY_ORDER_PATH}`);
    const before = new Map(test.files);
    resumeBookDeletions(app.context, test.realm);
    for (let step = 0; step < 100; step += 1) await Promise.resolve();
    expect(test.files).toEqual(before); expect(native.queue).not.toHaveBeenCalled();
  });

  it("freezes legacy numbering before hiding and purging the first book", async () => {
    const test = library(); const app = host(); const gate = held();
    const books = (await importLibraryBooks(test.realm, [source(1), source(2)])).books;
    test.files.delete(`/books/${LIBRARY_ORDER_PATH}`);
    native.exclude.mockImplementation(async () => gate.promise); native.purge.mockImplementation(test.purge);
    const accepted = await enqueueBookDeletion(app.context, test.realm, [books[0]!.id]);
    expect(accepted.books.map(book => book.sequence)).toEqual([2]);
    const order = JSON.parse(test.files.get(`/books/${LIBRARY_ORDER_PATH}`)!);
    expect(order.sequences[books[0]!.id]).toBe(1); expect(order.nextSequence).toBe(3);
    gate.release(); await until(() => test.jobs().length === 0);
    const appended = await importLibraryBooks(test.realm, [source(3)]);
    expect(appended.books.map(book => book.sequence)).toEqual([2, 3]);
  });

  it("acknowledges before held cancellation, hides immediately, and leaves the other book untouched", async () => {
    const test = library(); const app = host(); const gate = held();
    const books = (await importLibraryBooks(test.realm, [source(1), source(2)])).books;
    const selected = books[0]!; const other = books[1]!;
    const untouched = new Map([...test.files].filter(([path]) => path.startsWith(`${other.absolutePath}/`)));
    native.exclude.mockImplementation(async () => gate.promise); native.purge.mockImplementation(test.purge);
    const accepted = await enqueueBookDeletion(app.context, test.realm, [selected.id]);
    expect(accepted.results).toEqual([{ id: selected.id, ok: true }]);
    expect(accepted.books.map(book => book.id)).toEqual([other.id]); expect(accepted.archivedBooks).toEqual([]);
    expect(test.jobs()).toHaveLength(1); await until(() => native.exclude.mock.calls.length === 1);
    expect(native.shutdown).not.toHaveBeenCalled(); expect(native.purge).not.toHaveBeenCalled();
    expect(test.files.has(`${selected.absolutePath}/大纲/导入原稿.md`)).toBe(true);
    gate.release(); await until(() => test.jobs().length === 0);
    expect([...test.files.keys()].some(path => path.startsWith(`${selected.absolutePath}/`))).toBe(false);
    expect(new Map([...test.files].filter(([path]) => path.startsWith(`${other.absolutePath}/`)))).toEqual(untouched);
    expect(native.exclude).toHaveBeenCalledExactlyOnceWith(selected.id, expect.any(Function));
    expect(native.shutdown.mock.calls[0]?.[1]).toMatchObject({ cwd: selected.absolutePath });
  });

  it("keeps purge failures hidden without an archive or visible error and retries after backoff", async () => {
    const test = library(); const app = host(); const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    native.purge.mockRejectedValueOnce(new Error("disk is busy")).mockImplementation(test.purge);
    expect((await enqueueBookDeletion(app.context, test.realm, [book.id])).results[0]?.ok).toBe(true);
    await until(() => test.jobs()[0]?.attempts === 1);
    const snapshot = await listLibraryBooks(test.realm);
    expect(snapshot.books).toEqual([]); expect(snapshot.archivedBooks).toEqual([]);
    expect(snapshot.deletingBooks?.[0]).toMatchObject({ id: book.id, status: "deleting" });
    expect(snapshot.deletingBooks?.[0]?.error).toBeUndefined(); expect(test.jobs()[0]?.error).toBe("disk is busy");
    expect(native.purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); expect(native.purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await until(() => test.jobs().length === 0);
    expect(native.purge).toHaveBeenCalledTimes(2); expect((await listLibraryBooks(test.realm)).books).toEqual([]);
    expect([...test.files.keys()].some(path => path.startsWith(`${book.absolutePath}/`))).toBe(false);
  });

  it("reloads accepted jobs in a fresh host and resumes cleanup without showing the book", async () => {
    const test = library(); const first = host(); const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    native.purge.mockRejectedValueOnce(new Error("temporary failure")).mockImplementation(test.purge);
    await enqueueBookDeletion(first.context, test.realm, [book.id]); await until(() => test.jobs()[0]?.attempts === 1);
    first.dispose();
    const next = host(); expect((await listLibraryBooks(test.realm)).books).toEqual([]);
    const child = await realmForLibraryBook(test.realm, book.relativePath);
    await expect(assertBookDeletionNotQueued(child)).rejects.toThrow("不能继续生成");
    await vi.advanceTimersByTimeAsync(1000); expect(native.purge).toHaveBeenCalledTimes(1);
    resumeBookDeletions(next.context, test.realm); await until(() => test.jobs().length === 0);
    expect(native.queue.mock.calls.at(-1)?.[0]).toBe(next.context);
    expect(native.purge).toHaveBeenCalledTimes(2); expect((await listLibraryBooks(test.realm)).books).toEqual([]);
  });

  it("rejects reimport while pending, even when receipt flagging failed after acceptance", async () => {
    const test = library(); const app = host(); const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    test.fail("/追踪/书项目.json"); native.purge.mockImplementation(test.purge);
    const accepted = await enqueueBookDeletion(app.context, test.realm, [book.id]);
    expect(accepted.results).toEqual([{ id: book.id, ok: true }]); await until(() => test.jobs()[0]?.attempts === 1);
    expect(JSON.parse(test.files.get(`${book.absolutePath}/追踪/书项目.json`)!).deletingAt).toBeUndefined();
    expect((await listLibraryBooks(test.realm)).books).toEqual([]);
    expect(native.shutdown).toHaveBeenCalled(); expect(native.purge).not.toHaveBeenCalled();
    const retriedImport = await importLibraryBooks(test.realm, [source(1)]);
    expect(retriedImport.results[0]).toMatchObject({ status: "failed" }); expect(retriedImport.results[0]?.error).toContain("后台清理");
    expect(retriedImport.books).toEqual([]); expect(retriedImport.archivedBooks).toEqual([]);
    await expect(assertBookDeletionNotQueued(await realmForLibraryBook(test.realm, book.relativePath))).rejects.toThrow("不能继续生成");
    await vi.advanceTimersByTimeAsync(1000); await until(() => test.jobs().length === 0);
    expect((await importLibraryBooks(test.realm, [source(1)])).results[0]?.status).toBe("imported");
  });

  it("deduplicates repeated selections and accepts only valid IDs in a partial submission", async () => {
    const test = library(); const app = host(); const gate = held(); const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    native.exclude.mockImplementation(async () => gate.promise); native.purge.mockImplementation(test.purge);
    const unknown = "0".repeat(64);
    const accepted = await enqueueBookDeletion(app.context, test.realm, [book.id, book.id, unknown]);
    expect(accepted.results.filter(item => item.ok)).toEqual([{ id: book.id, ok: true }]);
    expect(accepted.results.find(item => item.id === unknown)).toMatchObject({ ok: false }); expect(test.jobs()).toHaveLength(1);
    gate.release(); await until(() => test.jobs().length === 0); expect(native.exclude).toHaveBeenCalledTimes(1);
  });

  it("does not accept or hide any selected book if the durable journal write fails", async () => {
    const test = library(); const app = host(); const books = (await importLibraryBooks(test.realm, [source(1), source(2)])).books;
    test.fail(DELETION_JOURNAL);
    await expect(enqueueBookDeletion(app.context, test.realm, [books[0]!.id, "0".repeat(64), books[1]!.id])).rejects.toThrow("simulated disk failure");
    expect(test.jobs()).toEqual([]); expect((await listLibraryBooks(test.realm)).books.map(book => book.id)).toEqual(books.map(book => book.id));
    expect(native.queue).not.toHaveBeenCalled(); expect(native.purge).not.toHaveBeenCalled();
    for (const book of books) expect(() => assertBookNotDeleting(app.context, book.absolutePath)).not.toThrow();
  });

  it("accepts another deletion while an earlier model cancellation is still held", async () => {
    const test = library(); const app = host(); const gate = held(); const books = (await importLibraryBooks(test.realm, [source(1), source(2)])).books;
    native.exclude.mockImplementationOnce(async () => gate.promise); native.purge.mockImplementation(test.purge);
    await enqueueBookDeletion(app.context, test.realm, [books[0]!.id]); await until(() => native.exclude.mock.calls.length === 1);
    const second = await enqueueBookDeletion(app.context, test.realm, [books[0]!.id, books[1]!.id]);
    expect(second.results.every(item => item.ok)).toBe(true); expect(second.books).toEqual([]);
    expect(test.jobs().map(job => job.book.id).sort()).toEqual(books.map(book => book.id).sort());
    expect(native.exclude).toHaveBeenCalledTimes(1);
    gate.release(); await until(() => test.jobs().length === 0);
    expect(native.exclude).toHaveBeenCalledTimes(2); expect(native.purge).toHaveBeenCalledTimes(2);
  });

  it("reconciles a completed purge when saving the final journal receipt failed", async () => {
    const test = library(); const app = host(); const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    native.purge.mockImplementation(async (realm: WorkspaceRealm, selected: LibraryBook) => {
      await test.purge(realm, selected); test.fail(DELETION_JOURNAL);
    });
    await enqueueBookDeletion(app.context, test.realm, [book.id]);
    await until(() => native.purge.mock.calls.length === 1 && !test.files.has(`${book.absolutePath}/追踪/书项目.json`));
    expect(test.jobs()).toHaveLength(1); expect((await listLibraryBooks(test.realm)).books).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000); await until(() => test.jobs().length === 0);
    expect(native.purge).toHaveBeenCalledTimes(1);
    expect((await listLibraryBooks(test.realm)).deletingBooks).toEqual([]);
  });
});
