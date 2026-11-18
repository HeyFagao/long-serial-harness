import type { Context } from "@deepseek-ai/cordis";
import type { LibrarySnapshot } from "./serial-library.js";
import { WorkspaceHttpError } from "./workspace-route.js";

interface NativeWorkspaceRow {
  readonly id: string;
  readonly path: string;
}

export interface NativeWorkspaceOrder {
  list(): readonly NativeWorkspaceRow[];
  insertBefore(workspaceId: string, beforeWorkspaceId?: string): Promise<readonly string[]>;
}

/** Move only the library's registered books, preserving all other rows in relative order. */
async function moveLibraryBooks(workspaces: NativeWorkspaceOrder, libraryPath: string, bookPaths: readonly string[]): Promise<void> {
  const rows = workspaces.list();
  // Native registration and the local filesystem both use realpath as the canonical identity.
  const idsByPath = new Map(rows.map(row => [row.path, row.id]));
  const orderedBookIds = [...new Set(bookPaths.map(path => idsByPath.get(path)).filter(id => id !== undefined))];
  if (orderedBookIds.length === 0) return;

  const managedIds = new Set(orderedBookIds);
  const remainingRows = rows.filter(row => !managedIds.has(row.id));
  const libraryId = idsByPath.get(libraryPath);
  const libraryIndex = remainingRows.findIndex(row => row.id === libraryId);
  const firstBookIndex = rows.findIndex(row => managedIds.has(row.id));
  const insertIndex = libraryIndex === -1 ? firstBookIndex : libraryIndex + 1;
  let anchor = remainingRows[insertIndex]?.id;

  // Work backwards so each book can be inserted before its final successor.
  for (const bookId of [...orderedBookIds].reverse()) {
    const current = workspaces.list();
    const index = current.findIndex(row => row.id === bookId);
    if (index === -1) continue;
    if (current[index + 1]?.id !== anchor) await workspaces.insertBefore(bookId, anchor);
    anchor = bookId;
  }
}

const registryOperations = new WeakMap<NativeWorkspaceOrder, Promise<void>>();

/** Other libraries can own our anchors, so select anchors only after their moves settle. */
export async function applyNativeLibraryOrder(workspaces: NativeWorkspaceOrder, libraryPath: string, bookPaths: readonly string[]): Promise<void> {
  const previous = registryOperations.get(workspaces) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => moveLibraryBooks(workspaces, libraryPath, bookPaths));
  registryOperations.set(workspaces, operation);
  try { await operation; }
  finally {
    if (registryOperations.get(workspaces) === operation) registryOperations.delete(workspaces);
  }
}

/** The caller holds the library operation lock and supplies the latest host catalogue. */
export async function syncNativeLibrarySidebarOrder(context: Context, library: LibrarySnapshot, canonicalLibraryPath: string): Promise<void> {
  if (library.isBookProject) throw new WorkspaceHttpError(409, "请回到书库总览整理左侧工作区顺序。");
  const books = library.books.filter(book => book.absolutePath !== "" && book.totalChapters > 0 && book.status !== "incomplete");
  if (books.length === 0) return;
  const workspaces = context.get("workspaceRegistry") as NativeWorkspaceOrder | undefined;
  if (workspaces === undefined || typeof workspaces.list !== "function" || typeof workspaces.insertBefore !== "function") {
    throw new WorkspaceHttpError(409, "Harness 工作区排序暂不可用，请刷新后重试。");
  }
  await applyNativeLibraryOrder(workspaces, canonicalLibraryPath, books.map(book => book.absolutePath));
}
