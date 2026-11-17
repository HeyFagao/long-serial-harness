import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { chapterTitlePreview, chapterTitleRecordPath, proseChapterNumber } from "../src/client/chapter-title-preview.js";
import { SERIAL_PLUGIN_VERSION } from "../src/plugin-version.js";

describe("saved chapter headline preview", () => {
  const prose = "第1章 旧钥匙\n\n婆婆把钥匙拍在桌上，要求我交出存折。\n";
  const candidates = ["婆婆逼我交出三年存折，却先拍下那把旧钥匙", "她把旧钥匙拍上桌，开口就要我保管三年的存折", "婆婆突然伸手要存折，桌上的旧钥匙让我停手", "保管三年的存折被婆婆讨要，她却带来旧钥匙", "一把旧钥匙拍上桌，婆婆为何突然要我的存折"];
  const record = () => ({ chapter: 1, bodySha256: createHash("sha256").update(prose).digest("hex"), title: candidates[0], candidates });

  it("locates only prose chapter records", () => {
    expect(proseChapterNumber("正文/第001章.md")).toBe(1);
    expect(proseChapterNumber("正文/第020章_旧钥匙.txt")).toBe(20);
    for (const path of [undefined, "大纲/第001章.md", "正文/第000章.md", "正文/导入正文.md"]) expect(proseChapterNumber(path)).toBeUndefined();
    expect(chapterTitleRecordPath(1)).toBe("追踪/公众号标题/第001章.json");
  });
  it("shows all five independently saved candidates rather than the short prose heading", async () => {
    expect(await chapterTitlePreview(JSON.stringify(record()), 1, prose)).toEqual({ kind: "candidates", titles: candidates });
  });
  it("distinguishes missing title records from historical saved titles", async () => {
    expect(await chapterTitlePreview(undefined, 1, prose)).toMatchObject({ kind: "missing", message: expect.stringContaining("短章名不是推文标题") });
    const current = record();
    const legacy = { chapter: current.chapter, bodySha256: current.bodySha256, title: current.title };
    expect(await chapterTitlePreview(JSON.stringify(legacy), 1, prose)).toEqual({ kind: "legacy", titles: [legacy.title] });
  });
  it("never shows stale, different-chapter, malformed or partial title records", async () => {
    expect(await chapterTitlePreview(JSON.stringify(record()), 1, prose + "作者改稿")).toMatchObject({ kind: "invalid" });
    expect(await chapterTitlePreview(JSON.stringify(record()), 2, prose)).toMatchObject({ kind: "invalid" });
    for (const content of ["broken", JSON.stringify({ ...record(), candidates: candidates.slice(0, 4) }), JSON.stringify({ ...record(), candidates: ["两字", ...candidates.slice(1)] })]) expect(await chapterTitlePreview(content, 1, prose)).toMatchObject({ kind: "invalid" });
  });
  it("keeps the host/client version aligned with the installed package metadata", async () => {
    const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SERIAL_PLUGIN_VERSION).toBe(metadata.version);
  });
});
