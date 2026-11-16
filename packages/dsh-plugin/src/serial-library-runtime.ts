import type { SerialResumeOptions, SerialStartOptions, SerialTask } from "./serial-runtime.js";

export type LibraryCount = 10 | 20 | "all";
export type LibraryStatus = "running" | "pausing" | "paused" | "blocked" | "stopped" | "completed";
export interface LibraryQueueBook {
  id: string;
  title: string;
  absolutePath: string;
  ownerSessionId: string;
  startChapter: number;
  targetChapter: number;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  completedChapters: number;
  serialTaskId?: string;
  retryRequested?: boolean;
  error?: string;
}
export interface LibraryTask {
  schemaVersion: 1;
  id: string;
  ownerSessionId: string;
  cwd: string;
  status: LibraryStatus;
  count: LibraryCount;
  books: LibraryQueueBook[];
  activeBookId?: string;
  error?: string;
  updatedAt: string;
  ownerContext: unknown;
  generation: Omit<SerialStartOptions, "count" | "startChapter">;
}
export interface LibraryBookController {
  snapshot(): SerialTask | null;
  start(options: SerialStartOptions): Promise<SerialTask>;
  resume(options?: SerialResumeOptions): Promise<SerialTask>;
  pause(): Promise<SerialTask>;
  stop(): Promise<SerialTask>;
}
export interface LibraryQueueAdapter {
  ownerSessionId: string;
  cwd: string;
  load(): Promise<LibraryTask | null>;
  save(task: LibraryTask): Promise<void>;
  captureContext(): Promise<unknown>;
  plan(): Promise<readonly { id: string; title: string; absolutePath: string; nextChapter: number; lastChapter: number; error?: string }[]>;
  controller(book: LibraryQueueBook, task: LibraryTask): Promise<LibraryBookController>;
  makeId(): string;
  now(): string;
  pollMs?: number;
}

const ACTIVE: ReadonlySet<LibraryStatus> = new Set(["running", "pausing"]);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const copy = <T>(value: T): T => structuredClone(value);

/** Shared provider failures must not trigger the same paid/auth request in every book. */
export function isSharedLibraryFailure(error: string): boolean {
  return /(?:\b(?:401|403|429|5\d\d)\b|no_subscription|insufficient[_ -]?(?:quota|balance|credit)|rate[_ -]?limit|authentication|unauthorized|permission[_ -]?denied|billing|network|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timeout|timed out|api.?key|credentials?|鉴权|订阅|余额|额度|计费|网络|连接|超时|权限|审批|密钥|提供商|模型.*(?:不可用|不存在|缺失))/iu.test(error);
}

export function assertLibraryTask(value: unknown): asserts value is LibraryTask {
  if (typeof value !== "object" || value === null) throw new Error("书库任务记录无效。");
  const task = value as LibraryTask;
  if (task.schemaVersion !== 1 || typeof task.id !== "string" || typeof task.ownerSessionId !== "string" || typeof task.cwd !== "string"
    || !["running", "pausing", "paused", "blocked", "stopped", "completed"].includes(task.status)
    || ![10, 20, "all"].includes(task.count) || !Array.isArray(task.books) || task.books.length > 1000
    || typeof task.generation !== "object" || task.generation === null) throw new Error("书库任务记录格式无效，请保留原文件后处理。");
  const ids = new Set<string>();
  for (const book of task.books) {
    if (typeof book.id !== "string" || ids.has(book.id) || typeof book.title !== "string" || typeof book.absolutePath !== "string" || typeof book.ownerSessionId !== "string"
      || !Number.isSafeInteger(book.startChapter) || book.startChapter < 1 || !Number.isSafeInteger(book.targetChapter) || book.targetChapter < book.startChapter - 1
      || !Number.isSafeInteger(book.completedChapters) || book.completedChapters < 0
      || !["pending", "running", "completed", "failed", "skipped"].includes(book.status)) throw new Error("书库章节范围或项目身份无效，未继续生成。");
    ids.add(book.id);
  }
}

/** Durable host-owned queue. Targets are fixed once: retries never add another ten chapters. */
export class SerialLibraryRuntime {
  private task: LibraryTask | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private driving = false;
  private disposed = false;
  private wake: (() => void) | undefined;
  private readonly controllers = new Map<string, LibraryBookController>();
  constructor(private readonly adapter: LibraryQueueAdapter) {}
  snapshot(): LibraryTask | null { return this.task === null ? null : copy(this.task); }
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.serial.then(work, work);
    this.serial = pending.catch(() => undefined);
    return pending;
  }
  private owned(): LibraryTask {
    if (this.task === null) throw new Error("还没有书库批量任务。");
    if (this.task.ownerSessionId !== this.adapter.ownerSessionId) throw new Error("请回到启动本批的书库会话控制任务。");
    return this.task;
  }
  private async commit(task: LibraryTask): Promise<void> {
    task.updatedAt = this.adapter.now();
    await this.adapter.save(copy(task));
    this.task = task;
  }
  /** Cancellation uses the already admitted controller even when access/config validation now fails. */
  private async stopReservedBook(book: LibraryQueueBook | undefined, task: LibraryTask): Promise<void> {
    if (book === undefined) return;
    let controller = this.controllers.get(book.ownerSessionId);
    if (controller === undefined) {
      if (book.serialTaskId === undefined) return;
      controller = await this.adapter.controller(book, task);
      this.controllers.set(book.ownerSessionId, controller);
    }
    const serial = controller.snapshot();
    if (serial === null) return;
    const own = book.serialTaskId === undefined
      ? serial.ownerSessionId === book.ownerSessionId && serial.startChapter === book.startChapter && serial.targetChapter === book.targetChapter
      : serial.id === book.serialTaskId;
    if (!own) throw new Error("当前小说批次身份已经变化，无法确认本批章节已停止，请查看原会话。");
    if (serial.status !== "completed") await controller.stop();
  }
  async restore(): Promise<LibraryTask | null> {
    await this.locked(async () => {
      if (this.task !== null) return;
      this.task = await this.adapter.load();
      if (this.task === null) return;
      assertLibraryTask(this.task);
      if (this.task.cwd !== this.adapter.cwd) throw new Error("书库目录已变化，请在原目录恢复。");
      if (this.task.ownerSessionId === this.adapter.ownerSessionId && ACTIVE.has(this.task.status)) {
        const next = copy(this.task);
        next.status = "paused";
        next.error = "上次书库任务被中断，进度已保留。点击继续后核对各书记录再接续。";
        await this.commit(next);
      }
    });
    return this.snapshot();
  }
  async start(count: LibraryCount, generation: LibraryTask["generation"] = {}): Promise<LibraryTask> {
    await this.locked(async () => {
      if (![10, 20, "all"].includes(count)) throw new Error("书库批量仅支持新增 10 章、20 章或写至完本。");
      this.task ??= await this.adapter.load();
      if (this.task !== null) {
        assertLibraryTask(this.task);
        if (! ["completed", "stopped"].includes(this.task.status)) throw new Error("已有未完成的书库批次，请继续或停止后再新建。");
      }
      const ownerContext = await this.adapter.captureContext();
      const plans = await this.adapter.plan();
      if (plans.length === 0) throw new Error("书库还没有小说项目，请先批量导入最终输出。");
      const books: LibraryQueueBook[] = plans.map(book => ({
        id: book.id, title: book.title, absolutePath: book.absolutePath, ownerSessionId: this.adapter.makeId(),
        startChapter: book.nextChapter, targetChapter: count === "all" ? book.lastChapter : Math.min(book.lastChapter, book.nextChapter + count - 1),
        status: book.error !== undefined ? "failed" : book.nextChapter > book.lastChapter ? "skipped" : "pending", completedChapters: 0,
        ...(book.error === undefined ? {} : { error: book.error })
      }));
      await this.commit({ schemaVersion: 1, id: this.adapter.makeId(), ownerSessionId: this.adapter.ownerSessionId, cwd: this.adapter.cwd,
        status: "running", count, books, ownerContext, generation: copy(generation), updatedAt: this.adapter.now() });
    });
    this.kick();
    return this.snapshot()!;
  }
  async pause(): Promise<LibraryTask> {
    await this.locked(async () => {
      const next = copy(this.owned());
      if (!ACTIVE.has(next.status)) return;
      const active = next.books.find(book => book.id === next.activeBookId);
      next.status = active === undefined ? "paused" : "pausing";
      delete next.error;
      await this.commit(next);
      if (active?.serialTaskId !== undefined) {
        const controller = this.controllers.get(active.ownerSessionId) ?? await this.adapter.controller(active, next);
        this.controllers.set(active.ownerSessionId, controller);
        if (controller.snapshot()?.id === active.serialTaskId) await controller.pause();
      }
    });
    this.wake?.();
    return this.snapshot()!;
  }
  async resume(): Promise<LibraryTask> {
    await this.locked(async () => {
      const next = copy(this.owned());
      if (ACTIVE.has(next.status)) return;
      if (next.status === "completed" && !next.books.some(book => book.status === "failed")) throw new Error("本批已经结束，请新建下一批。");
      for (const book of next.books) {
        if (book.status === "failed") { book.status = "pending"; book.retryRequested = true; delete book.error; }
      }
      const active = next.books.find(book => book.id === next.activeBookId);
      if (active !== undefined && active.serialTaskId !== undefined) {
        active.retryRequested = true;
      }
      next.status = "running";
      delete next.error;
      await this.commit(next);
    });
    this.kick();
    return this.snapshot()!;
  }
  async stop(): Promise<LibraryTask> {
    await this.locked(async () => {
      const next = copy(this.owned());
      const active = next.books.find(book => book.id === next.activeBookId);
      next.status = "blocked";
      next.error = "正在停止当前小说，已暂停书库后续派发。";
      await this.commit(next);
      try {
        await this.stopReservedBook(active, next);
        next.status = "stopped";
        delete next.error;
      } catch (error) {
        next.error = `尚未确认当前小说已停止，请重试停止：${message(error)}`;
      }
      await this.commit(next);
    });
    this.wake?.();
    return this.snapshot()!;
  }
  dispose(): void { this.disposed = true; this.wake?.(); }
  private kick(): void {
    if (this.driving || this.disposed || this.task?.status !== "running") return;
    this.driving = true;
    void this.drive().finally(() => { this.driving = false; if (!this.disposed && ACTIVE.has(this.task?.status ?? "stopped")) this.kick(); });
  }
  private async wait(): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(); }, this.adapter.pollMs ?? 1000);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
    });
  }
  private async drive(): Promise<void> {
    while (!this.disposed && this.task !== null && ACTIVE.has(this.task.status)) {
      try { await this.locked(() => this.step()); }
      catch (error) {
        try {
          await this.locked(async () => {
            const next = copy(this.owned());
            next.status = "blocked";
            next.error = message(error);
            try { await this.stopReservedBook(next.books.find(book => book.id === next.activeBookId), next); }
            catch (cancelError) { next.error += `；尚未确认当前小说已停止：${message(cancelError)}`; }
            await this.commit(next);
          });
        } catch { this.disposed = true; }
      }
      if (!this.disposed && this.task !== null && ACTIVE.has(this.task.status)) await this.wait();
    }
  }
  private async step(): Promise<void> {
    const next = copy(this.owned());
    if (!ACTIVE.has(next.status)) return;
    let book = next.books.find(item => item.id === next.activeBookId);
    if (book === undefined) {
      if (next.status === "pausing") { next.status = "paused"; await this.commit(next); return; }
      book = next.books.find(item => item.status === "pending");
      if (book === undefined) { next.status = "completed"; await this.commit(next); return; }
      next.activeBookId = book.id;
      book.status = "running";
      await this.commit(next); // Reserve the owner and fixed target before any native session or request.
    }
    try {
      const controller = await this.adapter.controller(book, next);
      this.controllers.set(book.ownerSessionId, controller);
      let serial = controller.snapshot();
      if (book.serialTaskId === undefined) {
        if (serial !== null && serial.ownerSessionId === book.ownerSessionId && serial.startChapter === book.startChapter && serial.targetChapter === book.targetChapter) {
          book.serialTaskId = serial.id; // Recover a crash after start but before this receipt was saved.
          if (serial.status === "paused" || serial.status === "blocked") serial = await controller.resume(book.retryRequested ? { allowRetryWindow: true } : undefined);
        } else {
          if (serial !== null && serial.status !== "completed" && serial.status !== "stopped") throw new Error("这本书已有未完成任务，请在该书原会话处理后再重试本批。");
          serial = await controller.start({ ...next.generation, count: book.targetChapter - book.startChapter + 1, startChapter: book.startChapter });
          book.serialTaskId = serial.id;
        }
        await this.commit(next);
      }
      if (serial === null || serial.id !== book.serialTaskId) throw new Error("书项目任务已被其他操作替换，未继续生成。");
      if (book.retryRequested && (serial.status === "paused" || serial.status === "blocked" || serial.status === "stopped")) serial = await controller.resume({ allowRetryWindow: true });
      delete book.retryRequested;
      book.completedChapters = serial.completed.filter(chapter => chapter >= book.startChapter && chapter <= book.targetChapter).length;
      if (serial.status === "completed") {
        book.status = "completed";
        delete book.error;
        delete next.activeBookId;
      } else if (serial.status === "blocked" || serial.status === "stopped") {
        const error = serial.error ?? "本书任务已停止。";
        book.error = error;
        // A scheduler error can be recorded while a native request is still unwinding.
        // Do not advance to another book until this reserved chapter is actually cancelled.
        await this.stopReservedBook(book, next);
        if (isSharedLibraryFailure(error)) { next.status = "blocked"; next.error = error; }
        else { book.status = "failed"; delete next.activeBookId; }
      } else if (serial.status === "paused") {
        next.status = "paused";
        next.error = "当前小说已暂停；继续本批将从原进度接续。";
      } else if (next.status === "pausing" && serial.status === "running") {
        await controller.pause();
      }
      await this.commit(next);
    } catch (error) {
      book.error = message(error);
      let cancelled = true;
      try { await this.stopReservedBook(book, next); }
      catch (cancelError) { cancelled = false; book.error += `；尚未确认当前小说已停止：${message(cancelError)}`; }
      if (!cancelled || isSharedLibraryFailure(book.error)) { next.status = "blocked"; next.error = book.error; }
      else { book.status = "failed"; delete next.activeBookId; }
      await this.commit(next);
    }
  }
}
