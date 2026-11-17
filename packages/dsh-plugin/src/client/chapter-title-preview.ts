export type ChapterTitlePreview =
  | { readonly kind: "candidates"; readonly titles: readonly string[] }
  | { readonly kind: "legacy"; readonly titles: readonly string[] }
  | { readonly kind: "missing" | "invalid"; readonly message: string };

export function proseChapterNumber(path: string | undefined): number | undefined {
  const match = path === undefined ? null : /^正文\/第0*(\d+)章(?:[_\s.-].*)?\.(?:md|txt)$/u.exec(path);
  const chapter = match === null ? 0 : Number(match[1]);
  return Number.isSafeInteger(chapter) && chapter > 0 ? chapter : undefined;
}

export function chapterTitleRecordPath(chapter: number): string {
  return `追踪/公众号标题/第${String(chapter).padStart(3, "0")}章.json`;
}

const missing: ChapterTitlePreview = { kind: "missing", message: "尚未生成独立公众号标题；正文里的短章名不是推文标题。" };

/** Only present title records bound to the exact saved prose, never to an unsaved draft. */
export async function chapterTitlePreview(content: string | undefined, chapter: number, savedProse: string): Promise<ChapterTitlePreview> {
  if (content === undefined) return missing;
  const invalid = { kind: "invalid", message: "公众号标题记录与当前正文不一致，暂不展示，请核对已保存正文与标题记录。" } as const;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return invalid; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid;
  const record = value as Record<string, unknown>;
  if (record.chapter !== chapter || typeof record.bodySha256 !== "string") return invalid;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(savedProse));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (record.bodySha256 !== hash) return invalid;
  const printable = (title: unknown): title is string => typeof title === "string" && title.trim() !== ""
    && [...title].length <= 200 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title);
  if (!printable(record.title)) return invalid;
  if (record.candidates === undefined) return { kind: "legacy", titles: [record.title] };
  const candidates = record.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 5 || !candidates.every(title => printable(title)
    && [...title.replace(/\s/gu, "")].length >= 15 && [...title.replace(/\s/gu, "")].length <= 25)
    || new Set(candidates).size !== 5 || !candidates.includes(record.title)) return invalid;
  return { kind: "candidates", titles: candidates as string[] };
}
