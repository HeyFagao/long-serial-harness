import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commitOriginalOutput, splitOriginalOutput, type OriginalOutputOptions, type OriginalTrackingLedger } from "../src/serial-output.js";
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
function reply(chapter = 1, body = "她走进屋里取来钥匙。".repeat(60)): string {
  return `第${String(chapter)}章 旧钥匙\n\n${body}\n\n【状态变更】\n本章摘要：发现钥匙的编号。\n实际字数：600\n章尾钩类型：疑问${String(chapter % 2)}\n人物：\n林青：知道钥匙被换过，尚不知道来人的名字。\n伏笔：\nFB001：新埋，发现钥匙柄的编号。\n时间：半小时\n与章纲不同的地方及原因：无\n下一章必须接住的事：确认编号来源。`;
}
function options(chapter = 1, attempt = 1): OriginalOutputOptions {
  return { active: { chapter, sessionId: `child-${String(chapter)}-${String(attempt)}`, requestId: `request-${String(chapter)}-${String(attempt)}`, attempt, dispatched: true },
    taskId: "task", text: reply(chapter), minChars: 500, maxChars: 800, totalChapters: 20, title: "旧钥匙" };
}

describe("original plain-text output host transaction", () => {
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
});
