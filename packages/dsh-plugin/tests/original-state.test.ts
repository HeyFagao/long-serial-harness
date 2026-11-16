import { describe, expect, it } from "vitest";
import { applyOriginalChange, emptyOriginalState, extractOriginalField, initializeOriginalState, type OriginalState } from "../src/original-state.js";

function change(overrides: Partial<Record<string, string>> = {}): string {
  const fields = {
    本章摘要: "找到了钥匙，邻居被排除嫌疑。", 实际字数: "2400", 章尾钩类型: "突然揭示",
    人物: "林青：在门厅，已知钥匙被换过，不知道换钥匙的人。", 伏笔: "无", 时间: "半小时",
    与章纲不同的地方及原因: "无", 下一章必须接住的事: "查清锁芯上的新划痕。", ...overrides
  };
  return `【状态变更】\n${Object.entries(fields).map(([key, value]) => `- ${key}：${value}`).join("\n")}`;
}

function plannedState(): OriginalState {
  const state = emptyOriginalState(20);
  state.fb.FB01 = { content: "钥匙来源", plant_chapter: 1, planned_reap: 1, status: "未埋", reap_chapter: null, next: "" };
  return state;
}

describe("original workbench state bookkeeping", () => {
  it("reads whole multiline field blocks without taking another field's text", () => {
    const text = change({ 人物: "\n- 林青：留在门厅。\n  认知：知道了钥匙被换过。\n- 许白：去了楼下。", 下一章必须接住的事: "查清划痕。\n保留完整的第二行承诺。" });
    expect(extractOriginalField(text, "人物")).toBe("- 林青：留在门厅。\n  认知：知道了钥匙被换过。\n- 许白：去了楼下。");
    expect(extractOriginalField(text, "下一章必须接住的事")).toContain("第二行承诺");
    expect(extractOriginalField(text, "不存在")).toBe("");
  });

  it("retains the original state shape, full notes and precise three-paragraph tail without mutating the input", () => {
    const original = emptyOriginalState(20);
    const note = "人物尚未得知门外的人是谁。".repeat(30);
    const promise = "这一事件必须延续到下一章。".repeat(30);
    const result = applyOriginalChange(original, { chapter: 1, title: "旧钥匙", change: change({ 人物: `林青：${note}\n  认知：仍不知道来人身份。`, 下一章必须接住的事: promise }), body: "第1章 旧钥匙\n\n第一段\n\n第二段\n\n第三段\n\n第四段", chars: 2400 });
    expect(original.next_chapter).toBe(1);
    expect(original.characters).toEqual({});
    expect(result.characters.林青?.note).toContain(note);
    expect(result.characters.林青?.note).toContain("认知：仍不知道来人身份。");
    expect(result.characters).not.toHaveProperty("认知");
    expect(result.pending).toBe(promise);
    expect(result.tail).toBe("第二段\n第三段\n第四段");
    expect(result.next_chapter).toBe(2);
    expect(result.recent).toEqual([{ n: 1, title: "旧钥匙", summary: "找到了钥匙，邻居被排除嫌疑。", hook_type: "突然揭示" }]);
    expect(result.chapter_meta["1"]).toEqual({ chars: 2400, hook_type: "突然揭示", time: "半小时" });
    expect(result.hook_type_counts.突然揭示).toBe(1);
  });

  it("never marks planned or merely mentioned foreshadows as resolved", () => {
    for (const field of ["无", "FB001：未回收，仍不知道钥匙来源。", "FB001：计划回收，下一章查清钥匙来源。", "回收：\nFB001：计划在下一章查清钥匙来源。", "FB001：回收"]) {
      const original = plannedState();
      const result = applyOriginalChange(original, { chapter: 1, title: "旧钥匙", change: change({ 伏笔: field }), body: "正文", chars: 2400 });
      expect(result.fb.FB01?.status, field).toBe("未埋");
      expect(result.fb.FB01?.reap_chapter, field).toBeNull();
      expect(result.fb.FB01?.planned_reap).toBe(1);
    }
  });

  it("applies only explicit reported foreshadow actions with descriptions and preserves full evidence", () => {
    const full = "主角在钥匙柄内发现祖父的刻字，来源得到确认。".repeat(12);
    const result = applyOriginalChange(plannedState(), { chapter: 1, title: "旧钥匙", change: change({ 伏笔: `FB001：回收，${full}\n新埋：\n- FB002：门框上留下一个陌生人的指纹。\n推进：FB003：邻居交出了另一把钥匙。` }), body: "正文", chars: 2400 });
    expect(result.fb.FB01).toMatchObject({ status: "已回收", reap_chapter: 1, planned_reap: 1 });
    expect(result.fb.FB01?.next).toContain(full);
    expect(result.fb.FB02).toMatchObject({ status: "已埋未收", plant_chapter: 1 });
    expect(result.fb.FB03).toMatchObject({ status: "推进中", reap_chapter: null });
  });

  it("does not invent appearances or facts from prose, and rejects duplicate or out-of-order commits", () => {
    const original = emptyOriginalState(20);
    original.characters.林青 = { note: "未登场" };
    const result = applyOriginalChange(original, { chapter: 1, title: "旧钥匙", change: change({ 人物: "无" }), body: "林青在正文里出现了。", chars: 2400 });
    expect(result.characters.林青?.note).toBe("未登场");
    expect(() => applyOriginalChange(result, { chapter: 1, title: "重复", change: change(), body: "正文", chars: 2400 })).toThrow("不一致");
    expect(() => applyOriginalChange(result, { chapter: 3, title: "跳章", change: change(), body: "正文", chars: 2400 })).toThrow("不一致");
  });

  it("keeps twelve recent summaries and all registered deviations without duplicating counters", () => {
    let state = emptyOriginalState(20);
    for (let chapter = 1; chapter <= 15; chapter += 1) {
      state = applyOriginalChange(state, { chapter, title: `章${String(chapter)}`, change: change({ 与章纲不同的地方及原因: "门厅改为楼道，人物行动不变。" }), body: "正文", chars: 2400 });
    }
    expect(state.recent).toHaveLength(12);
    expect(state.recent[0]?.n).toBe(4);
    expect(state.deviations).toHaveLength(15);
    expect(state.hook_type_counts.突然揭示).toBe(15);
  });

  it("ignores unsafe property names and does not execute state text", () => {
    const result = applyOriginalChange(emptyOriginalState(2), { chapter: 1, title: "章", change: change({ 人物: "__proto__：污染\nconstructor：污染\n林青：把文本 $('command') 留在纸上。" }), body: "正文", chars: 2400 });
    expect(Object.hasOwn(result.characters, "__proto__")).toBe(false);
    expect(Object.hasOwn(result.characters, "constructor")).toBe(false);
    expect(result.characters.林青?.note).toContain("$('command')");
  });

  it("initializes exact original plans and unintroduced characters without promoting planned facts", () => {
    const original = initializeOriginalState([
      { number: 4, content: "第4章：钥匙\n本章出场人物：林青、许白\n◆写作重点：埋设 FB001，邻居留下一把钥匙；推进 FB77。\n本章钩子：回收 FB002，确认地址。" },
      { number: 2, content: "第2章：门外\n本章出场人物：许白／阿洛\n写作重点：新埋 FB1，钥匙出现；结清 FB02，地址确认。\n本章钩子：回收 FB1，讲清来源。" }
    ], 20, "钥匙故事");
    expect(original.title).toBe("钥匙故事");
    expect(original.characters).toEqual({ 林青: { note: "未登场" }, 许白: { note: "未登场" }, 阿洛: { note: "未登场" } });
    expect(original.fb.FB01).toMatchObject({ plant_chapter: 2, planned_reap: 2, status: "未埋", reap_chapter: null });
    expect(original.fb.FB02).toMatchObject({ plant_chapter: null, planned_reap: 2, status: "未埋", reap_chapter: null });
    expect(original.fb).not.toHaveProperty("FB77");
    const result = applyOriginalChange(original, { chapter: 1, title: "开始", change: change({ 人物: "无", 伏笔: "无" }), body: "正文", chars: 2400 });
    expect(result.fb.FB01?.status).toBe("未埋");
    expect(result.characters.许白?.note).toBe("未登场");
  });
});
