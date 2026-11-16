import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { importLibraryBooks, listLibraryBooks, validateLibraryInputs, type LibraryInputFile } from "../src/serial-library.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

function library() {
  const files = new Map<string, string>();
  let writes = 0;
  let failOnce = "";
  const versions = new Map<string, string>();
  const target = (name: string) => ({ targetKey: name, displayPath: name });
  const resolve = async (name: string, options?: { cwd?: string }) => target(posix.resolve(options?.cwd ?? "/books", name));
  const fs = {
    resolve,
    processPath: (entry: { displayPath: string }) => entry.displayPath,
    contains: (root: { displayPath: string }, entry: { displayPath: string }) => entry.displayPath === root.displayPath || entry.displayPath.startsWith(`${root.displayPath}/`),
    stat: async (entry: { displayPath: string }) => files.has(entry.displayPath)
      ? { type: "file", size: Buffer.byteLength(files.get(entry.displayPath)!), version: versions.get(entry.displayPath) }
      : [...files.keys()].some(name => name.startsWith(`${entry.displayPath}/`)) ? { type: "directory", version: "dir" } : undefined,
    readBytes: async (entry: { displayPath: string }) => Buffer.from(files.get(entry.displayPath)!),
    listDir: async (root: { displayPath: string }) => {
      const prefix = `${root.displayPath}/`;
      const children = [...new Set([...files.keys()].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length).split("/")[0]!))];
      return children.map(name => ({ name, type: files.has(`${prefix}${name}`) ? "file" : "directory", target: target(`${prefix}${name}`) }));
    },
    writeText: async (entry: { displayPath: string }, content: string, expected: { kind: string; version?: string }, _signal: unknown, policy: { cwd: string }) => {
      expect(entry.displayPath.startsWith(`${policy.cwd}/`)).toBe(true);
      if (failOnce !== "" && entry.displayPath.endsWith(failOnce)) { failOnce = ""; throw new Error("模拟磁盘暂时不可写"); }
      if (expected.kind === "createIfAbsent" && files.has(entry.displayPath)) throw new Error("conflict");
      if (expected.kind === "replaceIfVersion" && expected.version !== versions.get(entry.displayPath)) throw new Error("stale");
      const version = `v${String(++writes)}`;
      files.set(entry.displayPath, content); versions.set(entry.displayPath, version);
      return { version };
    }
  };
  const realm = { cwd: "/books", root: target("/books"), fs, sessionId: "library", agent: { session: {} }, sandboxPolicy: { resolve: () => ({ cwd: "/books" }) } } as unknown as WorkspaceRealm;
  return { realm, files, versions, writes: () => writes, fail: (path: string) => { failOnce = path; } };
}

const source = (number: number): LibraryInputFile => ({ filename: `书${String(number)}.txt`, text: `书名：第${String(number)}本书\n第1章：钥匙\n只有书${String(number)}的角色出场。\n第2章：门开了\n书${String(number)}的独有伏笔被保留。` });

describe("independent multi-book import", () => {
  it("imports ten files into ten isolated book roots, retains source bytes and lists after reload", async () => {
    const test = library();
    const inputs = Array.from({ length: 10 }, (_, index) => source(index + 1));
    const result = await importLibraryBooks(test.realm, inputs);
    expect(result.results.map(item => item.status)).toEqual(Array(10).fill("imported"));
    expect(new Set(result.books.map(book => book.absolutePath)).size).toBe(10);
    for (const input of inputs) {
      const book = result.books.find(item => item.filename === input.filename)!;
      expect(book.completedChapters).toBe(0);
      expect(book.totalChapters).toBe(2);
      expect(test.files.get(`${book.absolutePath}/大纲/导入原稿.md`)).toBe(input.text);
      expect(test.files.has(`${book.absolutePath}/正文/第001章.md`)).toBe(false);
    }
    expect((await listLibraryBooks(test.realm)).books).toEqual(result.books);
    const first = result.books[0]!;
    const child = { ...test.realm, cwd: first.absolutePath, root: await test.realm.fs.resolve(first.absolutePath) };
    const childView = await listLibraryBooks(child);
    expect(childView.isBookProject).toBe(true);
    expect(childView.parentLibraryPath).toBe("/books");
    expect(childView.books).toHaveLength(1);
    await expect(importLibraryBooks(child, [source(11)])).rejects.toThrow("先回到书库");
  });

  it("deduplicates repeated files without overwriting author edits and separates same-title books", async () => {
    const test = library();
    const first = await importLibraryBooks(test.realm, [source(1), source(1)]);
    expect(first.results.map(item => item.status)).toEqual(["imported", "existing"]);
    const book = first.books[0]!;
    test.files.set(`${book.absolutePath}/大纲/细纲_第001章.md`, "作者修改的细纲");
    const count = test.writes();
    expect((await importLibraryBooks(test.realm, [source(1)])).results[0]?.status).toBe("existing");
    expect(test.writes()).toBe(count);
    expect(test.files.get(`${book.absolutePath}/大纲/细纲_第001章.md`)).toBe("作者修改的细纲");
    const second = await importLibraryBooks(test.realm, [{ ...source(1), text: source(1).text.replace("钥匙", "不同版本钥匙") }]);
    expect(second.books).toHaveLength(2);
    expect(new Set(second.books.map(item => item.title)).size).toBe(1);
    expect(new Set(second.books.map(item => item.absolutePath)).size).toBe(2);
  });

  it("isolates a malformed source and resumes only an interrupted project's missing artifacts", async () => {
    const test = library();
    test.fail("/大纲/细纲_第002章.md");
    const result = await importLibraryBooks(test.realm, [source(1), { filename: "错误.txt", text: "没有章节" }, source(2)]);
    expect(result.results.map(item => item.status)).toEqual(["failed", "failed", "imported"]);
    expect(result.books.find(item => item.filename === "书1.txt")?.status).toBe("incomplete");
    const ready = result.books.find(item => item.filename === "书2.txt")!;
    const readySourceVersion = test.versions.get(`${ready.absolutePath}/大纲/导入原稿.md`);
    const retried = await importLibraryBooks(test.realm, [source(1), source(2)]);
    expect(retried.results.map(item => item.status)).toEqual(["imported", "existing"]);
    expect(retried.books.every(item => item.status === "ready")).toBe(true);
    expect(test.versions.get(`${ready.absolutePath}/大纲/导入原稿.md`)).toBe(readySourceVersion);
  });

  it("normalizes hostile filenames/book names into local child roots and bounds input sizes", async () => {
    const test = library();
    const result = await importLibraryBooks(test.realm, [{ ...source(1), filename: "../../outside.txt", title: "../../CON\\external" }]);
    expect(result.results[0]?.status).toBe("imported");
    expect(result.books[0]?.relativePath.split("/")).toHaveLength(2);
    expect([...test.files.keys()].every(path => path.startsWith("/books/小说项目/"))).toBe(true);
    expect(() => validateLibraryInputs(Array(51).fill(source(1)))).toThrow("1—50");
    expect(() => validateLibraryInputs([{ filename: "big.txt", text: "长".repeat(700000) }])).toThrow("超过 2 MB");
    expect(() => validateLibraryInputs([{ filename: "bad.txt", text: 123 }])).toThrow("文件名和完整文本");
    const beforeLongTitle = test.writes();
    const longTitle = await importLibraryBooks(test.realm, [{ filename: "长书名.txt", text: `书名：${"长".repeat(201)}\n第1章：开场\n一个真实事件。` }]);
    expect(longTitle.results[0]?.error).toContain("书名超过 200 字");
    expect(test.writes()).toBe(beforeLongTitle);
  });

  it("keeps healthy projects visible when one book's saved metadata is damaged", async () => {
    const test = library();
    const result = await importLibraryBooks(test.realm, [source(1), source(2)]);
    test.files.set(`${result.books[0]!.absolutePath}/追踪/书项目.json`, "broken");
    const reloaded = await listLibraryBooks(test.realm);
    expect(reloaded.books).toHaveLength(2);
    expect(reloaded.books.filter(book => book.status === "ready")).toHaveLength(1);
    expect(reloaded.books.find(book => book.status === "blocked")?.error).toContain("不是有效的项目记录");
    test.files.set("/books/小说项目/旧稿\\备份/追踪/书项目.json", "{}");
    const withInvalidDirectory = await listLibraryBooks(test.realm);
    expect(withInvalidDirectory.books.filter(book => book.status === "ready")).toHaveLength(1);
    expect(withInvalidDirectory.books.find(book => book.title === "旧稿\\备份")?.absolutePath).toBe("");
  });
});
