import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { PropsRenderSlots, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildFileTree, type FileTreeNode } from "./file-tree.js";
import { JsonlPreview } from "./jsonl-preview.js";
import { MarkdownPreview } from "./markdown-preview.js";
import { endpoint } from "./workbench-ui.js";
import { isInternalRecordPath } from "../novel-paths.js";
import { SERIAL_PLUGIN_VERSION } from "../plugin-version.js";
import { chapterTitlePreview, chapterTitleRecordPath, proseChapterNumber, type ChapterTitlePreview } from "./chapter-title-preview.js";
import { SerialPanel } from "./serial-panel.js";
import { BookLibraryPanel, type NativeBookNavigation } from "./book-library-panel.js";
import { openSerialChapterSession, type SerialWorkspaceNavigation } from "./serial-navigation.js";
import serialStyles from "./serial-panel.css?inline";
import styles from "./novel-workbench.css?inline";

export const name = "oh-story";
export const inject = ["slots", "sessions"];
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap { "oh-story.workspace": { kind: "single"; scope: "session" } }
}
interface WorkspaceFile { readonly path: string; readonly bytes: number; readonly version: string; readonly kind: "text" | "media" }
interface WorkspacePayload { readonly cwd: string; readonly files: readonly WorkspaceFile[]; readonly metadataErrors: readonly string[]; readonly pluginVersion?: string }
interface FilePayload { readonly path: string; readonly content: string; readonly bytes: number; readonly version: string }
interface Draft { readonly content: string; readonly saved: string; readonly version: string; readonly saving?: boolean; readonly error?: string }
interface EditorMemory { selected?: string; drafts: Record<string, Draft>; mode: "preview" | "source" }
const memories = new Map<string, EditorMemory>();
const GROUPS = ["正文", "大纲", "设定", "追踪"] as const;

async function json<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(typeof body === "object" && body !== null && "error" in body ? String(body.error) : `请求失败（HTTP ${String(response.status)}）`);
  return body as T;
}
function preference(cwd: string | undefined): boolean | undefined {
  if (cwd === undefined) return undefined;
  try { const value = globalThis.localStorage.getItem(`oh-story.novel-open.${cwd}`); return value === null ? undefined : value === "true"; }
  catch { return undefined; }
}
function FileNodes({ nodes, selected, onSelect }: { readonly nodes: readonly FileTreeNode[]; readonly selected: string | undefined; readonly onSelect: (path: string) => void }) {
  return <>{nodes.map(node => node.kind === "directory"
    ? <details key={node.path}><summary>{node.name}<small>{node.fileCount}</small></summary><FileNodes nodes={node.children} selected={selected} onSelect={onSelect} /></details>
    : <button key={node.path} type="button" aria-label={node.path} aria-current={selected === node.path ? "true" : undefined} onClick={() => { onSelect(node.path); }}>{node.name}</button>)}</>;
}
interface Navigation {
  readonly openSerialSession: (owner: string, child: string) => Promise<void>;
  readonly bookNavigation: NativeBookNavigation;
}
type WorkbenchProps = PropsRuntime<"oh-story.workspace"> & Navigation;

/** A separate cache for each native session keeps unsaved drafts attached to their book. */
function NovelWorkbench({ sessionId, blank, openSerialSession, bookNavigation }: { readonly sessionId: string; readonly blank: boolean } & Navigation) {
  const remembered = useRef<EditorMemory>(memories.get(sessionId) ?? { drafts: {}, mode: "preview" });
  const [selected, setSelected] = useState(remembered.current.selected);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(remembered.current.drafts);
  const [mode, setMode] = useState<"preview" | "source">(remembered.current.mode);
  const [archived, setArchived] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspacePayload>();
  const [error, setError] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [titlePreview, setTitlePreview] = useState<{ readonly path: string; readonly savedProse: string; readonly value: ChapterTitlePreview }>();
  const [chosenOpen, setChosenOpen] = useState<boolean>();
  const [version, setVersion] = useState(0);
  const draftRef = useRef(drafts);
  draftRef.current = drafts;
  const saving = useRef(new Set<string>());
  const reload = useCallback(() => { setVersion(current => current + 1); }, []);
  const storedOpen = useMemo(() => preference(workspace?.cwd), [workspace?.cwd]);
  const open = chosenOpen ?? storedOpen ?? (blank || (workspace?.files.length ?? 0) > 0);
  useEffect(() => { memories.set(sessionId, { drafts, mode, ...(selected === undefined ? {} : { selected }) }); }, [drafts, mode, selected, sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint("workspace", sessionId), { signal: controller.signal }).then(json<WorkspacePayload>).then(value => { if (!controller.signal.aborted) { setWorkspace(value); setError(undefined); } }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { controller.abort(); };
  }, [sessionId, version]);
  useEffect(() => { if (!open) return; const timer = setInterval(reload, 5000); return () => { clearInterval(timer); }; }, [open, reload]);
  const files = useMemo(() => workspace?.files.filter(file => file.kind === "text") ?? [], [workspace]);
  const isBookProject = files.some(file => file.path === "追踪/书项目.json" || file.path.startsWith("大纲/") || file.path.startsWith("正文/"));
  const readOnlyRecord = selected !== undefined && isInternalRecordPath(selected);
  useEffect(() => {
    if (selected !== undefined || files.length === 0) return;
    const first = files.find(file => file.path.startsWith("正文/")) ?? files.find(file => file.path === "大纲/大纲规划.md") ?? files.find(file => !isInternalRecordPath(file.path));
    if (first !== undefined) setSelected(first.path);
  }, [files, selected]);
  const diskVersion = files.find(file => file.path === selected)?.version;
  useEffect(() => {
    if (selected === undefined) return;
    const prior = draftRef.current[selected];
    if (prior !== undefined && (prior.content !== prior.saved || prior.version === diskVersion)) return;
    const controller = new AbortController();
    setFileError(undefined);
    void fetch(endpoint("file", sessionId, selected), { signal: controller.signal }).then(json<FilePayload>).then(file => {
      if (controller.signal.aborted) return;
      setDrafts(current => {
        const latest = current[selected];
        if (latest !== undefined && latest.content !== latest.saved) return current;
        return { ...current, [selected]: { content: file.content, saved: file.content, version: file.version } };
      });
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setFileError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { controller.abort(); };
  }, [diskVersion, selected, sessionId]);
  const setOpen = (value: boolean): void => {
    setChosenOpen(value);
    if (workspace !== undefined) { try { globalThis.localStorage.setItem(`oh-story.novel-open.${workspace.cwd}`, String(value)); } catch { /* Session-local choice still works. */ } }
  };
  const save = async (): Promise<void> => {
    if (selected === undefined || isInternalRecordPath(selected) || saving.current.has(selected)) return;
    const path = selected;
    const submitted = draftRef.current[path];
    if (submitted === undefined || submitted.content === submitted.saved) return;
    saving.current.add(path);
    setDrafts(current => ({ ...current, [path]: { ...submitted, saving: true } }));
    try {
      const file = await json<FilePayload>(await fetch(endpoint("file", sessionId, path), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: submitted.content, baseVersion: submitted.version }) }));
      setDrafts(current => ({ ...current, [path]: { content: current[path]?.content ?? file.content, saved: file.content, version: file.version } }));
      reload();
    } catch (reason: unknown) {
      setDrafts(current => ({ ...current, [path]: { ...(current[path] ?? submitted), saving: false, error: `${reason instanceof Error ? reason.message : String(reason)}；编辑稿已保留。` } }));
    } finally { saving.current.delete(path); }
  };
  const reloadFile = async (): Promise<void> => {
    if (selected === undefined) return;
    const path = selected;
    try { const file = await json<FilePayload>(await fetch(endpoint("file", sessionId, path))); setDrafts(current => ({ ...current, [path]: { content: file.content, saved: file.content, version: file.version } })); setFileError(undefined); }
    catch (reason: unknown) { setFileError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const draft = selected === undefined ? undefined : drafts[selected];
  const dirty = draft !== undefined && draft.content !== draft.saved;
  const chapter = proseChapterNumber(selected);
  const titlePath = chapter === undefined ? undefined : chapterTitleRecordPath(chapter);
  const titleVersion = files.find(file => file.path === titlePath)?.version;
  useEffect(() => {
    if (selected === undefined || chapter === undefined || draft === undefined || titlePath === undefined) { setTitlePreview(undefined); return; }
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      const content = titleVersion === undefined ? undefined : (await json<FilePayload>(await fetch(endpoint("file", sessionId, titlePath), { signal: controller.signal }))).content;
      const value = await chapterTitlePreview(content, chapter, draft.saved);
      if (!controller.signal.aborted) setTitlePreview({ path: selected, savedProse: draft.saved, value });
    };
    void load().catch((reason: unknown) => {
      if (!controller.signal.aborted) setTitlePreview({ path: selected, savedProse: draft.saved, value: { kind: "invalid", message: `公众号标题暂时无法读取：${reason instanceof Error ? reason.message : String(reason)}` } });
    });
    return () => { controller.abort(); };
  }, [chapter, draft?.saved, selected, sessionId, titlePath, titleVersion]);
  const currentTitlePreview = titlePreview !== undefined && titlePreview.path === selected && titlePreview.savedProse === draft?.saved ? titlePreview.value : undefined;
  const versionMismatch = workspace !== undefined && workspace.pluginVersion !== SERIAL_PLUGIN_VERSION;
  const reading = (
        <section className="novel-reading" aria-label="章节与正文">
          <header className="novel-reading-toolbar"><h2>{isBookProject ? "章节与资料" : "运行记录（只读）"}</h2><button type="button" onClick={reload}>刷新项目文件</button></header>
          <div className="novel-document-layout">
            <nav className="novel-file-tree" aria-label="小说项目文件">
              {GROUPS.map(group => { const grouped = files.filter(file => file.path.startsWith(`${group}/`)); return grouped.length === 0 ? null : <details key={group} open={group === "正文"}><summary>{group}<small>{grouped.length}</small></summary><FileNodes nodes={buildFileTree(grouped, group)} selected={selected} onSelect={setSelected} /></details>; })}
              {files.length === 0 && <p className="novel-muted">导入后，这里会出现每章大纲和正文。</p>}
            </nav>
            <div className="novel-editor">
              <div className="novel-file-toolbar"><strong title={selected}>{selected ?? "正文预览"}{dirty ? " · 未保存" : ""}</strong>{!readOnlyRecord && <div role="group" aria-label="文稿查看方式"><button type="button" aria-pressed={mode === "preview"} onClick={() => { setMode("preview"); }}>预览</button><button type="button" aria-pressed={mode === "source"} onClick={() => { setMode("source"); }}>编辑</button></div>}{readOnlyRecord && <span className="novel-readonly-label">只读记录 · 工作台自动维护</span>}{mode === "source" && !readOnlyRecord && <button type="button" disabled={!dirty || draft?.saving === true} onClick={() => { void save(); }}>{draft?.saving === true ? "保存中…" : "保存"}</button>}</div>
              {(fileError !== undefined || draft?.error !== undefined) && <div className="novel-error" role="alert">{fileError ?? draft?.error}<button type="button" onClick={() => { void reloadFile(); }}>重新读取磁盘版本（放弃本页改动）</button></div>}
              {chapter !== undefined && <section className="novel-chapter-titles" aria-label="公众号备选标题"><h3>公众号备选标题</h3>{currentTitlePreview === undefined ? <p>正在读取独立标题…</p> : currentTitlePreview.kind === "candidates" || currentTitlePreview.kind === "legacy" ? <>{currentTitlePreview.kind === "legacy" && <p>旧版保存的标题；新章将独立生成五个候选。</p>}<ol>{currentTitlePreview.titles.map((title, index) => <li key={`${String(index)}-${title}`}>{title}</li>)}</ol><p>导出的章节 TXT 开头会列出以上标题，发布时任选其一。</p>{dirty && <p>以上标题对应已保存正文，当前编辑尚未保存。</p>}</> : <p>{currentTitlePreview.message}</p>}</section>}
              {selected === undefined ? <div className="novel-empty"><strong>{isBookProject ? "从左侧选择章节" : "运行记录仅用于排查问题"}</strong><p>{isBookProject ? "这里可以预览和编辑正文、大纲及设定。" : "日常选书、生成、导出都在上方完成，无需修改这些文件。"}</p></div> : draft === undefined ? <p className="novel-muted">正在读取文稿…</p> : mode === "source" && !readOnlyRecord ? <textarea className="novel-source" aria-label={`${selected} 编辑内容`} value={draft.content} onChange={event => { const content = event.target.value; setDrafts(current => ({ ...current, [selected]: { ...(current[selected] ?? draft), content } })); }} /> : <div className="novel-prose">{selected.endsWith(".jsonl") ? <JsonlPreview content={draft.content} label={selected} /> : <MarkdownPreview content={draft.content} label={selected} />}</div>}
            </div>
          </div>
        </section>
  );
  return <section className="novel-workbench" aria-label="长篇连载工作台" data-open={open ? "true" : "false"}>
    <style>{styles}{serialStyles}</style>
    <header className="novel-header"><div><strong>长篇连载生成器</strong><span>导入最终输出 · 逐章生成 · 自动保存</span><small className="novel-version">运行版本：{workspace?.pluginVersion ?? (workspace === undefined ? "正在读取…" : "旧版服务")} · 界面 {SERIAL_PLUGIN_VERSION}</small></div><button type="button" onClick={() => { setOpen(!open); }}>{open ? "收起工作台" : "打开长篇工作台"}</button></header>
    {versionMismatch && <p className="novel-error" role="alert">工作台界面与后台版本不同。请保存当前工作，完全退出并重新打开 Harness，让新版流程生效。</p>}
    {open && <>
      {error !== undefined && <p className="novel-error" role="alert">{error}</p>}
      <div className="novel-layout" data-view={isBookProject ? "book" : "library"}>
        <aside className="novel-controls">
          <BookLibraryPanel sessionId={sessionId} navigation={bookNavigation} onImported={reload} onAvailabilityChange={setArchived} />
          {!archived && files.some(file => file.path.startsWith("大纲/") || file.path.startsWith("正文/")) && <SerialPanel sessionId={sessionId} onWorkspaceChanged={reload} onOpenSession={openSerialSession} welcome />}
          <section className="novel-model-card"><h2>模型与中转站</h2><p className="novel-muted">在下方 Harness 模型选择器中切换写作模型。新增中转站请打开「设置 → 模型」。</p></section>
        </aside>
        {isBookProject ? reading : files.length > 0 && <details className="novel-library-records"><summary>查看运行记录</summary>{reading}</details>}
      </div>
      <p className="novel-native-note">运行日志与模型设置沿用下方 Harness 会话；当前章节的独立会话可从生成进度中打开。</p>
    </>}
  </section>;
}
function SessionBridge(props: WorkbenchProps) {
  const child = props.useSession(state => state.subagent?.address !== undefined);
  const blank = props.useSessions(state => state.byId[props.sessionId]?.blank === true);
  const marker = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement>();
  useLayoutEffect(() => {
    const document = marker.current?.ownerDocument;
    if (document === undefined || child) return;
    const locate = (): void => { const anchor = document.querySelector<HTMLElement>(`[data-conversation-content][data-conversation-session="${CSS.escape(props.sessionId)}"]:not([data-sidebar-chat] *) [data-conversation-scroll] > [data-slot='conversation.session']`); setTarget(current => current === anchor ? current : anchor ?? undefined); };
    locate();
    const observer = new MutationObserver(locate); observer.observe(document.body, { childList: true, subtree: true }); return () => { observer.disconnect(); };
  }, [child, props.sessionId]);
  return <><span ref={marker} hidden />{child || target === undefined ? null : createPortal(<NovelWorkbench key={props.sessionId} sessionId={props.sessionId} blank={blank} openSerialSession={props.openSerialSession} bookNavigation={props.bookNavigation} />, target)}</>;
}
type SeatProps = PropsRuntime<"shell.overlay"> & PropsRenderSlots<"oh-story.workspace">;
function WorkbenchSeat({ SessionProvider, renderSlot }: SeatProps) { return <SessionProvider empty={() => null}>{renderSlot("oh-story.workspace", {})}</SessionProvider>; }
/** Registers only the long-novel workbench; the host owns chat, models and execution. */
export function apply(context: ClientContext): void {
  context.slots.inject("shell.overlay", () => {
    const seat = context.slots.register({ name: "shell.overlay", id: "oh-story-workspace", order: -100, children: { "oh-story.workspace": { kind: "single", scope: "session" } } }, WorkbenchSeat);
    const workbench = context.slots.register({ name: "oh-story.workspace", inject: () => ({
      openSerialSession: (owner: string, child: string): Promise<void> => openSerialChapterSession(context.sessions as unknown as ISessions, context.get("uiWorkspace") as SerialWorkspaceNavigation | undefined, owner, child),
      bookNavigation: {
        unregister: async (workspaceId: string): Promise<void> => {
          const workspaces = context.get("workspaces") as { delete(id: string): Promise<void> } | undefined;
          if (workspaces === undefined) throw new Error("Harness 工作区列表尚未就绪。");
          await workspaces.delete(workspaceId);
        },
        openSession: (sessionId: string): Promise<void> => openSerialChapterSession(context.sessions as unknown as ISessions, context.get("uiWorkspace") as SerialWorkspaceNavigation | undefined, sessionId, sessionId),
        register: async (path: string, title: string): Promise<string> => {
          const workspaces = context.get("workspaces") as { create(input: { path: string }): Promise<{ workspaceId: string }>; rename(id: string, title: string): Promise<unknown> } | undefined;
          if (workspaces === undefined) throw new Error("Harness 项目列表尚未就绪，请稍后重试。");
          const workspace = await workspaces.create({ path });
          await workspaces.rename(workspace.workspaceId, title);
          return workspace.workspaceId;
        },
        open: async (workspaceId: string): Promise<void> => {
          const navigation = context.get("uiWorkspace") as { openWorkspace(id: string): Promise<void> } | undefined;
          if (navigation === undefined) throw new Error("Harness 项目导航尚未就绪，请稍后重试。");
          await navigation.openWorkspace(workspaceId);
        }
      }
    }) }, SessionBridge);
    return [seat, workbench];
  });
}
export default { name, inject, apply };
