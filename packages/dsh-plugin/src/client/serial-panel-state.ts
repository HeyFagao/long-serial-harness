/** History keeps its native owner even when the current session may start the next batch. */
import type { SerialTask } from "../serial-runtime.js";

export function serialProgressText(task: Pick<SerialTask, "status" | "phase" | "nextChapter"> & {
  readonly active?: { readonly chapter: number; readonly attempt: number };
  readonly titleActive?: { readonly attempt: number };
}): string {
  if (task.status === "completed") return "本批章节已保存并通过检查";
  if (task.phase === "title") {
    const chapter = String(task.nextChapter);
    if (task.status === "paused" || task.status === "stopped") return `第 ${chapter} 章正文已保存 · 标题已暂停，继续时只补标题`;
    if (task.status === "blocked") return `第 ${chapter} 章正文已保存 · 标题等待重试，正文不会重写`;
    if (task.status === "pausing") return `第 ${chapter} 章正文已保存 · 标题完成后暂停`;
    return `正文已保存 · 正在独立生成第 ${chapter} 章公众号标题 · 第 ${String(task.titleActive?.attempt ?? 1)} 次尝试`;
  }
  if (task.status === "stopped") return `本批已停止 · 下一章为第 ${String(task.nextChapter)} 章`;
  if (task.status === "paused") return `已暂停 · 下一章为第 ${String(task.nextChapter)} 章`;
  if (task.status === "blocked") return `第 ${String(task.nextChapter)} 章等待处理`;
  if (task.active !== undefined) return `正在处理第 ${String(task.active.chapter)} 章 · 第 ${String(task.active.attempt)} 次尝试`;
  return `准备第 ${String(task.nextChapter)} 章`;
}

export interface SerialPanelTaskState {
  readonly ownerSessionId: string;
  readonly status: "running" | "pausing" | "paused" | "blocked" | "stopped" | "completed";
  readonly nextChapter: number;
  readonly targetChapter: number;
  readonly error?: string;
}

export function serialPanelActions(task: SerialPanelTaskState | null | undefined, sessionId: string) {
  const differentOwner = task !== undefined && task !== null && task.ownerSessionId !== sessionId;
  const unfinished = task !== undefined && task !== null && task.status !== "completed" && task.status !== "stopped";
  const retryStop = task?.status === "stopped" && task.error?.startsWith("停止请求尚未完成：") === true;
  const stoppedWithRemaining = task?.status === "stopped" && task.nextChapter <= task.targetChapter;
  return {
    differentOwner,
    unfinished,
    canControlExisting: !differentOwner,
    canStartNewBatch: !unfinished && !retryStop,
    canResume: task?.status === "paused" || task?.status === "blocked" || (stoppedWithRemaining && !retryStop),
    stoppedWithRemaining,
    retryStop
  };
}
