import { describe, expect, it, vi } from "vitest";
import type { LibraryBook, LibraryImportResult } from "../src/serial-library.js";
import type { LibraryQueueBook } from "../src/serial-library-runtime.js";
import { canOpenLibraryBook, decodeLibraryText, libraryBookControls, libraryBookNumber, libraryImportPreviewOrder, libraryQueueControls, libraryStartSelection, registerLibraryResults, searchLibraryBooks } from "../src/client/book-library-panel.js";

const book = (id: string): LibraryBook => ({ id, title: `书${id}`, filename: `${id}.txt`, absolutePath: `/library/${id}`, relativePath: `小说项目/${id}`, totalChapters: 100, completedChapters: 0, status: "ready" });
const imported = (id: string): LibraryImportResult => ({ filename: `${id}.txt`, status: "imported", book: book(id) });
const queued = (status: LibraryQueueBook["status"]): LibraryQueueBook => ({ id: "book", title: "书", absolutePath: "/library/book", ownerSessionId: "book-session", startChapter: 11, targetChapter: 20, status, completedChapters: 3 });

describe("selected generation and independent book controls", () => {
  it("never turns an empty or stale explicit selection into all books", () => {
    expect(libraryStartSelection([book("ready")], [], "selected", null)).toMatchObject({ ids: [], reason: expect.stringContaining("勾选") });
    expect(libraryStartSelection([book("ready")], ["missing"], "selected", null).ids).toEqual([]);
  });
  it("excludes archived and deleting IDs while targeting only the checked normal books", () => {
    const books = [book("a"), book("b"), { ...book("archived"), status: "archived" }, { ...book("deleted"), status: "deleting" }];
    expect(libraryStartSelection(books, ["a", "archived", "deleted", "stale"], "selected", null).ids).toEqual(["a"]);
    expect(libraryStartSelection(books, [], "all", null).ids).toEqual(["a", "b"]);
  });
  it("allows a selected ready book to start while another book is running", () => {
    const task = { status: "running" as const, books: [{ ...queued("running"), id: "active" }] };
    expect(libraryStartSelection([book("ready"), book("active")], ["ready"], "selected", task)).toEqual({ ids: ["ready"] });
    expect(libraryStartSelection([book("ready"), book("active")], [], "all", task)).toEqual({ ids: ["ready"] });
  });
  it("does not silently start only part of a mixed ready and unfinished selection", () => {
    for (const status of ["pending", "running", "pausing", "paused", "failed"] as const) {
      const task = { status: "running" as const, books: [{ ...queued(status), id: "unfinished" }] };
      const selection = libraryStartSelection([book("ready"), book("unfinished")], ["ready", "unfinished"], "selected", task);
      expect(selection.ids).toEqual([]); expect(selection.reason).toContain("书unfinished");
    }
  });
  it("keeps a final saved body with a pending title out of completed-book generation", () => {
    const completeBody = { ...book("book"), completedChapters: 100, status: "running" };
    const controls = libraryBookControls(completeBody, queued("running"), "running");
    expect(controls).toMatchObject({ canStart: false, canPause: true, label: "生成中" });
    expect(libraryBookControls(completeBody, queued("paused"), "running")).toMatchObject({ canStart: false, canResume: true, label: "已单独暂停" });
  });
  it("distinguishes per-book pause, global pause and an independent single-book task", () => {
    expect(libraryBookControls(book("book"), queued("pausing"), "running")).toMatchObject({ canPause: false, canResume: false, label: "本章后暂停" });
    expect(libraryBookControls(book("book"), queued("paused"), "running")).toMatchObject({ canPause: false, canResume: true });
    expect(libraryBookControls(book("book"), queued("running"), "paused")).toMatchObject({ canPause: false, canResume: true, label: "本批已暂停" });
    expect(libraryBookControls({ ...book("book"), status: "pausing" }, queued("pausing"), "paused")).toMatchObject({ canPause: false, canResume: true, label: "本批已暂停" });
    expect(libraryBookControls({ ...book("book"), status: "pausing" }, queued("pausing"), "stopped")).toMatchObject({ canStart: false, canResume: true });
    expect(libraryBookControls({ ...book("book"), status: "paused" })).toMatchObject({ canStart: false, canPause: false, canResume: false, reason: expect.stringContaining("打开本书") });
  });
  it("allows an explicitly stopped queue to start a fresh target or resume the old one", () => {
    const stopped = { ...book("book"), status: "stopped" };
    expect(libraryBookControls(stopped, queued("running"), "stopped")).toMatchObject({ canStart: true, canResume: true });
    expect(libraryStartSelection([stopped], ["book"], "selected", { status: "stopped", books: [queued("running")] })).toEqual({ ids: ["book"] });
  });
});

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
  it("does not offer global resume when every unfinished book was paused individually", () => {
    expect(libraryQueueControls({ status: "paused", ownerSessionId: "owner", books: [queued("paused"), queued("completed")] }, "owner").resumeLabel).toBeUndefined();
    expect(libraryQueueControls({ status: "paused", ownerSessionId: "owner", books: [queued("paused"), queued("running")] }, "owner").resumeLabel).toBe("继续本批项目");
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

describe("stable book numbering and import preview", () => {
  it("previews numeric filenames in the same natural order without changing input contents or names", () => {
    const inputs = [
      { filename: "10_新书.txt", text: "十号原文\r\n", title: "十号标题", key: "first" },
      { filename: "2_新书.md", text: "二号原文\n", title: "二号标题", key: "second" },
      { filename: "1_新书.txt", text: "一号原文\n", title: "一号标题", key: "third" }
    ];
    const original = structuredClone(inputs);
    const ordered = libraryImportPreviewOrder(inputs);
    expect(ordered.map(file => file.filename)).toEqual(["1_新书.txt", "2_新书.md", "10_新书.txt"]);
    expect(ordered).toEqual([inputs[2], inputs[1], inputs[0]]);
    expect(inputs).toEqual(original);
  });
  it("keeps catalogue numbers and order when searching, selecting or omitting other books", () => {
    const books = [{ ...book("old"), title: "旧书", sequence: 8 }, { ...book("new-a"), title: "新书甲", sequence: 12 }, { ...book("new-b"), title: "新书乙", sequence: 20 }];
    const found = searchLibraryBooks(books, " 新书 ");
    expect(found.map(item => [item.id, libraryBookNumber(item)])).toEqual([["new-a", "012"], ["new-b", "020"]]);
    expect(libraryStartSelection(found, ["new-b", "new-a"], "selected", null).ids).toEqual(["new-a", "new-b"]);
    expect(searchLibraryBooks([books[2]!], "").map(libraryBookNumber)).toEqual(["020"]);
    expect(libraryBookNumber({ sequence: 1002 })).toBe("1002");
    expect(libraryBookNumber({})).toBeUndefined();
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
