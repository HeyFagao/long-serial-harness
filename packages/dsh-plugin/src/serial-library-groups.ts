export const UNGROUPED_LIBRARY_LABEL = "未分组";

export interface LibraryBookGroup<Book, Folder> {
  readonly folder?: Folder;
  readonly books: readonly Book[];
}

/** Shared section order for the bookcase and the native sidebar. Preserve the stored order inside each folder. */
export function groupsForLibraryBooks<Book extends { readonly folderId?: string }, Folder extends { readonly id: string }>(
  books: readonly Book[], folders: readonly Folder[] = []
): readonly LibraryBookGroup<Book, Folder>[] {
  const ungrouped: Book[] = [];
  const sections = folders.map(folder => ({ folder, books: [] as Book[] }));
  const byFolder = new Map(sections.map(section => [section.folder.id, section.books]));
  for (const book of books) {
    const contents = book.folderId === undefined ? undefined : byFolder.get(book.folderId);
    (contents ?? ungrouped).push(book);
  }
  return ungrouped.length > 0 ? [{ books: ungrouped }, ...sections] : sections;
}
