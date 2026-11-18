import type { Context } from "@deepseek-ai/cordis";
import type { LibrarySnapshot } from "./serial-library.js";
import { groupsForLibraryBooks, UNGROUPED_LIBRARY_LABEL } from "./serial-library-groups.js";
import { WorkspaceHttpError } from "./workspace-route.js";

interface NativeWorkspaceRow {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

export interface NativeWorkspaceOrder {
  list(): readonly NativeWorkspaceRow[];
  insertBefore(workspaceId: string, beforeWorkspaceId?: string): Promise<readonly string[]>;
}

interface NativeWorkspaceNames {
  rename(request: { workspaceId: string; title: string }): Promise<unknown>;
}

interface SidebarBook {
  readonly path: string;
  readonly title: string;
}

/** The native sidebar is flat; include the folder and fixed book number in every display label. */
export function nativeLibraryBookRows(library: Pick<LibrarySnapshot, "books" | "folders">): readonly SidebarBook[] {
  const active = library.books.filter(book => book.absolutePath !== "" && book.totalChapters > 0 && book.status !== "incomplete");
  return groupsForLibraryBooks(active, library.folders).flatMap(({ folder, books }) =>
    books.map(book => ({
      path: book.absolutePath,
      title: [folder?.name ?? UNGROUPED_LIBRARY_LABEL,
        ...(book.sequence === undefined ? [] : [String(book.sequence).padStart(3, "0")]), book.title].join(" · ")
    })));
}

async function labelLibraryBooks(workspaces: NativeWorkspaceOrder, names: NativeWorkspaceNames, books: readonly SidebarBook[]): Promise<void> {
  const rows = workspaces.list();
  const byPath = new Map(rows.map(row => [row.path, row]));
  for (const book of books) {
    const row = byPath.get(book.path);
    if (row === undefined) continue;
    // Other libraries and unrelated native workspaces share one title namespace.
    // Consult the live registry even on retries; the controller also checks atomically.
    for (let suffix = 1; ; suffix++) {
      // Among N workspaces there are at most N-1 other owners. One extra
      // attempt covers an intervening rename; a changing registry can retry fresh.
      if (suffix > rows.length + 1) throw new WorkspaceHttpError(409, "左侧工作区名称正在变化，请重试同步。");
      const title = suffix === 1 ? book.title : `${book.title} (${String(suffix)})`;
      if (workspaces.list().some(other => other.id !== row.id && other.title === title)) continue;
      if (row.title === title) break;
      try { await names.rename({ workspaceId: row.id, title }); break; }
      catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "workspace/name-conflict") throw error;
      }
    }
  }
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
export async function applyNativeLibraryOrder(workspaces: NativeWorkspaceOrder, names: NativeWorkspaceNames, libraryPath: string, books: readonly SidebarBook[]): Promise<void> {
  const previous = registryOperations.get(workspaces) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await labelLibraryBooks(workspaces, names, books);
    await moveLibraryBooks(workspaces, libraryPath, books.map(book => book.path));
  });
  registryOperations.set(workspaces, operation);
  try { await operation; }
  finally {
    if (registryOperations.get(workspaces) === operation) registryOperations.delete(workspaces);
  }
}

/** The caller holds the library operation lock and supplies the latest host catalogue. */
export async function syncNativeLibrarySidebarOrder(context: Context, library: LibrarySnapshot, canonicalLibraryPath: string): Promise<void> {
  if (library.isBookProject) throw new WorkspaceHttpError(409, "请回到书库总览整理左侧工作区顺序。");
  const books = nativeLibraryBookRows(library);
  if (books.length === 0) return;
  const workspaces = context.get("workspaceRegistry") as NativeWorkspaceOrder | undefined;
  const names = context.get("workspaceController") as NativeWorkspaceNames | undefined;
  if (workspaces === undefined || typeof workspaces.list !== "function" || typeof workspaces.insertBefore !== "function"
    || names === undefined || typeof names.rename !== "function") {
    throw new WorkspaceHttpError(409, "Harness 工作区分组同步暂不可用，请刷新后重试。");
  }
  await applyNativeLibraryOrder(workspaces, names, canonicalLibraryPath, books);
}
