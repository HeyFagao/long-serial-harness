import { strToU8, zipSync } from "fflate";
import { readChapterHeadline } from "./wechat-title.js";

export interface ExportChapter { readonly number: number; readonly prose: string; readonly headline?: string }
export interface ExportBook { readonly title: string; readonly totalChapters: number; readonly chapters: readonly ExportChapter[] }

export function safeExportName(title: string): string {
  const printable = [...title.normalize("NFC")].map(char => char.charCodeAt(0) < 32 ? "_" : char).join("");
  const safe = [...printable.replace(/[<>:"/\\|?*]/gu, "_").replace(/[. ]+$/u, "").trim()].slice(0, 48).join("");
  return safe === "" || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(safe) ? `小说_${safe}` : safe;
}

/** One ZIP per book, one TXT per chapter. Formatting does not mutate the saved manuscript. */
export function createChapterZip(book: ExportBook): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const notes = [`书名：《${book.title}》`, `本次导出 ${String(book.chapters.length)} / ${String(book.totalChapters)} 章。`, "每章独立TXT，第一行为标题，随后保留书名、章号和正文。", "标题沿用保存稿件；旧稿不会在导出时重新调用模型或改写。", ""];
  for (const chapter of book.chapters) {
    const parsed = readChapterHeadline(chapter.prose, chapter.number);
    const title = chapter.headline ?? parsed?.title ?? `第${String(chapter.number)}章`;
    const filename = `第${String(chapter.number).padStart(3, "0")}章_${safeExportName(title)}.txt`;
    const text = `${title}\n书名：《${book.title}》\n第${String(chapter.number)}章\n\n${parsed?.body ?? chapter.prose.trim()}\n`;
    entries[filename] = strToU8(`\uFEFF${text.replace(/\r?\n/gu, "\r\n")}`);
    notes.push(`${String(chapter.number).padStart(3, "0")}｜${title}`);
    if (parsed === undefined) notes.push("  旧稿没有可识别标题行，本次保留正文；请人工补题。");
  }
  entries["目录与导出说明.txt"] = strToU8(`\uFEFF${notes.join("\r\n")}\r\n`);
  return zipSync(entries, { level: 1 });
}
