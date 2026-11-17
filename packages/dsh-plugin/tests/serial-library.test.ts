import { posix } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { exportLibraryBooks, importLibraryBooks, listLibraryBooks, recycleLibraryBooks, realmForLibraryBook, selectedLibraryIds, validateLibraryInputs, type LibraryBook, type LibraryInputFile } from "../src/serial-library.js";
import { commitOriginalOutput } from "../src/serial-output.js";
import { exportSerialChapters } from "../src/serial-route.js";
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

async function writeChapter(test: ReturnType<typeof library>, book: LibraryBook, chapter = 1): Promise<void> {
  const child = await realmForLibraryBook(test.realm, book.relativePath);
  const result = await commitOriginalOutput(child, {
    active: { chapter, sessionId: `child-${book.id}-${String(chapter)}`, requestId: `req-${String(chapter)}`, attempt: 1, dispatched: true },
    taskId: "test", minChars: 2300, maxChars: 2500, totalChapters: 2, title: "钥匙",
    text: `第${String(chapter)}章 钥匙\n\n${"她走进屋里取来钥匙。".repeat(180)}\n\n【状态变更】\n本章摘要：发现钥匙的编号。\n实际字数：1800\n章尾钩类型：疑问${String(chapter % 2)}\n人物：\n林青：知道钥匙被换过，尚不知道来人的名字。\n伏笔：\nFB001：新埋，发现钥匙柄的编号。\n时间：半小时\n与章纲不同的地方及原因：无\n下一章必须接住的事：确认编号来源。`
  });
  expect(result.accepted).toBe(true);
}

describe("book recycling and TXT export", () => {
  it("keeps the durable book identity when failed generation records are malformed", async () => {
    const test = library();
    const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    test.files.set(`${book.absolutePath}/追踪/连载任务.json`, "broken json");
    const snapshot = await listLibraryBooks(test.realm);
    expect(snapshot.books).toHaveLength(1);
    expect(snapshot.books[0]).toMatchObject({ id: book.id, relativePath: book.relativePath, status: "blocked" });
  });
  it("holds a pending title out of export and uses only a title bound to the saved chapter", async () => {
    const test = library(); const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    await writeChapter(test, book);
    const taskPath = `${book.absolutePath}/追踪/连载任务.json`;
    test.files.set(taskPath, JSON.stringify({ status: "running", phase: "title", nextChapter: 1 }));
    await expect(exportLibraryBooks(test.realm, [book.id])).rejects.toThrow("标题未完成");
    const prose = test.files.get(`${book.absolutePath}/正文/第001章.md`)!;
    const title = { chapter: 1, title: "她取回了那把旧钥匙，却发现上面刻着另一个人的编号", bodySha256: createHash("sha256").update(prose).digest("hex") };
    const titlePath = `${book.absolutePath}/追踪/公众号标题/第001章.json`;
    test.files.set(titlePath, JSON.stringify(title)); test.files.set(taskPath, JSON.stringify({ status: "completed", nextChapter: 2 }));
    const outer = unzipSync(await exportLibraryBooks(test.realm, [book.id]));
    const inner = unzipSync(outer[Object.keys(outer).find(name => name.endsWith(".zip"))!]!);
    const chapter = strFromU8(inner[Object.keys(inner).find(name => name.startsWith("第001章"))!]!);
    expect(chapter).toContain(`${title.title}\r\n书名：《第1本书》`);
    expect(test.files.get(`${book.absolutePath}/正文/第001章.md`)).toBe(prose);
    test.files.set(titlePath, JSON.stringify({ ...title, bodySha256: "wrong" }));
    await expect(exportLibraryBooks(test.realm, [book.id])).rejects.toThrow("标题与正文不一致");
  });
  it("exports all saved title candidates through single-book and batch paths without changing records", async () => {
    const test = library(); const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    await writeChapter(test, book);
    const prose = test.files.get(`${book.absolutePath}/正文/第001章.md`)!;
    const candidates = ["她取回了那把旧钥匙，却发现刻着另一个人的编号", "旧钥匙上多了陌生编号，她终于察觉有人来过", "她拿回以为丢失的钥匙，柄上的编号却变了", "明明是她保管的旧钥匙，为何刻着别人的编号", "她走进屋里取来旧钥匙，却被陌生编号绊住脚"];
    const record = { chapter: 1, title: candidates[3], candidates, topThree: [candidates[3], candidates[0], candidates[1]], coreHook: "不应进入TXT的分析", tags: { category: "悬疑惊悚" }, bodySha256: createHash("sha256").update(prose).digest("hex") };
    const titlePath = `${book.absolutePath}/追踪/公众号标题/第001章.json`;
    test.files.set(titlePath, JSON.stringify(record));
    const before = new Map(test.files);
    const child = await realmForLibraryBook(test.realm, book.relativePath);
    expect((await exportSerialChapters(child)).chapters[0]).toMatchObject({ headline: record.title, headlineCandidates: candidates });
    const outer = unzipSync(await exportLibraryBooks(test.realm, [book.id]));
    const inner = unzipSync(outer[Object.keys(outer).find(name => name.endsWith(".zip"))!]!);
    const filename = Object.keys(inner).find(name => name.startsWith("第001章"))!;
    const chapter = strFromU8(inner[filename]!).replace(/^\uFEFF/u, "");
    expect(filename).toContain(record.title);
    expect(chapter.split("\r\n").slice(0, 7)).toEqual(["本章备选标题（任选一个用于发布）", ...candidates.map((title, index) => `${String(index + 1)}. ${title}`), ""]);
    expect(chapter).toContain("书名：《第1本书》\r\n第1章\r\n\r\n");
    expect(chapter).not.toContain(record.coreHook); expect(chapter).not.toContain("悬疑惊悚");
    expect(test.files).toEqual(before);
    for (const invalid of [candidates.slice(0, 4), [...candidates.slice(0, 4), candidates[0]], [...candidates.slice(0, 4), "假标题\n混入内容"]]) {
      test.files.set(titlePath, JSON.stringify({ ...record, candidates: invalid }));
      await expect(exportSerialChapters(child)).rejects.toThrow("候选标题记录无效");
    }
    test.files.set(titlePath, JSON.stringify({ ...record, bodySha256: "wrong" }));
    await expect(exportSerialChapters(child)).rejects.toThrow("标题与正文不一致");
  });
  it("recycles and restores a completed book without changing its source, prose or progress", async () => {
    const test = library();
    const book = (await importLibraryBooks(test.realm, [source(1)])).books[0]!;
    await writeChapter(test, book); await writeChapter(test, book, 2);
    const before = new Map([...test.files].filter(([path]) => !path.endsWith("书项目.json")));
    const deleted = await recycleLibraryBooks(test.realm, [book.id]);
    expect(deleted.results).toEqual([{ id: book.id, ok: true }]);
    expect(deleted.books).toHaveLength(0);
    expect(deleted.archivedBooks?.[0]).toMatchObject({ id: book.id, completedChapters: 2, status: "archived" });
    expect((await importLibraryBooks(test.realm, [source(1)])).results[0]?.error).toContain("回收站");
    const zip = unzipSync(await exportLibraryBooks(test.realm, [book.id]));
    expect(Object.keys(zip).some(name => name.endsWith("_全本.zip"))).toBe(true);
    const restored = await recycleLibraryBooks(test.realm, [book.id], true);
    expect(restored.books[0]).toMatchObject({ id: book.id, completedChapters: 2 });
    expect(restored.archivedBooks).toHaveLength(0);
    expect(new Map([...test.files].filter(([path]) => !path.endsWith("书项目.json")))).toEqual(before);
  });

  it("rejects running, paused and queue-reserved books, while processing safe selections", async () => {
    const test = library();
    const books = (await importLibraryBooks(test.realm, [source(1), source(2), source(3), source(4)])).books;
    test.files.set(`${books[0]!.absolutePath}/追踪/连载任务.json`, JSON.stringify({ status: "running" }));
    test.files.set(`${books[1]!.absolutePath}/追踪/连载任务.json`, JSON.stringify({ status: "paused" }));
    test.files.set("/books/追踪/书库任务.json", JSON.stringify({ status: "running", books: [{ id: books[2]!.id, status: "pending" }] }));
    const result = await recycleLibraryBooks(test.realm, books.map(book => book.id));
    expect(result.results.map(item => item.ok)).toEqual([false, false, false, true]);
    expect(result.archivedBooks).toHaveLength(1);
    test.files.set(`${books[0]!.absolutePath}/追踪/连载任务.json`, JSON.stringify({ status: "stopped" }));
    expect((await recycleLibraryBooks(test.realm, [books[0]!.id])).results[0]?.ok).toBe(true);
  });

  it("exports duplicate titles as distinct UTF-8 TXT files and names skipped empty books", async () => {
    const test = library();
    const books = (await importLibraryBooks(test.realm, [source(1), { ...source(1), text: source(1).text.replace("钥匙", "另一把钥匙") }, source(2)])).books;
    await writeChapter(test, books[0]!); await writeChapter(test, books[1]!);
    const before = new Map(test.files);
    const zip = unzipSync(await exportLibraryBooks(test.realm, books.map(book => book.id)));
    const names = Object.keys(zip).filter(name => name !== "导出说明.txt");
    expect(names).toHaveLength(2);
    expect(names.every(name => name.endsWith("未完结_已保存1章.zip"))).toBe(true);
    for (const name of names) {
      const inner = unzipSync(zip[name]!);
      const chapterNames = Object.keys(inner).filter(item => item.startsWith("第"));
      expect(chapterNames).toHaveLength(1);
      const data = inner[chapterNames[0]!]!;
      expect([...data.slice(0, 3)]).toEqual([239, 187, 191]);
      const body = strFromU8(data);
      expect(body).toContain("钥匙\r\n书名：《第1本书》\r\n第1章\r\n");
      expect(body).not.toContain("【状态变更】");
      expect(body).not.toContain("本章摘要");
    }
    expect(strFromU8(zip["导出说明.txt"]!)).toContain("未导出《第2本书》");
    expect(test.files).toEqual(before);
    await expect(exportLibraryBooks(test.realm, [books[2]!.id])).rejects.toThrow("没有可导出的正文");
    test.files.set(`${books[0]!.absolutePath}/正文/第001章.md`, "作者在导出前另改了稿子");
    await expect(exportLibraryBooks(test.realm, [books[0]!.id])).rejects.toThrow("校验未通过");
  });

  it("rejects arbitrary paths and unknown IDs without writing outside the selected library", async () => {
    const test = library();
    expect(() => selectedLibraryIds(["../../outside"])).toThrow("勾选");
    const result = await recycleLibraryBooks(test.realm, ["0".repeat(64)]);
    expect(result.results[0]?.ok).toBe(false);
    expect(test.writes()).toBe(0);
  });
});

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
