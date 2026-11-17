import { strToU8, zipSync } from "fflate";
import { readChapterHeadline } from "./wechat-title.js";

export interface ExportChapter { readonly number: number; readonly prose: string; readonly headline?: string; readonly headlineCandidates?: readonly string[] }
export interface ExportBook { readonly title: string; readonly totalChapters: number; readonly chapters: readonly ExportChapter[] }

export function safeExportName(title: string): string {
  const printable = [...title.normalize("NFC")].map(char => char.charCodeAt(0) < 32 ? "_" : char).join("");
  const safe = [...printable.replace(/[<>:"/\\|?*]/gu, "_").replace(/[. ]+$/u, "").trim()].slice(0, 48).join("");
  return safe === "" || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(safe) ? `小说_${safe}` : safe;
}

/** One ZIP per book, one TXT per chapter. Formatting does not mutate the saved manuscript. */
export function createChapterZip(book: ExportBook): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const notes = [`书名：《${book.title}》`, `本次导出 ${String(book.chapters.length)} / ${String(book.totalChapters)} 章。`, "每章独立TXT，开头列出已保存的五个备选标题，可自行选择一个发布；随后保留书名、章号和正文。", "旧稿只有一个标题时沿用该标题；导出不会重新调用模型或改写。", ""];
  for (const chapter of book.chapters) {
    const parsed = readChapterHeadline(chapter.prose, chapter.number);
    const title = chapter.headline ?? parsed?.title ?? `第${String(chapter.number)}章`;
    const filename = `第${String(chapter.number).padStart(3, "0")}章_${safeExportName(title)}.txt`;
    const titleBlock = chapter.headlineCandidates === undefined ? title
      : ["本章备选标题（任选一个用于发布）", ...chapter.headlineCandidates.map((candidate, index) => `${String(index + 1)}. ${candidate}`), ""].join("\n");
    const text = `${titleBlock}\n书名：《${book.title}》\n第${String(chapter.number)}章\n\n${parsed?.body ?? chapter.prose.trim()}\n`;
    entries[filename] = strToU8(`\uFEFF${text.replace(/\r?\n/gu, "\r\n")}`);
    notes.push(`${String(chapter.number).padStart(3, "0")}｜${title}`);
    if (parsed === undefined) notes.push("  旧稿没有可识别标题行，本次保留正文；请人工补题。");
  }
  entries["目录与导出说明.txt"] = strToU8(`\uFEFF${notes.join("\r\n")}\r\n`);
  return zipSync(entries, { level: 1 });
}
