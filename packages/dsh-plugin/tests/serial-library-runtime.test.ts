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
  const stops: string[] = [];
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
        stops.push(book.id);
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
    async captureContext(modelSelection) { return { modelSelection: modelSelection ?? { provider: "selected-relay", model: "selected-model" } }; },
    async plan() { return lengths.map((lastChapter, i) => ({ id: String(i), title: `Book ${String(i)}`, absolutePath: `/library/book-${String(i)}`, nextChapter: totals[i]! + 1, lastChapter })); },
    controller
  };
  return { adapter, totals, starts, retries, stops, errors, owners, saved: () => saved, maxActive: () => maxActive, hold: (value: boolean) => { hold = value; },
    failAcquisition: (error?: string) => { acquisitionError = error; }, failStop: (error?: string) => { stopError = error; } };
}

describe("durable multi-book generation", () => {
  it("writes exactly ten selected chapters and supports fifty without touching unselected books", async () => {
    const f = fixture([100, 100, 100]); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all", ["0", "2"]); await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 0, 10]); expect(f.starts.map(book => book.book)).toEqual(["0", "2"]);
    await queue.start(50, {}, "all", ["1"]); await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 50, 10]); expect(f.starts.at(-1)).toEqual({ book: "1", from: 1, to: 50 }); queue.dispose();
  });

  it("rejects empty, unknown and mixed invalid selections before creating a batch", async () => {
    const f = fixture([20, 20]); const queue = new SerialLibraryRuntime(f.adapter);
    await expect(queue.start(10, {}, "all", [])).rejects.toThrow("勾选");
    await expect(queue.start(10, {}, "all", ["0", "missing"])).rejects.toThrow("不在当前书库");
    expect(f.saved()).toBeNull(); expect(f.starts).toEqual([]); queue.dispose();
  });

  it("appends selected books during generation without changing old targets or captured settings", async () => {
    const f = fixture([100, 100, 100]); f.hold(true); let model = "first";
    f.adapter.captureContext = async () => ({ model });
    const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, { style: "first-style" }, "all", ["0", "1"]);
    await until(() => f.starts.length === 2); const old = queue.snapshot()!;
    model = "second"; await queue.start(20, { style: "second-style" }, "all", ["2"]);
    await until(() => f.starts.length === 3);
    const current = queue.snapshot()!;
    expect(current.id).toBe(old.id); expect(current.books.slice(0, 2)).toEqual(old.books);
    expect(current.books[2]).toMatchObject({ targetChapter: 20, count: 20, generation: { style: "second-style" }, ownerContext: { model: "second" } });
    expect(current.ownerContext).toEqual({ model: "first" }); expect(current.generation).toEqual({ style: "first-style" });
    await expect(queue.start(10, {}, "all", ["0"])).rejects.toThrow("继续所选书");
    f.hold(false); await until(() => queue.snapshot()?.status === "completed"); expect(f.totals).toEqual([10, 10, 20]); queue.dispose();
  });

  it("pins different model and effort choices for appended books and preserves pending choices after restart", async () => {
    const f = fixture([20, 20, 20]); f.hold(true);
    const firstModel = { provider: "gpt-relay", model: "gpt-writing", reasoningEffort: "high" };
    const secondModel = { provider: "claude-relay", model: "claude-writing", reasoningEffort: "low" };
    const used: { book: string; modelSelection: unknown }[] = [];
    const baseController = f.adapter.controller;
    f.adapter.controller = async (book, task) => {
      const inner = await baseController(book, task);
      return { ...inner, async start(options) { used.push({ book: book.id, modelSelection: structuredClone(options.modelSelection) }); return inner.start(options); } };
    };
    const first = new SerialLibraryRuntime(f.adapter);
    await first.start(10, { modelSelection: firstModel }, 1, ["0", "1"]);
    await until(() => f.starts.length === 1);
    const original = first.snapshot()!.books[0]!;
    await first.start(20, { modelSelection: secondModel }, 1, ["2"]);
    expect(first.snapshot()!.books[0]).toEqual(original);
    expect(first.snapshot()!.books[1]).toMatchObject({ ownerContext: { modelSelection: firstModel }, generation: { modelSelection: firstModel } });
    expect(first.snapshot()!.books[2]).toMatchObject({ ownerContext: { modelSelection: secondModel }, generation: { modelSelection: secondModel } });
    firstModel.reasoningEffort = "low";
    expect(first.snapshot()!.books[1]!.generation!.modelSelection!.reasoningEffort).toBe("high");
    await first.pause(); await until(() => first.snapshot()?.status === "paused"); first.dispose();
    f.adapter.captureContext = async () => ({ modelSelection: { provider: "later-relay", model: "later-model" } });
    const recovered = new SerialLibraryRuntime(f.adapter); await recovered.restore(); await recovered.resume(); f.hold(false);
    await until(() => recovered.snapshot()?.status === "completed");
    expect(used).toEqual([
      { book: "0", modelSelection: { provider: "gpt-relay", model: "gpt-writing", reasoningEffort: "high" } },
      { book: "1", modelSelection: { provider: "gpt-relay", model: "gpt-writing", reasoningEffort: "high" } },
      { book: "2", modelSelection: secondModel }
    ]);
    recovered.dispose();
  });

  it("pauses only selected running books and resumes their original target", async () => {
    const f = fixture([30, 30]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.starts.length === 2);
    const id = queue.snapshot()!.id; await queue.pauseBooks(["0"]);
    await until(() => queue.snapshot()?.books[0]?.status === "paused");
    expect(queue.snapshot()?.status).toBe("running"); expect([...f.owners.values()][1]?.status).toBe("running");
    f.hold(false); await until(() => queue.snapshot()?.status === "paused"); expect(f.totals).toEqual([0, 10]);
    await queue.resumeBooks(["0"]); await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 10]); expect(f.starts).toHaveLength(2); expect(queue.snapshot()?.id).toBe(id); queue.dispose();
  });

  it("pauses pending books before they obtain a model slot", async () => {
    const f = fixture([20, 20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, 1); await until(() => f.starts.length === 1); await queue.pauseBooks(["1"]);
    expect(queue.snapshot()?.books[1]?.status).toBe("paused"); f.hold(false);
    await until(() => queue.snapshot()?.status === "paused"); expect(f.totals).toEqual([10, 0, 10]);
    expect(f.starts.map(book => book.book)).toEqual(["0", "2"]);
    await queue.resumeBooks(["1"]); await until(() => queue.snapshot()?.status === "completed"); expect(f.totals).toEqual([10, 10, 10]); queue.dispose();
  });

  it("keeps individually paused books paused through global pause and resume", async () => {
    const f = fixture([20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.starts.length === 2);
    await queue.pauseBooks(["0"]); await until(() => queue.snapshot()?.books[0]?.status === "paused");
    await queue.pause(); await until(() => queue.snapshot()?.status === "paused"); await queue.resume();
    await until(() => [...f.owners.values()][1]?.status === "running");
    expect([...f.owners.values()][0]?.status).toBe("paused"); f.hold(false);
    await until(() => queue.snapshot()?.status === "paused"); expect(f.totals).toEqual([0, 10]);
    await expect(queue.resume()).rejects.toThrow("单独暂停"); queue.dispose();
  });

  it("treats a pause made in one book's editor as an individual hold", async () => {
    const f = fixture([20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.starts.length === 2);
    [...f.owners.values()][0]!.status = "paused"; f.hold(false);
    await until(() => queue.snapshot()?.status === "paused");
    expect(f.totals).toEqual([0, 10]); expect(queue.snapshot()?.books[0]?.status).toBe("paused"); queue.dispose();
  });

  it("appends a new selection while globally paused without resuming earlier books", async () => {
    const f = fixture([20, 20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, 1, ["0", "1"]); await until(() => f.starts.length === 1);
    await queue.pause(); await until(() => queue.snapshot()?.status === "paused");
    await queue.start(10, {}, "all", ["2"]); f.hold(false); await until(() => queue.snapshot()?.status === "paused");
    expect(f.totals).toEqual([0, 0, 10]); expect(f.starts.map(book => book.book)).toEqual(["0", "2"]);
    await queue.resumeBooks(["0", "1"]); await until(() => queue.snapshot()?.status === "completed"); expect(f.totals).toEqual([10, 10, 10]); queue.dispose();
  });

  it("selectively resumes a global hold without starting unselected reservations", async () => {
    const f = fixture([20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, 1); await until(() => f.starts.length === 1);
    await queue.pause(); await until(() => queue.snapshot()?.status === "paused");
    await queue.resumeBooks(["1"]); f.hold(false); await until(() => queue.snapshot()?.status === "paused");
    expect(f.totals).toEqual([0, 10]); expect(queue.snapshot()?.books[0]?.status).toBe("paused"); queue.dispose();
  });

  it("does not hide an unselected live writer when cancellation of a blocked queue failed", async () => {
    const f = fixture([20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, 1); await until(() => f.starts.length === 1);
    f.failStop("native cancellation unavailable"); await queue.stop(); expect(queue.snapshot()?.status).toBe("blocked");
    const before = queue.snapshot();
    await expect(queue.resumeBooks(["1"])).rejects.toThrow("native cancellation unavailable");
    expect(queue.snapshot()).toEqual(before); expect(f.starts.map(book => book.book)).toEqual(["0"]);
    expect([...f.owners.values()][0]?.status).toBe("running");
    f.failStop(); await queue.resumeBooks(["1"]); f.hold(false); await until(() => queue.snapshot()?.status === "paused");
    expect(f.totals).toEqual([0, 10]); expect([...f.owners.values()][0]?.status).toBe("stopped"); queue.dispose();
  });

  it("starts a fresh selected batch after all previous reservations finished", async () => {
    const f = fixture([20, 20, 20]); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => queue.snapshot()?.status === "completed");
    const oldId = queue.snapshot()!.id;
    await queue.start(10, {}, "all", ["1"]); await until(() => queue.snapshot()?.status === "completed");
    expect(queue.snapshot()?.id).not.toBe(oldId); expect(queue.snapshot()?.books.map(book => book.id)).toEqual(["1"]);
    expect(f.totals).toEqual([10, 20, 10]); queue.dispose();
  });

  it("preserves explicit pause intent after restart and does not extend resumed targets", async () => {
    const f = fixture([20, 20]); f.hold(true); const first = new SerialLibraryRuntime(f.adapter);
    await first.start(10, {}, "all"); await until(() => f.starts.length === 2);
    await first.pauseBooks(["0"]); await until(() => first.snapshot()?.books[0]?.status === "paused"); first.dispose();
    for (const task of f.owners.values()) task.status = "paused";
    const recovered = new SerialLibraryRuntime(f.adapter); await recovered.restore(); await recovered.resume(); f.hold(false);
    await until(() => recovered.snapshot()?.status === "paused"); expect(f.totals).toEqual([0, 10]);
    await recovered.resumeBooks(["0"]); await until(() => recovered.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 10]); expect(f.starts).toHaveLength(2); recovered.dispose();
  });

  it("keeps a pausing native request in its concurrency slot and stops it with the queue", async () => {
    const f = fixture([20, 20, 20]); f.hold(true); const baseController = f.adapter.controller;
    f.adapter.controller = async (book, task) => {
      const inner = await baseController(book, task);
      return { ...inner, async pause() { const current = f.owners.get(book.ownerSessionId)!; current.status = "pausing"; return structuredClone(current); } };
    };
    const queue = new SerialLibraryRuntime(f.adapter); await queue.start(10, {}, 2);
    await until(() => f.starts.length === 2); await queue.pauseBooks(["0"]);
    expect(queue.snapshot()?.books[0]?.status).toBe("pausing");
    await expect(queue.resumeBooks(["0"])).rejects.toThrow("正在完成当前章");
    await new Promise(resolve => setTimeout(resolve, 10)); expect(f.starts).toHaveLength(2);
    await queue.stop(); expect(new Set(f.stops)).toEqual(new Set(["0", "1"])); queue.dispose();
  });

  it("still blocks shared provider failures discovered while a selected book pauses", async () => {
    const f = fixture([20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.starts.length === 2);
    const failed = [...f.owners.values()][0]!; failed.status = "blocked"; failed.error = "HTTP 429";
    await queue.pauseBooks(["0"]);
    expect(queue.snapshot()?.status).toBe("blocked"); expect(queue.snapshot()?.books[0]?.status).toBe("paused");
    expect([...f.owners.values()].every(task => task.status === "stopped")).toBe(true); queue.dispose();
  });

  it("recognizes completion instead of leaving a selected final chapter paused", async () => {
    const f = fixture([1, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.starts.length === 2);
    const finished = [...f.owners.values()][0]!; finished.status = "completed"; finished.completed = [1]; finished.nextChapter = 2;
    await queue.pauseBooks(["0"]);
    expect(queue.snapshot()?.books[0]).toMatchObject({ status: "completed", completedChapters: 1 });
    expect(queue.snapshot()?.status).toBe("running"); queue.dispose();
  });

  it("uses per-book generation options when a later selection joins a live batch", async () => {
    const f = fixture([20, 20]); f.hold(true); const baseController = f.adapter.controller;
    const used: { id: string; style?: string }[] = [];
    f.adapter.controller = async (book, task) => {
      const inner = await baseController(book, task);
      return { ...inner, async start(options) { used.push({ id: book.id, ...(options.style === undefined ? {} : { style: options.style }) }); return inner.start(options); } };
    };
    const queue = new SerialLibraryRuntime(f.adapter); await queue.start(10, { style: "first" }, "all", ["0"]);
    await until(() => f.starts.length === 1); await queue.start(10, { style: "second" }, "all", ["1"]);
    await until(() => f.starts.length === 2); expect(used).toEqual([{ id: "0", style: "first" }, { id: "1", style: "second" }]); queue.dispose();
  });

  it("keeps an explicit pause recoverable when the other running book is deleted", async () => {
    const f = fixture([20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.starts.length === 2);
    await queue.pauseBooks(["0"]); await until(() => queue.snapshot()?.books[0]?.status === "paused");
    await queue.excludeBookForDeletion("1");
    expect(queue.snapshot()?.status).toBe("paused"); expect(queue.snapshot()?.books.map(book => book.id)).toEqual(["0"]);
    f.hold(false); await queue.resumeBooks(["0"]); await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 0]); queue.dispose();
  });

  it("finishes a persisted individual pause after restart without resuming that book", async () => {
    const f = fixture([20, 20]); f.hold(true); const baseController = f.adapter.controller;
    f.adapter.controller = async (book, task) => {
      const inner = await baseController(book, task);
      return { ...inner, async pause() { const current = f.owners.get(book.ownerSessionId)!; current.status = "pausing"; return structuredClone(current); } };
    };
    const first = new SerialLibraryRuntime(f.adapter); await first.start(10, {}, "all"); await until(() => f.starts.length === 2);
    await first.pauseBooks(["0"]); expect(first.snapshot()?.books[0]?.status).toBe("pausing"); first.dispose();
    for (const task of f.owners.values()) task.status = "paused";
    const recovered = new SerialLibraryRuntime(f.adapter); await recovered.restore(); await recovered.resumeBooks(["1"]); f.hold(false);
    await until(() => recovered.snapshot()?.status === "paused");
    expect(f.totals).toEqual([0, 10]); expect(f.retries.map(item => item.book)).toEqual(["1"]);
    expect(recovered.snapshot()?.books[0]?.status).toBe("paused"); recovered.dispose();
  });

  it("resumes the same individually pausing book after restart without waking its neighbor", async () => {
    const f = fixture([20, 20]); f.hold(true); const baseController = f.adapter.controller;
    f.adapter.controller = async (book, task) => {
      const inner = await baseController(book, task);
      return { ...inner, async pause() { const current = f.owners.get(book.ownerSessionId)!; current.status = "pausing"; return structuredClone(current); } };
    };
    const first = new SerialLibraryRuntime(f.adapter); await first.start(10, {}, "all"); await until(() => f.starts.length === 2);
    await first.pauseBooks(["0"]); first.dispose(); for (const task of f.owners.values()) task.status = "paused";
    const recovered = new SerialLibraryRuntime(f.adapter); await recovered.restore();
    expect(recovered.snapshot()?.books[0]?.status).toBe("pausing"); await recovered.resumeBooks(["0"]); f.hold(false);
    await until(() => recovered.snapshot()?.status === "paused");
    expect(f.totals).toEqual([10, 0]); expect(f.retries.map(item => item.book)).toEqual(["0"]);
    expect(f.starts).toHaveLength(2); expect(recovered.snapshot()?.books[0]?.targetChapter).toBe(10); recovered.dispose();
  });

  it("refuses cold selected resume while the selected native task is still pausing", async () => {
    const f = fixture([20, 20]); f.hold(true); const baseController = f.adapter.controller;
    f.adapter.controller = async (book, task) => {
      const inner = await baseController(book, task);
      return { ...inner, async pause() { const current = f.owners.get(book.ownerSessionId)!; current.status = "pausing"; return structuredClone(current); } };
    };
    const first = new SerialLibraryRuntime(f.adapter); await first.start(10, {}, "all"); await until(() => f.starts.length === 2);
    await first.pauseBooks(["0"]); first.dispose();
    const recovered = new SerialLibraryRuntime(f.adapter); await recovered.restore(); const before = recovered.snapshot();
    await expect(recovered.resumeBooks(["0"])).rejects.toThrow("仍在完成当前章");
    expect(recovered.snapshot()).toEqual(before); expect(f.retries).toEqual([]); expect(f.starts).toHaveLength(2); recovered.dispose();
  });

  it("removes one running reservation without stopping concurrent books or bringing it back on resume", async () => {
    const f = fixture([20, 20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.saved()?.books.every(book => book.serialTaskId !== undefined) === true);
    const owners = new Map(queue.snapshot()!.books.map(book => [book.id, book.ownerSessionId]));
    await queue.excludeBookForDeletion("1");
    expect(f.stops).toEqual(["1"]);
    expect(f.saved()?.books.map(book => book.id)).toEqual(["0", "2"]);
    expect(f.owners.get(owners.get("1")!)?.status).toBe("stopped");
    expect(["0", "2"].every(id => f.owners.get(owners.get(id)!)?.status === "running")).toBe(true);
    await queue.pause(); await until(() => queue.snapshot()?.status === "paused");
    f.hold(false); await queue.resume(); await until(() => queue.snapshot()?.status === "completed");
    expect(f.retries.map(item => item.book)).toEqual(["0", "2"]);
    expect(f.totals).toEqual([10, 0, 10]); expect(f.starts).toHaveLength(3); queue.dispose();
  });

  it("removes a pending reservation without opening or stopping another book", async () => {
    const f = fixture([20, 20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10); await until(() => f.saved()?.books[0]?.serialTaskId !== undefined);
    await queue.excludeBookForDeletion("1");
    expect(f.stops).toEqual([]); expect(f.starts.map(item => item.book)).toEqual(["0"]);
    f.hold(false); await until(() => queue.snapshot()?.status === "completed");
    expect(f.starts.map(item => item.book)).toEqual(["0", "2"]); expect(f.totals).toEqual([10, 0, 10]); queue.dispose();
  });

  it("removes failed entries and completes an empty queue", async () => {
    const f = fixture([20]); f.errors.set("0", "正文验收失败"); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10); await until(() => queue.snapshot()?.status === "completed");
    expect(queue.snapshot()?.books[0]?.status).toBe("failed");
    await queue.excludeBookForDeletion("0");
    expect(f.saved()?.books).toEqual([]); expect(f.saved()?.status).toBe("completed");
    await expect(queue.resume()).rejects.toThrow("本批已经结束"); queue.dispose();
  });

  it("deletes a failed book from a completed historical batch opened by another library session", async () => {
    const f = fixture([1, 1]); f.errors.set("0", "正文验收失败");
    const first = new SerialLibraryRuntime(f.adapter); await first.start(10);
    await until(() => first.snapshot()?.status === "completed"); first.dispose();
    const priorOwner = f.saved()!.ownerSessionId; const untouched = f.saved()!.books[1];
    const next = new SerialLibraryRuntime({ ...f.adapter, ownerSessionId: "new-library-session" }); await next.restore();
    await next.excludeBookForDeletion("0");
    expect(f.saved()?.ownerSessionId).toBe(priorOwner); expect(f.saved()?.status).toBe("completed");
    expect(f.saved()?.books).toEqual([untouched]); expect(f.starts).toHaveLength(2); expect(f.retries).toEqual([]); next.dispose();
  });

  it("deletes one book from a stopped historical batch without adopting or resuming it", async () => {
    const f = fixture([20, 20]); f.hold(true);
    const first = new SerialLibraryRuntime(f.adapter); await first.start(10);
    await until(() => f.saved()?.books[0]?.serialTaskId !== undefined); await first.stop(); first.dispose();
    const priorOwner = f.saved()!.ownerSessionId; const untouched = f.saved()!.books[1];
    const next = new SerialLibraryRuntime({ ...f.adapter, ownerSessionId: "new-library-session" }); await next.restore();
    await next.excludeBookForDeletion("0");
    expect(f.saved()?.ownerSessionId).toBe(priorOwner); expect(f.saved()?.status).toBe("stopped");
    expect(f.saved()?.books).toEqual([untouched]); expect(f.starts).toHaveLength(1); expect(f.retries).toEqual([]); next.dispose();
  });

  it("closes the current book writer through the deletion callback when the old reservation no longer matches", async () => {
    const f = fixture([20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.saved()?.books.every(book => book.serialTaskId !== undefined) === true);
    const selected = f.saved()!.books[0]!; const other = f.saved()!.books[1]!;
    const current = f.owners.get(selected.ownerSessionId)!;
    current.id = "new-independent-task"; current.ownerSessionId = "new-book-owner";
    f.failAcquisition("old model no longer configured");
    let shutdowns = 0;
    await queue.excludeBookForDeletion(selected.id, async () => { shutdowns += 1; current.status = "stopped"; });
    expect(shutdowns).toBe(1); expect(current.status).toBe("stopped"); expect(f.stops).toEqual([]);
    expect(f.saved()?.books).toEqual([other]); expect(f.owners.get(other.ownerSessionId)?.status).toBe("running");
    expect(f.retries).toEqual([]); queue.dispose();
  });

  it("retains an old reservation if the current-writer deletion callback cannot confirm shutdown", async () => {
    const f = fixture([20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10); await until(() => f.saved()?.books[0]?.serialTaskId !== undefined);
    const before = f.saved();
    await expect(queue.excludeBookForDeletion("0", async () => { throw new Error("current writer still running"); })).rejects.toThrow("current writer still running");
    expect(f.saved()).toEqual(before); expect(f.stops).toEqual([]); queue.dispose();
  });

  it("clears the removed book's global error while leaving a blocked queue paused for explicit resume", async () => {
    const f = fixture([20, 20]); f.errors.set("0", "HTTP 403 no_subscription"); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10); await until(() => queue.snapshot()?.status === "blocked");
    await queue.excludeBookForDeletion("0");
    expect(f.saved()?.books.map(book => book.id)).toEqual(["1"]);
    expect(f.saved()?.status).toBe("blocked"); expect(f.saved()?.error).toBeUndefined();
    expect(f.starts.map(item => item.book)).toEqual(["0"]);
    f.errors.clear(); await queue.resume(); await until(() => queue.snapshot()?.status === "completed");
    expect(f.starts.map(item => item.book)).toEqual(["0", "1"]); queue.dispose();
  });

  it("keeps a blocked reservation and its errors when deletion cannot cancel its child", async () => {
    const f = fixture([20, 20]); f.errors.set("0", "HTTP 403 no_subscription"); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10); await until(() => queue.snapshot()?.status === "blocked");
    const before = f.saved(); f.failStop("native cancellation failed");
    await expect(queue.excludeBookForDeletion("0")).rejects.toThrow("native cancellation failed");
    expect(f.saved()).toEqual(before); expect(queue.snapshot()).toEqual(before);
    f.failStop(); await queue.excludeBookForDeletion("0");
    expect(f.saved()?.books.map(book => book.id)).toEqual(["1"]); queue.dispose();
  });

  it("uses the native deletion barrier before removing the reservation and can retry its failure", async () => {
    const f = fixture([20, 20]); f.errors.set("0", "HTTP 403 no_subscription");
    const controller = f.adapter.controller; let fail = true; let draining = false; let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    f.adapter.controller = async (book, task) => {
      const inner = await controller(book, task);
      return { ...inner, async shutdownForDeletion() {
        if (fail) throw new Error("native still pending");
        await inner.stop(); draining = true; await drained;
      } };
    };
    const queue = new SerialLibraryRuntime(f.adapter); await queue.start(10);
    await until(() => queue.snapshot()?.status === "blocked"); const before = f.saved();
    await expect(queue.excludeBookForDeletion("0")).rejects.toThrow("native still pending");
    expect(f.saved()).toEqual(before);
    fail = false; const deletion = queue.excludeBookForDeletion("0");
    await until(() => draining); expect(f.saved()).toEqual(before);
    release(); await deletion;
    expect(f.saved()?.books.map(book => book.id)).toEqual(["1"]); queue.dispose();
  });

  it("runs all ten books together and stops/resumes every admitted book", async () => {
    const f = fixture(Array<number>(10).fill(20)); f.hold(true);
    const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all");
    await until(() => f.starts.length === 10);
    expect(f.maxActive()).toBe(10);
    const id = queue.snapshot()!.id;
    await queue.pause(); await until(() => queue.snapshot()?.status === "paused");
    expect([...f.owners.values()].every(task => task.status === "paused")).toBe(true);
    await queue.resume(); await until(() => [...f.owners.values()].every(task => task.status === "running"));
    await queue.stop();
    expect([...f.owners.values()].every(task => task.status === "stopped")).toBe(true);
    f.hold(false); await queue.resume(); await until(() => queue.snapshot()?.status === "completed");
    expect(queue.snapshot()!.id).toBe(id); expect(f.starts).toHaveLength(10);
    expect(f.totals).toEqual(Array(10).fill(10)); queue.dispose();
  });
  it("honors a custom concurrency and refills free slots", async () => {
    const f = fixture([2, 8, 4, 10, 3]); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start("all", {}, 3); await until(() => queue.snapshot()?.status === "completed");
    expect(f.maxActive()).toBe(3); expect(f.totals).toEqual([2, 8, 4, 10, 3]); queue.dispose();
  });
  it("stops all already running books on a shared provider failure", async () => {
    const f = fixture([20, 20, 20]); f.hold(true); const queue = new SerialLibraryRuntime(f.adapter);
    await queue.start(10, {}, "all"); await until(() => f.starts.length === 3);
    f.errors.set("0", "HTTP 429"); f.hold(false);
    await until(() => queue.snapshot()?.status === "blocked");
    expect([...f.owners.values()].every(task => task.status === "stopped")).toBe(true);
    f.errors.clear(); await queue.resume(); await until(() => queue.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 10, 10]); queue.dispose();
  });
  it("restores all concurrent owners and preserves the chosen concurrency", async () => {
    const f = fixture([20, 20, 20]); f.hold(true); const first = new SerialLibraryRuntime(f.adapter);
    await first.start(10, {}, "all"); await until(() => f.saved()?.books.every(book => book.serialTaskId !== undefined) === true);
    first.dispose(); for (const task of f.owners.values()) task.status = "paused";
    const next = new SerialLibraryRuntime(f.adapter); await next.restore();
    expect(next.snapshot()?.concurrency).toBe("all"); expect(next.snapshot()?.status).toBe("paused");
    f.hold(false); await next.resume(); await until(() => next.snapshot()?.status === "completed");
    expect(f.totals).toEqual([10, 10, 10]); expect(f.starts).toHaveLength(3); next.dispose();
  });
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
