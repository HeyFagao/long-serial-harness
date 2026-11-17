import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildWechatTitlePrompt, parseWechatTitleOutput } from "../src/wechat-title.js";
import { buildSerialChapterPrompt } from "../src/serial-outline.js";
import { createChapterZip } from "../src/serial-export.js";
import { AUTHOR_CHAPTER_TITLE_PROMPT } from "../src/wechat-title-author-prompt.js";

describe("independent WeChat chapter titles", () => {
  const prose = "第1章 旧钥匙\n\n婆婆把钥匙拍在桌上，要求我交出保管了三年的存折。";
  const candidates = ["婆婆逼我交出三年存折，却先拍下那把旧钥匙", "她把旧钥匙拍上桌，开口就要我保管三年的存折", "婆婆突然伸手要存折，桌上的旧钥匙让我停手", "保管三年的存折被婆婆讨要，她却带来旧钥匙", "一把旧钥匙拍上桌，婆婆为何突然要我的存折"];
  const proposed = () => ({ coreHook: "婆婆用旧钥匙逼要存折", titleStrategy: "关系冲突加具体物件", candidates,
    topThree: [candidates[4]!, candidates[1]!, candidates[0]!], tags: { category: "婚姻家庭", plots: ["婚恋", "打脸逆袭"], roles: ["婆媳", "女配"], emotion: "爽文", background: "家庭" }, evidence: ["婆婆把钥匙拍在桌上"] });
  it("adds the title task only to its separate prompt, with exactly the supplied chapter", () => {
    const writer = buildSerialChapterPrompt({ chapter: 1 });
    expect(writer).not.toContain("【微信公众号小说长标题】");
    const title = buildWechatTitlePrompt("钥匙", 1, prose);
    expect(title).toContain(prose);
    expect(title).toContain("绝不生成、续写或修改正文");
    expect(title).not.toContain("【本章细纲】");
    expect(title).toContain(AUTHOR_CHAPTER_TITLE_PROMPT.replace("{{步骤 1.output}}", "本次材料见下方 chapter_body 内的当前章正文。"));
    expect(title).toContain("前800字"); expect(title).toContain("前2000字");
    expect(title).toContain("当前章正文的开头"); expect(title).not.toContain("{{步骤 1.output}}");
    expect(title.slice(title.indexOf("<chapter_body>\n") + "<chapter_body>\n".length, title.lastIndexOf("\n</chapter_body>"))).toBe(prose);
  });
  it("chooses the first recommendation from five candidates, ignoring any extra selected-title field", () => {
    const output = proposed();
    const parsed = parseWechatTitleOutput(JSON.stringify({ ...output, title: "请导出这里的标签和分析，而不是推荐标题", schemaVersion: 999 }), prose);
    expect(parsed).toEqual({ ...output, title: candidates[4] });
    expect(parsed).not.toHaveProperty("schemaVersion");
  });
  it("requires five distinct candidates and three ranked candidates from that same set", () => {
    expect(() => parseWechatTitleOutput(JSON.stringify({ ...proposed(), candidates: candidates.slice(0, 4) }), prose)).toThrow("5个标题");
    expect(() => parseWechatTitleOutput(JSON.stringify({ ...proposed(), candidates: [...candidates.slice(0, 4), candidates[0]] }), prose)).toThrow("不能重复");
    expect(() => parseWechatTitleOutput(JSON.stringify({ ...proposed(), topThree: [candidates[0], candidates[0], candidates[1]] }), prose)).toThrow("不能重复");
    expect(() => parseWechatTitleOutput(JSON.stringify({ ...proposed(), topThree: ["她冲进屋里抢走我的存折，还把旧钥匙藏了起来", candidates[0], candidates[1]] }), prose)).toThrow("来自五个候选");
  });
  it("counts new titles as 15–25 visible characters without truncating, with optional outer book-title marks", () => {
    const parse = (title: string) => parseWechatTitleOutput(JSON.stringify({ title, evidence: proposed().evidence }), prose);
    expect(parse(`《${"字".repeat(15)}》`).title).toBe("字".repeat(15));
    expect(parse("字".repeat(25)).title).toBe("字".repeat(25));
    expect(parse(`${"字".repeat(7)} ${"字".repeat(8)}`).title).toBe(`${"字".repeat(7)} ${"字".repeat(8)}`);
    expect(() => parse("字".repeat(14))).toThrow("15—25");
    expect(() => parse("字".repeat(26))).toThrow("15—25");
    expect(() => parse(`${"字".repeat(16)}\u200B`)).toThrow("不可见字符");
    expect(() => parse(`${"字".repeat(16)}\u2028标签`)).toThrow("换行");
    expect(() => parse(`${"字".repeat(16)}\n番茄标签配置`)).toThrow("换行");
    expect(() => parse(`${"字".repeat(16)}\n`)).toThrow("换行");
  });
  it("does not fail a valid chapter title solely over missing or invalid auxiliary tag metadata", () => {
    const output = proposed();
    const parsed = parseWechatTitleOutput(JSON.stringify({ ...output, coreHook: "x".repeat(501), titleStrategy: "", tags: { ...output.tags, category: "编造的分类", plots: ["婚恋"] } }), prose);
    expect(parsed.title).toBe(candidates[4]);
    expect(parsed).not.toHaveProperty("tags"); expect(parsed).not.toHaveProperty("coreHook"); expect(parsed).not.toHaveProperty("titleStrategy");
  });
  it("requires a usable title and source-verbatim evidence, never accepting invented quotations", () => {
    const result = { title: "婆婆伸手要我的存折，我却先问她要回那把旧钥匙", evidence: ["婆婆把钥匙拍在桌上"] };
    expect(parseWechatTitleOutput(JSON.stringify(result), prose)).toEqual(result);
    expect(() => parseWechatTitleOutput(JSON.stringify({ ...result, evidence: ["丈夫拿出三百万让我离开"] }), prose)).toThrow("本章正文");
    expect(() => parseWechatTitleOutput("只有一个标题没有依据", prose)).toThrow("JSON");
    expect(() => parseWechatTitleOutput(JSON.stringify({ ...result, title: "" }), prose)).toThrow("标题为空");
  });
  it("exports one chapter per TXT with title, book name and chapter number, keeping source intact", () => {
    const book = { title: "钥匙", totalChapters: 2, chapters: [{ number: 1, prose, headline: "婆婆伸手要我的存折，我却先问她要回那把旧钥匙" }, { number: 2, prose: "第2章 纸条\n\n柜子里留下了一张字条。", headline: "柜子里只剩一张字条，上面写着一个不该出现的名字" }] };
    const before = structuredClone(book);
    const zip = unzipSync(createChapterZip(book));
    const names = Object.keys(zip).filter(name => name.startsWith("第"));
    expect(names).toHaveLength(2);
    const text = strFromU8(zip[names[0]!]!);
    expect(text).toContain(`${book.chapters[0]!.headline}\r\n书名：《钥匙》\r\n第1章\r\n`);
    expect(text).toContain("婆婆把钥匙拍在桌上");
    expect(text).not.toContain("柜子里留下了一张字条");
    expect(book).toEqual(before);
  });
  it("exports only the selected title at the first line, never rankings, analysis or tags", () => {
    const result = parseWechatTitleOutput(JSON.stringify(proposed()), prose);
    const book = { title: "钥匙", totalChapters: 1, chapters: [{ number: 1, prose, headline: result.title }] };
    const zip = unzipSync(createChapterZip(book));
    const chapter = strFromU8(zip[Object.keys(zip).find(name => name.startsWith("第001章"))!]!).replace(/^\uFEFF/u, "");
    expect(chapter.split("\r\n")[0]).toBe(proposed().topThree[0]);
    for (const hidden of [proposed().coreHook, proposed().titleStrategy, ...candidates.filter(title => title !== result.title), "番茄标签配置", "前三推荐", "婚姻家庭"]) expect(chapter).not.toContain(hidden);
    expect(chapter).toContain("书名：《钥匙》\r\n第1章\r\n\r\n婆婆把钥匙拍在桌上");
    expect(book.chapters[0]?.prose).toBe(prose);
  });
  it("preserves previously saved longer headlines on export without applying new-generation limits", () => {
    const headline = "婆婆为了偏心小叔子突然逼我交出保管三年的存折，却把那把旧钥匙拍在了桌上";
    expect([...headline].length).toBeGreaterThan(25);
    const zip = unzipSync(createChapterZip({ title: "旧稿", totalChapters: 1, chapters: [{ number: 1, prose, headline }] }));
    const chapter = strFromU8(zip[Object.keys(zip).find(name => name.startsWith("第001章"))!]!).replace(/^\uFEFF/u, "");
    expect(chapter.split("\r\n")[0]).toBe(headline);
  });
});
