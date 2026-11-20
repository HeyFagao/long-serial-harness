import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { chapterWording, MOBILE_PARAGRAPH_LIMIT, typesetMobileChapter } from "../src/mobile-typography.js";
import { createChapterZip } from "../src/serial-export.js";

function visible(text: string): number {
  return [...text].filter(char => !/\s/u.test(char)).length;
}

const beat = "许青梅把旧钥匙按在桌面上，周秘书站在门边看了她很久。";

describe("mobile chapter typography", () => {
  it("turns a dense unseparated draft into short paragraphs with a blank line between them", () => {
    const wall = beat.repeat(6) + "她把存折收进抽屉，窗外的车声一阵一阵地涌进来。";
    expect(visible(wall)).toBeGreaterThan(MOBILE_PARAGRAPH_LIMIT * 2);
    const output = typesetMobileChapter(wall);
    const paragraphs = output.split("\n\n");
    expect(paragraphs.length).toBeGreaterThan(2);
    expect(output).not.toMatch(/\n{3,}/u);
    for (const paragraph of paragraphs) {
      expect(paragraph).not.toContain("\n");
      expect(visible(paragraph) <= MOBILE_PARAGRAPH_LIMIT || paragraph.split("。").length <= 2).toBe(true);
    }
    expect(chapterWording(output)).toBe(chapterWording(wall));
    expect(typesetMobileChapter(output)).toBe(output);
  });

  it("puts spoken dialogue on its own paragraph for curly, corner and single quotes", () => {
    const dense = "许青梅把钥匙拍在桌上。“你先回去。”他还是没动。「那钥匙呢？」周秘书问了一句。她只回：‘你先走。’屋里又静下来。许青梅说：“他刚才来问‘你走不走’，我没答。”";
    const output = typesetMobileChapter(dense);
    expect(output.split("\n\n")).toEqual([
      "许青梅把钥匙拍在桌上。",
      "“你先回去。”",
      "他还是没动。",
      "「那钥匙呢？」",
      "周秘书问了一句。她只回：",
      "‘你先走。’",
      "屋里又静下来。许青梅说：",
      "“他刚才来问‘你走不走’，我没答。”"
    ]);
    for (const spoken of ["“你先回去。”", "「那钥匙呢？」", "‘你先走。’", "“他刚才来问‘你走不走’，我没答。”"]) expect(output.split("\n\n")).toContain(spoken);
    expect(output).not.toMatch(/^‘你走不走’$/mu);
    expect(chapterWording(output)).toBe(chapterWording(dense));
    expect(typesetMobileChapter(output)).toBe(output);
    expect(typesetMobileChapter("她抬眼：『你现在就走。』门还开着。").split("\n\n")).toEqual(["她抬眼：", "『你现在就走。』", "门还开着。"]);
  });

  it("keeps a single over-long sentence intact and does not shred a comfortable paragraph", () => {
    const sentence = `${"许青梅把旧钥匙按在桌上，".repeat(8)}周秘书仍旧没有接。`;
    expect(visible(sentence)).toBeGreaterThan(MOBILE_PARAGRAPH_LIMIT);
    expect(typesetMobileChapter(sentence)).toBe(sentence);
    const comfortable = "许青梅把钥匙拍在桌上。周秘书站在门边没有接话。";
    expect(visible(comfortable)).toBeLessThanOrEqual(MOBILE_PARAGRAPH_LIMIT);
    expect(typesetMobileChapter(comfortable)).toBe(comfortable);
  });

  it("leaves already airy text unchanged instead of double-spacing or shredding it", () => {
    const formatted = ["许青梅把钥匙拍在桌上。", "“你先回去。”", "周秘书站在门边没动。"].join("\n\n");
    expect(typesetMobileChapter(formatted)).toBe(formatted);
    expect(typesetMobileChapter(`${formatted}\n`)).toBe(formatted);
    expect(typesetMobileChapter("甲。\n\n\n乙。")).toBe("甲。\n\n乙。");
    expect(typesetMobileChapter("甲。\r\n\r\n“你先走。”")).toBe("甲。\n\n“你先走。”");
    const singleNewlines = ["许青梅把钥匙拍在桌上。", "“你先回去。”", "周秘书站在门边没动。"].join("\n");
    expect(typesetMobileChapter(singleNewlines)).toBe(formatted);
  });

  it("joins a wrapped quote without swallowing the next finished paragraph", () => {
    const wrapped = "“你先回去，\n这件事明天再算。”\n周秘书站在门边没动。";
    expect(typesetMobileChapter(wrapped)).toBe("“你先回去，这件事明天再算。”\n\n周秘书站在门边没动。");
  });

  it("only adjusts Chinese spacing and does not change wording", () => {
    expect(typesetMobileChapter("你 好 ， 世 界 。")).toBe("你好，世界。");
    expect(typesetMobileChapter("她买了 iPhone 15 。")).toBe("她买了 iPhone 15。");
    const named = "许青梅在2019年3月把3500元存折交出去。";
    expect(typesetMobileChapter(named)).toBe(named);
    const mixed = "许青梅 说 ： “ 你先回去 。 ” 周秘书没动。";
    const output = typesetMobileChapter(mixed);
    expect(chapterWording(output)).toBe(chapterWording(mixed));
    expect(output).toContain("“你先回去。”");
  });

  it("keeps 【状态变更】 verbatim, including when the prose around it is reflowed", () => {
    const change = "【状态变更】\r\n- 本章摘要：她说“你走”。\r\n- 章尾钩类型：未完成动作\r\n- 人物：许青梅/在屋内\r\n";
    const input = `她把钥匙拍在桌上。“你先走。”他还站着。\r\n\r\n${change}`;
    const output = typesetMobileChapter(input);
    expect(output.endsWith(change)).toBe(true);
    expect(output.startsWith("她把钥匙拍在桌上。\n\n“你先走。”\n\n他还站着。\n\n")).toBe(true);
    expect(output.slice(output.indexOf("【状态变更】"))).toBe(change);
    expect(typesetMobileChapter(change)).toBe(change);
    expect(chapterWording(output)).toBe(chapterWording(input));
  });

  it("exports phone paragraphs while leaving headers, candidates and the source book untouched", () => {
    const candidates = ["婆婆逼我交出三年存折，却先拍下那把旧钥匙", "她把旧钥匙拍上桌，开口就要我保管三年的存折", "婆婆突然伸手要存折，桌上的旧钥匙让我停手", "保管三年的存折被婆婆讨要，她却带来旧钥匙", "一把旧钥匙拍上桌，婆婆为何突然要我的存折"];
    const change = "【状态变更】\n- 本章摘要：她拍下钥匙。\n- 章尾钩类型：未完成动作\n";
    const prose = `第1章 旧钥匙\n${beat.repeat(4)}“你现在就走。”${beat}\n\n${change}`;
    const book = { title: "钥匙", totalChapters: 2, chapters: [{ number: 1, prose, headline: candidates[0]!, headlineCandidates: candidates }, { number: 2, prose: "第2章 纸条\n\n柜子里留下了一张字条。", headline: "柜子里只剩一张字条，上面写着一个不该出现的名字" }] };
    const before = structuredClone(book);
    const zip = unzipSync(createChapterZip(book));
    const filename = Object.keys(zip).find(name => name.startsWith("第001章"))!;
    const chapter = strFromU8(zip[filename]!).replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
    expect(chapter.split("\n").slice(0, 8)).toEqual(["本章备选标题（任选一个用于发布）", ...candidates.map((title, index) => `${String(index + 1)}. ${title}`), "", "书名：《钥匙》"]);
    expect(chapter).toContain("书名：《钥匙》\n第1章\n\n");
    const body = chapter.slice(chapter.indexOf("第1章\n\n") + "第1章\n\n".length).replace(/\n$/u, "");
    expect(body).toContain("\n\n“你现在就走。”\n\n");
    expect(body.endsWith(change.trimEnd())).toBe(true);
    expect(body.slice(body.indexOf("【状态变更】"))).toBe(change.trimEnd());
    expect(chapterWording(body.slice(0, body.indexOf("【状态变更】")))).toBe(chapterWording(`${beat.repeat(4)}“你现在就走。”${beat}`));
    const second = strFromU8(zip[Object.keys(zip).find(name => name.startsWith("第002章"))!]!).replace(/^\uFEFF/u, "");
    expect(second).toContain("书名：《钥匙》\r\n第2章\r\n\r\n柜子里留下了一张字条。");
    expect(second).not.toContain("你现在就走");
    expect(book).toEqual(before);
    const notes = strFromU8(zip["目录与导出说明.txt"]!).replace(/^\uFEFF/u, "");
    expect(notes).toContain("书名：《钥匙》");
    expect(notes).toContain("不改故事用词");
  });
});
