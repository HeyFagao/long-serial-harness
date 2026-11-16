import { describe, expect, it } from "vitest";
import { parseOriginalChapterPlan } from "../src/original-outline-plan.js";

describe("portable app chapter plan fields", () => {
  it("keeps the original labels, last matching field and FB normalization", () => {
    const plan = parseOriginalChapterPlan("第1章：开场\n本章出场人物：甲、乙，丙/丁／戊\n写作重点：埋设FB99。\n◇ 写作重点：新埋 FB 0001 和 FB2；提及 FB003。\n本章钩子：收束 FB002，结清FB09。\n剧情点一：埋设FB88。");
    expect(plan.characters).toEqual(["甲", "乙", "丙", "丁", "戊"]);
    expect(plan.fb_plant).toEqual(["FB01", "FB02"]);
    expect(plan.fb_reap).toEqual(["FB02", "FB09"]);
    expect(plan.fb_push).toEqual(["FB03"]);
    expect(plan.fb_plant).not.toContain("FB99");
    expect(plan.fb_plant).not.toContain("FB88");
  });

  it("respects the original 30-codepoint window and sentence separators", () => {
    const plan = parseOriginalChapterPlan(`写作重点：埋设${"甲".repeat(31)}FB01。埋下；FB02。新埋 FB03。\n本章钩子：回收${"😀".repeat(25)}FB4。`);
    expect(plan.fb_plant).toEqual(["FB03"]);
    expect(plan.fb_reap).toEqual(["FB04"]);
  });
});
