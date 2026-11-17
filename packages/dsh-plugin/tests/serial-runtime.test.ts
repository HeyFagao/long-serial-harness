import { describe, expect, it } from "vitest";
import { SerialRuntime, assertSerialTask, type SerialActive, type SerialAdapter, type SerialObservation, type SerialTask } from "../src/serial-runtime.js";

function fixture(count = 150) {
  let disk: SerialTask | null = null;
  let seq = 0;
  let pending: SerialActive | undefined;
  let observation: SerialObservation = { running: false, pendingInput: false, cursor: 0 };
  let automatic = true;
  const complete = new Set<number>();
  const partial = new Set<number>();
  const requests: string[] = [];
  const childIds: string[] = [];
  const cancellations: string[] = [];
  const repairable = new Set<number>();
  const backups: { chapter: number; attempt: number; issues: readonly string[]; path: string }[] = [];
  const adapter: SerialAdapter = {
    ownerSessionId: "owner", cwd: "/book", makeId: () => `id-${String(++seq)}`, now: () => "2026-11-16T00:00:00Z", pollMs: 1,
    load: async () => structuredClone(disk),
    save: async task => { disk = structuredClone(task); },
    plan: async () => ({ nextChapter: complete.size + 1, chapters: Array.from({ length: count }, (_, index) => index + 1) }),
    inspect: async chapter => ({ ok: complete.has(chapter), proseExists: complete.has(chapter) || partial.has(chapter), issues: complete.has(chapter) ? [] : ["tracking incomplete"], repairable: repairable.has(chapter) }),
    prepareRepair: async (chapter, attempt, issues) => { const path = `追踪/连载修订/第${chapter}章/尝试${attempt}-正文.md`; if (!backups.some(item => item.path === path)) backups.push({ chapter, attempt, issues, path }); return path; },
    state: async active => { if (active?.requestId === "" || active === undefined) { const value = { ...observation }; delete value.lastTurnReason; delete value.lastTurnError; return value; } return observation; },
    dispatch: async active => {
      if (!requests.includes(active.requestId)) requests.push(active.requestId);
      if (!childIds.includes(active.sessionId)) childIds.push(active.sessionId);
      pending = active;
      if (automatic) { complete.add(active.chapter); observation = { running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true, cursor: seq }; }
      else observation = { running: true, pendingInput: false, cursor: seq };
    },
    cancel: async active => { cancellations.push(active.sessionId); if (!observation.externalInput) observation = { running: false, pendingInput: false, lastTurnReason: "aborted" }; }
  };
  return {
    adapter, complete, partial, requests, childIds, repairable, backups, cancellations,
    disk: () => disk,
    setDisk: (value: SerialTask) => { disk = structuredClone(value); },
    hold: () => { automatic = false; },
    state: (value: SerialObservation) => { observation = value; },
    finish: () => { if (pending !== undefined) complete.add(pending.chapter); observation = { running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true, cursor: seq }; },
    auto: () => { automatic = true; }
  };
}
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error("scheduler did not settle");
}

describe("native serial scheduler", () => {
  it("waits for in-flight manuscript finalization and inspection before deletion settles", async () => {
    const f = fixture(2); f.hold();
    let releaseFinalization!: () => void; let releaseInspection!: () => void;
    const finalization = new Promise<void>(resolve => { releaseFinalization = resolve; });
    const inspection = new Promise<void>(resolve => { releaseInspection = resolve; });
    let finalizing = false; let inspecting = false; let closed = false; let writes = 0;
    const save = f.adapter.save; const inspect = f.adapter.inspect;
    f.adapter.save = async task => { expect(closed).toBe(false); writes += 1; await save(task); };
    f.adapter.finalize = async () => { finalizing = true; await finalization; expect(closed).toBe(false); };
    f.adapter.inspect = async (...args) => { if (finalizing) { inspecting = true; await inspection; } return inspect(...args); };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 2 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    f.finish(); await eventually(() => finalizing);
    let settled = false;
    const shutdown = runtime.shutdownForDeletion().then(() => { settled = true; closed = true; });
    await new Promise(resolve => setTimeout(resolve, 5)); expect(settled).toBe(false);
    releaseFinalization(); await eventually(() => inspecting && runtime.snapshot()?.status === "stopped");
    expect(settled).toBe(false);
    releaseInspection(); await shutdown;
    const settledWrites = writes;
    await expect(runtime.resume()).rejects.toThrow("正在删除");
    await expect(runtime.stop()).rejects.toThrow("已经关闭");
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(writes).toBe(settledWrites); expect(f.requests).toHaveLength(1);
    await runtime.shutdownForDeletion();
  });

  it("deletion cancels the independent title child and retains the completed prose until purge", async () => {
    const f = fixture(1); const titles: SerialActive[] = []; const states = new Map<string, SerialObservation>();
    const state = f.adapter.state;
    f.adapter.state = async active => states.get(active?.sessionId ?? "") ?? (f.complete.size > 0 && active?.sessionId !== f.childIds[0] ? { running: false, pendingInput: false } : state(active));
    f.adapter.inspectTitle = async () => false;
    f.adapter.dispatchTitle = async active => { titles.push(active); states.set(active.sessionId, { running: true, pendingInput: true, requestKnown: true }); };
    f.adapter.finalizeTitle = async () => ({ ok: false });
    f.adapter.cancel = async active => { f.cancellations.push(active.sessionId); states.set(active.sessionId, { running: false, pendingInput: false, lastTurnReason: "aborted" }); };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.titleActive?.dispatched === true);
    await runtime.shutdownForDeletion();
    expect(f.cancellations).toEqual([titles[0]!.sessionId]);
    expect(f.requests).toHaveLength(1); expect(titles).toHaveLength(1); expect(f.complete.has(1)).toBe(true);
    expect(runtime.snapshot()?.status).toBe("stopped");
  });

  it("retains cancellation failures and permits a later deletion retry", async () => {
    const f = fixture(1); f.hold(); const cancel = f.adapter.cancel;
    f.adapter.cancel = async () => { throw new Error("native cancellation failed"); };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    await expect(runtime.shutdownForDeletion()).rejects.toThrow("native cancellation failed");
    expect(runtime.snapshot()?.status).toBe("stopped");
    expect(f.disk()?.error).toContain("native cancellation failed");
    f.adapter.cancel = cancel;
    await runtime.shutdownForDeletion();
    expect(f.disk()?.error).toBeUndefined(); expect(f.requests).toHaveLength(1);
  });

  it("refuses deletion if native state remains pending after cancellation", async () => {
    const f = fixture(1); f.hold(); f.adapter.cancel = async () => undefined;
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    f.state({ running: false, pendingInput: true, ownQueued: true, requestKnown: true });
    await expect(runtime.shutdownForDeletion()).rejects.toThrow("尚未删除");
    expect(f.disk()?.error).toContain("仍在运行、排队或等待输入"); runtime.dispose();
  });

  it("does not let an earlier overlapping stop write an error after deletion has drained", async () => {
    const f = fixture(1); f.hold(); const cancel = f.adapter.cancel;
    let releaseOldStop!: () => void; let cancelCalls = 0;
    const oldStop = new Promise<void>(resolve => { releaseOldStop = resolve; });
    f.adapter.cancel = async active => {
      cancelCalls += 1;
      if (cancelCalls === 1) { await oldStop; throw new Error("late cancellation error"); }
      await cancel(active);
    };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    const stopping = runtime.stop(); await eventually(() => cancelCalls === 1);
    await runtime.shutdownForDeletion(); const before = f.disk();
    releaseOldStop(); await expect(stopping).rejects.toThrow("late cancellation error");
    expect(f.disk()).toEqual(before); expect(f.disk()?.error).toBeUndefined();
  });

  it("closes a completed book without model calls or rewriting its receipt", async () => {
    const f = fixture(1); const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.status === "completed");
    const before = f.disk(); await runtime.shutdownForDeletion();
    expect(f.disk()).toEqual(before); expect(f.requests).toHaveLength(1); expect(f.cancellations).toEqual([]);
  });

  it.each(["paused", "blocked", "stopped"] as const)("closes a cold %s task without starting or resuming it", async status => {
    const f = fixture(1);
    f.setDisk({ schemaVersion: 1, id: "old-task", ownerSessionId: "owner", cwd: "/book", status,
      startChapter: 1, targetChapter: 1, nextChapter: 1, completed: [], completedSessions: {}, attempts: { "1": 1 },
      active: { chapter: 1, sessionId: "old-child", requestId: "old-request", attempt: 1, dispatched: true },
      maxAttempts: 6, updatedAt: "old" });
    const runtime = new SerialRuntime(f.adapter); await runtime.shutdownForDeletion();
    expect(f.disk()?.status).toBe("stopped"); expect(f.requests).toEqual([]); expect(f.cancellations).toEqual([]);
  });

  it("closes a never-started project without creating a task receipt", async () => {
    const f = fixture(1); const runtime = new SerialRuntime(f.adapter);
    await runtime.shutdownForDeletion();
    expect(f.disk()).toBeNull(); expect(f.requests).toEqual([]);
    await expect(runtime.start({ count: 1 })).rejects.toThrow("正在删除");
  });

  it("retries only the independent title six times, then resumes without regenerating prose", async () => {
    const f = fixture(1); const titles: SerialActive[] = []; const done = new Set<number>();
    let succeeds = false;
    const state = f.adapter.state;
    f.adapter.state = async active => titles.some(item => item.sessionId === active?.sessionId)
      ? { running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true, finalText: "标题" }
      : active?.attempt !== undefined && active.sessionId !== f.childIds[0] && f.complete.size > 0 ? { running: false, pendingInput: false, requestKnown: false } : state(active);
    f.adapter.inspectTitle = async chapter => done.has(chapter);
    f.adapter.dispatchTitle = async active => { expect(f.complete.has(active.chapter)).toBe(true); titles.push({ ...active }); };
    f.adapter.finalizeTitle = async active => { if (succeeds) done.add(active.chapter); return { ok: succeeds, issue: "标题缺少依据" }; };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    expect(f.requests).toHaveLength(1); expect(titles).toHaveLength(6);
    expect(runtime.snapshot()?.error).toContain("只补标题");
    expect(runtime.snapshot()?.completed).toEqual([]); expect(f.complete.has(1)).toBe(true);
    succeeds = true;
    await runtime.resume({ allowRetryWindow: true });
    await eventually(() => runtime.snapshot()?.status === "completed");
    expect(f.requests).toHaveLength(1); expect(done.has(1)).toBe(true); runtime.dispose();
  });

  it.each(["paused", "completed"] as const)("uses the current title workflow for new chapters of a legacy %s task", async status => {
    const f = fixture(3); f.complete.add(1);
    f.setDisk({ schemaVersion: 1, id: "pre-title-workflow", ownerSessionId: "owner", cwd: "/book", status,
      startChapter: 1, targetChapter: status === "completed" ? 1 : 3, nextChapter: 2,
      completed: [1], completedSessions: { "1": "legacy-body-child" }, attempts: { "1": 1 },
      maxAttempts: 6, updatedAt: "before-upgrade" });
    const titles: SerialActive[] = []; const done = new Set<number>(); const state = f.adapter.state;
    f.adapter.state = async active => titles.some(title => title.sessionId === active?.sessionId)
      ? { running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true }
      : active !== undefined && !f.childIds.includes(active.sessionId)
        ? { running: false, pendingInput: false, requestKnown: false } : state(active);
    f.adapter.inspectTitle = async chapter => done.has(chapter);
    f.adapter.dispatchTitle = async active => { expect(f.complete.has(active.chapter)).toBe(true); titles.push({ ...active }); };
    f.adapter.finalizeTitle = async active => { done.add(active.chapter); return { ok: true }; };
    const runtime = new SerialRuntime(f.adapter); await runtime.restore();
    if (status === "completed") await runtime.start({ count: 2 }); else await runtime.resume();
    await eventually(() => runtime.snapshot()?.status === "completed");
    expect(f.requests).toHaveLength(2);
    expect(titles.map(title => title.chapter)).toEqual([2, 3]);
    expect([...done]).toEqual([2, 3]);
    expect(f.complete.has(1)).toBe(true); runtime.dispose();
  });

  it("adds the current independent title stage to an old in-flight chapter already saved before upgrade", async () => {
    const f = fixture(3); f.complete.add(1); f.complete.add(2);
    f.setDisk({ schemaVersion: 1, id: "legacy-in-flight", ownerSessionId: "owner", cwd: "/book", status: "paused",
      startChapter: 1, targetChapter: 3, nextChapter: 2, completed: [1], completedSessions: { "1": "legacy-one" },
      attempts: { "1": 1, "2": 1 }, active: { chapter: 2, sessionId: "legacy-two", requestId: "legacy-request", attempt: 1, dispatched: true },
      maxAttempts: 6, updatedAt: "before-upgrade" });
    const titles: SerialActive[] = []; const done = new Set<number>(); const state = f.adapter.state;
    f.adapter.state = async active => titles.some(title => title.sessionId === active?.sessionId)
      ? { running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true }
      : active !== undefined && !f.childIds.includes(active.sessionId)
        ? { running: false, pendingInput: false, requestKnown: false } : state(active);
    f.adapter.inspectTitle = async chapter => done.has(chapter);
    f.adapter.dispatchTitle = async active => { expect(f.complete.has(active.chapter)).toBe(true); titles.push({ ...active }); };
    f.adapter.finalizeTitle = async active => { done.add(active.chapter); return { ok: true }; };
    const runtime = new SerialRuntime(f.adapter); await runtime.restore(); await runtime.resume();
    await eventually(() => runtime.snapshot()?.status === "completed");
    expect(f.requests).toHaveLength(1);
    expect(titles.map(title => title.chapter)).toEqual([2, 3]);
    expect(runtime.snapshot()?.completedSessions["2"]).toBe("legacy-two"); runtime.dispose();
  });

  it("stops the title child and resumes it after a cold restore, preserving the prose request", async () => {
    const f = fixture(1); const titles: SerialActive[] = []; const states = new Map<string, SerialObservation>();
    const state = f.adapter.state; let done = false;
    f.adapter.state = async active => states.get(active?.sessionId ?? "") ?? (f.complete.size > 0 && active?.sessionId !== f.childIds[0] ? { running: false, pendingInput: false, requestKnown: false } : await state(active));
    f.adapter.inspectTitle = async () => done;
    f.adapter.dispatchTitle = async active => { titles.push(active); states.set(active.sessionId, { running: true, pendingInput: false, requestKnown: true }); };
    f.adapter.finalizeTitle = async () => { done = true; return { ok: true }; };
    f.adapter.cancel = async active => { f.cancellations.push(active.sessionId); states.set(active.sessionId, { running: false, pendingInput: false, lastTurnReason: "aborted", requestKnown: true }); };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => titles.length === 1);
    await runtime.stop(); expect(f.cancellations).toEqual([titles[0]!.sessionId]); runtime.dispose();
    const restored = new SerialRuntime(f.adapter); await restored.restore(); await restored.resume();
    await eventually(() => titles.length === 2);
    expect(titles[0]!.sessionId).not.toBe(titles[1]!.sessionId);
    states.set(titles[1]!.sessionId, { running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true });
    await eventually(() => restored.snapshot()?.status === "completed");
    expect(f.requests).toHaveLength(1); expect(done).toBe(true); restored.dispose();
  });
  it("settles native text through the host before accepting the chapter", async () => {
    const f = fixture(1);
    f.adapter.dispatch = async active => { f.requests.push(active.requestId); f.state({ running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true, finalText: "原版两块输出" }); };
    let finalized = 0;
    f.adapter.finalize = async (active, observation) => { expect(observation.finalText).toBe("原版两块输出"); finalized += 1; f.complete.add(active.chapter); };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1, divergence: 2 });
    await eventually(() => runtime.snapshot()?.status === "completed");
    expect(finalized).toBe(1); expect(f.requests).toHaveLength(1); expect(runtime.snapshot()?.divergence).toBe(2); runtime.dispose();
  });

  it("rejects discussion-only divergence before starting a writing batch", async () => {
    const f = fixture(1); const runtime = new SerialRuntime(f.adapter);
    await expect(runtime.start({ count: 1, divergence: 3 })).rejects.toThrow("等级 3 仅讨论");
    expect(f.requests).toHaveLength(0); runtime.dispose();
  });

  it("retries an interrupted local settlement without paying for a second model request", async () => {
    const f = fixture(1);
    f.adapter.dispatch = async active => { f.requests.push(active.requestId); f.state({ running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true, finalText: "完成的输出" }); };
    let finalized = 0;
    f.adapter.finalize = async active => { finalized += 1; if (finalized === 1) throw new Error("disk interrupted"); f.complete.add(active.chapter); };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    expect(f.requests).toHaveLength(1); expect(runtime.snapshot()?.completed).toEqual([]);
    await runtime.resume(); expect(runtime.snapshot()?.status).toBe("completed");
    expect(finalized).toBe(2); expect(f.requests).toHaveLength(1); runtime.dispose();
  });
  it("runs 50 then 100 chapters in 150 distinct fresh native child sessions", async () => {
    const f = fixture(); const runtime = new SerialRuntime(f.adapter);
    await runtime.start({ count: 50 });
    await eventually(() => runtime.snapshot()?.status === "completed");
    expect(runtime.snapshot()?.completed).toHaveLength(50);
    await runtime.start({ count: 100 });
    await eventually(() => runtime.snapshot()?.status === "completed");
    expect(runtime.snapshot()?.completed).toEqual(Array.from({ length: 100 }, (_, i) => i + 51));
    expect(new Set(f.requests).size).toBe(150);
    expect(new Set(f.childIds).size).toBe(150);
    expect(f.childIds).not.toContain("owner");
    expect(Object.keys(runtime.snapshot()!.completedSessions)).toHaveLength(100);
    expect(runtime.snapshot()).toMatchObject({ minChars: 2300, maxChars: 2500, maxAttempts: 6 });
    runtime.dispose();
  });

  it("resumes a crash after tracking commit without generating the chapter twice", async () => {
    const f = fixture(3); f.hold();
    const first = new SerialRuntime(f.adapter); await first.start({ count: 3 });
    await eventually(() => first.snapshot()?.active?.dispatched === true);
    first.dispose(); f.finish(); f.auto();
    const recovered = new SerialRuntime(f.adapter); await recovered.restore();
    expect(recovered.snapshot()?.status).toBe("paused"); await recovered.resume();
    await eventually(() => recovered.snapshot()?.status === "completed");
    expect(f.requests).toHaveLength(3);
    expect(recovered.snapshot()?.completed).toEqual([1, 2, 3]); recovered.dispose();
  });

  it("reconciles completed prose after a dispatch acknowledgement crash", async () => {
    const f = fixture(1); f.hold();
    const first = new SerialRuntime(f.adapter); await first.start({ count: 1 });
    await eventually(() => first.snapshot()?.active?.dispatched === true);
    first.dispose();
    const saved = f.disk()!; saved.active!.dispatched = false; f.setDisk(saved);
    f.finish(); f.auto();
    const recovered = new SerialRuntime(f.adapter); await recovered.restore();
    expect(recovered.snapshot()?.status).toBe("paused"); await recovered.resume();
    await eventually(() => recovered.snapshot()?.status === "completed");
    expect(f.requests).toHaveLength(1); recovered.dispose();
  });

  it("preserves partial prose and blocks instead of overwriting on recovery", async () => {
    const f = fixture(2); f.hold(); const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 2 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    f.partial.add(1); f.state({ running: false, pendingInput: false, lastTurnReason: "completed" });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    await expect(runtime.resume()).rejects.toThrow("已有未通过验收的正文");
    expect(f.requests).toHaveLength(1); runtime.dispose();
  });

  it("pauses at chapter boundary and continues only on explicit resume", async () => {
    const f = fixture(3); f.hold(); const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 3 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    expect((await runtime.pause()).status).toBe("pausing"); f.finish();
    await eventually(() => runtime.snapshot()?.status === "paused");
    expect(runtime.snapshot()?.completed).toEqual([1]); expect(f.requests).toHaveLength(1);
    f.auto(); await runtime.resume(); await eventually(() => runtime.snapshot()?.status === "completed"); runtime.dispose();
  });

  it("honors native stop even if the chapter was already committed", async () => {
    const f = fixture(3); f.hold(); const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 3 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    f.complete.add(1); f.state({ running: false, pendingInput: false, lastTurnReason: "aborted" });
    await eventually(() => runtime.snapshot()?.status === "paused");
    expect(f.requests).toHaveLength(1); expect(runtime.snapshot()?.completed).toEqual([]);
    f.state({ running: false, pendingInput: false }); f.auto(); await runtime.resume();
    await eventually(() => runtime.snapshot()?.status === "completed"); runtime.dispose();
  });

  it("yields to foreign user input without cancelling it", async () => {
    const f = fixture(3); f.hold(); const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 3 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    f.state({ running: true, pendingInput: false, externalInput: true });
    await eventually(() => runtime.snapshot()?.status === "paused");
    expect((await f.adapter.state()).running).toBe(true); expect(f.requests).toHaveLength(1);
    expect(f.cancellations).toEqual([runtime.snapshot()!.active!.sessionId]); expect(f.cancellations).not.toContain("owner"); runtime.dispose();
  });

  it("does not start a second writer from another owner", async () => {
    const f = fixture(3); f.hold(); const first = new SerialRuntime(f.adapter); await first.start({ count: 3 });
    await eventually(() => first.snapshot()?.active?.dispatched === true); first.dispose();
    const second = new SerialRuntime({ ...f.adapter, ownerSessionId: "another" }); await second.restore();
    await expect(second.resume()).rejects.toThrow("另一个 DSH 会话");
    await expect(second.start({ count: 3 })).rejects.toThrow("已有连载任务");
    expect(f.requests).toHaveLength(1); second.dispose();
  });

  it("automatically retries a failed model five times before blocking", async () => {
    const f = fixture(1);
    f.adapter.dispatch = async active => { f.requests.push(active.requestId); f.state({ running: false, pendingInput: false, lastTurnError: "network unavailable", lastTurnReason: "error" }); };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    expect(f.requests).toHaveLength(6);
    expect(new Set(f.requests).size).toBe(6);
    await expect(runtime.resume()).rejects.toThrow("重试上限"); runtime.dispose();
  });

  it("waits for its own accepted queued request without duplicate dispatch", async () => {
    const f = fixture(1); f.hold(); const runtime = new SerialRuntime(f.adapter);
    await runtime.start({ count: 1 }); await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    f.state({ running: false, pendingInput: false, ownQueued: true, requestKnown: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runtime.snapshot()?.status).toBe("running"); expect(f.requests).toHaveLength(1);
    await runtime.pause();
    f.finish(); await eventually(() => runtime.snapshot()?.status === "completed"); runtime.dispose();
  });

  it("stops its isolated child after foreign parent input without cancelling the parent", async () => {
    const f = fixture(3); f.hold(); let cancellations = 0;
    f.adapter.cancel = async active => { expect(active.sessionId).not.toBe("owner"); cancellations += 1; };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 3 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    f.state({ running: true, pendingInput: false, externalInput: true });
    await eventually(() => runtime.snapshot()?.status === "paused");
    expect((await runtime.stop()).status).toBe("stopped"); expect(cancellations).toBe(2); expect((await f.adapter.state()).running).toBe(true); runtime.dispose();
  });

  it("preserves a stopped failed draft's task identity and resumes only on an explicit command", async () => {
    const f = fixture(1); f.hold(); const first = new SerialRuntime(f.adapter);
    await first.start({ count: 1 }); await eventually(() => first.snapshot()?.active?.dispatched === true);
    await first.pause(); f.partial.add(1); f.repairable.add(1);
    f.state({ running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true });
    await eventually(() => first.snapshot()?.status === "paused");
    const originalId = first.snapshot()!.id;
    await first.stop(); expect(first.snapshot()?.status).toBe("stopped");
    await expect(first.start({ count: 1 })).rejects.toThrow("恢复这批");
    expect(first.snapshot()?.id).toBe(originalId); expect(f.requests).toHaveLength(1);
    first.dispose();
    const recovered = new SerialRuntime(f.adapter); await recovered.restore();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(recovered.snapshot()?.status).toBe("stopped"); expect(f.requests).toHaveLength(1);
    f.auto(); await recovered.resume(); await eventually(() => recovered.snapshot()?.status === "completed");
    expect(recovered.snapshot()?.id).toBe(originalId); expect(recovered.snapshot()?.targetChapter).toBe(1);
    expect(recovered.snapshot()?.attempts["1"]).toBe(2); expect(f.backups).toHaveLength(1); recovered.dispose();
  });

  it("retries a failed native cancellation even though the task is already marked stopped", async () => {
    const f = fixture(1); f.hold(); const runtime = new SerialRuntime(f.adapter);
    await runtime.start({ count: 1 }); await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    const originalId = runtime.snapshot()!.id; let calls = 0;
    f.adapter.cancel = async active => {
      expect(active.sessionId).not.toBe("owner"); calls += 1;
      if (calls === 1) throw new Error("cancel unavailable");
      f.state({ running: false, pendingInput: false, lastTurnReason: "aborted", requestKnown: true });
    };
    await expect(runtime.stop()).rejects.toThrow("cancel unavailable");
    expect(runtime.snapshot()?.status).toBe("stopped"); expect(runtime.snapshot()?.error).toContain("停止请求尚未完成");
    await expect(runtime.start({ count: 1 })).rejects.toThrow("正在处理其他工作");
    await runtime.stop(); expect(calls).toBe(2); expect(runtime.snapshot()?.error).toBeUndefined();
    await runtime.stop(); expect(calls).toBe(2); expect(runtime.snapshot()?.id).toBe(originalId); runtime.dispose();
  });

  it("can resume an owned draft after stopping an in-flight repair without changing batches", async () => {
    const f = fixture(1); f.hold();
    const nativeState = f.adapter.state;
    f.adapter.state = async active => active !== undefined && active.requestId !== "" && !f.childIds.includes(active.sessionId)
      ? { running: false, pendingInput: false, requestKnown: false } : nativeState(active);
    const runtime = new SerialRuntime(f.adapter);
    await runtime.start({ count: 1 }); await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    await runtime.pause(); f.partial.add(1); f.repairable.add(1);
    f.state({ running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true });
    await eventually(() => runtime.snapshot()?.status === "paused");
    const id = runtime.snapshot()!.id;
    await runtime.resume(); await eventually(() => runtime.snapshot()?.active?.attempt === 2 && runtime.snapshot()?.active?.dispatched === true);
    await runtime.stop(); expect(runtime.snapshot()?.status).toBe("stopped");
    f.auto(); await runtime.resume(); await eventually(() => runtime.snapshot()?.status === "completed");
    expect(runtime.snapshot()?.id).toBe(id); expect(runtime.snapshot()?.attempts["1"]).toBe(3);
    expect(f.backups.map(item => item.attempt)).toEqual([2, 3]); runtime.dispose();
  });

  it("rejects a non-completed native turn even with valid prose receipts", async () => {
    const f = fixture(3); f.hold(); const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 3 });
    await eventually(() => runtime.snapshot()?.active?.dispatched === true);
    f.complete.add(1); f.state({ running: false, pendingInput: false, lastTurnReason: "max-tokens" });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    expect(runtime.snapshot()?.completed).toEqual([]); expect(f.requests).toHaveLength(1); runtime.dispose();
  });

  it("backs up generated unaccepted prose before a fresh automatic repair succeeds", async () => {
    const f = fixture(1); const dispatches: SerialActive[] = [];
    f.adapter.dispatch = async (active, prompt) => {
      dispatches.push(structuredClone(active));
      if (active.attempt === 1) { f.partial.add(1); f.repairable.add(1); }
      else {
        expect(f.backups).toHaveLength(1); expect(active.backupPath).toBe(f.backups[0]!.path);
        expect(prompt).toContain(f.backups[0]!.path); expect(prompt).toContain("tracking incomplete");
        f.complete.add(1);
      }
      f.state({ running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true });
    };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.status === "completed");
    expect(dispatches).toHaveLength(2); expect(dispatches[0]!.sessionId).not.toBe(dispatches[1]!.sessionId);
    expect(runtime.snapshot()?.completedSessions["1"]).toBe(dispatches[1]!.sessionId);
    expect(f.backups[0]!.attempt).toBe(2); runtime.dispose();
  });

  it("stops after five backed-up quality repairs and preserves the last draft", async () => {
    const f = fixture(1); const dispatches: SerialActive[] = [];
    f.adapter.dispatch = async active => {
      dispatches.push(structuredClone(active)); f.partial.add(1); f.repairable.add(1);
      if (active.attempt > 1) expect(f.backups.some(backup => backup.attempt === active.attempt)).toBe(true);
      f.state({ running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true });
    };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    expect(dispatches).toHaveLength(6); expect(new Set(dispatches.map(active => active.sessionId)).size).toBe(6);
    expect(f.backups.map(backup => backup.attempt)).toEqual([2, 3, 4, 5, 6]); expect(f.partial.has(1)).toBe(true);
    expect(runtime.snapshot()?.completed).toEqual([]); await expect(runtime.resume()).rejects.toThrow("重试上限"); runtime.dispose();
  });

  it("adds one bounded quality-repair window only for an explicit retry while preserving every attempt", async () => {
    const f = fixture(1); const dispatches: SerialActive[] = [];
    f.adapter.dispatch = async active => {
      dispatches.push(structuredClone(active)); f.partial.add(1); f.repairable.add(1);
      f.state({ running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true });
    };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1, maxAttempts: 3 });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    const taskId = runtime.snapshot()!.id; const originalChildren = dispatches.map(item => item.sessionId);
    expect(dispatches.map(item => item.attempt)).toEqual([1, 2, 3]);
    await expect(runtime.resume()).rejects.toThrow("重试上限");
    await new Promise(resolve => setTimeout(resolve, 10)); expect(dispatches).toHaveLength(3);
    await runtime.resume({ allowRetryWindow: true });
    await eventually(() => runtime.snapshot()?.status === "blocked" && runtime.snapshot()?.attempts["1"] === 6);
    expect(runtime.snapshot()?.id).toBe(taskId); expect(runtime.snapshot()?.attemptLimits?.["1"]).toBe(6);
    expect(dispatches.map(item => item.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(dispatches.slice(0, 3).map(item => item.sessionId)).toEqual(originalChildren);
    expect(new Set(dispatches.map(item => item.sessionId)).size).toBe(6);
    expect(new Set(f.backups.map(item => item.path)).size).toBe(5);
    expect(f.backups.map(item => item.attempt)).toEqual([2, 3, 4, 5, 6]);
    assertSerialTask(f.disk());
    await expect(runtime.resume()).rejects.toThrow("重试上限");
    await new Promise(resolve => setTimeout(resolve, 10)); expect(dispatches).toHaveLength(6);
    runtime.dispose();
  });

  it("does not repair prose that existed before this task dispatched a chapter", async () => {
    const f = fixture(1); f.partial.add(1); f.repairable.add(1);
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    expect(f.requests).toHaveLength(0); expect(f.backups).toHaveLength(0); runtime.dispose();
  });

  it("keeps an undispatched reservation after restart without consuming another attempt", async () => {
    const f = fixture(1); f.hold(); const first = new SerialRuntime(f.adapter);
    await first.start({ count: 1 }); await eventually(() => first.snapshot()?.active?.dispatched === true); first.dispose();
    const saved = f.disk()!; const identity = saved.active!.sessionId; const requestId = saved.active!.requestId;
    saved.active!.dispatched = false; f.setDisk(saved); f.requests.splice(0); f.childIds.splice(0);
    f.state({ running: false, pendingInput: false, requestKnown: false }); f.auto();
    const recovered = new SerialRuntime(f.adapter); await recovered.restore(); await recovered.resume();
    await eventually(() => recovered.snapshot()?.status === "completed");
    expect(f.requests).toEqual([requestId]); expect(f.childIds).toEqual([identity]);
    expect(recovered.snapshot()?.attempts["1"]).toBe(1); recovered.dispose();
  });

  it("does not call the repair model when its backup cannot be persisted", async () => {
    const f = fixture(1); let calls = 0;
    f.adapter.dispatch = async () => { calls += 1; f.partial.add(1); f.repairable.add(1); f.state({ running: false, pendingInput: false, lastTurnReason: "completed", requestKnown: true }); };
    f.adapter.prepareRepair = async () => { throw new Error("backup write denied"); };
    const runtime = new SerialRuntime(f.adapter); await runtime.start({ count: 1 });
    await eventually(() => runtime.snapshot()?.status === "blocked");
    expect(calls).toBe(1); expect(runtime.snapshot()?.active?.dispatched).toBe(false); expect(runtime.snapshot()?.error).toContain("backup write denied"); runtime.dispose();
  });

  it("rejects corrupt progress and insufficient outline coverage", async () => {
    const f = fixture(3); const runtime = new SerialRuntime(f.adapter);
    await expect(runtime.start({ count: 50 })).rejects.toThrow("只有 3 章");
    expect(() => assertSerialTask({ schemaVersion: 1, nextChapter: 50, completed: [1] })).toThrow("损坏"); runtime.dispose();
  });
});
