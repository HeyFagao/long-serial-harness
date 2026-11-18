import { expect, test, vi } from "vitest";
import { applyNativeLibraryOrder, nativeLibraryBookRows, type NativeWorkspaceOrder } from "../src/serial-sidebar-order.js";

function workspaceRegistry(initial: readonly (readonly [id: string, path: string, title?: string])[]) {
  const items = initial.map(([id, path, title]) => ({ id, path, title: title ?? "同名项目" }));
  const rename = vi.fn(async ({ workspaceId, title }: { workspaceId: string; title: string }) => {
    const row = items.find(other => other.id === workspaceId);
    if (row === undefined) throw new Error("missing workspace");
    if (items.some(other => other.id !== workspaceId && other.title === title)) throw Object.assign(new Error("conflicting title"), { code: "workspace/name-conflict" });
    row.title = title;
  });
  const move = vi.fn(async (id: string, before?: string) => {
    await Promise.resolve();
    const from = items.findIndex(row => row.id === id);
    const [book] = items.splice(from, 1);
    if (book === undefined) throw new Error("unknown workspace");
    const target = before === undefined ? items.length : items.findIndex(row => row.id === before);
    if (target === -1) throw new Error("unknown anchor");
    items.splice(target, 0, book);
    return items.map(row => row.id);
  });
  const workspaces: NativeWorkspaceOrder = {
    list: () => items,
    insertBefore: move,
  };
  const syncRows = (libraryPath: string, rows: readonly { path: string; title: string }[]) => applyNativeLibraryOrder(workspaces, { rename }, libraryPath, rows);
  return { items, move, rename, syncRows, sync: (libraryPath: string, paths: readonly string[]) => syncRows(libraryPath, paths.map(path => ({ path, title: path }))) };
}

test("reconciles prepended native book rows by path and leaves unrelated rows, including identical titles, alone", async () => {
  const book = (name: string) => `/library/小说项目/${name}`;
  const registry = workspaceRegistry([
    ["new-2", book("new-2")], ["other-1", "/other-1"],
    ["new-1", book("new-1")], ["library", "/library"], ["other-2", "/other-2"],
    ["old-2", book("old-2")], ["old-1", book("old-1")], ["other-3", "/other-3"],
  ]);
  const order = [book("old-1"), book("old-2"), book("new-1"), book("new-2")];
  await registry.sync("/library", order);
  expect(registry.items.map(row => row.id)).toEqual(["other-1", "library", "old-1", "old-2", "new-1", "new-2", "other-2", "other-3"]);
  expect(registry.move.mock.calls.every(([id]) => /^(?:old|new)-/u.test(id))).toBe(true);

  registry.move.mockClear();
  await registry.sync("/library", order);
  expect(registry.move).not.toHaveBeenCalled();
});

test("uses existing book slots with canonical Windows paths when the library root is unregistered", async () => {
  const first = "C:\\Library\\小说项目\\First";
  const second = "C:\\Library\\小说项目\\Second";
  const registry = workspaceRegistry([
    ["other-1", "C:\\Other1"], ["second", second],
    ["other-2", "C:\\Other2"], ["first", first],
  ]);
  await registry.sync("C:\\Library", [first, second]);
  expect(registry.items.map(row => row.id)).toEqual(["other-1", "first", "second", "other-2"]);
});

test("serializes different libraries sharing one registry before choosing their anchors", async () => {
  const first = "/first/小说项目/One";
  const second = "/second/小说项目/Two";
  const registry = workspaceRegistry([
    ["library-1", "/first"], ["book-2", second], ["library-2", "/second"], ["book-1", first],
  ]);
  await Promise.all([registry.sync("/first", [first]), registry.sync("/second", [second])]);
  expect(registry.items.map(row => row.id)).toEqual(["library-1", "book-1", "library-2", "book-2"]);
});

test("applies the same folder sections as the workbench, including legacy rows and same-title novels", async () => {
  const book = (sequence: number, folderId?: string) => ({
    id: String(sequence), title: "同名书", filename: "原稿", absolutePath: "/books/" + String(sequence), relativePath: String(sequence),
    totalChapters: 10, completedChapters: 1, status: "ready", sequence, ...(folderId === undefined ? {} : { folderId })
  });
  const folders = [{ id: "one", name: "第一批", number: 1, createdAt: "2026-11-16" }, { id: "two", name: "第二批", number: 2, createdAt: "2026-11-17" }];
  const books = [book(10, "two"), book(1), book(12, "one"), book(2, "one")];
  const registry = workspaceRegistry([
    ["ext", "/other", "第一批 · 012 · 同名书"], ["root", "/books"], ...books.map(item => [item.id, item.absolutePath] as const)
  ]);
  const sync = () => registry.syncRows("/books", nativeLibraryBookRows({ folders, books }));
  await sync();
  expect(registry.items.map(row => [row.id, row.title])).toEqual([
    ["ext", "第一批 · 012 · 同名书"], ["root", "同名项目"], ["1", "未分组 · 001 · 同名书"],
    ["12", "第一批 · 012 · 同名书 (2)"], ["2", "第一批 · 002 · 同名书"], ["10", "第二批 · 010 · 同名书"]
  ]);
  registry.rename.mockClear();
  registry.move.mockClear();
  await sync();
  expect(registry.rename).not.toHaveBeenCalled();
  expect(registry.move).not.toHaveBeenCalled();

  folders[0]!.name = "周更";
  books[0] = book(10, "one");
  await sync();
  expect(registry.items.slice(2).map(row => row.title)).toEqual(["未分组 · 001 · 同名书", "周更 · 010 · 同名书", "周更 · 012 · 同名书", "周更 · 002 · 同名书"]);
});

test("handles a title claimed concurrently through the native controller and recovers from a failed sync", async () => {
  const registry = workspaceRegistry([["book", "/library/book"], ["root", "/library"]]);
  const title = "周更 · 001 · 重逢";
  const sync = () => registry.syncRows("/library", [{ path: "/library/book", title }]);
  registry.rename.mockImplementationOnce(async () => {
    registry.items.push({ id: "another", path: "/another", title });
    throw Object.assign(new Error("title claimed"), { code: "workspace/name-conflict" });
  }).mockRejectedValueOnce(new Error("storage busy"));
  await expect(sync()).rejects.toThrow("storage busy");
  await sync();
  expect(registry.items.map(row => [row.id, row.title])).toEqual([["root", "同名项目"], ["book", title + " (2)"], ["another", title]]);
});
