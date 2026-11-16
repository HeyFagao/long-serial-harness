import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryQueueAdapter, LibraryTask } from "../src/serial-library-runtime.js";
import { registerLibraryQueueRoute } from "../src/serial-library-queue-route.js";

const state = vi.hoisted(() => ({ stored: null as LibraryTask | null, owners: [] as string[] }));
vi.mock("../src/serial-library-runtime.js", async original => ({
  ...await original<object>(),
  SerialLibraryRuntime: class {
    private task: LibraryTask | null = null;
    constructor(private readonly adapter: LibraryQueueAdapter) { state.owners.push(adapter.ownerSessionId); }
    async restore() { this.task = await this.adapter.load(); return this.task; }
    snapshot() { return this.task; }
    async start() { return { ownerSessionId: this.adapter.ownerSessionId, status: "running" }; }
    dispose() {}
  }
}));
vi.mock("../src/workspace-request-trust.js", () => ({ isTrustedWorkspaceRequest: () => true }));
vi.mock("../src/workspace-route.js", async original => ({
  ...await original<object>(),
  workspaceRealmForSession: async (_: unknown, id: string) => ({ sessionId: id, cwd: "/library", root: { targetKey: "library" },
    fs: { stat: async () => state.stored === null ? undefined : { type: "file", version: "v1" } } }),
  creativeTarget: async () => ({ targetKey: "task" }),
  readVersionedFile: async () => ({ content: JSON.stringify(state.stored), version: "v1" }),
  jsonBody: async (request: { input?: unknown }) => request.input ?? {}
}));

function harness() {
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  const context = { effect: (setup: () => unknown) => setup(), webServer: { register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {}; } } } as unknown as Context;
  registerLibraryQueueRoute(context);
  return async (session: string, method = "GET", input?: unknown) => {
    let status = 0;
    let body = "";
    const request = { method, url: `/oh-story/library/queue?sessionId=${session}`, input } as unknown as IncomingMessage;
    const response = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } } as unknown as ServerResponse;
    await handler!(request, response);
    return { status, body: JSON.parse(body) as { task?: { ownerSessionId: string }; error?: string } };
  };
}
function stored(status: LibraryTask["status"]): LibraryTask {
  return { schemaVersion: 1, id: "queue", cwd: "/library", ownerSessionId: "owner-a", status, count: 10, books: [],
    generation: {}, ownerContext: {}, updatedAt: "now" };
}

describe("library queue owner cache", () => {
  beforeEach(() => { state.stored = null; state.owners = []; });

  it.each(["completed", "stopped"] as const)("allows another ordinary session to start after %s", async status => {
    state.stored = stored(status);
    const request = harness();
    expect((await request("owner-a")).status).toBe(200);
    const next = await request("owner-b", "POST", { action: "start", count: 10 });
    expect(next.status).toBe(200);
    expect(next.body.task?.ownerSessionId).toBe("owner-b");
    expect(state.owners).toEqual(["owner-a", "owner-b"]);
  });

  it("does not let an earlier empty editor GET claim ownership forever", async () => {
    const request = harness();
    await request("owner-a");
    const next = await request("owner-b", "POST", { action: "start", count: 10 });
    expect(next.status).toBe(200);
    expect(next.body.task?.ownerSessionId).toBe("owner-b");
  });

  it("preserves ownership while the existing queue is paused", async () => {
    state.stored = stored("paused");
    const request = harness();
    await request("owner-a");
    const next = await request("owner-b", "POST", { action: "start", count: 10 });
    expect(next.status).toBe(409);
    expect(next.body.error).toContain("启动本批");
    expect(state.owners).toEqual(["owner-a"]);
  });
});
