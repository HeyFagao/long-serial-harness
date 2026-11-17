import type { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { isInternalRecordPath } from "../src/novel-paths.js";
import { registerWorkspaceRoute } from "../src/workspace-route.js";

function editor(path: string) {
  const files = new Map([[path, { content: "原内容", version: "v1" }]]);
  const writeText = vi.fn(async (target: string, content: string, intent: { kind: string; version: string }) => {
    const current = files.get(target);
    if (intent.kind !== "replaceIfVersion" || current?.version !== intent.version) throw new FsError("stale", "FS_STALE_VERSION");
    const next = { content, version: "v2" }; files.set(target, next);
    return { after: content, version: next.version };
  });
  const fs = { resolve: async (target: string) => target, contains: () => true, writeText,
    stat: async (target: string) => { const file = files.get(target); return file === undefined ? undefined : { type: "file", size: Buffer.byteLength(file.content), version: file.version }; },
    readBytes: async (target: string) => Buffer.from(files.get(target)!.content) };
  const sandboxPolicy = { resolve: () => ({ mode: "workspace-write", workspaceRoot: "/book" }) };
  const agent = { session: { header: { cwd: "/book" } }, ctx: { get: (name: string) => name === "fs" ? fs : name === "sandboxPolicy" ? sandboxPolicy : undefined } };
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  const context = { effect: (work: () => unknown) => work(), logger: () => ({ error: vi.fn() }),
    typert: { lookups: { get: () => ({ resolve: async () => agent }) } },
    webServer: { register: (route: { handler: typeof handler }) => { handler = route.handler; } } } as unknown as Context;
  registerWorkspaceRoute(context, { maxBytes: 1_000_000 });
  return { files, writeText, request: async (method: "GET" | "PUT", baseVersion = "v1") => {
    const request = Readable.from([Buffer.from(JSON.stringify({ content: "修改内容", baseVersion }))]) as unknown as IncomingMessage;
    request.url = `/oh-story/file?sessionId=book&path=${encodeURIComponent(path)}`;
    request.method = method; request.headers = { host: "127.0.0.1" };
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await handler!(request, response as unknown as ServerResponse);
    return { status: response.writeHead.mock.calls[0]?.[0] as number, value: JSON.parse(String(response.end.mock.calls[0]?.[0])) as { error?: string; content?: string } };
  } };
}

describe("public editor machine record protection", () => {
  it.each(["追踪/书库任务.json", "追踪/_tracking-state.json", "追踪/公众号标题/第001章.json", "追踪/连载上下文/batch/events.JSONL"])("allows reading %s but rejects public editing before mutation", async path => {
    expect(isInternalRecordPath(path)).toBe(true);
    const fixture = editor(path);
    expect(await fixture.request("GET")).toMatchObject({ status: 200, value: { content: "原内容" } });
    expect(await fixture.request("PUT")).toEqual({ status: 403, value: { error: "运行记录由工作台自动维护，只能查看。" } });
    expect(fixture.writeText).not.toHaveBeenCalled();
    expect(fixture.files.get(path)?.content).toBe("原内容");
  });

  it.each(["正文/第001章.md", "大纲/细纲_第001章.md", "设定/文风.md", "追踪/作者备注.txt", "追踪/逐章记录/第001章.md", "设定/作者配置.json"])("preserves normal versioned editing of %s", async path => {
    expect(isInternalRecordPath(path)).toBe(false);
    const fixture = editor(path);
    expect(await fixture.request("PUT", "v0")).toMatchObject({ status: 412 });
    expect(fixture.files.get(path)?.content).toBe("原内容");
    expect(await fixture.request("PUT")).toMatchObject({ status: 200, value: { content: "修改内容" } });
    expect(fixture.writeText.mock.calls.at(-1)?.[2]).toEqual({ kind: "replaceIfVersion", version: "v1" });
  });

  it("does not use the read-only classifier as path authorization", async () => {
    const fixture = editor("追踪/../secret.json");
    expect(isInternalRecordPath("追踪/../secret.json")).toBe(false);
    expect(await fixture.request("PUT")).toMatchObject({ status: 403 });
    expect(fixture.writeText).not.toHaveBeenCalled();
  });
});
