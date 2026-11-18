export interface LibraryFolder {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly createdAt: string;
}

interface StoredFolder extends LibraryFolder {
  /** First receipt and the catalogue live in separate files. Hide a reservation until its first book exists. */
  readonly pending?: true;
}

export interface LibraryFiling {
  readonly nextNumber: number;
  readonly folders: readonly StoredFolder[];
  readonly memberships: Readonly<Record<string, string>>;
}

export const emptyFiling: LibraryFiling = { nextNumber: 1, folders: [], memberships: {} };

const labelKey = (name: string): string => name.normalize("NFKC").toLocaleLowerCase("zh-CN");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function folderName(value: unknown): string {
  if (typeof value !== "string") throw new Error("请输入文件夹名称。");
  const name = value.trim().normalize("NFC");
  if (!name || [...name].length > 60 || [...name].some(c => /\p{Cc}/u.test(c))) throw new Error("文件夹名称需为 1—60 个可见字符。");
  if (["全部", "全部书籍", "历史未分组", "未分组"].includes(labelKey(name))) throw new Error("这个名称用于书库视图，请换一个文件夹名称。");
  return name;
}

export function availableFolderName(filing: LibraryFiling, value: unknown, exceptId?: string): string {
  const name = folderName(value);
  if (filing.folders.some(folder => folder.id !== exceptId && labelKey(folder.name) === labelKey(name))) throw new Error("已有同名文件夹，请选择已有文件夹或换一个名称。");
  return name;
}

function batchLabel(number: number): string {
  if (number >= 10_000) return `第${String(number)}批`;
  const digits = "零一二三四五六七八九";
  let numeral = "";
  let zero = false;
  for (const [index, digit] of Array.from(String(number), Number).entries()) {
    const place = String(number).length - index - 1;
    if (digit === 0) { zero = true; continue; }
    if (zero) numeral += "零";
    if (digit !== 1 || place !== 1 || index !== 0) numeral += digits[digit]!;
    numeral += ["", "十", "百", "千"][place]!;
    zero = false;
  }
  return `第${numeral}批`;
}

export function addFolder(filing: LibraryFiling, id: string, name?: string, pending = false): { filing: LibraryFiling; folder: LibraryFolder } {
  let number = filing.nextNumber;
  while (name === undefined && filing.folders.some(item => labelKey(item.name) === labelKey(batchLabel(number)))) number++;
  if (!Number.isSafeInteger(number + 1)) throw new Error("文件夹批次序号已用尽。");
  const folder = { id, name: availableFolderName(filing, name ?? batchLabel(number)), number, createdAt: new Date().toISOString() };
  return { filing: { ...filing, folders: [...filing.folders, { ...folder, ...(pending ? { pending: true } : {}) }], nextNumber: number + 1 }, folder };
}

export function requireFolder(filing: LibraryFiling, id: unknown): LibraryFolder {
  const folder = filing.folders.find(item => item.id === id);
  if (!folder) throw new Error("文件夹已不存在，请刷新书库后重选。");
  return folder;
}

export function dropFolder(filing: LibraryFiling, id: string): LibraryFiling {
  return {
    ...filing,
    folders: filing.folders.filter(folder => folder.id !== id),
    memberships: Object.fromEntries(Object.entries(filing.memberships).filter(([, folderId]) => folderId !== id))
  };
}

/** Commit folders with materialized receipts and discard abandoned, still empty import reservations. */
export function settleFiling(filing: LibraryFiling, books: readonly { readonly id: string }[]): LibraryFiling {
  if (!filing.folders.some(folder => folder.pending)) return filing;
  const populated = new Set(books.map(book => filing.memberships[book.id]));
  let next = filing;
  for (const folder of filing.folders) {
    if (!folder.pending) continue;
    if (!populated.has(folder.id)) {
      next = dropFolder(next, folder.id);
      // A reservation without any receipt has never been shown as a batch.
      if (folder.number + 1 === next.nextNumber) next = { ...next, nextNumber: folder.number };
      continue;
    }
    const committed = { id: folder.id, name: folder.name, createdAt: folder.createdAt, number: folder.number };
    next = { ...next, folders: next.folders.map(item => item.id === folder.id ? committed : item) };
  }
  return next;
}

export function parseFiling(raw: unknown, sequences: object): LibraryFiling {
  const damaged = () => new Error("书库文件夹记录损坏，已保留原文件。");
  if (!record(raw) || !Number.isSafeInteger(raw.nextNumber) || Number(raw.nextNumber) < 1 || !Array.isArray(raw.folders) || !record(raw.memberships)) throw damaged();
  const names = new Set<string>();
  const ids = new Set<string>();
  let lastNumber = 0;
  for (const folder of raw.folders as unknown[]) {
    if (!record(folder) || typeof folder.id !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(folder.id) || ids.has(folder.id)
      || !Number.isSafeInteger(folder.number) || Number(folder.number) <= lastNumber || Number(folder.number) >= Number(raw.nextNumber)
      || typeof folder.createdAt !== "string" || !Number.isFinite(Date.parse(folder.createdAt))
      || typeof folder.name !== "string" || folder.name !== folderName(folder.name) || names.has(labelKey(folder.name))
      || (folder.pending !== undefined && folder.pending !== true)) throw damaged();
    ids.add(folder.id); names.add(labelKey(folder.name)); lastNumber = Number(folder.number);
  }
  for (const [id, folderId] of Object.entries(raw.memberships)) {
    if (!Object.hasOwn(sequences, id) || typeof folderId !== "string" || !ids.has(folderId)) throw damaged();
  }
  return raw as unknown as LibraryFiling;
}
