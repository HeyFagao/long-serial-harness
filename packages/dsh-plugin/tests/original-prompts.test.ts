import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendOriginalBookStyle, buildOriginalRewritePrompt, buildOriginalUserPrompt, ORIGINAL_SYSTEM_PROMPT, ORIGINAL_SYSTEM_PROMPT_SHA256 } from "../src/original-prompts.js";
import { buildOriginalSettingsSlices, renderOriginalDossier } from "../src/original-context.js";

describe("portable-app original writing prompts", () => {
  it("preserves the recovered system prompt byte for byte", () => {
    expect(Buffer.byteLength(ORIGINAL_SYSTEM_PROMPT, "utf8")).toBe(8685);
    expect(createHash("sha256").update(ORIGINAL_SYSTEM_PROMPT).digest("hex")).toBe(ORIGINAL_SYSTEM_PROMPT_SHA256);
    expect(ORIGINAL_SYSTEM_PROMPT_SHA256).toBe("4e56881a6c2ac904dd50467eead4ada0e452e5d2c1d598701622a5b73cc4abf2");
  });

  it("uses the exact original five input blocks and defaults", () => {
    const user = buildOriginalUserPrompt({ chapterRaw: "细纲原文", dossierText: "记账原文", settingsSlices: "", tail: "" });
    expect(user).toBe("现在写本章，材料如下。\n\n【本章细纲】\n细纲原文\n\n【读档包（程序记账的人物状态、伏笔台账、近章摘要与钩子清单）】\n记账原文\n\n【相关设定条目（只含本章用到的人物卡、伏笔条目与世界观规矩）】\n无额外条目，按读档包与细纲执行。\n\n【上一章最后 3 段原文】\n本章为第 1 章，此栏为空。\n\n【发散等级】0\n0 = 严格按细纲；1 = 可补细节；2 = 可调次要情节，需在状态变更里说明；3 = 先提出更好的走向，不写正文。\n\n开始写。只输出章节正文与【状态变更】。");
    expect(buildOriginalRewritePrompt("上一版\n【状态变更】\n真实变化", ["问题甲", "问题乙"])).toContain("1. 问题甲\n2. 问题乙\n\n请通读原文，只针对上述问题做最小修改");
  });

  it("never clips style or original user data and reapplies style on repairs", () => {
    const style = "完整风格".repeat(3000) + "风格终点";
    expect(appendOriginalBookStyle(ORIGINAL_SYSTEM_PROMPT, style)).toBe(ORIGINAL_SYSTEM_PROMPT + "\n\n【本书文风补充（作者指定，优先级高于通用规范）】\n" + style);
    const original = "上一版原文".repeat(3000) + "原文终点";
    expect(buildOriginalRewritePrompt(original, ["修订字数"])).toContain(original);
  });

  it("renders the original dossier sections from committed facts, not a model rewrite", () => {
    const state = { characters: { 阿青: { note: "知道证据在抽屉中。" }, 未见: { note: "未登场" } }, fb: { FB2: { status: "已埋未收", plant_chapter: 2, planned_reap: 10, reap_chapter: null } }, pending: "打开抽屉。", recent: [{ n: 2, title: "证据", summary: "发现钥匙。", hook_type: "神秘物品" }], deviations: ["第2章：延后一步"] };
    const result = renderOriginalDossier(state, 3, 20);
    expect(result).toContain("一、当前进度：已写到第 2 章，本章为第 3 章，全书共 20 章。");
    expect(result).toContain("阿青：知道证据在抽屉中。");
    expect(result).not.toContain("未见");
    expect(result).toContain("FB2｜已埋未收｜埋设章 2｜计划回收 10｜实际回收 None");
    expect(result).toContain("第2章《证据》：发现钥匙。");
    expect(result).toContain("七、正文与章纲的已登记偏差（以正文为准）：\n第2章：延后一步");
  });

  it("keeps relevant whole paragraphs past the original 700-character cutoff", () => {
    const long = "阿青人物卡：" + "既定关系。".repeat(180) + "人物卡末句";
    const slices = buildOriginalSettingsSlices("本章出场人物：阿青、阿迟\n伏笔：FB2", [{ name: "小说设定集", content: long + "\n\n阿迟人物卡：既定身份。\n\nFB2：已定伏笔。" }]);
    expect(slices).toContain(long);
    expect(slices).toContain("◆ 阿迟\n阿迟人物卡：既定身份。");
    expect(slices).toContain("◆ FB2\nFB2：已定伏笔。");
    expect(slices).not.toContain("不存在的人物");
  });
});
