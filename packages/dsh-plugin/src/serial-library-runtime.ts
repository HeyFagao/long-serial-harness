import type { SerialResumeOptions, SerialStartOptions, SerialTask } from "./serial-runtime.js";

export type LibraryConcurrency = number | "all";
export type LibraryCount = 10 | 20 | 50 | "all";
export type LibraryStatus = "running" | "pausing" | "paused" | "blocked" | "stopped" | "completed";
export interface LibraryQueueBook {
  id: string;
  title: string;
  absolutePath: string;
  ownerSessionId: string;
  startChapter: number;
  targetChapter: number;
  status: "pending" | "running" | "pausing" | "paused" | "completed" | "failed" | "skipped";
  completedChapters: number;
  /** Appended selections keep their own captured model and generation settings. */
  count?: LibraryCount;
  ownerContext?: unknown;
  generation?: LibraryTask["generation"];
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
  activeBookId?: string; // Legacy serial.3 receipt.
  concurrency?: LibraryConcurrency;
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
  shutdownForDeletion?(): Promise<void>;
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
    || ![10, 20, 50, "all"].includes(task.count) || !Array.isArray(task.books)
    || typeof task.generation !== "object" || task.generation === null) throw new Error("书库任务记录格式无效，请保留原文件后处理。");
  if (task.concurrency !== undefined) assertLibraryConcurrency(task.concurrency);
  const ids = new Set<string>();
  for (const book of task.books) {
    if (typeof book.id !== "string" || ids.has(book.id) || typeof book.title !== "string" || typeof book.absolutePath !== "string" || typeof book.ownerSessionId !== "string"
      || !Number.isSafeInteger(book.startChapter) || book.startChapter < 1 || !Number.isSafeInteger(book.targetChapter) || book.targetChapter < book.startChapter - 1
      || !Number.isSafeInteger(book.completedChapters) || book.completedChapters < 0
      || !["pending", "running", "pausing", "paused", "completed", "failed", "skipped"].includes(book.status)
      || (book.count !== undefined && ![10, 20, 50, "all"].includes(book.count))
      || (book.generation !== undefined && (typeof book.generation !== "object" || book.generation === null || Array.isArray(book.generation)))) throw new Error("书库章节范围或项目身份无效，未继续生成。");
    ids.add(book.id);
  }
}

export function assertLibraryConcurrency(value: unknown): asserts value is LibraryConcurrency {
  if (value !== "all" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) throw new Error("并发数必须为正整数，或选择全部项目同时生成。");
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
  private async stopReservedBook(book: LibraryQueueBook | undefined, task: LibraryTask, forDeletion = false): Promise<void> {
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
    if (forDeletion && controller.shutdownForDeletion !== undefined) await controller.shutdownForDeletion();
    else if (serial.status !== "completed") await controller.stop();
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
  private selectedBooks(task: LibraryTask, ids: readonly string[]): LibraryQueueBook[] {
    if (ids.length === 0 || ids.some(id => typeof id !== "string" || id === "")) throw new Error("请先勾选要操作的书。");
    const selected = new Set(ids);
    if ([...selected].some(id => !task.books.some(book => book.id === id))) throw new Error("所选书不在当前批次中，请刷新后重新选择。");
    return task.books.filter(book => selected.has(book.id));
  }
  /** Convert a global hold into individual holds before explicitly starting a different selection. */
  private retainOtherHolds(task: LibraryTask, selected: ReadonlySet<string>): void {
    if (task.status === "running") return;
    for (const book of task.books) {
      if (selected.has(book.id)) continue;
      if (book.status === "pending") book.status = "paused";
      else if (book.status === "running") book.status = task.status === "pausing" ? "pausing" : "paused";
    }
  }
  private settleIdle(task: LibraryTask): void {
    if (task.status !== "running") return;
    if (!task.books.some(book => book.status === "running" || book.status === "pending" || book.status === "pausing")) {
      task.status = task.books.some(book => book.status === "paused") ? "paused" : "completed";
    }
  }
  async start(count: LibraryCount, generation: LibraryTask["generation"] = {}, concurrency: LibraryConcurrency = 1, ids?: readonly string[]): Promise<LibraryTask> {
    await this.locked(async () => {
      if (![10, 20, 50, "all"].includes(count)) throw new Error("书库批量支持新增 10、20、50 章或写至完本。");
      assertLibraryConcurrency(concurrency);
      if (ids !== undefined && (ids.length === 0 || ids.some(id => typeof id !== "string" || id === ""))) throw new Error("请先勾选要生成的书。");
      this.task ??= await this.adapter.load();
      if (this.task !== null) {
        assertLibraryTask(this.task);
        if (ids === undefined && !["completed", "stopped"].includes(this.task.status)) throw new Error("已有未完成的书库批次。可勾选其他书开始，或继续原批次。");
        if (ids !== undefined && this.task.status === "blocked") throw new Error("书库正在等待处理共享错误，请先处理并继续原批次，再启动所选书。");
        if (ids !== undefined && !["completed", "stopped"].includes(this.task.status)) this.owned();
      }
      const plans = await this.adapter.plan();
      const selection = ids === undefined ? undefined : new Set(ids);
      if (selection !== undefined && [...selection].some(id => !plans.some(book => book.id === id))) throw new Error("所选书已删除或不在当前书库，请刷新后重新选择。");
      const selectedPlans = selection === undefined ? plans : plans.filter(book => selection.has(book.id));
      if (selectedPlans.length === 0) throw new Error("书库还没有可生成的小说，请先导入或勾选书项目。");
      const previous = this.task;
      if (selection !== undefined && previous !== null && previous.status !== "stopped") {
        const unfinished = previous.books.filter(book => selection.has(book.id) && !["completed", "skipped"].includes(book.status));
        if (unfinished.length > 0) throw new Error(`《${unfinished[0]!.title}》已有未完成目标，请使用“继续所选书”，不会重新增加章节或覆盖原目标。`);
      }
      const ownerContext = await this.adapter.captureContext();
      const books: LibraryQueueBook[] = selectedPlans.map(book => ({
        id: book.id, title: book.title, absolutePath: book.absolutePath, ownerSessionId: this.adapter.makeId(),
        startChapter: book.nextChapter, targetChapter: count === "all" ? book.lastChapter : Math.min(book.lastChapter, book.nextChapter + count - 1),
        status: book.error !== undefined ? "failed" : book.nextChapter > book.lastChapter ? "skipped" : "pending", completedChapters: 0,
        count, ownerContext: copy(ownerContext), generation: copy(generation),
        ...(book.error === undefined ? {} : { error: book.error })
      }));
      if (selection !== undefined && previous !== null && !previous.books.every(book => book.status === "completed" || book.status === "skipped")) {
        const next = copy(previous);
        this.retainOtherHolds(next, selection);
        next.books = [...next.books.filter(book => !selection.has(book.id)), ...books];
        // Terminal history can be continued in a new library session; old per-book captures remain intact.
        if (["completed", "stopped"].includes(previous.status)) next.ownerSessionId = this.adapter.ownerSessionId;
        next.status = "running"; next.concurrency = concurrency; delete next.error;
        await this.commit(next);
      } else {
        await this.commit({ schemaVersion: 1, id: this.adapter.makeId(), ownerSessionId: this.adapter.ownerSessionId, cwd: this.adapter.cwd,
          status: "running", count, concurrency, books, ownerContext, generation: copy(generation), updatedAt: this.adapter.now() });
      }
    });
    this.kick(); this.wake?.();
    return this.snapshot()!;
  }
  async pauseBooks(ids: readonly string[]): Promise<LibraryTask> {
    await this.locked(async () => {
      const next = copy(this.owned());
      const selected = this.selectedBooks(next, ids);
      const active = selected.filter(book => book.status === "running" || book.status === "pausing");
      for (const book of selected) {
        if (book.status === "pending") book.status = "paused";
        else if (book.status === "running") book.status = "pausing";
      }
      // Persist the hold before the next scheduler pass can admit another chapter.
      await this.commit(next);
      for (const book of active) {
        const controller = this.controllers.get(book.ownerSessionId) ?? await this.adapter.controller(book, next);
        this.controllers.set(book.ownerSessionId, controller);
        const serial = controller.snapshot();
        if (serial === null) { book.status = "paused"; continue; }
        if (book.serialTaskId !== undefined && serial.id !== book.serialTaskId) throw new Error("本书任务身份已经变化，请在原会话暂停。");
        book.serialTaskId ??= serial.id;
        if (serial.status === "completed") { book.status = "completed"; book.completedChapters = serial.completed.length; }
        else if (serial.status === "running" || serial.status === "pausing") await controller.pause();
        else {
          if (serial.status === "blocked") {
            await this.stopReservedBook(book, next);
            if (serial.error !== undefined && isSharedLibraryFailure(serial.error)) { next.status = "blocked"; next.error = serial.error; }
          }
          book.status = "paused";
        }
      }
      if (next.status === "blocked") await this.stopRunningBooks(next);
      this.settleIdle(next); await this.commit(next);
    });
    this.kick(); this.wake?.(); return this.snapshot()!;
  }
  async resumeBooks(ids: readonly string[]): Promise<LibraryTask> {
    await this.locked(async () => {
      const next = copy(this.owned());
      const selected = this.selectedBooks(next, ids);
      for (const book of selected.filter(book => book.status === "pausing")) {
        if (ACTIVE.has(next.status)) throw new Error("所选书正在完成当前章并暂停，请等待“已暂停”后继续。");
        // A host restart can persist the pause intent while the child runtime has
        // already recovered paused. Reconcile only the explicitly selected child.
        const controller = this.controllers.get(book.ownerSessionId) ?? await this.adapter.controller(book, next);
        this.controllers.set(book.ownerSessionId, controller);
        const serial = controller.snapshot();
        if (serial === null) { book.status = "paused"; continue; }
        if ((book.serialTaskId !== undefined && serial.id !== book.serialTaskId)
          || (book.serialTaskId === undefined && (serial.ownerSessionId !== book.ownerSessionId || serial.startChapter !== book.startChapter || serial.targetChapter !== book.targetChapter))) throw new Error("本书任务身份已经变化，请在原会话处理。");
        if (serial.status === "running" || serial.status === "pausing") throw new Error("所选书仍在完成当前章，请等待暂停完成后继续。");
        book.serialTaskId ??= serial.id;
        book.completedChapters = serial.completed.filter(chapter => chapter >= book.startChapter && chapter <= book.targetChapter).length;
        book.status = serial.status === "completed" ? "completed" : "paused";
      }
      const resumable = selected.filter(book => book.status === "paused" || book.status === "failed"
        || (next.status !== "running" && (book.status === "running" || book.status === "pending")));
      if (resumable.length === 0) { await this.commit(next); return; }
      const resumedIds = new Set(resumable.map(book => book.id));
      // A blocked queue may still contain a native request whose cancellation failed.
      // Do not relabel an unselected writer paused until its stop is confirmed.
      if (next.status === "blocked") {
        for (const book of next.books.filter(book => !resumedIds.has(book.id) && (book.status === "running" || book.status === "pausing"))) await this.stopReservedBook(book, next);
      }
      this.retainOtherHolds(next, resumedIds);
      for (const book of resumable) { book.status = "pending"; book.retryRequested = true; delete book.error; }
      next.status = "running"; delete next.error; await this.commit(next);
    });
    this.kick(); this.wake?.(); return this.snapshot()!;
  }
  async pause(): Promise<LibraryTask> {
    await this.locked(async () => {
      const next = copy(this.owned());
      if (!ACTIVE.has(next.status)) return;
      const active = next.books.filter(book => book.status === "running" || book.status === "pausing");
      next.status = active.length === 0 ? "paused" : "pausing";
      delete next.error;
      await this.commit(next);
      await Promise.all(active.map(async book => {
        if (book.serialTaskId === undefined) return;
        const controller = this.controllers.get(book.ownerSessionId) ?? await this.adapter.controller(book, next);
        this.controllers.set(book.ownerSessionId, controller);
        if (controller.snapshot()?.id === book.serialTaskId) await controller.pause();
      }));
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
      const active = next.books.filter(book => book.status === "running");
      for (const book of active) if (book.serialTaskId !== undefined) book.retryRequested = true;
      if (!next.books.some(book => book.status === "pending" || book.status === "running" || book.status === "pausing")) {
        if (next.books.some(book => book.status === "paused")) throw new Error("这些书已单独暂停，请勾选后点击“继续所选书”。");
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
      next.status = "blocked";
      next.error = "正在停止当前小说，已暂停书库后续派发。";
      await this.commit(next);
      try {
        await this.stopRunningBooks(next);
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
  /** Remove one reservation durably; future resumes must never admit the deleted book again. */
  async excludeBookForDeletion(id: string, shutdownCurrentBook?: () => Promise<void>): Promise<void> {
    await this.locked(async () => {
      this.task ??= await this.adapter.load();
      if (this.task === null) return;
      assertLibraryTask(this.task);
      if (this.task.cwd !== this.adapter.cwd) throw new Error("书库目录已变化，请在原目录处理删除。");
      // Deletion is authorized against this library, including historical batches
      // opened from a different library session. Preserve the original queue owner;
      // The host can resolve the current book writer even when this old reservation
      // refers to a previous batch or obsolete model settings.
      const next = copy(this.task);
      const book = next.books.find(item => item.id === id);
      if (book === undefined) return;
      // Keep the original receipt and errors if cancellation fails. Other books are untouched.
      if (shutdownCurrentBook !== undefined) await shutdownCurrentBook();
      else await this.stopReservedBook(book, next, true);
      next.books = next.books.filter(item => item.id !== id);
      if (next.activeBookId === id) delete next.activeBookId;
      if (book.error !== undefined && next.error === book.error && !next.books.some(item => item.error === next.error)) delete next.error;
      if (next.books.length === 0) { next.status = "completed"; delete next.error; }
      else this.settleIdle(next);
      await this.commit(next);
      this.controllers.delete(book.ownerSessionId);
    });
    this.wake?.();
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
            try { await this.stopRunningBooks(next); }
            catch (cancelError) { next.error += `；尚未确认当前小说已停止：${message(cancelError)}`; }
            await this.commit(next);
          });
        } catch { this.disposed = true; }
      }
      if (!this.disposed && this.task !== null && ACTIVE.has(this.task.status)) await this.wait();
    }
  }
  private async stopRunningBooks(task: LibraryTask): Promise<void> {
    const results = await Promise.allSettled(task.books.filter(book => book.status === "running" || book.status === "pausing").map(book => this.stopReservedBook(book, task)));
    const errors = results.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (errors.length > 0) throw new Error(errors.map(item => message(item.reason)).join("；"));
  }
  private async step(): Promise<void> {
    const next = copy(this.owned());
    if (!ACTIVE.has(next.status)) return;
    const limit = next.concurrency === "all" ? next.books.length : next.concurrency ?? 1;
    // Admission is serialized for durable receipts; each controller runs its own chapter loop concurrently.
    for (const book of next.books.filter(item => item.status === "running" || item.status === "pausing")) {
      await this.stepBook(next, book);
      if (!ACTIVE.has(next.status)) break;
    }
    if (next.status === "running") {
      for (const book of next.books.filter(item => item.status === "pending")) {
        if (next.books.filter(item => item.status === "running" || item.status === "pausing").length >= limit) break;
        book.status = "running";
        await this.commit(next);
        await this.stepBook(next, book);
        if (next.status !== "running") break;
      }
    }
    if (next.status === "blocked") await this.stopRunningBooks(next);
    if (next.status === "pausing") {
      await Promise.all(next.books.filter(book => book.status === "running" || book.status === "pausing").map(async book => {
        const controller = this.controllers.get(book.ownerSessionId);
        if (controller?.snapshot()?.status === "running") await controller.pause();
      }));
      const active = next.books.filter(book => book.status === "running" || book.status === "pausing");
      if (active.every(book => this.controllers.get(book.ownerSessionId)?.snapshot()?.status === "paused")) next.status = "paused";
    }
    this.settleIdle(next);
    await this.commit(next);
  }
  private async stepBook(next: LibraryTask, book: LibraryQueueBook): Promise<void> {
    try {
      const controller = await this.adapter.controller(book, next);
      this.controllers.set(book.ownerSessionId, controller);
      let serial = controller.snapshot();
      if (book.status === "pausing") {
        if (serial === null) book.status = "paused";
        else {
          if (book.serialTaskId !== undefined && serial.id !== book.serialTaskId) throw new Error("书项目任务已被其他操作替换，未继续暂停。");
          book.serialTaskId ??= serial.id;
          book.completedChapters = serial.completed.filter(chapter => chapter >= book.startChapter && chapter <= book.targetChapter).length;
          if (serial.status === "completed") { book.status = "completed"; delete book.error; }
          else if (serial.status === "paused" || serial.status === "stopped" || serial.status === "blocked") {
            if (serial.status === "blocked") {
              await this.stopReservedBook(book, next);
              if (serial.error !== undefined && isSharedLibraryFailure(serial.error)) { next.status = "blocked"; next.error = serial.error; }
            }
            book.status = "paused";
          } else await controller.pause();
        }
        await this.commit(next); return;
      }
      if (book.serialTaskId === undefined) {
        if (serial !== null && serial.ownerSessionId === book.ownerSessionId && serial.startChapter === book.startChapter && serial.targetChapter === book.targetChapter) {
          book.serialTaskId = serial.id; // Recover a crash after start but before this receipt was saved.
          if (serial.status === "paused" || serial.status === "blocked") serial = await controller.resume(book.retryRequested ? { allowRetryWindow: true } : undefined);
        } else {
          if (serial !== null && serial.status !== "completed" && serial.status !== "stopped") throw new Error("这本书已有未完成任务，请在该书原会话处理后再重试本批。");
          serial = await controller.start({ ...(book.generation ?? next.generation), count: book.targetChapter - book.startChapter + 1, startChapter: book.startChapter });
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
        // A pause in one book must never pause unrelated books. Global holds retain their running reservations.
        if (next.status !== "pausing") book.status = "paused";
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
