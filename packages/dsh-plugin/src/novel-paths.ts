/** File boundary for the long-serial workbench only. */
export const NOVEL_DIRECTORIES = ["正文", "大纲", "设定", "追踪", "对标", "参考资料"] as const;
export const NOVEL_ROOT_FILES = ["正文.md", "设定.md", "小节大纲.md"] as const;
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".txt", ".json", ".jsonl"]);

export function safeNovelRelativePath(path: string): boolean {
  return path !== ""
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export function editableNovelPath(path: string): boolean {
  const filename = path.split("/").at(-1) ?? "";
  const dot = filename.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/** Machine records remain readable, but the public document editor must not rewrite them. */
export function isInternalRecordPath(path: string): boolean {
  return safeNovelRelativePath(path) && path.startsWith("追踪/") && /\.(?:json|jsonl)$/iu.test(path);
}
