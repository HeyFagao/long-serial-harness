import { describe, expect, it, vi } from "vitest";
import type { LibraryBook, LibraryImportResult } from "../src/serial-library.js";
import type { LibraryQueueBook } from "../src/serial-library-runtime.js";
import { canOpenLibraryBook, decodeLibraryText, libraryQueueControls, registerLibraryResults } from "../src/client/book-library-panel.js";

const book = (id: string): LibraryBook => ({ id, title: `书${id}`, filename: `${id}.txt`, absolutePath: `/library/${id}`, relativePath: `小说项目/${id}`, totalChapters: 100, completedChapters: 0, status: "ready" });
const imported = (id: string): LibraryImportResult => ({ filename: `${id}.txt`, status: "imported", book: book(id) });
const queued = (status: LibraryQueueBook["status"]): LibraryQueueBook => ({ id: "book", title: "书", absolutePath: "/library/book", ownerSessionId: "book-session", startChapter: 11, targetChapter: 20, status, completedChapters: 3 });

describe("library recovery ownership", () => {
  it("offers explicit recovery for a stopped batch with unfinished books", () => {
    const controls = libraryQueueControls({ status: "stopped", ownerSessionId: "owner", books: [queued("running")] }, "owner");
    expect(controls.resumeLabel).toBe("恢复这批项目");
    expect(controls.canStart).toBe(true);
    expect(controls.canStop).toBe(false);
  });
  it("allows a new session to start a new batch without letting it resume an old owner's batch", () => {
    for (const status of ["stopped", "completed"] as const) {
      const controls = libraryQueueControls({ status, ownerSessionId: "owner", books: [queued("failed")] }, "new-session");
      expect(controls.canStart).toBe(true);
      expect(controls.differentOwner).toBe(true);
      expect(controls.resumeLabel).toBeUndefined();
      expect(controls.canStop).toBe(false);
    }
  });
  it("retains a stop retry after a blocked cancellation and retries only failed completed batches", () => {
    const blocked = libraryQueueControls({ status: "blocked", ownerSessionId: "owner", books: [queued("running")] }, "owner");
    expect(blocked.canStart).toBe(false);
    expect(blocked.canStop).toBe(true);
    expect(libraryQueueControls({ status: "completed", ownerSessionId: "owner", books: [queued("failed")] }, "owner").resumeLabel).toBe("重试失败项目");
    for (const status of ["stopped", "completed"] as const) expect(libraryQueueControls({ status, ownerSessionId: "owner", books: [queued("completed"), queued("skipped")] }, "owner").resumeLabel).toBeUndefined();
  });
});

describe("batch input decoding", () => {
  it("preserves UTF-8 Chinese text and line endings", () => {
    const text = "&&&章纲&&&\r\n第1章：开端\r\n正文资料\n";
    expect(decodeLibraryText(new TextEncoder().encode(text).buffer)).toBe(text);
  });
  it("reads legacy GB18030 files before importing them as text", () => {
    expect(decodeLibraryText(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]).buffer)).toBe("中文");
  });
});

describe("native book registration after a multi-file import", () => {
  it("registers all ten books while retaining the library overview", async () => {
    const navigation = { register: vi.fn(async (path: string) => `workspace:${path}`), open: vi.fn(async () => {}) };
    const received: string[] = [];
    await registerLibraryResults(Array.from({ length: 10 }, (_, i) => imported(String(i + 1))), navigation, (value, registration) => { expect(registration.error).toBeUndefined(); received.push(value.id); });
    expect(navigation.register).toHaveBeenCalledTimes(10);
    expect(received).toHaveLength(10);
    expect(navigation.open).not.toHaveBeenCalled();
  });
  it("keeps other books registrable when one native registration fails", async () => {
    const navigation = { register: vi.fn(async (path: string) => { if (path.endsWith("/2")) throw new Error("原生工作区暂时不可用"); return `workspace:${path}`; }), open: vi.fn(async () => {}) };
    const received: { id: string; error?: string }[] = [];
    await registerLibraryResults([imported("1"), imported("2"), imported("3")], navigation, (value, registration) => { received.push({ id: value.id, ...(registration.error === undefined ? {} : { error: registration.error }) }); });
    expect(received).toEqual([{ id: "1" }, { id: "2", error: "原生工作区暂时不可用" }, { id: "3" }]);
    expect(navigation.register).toHaveBeenCalledTimes(3);
    expect(navigation.open).not.toHaveBeenCalled();
  });
  it("does not register failed imports or repeat identical books in the same result", async () => {
    const navigation = { register: vi.fn(async () => "workspace"), open: vi.fn(async () => {}) };
    const result = vi.fn();
    await registerLibraryResults([imported("1"), { ...imported("1"), status: "existing" }, { filename: "bad.txt", status: "failed", error: "缺章纲" }], navigation, result);
    expect(navigation.register).toHaveBeenCalledExactlyOnceWith("/library/1", "书1");
    expect(result).toHaveBeenCalledTimes(1);
  });
  it("keeps damaged catalogue entries visible but never registers their invalid paths", async () => {
    const navigation = { register: vi.fn(async () => "workspace"), open: vi.fn(async () => {}) };
    const damaged = { ...book("bad"), absolutePath: "", totalChapters: 0, status: "blocked", error: "项目记录损坏" };
    expect(canOpenLibraryBook(damaged)).toBe(false);
    expect(canOpenLibraryBook({ ...book("partial"), status: "incomplete" })).toBe(false);
    await registerLibraryResults([{ filename: "bad.txt", status: "existing", book: damaged }, imported("good")], navigation, vi.fn());
    expect(navigation.register).toHaveBeenCalledExactlyOnceWith("/library/good", "书good");
  });
});
