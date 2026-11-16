/** History keeps its native owner even when the current session may start the next batch. */
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
