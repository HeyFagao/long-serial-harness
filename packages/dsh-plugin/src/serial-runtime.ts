import { buildSerialChapterPrompt } from "./serial-outline.js";

export type SerialStatus = "running" | "pausing" | "paused" | "blocked" | "stopped" | "completed";
export interface SerialActive {
  chapter: number;
  sessionId: string;
  requestId: string;
  attempt: number;
  dispatched: boolean;
  baselineSeq?: number;
  repairIssues?: string[];
  backupPath?: string;
}
export interface SerialTask {
  schemaVersion: 1;
  id: string;
  ownerSessionId: string;
  cwd: string;
  status: SerialStatus;
  startChapter: number;
  targetChapter: number;
  nextChapter: number;
  completed: number[];
  completedSessions: Record<string, string>;
  attempts: Record<string, number>;
  /** Absolute attempt ceilings; only an explicit human retry may extend one chapter's window. */
  attemptLimits?: Record<string, number>;
  active?: SerialActive;
  error?: string;
  updatedAt: string;
  maxAttempts: number;
  minChars?: number;
  maxChars?: number;
  style?: string;
  divergence?: number;
  observedSeq?: number;
}
export interface SerialStartOptions {
  count: number | "all";
  startChapter?: number;
  maxAttempts?: number;
  minChars?: number;
  maxChars?: number;
  style?: string;
  divergence?: number;
}
export interface SerialObservation {
  running: boolean;
  pendingInput: boolean;
  ownQueued?: boolean;
  cursor?: number;
  lastTurnError?: string;
  lastTurnReason?: string;
  externalInput?: boolean;
  requestKnown?: boolean;
  /** Only the terminal assistant text, never reasoning, tool output or a partial stream. */
  finalText?: string;
}
export interface SerialResumeOptions {
  /** User-facing retry only. Background recovery must leave this false. */
  readonly allowRetryWindow?: boolean;
}
export interface SerialAdapter {
  ownerSessionId: string;
  cwd: string;
  load(): Promise<SerialTask | null>;
  /** A native filesystem compare-and-swap; reject when another writer owns the manifest. */
  save(task: SerialTask): Promise<void>;
  plan(): Promise<{ nextChapter: number; chapters: readonly number[] }>;
  inspect(chapter: number, minChars?: number, maxChars?: number): Promise<{ ok: boolean; issues: string[]; proseExists: boolean; repairable?: boolean }>;
  /** Create-only, idempotent backup of this unaccepted chapter before a repair can be dispatched. */
  prepareRepair(chapter: number, attempt: number, issues: readonly string[]): Promise<string>;
  state(active?: SerialActive): Promise<SerialObservation>;
  /** Persist a completed plain-text chapter through the host before accepting its receipt. */
  finalize?(active: SerialActive, observation: SerialObservation): Promise<void>;
  dispatch(active: SerialActive, prompt: string): Promise<void>;
  cancel(active: SerialActive): Promise<void>;
  makeId(): string;
  now(): string;
  pollMs?: number;
}

const RUNNING: ReadonlySet<SerialStatus> = new Set(["running", "pausing"]);
const CANCELLED = new Set(["cancelled", "canceled", "user", "disposed", "rejected", "interrupted", "aborted"]);
function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function clone(task: SerialTask): SerialTask { return structuredClone(task); }
function attemptLimit(task: SerialTask, chapter: number): number { return task.attemptLimits?.[String(chapter)] ?? task.maxAttempts; }

/** A host-owned, one-chapter-at-a-time controller. DSH owns every model turn and approval. */
export class SerialRuntime {
  private task: SerialTask | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private driving = false;
  private disposed = false;
  private wake: (() => void) | undefined;

  constructor(private readonly adapter: SerialAdapter) {}

  snapshot(): SerialTask | null { return this.task === null ? null : clone(this.task); }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.serial.then(work, work);
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  private owned(): SerialTask {
    if (this.task === null) throw new Error("还没有连载任务，请先导入大纲并开始。");
    if (this.task.ownerSessionId !== this.adapter.ownerSessionId) {
      throw new Error("这本书的连载任务属于另一个 DSH 会话。请回到原会话管理，避免两个会话同时写书。");
    }
    return this.task;
  }

  private async commit(next: SerialTask): Promise<void> {
    next.updatedAt = this.adapter.now();
    await this.adapter.save(clone(next));
    this.task = next;
  }

  async restore(): Promise<SerialTask | null> {
    await this.locked(async () => {
      if (this.task !== null) return;
      this.task = await this.adapter.load();
      if (this.task !== null) {
        assertSerialTask(this.task);
        if (this.task.ownerSessionId === this.adapter.ownerSessionId && RUNNING.has(this.task.status)) {
          const next = clone(this.task);
          next.status = "paused";
          next.error = "上次连载被中断。已保留进度，请点继续；续跑前会核验正文与追踪。";
          await this.commit(next);
        }
      }
    });
    this.kick();
    return this.snapshot();
  }

  async start(options: SerialStartOptions): Promise<SerialTask> {
    await this.locked(async () => {
      this.task ??= await this.adapter.load();
      if (this.task !== null) assertSerialTask(this.task);
      if (this.task !== null && RUNNING.has(this.task.status)) throw new Error("已有连载任务正在进行，请先暂停或停止。");
      if (this.task !== null && this.task.status !== "completed" && this.task.status !== "stopped") {
        this.owned();
        throw new Error("还有未完成的连载任务，请用继续，或先停止旧任务再新建。");
      }
      // A stopped task may still own an unaccepted draft or an unfinished cancel.
      // Keep its identity available for explicit recovery instead of orphaning it.
      const stoppedActive = this.task?.status === "stopped" ? this.task.active : undefined;
      const observation = await this.adapter.state(stoppedActive);
      if (observation.running || observation.pendingInput || observation.ownQueued === true || observation.externalInput) throw new Error("当前 DSH 会话正在处理其他工作或等待输入，请先完成它。");
      if (stoppedActive !== undefined) {
        const inspected = await this.adapter.inspect(stoppedActive.chapter, this.task?.minChars, this.task?.maxChars);
        if (inspected.proseExists && !inspected.ok) throw new Error("已停止的原批次仍有未验收稿件。请点击「恢复这批」保留原任务身份继续修订，不能新建批次接管或覆盖现稿。");
      }
      const plan = await this.adapter.plan();
      const start = options.startChapter ?? plan.nextChapter;
      if (!Number.isSafeInteger(start) || start < 1 || start !== plan.nextChapter) {
        throw new Error(`应从已提交进度的下一章第 ${String(plan.nextChapter)} 章开始，不能跳章或覆盖正文。`);
      }
      const available = new Set(plan.chapters);
      let contiguous = 0;
      while (available.has(start + contiguous)) contiguous += 1;
      const count = options.count === "all" ? contiguous : options.count;
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error("本批章节数必须为 1–1000，或选择写完已导入的连续大纲。");
      if (count > contiguous) throw new Error(`从第 ${String(start)} 章起只有 ${String(contiguous)} 章连续细纲，请先补齐本批大纲。`);
      const maxAttempts = options.maxAttempts ?? 3;
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("重试次数必须为 1–3。");
      if ((options.minChars === undefined) !== (options.maxChars === undefined)) throw new Error("自定义字数范围需要同时填写最少和最多字数，也可以全部留空使用原有细纲设置。");
      for (const value of [options.minChars, options.maxChars]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 500 || value > 20000)) throw new Error("每章字数范围必须为 500–20000 的整数。");
      }
      if (options.minChars !== undefined && options.maxChars !== undefined && options.minChars > options.maxChars) throw new Error("最少字数不能大于最多字数。");
      if (options.style !== undefined && (typeof options.style !== "string" || options.style.length > 4000)) throw new Error("风格要求不能超过 4000 字。");
      if (options.divergence !== undefined && (!Number.isInteger(options.divergence) || options.divergence < 0 || options.divergence > 2)) throw new Error("批量生成的发散等级必须为 0–2；等级 3 仅讨论，不生成正文。");
      const next: SerialTask = {
        schemaVersion: 1, id: this.adapter.makeId(), ownerSessionId: this.adapter.ownerSessionId,
        cwd: this.adapter.cwd, status: "running", startChapter: start, targetChapter: start + count - 1,
        nextChapter: start, completed: [], completedSessions: {}, attempts: {}, attemptLimits: {}, updatedAt: this.adapter.now(), maxAttempts,
        minChars: options.minChars ?? 2300,
        maxChars: options.maxChars ?? 2500,
        divergence: options.divergence ?? 0,
        ...(options.style === undefined ? {} : { style: options.style }),
        ...(observation.cursor === undefined ? {} : { observedSeq: observation.cursor })
      };
      await this.commit(next);
    });
    this.kick();
    return this.snapshot()!;
  }

  async pause(): Promise<SerialTask> {
    await this.locked(async () => {
      const next = clone(this.owned());
      if (!RUNNING.has(next.status)) return;
      next.status = next.active === undefined ? "paused" : "pausing";
      delete next.error;
      await this.commit(next);
    });
    this.wake?.();
    return this.snapshot()!;
  }

  async resume(options: SerialResumeOptions = {}): Promise<SerialTask> {
    await this.locked(async () => {
      const next = clone(this.owned());
      if (next.status === "completed") throw new Error("这批任务已经完成，请新建下一批。");
      if (RUNNING.has(next.status)) return;
      const observation = await this.adapter.state(next.active);
      if (observation.running || observation.pendingInput || observation.ownQueued === true) throw new Error("当前章节仍在运行或等待原生审批，请先在右侧对话中处理。");
      if (next.active !== undefined) {
        if (observation.lastTurnReason === "completed" && !observation.externalInput) await this.adapter.finalize?.(next.active, observation);
        const inspected = await this.adapter.inspect(next.active.chapter, next.minChars, next.maxChars);
        if (inspected.ok) this.acceptChapter(next);
        else if (!next.active.dispatched && observation.requestKnown !== true) {
          // The process may have stopped before any model admission. Keep that reserved child and attempt.
          if (observation.cursor !== undefined) next.active.baselineSeq = observation.cursor;
          if (inspected.proseExists && next.active.repairIssues === undefined) throw new Error("本章出现了非本轮生成的正文，请先核对并提交追踪，不会覆盖现稿。");
        }
        else if (inspected.proseExists) {
          const cancelledOwnedRepair = next.status === "stopped" && next.active.repairIssues !== undefined
            && observation.lastTurnReason !== undefined && CANCELLED.has(observation.lastTurnReason);
          if ((observation.lastTurnReason !== "completed" && !cancelledOwnedRepair) || inspected.repairable !== true) {
            throw new Error("本章已有未通过验收的正文。请在原生对话中处理具体阻塞并提交追踪，再点继续；不会覆盖或丢弃现稿。");
          }
          this.allowExplicitRetryWindow(next, options);
          next.active = this.reserveAttempt(next, observation, inspected.issues);
        } else {
          this.allowExplicitRetryWindow(next, options);
          if ((next.attempts[String(next.active.chapter)] ?? 0) >= attemptLimit(next, next.active.chapter)) {
            throw new Error("本章已达到本轮重试上限。请显式点击「重试并继续」，为当前章追加一轮有限重试。");
          }
          delete next.active;
        }
      }
      next.status = next.nextChapter > next.targetChapter ? "completed" : "running";
      if (observation.cursor !== undefined) next.observedSeq = observation.cursor;
      delete next.error;
      await this.commit(next);
    });
    this.kick();
    return this.snapshot()!;
  }

  private allowExplicitRetryWindow(task: SerialTask, options: SerialResumeOptions): void {
    const used = task.attempts[String(task.nextChapter)] ?? 0;
    if (!options.allowRetryWindow || used < attemptLimit(task, task.nextChapter)) return;
    const ceiling = used + task.maxAttempts;
    if (!Number.isSafeInteger(ceiling)) throw new Error("本章重试计数超出安全范围，请保留记录后处理。");
    task.attemptLimits ??= {};
    task.attemptLimits[String(task.nextChapter)] = ceiling;
  }

  private reserveAttempt(task: SerialTask, observation: SerialObservation, repairIssues?: readonly string[]): SerialActive {
    const attempt = (task.attempts[String(task.nextChapter)] ?? 0) + 1;
    if (attempt > attemptLimit(task, task.nextChapter)) throw new Error("本章已达到本轮重试上限。正文与备份已保留；点击「重试并继续」可为本章追加一轮有限修订。");
    task.attempts[String(task.nextChapter)] = attempt;
    return {
      chapter: task.nextChapter, sessionId: this.adapter.makeId(), requestId: this.adapter.makeId(), attempt, dispatched: false,
      ...(observation.cursor === undefined ? {} : { baselineSeq: observation.cursor }),
      ...(repairIssues === undefined ? {} : { repairIssues: [...repairIssues] })
    };
  }

  private acceptChapter(task: SerialTask): void {
    const chapter = task.nextChapter;
    if (!task.completed.includes(chapter)) task.completed.push(chapter);
    if (task.active !== undefined) task.completedSessions[String(chapter)] = task.active.sessionId;
    task.nextChapter += 1;
    delete task.active;
    delete task.error;
  }

  async stop(): Promise<SerialTask> {
    let activeToCancel: SerialActive | undefined;
    let stoppedTaskId: string | undefined;
    await this.locked(async () => {
      const next = clone(this.owned());
      if (next.status === "completed") return;
      stoppedTaskId = next.id;
      if (next.active !== undefined) {
        const observation = await this.adapter.state(next.active);
        const isolated = next.active.sessionId !== next.ownerSessionId;
        if (observation.ownQueued === true || ((isolated || (RUNNING.has(next.status) && !observation.externalInput))
          && (observation.running || (observation.pendingInput && observation.requestKnown === true)))) activeToCancel = next.active;
      }
      if (next.status !== "stopped") {
        next.status = "stopped";
        delete next.error;
        await this.commit(next);
      } else if (activeToCancel === undefined && next.error?.startsWith("停止请求尚未完成：")) {
        delete next.error;
        await this.commit(next);
      }
    });
    this.wake?.();
    if (activeToCancel !== undefined) {
      try { await this.adapter.cancel(activeToCancel); }
      catch (error) {
        await this.locked(async () => {
          if (this.task === null || this.task.id !== stoppedTaskId || this.task.status !== "stopped" || this.task.active?.requestId !== activeToCancel?.requestId) return;
          const next = clone(this.task);
          next.error = `停止请求尚未完成：${describe(error)}。请再次点击停止重试；不会派发下一章。`;
          await this.commit(next);
        });
        throw error;
      }
      await this.locked(async () => {
        if (this.task === null || this.task.id !== stoppedTaskId || this.task.status !== "stopped" || !this.task.error?.startsWith("停止请求尚未完成：")) return;
        const next = clone(this.task); delete next.error; await this.commit(next);
      });
    }
    return this.snapshot()!;
  }

  dispose(): void {
    this.disposed = true;
    this.wake?.();
  }

  private kick(): void {
    if (this.disposed || this.driving || this.task === null || !RUNNING.has(this.task.status)
      || this.task.ownerSessionId !== this.adapter.ownerSessionId) return;
    this.driving = true;
    void this.drive().finally(() => {
      this.driving = false;
      if (!this.disposed && this.task !== null && RUNNING.has(this.task.status)) this.kick();
    });
  }

  private async delay(): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); this.wake = undefined; resolve(); };
      const timer = setTimeout(done, this.adapter.pollMs ?? 1000);
      this.wake = done;
    });
  }

  private async block(message: string, status: "blocked" | "paused" = "blocked", expectedId?: string): Promise<void> {
    await this.locked(async () => {
      if (this.task === null || !RUNNING.has(this.task.status) || (expectedId !== undefined && this.task.id !== expectedId)) return;
      const next = clone(this.task);
      next.status = status;
      next.error = message;
      await this.commit(next);
    });
  }

  private async drive(): Promise<void> {
    let operationTaskId: string | undefined;
    try {
      while (!this.disposed && this.task !== null && RUNNING.has(this.task.status)) {
        const current = this.snapshot()!;
        operationTaskId = current.id;
        const observation = await this.adapter.state(current.active ?? (current.observedSeq === undefined ? undefined : {
          chapter: current.nextChapter, sessionId: current.ownerSessionId, requestId: "", attempt: 0, dispatched: false, baselineSeq: current.observedSeq
        }));
        if (observation.externalInput) {
          await this.block("检测到你在原生对话中插入了其他工作，连载已暂停。处理完后点继续。", "paused", current.id);
          if (current.active !== undefined && current.active.sessionId !== current.ownerSessionId
            && (observation.running || observation.pendingInput || observation.ownQueued === true || observation.requestKnown === true)) {
            await this.adapter.cancel(current.active);
          }
          return;
        }
        if (observation.pendingInput || observation.running || observation.ownQueued === true) { await this.delay(); continue; }
        if (current.active !== undefined && observation.lastTurnReason !== undefined && CANCELLED.has(observation.lastTurnReason)) {
          await this.block("原生会话的这一轮已停止，连载也已暂停。确认当前章节后再继续。", "paused", current.id);
          return;
        }
        if (current.active?.dispatched === true && observation.lastTurnReason !== "completed") {
          await this.block(`原生写作轮次未正常完成（${observation.lastTurnReason ?? "缺少本轮完成回执"}）${observation.lastTurnError === undefined ? "" : `：${observation.lastTurnError}`}。请处理后继续。`, "blocked", current.id);
          return;
        }
        if (current.active?.dispatched === true && observation.lastTurnReason === "completed") {
          // Serialize settlement with stop/pause; the host owns all manuscript writes.
          await this.locked(async () => {
            if (this.task === null || !RUNNING.has(this.task.status) || this.task.id !== current.id || this.task.active?.requestId !== current.active?.requestId) return;
            await this.adapter.finalize?.(current.active!, observation);
          });
        }
        const result = await this.adapter.inspect(current.nextChapter, current.minChars, current.maxChars);
        if (result.ok) {
          await this.locked(async () => {
            if (this.task === null || !RUNNING.has(this.task.status) || this.task.id !== current.id || this.task.nextChapter !== current.nextChapter) return;
            const next = clone(this.task);
            this.acceptChapter(next);
            if (observation.cursor !== undefined) next.observedSeq = observation.cursor;
            if (next.nextChapter > next.targetChapter) next.status = "completed";
            else if (next.status === "pausing") next.status = "paused";
            await this.commit(next);
          });
          continue;
        }
        const preparedRepair = current.active !== undefined && !current.active.dispatched && current.active.repairIssues !== undefined;
        if (result.proseExists && !preparedRepair) {
          if (current.status === "pausing") { await this.block("当前章节尚需修复，已按要求暂停；现稿与进度都已保留。", "paused", current.id); return; }
          if (current.active?.dispatched === true && observation.lastTurnReason === "completed" && result.repairable === true && current.active.attempt < attemptLimit(current, current.nextChapter)) {
            await this.locked(async () => {
              if (this.task === null || this.task.status !== "running" || this.task.id !== current.id || this.task.active?.requestId !== current.active?.requestId) return;
              const next = clone(this.task);
              next.active = this.reserveAttempt(next, observation, result.issues);
              await this.commit(next);
            });
            continue;
          }
          const limit = current.active !== undefined && current.active.attempt >= attemptLimit(current, current.nextChapter) ? "已达到本轮自动修复上限；点击「重试并继续」可追加一轮有限修订；" : "";
          await this.block(`第 ${String(current.nextChapter)} 章已有正文但未通过完整验收：${result.issues.join("；")}。${limit}保留现稿，请在原生会话中处理并提交追踪。`, "blocked", current.id);
          return;
        }
        if (preparedRepair && (!result.proseExists || result.repairable !== true)) {
          await this.block("待修订正文或追踪状态已经改变，停止自动修订以保护稿件。请核对后继续。", "blocked", current.id);
          return;
        }
        if (current.status === "pausing") { await this.block("已在章节边界暂停。", "paused", current.id); return; }
        if (current.active?.dispatched === true) {
          // DSH owns transport retries. A settled failure or missing prose requires an explicit resume.
          await this.block(`第 ${String(current.nextChapter)} 章未提交完成${observation.lastTurnError === undefined ? "，请查看原生写作会话中的处理要求" : `：${observation.lastTurnError}`}。`, "blocked", current.id);
          return;
        }
        let active: SerialActive | undefined;
        await this.locked(async () => {
          if (this.task === null || this.task.status !== "running" || this.task.id !== current.id || this.task.nextChapter !== current.nextChapter) return;
          const next = clone(this.task);
          if (next.active === undefined) {
            next.active = this.reserveAttempt(next, observation);
            await this.commit(next);
          }
          active = next.active;
        });
        if (active === undefined || this.disposed) continue;
        // The persisted request ID is reused if process death occurs before this acknowledgement.
        await this.locked(async () => {
          if (this.disposed || this.task === null || this.task.status !== "running" || this.task.active?.requestId !== active?.requestId) return;
          const admission = await this.adapter.state(active);
          if (admission.externalInput || admission.running || admission.pendingInput || admission.ownQueued === true || (admission.lastTurnReason !== undefined && CANCELLED.has(admission.lastTurnReason))) {
            const paused = clone(this.task);
            paused.status = "paused";
            paused.error = "会话状态已变化，连载已暂停，未插入下一章。";
            await this.commit(paused);
            return;
          }
          if (active!.repairIssues !== undefined) {
            const backupPath = await this.adapter.prepareRepair(active!.chapter, active!.attempt, active!.repairIssues);
            if (backupPath.trim() === "" || (active!.backupPath !== undefined && active!.backupPath !== backupPath)) throw new Error("修订备份路径未通过核验，未调用模型。");
            const backedUp = clone(this.task);
            backedUp.active!.backupPath = backupPath;
            await this.commit(backedUp);
            active = backedUp.active;
          }
          const prompt = buildSerialChapterPrompt({ chapter: active!.chapter,
            ...(current.minChars === undefined ? {} : { minChars: current.minChars }),
            ...(current.maxChars === undefined ? {} : { maxChars: current.maxChars }),
            ...(current.style === undefined ? {} : { style: current.style }),
            ...(current.divergence === undefined ? {} : { divergence: current.divergence }),
            ...(active!.repairIssues === undefined ? {} : { repairIssues: active!.repairIssues })
          }) + (active!.backupPath === undefined ? "" : `\n\n宿主已经将本轮修订前正文原样备份到 ${active!.backupPath}。现稿全文由宿主随本次任务提供；只按原输出格式修订当前未验收章节。`);
          // Serialize admission with stop/pause so neither can acknowledge before a late send.
          await this.adapter.dispatch(active!, prompt);
          const next = clone(this.task);
          next.active!.dispatched = true;
          await this.commit(next);
        });
      }
    } catch (error) {
      try { await this.block(`连载已停止推进：${describe(error)}`, "blocked", operationTaskId); }
      catch {
        // A failed CAS must not be overwritten by a second blind write.
        if (this.task !== null && this.task.id === operationTaskId) { this.task.status = "blocked"; this.task.error = `任务状态未能保存：${describe(error)}`; }
      }
    }
  }
}

/** Reject corrupt manifests instead of guessing a cursor and potentially rewriting a chapter. */
export function assertSerialTask(value: unknown): asserts value is SerialTask {
  if (typeof value !== "object" || value === null) throw new Error("连载任务文件不是有效对象。");
  const task = value as Partial<SerialTask>;
  if (task.schemaVersion !== 1 || typeof task.id !== "string" || typeof task.ownerSessionId !== "string" || typeof task.cwd !== "string"
    || !["running", "pausing", "paused", "blocked", "stopped", "completed"].includes(task.status ?? "")
    || !Number.isSafeInteger(task.startChapter) || !Number.isSafeInteger(task.targetChapter) || !Number.isSafeInteger(task.nextChapter)
    || task.startChapter! < 1 || task.targetChapter! < task.startChapter! || task.nextChapter! < task.startChapter! || task.nextChapter! > task.targetChapter! + 1
    || !Array.isArray(task.completed) || !task.completed.every(Number.isSafeInteger)
    || task.completed.length !== task.nextChapter! - task.startChapter!
    || !task.completed.every((chapter, index) => chapter === task.startChapter! + index)
    || typeof task.completedSessions !== "object" || task.completedSessions === null || Array.isArray(task.completedSessions)
    || !Object.values(task.completedSessions).every(sessionId => typeof sessionId === "string" && sessionId !== task.ownerSessionId)
    || typeof task.attempts !== "object" || task.attempts === null || Array.isArray(task.attempts)
    || !Object.values(task.attempts).every(attempt => Number.isSafeInteger(attempt) && attempt >= 1)
    || (task.attemptLimits !== undefined && (typeof task.attemptLimits !== "object" || task.attemptLimits === null || Array.isArray(task.attemptLimits)
      || !Object.entries(task.attemptLimits).every(([chapter, limit]) => /^\d+$/u.test(chapter) && Number(chapter) >= task.startChapter! && Number(chapter) <= task.targetChapter!
        && Number.isSafeInteger(limit) && limit >= task.maxAttempts!)))
    || !Number.isSafeInteger(task.maxAttempts) || task.maxAttempts! < 1 || task.maxAttempts! > 3
    || typeof task.updatedAt !== "string") throw new Error("连载任务文件损坏或版本不兼容，已停止以保护正文。");
  if (task.active !== undefined && (task.active.chapter !== task.nextChapter || typeof task.active.sessionId !== "string" || task.active.sessionId === "" || task.active.sessionId === task.ownerSessionId
    || typeof task.active.requestId !== "string" || typeof task.active.dispatched !== "boolean"
    || (task.active.repairIssues !== undefined && (!Array.isArray(task.active.repairIssues) || !task.active.repairIssues.every(issue => typeof issue === "string")))
    || (task.active.backupPath !== undefined && (typeof task.active.backupPath !== "string" || task.active.repairIssues === undefined))
    || !Number.isSafeInteger(task.active.attempt) || task.active.attempt < 1 || task.active.attempt > attemptLimit(task as SerialTask, task.active.chapter))) {
    throw new Error("连载任务的在途章节状态不一致，已停止以保护正文。");
  }
}
