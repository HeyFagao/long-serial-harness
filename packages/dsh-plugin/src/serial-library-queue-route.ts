import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { FsVersion } from "@deepseek-ai/dsh-fs";
import { listLibraryBooks } from "./serial-library.js";
import { captureLibraryOwnerContext, ensureLibraryBookRealm, type LibraryOwnerContext } from "./serial-library-native.js";
import { assertLibraryTask, assertLibraryConcurrency, SerialLibraryRuntime, type LibraryQueueAdapter, type LibraryTask } from "./serial-library-runtime.js";
import { getSerialRuntime } from "./serial-route.js";
import { creativeTarget, jsonBody, mapFsError, readVersionedFile, send, workspaceRealmForSession, WorkspaceHttpError, type WorkspaceRealm } from "./workspace-route.js";
import { isTrustedWorkspaceRequest } from "./workspace-request-trust.js";

const TASK_PATH = "追踪/书库任务.json";
const MAX_BYTES = 2_097_152;

export function createLibraryQueueAdapter(context: Context, realm: WorkspaceRealm): LibraryQueueAdapter {
  let version: FsVersion | undefined;
  return {
    ownerSessionId: realm.sessionId, cwd: realm.cwd, makeId: randomUUID, now: () => new Date().toISOString(),
    async load() {
      const target = await creativeTarget(realm, TASK_PATH);
      if (await realm.fs.stat(target) === undefined) return null;
      const file = await readVersionedFile(realm.fs, target, MAX_BYTES);
      const value: unknown = JSON.parse(file.content);
      assertLibraryTask(value);
      version = file.version;
      return value;
    },
    async save(task) {
      const saved = await realm.fs.writeText(await creativeTarget(realm, TASK_PATH), `${JSON.stringify(task, null, 2)}\n`,
        version === undefined ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version },
        undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
      version = saved.version;
    },
    async captureContext() {
      const fresh = await workspaceRealmForSession(context, realm.sessionId);
      if (fresh.root.targetKey !== realm.root.targetKey) throw new WorkspaceHttpError(409, "书库所属会话目录已改变，未开始批量写作。");
      realm = fresh;
      return captureLibraryOwnerContext(realm);
    },
    async plan() {
      const library = await listLibraryBooks(realm);
      if (library.isBookProject) throw new WorkspaceHttpError(409, "请回到书库总览操作所有项目。");
      return library.books.map(book => ({ id: book.id, title: book.title, absolutePath: book.absolutePath,
        nextChapter: book.completedChapters + 1, lastChapter: Math.max(book.completedChapters, book.totalChapters),
        ...(book.absolutePath === "" || book.totalChapters < 1 ? { error: book.error ?? "本书项目记录无效，请先修复导入。" }
          : book.status === "incomplete" ? { error: "本书导入尚未完成，请重新选择原文件补齐后重试。" }
          : ["running", "pausing", "paused", "blocked"].includes(book.status) ? { error: "本书已有未结束的单书任务，请先在原会话继续或停止。" } : {}) }));
    },
    async controller(book, task) {
      const currentLibrary = await listLibraryBooks(realm);
      const current = currentLibrary.books.find(item => item.id === book.id);
      if (current === undefined || current.absolutePath !== book.absolutePath) throw new WorkspaceHttpError(409, "书项目已移动或不属于当前书库，未继续写作。");
      const bookRealm = await ensureLibraryBookRealm(context, realm, book.absolutePath, book.ownerSessionId, task.ownerContext as LibraryOwnerContext);
      const holder = await getSerialRuntime(context, bookRealm);
      if (holder.ownerSessionId !== book.ownerSessionId) throw new WorkspaceHttpError(409, "这本书已有其他会话的未完成任务，请先处理原任务。");
      return holder.runtime;
    }
  };
}

function generationOptions(input: Record<string, unknown>): LibraryTask["generation"] {
  const result: LibraryTask["generation"] = {};
  for (const name of ["minChars", "maxChars", "maxAttempts", "divergence"] as const) {
    const value = input[name];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new WorkspaceHttpError(400, `${name} 必须是整数。`);
      Object.assign(result, { [name]: value });
    }
  }
  if (result.minChars !== undefined || result.maxChars !== undefined) {
    if (result.minChars === undefined || result.maxChars === undefined || result.minChars < 500 || result.maxChars > 20000 || result.minChars > result.maxChars) throw new WorkspaceHttpError(400, "每章字数需要完整填写 500—20000 以内的有效范围。");
  }
  if (result.maxAttempts !== undefined && (result.maxAttempts < 1 || result.maxAttempts > 6)) throw new WorkspaceHttpError(400, "修订尝试次数必须为 1—6。");
  if (input.divergence !== undefined && (Number(input.divergence) < 0 || Number(input.divergence) > 2)) throw new WorkspaceHttpError(400, "批量正文生成的发散等级为 0—2；建议模式不能批量写正文。");
  if (input.style !== undefined) {
    if (typeof input.style !== "string" || input.style.length > 4000) throw new WorkspaceHttpError(400, "补充文风要求不能超过 4000 字。");
    result.style = input.style;
  }
  return result;
}

export function registerLibraryQueueRoute(context: Context, options: { readonly trustedHosts?: readonly string[] } = {}): void {
  const runtimes = new Map<string, Promise<{ runtime: SerialLibraryRuntime; ownerSessionId: string }>>();
  const obtain = async (realm: WorkspaceRealm): Promise<{ runtime: SerialLibraryRuntime; ownerSessionId: string }> => {
    const key = realm.root.targetKey;
    let pending = runtimes.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const target = await creativeTarget(realm, TASK_PATH);
        let owner = realm;
        if (await realm.fs.stat(target) !== undefined) {
          const file = await readVersionedFile(realm.fs, target, MAX_BYTES);
          const task: unknown = JSON.parse(file.content);
          assertLibraryTask(task);
          if (task.ownerSessionId !== realm.sessionId && task.status !== "completed" && task.status !== "stopped") {
            owner = await workspaceRealmForSession(context, task.ownerSessionId);
            if (owner.root.targetKey !== key) throw new WorkspaceHttpError(409, "书库任务与所属会话目录不符。");
          }
        }
        const runtime = new SerialLibraryRuntime(createLibraryQueueAdapter(context, owner));
        await runtime.restore();
        return { runtime, ownerSessionId: owner.sessionId };
      })();
      runtimes.set(key, pending);
      void pending.catch(() => { runtimes.delete(key); });
    }
    const holder = await pending;
    const task = holder.runtime.snapshot();
    if (holder.ownerSessionId !== realm.sessionId && (task === null || task.status === "completed" || task.status === "stopped")) {
      holder.runtime.dispose();
      runtimes.delete(key);
      return obtain(realm);
    }
    return holder;
  };
  context.effect(() => () => {
    for (const pending of runtimes.values()) void pending.then(holder => { holder.runtime.dispose(); }).catch(() => undefined);
    runtimes.clear();
  }, "serial library queue lifecycle");
  context.effect(() => context.webServer.register({ kind: "exact", path: "/oh-story/library/queue", async handler(request: IncomingMessage, response: ServerResponse) {
    try {
      if (!isTrustedWorkspaceRequest(request, options.trustedHosts ?? [])) throw new WorkspaceHttpError(403, "请求来源不受信任。");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const realm = await workspaceRealmForSession(context, url.searchParams.get("sessionId") ?? "");
      const holder = await obtain(realm);
      if (request.method === "GET") { send(response, 200, { task: holder.runtime.snapshot() }); return; }
      if (request.method !== "POST") throw new WorkspaceHttpError(405, "仅支持 GET 和 POST。");
      if (holder.ownerSessionId !== realm.sessionId) throw new WorkspaceHttpError(409, "请回到启动本批的书库会话管理队列。");
      const input = await jsonBody(request, 65_536);
      let task: LibraryTask;
      switch (input.action) {
        case "start": {
          if (input.count !== 10 && input.count !== 20 && input.count !== "all") throw new WorkspaceHttpError(400, "请选择所有项目新增 10 章、20 章或写至完本。");
          const concurrency = input.concurrency ?? "all";
          assertLibraryConcurrency(concurrency);
          task = await holder.runtime.start(input.count, generationOptions(input), concurrency);
          break;
        }
        case "pause": task = await holder.runtime.pause(); break;
        case "resume": task = await holder.runtime.resume(); break;
        case "stop": task = await holder.runtime.stop(); break;
        default: throw new WorkspaceHttpError(400, "未知书库队列操作。");
      }
      send(response, 200, { task });
    } catch (error) {
      const mapped = error instanceof WorkspaceHttpError ? error : mapFsError(error);
      send(response, mapped?.status ?? 409, { error: mapped?.message ?? (error instanceof Error ? error.message : "书库队列操作失败。") });
    }
  } }), "serial multi-book generation API");
}
