import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractOriginalField } from "../src/original-state.js";
import { commitOriginalOutput, recoverPendingOriginalChapter, splitOriginalOutput, type OriginalOutputOptions, type OriginalTrackingLedger } from "../src/serial-output.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

function fixture() {
  const files = new Map<string, string>();
  const versions = new Map<string, number>();
  let writes = 0;
  let failAt: number | undefined;
  const realm = {
    sessionId: "owner", cwd: "/book", root: "/book", agent: { session: {} }, sandboxPolicy: { resolve: () => ({}) },
    fs: {
      resolve: async (path: string) => path,
      contains: () => true,
      stat: async (path: string) => files.has(path) ? { type: "file", version: String(versions.get(path) ?? 0), size: Buffer.byteLength(files.get(path)!) }
        : [...files.keys()].some(key => key.startsWith(`${path}/`)) ? { type: "directory", version: "dir" } : undefined,
      readBytes: async (path: string) => Buffer.from(files.get(path)!),
      listDir: async (path: string) => [...files.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
        .map(key => ({ type: "file", target: key, name: key.slice(path.length + 1) })),
      writeText: async (path: string, content: string, expected: { kind: string; version?: string }) => {
        writes += 1;
        if (writes === failAt) throw new Error("simulated host crash");
        if (expected.kind === "createIfAbsent" ? files.has(path) : String(versions.get(path) ?? 0) !== expected.version) throw new Error("CAS conflict");
        files.set(path, content); versions.set(path, (versions.get(path) ?? 0) + 1);
        return { version: String(versions.get(path)) };
      }
    }
  } as unknown as WorkspaceRealm;
  return { realm, files, writes: () => writes, failOn: (n?: number) => { failAt = n; }, ledger: () => JSON.parse(files.get("追踪/_tracking-state.json")!) as OriginalTrackingLedger };
}
function reply(chapter = 1, body = "她走进屋里取来钥匙。".repeat(180)): string {
  return `第${String(chapter)}章 旧钥匙\n\n${body}\n\n【状态变更】\n本章摘要：发现钥匙的编号。\n实际字数：600\n章尾钩类型：疑问${String(chapter % 2)}\n人物：\n林青：知道钥匙被换过，尚不知道来人的名字。\n伏笔：\nFB001：新埋，发现钥匙柄的编号。\n时间：半小时\n与章纲不同的地方及原因：无\n下一章必须接住的事：确认编号来源。`;
}
function options(chapter = 1, attempt = 1): OriginalOutputOptions {
  return { active: { chapter, sessionId: `child-${String(chapter)}-${String(attempt)}`, requestId: `request-${String(chapter)}-${String(attempt)}`, attempt, dispatched: true },
    taskId: "task", text: reply(chapter), minChars: 500, maxChars: 800, totalChapters: 20, title: "旧钥匙" };
}

describe("original plain-text output host transaction", () => {
  it("accepts 1501 and 2524 characters despite the old suggested range, but rejects 1500", async () => {
    for (const count of [1500, 1501, 2524, 8000]) {
      const f = fixture();
      const text = reply(1, "字".repeat(count)).replace("第1章 旧钥匙\n\n", "");
      const result = await commitOriginalOutput(f.realm, { ...options(), text, minChars: 2300, maxChars: 2500 });
      expect(result.accepted).toBe(count > 1500);
    }
  });
  it("splits the original two-block contract without including state in prose", () => {
    expect(splitOriginalOutput("\n正文\n\n【状态变更】\n本章摘要：全文\n")).toEqual({ prose: "正文", change: "【状态变更】\n本章摘要：全文" });
    expect(splitOriginalOutput("只有正文")).toEqual({ prose: "只有正文", change: "" });
  });

  it("writes the body and full state first, then commits an independent truthful ledger", async () => {
    const f = fixture();
    const result = await commitOriginalOutput(f.realm, options());
    expect(result.accepted).toBe(true);
    const body = f.files.get("正文/第001章.md")!;
    expect(body).not.toContain("【状态变更】");
    expect(f.files.get("追踪/状态变更/第001章.md")).toContain("尚不知道来人的名字");
    const ledger = f.ledger();
    expect(ledger).toMatchObject({ kind: "serial-original", schema_version: 1, last_committed_chapter: 1, state_revision: 1 });
    expect(ledger.wordcount_records["1"]?.body_sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(ledger.original_state.next_chapter).toBe(2);
    expect(ledger.original_state.characters.林青?.note).toContain("尚不知道来人的名字");
    expect(ledger.pending_chapters).toEqual({});
  });

  it("replays the same receipt idempotently and protects accepted chapters and author edits", async () => {
    const f = fixture(); await commitOriginalOutput(f.realm, options()); const writes = f.writes();
    await commitOriginalOutput(f.realm, options()); expect(f.writes()).toBe(writes); expect(f.ledger().state_revision).toBe(1);
    await expect(commitOriginalOutput(f.realm, { ...options(), text: reply(1, "换稿".repeat(300)) })).rejects.toThrow("最终输出发生变化");
    await expect(commitOriginalOutput(f.realm, options(1, 2))).rejects.toThrow("已经验收");
    f.files.set("正文/第001章.md", "作者改过的正文");
    await expect(commitOriginalOutput(f.realm, options())).rejects.toThrow("保留作者操作");
    expect(f.files.get("正文/第001章.md")).toBe("作者改过的正文");
  });

  it("recovers after a crash between output files without advancing partial progress", async () => {
    const f = fixture(); f.failOn(3);
    await expect(commitOriginalOutput(f.realm, options())).rejects.toThrow("simulated host crash");
    expect(f.files.has("正文/第001章.md")).toBe(true);
    expect(f.files.has("追踪/_tracking-state.json")).toBe(false);
    const originalBody = f.files.get("正文/第001章.md");
    f.failOn(); await commitOriginalOutput(f.realm, options());
    expect(f.files.get("正文/第001章.md")).toBe(originalBody);
    expect(f.ledger().last_committed_chapter).toBe(1);
  });

  it("saves a failed draft without committing its story state and permits only its owned repair", async () => {
    const f = fixture(); const short = { ...options(), text: reply(1, "短稿") };
    expect((await commitOriginalOutput(f.realm, short)).accepted).toBe(false);
    expect(f.ledger().last_committed_chapter).toBe(0);
    expect(f.ledger().original_state.characters).toEqual({});
    expect(f.ledger().pending_chapters["1"]?.issues.join(" ")).toContain("字数");
    await expect(commitOriginalOutput(f.realm, options(1, 2))).rejects.toThrow("只有明确修订轮次");
    const repair = options(1, 2);
    await commitOriginalOutput(f.realm, { ...repair, active: { ...repair.active, repairIssues: ["字数不足"] } });
    expect(f.ledger().last_committed_chapter).toBe(1);
    expect(f.ledger().pending_chapters).toEqual({});
    expect(f.files.get("追踪/连载输出/task/child-1-1.json")).toContain("短稿");
  });

  it("does not overwrite unrelated or edited unaccepted manuscripts", async () => {
    const f = fixture(); f.files.set("正文/第001章.md", "原有未登记稿");
    await expect(commitOriginalOutput(f.realm, options())).rejects.toThrow("不是本次可修订");
    expect(f.writes()).toBe(0);
    const g = fixture(); await commitOriginalOutput(g.realm, { ...options(), text: reply(1, "短稿") });
    g.files.set("正文/第001章.md", "人工修改后的短稿");
    const repair = options(1, 2);
    await expect(commitOriginalOutput(g.realm, { ...repair, active: { ...repair.active, repairIssues: ["字数不足"] } })).rejects.toThrow("不是本次可修订");
    expect(g.files.get("正文/第001章.md")).toBe("人工修改后的短稿");
  });

  it("checks original quality fields and does not silently merge state across books", async () => {
    const first = fixture(); const second = fixture();
    await commitOriginalOutput(first.realm, options());
    await commitOriginalOutput(first.realm, options(2));
    expect(first.ledger().last_committed_chapter).toBe(2);
    expect(second.files.size).toBe(0);
    const result = await commitOriginalOutput(second.realm, { ...options(), text: "她拿起钥匙。".repeat(120) });
    expect(result.accepted).toBe(false); expect(result.issues).toContain("缺少【状态变更】区块，必须按字段补齐。");
    expect(second.ledger().last_committed_chapter).toBe(0);
  });

  it("preserves legacy committed memory and refuses empty or partial results", async () => {
    const f = fixture(); f.files.set("追踪/_tracking-state.json", JSON.stringify({ schema_version: 4, last_committed_chapter: 8 }));
    await expect(commitOriginalOutput(f.realm, options())).rejects.toThrow("需要先完成明确迁移");
    expect(f.writes()).toBe(0);
    await expect(commitOriginalOutput(f.realm, { ...options(), text: undefined })).rejects.toThrow("没有可保存");
  });

  it("keeps original planned FB dates in the dossier and rejects omitted required plant records", async () => {
    const outlineSource = "书名：旧钥匙\n第1章 发现\n本章出场人物：林青、许白\n◆写作重点：埋设FB001，留在钥匙柄上。\n本章钩子：有人回来。\n第2章 答案\n本章出场人物：许白\n◆写作重点：回收FB001，确认编号来源。\n本章钩子：门外又有脚步。";
    const chapterRaw = "第1章 发现\n◆写作重点：埋设FB001，留在钥匙柄上。";
    const f = fixture();
    const missing = { ...options(), outlineSource, chapterRaw, bookTitle: "旧钥匙", text: reply().replace("FB001：新埋，发现钥匙柄的编号。", "无") };
    const result = await commitOriginalOutput(f.realm, missing);
    expect(result.accepted).toBe(false); expect(result.issues.join(" ")).toContain("细纲要求埋设 FB01");
    expect(f.ledger().last_committed_chapter).toBe(0);
    expect(f.ledger().original_state.fb.FB01).toMatchObject({ status: "未埋", plant_chapter: 1, planned_reap: 2, reap_chapter: null });
    expect(f.ledger().original_state.characters.许白?.note).toBe("未登场");
    const repair = options(1, 2);
    await commitOriginalOutput(f.realm, { ...repair, outlineSource, chapterRaw, active: { ...repair.active, repairIssues: ["登记必埋伏笔"] } });
    expect(f.ledger().last_committed_chapter).toBe(1);
    expect(f.ledger().original_state.fb.FB01).toMatchObject({ status: "已埋未收", plant_chapter: 1, planned_reap: 2, reap_chapter: null });
    const second = { ...options(2), outlineSource, chapterRaw: "第2章 答案\n写作重点：回收FB001" , text: reply(2).replace("FB001：新埋，发现钥匙柄的编号。", "FB001：未回收，仍不知道编号来源。") };
    await commitOriginalOutput(f.realm, second);
    expect(f.ledger().original_state.fb.FB01?.reap_chapter).toBeNull();
  });

  it("accepts a full chapter whose only defect is a repeated hook, and does not let an edit note replace it", async () => {
    const f = fixture();
    const chapter = (hook: string, body = "她把账本摊开，逐笔核对转出的金额。") => `第1章 金额对不上\n\n${body.repeat(100)}\n\n【状态变更】\n本章摘要：核对转出金额。\n实际字数：2400\n章尾钩类型：${hook}\n人物：\n周桂兰：发现金额对不上。\n伏笔：\n无\n时间：半小时\n与章纲不同的地方及原因：无\n下一章必须接住的事：继续核对那笔转账。`;
    await commitOriginalOutput(f.realm, { ...options(), text: chapter("隐藏含义") });
    expect(f.ledger().last_committed_chapter).toBe(1);
    expect(f.ledger().original_state.recent.at(-1)?.hook_type).toBe("隐藏含义");
    const repeated = chapter("隐藏含义", "她又把账本摊开，问这笔金额到底差在哪里。").replaceAll("第1章", "第2章");
    const second = await commitOriginalOutput(f.realm, { ...options(2), text: repeated });
    expect(second.accepted).toBe(true);
    expect(f.ledger().last_committed_chapter).toBe(2);
    expect(f.ledger().original_state.recent.at(-1)?.hook_type).not.toBe("隐藏含义");
    const saved = f.files.get("正文/第002章.md")!;
    expect(saved).toContain("她又把账本摊开");
    expect(saved).toContain("这一步停在做到一半的地方");
    expect(saved).not.toContain("建议最小修改");
    const advice = "建议最小修改如下，正文其余内容全部保留：\n\n将章尾三段改为：\n\n她把截图放到桌上。\n\n“你先别关页面。”\n\n他的手停在半空。\n\n状态变更中改为：\n\n- 章尾钩类型：未完成动作\n- 下一章必须接住的事：核对接下来的那一笔。";
    await expect(commitOriginalOutput(f.realm, { ...options(2, 2), text: advice, active: { ...options(2, 2).active, repairIssues: ["章尾钩类型重复"] } })).rejects.toThrow("已经验收");
    expect(f.files.get("正文/第002章.md")).toBe(saved);
  });

  it("keeps the longer draft when a repair returns only an edit note, then recovers it on continue", async () => {
    const f = fixture();
    const full = `第2章 金额对不上\n\n${"她把账本摊开，问这笔金额为什么对不上。".repeat(80)}\n\n【状态变更】\n本章摘要：核对转出金额。\n实际字数：2400\n章尾钩类型：隐藏含义\n人物：\n周桂兰：发现金额对不上。\n伏笔：\n无\n时间：半小时\n与章纲不同的地方及原因：无\n下一章必须接住的事：继续核对那笔转账。`;
    await commitOriginalOutput(f.realm, { ...options(), text: full.replace("第2章", "第1章") });
    const pending = full;
    const note = `建议采用“未完成动作”钩子，最小修改上一版结尾三段，保留前文不动：\n\n她看着账本。`;
    // An older build left the full chapter pending. A new repair must not replace it with the note.
    const planted = `${pending.split("【状态变更】")[0]!.trim()}\n`;
    const plantedChange = `【状态变更】\n${pending.split("【状态变更】")[1]!.trim()}\n`;
    f.files.set("正文/第002章.md", planted);
    f.files.set("追踪/状态变更/第002章.md", plantedChange);
    f.files.set("追踪/逐章记录/第002章.md", "# 第002章 · 金额对不上\n\n- 结果：核对转出金额。\n- 下一章承诺：继续核对那笔转账。\n");
    const plantedLedger = f.ledger();
    plantedLedger.pending_chapters["2"] = { taskId: "task", childSessionId: "child-2-1", prosePath: "正文/第002章.md",
      body_sha256: createHash("sha256").update(planted).digest("hex"), change_sha256: createHash("sha256").update(plantedChange).digest("hex"),
      record_sha256: createHash("sha256").update(f.files.get("追踪/逐章记录/第002章.md")!).digest("hex"), issues: ["章尾钩类型「隐藏含义」与上一章重复，换一种钩子写法与类型。"] };
    f.files.set("追踪/_tracking-state.json", `${JSON.stringify(plantedLedger, null, 2)}\n`);
    const stored = await commitOriginalOutput(f.realm, { ...options(2, 2), active: { ...options(2, 2).active, repairIssues: ["章尾钩类型重复"] }, text: note });
    expect(stored.accepted).toBe(true);
    expect(f.files.get("正文/第002章.md")).not.toContain("保留前文不动");
    expect(f.files.get("正文/第002章.md")).toContain("她把账本摊开");
    expect(extractOriginalField(f.files.get("追踪/状态变更/第002章.md")!, "章尾钩类型")).not.toBe("隐藏含义");
  });

  it("recovers an older pending chapter that failed only because its hook repeated", async () => {
    const f = fixture();
    const full = `第2章 金额对不上\n\n${"她把账本摊开，问这笔金额为什么对不上。".repeat(80)}\n\n【状态变更】\n本章摘要：核对转出金额。\n实际字数：2400\n章尾钩类型：隐藏含义\n人物：\n周桂兰：发现金额对不上。\n伏笔：\n无\n时间：半小时\n与章纲不同的地方及原因：无\n下一章必须接住的事：继续核对那笔转账。`;
    await commitOriginalOutput(f.realm, { ...options(), text: full.replace("第2章", "第1章") });
    const prose = `${full.split("【状态变更】")[0]!.trim()}\n`;
    const change = `【状态变更】\n${full.split("【状态变更】")[1]!.trim()}\n`;
    f.files.set("正文/第002章.md", prose);
    f.files.set("追踪/状态变更/第002章.md", change);
    f.files.set("追踪/逐章记录/第002章.md", "# 第002章 · 金额对不上\n\n- 结果：核对转出金额。\n- 下一章承诺：继续核对那笔转账。\n");
    const ledger = f.ledger();
    ledger.pending_chapters["2"] = { taskId: "task", childSessionId: "child-2-1", prosePath: "正文/第002章.md",
      body_sha256: createHash("sha256").update(prose).digest("hex"), change_sha256: createHash("sha256").update(change).digest("hex"),
      record_sha256: createHash("sha256").update(f.files.get("追踪/逐章记录/第002章.md")!).digest("hex"), issues: ["章尾钩类型「隐藏含义」与上一章重复，换一种钩子写法与类型。"] };
    f.files.set("追踪/_tracking-state.json", `${JSON.stringify(ledger, null, 2)}\n`);
    expect(await recoverPendingOriginalChapter(f.realm, "task", 2)).toBe(true);
    expect(f.ledger().last_committed_chapter).toBe(2);
    expect(f.ledger().pending_chapters["2"]).toBeUndefined();
    expect(extractOriginalField(f.files.get("追踪/状态变更/第002章.md")!, "章尾钩类型")).not.toBe("隐藏含义");
    expect(f.files.get("正文/第002章.md")).toContain("她把账本摊开");
    expect(f.files.get("正文/第002章.md")).not.toContain("前文");
  });

  it("replaces an engineering word instead of blocking an otherwise finished chapter", async () => {
    const f = fixture();
    const text = `第1章 旧钥匙\n\n${"她把前文的账目又看了一遍，数字还是对不上。".repeat(80)}\n\n【状态变更】\n本章摘要：再次核对账目。\n实际字数：2400\n章尾钩类型：信息差\n人物：\n周桂兰：仍不接受含糊的说法。\n伏笔：\n无\n时间：片刻\n与章纲不同的地方及原因：无\n下一章必须接住的事：把那笔数字对上。`;
    const result = await commitOriginalOutput(f.realm, { ...options(), text });
    expect(result.accepted).toBe(true);
    expect(f.files.get("正文/第001章.md")).not.toContain("前文");
    expect(f.files.get("正文/第001章.md")).toContain("先前");
  });
});
