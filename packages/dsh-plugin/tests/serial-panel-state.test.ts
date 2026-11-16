import { describe, expect, it } from "vitest";
import { serialPanelActions, type SerialPanelTaskState } from "../src/client/serial-panel-state.js";

const task = (status: SerialPanelTaskState["status"], overrides: Partial<SerialPanelTaskState> = {}): SerialPanelTaskState => ({ ownerSessionId: "original-owner", status, nextChapter: 4, targetChapter: 10, ...overrides });

describe("native owner controls after a batch ends", () => {
  it.each(["completed", "stopped"] as const)("allows a new session to start after %s without taking over the historical batch", status => {
    const actions = serialPanelActions(task(status), "new-owner");
    expect(actions.canStartNewBatch).toBe(true);
    expect(actions.differentOwner).toBe(true);
    expect(actions.canControlExisting).toBe(false);
  });
  it.each(["running", "pausing", "paused", "blocked"] as const)("does not open a second batch while the original is %s", status => {
    expect(serialPanelActions(task(status), "new-owner").canStartNewBatch).toBe(false);
    expect(serialPanelActions(task(status), "original-owner").canStartNewBatch).toBe(false);
  });
  it("exposes explicit resume for a stopped batch with remaining chapters and retains owner protection", () => {
    expect(serialPanelActions(task("stopped"), "original-owner")).toMatchObject({ canResume: true, canControlExisting: true, stoppedWithRemaining: true });
    expect(serialPanelActions(task("stopped"), "new-owner")).toMatchObject({ canResume: true, canControlExisting: false, differentOwner: true });
    expect(serialPanelActions(task("stopped", { nextChapter: 11 }), "original-owner").canResume).toBe(false);
  });
  it("requires retrying a failed cancellation before resume or a new batch", () => {
    const failed = task("stopped", { error: "停止请求尚未完成：原生会话仍在运行" });
    expect(serialPanelActions(failed, "original-owner")).toMatchObject({ retryStop: true, canResume: false, canStartNewBatch: false, canControlExisting: true });
    expect(serialPanelActions(failed, "new-owner").canControlExisting).toBe(false);
  });
  it("allows the first batch without inventing a historical owner", () => {
    expect(serialPanelActions(null, "new-owner")).toMatchObject({ canStartNewBatch: true, differentOwner: false, canResume: false, retryStop: false });
  });
});
