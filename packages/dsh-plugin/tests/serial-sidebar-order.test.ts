import { expect, test, vi } from "vitest";
import { applyNativeLibraryOrder, type NativeWorkspaceOrder } from "../src/serial-sidebar-order.js";

function workspaceRegistry(initial: readonly (readonly [id: string, path: string])[]) {
  const items = initial.map(([id, path]) => ({ id, path, title: "同名项目" }));
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
  return { items, move, sync: (libraryPath: string, bookPaths: readonly string[]) => applyNativeLibraryOrder(workspaces, libraryPath, bookPaths) };
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
