import { describe, expect, it } from "vitest";
import { assertLibraryTask, isSharedLibraryFailure, SerialLibraryRuntime, type LibraryBookController, type LibraryQueueAdapter, type LibraryQueueBook, type LibraryTask } from "../src/serial-library-runtime.js";
import type { SerialTask } from "../src/serial-runtime.js";

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("queue did not settle");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function fixture(lengths: readonly number[]) {
  let saved: LibraryTask | null = null;
  let sequence = 0;
  let active = 0;
  let maxActive = 0;
  const totals = lengths.map(() => 0);
  const starts: { book: string; from: number; to: number }[] = [];
  const retries: { book: string; allowRetryWindow: boolean }[] = [];
  const owners = new Map<string, SerialTask>();
  const errors = new Map<string, string>();
  let acquisitionError: string | undefined;
  let stopError: string | undefined;
  let hold = false;
  const controls = new Map<string, LibraryBookController>();
  const controller = async (book: LibraryQueueBook): Promise<LibraryBookController> => {
    if (acquisitionError !== undefined) throw new Error(acquisitionError);
    const existing = controls.get(book.ownerSessionId);
    if (existing !== undefined) return existing;
    const index = Number(book.id);
    const current = () => owners.get(book.ownerSessionId) ?? null;
    const activate = (task: SerialTask) => {
      task.status = "running";
      delete task.error;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return structuredClone(task);
    };
    const value: LibraryBookController = {
      snapshot() {
        const task = current();
        if (task?.status === "running" && !hold) {
          const error = errors.get(book.id);
          if (error !== undefined) { task.status = "blocked"; task.error = error; active -= 1; }
          else {
            task.completed.push(task.nextChapter);
            totals[index] = task.nextChapter;
            task.nextChapter += 1;
            if (task.nextChapter > task.targetChapter) { task.status = "completed"; active -= 1; }
          }
        }
        return task === null ? null : structuredClone(task);
      },
      async start(options) {
        const start = totals[index]! + 1;
        if (options.startChapter !== start) throw new Error("progress changed");
        const count = options.count === "all" ? lengths[index]! - start + 1 : options.count;
        const task: SerialTask = { schemaVersion: 1, id: `serial-${String(++sequence)}`, ownerSessionId: book.ownerSessionId, cwd: book.absolutePath,
          status: "running", startChapter: start, targetChapter: start + count - 1, nextChapter: start, completed: [], completedSessions: {}, attempts: {},
          updatedAt: "now", maxAttempts: 3 };
        owners.set(book.ownerSessionId, task);
        starts.push({ book: book.id, from: start, to: task.targetChapter });
        return activate(task);
      },
      async pause() { const task = current()!; if (task.status === "running") active -= 1; task.status = "paused"; return structuredClone(task); },
      async resume(options) { retries.push({ book: book.id, allowRetryWindow: options?.allowRetryWindow === true }); return activate(current()!); },
      async stop() {
        if (stopError !== undefined) throw new Error(stopError);
        const task = current()!; if (task.status === "running") active -= 1; task.status = "stopped"; return structuredClone(task);
      }
    };
    controls.set(book.ownerSessionId, value);
    return value;
  };
  const adapter: LibraryQueueAdapter = {
    ownerSessionId: "library-owner", cwd: "/library", pollMs: 1,
    makeId: () => `id-${String(++sequence)}`, now: () => "2026-11-16T00:00:00.000Z",
    async load() { return saved === null ? null : structuredClone(saved); },
    async save(task) { saved = structuredClone(task); },
    async captureContext() { return { modelSelection: { provider: "selected-relay", model: "selected-model" } }; },
    async plan() { return lengths.map((lastChapter, i) => ({ id: String(i), title: `Book ${String(i)}`, absolutePath: `/library/book-${String(i)}`, nextChapter: totals[i]! + 1, lastChapter })); },
    controller
  };
  return { adapter, totals, starts, retries, errors, owners, saved: () => saved, maxActive: () => maxActive, hold: (value: boolean) => { hold = value; },
    failAcquisition: (error?: string) => { acquisitionError = error; }, failStop: (error?: string) => { stopError = error; } };
}

describe("durable multi-book generation", () => {
  it("adds 10, then 20, then finishes ten independent books without overrun", async () => {
    const f = fixture([32, 32, ...Array<number>(8).fill(11)]);
    const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10);
    await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual(Array(10).fill(10));
    await queue.start(20);
    await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([30, 30, ...Array<number>(8).fill(11)]);
    expect(queue.snapshot()?.books.slice(2).every(book => book.targetChapter === 11 && book.completedChapters === 1)).toBe(true);
    await queue.start("all");
    await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([32, 32, ...Array<number>(8).fill(11)]);
    expect(queue.snapshot()?.books.slice(2).every(book => book.status === "skipped")).toBe(true);
    expect(f.maxActive()).toBe(1);
    expect(f.starts).toHaveLength(22);
    queue.dispose();
  });

  it("isolates a book error and retries only its original fixed target", async () => {
    const f = fixture([30, 30, 30]);
    f.errors.set("1", "本书文风文件缺失，请恢复完整文件。");
    const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10);
    await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 0, 10]);
    expect(queue.snapshot()?.books[1]?.status).toBe("failed");
    expect(f.retries).toEqual([]); // The background queue does not grant extra retry windows.
    f.errors.delete("1");
    await queue.resume();
    await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 10, 10]);
    expect(f.starts).toHaveLength(3);
    expect(f.retries).toEqual([{ book: "1", allowRetryWindow: true }]);
    expect(f.maxActive()).toBe(1);
    queue.dispose();
  });

  it("blocks the whole queue on shared account failure before contacting later books", async () => {
    const f = fixture([30, 30, 30]);
    f.errors.set("0", "API error (403): no_subscription");
    const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10);
    await until(() => queue.snapshot()?.status === "blocked");
    expect(f.starts.map(item => item.book)).toEqual(["0"]);
    expect(f.totals).toEqual([0, 0, 0]);
    f.errors.clear();
    await queue.resume();
    await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 10, 10]);
    expect(f.starts).toHaveLength(3);
    queue.dispose();
  });

  it("pauses and stops the active book without starting another", async () => {
    const f = fixture([30, 30]);
    f.hold(true);
    const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(20);
    await until(() => f.starts.length === 1);
    await queue.pause();
    await until(() => queue.snapshot()?.status === "paused");
    expect(f.starts).toHaveLength(1);
    await queue.resume();
    await queue.stop();
    f.hold(false);
    expect(queue.snapshot()?.status).toBe("stopped");
    expect(f.starts).toHaveLength(1);
    expect([...f.owners.values()][0]?.status).toBe("stopped");
    await queue.resume();
    await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([20, 20]);
    expect(f.starts).toHaveLength(2);
    queue.dispose();
  });

  it("cancels the admitted controller if a new permission check refuses access", async () => {
    const f = fixture([30, 30]);
    f.hold(true);
    const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10);
    await until(() => f.saved()?.books[0]?.serialTaskId !== undefined);
    f.failAcquisition("书库权限已经收紧");
    await until(() => queue.snapshot()?.status === "blocked");
    expect([...f.owners.values()][0]?.status).toBe("stopped");
    expect(f.starts).toHaveLength(1);
    await queue.stop();
    expect(queue.snapshot()?.status).toBe("stopped");
    queue.dispose();
  });

  it("does not report stopped or advance when cancellation cannot be confirmed", async () => {
    const f = fixture([30, 30]);
    f.hold(true);
    const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10);
    await until(() => f.saved()?.books[0]?.serialTaskId !== undefined);
    f.failAcquisition("书库权限已经收紧");
    f.failStop("native cancellation unavailable");
    await queue.stop();
    expect(queue.snapshot()?.status).toBe("blocked");
    expect(queue.snapshot()?.error).toContain("尚未确认");
    expect(f.starts).toHaveLength(1);
    expect([...f.owners.values()][0]?.status).toBe("running");
    f.failStop();
    await queue.stop();
    expect(queue.snapshot()?.status).toBe("stopped");
    expect([...f.owners.values()][0]?.status).toBe("stopped");
    queue.dispose();
  });

  it("restores cold as paused and retains the reserved model and chapter range", async () => {
    const f = fixture([30, 30]);
    f.hold(true);
    const first = new SerialLibraryRuntime(f.adapter);
    await first.start(10);
    await until(() => f.saved()?.books[0]?.serialTaskId !== undefined);
    first.dispose();
    for (const task of f.owners.values()) task.status = "paused";
    const recovered = new SerialLibraryRuntime(f.adapter);
    await recovered.restore();
    expect(recovered.snapshot()?.status).toBe("paused");
    expect(f.starts).toHaveLength(1);
    expect(recovered.snapshot()?.ownerContext).toEqual({ modelSelection: { provider: "selected-relay", model: "selected-model" } });
    f.hold(false);
    await recovered.resume();
    await until(() => recovered.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 10]);
    expect(f.starts).toHaveLength(2);
    recovered.dispose();
  });

  it("rejects malformed queue state and identifies global rather than literary failures", () => {
    expect(() => assertLibraryTask({ schemaVersion: 1 })).toThrow();
    for (const error of ["HTTP 429", "API key invalid", "网络连接超时", "权限审批未通过", "no_subscription"]) expect(isSharedLibraryFailure(error)).toBe(true);
    expect(isSharedLibraryFailure("第3章正文缺失")).toBe(false);
    expect(isSharedLibraryFailure("本书文风文件缺失")).toBe(false);
  });
});
