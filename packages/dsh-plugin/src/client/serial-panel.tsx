import { useCallback, useEffect, useId, useRef, useState } from "react";
import { endpoint } from "./workbench-ui.js";
import { serialPanelActions } from "./serial-panel-state.js";

interface SerialTaskView {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly status: "running" | "pausing" | "paused" | "blocked" | "stopped" | "completed";
  readonly startChapter: number;
  readonly targetChapter: number;
  readonly nextChapter: number;
  readonly completed: readonly number[];
  readonly active?: { readonly chapter: number; readonly attempt: number; readonly sessionId: string };
  readonly error?: string;
  readonly updatedAt: string;
}

interface SerialOutlineView {
  readonly title: string;
  readonly totalChapters: number;
  readonly chapters: readonly number[];
  readonly issues?: readonly { readonly line?: number; readonly field?: string; readonly message: string; readonly severity: string }[];
}

interface SerialPayload {
  readonly task: SerialTaskView | null;
  readonly outline?: SerialOutlineView;
}

const STATUS_LABELS: Record<SerialTaskView["status"], string> = {
  running: "正在连载",
  pausing: "本章结束后暂停",
  paused: "已暂停",
  blocked: "需要处理",
  stopped: "已停止",
  completed: "本批完成"
};

async function payloadOf(response: Response): Promise<SerialPayload> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : `请求失败（HTTP ${String(response.status)}）`;
    throw new Error(message);
  }
  if (typeof body !== "object" || body === null || !("task" in body)) throw new Error("工作台返回的数据不完整，请刷新后重试。");
  return body as SerialPayload;
}

/** The browser only observes the Host queue. Closing this surface never owns or cancels a run. */
export function SerialPanel({ sessionId, onWorkspaceChanged, onOpenSession, welcome = false }: {
  readonly sessionId: string;
  readonly onWorkspaceChanged: () => void;
  readonly onOpenSession: (ownerSessionId: string, childSessionId: string) => Promise<void>;
  readonly welcome?: boolean;
}) {
  const id = useId();
  const [snapshot, setSnapshot] = useState<SerialPayload>();
  const [expanded, setExpanded] = useState(welcome);
  const [count, setCount] = useState(10);
  const [divergence, setDivergence] = useState(0);
  const [untilEnd, setUntilEnd] = useState(false);
  const [minChars, setMinChars] = useState("2300");
  const [maxChars, setMaxChars] = useState("2500");
  const [style, setStyle] = useState("");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const mounted = useRef(true);
  const revision = useRef(0);
  const observedRevision = useRef<string>();
  const changed = useRef(onWorkspaceChanged);
  changed.current = onWorkspaceChanged;

  const accept = useCallback((value: SerialPayload): void => {
    if (!mounted.current) return;
    setSnapshot(value);
    const stamp = `${value.outline?.title ?? ""}|${String(value.outline?.totalChapters ?? 0)}|${value.task?.id ?? ""}|${value.task?.completed.join(",") ?? ""}|${value.task?.status ?? ""}`;
    if (observedRevision.current !== undefined && observedRevision.current !== stamp) changed.current();
    observedRevision.current = stamp;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      const current = revision.current;
      try {
        const value = await payloadOf(await fetch(endpoint("serial", sessionId), { signal: controller.signal }));
        if (!controller.signal.aborted && current === revision.current) { accept(value); setLoadError(undefined); }
      } catch (reason: unknown) {
        if (!controller.signal.aborted && current === revision.current) setLoadError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void read(); }, 3000);
      }
    };
    void read();
    return () => { mounted.current = false; controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [accept, sessionId]);

  const act = async (action: string, fields: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    if (pending !== undefined) return;
    revision.current += 1;
    setPending(action);
    setError(undefined);
    try {
      const value = await payloadOf(await fetch(endpoint("serial", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...fields })
      }));
      if (!mounted.current) return;
      accept(value);
      setExpanded(true);
      setLoadError(undefined);
    } catch (reason: unknown) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      revision.current += 1;
      if (mounted.current) setPending(undefined);
    }
  };

  const openCurrentChapter = async (): Promise<void> => {
    const current = snapshot?.task;
    if (current?.active === undefined || pending !== undefined) return;
    setPending("open-session");
    setError(undefined);
    try { await onOpenSession(current.ownerSessionId, current.active.sessionId); }
    catch (reason: unknown) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setPending(undefined); }
  };

  const openTaskSession = async (): Promise<void> => {
    const current = snapshot?.task;
    if (current === undefined || current === null || pending !== undefined) return;
    setPending("open-owner");
    setError(undefined);
    try { await onOpenSession(current.ownerSessionId, current.ownerSessionId); }
    catch (reason: unknown) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setPending(undefined); }
  };

  const download = async (): Promise<void> => {
    if (pending !== undefined) return;
    setPending("export");
    setError(undefined);
    try {
      const response = await fetch(endpoint("serial/export", sessionId));
      if (!response.ok) { await payloadOf(response); return; }
      const body = await response.blob();
      if (!mounted.current) return;
      const url = URL.createObjectURL(body);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(snapshot?.outline?.title || "长篇连载").replace(/[\\/:*?"<>|]/gu, "_")}-已完成.txt`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
    } catch (reason: unknown) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (mounted.current) setPending(undefined); }
  };

  const task = snapshot?.task;
  const controls = serialPanelActions(task, sessionId);
  const differentSession = controls.differentOwner;
  const running = task?.status === "running" || task?.status === "pausing";
  const total = task === undefined || task === null ? 0 : task.targetChapter - task.startChapter + 1;
  const done = task?.completed.length ?? 0;
  const progress = total > 0 ? Math.min(100, Math.round(done * 100 / total)) : 0;
  const busy = pending !== undefined;
  const titleText = snapshot?.outline?.title || "长篇连载";
  const canStart = snapshot !== undefined && snapshot.outline !== undefined && controls.canStartNewBatch && !busy;
  const customLength = minChars !== "" || maxChars !== "";
  const invalidLength = customLength && (minChars === "" || maxChars === "" || !Number.isInteger(Number(minChars)) || !Number.isInteger(Number(maxChars)) || Number(minChars) < 500 || Number(maxChars) < Number(minChars) || Number(maxChars) > 20000);

  return <section className={`oh-serial-panel${welcome ? " oh-serial-panel-welcome" : ""}`} aria-label="长篇批量生成" data-status={task?.status ?? "ready"}>
    <div className="oh-serial-heading">
      <button className="oh-serial-toggle" type="button" aria-expanded={expanded} aria-controls={`${id}-body`} onClick={() => { setExpanded(!expanded); }}>
        <span className="oh-serial-mark" aria-hidden>连</span>
        <span className="oh-serial-heading-copy"><strong>长篇连载</strong><small>{snapshot?.outline === undefined ? "选择 10 / 20 / 50 章，或生成全本" : `${titleText} · ${String(snapshot.outline.totalChapters)} 章大纲`}</small></span>
        <span className="oh-serial-chevron" aria-hidden>{expanded ? "⌃" : "⌄"}</span>
      </button>
      {task !== undefined && task !== null && <span className="oh-serial-badge" role="status"><i aria-hidden />{STATUS_LABELS[task.status]}{!expanded && total > 0 ? ` ${String(done)}/${String(total)}` : ""}</span>}
    </div>
    <div id={`${id}-body`} className="oh-serial-body" hidden={!expanded}>
      <p className="oh-serial-note">沿用当前 Harness 模型，每章新建独立写作会话，自动带入完整文风与前 10 章正文（不足 10 章时读取已有正文）。保存、检查后继续。</p>
      {(loadError !== undefined || error !== undefined) && <div className="oh-serial-alert" role="alert">{error ?? loadError}</div>}
      {snapshot === undefined && loadError === undefined && <p className="oh-serial-note" role="status">正在读取连载进度…</p>}

      {task !== undefined && task !== null && <div className="oh-serial-progress-card">
        <div className="oh-serial-progress-caption"><span>本批第 {task.startChapter}—{task.targetChapter} 章</span><strong>{done}<small> / {total} 章已验收</small></strong></div>
        <progress max={total || 1} value={done} aria-label="本批已验收章节" />
        <div className="oh-serial-progress-meta"><span>{task.status === "completed" ? "本批章节已保存并通过检查" : task.status === "stopped" ? `本批已停止 · 下一章为第 ${String(task.nextChapter)} 章` : task.active !== undefined ? `正在处理第 ${String(task.active.chapter)} 章 · 第 ${String(task.active.attempt)} 次尝试` : `下一章：第 ${String(task.nextChapter)} 章`}</span><span>{progress}%</span></div>
        {task.error !== undefined && <div className="oh-serial-task-error" role="alert">{task.error}</div>}
        {differentSession && <p className="oh-serial-note">这批任务属于另一会话。恢复或管理原批次请点击「回到任务会话」；已结束的历史批次不影响你在当前会话开始新批次。</p>}
        {task.status === "blocked" && <p className="oh-serial-note">请先查看上方错误；点击「查看当前章会话」查看日志、轨迹并处理审批。处理后点击「重试并继续」，已验收章节会保留。</p>}
        {controls.stoppedWithRemaining && <p className="oh-serial-note">停止后保留原批次进度和未验收稿。点击「恢复这批」继续同一批次；未验收稿会先按原任务检查或修订。</p>}
        <div className="oh-serial-actions">
          {differentSession && <button className="oh-serial-primary" type="button" disabled={busy} onClick={() => { void openTaskSession(); }}>{pending === "open-owner" ? "正在打开…" : "回到任务会话"}</button>}
          {task.active !== undefined && <button type="button" disabled={busy} onClick={() => { void openCurrentChapter(); }}>{pending === "open-session" ? "正在打开…" : "查看当前章会话"}</button>}
          {task.status === "running" && <button type="button" disabled={busy || differentSession} onClick={() => { void act("pause"); }}>{pending === "pause" ? "正在暂停…" : "本章后暂停"}</button>}
          {task.status === "pausing" && <span className="oh-serial-note">本章保存后暂停，不再启动下一章。</span>}
          {controls.canResume && <button className="oh-serial-primary" type="button" disabled={busy || differentSession} onClick={() => { void act("resume"); }}>{pending === "resume" ? "正在恢复…" : task.status === "blocked" ? "重试并继续" : task.status === "stopped" ? "恢复这批" : "继续本批"}</button>}
          {(running || task.status === "blocked" || task.status === "paused") && <button className="oh-serial-stop" type="button" disabled={busy || differentSession} onClick={() => { void act("stop"); }}>{pending === "stop" ? "正在停止…" : "立即停止"}</button>}
          {controls.retryStop && <button className="oh-serial-stop" type="button" disabled={busy || differentSession} onClick={() => { void act("stop"); }}>{pending === "stop" ? "正在重试停止…" : "重试停止"}</button>}
          <a className="oh-serial-export" href={endpoint("serial/export", sessionId)} aria-disabled={busy} onClick={(event) => { event.preventDefault(); void download(); }} download>{pending === "export" ? "正在导出…" : "导出已完成 TXT ↗"}</a>
        </div>
      </div>}

      <div className="oh-serial-generate">
        <fieldset disabled={busy || !controls.canStartNewBatch}>
          <legend>本次生成</legend>
          <div className="oh-serial-counts" role="group" aria-label="本次生成章数">
            {[10, 20, 50].map((value) => <button type="button" key={value} aria-pressed={!untilEnd && count === value} onClick={() => { setCount(value); setUntilEnd(false); }}>{value} 章</button>)}
            <button type="button" aria-pressed={untilEnd} onClick={() => { setUntilEnd(true); }}>生成全本</button>
          </div>
          <details className="oh-serial-settings"><summary>写作设置</summary><label className="oh-serial-field oh-serial-divergence" htmlFor={`${id}-divergence`}>发散级别<select id={`${id}-divergence`} value={divergence} onChange={(event) => { setDivergence(Number(event.target.value)); }}><option value={0}>0 · 严格遵守章纲</option><option value={1}>1 · 允许补充细节</option><option value={2}>2 · 允许补充次要情节</option></select></label><div className="oh-serial-word-range"><label>最少<input type="number" min="500" max="20000" step="100" value={minChars} placeholder="默认" onChange={(event) => { setMinChars(event.target.value); }} /></label><span>—</span><label>最多<input type="number" min="500" max="20000" step="100" value={maxChars} placeholder="默认" onChange={(event) => { setMaxChars(event.target.value); }} /></label><span>字</span></div><label className="oh-serial-field oh-serial-style" htmlFor={`${id}-style`}>本书文风补充<textarea id={`${id}-style`} value={style} maxLength={4000} rows={3} placeholder="例如：第三人称有限视角，多用行动与对话推进，少解释情绪。" onChange={(event) => { setStyle(event.target.value); }} /></label><p className="oh-serial-note">默认每章 2300—2500 字；可调整上下限，或同时留空恢复默认。</p><button type="button" className="oh-serial-test-one" aria-pressed={!untilEnd && count === 1} onClick={() => { setCount(1); setUntilEnd(false); }}>只试写 1 章</button></details>
        </fieldset>
        {invalidLength && <p className="oh-serial-task-error">请设置 500—20000 字范围，最多字数不能小于最少字数。</p>}
        <button className="oh-serial-primary oh-serial-start" type="button" disabled={!canStart || invalidLength} onClick={() => { void act("start", { count: untilEnd ? "all" : count, divergence, ...(customLength ? { minChars: Number(minChars), maxChars: Number(maxChars) } : {}), ...(style.trim() === "" ? {} : { style: style.trim() }) }); }}>{pending === "start" ? "正在启动…" : untilEnd ? "一键生成 · 全本" : `一键生成 · ${String(count)} 章`}</button>
        {snapshot?.outline === undefined && <p className="oh-serial-note">先导入章纲，再开始生成。模型可在 Harness 的「设置 → 模型」中配置。</p>}
      </div>

      {snapshot?.outline?.issues !== undefined && snapshot.outline.issues.length > 0 && <details className="oh-serial-issues"><summary>大纲检查提示 · {snapshot.outline.issues.length} 项</summary><ul>{snapshot.outline.issues.map((issue, index) => <li key={`${String(issue.line)}-${String(index)}`}>{issue.line !== undefined ? `第 ${String(issue.line)} 行：` : ""}{issue.message}</li>)}</ul></details>}
      <p className="oh-serial-footnote">每章完成后自动保存。关闭此页面不影响生成；退出 Harness 后重新打开原项目，再继续本批。</p>
    </div>
  </section>;
}
