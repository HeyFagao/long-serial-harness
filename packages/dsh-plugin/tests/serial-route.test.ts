import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import * as workspaceRoute from "../src/workspace-route.js";
import { committedChapter, importedThroughChapter, importSerialOutline, numberedChapter, prepareSerialReferenceContext, prepareSerialRepair, registerSerialRoute, requireCommittedChapterFiles, verifySerialIntegrity } from "../src/serial-route.js";
import { markBookDeleting } from "../src/serial-library-operations.js";

const source = "书名：测试书\n第1章：门开了\n主角发现钥匙不见了。\n第2章：旧账\n主角问清钥匙的来源。";

function workspace(files = new Map<string, string>()) {
  const write = vi.fn(async (path: string, content: string, intent: { kind: string }) => {
    if (intent.kind !== "createIfAbsent" && intent.kind !== "replaceIfVersion") throw new Error("unguarded write");
    if (files.has(path) && intent.kind === "createIfAbsent") throw new Error("conflict");
    files.set(path, content);
    return { after: content, version: "v1" };
  });
  const realm = {
    cwd: "/book", root: "/book", sessionId: "book", agent: { session: {} }, sandboxPolicy: { resolve: () => ({}) },
    fs: {
      resolve: async (path: string) => path,
      contains: () => true,
      stat: async (path: string) => files.has(path) ? { type: "file", size: Buffer.byteLength(files.get(path)!), version: "v1" } : [...files.keys()].some(file => file.startsWith(`${path}/`)) ? { type: "directory", version: "d1" } : undefined,
      readBytes: async (path: string) => Buffer.from(files.get(path)!),
      listDir: async (path: string) => [...files.keys()].filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")).map(file => ({ name: file.slice(path.length + 1), type: "file", target: file })),
      writeText: write
    }
  } as unknown as WorkspaceRealm;
  return { realm, files, write };
}

describe("native serial workspace route", () => {
  it.each(["GET", "POST"])("rejects a %s from an old book tab before recreating a deleted runtime", async method => {
    const test = workspace(); const path = "/books/小说项目/selected";
    const realm = { ...test.realm, cwd: path, root: { targetKey: path, displayPath: path } } as unknown as WorkspaceRealm;
    let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
    const context = { effect: (work: () => unknown) => work(), logger: () => ({ warn: vi.fn() }),
      webServer: { register: (route: { handler: typeof handler }) => { handler = route.handler; } } } as unknown as Context;
    const resolveRealm = vi.spyOn(workspaceRoute, "workspaceRealmForSession").mockResolvedValue(realm);
    const stat = vi.spyOn(realm.fs, "stat");
    try {
      registerSerialRoute(context); markBookDeleting(context, path, true);
      const response = { writeHead: vi.fn(), end: vi.fn() };
      await handler!({ url: "/oh-story/serial?sessionId=book", method, headers: { host: "127.0.0.1" } } as IncomingMessage, response as unknown as ServerResponse);
      expect(response.writeHead.mock.calls[0]?.[0]).toBe(409);
      expect(String(response.end.mock.calls[0]?.[0])).toContain("后台删除");
      expect(stat).not.toHaveBeenCalled(); expect(test.write).not.toHaveBeenCalled();
    } finally { resolveRealm.mockRestore(); stat.mockRestore(); }
  });

  it.each(["GET", "POST"])("checks the persistent deletion journal before restoring a runtime on %s after restart", async method => {
    const path = "/books/小说项目/selected";
    const test = workspace(new Map([["追踪/书库删除任务.json", JSON.stringify({ schemaVersion: 1, jobs: [{ status: "pending", requestedAt: "2026-11-17T00:00:00Z",
      book: { id: "a".repeat(64), title: "Selected", absolutePath: path, relativePath: "小说项目/selected" } }] })]]));
    const realm = { ...test.realm, cwd: path, root: { targetKey: path, displayPath: path } } as unknown as WorkspaceRealm;
    let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
    const context = { effect: (work: () => unknown) => work(), logger: () => ({ warn: vi.fn() }),
      webServer: { register: (route: { handler: typeof handler }) => { handler = route.handler; } } } as unknown as Context;
    const resolveRealm = vi.spyOn(workspaceRoute, "workspaceRealmForSession").mockResolvedValue(realm);
    const stat = vi.spyOn(realm.fs, "stat");
    try {
      registerSerialRoute(context);
      const response = { writeHead: vi.fn(), end: vi.fn() };
      await handler!({ url: "/oh-story/serial?sessionId=book", method, headers: { host: "127.0.0.1" } } as IncomingMessage, response as unknown as ServerResponse);
      expect(response.writeHead.mock.calls[0]?.[0]).toBe(409);
      expect(String(response.end.mock.calls[0]?.[0])).toContain("不能继续生成");
      expect(stat.mock.calls.every(([entry]) => (entry as unknown as string) === "追踪/书库删除任务.json")).toBe(true);
      expect(test.write).not.toHaveBeenCalled();
    } finally { resolveRealm.mockRestore(); stat.mockRestore(); }
  });

  it("imports source and outlines without overwriting and retries idempotently", async () => {
    const { realm, files, write } = workspace();
    const result = await importSerialOutline(realm, source, "自定书名");
    expect(result.title).toBe("自定书名");
    expect(result.chapters).toEqual([1, 2]);
    expect(files.get("大纲/导入原稿.md")).toBe(source);
    expect([...files.keys()].some(path => path.startsWith("正文/"))).toBe(false);
    const writes = write.mock.calls.length;
    await importSerialOutline(realm, source, "自定书名");
    expect(write).toHaveBeenCalledTimes(writes);
  });

  it("preflights every conflicting destination before writing any file", async () => {
    const { realm, write } = workspace(new Map([["大纲/细纲_第002章.md", "作者的已有大纲"]]));
    await expect(importSerialOutline(realm, source)).rejects.toThrow("覆盖已有文件");
    expect(write).not.toHaveBeenCalled();
  });

  it("backs up only an unaccepted current chapter and rejects a changed retry source", async () => {
    const { realm, files, write } = workspace(new Map([
      ["正文/第001章.md", "已有的未验收正文"],
      ["追踪/_tracking-state.json", JSON.stringify({ schema_version: 4, last_committed_chapter: 0 })]
    ]));
    const path = await prepareSerialRepair(realm, 1, 2, ["字数不足"]);
    expect(files.get(path)).toBe("已有的未验收正文");
    expect(write).toHaveBeenCalledTimes(3);
    await prepareSerialRepair(realm, 1, 2, ["字数不足"]);
    expect(write).toHaveBeenCalledTimes(3);
    files.set("正文/第001章.md", "作者刚改过的稿件");
    await expect(prepareSerialRepair(realm, 1, 2, ["字数不足"])).rejects.toThrow("备份与当前文件不一致");
    const nextBatchPath = await prepareSerialRepair(realm, 1, 2, ["字数不足"], "next-batch");
    expect(files.get(nextBatchPath)).toBe("作者刚改过的稿件");
    expect(files.get(path)).toBe("已有的未验收正文");
    files.set("追踪/_tracking-state.json", JSON.stringify({ schema_version: 4, last_committed_chapter: 1 }));
    await expect(prepareSerialRepair(realm, 1, 3, ["字数不足"])).rejects.toThrow("进度已变化");
  });

  it("detects earlier accepted prose drift, including an imported prefix, without rolling it back", async () => {
    const { realm, files } = workspace(new Map([["正文/第001章.md", "原有第一章"], ["正文/第002章.md", "原有第二章"]]));
    await expect(verifySerialIntegrity(realm, "batch-1", 2, false)).rejects.toThrow("基线丢失");
    await verifySerialIntegrity(realm, "batch-1", 2, true);
    await verifySerialIntegrity(realm, "batch-1", 2, false);
    files.set("正文/第001章.md", "子会话不应修改的旧章");
    await expect(verifySerialIntegrity(realm, "batch-1", 2, false)).rejects.toThrow("已验收的第 1 章");
    expect(files.get("正文/第001章.md")).toBe("子会话不应修改的旧章");
    files.set("正文/第001章.md", "原有第一章");
    files.set("正文/第003章.md", "新验收第三章");
    await verifySerialIntegrity(realm, "batch-1", 3, false);
    await expect(verifySerialIntegrity(realm, "batch-1", 2, false)).rejects.toThrow("进度倒退");
  });

  it("makes an existing project's style file mandatory after its first use in a batch", async () => {
    const { realm, files } = workspace(new Map([["设定/文风.md", "作者原生文风全文"], ["正文/第001章.md", "第一章完整正文"]]));
    const first = await prepareSerialReferenceContext(realm, 1, "batch-style");
    expect(first.manifest.requiresStyle).toBe(true);
    expect(files.has("追踪/连载上下文/batch-style/文风必需.json")).toBe(true);
    files.delete("设定/文风.md");
    await expect(prepareSerialReferenceContext(realm, 2, "batch-style")).rejects.toThrow("文风.md 缺失");
    const legacy = workspace();
    expect((await prepareSerialReferenceContext(legacy.realm, 1, "old-no-style")).manifest.requiresStyle).toBe(false);
    expect(legacy.write).not.toHaveBeenCalled();
  });

  it("does not accept malformed progress or silently export a missing chapter", () => {
    expect(committedChapter(undefined)).toBe(0);
    expect(committedChapter({ last_committed_chapter: 100 })).toBe(100);
    expect(importedThroughChapter({ schema_version: 4, imported_through_chapter: 10, last_committed_chapter: 10, state_revision: 0, wordcount_records: {} })).toBe(10);
    expect(() => importedThroughChapter({ schema_version: 4, imported_through_chapter: 11, last_committed_chapter: 10 })).toThrow("导入边界");
    expect(() => committedChapter({ last_committed_chapter: "100" })).toThrow();
    expect(() => requireCommittedChapterFiles(new Map([[1, "one"], [3, "three"]]), 3)).toThrow("缺少第 2 章");
    expect(numberedChapter("第001章_开场.md", "prose")).toBe(1);
    expect(numberedChapter("细纲_第050章.md", "outline")).toBe(50);
    expect(numberedChapter("第0章.md", "prose")).toBeUndefined();
  });

});
