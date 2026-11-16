import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildWechatTitlePrompt, parseWechatTitleOutput } from "../src/wechat-title.js";
import { buildSerialChapterPrompt } from "../src/serial-outline.js";
import { createChapterZip } from "../src/serial-export.js";

describe("independent WeChat chapter titles", () => {
  const prose = "第1章 旧钥匙\n\n婆婆把钥匙拍在桌上，要求我交出保管了三年的存折。";
  it("adds the title task only to its separate prompt, with exactly the supplied chapter", () => {
    const writer = buildSerialChapterPrompt({ chapter: 1 });
    expect(writer).not.toContain("【微信公众号小说长标题】");
    const title = buildWechatTitlePrompt("钥匙", 1, prose);
    expect(title).toContain(prose);
    expect(title).toContain("绝不生成、续写或修改正文");
    expect(title).not.toContain("【本章细纲】");
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
});
