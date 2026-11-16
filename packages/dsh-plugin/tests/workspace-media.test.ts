import { describe, expect, it } from "vitest";
import { assertCreativePath } from "../src/workspace-route.js";

describe("novel workspace document boundary", () => {
  it("keeps novel outlines, style, prose and tracking editable", () => {
    for (const name of [
      "大纲/细纲_第001章.md", "设定/文风.md", "正文/第001章.md",
      "追踪/连载任务.json", "追踪/连载上下文/batch-1/child-1.json", "参考资料/参考.txt",
      "正文.md", "设定.md", "小节大纲.md"
    ]) {
      expect(() => { assertCreativePath(name, "text"); }).not.toThrow();
    }
  });

  it("does not expose removed workbenches through the generic editor", () => {
    for (const path of [
      "剧集/EP001/剧本.md", "设定集/人物.md", "交付/发布说明.md", "short-drama.json",
      "game-adaptations/demo/PRODUCT_BRIEF.md", "game-adaptations/demo/app.js",
      "video-recaps/demo/project.json", "video-recaps/demo/narration.md"
    ]) {
      expect(() => { assertCreativePath(path, "text"); }).toThrow();
    }
  });

  it("rejects media, executable files, traversal and unrelated root files", () => {
    for (const path of [
      "正文/../secret.md", "/正文/第001章.md", "正文\\第001章.md", "正文//第001章.md",
      "正文/run.sh", "正文/run.js", "private/secret.md", "README.md", "笔记.md"
    ]) {
      expect(() => { assertCreativePath(path, "text"); }).toThrow();
    }
    for (const path of ["正文/cover.png", "剧集/EP001/output.mp4", "video-recaps/demo/input.mkv"]) {
      expect(() => { assertCreativePath(path, "media"); }).toThrow();
    }
  });
});
