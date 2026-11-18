/** Pure helpers shared by the import preview and the host catalogue. */
export const LIBRARY_ORDER_PATH = "追踪/书库顺序.json";
export interface LibraryOrder {
  readonly schemaVersion: 1;
  readonly nextSequence: number;
  readonly sequences: Readonly<Record<string, number>>;
}

export function compareLibraryInputFilenames(left: { readonly filename: string }, right: { readonly filename: string }): number {
  return left.filename.localeCompare(right.filename, "zh-Hans-CN", { numeric: true }) || left.filename.localeCompare(right.filename);
}

/** This is the previous release's display order, used once when upgrading a legacy catalogue. */
export function compareLegacyLibraryBooks(left: { readonly title: string; readonly id: string }, right: { readonly title: string; readonly id: string }): number {
  return left.title.localeCompare(right.title, "zh-Hans-CN") || left.id.localeCompare(right.id);
}

export function parseLibraryOrder(value: unknown): LibraryOrder {
  const object = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const sequences = object?.sequences;
  if (object?.schemaVersion !== 1 || !Number.isSafeInteger(object.nextSequence) || Number(object.nextSequence) < 1
    || typeof sequences !== "object" || sequences === null || Array.isArray(sequences)) throw new Error("书库顺序记录损坏，已保留原文件，未重新编号。");
  const seen = new Set<number>();
  for (const [id, sequence] of Object.entries(sequences)) {
    if (!/^[a-f0-9]{64}$/u.test(id) || !Number.isSafeInteger(sequence) || Number(sequence) < 1 || Number(sequence) >= Number(object.nextSequence) || seen.has(Number(sequence))) throw new Error("书库顺序记录损坏，已保留原文件，未重新编号。");
    seen.add(Number(sequence));
  }
  return { schemaVersion: 1, nextSequence: Number(object.nextSequence), sequences: { ...sequences as Record<string, number> } };
}

export function extendLibraryOrder(order: LibraryOrder | undefined, ids: readonly string[]): LibraryOrder {
  const sequences: Record<string, number> = { ...order?.sequences };
  let nextSequence = order?.nextSequence ?? 1;
  for (const id of ids) {
    if (sequences[id] !== undefined) continue;
    if (!/^[a-f0-9]{64}$/u.test(id) || !Number.isSafeInteger(nextSequence + 1)) throw new Error("书库序号已无法安全分配，未新建项目。");
    sequences[id] = nextSequence++;
  }
  return { schemaVersion: 1, nextSequence, sequences };
}

export function assignLibraryOrder<T extends { readonly id: string; readonly title: string }>(books: readonly T[], order: LibraryOrder | undefined): { readonly books: readonly (T & { readonly sequence: number })[]; readonly order: LibraryOrder } {
  const extended = extendLibraryOrder(order, [...books].sort(compareLegacyLibraryBooks).map(book => book.id));
  return { order: extended, books: books.map(book => ({ ...book, sequence: extended.sequences[book.id]! })).sort((left, right) => left.sequence - right.sequence || compareLegacyLibraryBooks(left, right)) };
}
