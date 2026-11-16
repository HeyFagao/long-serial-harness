import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import { registerWorkspaceRoute } from "../src/workspace-route.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void;

function nativeRoute() {
  let handler: Handler | undefined;
  const lookup = vi.fn();
  const context = {
    effect: (setup: () => unknown) => setup(),
    webServer: { register: (route: { handler: Handler }) => { handler = route.handler; return () => undefined; } },
    typert: { lookups: { get: lookup } }
  } as unknown as Context;
  registerWorkspaceRoute(context, { maxBytes: 2_097_152 });
  return {
    lookup,
    request: async (url: string, headers: Record<string, string> = { host: "localhost:3080" }) => {
      let status: number | undefined;
      let body: string | undefined;
      const request = { url, method: "GET", headers } as IncomingMessage;
      const response = {
        writeHead: (code: number) => { status = code; },
        end: (value: string) => { body = value; }
      } as unknown as ServerResponse;
      if (handler === undefined) throw new Error("No native route registered");
      await handler(request, response);
      return { status, body };
    }
  };
}

describe("removed workbench HTTP routes", () => {
  it("returns 404 without resolving a session or running a media capability probe", async () => {
    const route = nativeRoute();
    for (const path of [
      "/oh-story/game-preview/session/project/index.html", "/oh-story/media?sessionId=book&path=正文/cover.png",
      "/oh-story/video-preflight", "/oh-story/drama-preflight"
    ]) {
      expect((await route.request(path)).status).toBe(404);
    }
    expect(route.lookup).not.toHaveBeenCalled();
  });

  it("does not keep the old relaxed iframe-navigation exception", async () => {
    const route = nativeRoute();
    const result = await route.request("/oh-story/game-preview/session/project/index.html", {
      host: "localhost:3080", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe"
    });
    expect(result.status).toBe(403);
    expect(route.lookup).not.toHaveBeenCalled();
  });

  it("retains the native workspace configuration endpoint", async () => {
    const result = await nativeRoute().request("/oh-story/config");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ welcomeGuide: true });
  });
});
