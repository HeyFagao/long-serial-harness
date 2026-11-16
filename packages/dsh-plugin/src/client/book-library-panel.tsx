import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { LibraryBook, LibraryImportResult, LibraryInputFile, LibrarySnapshot } from "../serial-library.js";
import type { LibraryCount, LibraryTask } from "../serial-library-runtime.js";
import { endpoint } from "./workbench-ui.js";
import libraryStyles from "./book-library.css?inline";

export interface NativeBookNavigation {
  register(path: string, title: string): Promise<string>;
  open(workspaceId: string): Promise<void>;
  unregister?(workspaceId: string): Promise<void>;
  openSession?(sessionId: string): Promise<void>;
}
interface SelectedFile extends LibraryInputFile { readonly bytes: number; readonly key: string }
interface Registration { readonly workspaceId?: string; readonly error?: string }
type ImportPayload = LibrarySnapshot & { readonly results: readonly LibraryImportResult[] };
const FALLBACK_LIMITS = { maxFiles: 50, maxBytesPerFile: 2_097_152, maxTotalBytes: 33_554_432 };
const STATUS: Readonly<Record<string, string>> = { ready: "待生成", incomplete: "导入未完成", running: "生成中", pausing: "正在暂停", paused: "已暂停", blocked: "需要处理", stopped: "已停止", completed: "本批完成", archived: "旧版回收站", deleting: "后台删除中" };
// Shared across session remounts so an old unregister cannot remove an explicitly reimported entry.
const workspaceCleanup = new Map<string, Promise<void>>();

async function responseJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(typeof body === "object" && body !== null && "error" in body ? String(body.error) : `请求失败（HTTP ${String(response.status)}）`);
  return body as T;
}

/** The uploaded bytes stay in the host workspace; decoding does not call a model. */
export function decodeLibraryText(bytes: ArrayBuffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
}

/** Register every successful import without navigating away from the multi-book results. */
export async function registerLibraryResults(results: readonly LibraryImportResult[], navigation: NativeBookNavigation, onResult: (book: LibraryBook, registration: Registration) => void): Promise<void> {
  const registered = new Set<string>();
  for (const result of results) {
    const book = result.book;
    if (result.status === "failed" || book === undefined || !canOpenLibraryBook(book) || registered.has(book.id)) continue;
    registered.add(book.id);
    try { onResult(book, { workspaceId: await registerBookWorkspace(navigation, book) }); }
    catch (reason: unknown) { onResult(book, { error: reason instanceof Error ? reason.message : String(reason) }); }
  }
}

export function canOpenLibraryBook(book: LibraryBook): boolean {
  return book.absolutePath.trim() !== "" && book.totalChapters > 0 && !["incomplete", "archived", "deleting", "delete_failed"].includes(book.status);
}

async function waitForWorkspaceCleanup(cleanup: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("侧栏清理超时")); }, 5000); })
    ]);
    return true;
  } catch { return false; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Native sidebar cleanup must never keep a library action pending indefinitely. */
function unregisterBookWorkspace(navigation: NativeBookNavigation, book: LibraryBook, workspaceId: string): Promise<boolean> {
  const unregister = navigation.unregister?.bind(navigation);
  if (unregister === undefined) return Promise.resolve(true);
  const previous = workspaceCleanup.get(book.absolutePath) ?? Promise.resolve();
  const cleanup = previous.then(() => unregister(workspaceId)).then(() => undefined, () => undefined);
  workspaceCleanup.set(book.absolutePath, cleanup);
  void cleanup.then(() => { if (workspaceCleanup.get(book.absolutePath) === cleanup) workspaceCleanup.delete(book.absolutePath); });
  return waitForWorkspaceCleanup(cleanup);
}

async function registerBookWorkspace(navigation: NativeBookNavigation, book: LibraryBook): Promise<string> {
  const cleanup = workspaceCleanup.get(book.absolutePath);
  if (cleanup !== undefined && !await waitForWorkspaceCleanup(cleanup)) throw new Error("书项目正在准备中，请稍后重试登记。");
  // Another late registration can have queued more cleanup while the first one was finishing.
  if (workspaceCleanup.has(book.absolutePath)) return registerBookWorkspace(navigation, book);
  return navigation.register(book.absolutePath, book.title);
}

/** A historic task never owns a new batch, but only its original session can resume it. */
export function libraryQueueControls(task: Pick<LibraryTask, "status" | "ownerSessionId" | "books"> | null | undefined, sessionId: string): {
  readonly canStart: boolean;
  readonly differentOwner: boolean;
  readonly canPause: boolean;
  readonly canStop: boolean;
  readonly resumeLabel?: string;
} {
  const canStart = task === undefined || task === null || task.status === "stopped" || task.status === "completed";
  const differentOwner = task !== undefined && task !== null && task.ownerSessionId !== sessionId;
  if (task === undefined || task === null || differentOwner) return { canStart, differentOwner, canPause: false, canStop: false };
  let resumeLabel: string | undefined;
  if (task.status === "paused" || task.status === "blocked") resumeLabel = "继续本批项目";
  else if (task.status === "stopped" && task.books.some(book => book.status !== "completed" && book.status !== "skipped")) resumeLabel = "恢复这批项目";
  else if (task.status === "completed" && task.books.some(book => book.status === "failed")) resumeLabel = "重试失败项目";
  return { canStart, differentOwner, canPause: task.status === "running", canStop: !canStart, ...(resumeLabel === undefined ? {} : { resumeLabel }) };
}

interface BookLibraryPanelProps {
  readonly sessionId: string;
  readonly navigation: NativeBookNavigation;
  readonly onImported: () => void;
  readonly onAvailabilityChange?: (archived: boolean) => void;
}

export function BookLibraryPanel(props: BookLibraryPanelProps) {
  // A session switch owns a fresh selection and async lifecycle. Old responses cannot act on its books.
  return <BookLibraryContent key={props.sessionId} {...props} />;
}

function BookLibraryContent({ sessionId, navigation, onImported, onAvailabilityChange }: BookLibraryPanelProps) {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>();
  const [checkedBooks, setCheckedBooks] = useState<readonly string[]>([]);
  const [hiddenBookIds, setHiddenBookIds] = useState<readonly string[]>([]);
  const [manageError, setManageError] = useState<string>();
  const [manageNotice, setManageNotice] = useState<string>();
  const [selected, setSelected] = useState<readonly SelectedFile[]>([]);
  const [results, setResults] = useState<readonly LibraryImportResult[]>([]);
  const [registrations, setRegistrations] = useState<Readonly<Record<string, Registration>>>({});
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [queueError, setQueueError] = useState<string>();
  const [concurrency, setConcurrency] = useState("all");
  const [task, setTask] = useState<LibraryTask | null>();
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const revision = useRef(0);
  const loadSequence = useRef(0);
  const queueRevision = useRef(0);
  const registrationAttempted = useRef(new Set<string>());
  const suppressedRegistrations = useRef(new Map<string, string>());
  const pendingDeletionSubmission = useRef(new Set<string>());
  const registrationsRef = useRef<Readonly<Record<string, Registration>>>({});
  const registrationGeneration = useRef(new Map<string, number>());
  const managementPending = useRef(false);
  const refreshing = useCallback(() => { setRefresh(current => current + 1); }, []);
  const limits = snapshot?.limits ?? FALLBACK_LIMITS;
  const currentBookDeleted = snapshot?.isBookProject === true && (["deleting", "delete_failed"].includes(snapshot.books[0]?.status ?? "") || (snapshot.deletingBooks?.length ?? 0) > 0);
  useEffect(() => { onAvailabilityChange?.(currentBookDeleted || (snapshot?.isBookProject === true && snapshot.books[0]?.status === "archived")); }, [currentBookDeleted, onAvailabilityChange, snapshot]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const stamp = revision.current;
    const sequence = ++loadSequence.current;
    void fetch(endpoint("library", sessionId), { signal: controller.signal }).then(responseJson<LibrarySnapshot>).then(value => {
      if (controller.signal.aborted || stamp !== revision.current || sequence !== loadSequence.current) return;
      for (const book of value.deletingBooks ?? []) suppressedRegistrations.current.set(book.id, book.absolutePath);
      setSnapshot(value);
      setLoadError(undefined);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && stamp === revision.current) setLoadError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { controller.abort(); };
  }, [refresh, sessionId]);
  useEffect(() => { const timer = setInterval(refreshing, 5000); return () => { clearInterval(timer); }; }, [refreshing]);
  useEffect(() => {
    if (snapshot === undefined || snapshot.isBookProject || pending !== undefined) return;
    // If a page closed after the host imported files, reopening the catalogue
    // recovers any missing native registrations. A failed attempt is never
    // automatically retried on each polling tick.
    const books = snapshot.books.filter(book => canOpenLibraryBook(book) && !registrationSuppressed(book) && registrations[book.id] === undefined && !registrationAttempted.current.has(book.id));
    for (const book of books) registrationAttempted.current.add(book.id);
    void registerBooks(books);
  }, [navigation, pending, registrations, snapshot]);
  useEffect(() => {
    if (snapshot === undefined || snapshot.isBookProject) return;
    const controller = new AbortController();
    const stamp = queueRevision.current;
    void fetch(endpoint("library/queue", sessionId), { signal: controller.signal }).then(responseJson<{ readonly task: LibraryTask | null }>).then(value => {
      if (!controller.signal.aborted && stamp === queueRevision.current) { setTask(value.task); setQueueError(undefined); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted && stamp === queueRevision.current) setQueueError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { controller.abort(); };
  }, [refresh, sessionId, snapshot?.isBookProject]);

  const chooseFiles = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setError(undefined);
    setNotice(undefined);
    setResults([]);
    if (files.length > limits.maxFiles) { setError(`一次最多导入 ${String(limits.maxFiles)} 本，请分批选择。`); return; }
    if (files.reduce((sum, file) => sum + file.size, 0) > limits.maxTotalBytes) { setError("本批文件超过 32 MB，请分批导入。"); return; }
    setPending("read");
    const next: SelectedFile[] = [];
    const failures: LibraryImportResult[] = [];
    let decodedBytes = 0;
    for (const [index, file] of files.entries()) {
      try {
        if (!/\.(txt|md)$/iu.test(file.name)) throw new Error("请选择 TXT 或 Markdown 文本。");
        if (file.size > limits.maxBytesPerFile) throw new Error("文件超过 2 MB，请移除无关内容后重试。");
        const text = decodeLibraryText(await file.arrayBuffer());
        const bytes = new TextEncoder().encode(text).byteLength;
        if (bytes > limits.maxBytesPerFile) throw new Error("转换为 UTF-8 后超过 2 MB，请拆分文件。");
        if (decodedBytes + bytes > limits.maxTotalBytes) throw new Error("本批文本超过 32 MB，请分批导入。");
        decodedBytes += bytes;
        next.push({ key: `${String(index)}:${file.name}`, filename: file.name, text, bytes });
      } catch (reason: unknown) { failures.push({ filename: file.name, status: "failed", error: reason instanceof Error ? reason.message : "无法读取文本，请另存为 UTF-8 后重试。" }); }
    }
    if (!mounted.current) return;
    setSelected(next);
    setResults(failures);
    setPending(undefined);
  };

  function registrationSuppressed(book: LibraryBook): boolean {
    return suppressedRegistrations.current.has(book.id) || [...suppressedRegistrations.current.values()].includes(book.absolutePath);
  }
  function recordRegistration(book: LibraryBook, registration: Registration, generation = registrationGeneration.current.get(book.id) ?? 0): boolean {
    if (registrationSuppressed(book)) {
      if ([...suppressedRegistrations.current].some(([id, path]) => pendingDeletionSubmission.current.has(id) && (id === book.id || path === book.absolutePath))) {
        // Wait for durable acceptance before unregistering. A rejected POST must preserve this entry.
        registrationsRef.current = { ...registrationsRef.current, [book.id]: registration };
        return false;
      }
      // A native register started before Delete can finish after its response. Remove that late entry too.
      if (registration.workspaceId !== undefined) void unregisterBookWorkspace(navigation, book, registration.workspaceId);
      return false;
    }
    if (!mounted.current || generation !== (registrationGeneration.current.get(book.id) ?? 0)) return false;
    registrationAttempted.current.add(book.id);
    registrationsRef.current = { ...registrationsRef.current, [book.id]: registration };
    setRegistrations(registrationsRef.current);
    return true;
  }
  async function registerBooks(books: readonly LibraryBook[]): Promise<void> {
    const registered = new Set<string>();
    for (const book of books) {
      if (!mounted.current) return;
      if (!canOpenLibraryBook(book) || registrationSuppressed(book) || registered.has(book.id)) continue;
      registered.add(book.id);
      const generation = registrationGeneration.current.get(book.id) ?? 0;
      try { recordRegistration(book, { workspaceId: await registerBookWorkspace(navigation, book) }, generation); }
      catch (reason: unknown) { recordRegistration(book, { error: reason instanceof Error ? reason.message : String(reason) }, generation); }
    }
  }
  const importFiles = async (): Promise<void> => {
    if (pending !== undefined || selected.length === 0) return;
    revision.current += 1;
    setPending("import"); setError(undefined); setNotice(undefined);
    try {
      const value = await responseJson<ImportPayload>(await fetch(endpoint("library", sessionId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: selected.map(({ filename, text, title }) => ({ filename, text, ...(title?.trim() ? { title: title.trim() } : {}) })) }) }));
      if (!mounted.current) return;
      setSnapshot(value);
      setResults(value.results);
      const failedNames = new Set(value.results.filter(result => result.status === "failed").map(result => result.filename));
      setSelected(current => current.filter(file => failedNames.has(file.filename)));
      setPending("register");
      const importedBooks = value.results.flatMap(result => result.status !== "failed" && result.book !== undefined ? [result.book] : []);
      // Explicitly importing a deleted book again authorizes a new native project entry.
      for (const book of importedBooks) {
        registrationGeneration.current.set(book.id, (registrationGeneration.current.get(book.id) ?? 0) + 1);
        for (const [id, path] of suppressedRegistrations.current) if (id === book.id || path === book.absolutePath) suppressedRegistrations.current.delete(id);
      }
      setHiddenBookIds(current => current.filter(id => !importedBooks.some(book => book.id === id)));
      await registerBooks(importedBooks);
      if (!mounted.current) return;
      const imported = value.results.filter(result => result.status === "imported").length;
      const existing = value.results.filter(result => result.status === "existing").length;
      const failed = value.results.filter(result => result.status === "failed").length;
      setNotice(`新建 ${String(imported)} 本，已有 ${String(existing)} 本${failed > 0 ? `，失败 ${String(failed)} 本` : ""}。每本书独立保存，可从下方打开。`);
      onImported();
    } catch (reason: unknown) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { revision.current += 1; if (mounted.current) { setPending(undefined); refreshing(); } }
  };
  const openBook = async (book: LibraryBook): Promise<void> => {
    if (pending !== undefined || !canOpenLibraryBook(book) || registrationSuppressed(book)) return;
    setPending(book.id); setError(undefined);
    try {
      const workspaceId = registrations[book.id]?.workspaceId ?? await registerBookWorkspace(navigation, book);
      if (recordRegistration(book, { workspaceId })) await navigation.open(workspaceId);
    } catch (reason: unknown) { recordRegistration(book, { error: reason instanceof Error ? reason.message : String(reason) }); }
    finally { if (mounted.current) setPending(undefined); }
  };
  const retryRegister = async (book: LibraryBook): Promise<void> => {
    if (pending !== undefined || !canOpenLibraryBook(book) || registrationSuppressed(book)) return;
    setPending(book.id);
    try { recordRegistration(book, { workspaceId: await registerBookWorkspace(navigation, book) }); }
    catch (reason: unknown) { recordRegistration(book, { error: reason instanceof Error ? reason.message : String(reason) }); }
    finally { if (mounted.current) setPending(undefined); }
  };
  const backToLibrary = async (): Promise<void> => {
    if (snapshot?.parentLibraryPath === undefined || pending !== undefined) return;
    setPending("back"); setError(undefined);
    try {
      const path = snapshot.parentLibraryPath;
      const workspaceId = await navigation.register(path, path.split(/[\\/]/u).at(-1) || "小说书库");
      if (mounted.current) await navigation.open(workspaceId);
    } catch (reason: unknown) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setPending(undefined); }
  };
  const queueAction = async (action: "start" | "pause" | "resume" | "stop", count?: LibraryCount): Promise<void> => {
    if (pending !== undefined) return;
    queueRevision.current += 1;
    setPending(`queue-${action}`); setError(undefined);
    try {
      const value = await responseJson<{ readonly task: LibraryTask | null }>(await fetch(endpoint("library/queue", sessionId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, concurrency: concurrency === "all" ? "all" : Number(concurrency), ...(count === undefined ? {} : { count }) }) }));
      if (mounted.current) { setTask(value.task); setQueueError(undefined); onImported(); }
    } catch (reason: unknown) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { queueRevision.current += 1; if (mounted.current) { setPending(undefined); refreshing(); } }
  };
  const openQueueOwner = async (): Promise<void> => {
    if (task === undefined || task === null || pending !== undefined || navigation.openSession === undefined) return;
    setPending("queue-owner"); setError(undefined);
    try { await navigation.openSession(task.ownerSessionId); }
    catch (reason: unknown) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setPending(undefined); }
  };
  const manageBooks = async (action: "export" | "delete", ids: readonly string[]): Promise<void> => {
    if (pending !== undefined || managementPending.current || ids.length === 0) return;
    const catalogue = [...(snapshot?.books ?? []), ...(snapshot?.archivedBooks ?? [])];
    const selectedIds = [...new Set(ids)].filter(id => catalogue.some(book => book.id === id));
    if (selectedIds.length === 0) { setManageError("所选书项目已变化，请刷新后重新选择。"); return; }
    const selectedBooks = catalogue.filter(book => selectedIds.includes(book.id));
    const newlySuppressed = selectedBooks.filter(book => !suppressedRegistrations.current.has(book.id)).map(book => book.id);
    const accepted = new Set<string>();
    managementPending.current = true;
    revision.current += 1; queueRevision.current += 1;
    setPending(action); setError(undefined); setManageError(undefined); setManageNotice(undefined);
    if (action === "delete") {
      // Hide the exact clicked selection immediately; a rejected submission rolls it back below.
      setHiddenBookIds(current => [...new Set([...current, ...selectedIds])]);
      for (const book of selectedBooks) { suppressedRegistrations.current.set(book.id, book.absolutePath); pendingDeletionSubmission.current.add(book.id); }
    }
    try {
      const response = await fetch(endpoint("library", sessionId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ids: selectedIds }) });
      if (action === "export") {
        if (!response.ok) await responseJson(response);
        const blob = await response.blob();
        if (!mounted.current) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a"); link.href = url; link.download = "小说正文_TXT合集.zip";
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
        setManageNotice("TXT合集已交给 Harness 下载。每本书一个ZIP，里面每章一个TXT；未完结和跳过的书请查看ZIP内的导出说明。原稿保留。");
      } else {
        const result = await responseJson<LibrarySnapshot & { results: { id: string; ok: boolean; error?: string }[] }>(response);
        for (const item of result.results) if (item.ok && selectedIds.includes(item.id)) accepted.add(item.id);
        const unacceptedCount = selectedIds.length - accepted.size;
        for (const id of selectedIds) pendingDeletionSubmission.current.delete(id);
        for (const id of accepted) {
          registrationAttempted.current.delete(id);
          const workspaceId = registrationsRef.current[id]?.workspaceId;
          const book = catalogue.find(item => item.id === id);
          if (workspaceId !== undefined && book !== undefined) void unregisterBookWorkspace(navigation, book, workspaceId);
        }
        registrationsRef.current = Object.fromEntries(Object.entries(registrationsRef.current).filter(([id]) => !accepted.has(id)));
        if (!mounted.current) return;
        revision.current += 1; setSnapshot(result);
        setRegistrations(registrationsRef.current);
        setCheckedBooks(current => current.filter(id => !accepted.has(id)));
        const deletedNames = new Set(catalogue.filter(book => accepted.has(book.id)).map(book => book.filename));
        setResults(current => current.filter(item => !deletedNames.has(item.filename)));
        if (accepted.size > 0) setManageNotice(`已从列表移除 ${String(accepted.size)} 本书。`);
        if (unacceptedCount > 0) setManageError(accepted.size > 0 ? "部分书籍删除未提交，请再试一次。" : "删除未提交，请再试一次。");
        refreshing(); onImported();
      }
    } catch (reason) { if (mounted.current) setManageError(action === "delete" ? "删除未提交，请再试一次。" : reason instanceof Error ? reason.message : String(reason)); }
    finally {
      if (action === "delete") {
        for (const id of selectedIds) pendingDeletionSubmission.current.delete(id);
        for (const id of newlySuppressed) if (!accepted.has(id)) {
          suppressedRegistrations.current.delete(id);
          registrationAttempted.current.delete(id);
        }
        if (mounted.current) {
          // Accepted deletes stay hidden through later polling or cleanup retries. Only submission failures return.
          setHiddenBookIds(current => current.filter(id => !selectedIds.includes(id) || accepted.has(id)));
          setRegistrations(registrationsRef.current);
        }
      }
      managementPending.current = false;
      revision.current += 1; queueRevision.current += 1;
      if (mounted.current) { setPending(undefined); refreshing(); }
    }
  };
  const hiddenIds = new Set([...hiddenBookIds, ...(snapshot?.deletingBooks ?? []).map(book => book.id), ...(snapshot?.books ?? []).filter(book => ["deleting", "delete_failed"].includes(book.status)).map(book => book.id)]);
  const bookIsVisible = (book: LibraryBook): boolean => !hiddenIds.has(book.id);
  const visibleBooks = (snapshot?.books ?? []).filter(bookIsVisible);
  const visibleArchivedBooks = (snapshot?.archivedBooks ?? []).filter(bookIsVisible);
  const visibleSelectedIds = checkedBooks.filter(id => [...visibleBooks, ...visibleArchivedBooks].some(book => book.id === id));
  const hiddenFilenames = new Set([...(snapshot?.books ?? []), ...(snapshot?.archivedBooks ?? [])].filter(book => hiddenIds.has(book.id)).map(book => book.filename));
  const visibleResults = results.filter(result => !hiddenFilenames.has(result.filename) && (result.book === undefined || !hiddenIds.has(result.book.id)));
  const visibleTaskBooks = task?.books.filter(book => !hiddenIds.has(book.id)) ?? [];
  const busy = pending !== undefined;
  const queueControls = libraryQueueControls(task, sessionId);
  const differentOwner = queueControls.differentOwner;
  const failedBooks = visibleTaskBooks.filter(book => book.status === "failed").length;
  const doneBooks = visibleTaskBooks.filter(book => book.status === "completed" || book.status === "skipped").length;
  return <section className="book-library-panel" aria-label="小说书库">
    <style>{libraryStyles}</style>
    <header className="book-library-heading"><h2>{snapshot?.isBookProject ? "当前书项目" : "小说书库"}</h2><button type="button" disabled={busy} onClick={refreshing}>刷新</button></header>
    {(error !== undefined || loadError !== undefined) && <p className="book-library-error" role="alert">{error ?? loadError}</p>}
    {snapshot === undefined && loadError === undefined && <p className="book-library-note">正在读取书项目…</p>}
    {snapshot?.isBookProject ? <>
      <p className="book-library-note">{currentBookDeleted ? "本书已从书库移除。请返回书库继续操作。" : snapshot.books[0]?.status === "archived" ? "本书位于旧版回收站。请回到书库导出或永久删除。" : "当前小说独立保存。其他小说可从 Harness 工作区列表打开。"}</p>
      {snapshot.parentLibraryPath !== undefined && <button className="book-library-back" type="button" disabled={busy} onClick={() => { void backToLibrary(); }}>{pending === "back" ? "正在返回…" : "← 回到书库总览"}</button>}
    </> : <>
      <p className="book-library-note">一次选择多份“最终输出”，每个文件创建一本小说、一个独立项目。</p>
      <label className="book-library-upload"><input type="file" accept=".txt,.md,text/plain,text/markdown" multiple disabled={busy} aria-label="批量选择最终输出文件" onChange={event => { void chooseFiles(event); }} /><span>{pending === "read" ? "正在读取…" : "批量选择 TXT / Markdown"}</span><small>可一次导入 10 本，每次最多 {limits.maxFiles} 本</small></label>
      {selected.length > 0 && <div className="book-library-selection"><strong>待导入 {selected.length} 本</strong><ul>{selected.map(file => <li key={file.key}><span title={file.filename}>{file.filename}</span><input value={file.title ?? ""} maxLength={120} placeholder="书名（留空自动识别）" aria-label={`${file.filename} 书名`} disabled={busy} onChange={event => { const title = event.target.value; setSelected(current => current.map(item => item.key === file.key ? { ...item, title } : item)); }} /><button type="button" disabled={busy} aria-label={`移除 ${file.filename}`} onClick={() => { setSelected(current => current.filter(item => item.key !== file.key)); }}>移除</button></li>)}</ul><button className="book-library-primary" type="button" disabled={busy} onClick={() => { void importFiles(); }}>{pending === "import" ? "正在拆解各本小说…" : pending === "register" ? "正在添加 Harness 项目…" : `导入并创建 ${String(selected.length)} 本小说`}</button></div>}
    </>}
    {notice !== undefined && <p className="book-library-notice" role="status">{notice}</p>}
    {visibleResults.some(result => result.status === "failed") && <details className="book-library-results" open><summary>导入问题 · {visibleResults.filter(result => result.status === "failed").length} 项</summary><ul>{visibleResults.filter(result => result.status === "failed").map((result, index) => <li key={`${result.filename}:${String(index)}`}><strong>{result.filename}</strong><span>{result.error}</span></li>)}</ul></details>}
    {snapshot !== undefined && !snapshot.isBookProject && <section className="book-library-batch" aria-label="书库批量生成">
      <h3>所有项目一键生成</h3>
      <p className="book-library-note">书与书同时生成，每本书内部逐章续写；各书文风和前文独立关联。</p>
      {queueError !== undefined && <p className="book-library-error" role="alert">{queueError}</p>}
      <label>书间并发 <select aria-label="书间并发模式" disabled={busy || !queueControls.canStart} value={concurrency === "all" ? "all" : "custom"} onChange={event => { setConcurrency(event.target.value === "all" ? "all" : "1"); }}><option value="all">全部项目同时生成（不限并发）</option><option value="custom">自定义并发数</option></select></label>
      {concurrency !== "all" && <input aria-label="同时生成的书数" type="number" min="1" step="1" disabled={busy || !queueControls.canStart} value={concurrency} onChange={event => { setConcurrency(event.target.value); }} />}
      <div className="book-library-batch-starts">
        <button type="button" disabled={busy || !queueControls.canStart || !visibleBooks.some(canOpenLibraryBook) || task === undefined || queueError !== undefined} onClick={() => { void queueAction("start", 10); }}>所有项目新增 10 章</button>
        <button type="button" disabled={busy || !queueControls.canStart || !visibleBooks.some(canOpenLibraryBook) || task === undefined || queueError !== undefined} onClick={() => { void queueAction("start", 20); }}>所有项目新增 20 章</button>
        <button className="book-library-primary" type="button" disabled={busy || !queueControls.canStart || !visibleBooks.some(canOpenLibraryBook) || task === undefined || queueError !== undefined} onClick={() => { void queueAction("start", "all"); }}>所有项目写至完本</button>
      </div>
      {task !== undefined && task !== null && visibleTaskBooks.length > 0 && <div className="book-library-queue" data-status={task.status}>
        <div className="book-library-queue-heading"><strong>{STATUS[task.status] ?? task.status}</strong><span>{doneBooks} / {visibleTaskBooks.length} 本完成{failedBooks > 0 ? ` · ${String(failedBooks)} 本待处理` : ""}</span></div>
        <p>本批书间并发：{task.concurrency === "all" ? "全部项目" : task.concurrency ?? 1} · 生成中 {visibleTaskBooks.filter(book => book.status === "running").length} 本</p>
        <progress aria-label="本批书项目进度" value={doneBooks} max={visibleTaskBooks.length} />
        {task.error !== undefined && visibleTaskBooks.length === task.books.length && <p className="book-library-error" role="alert">{task.error}</p>}
        {differentOwner && <p className="book-library-note">本批由另一个书库会话启动，请回到该会话管理任务。</p>}
        <div className="book-library-queue-actions">
          {differentOwner && navigation.openSession !== undefined && <button type="button" disabled={busy} onClick={() => { void openQueueOwner(); }}>回到书库任务会话</button>}
          {queueControls.canPause && <button type="button" disabled={busy} onClick={() => { void queueAction("pause"); }}>本章后暂停所有项目</button>}
          {queueControls.resumeLabel !== undefined && <button type="button" disabled={busy} onClick={() => { void queueAction("resume"); }}>{queueControls.resumeLabel}</button>}
          {queueControls.canStop && <button type="button" disabled={busy} onClick={() => { void queueAction("stop"); }}>停止所有项目</button>}
        </div>
        {task.status === "pausing" && <p className="book-library-note">当前章保存后暂停，不再启动下一章或下一本。</p>}
        <details className="book-library-queue-details" open={task.status === "blocked" || failedBooks > 0}><summary>查看各书进度</summary><ol aria-label="本批项目进度">{visibleTaskBooks.map(book => <li key={book.id} data-active={book.status === "running" ? "true" : "false"}><strong>{book.title}</strong><span>{book.status === "skipped" ? "已达到大纲末尾" : `第 ${String(book.startChapter)}—${String(book.targetChapter)} 章 · 本批已保存 ${String(book.completedChapters)} 章`}</span><em>{({ pending: "等待开始", running: "生成中", completed: "完成", failed: "需要处理", skipped: "无需新增" } as const)[book.status]}</em>{book.error !== undefined && <p className="book-library-error">{book.error}</p>}</li>)}</ol></details>
        <p className="book-library-note">本批已保存在 Harness。关闭页面不会停止生成；退出应用后可在这里继续。</p>
      </div>}
    </section>}
    {snapshot !== undefined && !snapshot.isBookProject && <section className="book-library-manage" aria-label="批量导出与整理">
      <h3>导出与整理</h3>
      <div className="book-library-queue-actions">
        <button type="button" disabled={busy} onClick={() => { setCheckedBooks(visibleBooks.map(book => book.id)); }}>全选书项目</button>
        <button type="button" disabled={busy} onClick={() => { setCheckedBooks(visibleBooks.filter(book => book.totalChapters > 0 && book.completedChapters >= book.totalChapters && book.status === "completed").map(book => book.id)); }}>选择已完本</button>
        <button type="button" disabled={busy} onClick={() => { setCheckedBooks([]); }}>取消选择</button>
      </div>
      <p>已选 {visibleSelectedIds.length} 本</p>
      <div className="book-library-queue-actions">
        <button type="button" disabled={busy || visibleSelectedIds.length === 0} onClick={() => { void manageBooks("export", visibleSelectedIds); }}>{pending === "export" ? "正在打包正文…" : "批量导出 TXT"}</button>
        <button type="button" disabled={busy || visibleSelectedIds.length === 0} onClick={() => { void manageBooks("delete", visibleSelectedIds); }}>删除所选书</button>
      </div>
      <p className="book-library-note">每本书一个ZIP，里面每章一个TXT；多本书再合成总包下载。未完结的书导出已保存章节；导出不删除原稿。</p>
      <p className="book-library-note">删除后无法恢复，不进入回收站。</p>
      <div className="book-library-manage-feedback" aria-live="polite" aria-atomic="true">
        {pending === "delete" && <p className="book-library-notice" role="status">正在提交删除，所选书已从列表移除…</p>}
        {manageNotice !== undefined && <p className="book-library-notice" role="status">{manageNotice}</p>}
        {manageError !== undefined && <p className="book-library-error" role="alert">{manageError}</p>}
      </div>
      {visibleArchivedBooks.length > 0 && <details><summary>旧版回收站 · {visibleArchivedBooks.length} 本</summary><p className="book-library-note">旧版移入回收站的书仍占用磁盘。可勾选后导出或永久删除；新版删除不再保留回收站副本。</p>{visibleArchivedBooks.map(book => <article key={book.id}>
        <input type="checkbox" aria-label={`选择旧版回收站中的 ${book.title}`} checked={checkedBooks.includes(book.id)} disabled={busy} onChange={event => { const checked = event.target.checked; setCheckedBooks(current => checked ? [...new Set([...current, book.id])] : current.filter(id => id !== book.id)); }} />
        <strong>{book.title}</strong><span>已保存 {book.completedChapters} 章</span>
        <button type="button" disabled={busy} aria-label={`永久删除 ${book.title}`} onClick={() => { void manageBooks("delete", [book.id]); }}>永久删除</button>
        <button type="button" disabled={busy} aria-label={`导出 ${book.title}`} onClick={() => { void manageBooks("export", [book.id]); }}>导出TXT</button>
      </article>)}</details>}

    </section>}
    {snapshot !== undefined && <div className="book-library-books" role="list" aria-label="小说项目列表">{visibleBooks.map(book => <article key={book.id} role="listitem" className="book-library-book">{!snapshot.isBookProject && <input type="checkbox" aria-label={`选择 ${book.title}`} checked={checkedBooks.includes(book.id)} disabled={busy} onChange={event => { const checked = event.target.checked; setCheckedBooks(current => checked ? [...new Set([...current, book.id])] : current.filter(id => id !== book.id)); }} />}<div><strong title={book.title}>{book.title}</strong><span>{book.completedChapters} / {book.totalChapters} 章 · {STATUS[book.status] ?? book.status}</span></div>{!snapshot.isBookProject && <button type="button" disabled={busy || !canOpenLibraryBook(book)} onClick={() => { void openBook(book); }}>{pending === book.id ? "正在打开…" : "打开"}</button>}{book.error !== undefined && <p className="book-library-error">{book.error}</p>}{registrations[book.id]?.error !== undefined && <div className="book-library-error">文件已保存，Harness 项目登记未完成：{registrations[book.id]?.error}<button type="button" disabled={busy || !canOpenLibraryBook(book)} onClick={() => { void retryRegister(book); }}>重试登记项目</button></div>}</article>)}</div>}
    {snapshot !== undefined && visibleBooks.length === 0 && <p className="book-library-empty">这里还没有书项目。批量导入后，每本书会出现在这里和 Harness 工作区列表中。</p>}
  </section>;
}
