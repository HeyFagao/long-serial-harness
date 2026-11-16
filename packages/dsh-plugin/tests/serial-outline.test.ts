import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSerialChapterPrompt,
  countSerialVisibleChars,
  parseSerialChapterNumber,
  parseSerialOutline,
  serialImportArtifacts,
  validateSerialChapter
} from "../src/serial-outline.js";

const chapterBody = [
  "本章出场人物：沈知意、周明远、贺母",
  "▶ 剧情点一：订婚宴开场五十分钟，男方没到，沈知意独自撑住场面。",
  "▶ 剧情点二：她撞见男方与别人同车抵达，对方连解释都懒得给。",
  "▶ 剧情点三：男方递来一份协议，要她当场签字。",
  "◆ 情绪变化曲线：隐忍克制 → 冷意上涌 → 决断前夜",
  "本章钩子：协议封面写着\"权益放弃协议\"。",
  "◆ 写作重点：对话博弈与环境压迫；埋设FB01（协议暗条款）的物理载体。"
].join("\n");
const source = ` &&&开书信息&&&\n书本名称：示例书名\n简介：一句话说清这本书的卖点。\n\n&&&核心设定&&&\n沈知意，女主，35 岁。\nFB01：退婚协议里的隐藏条款，第 1 章埋设，第 40 章回收。\n\n&&&章纲&&&\n第1章：退婚宴上的空位\n${chapterBody}\n\n第2章：签还是不签\n${chapterBody}\n`;

describe("legacy serial outline import", () => {
  it("preserves the supplied format and every nonchapter section without treating story references as headings", () => {
    const input = `\uFEFF${source.replaceAll("\n", "\r\n")}\r\n&&&附加设定&&&\r\n红伞不能换成黑伞。`;
    const outline = parseSerialOutline(input);
    expect(outline.title).toBe("示例书名");
    expect(outline.chapters.map((chapter) => chapter.number)).toEqual([1, 2]);
    expect(outline.diagnostics).toEqual([]);
    expect(outline.source).toBe(input);
    const artifacts = serialImportArtifacts(outline);
    expect(artifacts.find((file) => file.path === "大纲/导入原稿.md")?.content).toBe(input);
    expect(artifacts.find((file) => file.path === "设定/导入资料.md")?.content).toContain("红伞不能换成黑伞。");
    expect(artifacts.find((file) => file.path === "设定/导入资料.md")?.content).toContain("第 40 章回收");
    expect(artifacts.find((file) => file.path === "大纲/细纲_第001章.md")?.content).toContain(chapterBody);
    expect(artifacts.some((file) => file.path.includes("_tracking-state"))).toBe(false);
  });

  it("accepts Markdown, Arabic, fullwidth and Chinese chapter numbers", () => {
    const outline = parseSerialOutline(`## **第九十八章：标题**\n${chapterBody}\n### 第９９章：尾声\n${chapterBody}\n第 一百 章：新篇\n${chapterBody}`);
    expect(outline.chapters.map((chapter) => chapter.number)).toEqual([98, 99, 100]);
    expect(outline.chapters[0]?.title).toBe("标题");
    expect(outline.diagnostics).toEqual([]);
    expect(outline.chapters[2]?.outlinePath).toBe("大纲/细纲_第100章.md");
  });

  it("retains exact chapter numbering for a 100 chapter batch", () => {
    const outline = parseSerialOutline(Array.from({ length: 100 }, (_, index) => `第${index + 1}章：第${index + 1}场\n${chapterBody}`).join("\n\n"));
    expect(outline.chapters).toHaveLength(100);
    expect(outline.diagnostics).toEqual([]);
    expect(serialImportArtifacts(outline)).toHaveLength(102);
  });

  it("includes both legacy 章纲 and 细纲 sections instead of silently dropping the latter", () => {
    const outline = parseSerialOutline(`&&&章纲&&&\n第1章：一\n${chapterBody}\n&&&细纲&&&\n第2章：二\n${chapterBody}`);
    expect(outline.chapters.map((chapter) => chapter.number)).toEqual([1, 2]);
    expect(outline.diagnostics).toEqual([]);
  });

  it.each(["文风", "文风手册", "文风推荐", "文风设定", "写作文风", "文风要求"])("preserves %s verbatim in the native style file", (section) => {
    const style = "\r\n  长短句交替；对话 40–50%。\r\n\r\n## 角色声线\r\n沈知意：少解释，不用空洞独白。  \r\n";
    const outline = parseSerialOutline(`&&&${section}&&&\r\n${style}&&&章纲&&&\r\n第1章：一\r\n${chapterBody.replaceAll("\n", "\r\n")}`);
    const artifacts = serialImportArtifacts(outline);
    expect(artifacts.find((file) => file.path === "设定/文风.md")?.content).toBe(style);
    expect(outline.sections.find((item) => item.name === section)?.content).toBe(style);
    expect(artifacts.find((file) => file.path === "设定/导入资料.md")?.content).toContain(style);
  });

  it("splits finished design and settings into fixed files without summaries or altered facts", () => {
    const design = "第一阶段 1–50 章。FB01 第40章回收。\n\n";
    const core = "主角 35 岁，不提前揭开协议暗条款。\n";
    const bible = "沈知意：不签协议。\nFB01：埋设第1章，回收第40章。\n";
    const input = `&&&核心设计&&&\n${design}&&&核心设定&&&\n${core}&&&小说设定集&&&\n${bible}&&&章纲&&&\n第1章：一\n${chapterBody}`;
    const artifacts = serialImportArtifacts(parseSerialOutline(input));
    expect(artifacts.find((file) => file.path === "设定/核心设计.md")?.content).toBe(design);
    expect(artifacts.find((file) => file.path === "设定/核心设定.md")?.content).toBe(core);
    expect(artifacts.find((file) => file.path === "设定/小说设定集.md")?.content).toBe(bible);
    expect(artifacts.find((file) => file.path === "大纲/导入原稿.md")?.content).toBe(input);
    expect(artifacts.find((file) => file.path === "设定/导入资料.md")?.content).toContain(bible);
  });

  it("retains repeated style sections in order without creating conflicting duplicate artifacts", () => {
    const artifacts = serialImportArtifacts(parseSerialOutline(`&&&文风推荐&&&\n原句一。\n&&&文风手册&&&\n原句二。\n&&&章纲&&&\n第1章：一\n${chapterBody}`));
    const styles = artifacts.filter((file) => file.path === "设定/文风.md");
    expect(styles).toEqual([{ path: "设定/文风.md", content: "原句一。\n原句二。\n" }]);
  });

  it("maps the real 9.0 export layout with a fenced Part A style manual after the chapters", () => {
    // Structural reproduction only: no private manuscript content is bundled.
    const style = " ```text\nPart A: 爆款文风系统指令\n\n一、作品定位与文风基因\n长短句交替，不做重新规划。\n\n十四、最终写作总则\n每次反击要有代价。\n``` \n";
    const input = `\n&&&开书信息&&&\n书本名称：回归样书\n&&&推荐素材&&&\n推荐素材原文。\n&&&章纲&&&\n第1章：起点\n${chapterBody}\n第2章：下一步\n${chapterBody}\n&&&核心设定&&&\n${style}&&&初始灵感存档&&&\n初始灵感原文。\n&&&小说设定集&&&\n人物与伏笔原文。\n&&&大纲规划&&&\n# 已完成的全书架构\n后部规划原文。`;
    const outline = parseSerialOutline(input);
    const artifacts = serialImportArtifacts(outline);
    expect(outline.chapters.map((chapter) => chapter.number)).toEqual([1, 2]);
    expect(outline.sections).toHaveLength(7);
    expect(artifacts.find((file) => file.path === "设定/文风.md")?.content).toBe(style);
    expect(artifacts.find((file) => file.path === "设定/核心设定.md")?.content).toBe(style);
    expect(artifacts.find((file) => file.path === "设定/开书信息.md")?.content).toBe("书本名称：回归样书\n");
    expect(artifacts.find((file) => file.path === "设定/推荐素材.md")?.content).toBe("推荐素材原文。\n");
    expect(artifacts.find((file) => file.path === "设定/初始灵感存档.md")?.content).toBe("初始灵感原文。\n");
    expect(artifacts.find((file) => file.path === "设定/小说设定集.md")?.content).toBe("人物与伏笔原文。\n");
    expect(artifacts.find((file) => file.path === "大纲/大纲规划.md")?.content).toBe("# 已完成的全书架构\n后部规划原文。");
    expect(artifacts.find((file) => file.path === "大纲/导入原稿.md")?.content).toBe(input);
  });

  it("does not reinterpret an ordinary core-setting mention as a style manual", () => {
    const artifacts = serialImportArtifacts(parseSerialOutline(`&&&核心设定&&&\n人物聊天提到文风系统指令这个词。\n&&&章纲&&&\n第1章：一\n${chapterBody}`));
    expect(artifacts.some((file) => file.path === "设定/文风.md")).toBe(false);
  });

  it("preserves additional writing-focus lines rather than overwriting an earlier field", () => {
    const outline = parseSerialOutline(`&&&章纲&&&\n第1章：一\n${chapterBody}\n◆ 写作重点：追加的限制也要保留。`);
    expect(outline.diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", code: "conflicting_field" }));
    const content = serialImportArtifacts(outline).find((file) => file.path === "大纲/细纲_第001章.md")?.content;
    expect(content).toContain("对话博弈与环境压迫");
    expect(content).toContain("追加的限制也要保留。");
  });

  it("reports duplicate and missing chapters with original line numbers and refuses artifacts", () => {
    const outline = parseSerialOutline("第1章：一\n情节一\n第3章：三\n情节三\n第3章：重复\n情节重复");
    expect(outline.diagnostics).toContainEqual(expect.objectContaining({ code: "chapter_gap", line: 3, chapter: 3 }));
    expect(outline.diagnostics).toContainEqual(expect.objectContaining({ code: "duplicate_chapter", line: 5, chapter: 3 }));
    expect(() => serialImportArtifacts(outline)).toThrow("第 3 行");
  });

  it("rejects empty chapters and malformed section delimiters without inventing content", () => {
    const outline = parseSerialOutline("&&&章纲\n第1章：一\n第2章：二\n剧情二");
    expect(outline.diagnostics).toContainEqual(expect.objectContaining({ code: "malformed_section", line: 1 }));
    expect(outline.diagnostics).toContainEqual(expect.objectContaining({ code: "empty_chapter", line: 2 }));
    expect(parseSerialOutline("没有章纲").diagnostics).toContainEqual(expect.objectContaining({ code: "no_chapters" }));
  });

  it("uses safe fixed output paths even when titles contain path traversal or commands", () => {
    const outline = parseSerialOutline(`书名：../../escape\n第1章：../../escape\n${chapterBody}\n$(run-a-command)`);
    const paths = serialImportArtifacts(outline).map((artifact) => artifact.path);
    expect(paths).toEqual(["大纲/导入原稿.md", "设定/导入资料.md", "大纲/细纲_第001章.md"]);
    expect(outline.source).toContain("$(run-a-command)");
    expect(serialImportArtifacts(outline).find((artifact) => artifact.path === "设定/导入资料.md")?.content).toContain("书名：../../escape");
    expect(serialImportArtifacts(outline).find((artifact) => artifact.path === "设定/导入资料.md")?.content).not.toContain(chapterBody);
  });

  it("rejects malformed numbered headings among otherwise valid chapters", () => {
    const outline = parseSerialOutline(`第1章：一\n${chapterBody}\n第1.5章：不能截成正文\n${chapterBody}`);
    expect(outline.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_chapter_number", severity: "error" }));
    expect(() => serialImportArtifacts(outline)).toThrow("无法识别这个章号");
  });

  it("warns about missing fields and keeps the material available for native outline completion", () => {
    const outline = parseSerialOutline("第1章：一\n人物对峙，手里的信还没拆。");
    expect(outline.diagnostics.every((item) => item.severity === "warning")).toBe(true);
    expect(serialImportArtifacts(outline).at(-1)?.content).toContain("人物对峙，手里的信还没拆。");
  });

  it("rejects binary-looking and oversized imports", () => {
    expect(parseSerialOutline("\0第1章").diagnostics[0]?.code).toBe("invalid_encoding");
    expect(parseSerialOutline("字".repeat(700_000)).diagnostics[0]?.code).toBe("source_too_large");
  });

  it.each([
    ["第一", undefined], ["零", undefined], ["0", undefined], ["一二十", undefined],
    ["十百", undefined], ["百", undefined], ["一千一百一十一", 1111], ["一万零一", 10001],
    ["二〇二", 202], ["十万", 100000], ["100001", undefined], ["１２０", 120]
  ])("parses chapter numeral %s without ambiguous coercion", (raw, expected) => {
    expect(parseSerialChapterNumber(raw as string)).toBe(expected);
  });
});

describe("native Oh Story chapter receipts", () => {
  const prose = `# 第001章\n\n${"沈知意把协议留在桌上。".repeat(20)}\n`;
  const chars = countSerialVisibleChars(prose);
  const digest = createHash("sha256").update(prose).digest("hex");
  const trackingState = {
    schema_version: 4,
    last_committed_chapter: 1,
    state_revision: 1,
    wordcount_records: {
      "1": { metric: "visible_chars_v1", actual: chars, body_sha256: digest, resolution: "within_user_band" }
    }
  };
  const chapterRecord = "# 第001章 · 退婚宴\n- 结果：她带走了协议。\n- 下一章承诺：查明附件\n\n## 角色变化\n- 无\n";

  it("accepts only prose and memory that agree on the committed bytes", () => {
    const result = validateSerialChapter({ chapter: 1, prose, trackingState, chapterRecord, minChars: 100, maxChars: 1000 });
    expect(result).toEqual({ ok: true, issues: [], chars, sha256: digest });
    expect(validateSerialChapter({ chapter: 1, prose: `${prose}多了字`, trackingState, chapterRecord }).ok).toBe(false);
  });

  it("rejects prose-written/state-not-committed crashes and incomplete delta records", () => {
    expect(validateSerialChapter({ chapter: 1, prose, trackingState: { ...trackingState, last_committed_chapter: 0 }, chapterRecord }).issues.join(" ")).toContain("尚未提交");
    expect(validateSerialChapter({ chapter: 1, prose, trackingState, chapterRecord: undefined }).issues.join(" ")).toContain("逐章记录");
    expect(validateSerialChapter({ chapter: 1, prose, trackingState, chapterRecord: chapterRecord.replace("第001章", "第002章") }).ok).toBe(false);
  });

  it("enforces the configured range independently of a model claiming completion", () => {
    expect(validateSerialChapter({ chapter: 1, prose, trackingState, chapterRecord, minChars: 2300, maxChars: 2500 }).issues.join(" ")).toContain("少于本批下限");
    expect(validateSerialChapter({ chapter: 1, prose: `${prose}\n【状态变更】{}`, trackingState, chapterRecord }).issues.join(" ")).toContain("运行日志");
  });

  it("preserves verified visible-character boundaries without a Python runtime", () => {
    // The first four values were verified against the pinned visible_chars_v1 implementation.
    // Ordinary chapter titles additionally follow the original portable workbench's count_chars.
    const cases: readonly (readonly [string, number])[] = [
      ["\uFEFF---\ntitle: 小说\n---\n\n# 章名\n你 好🙂\n\u0085\u2003\u200B\uFEFF", 5],
      ["---\n不是frontmatter\n---\n# 保留\n正文", 24],
      ["\r\n\u3000\r\n### 第1章\r\n甲\t乙\r丙", 3],
      ["#标题没有空格\nabc🙂", 11],
      ["\uFEFF第12章：普通标题\r\n你 好🙂\r\n", 3],
      ["第 12 章 普通标题\n甲\u3000乙\u2003丙", 3],
      ["第12章 标题\n𠀀e\u0301🙂", 4]
    ];
    for (const [input, expected] of cases) expect(countSerialVisibleChars(input)).toBe(expected);
  });

  it("uses the original portable-app prompts and current batch bounds without upstream writing tools", () => {
    const prompt = buildSerialChapterPrompt({ chapter: 50, minChars: 1800, maxChars: 2200, style: "少用独白", divergence: 1,
      originalContext: { chapterRaw: "第50章：归来\n已定情节", dossierText: "已提交的状态", settingsSlices: "相关设定", tail: "上章最后一句" },
      repairIssues: ["正文已写，但状态字段缺失"], repairOriginal: "第50章：归来\n上一版原文" });
    expect(prompt).toMatch(/^你是一名中文网络长篇小说的执笔/u);
    expect(prompt).toContain("本轮只完成当前工作区这本书的第 50 章");
    expect(prompt).toContain("当前批次建议字数为 1800–2200 字");
    expect(prompt).toContain("当前批次字数配置优先于原版系统提示词");
    expect(prompt).toContain("下面是你上一版章节正文与状态变更，程序检测发现以下问题");
    expect(prompt).toContain("只针对上述问题做最小修改");
    expect(prompt).toContain("不动已验收章节");
    expect(prompt).toContain("少用独白");
    expect(prompt).not.toMatch(/\/story-long-write|build_writer_prompt|narrative-writer|storyctl\.py|tracking_commit\.py/u);
    expect(() => buildSerialChapterPrompt({ chapter: 1, minChars: 2000 })).toThrow("上下限");
    expect(() => buildSerialChapterPrompt({ chapter: 1, minChars: 3000, maxChars: 2000 })).toThrow("下限不能大于上限");
    expect(() => buildSerialChapterPrompt({ chapter: 1, divergence: 3 })).toThrow("不生成正文");
  });

  it("keeps original user input sections, fresh sessions and the latest ten full bodies", () => {
    const prompt = buildSerialChapterPrompt({ chapter: 51, recentChapters: [{ number: 50, path: "正文/第050章_门外.md" }, { number: 41, path: "正文/第041章.md" }],
      originalContext: { chapterRaw: "第51章：新门\n已批准的剧情。", dossierText: "近期状态", settingsSlices: "相关人物", tail: "前章的最后三段", stylePrompt: "完整本书文风\n最后一条" } });
    expect(prompt).toContain("这是本章独立的新会话");
    expect(prompt).toContain("第 41–50 章正文全文");
    expect(prompt).toContain("摘要和上一章结尾不能替代这些最近正文的实际读取");
    expect(prompt).toContain("【本书文风补充（作者指定，优先级高于通用规范）】\n完整本书文风\n最后一条");
    expect(prompt).toContain("【本章细纲】\n第51章：新门\n已批准的剧情。");
    expect(prompt).toContain("【上一章最后 3 段原文】\n前章的最后三段");
    expect(prompt).toContain("不重新选题、重新规划全书、重排章节或改写文风");
    expect(buildSerialChapterPrompt({ chapter: 1 })).toContain("没有历史正文");
    expect(buildSerialChapterPrompt({ chapter: 2 })).toContain("第 1–1 章正文全文");
  });

  it("rejects stale, duplicate, other-workspace and backup context paths", () => {
    for (const recentChapters of [
      [{ number: 1, path: "正文/第001章.md" }],
      [{ number: 50, path: "../别的书/正文/第050章.md" }],
      [{ number: 50, path: "正文/第050章_原稿_20261116.md" }],
      [{ number: 50, path: "正文/第050章.md" }, { number: 50, path: "正文/第050章_另一本.md" }],
      [{ number: 50, path: "正文/第049章.md" }]
    ]) expect(() => buildSerialChapterPrompt({ chapter: 51, recentChapters })).toThrow("最近至多 10 章");
  });
});
