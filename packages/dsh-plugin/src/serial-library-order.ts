import { parseFiling, type LibraryFiling } from "./serial-library-folders.js";

/** Pure helpers shared by the import preview and the host catalogue. */
export const LIBRARY_ORDER_PATH = "追踪/书库顺序.json";
export interface LibraryOrder {
  readonly schemaVersion: 1;
  readonly nextSequence: number;
  readonly sequences: Readonly<Record<string, number>>;
  readonly filing?: LibraryFiling;
  /** Includes reserved identities so hiding or restoring a book preserves its position. */
  readonly displayOrder?: readonly string[];
}

export interface LibraryBookMove {
  readonly id: string;
  readonly targetId: string;
  readonly position: "before" | "after";
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
  const displayOrder: unknown = object.displayOrder;
  if (displayOrder !== undefined && (!Array.isArray(displayOrder) || displayOrder.length !== seen.size
    || new Set(displayOrder).size !== seen.size || displayOrder.some(id => typeof id !== "string" || !Object.hasOwn(sequences, id)))) {
    throw new Error("书库顺序记录损坏，已保留原文件，未重新编号。");
  }
  return {
    schemaVersion: 1,
    nextSequence: Number(object.nextSequence),
    sequences: { ...sequences as Record<string, number> },
    ...(displayOrder === undefined ? {} : { displayOrder: [...displayOrder as string[]] }),
    ...(object.filing === undefined ? {} : { filing: parseFiling(object.filing, sequences) })
  };
}

export function extendLibraryOrder(order: LibraryOrder | undefined, ids: readonly string[]): LibraryOrder {
  const sequences: Record<string, number> = { ...order?.sequences };
  const displayOrder = order?.displayOrder === undefined ? undefined : [...order.displayOrder];
  let nextSequence = order?.nextSequence ?? 1;
  for (const id of ids) {
    if (sequences[id] !== undefined) continue;
    if (!/^[a-f0-9]{64}$/u.test(id) || !Number.isSafeInteger(nextSequence + 1)) throw new Error("书库序号已无法安全分配，未新建项目。");
    sequences[id] = nextSequence++;
    displayOrder?.push(id);
  }
  return { ...order, schemaVersion: 1, nextSequence, sequences, ...(displayOrder === undefined ? {} : { displayOrder }) };
}

export function moveLibraryDisplayOrder(order: LibraryOrder, move: LibraryBookMove): LibraryOrder {
  const { id, targetId, position } = move;
  if (id === targetId) return order;
  const importOrder = Object.keys(order.sequences).sort((left, right) => order.sequences[left]! - order.sequences[right]!);
  const previous = order.displayOrder ?? importOrder;
  const displayOrder = previous.filter(bookId => bookId !== id);
  const target = displayOrder.indexOf(targetId);
  if (target < 0 || displayOrder.length !== previous.length - 1) throw new Error("书籍顺序已变化，请刷新后再调整。");
  displayOrder.splice(target + (position === "after" ? 1 : 0), 0, id);
  if (displayOrder.every((bookId, index) => bookId === previous[index])) return order;
  if (displayOrder.every((bookId, index) => bookId === importOrder[index])) return resetLibraryDisplayOrder(order);
  return { ...order, displayOrder };
}

export function resetLibraryDisplayOrder(order: LibraryOrder): LibraryOrder {
  if (order.displayOrder === undefined) return order;
  const reset = { ...order };
  delete reset.displayOrder;
  return reset;
}

export function assignLibraryOrder<T extends { readonly id: string; readonly title: string }>(books: readonly T[], order: LibraryOrder | undefined): { readonly books: readonly (T & { readonly sequence: number })[]; readonly order: LibraryOrder } {
  const extended = extendLibraryOrder(order, [...books].sort(compareLegacyLibraryBooks).map(book => book.id));
  const positions = new Map(extended.displayOrder?.map((id, index) => [id, index]));
  const numbered = books.map(book => ({ ...book, sequence: extended.sequences[book.id]! }));
  numbered.sort((left, right) => (positions.get(left.id) ?? left.sequence) - (positions.get(right.id) ?? right.sequence) || compareLegacyLibraryBooks(left, right));
  return { order: extended, books: numbered };
}
