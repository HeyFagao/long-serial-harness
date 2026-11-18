import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LibraryBook, LibrarySnapshot } from "../serial-library.js";
import { groupsForLibraryBooks, UNGROUPED_LIBRARY_LABEL } from "../serial-library-groups.js";

interface FolderListProps {
  readonly books: readonly LibraryBook[];
  readonly folders: NonNullable<LibrarySnapshot["folders"]>;
  readonly occupiedFolderIds?: ReadonlySet<string>;
  readonly checkedIds: readonly string[];
  readonly query: string;
  readonly arranging: boolean;
  readonly busy: boolean;
  readonly expandedFolder?: { readonly id: string; readonly revision: number; readonly scroll?: boolean } | undefined;
  readonly onSelect: (ids: readonly string[]) => void;
  readonly renameEditor?: { readonly id: string; readonly content: ReactNode } | undefined;
  readonly onRename: (id: string, name: string) => void;
  readonly onDeleteEmpty: (id: string) => void;
  readonly renderBook: (book: LibraryBook, index: number, siblings: readonly LibraryBook[]) => ReactNode;
}

const folderDateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function searchLibraryBooks(books: readonly LibraryBook[], query: string): readonly LibraryBook[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? books.filter(book => book.title.toLocaleLowerCase().includes(needle)) : books;
}

export function LibraryFolderList({ books, folders, occupiedFolderIds, checkedIds, query, arranging, busy, expandedFolder, onSelect, renameEditor, onRename, onDeleteEmpty, renderBook }: FolderListProps) {
  const list = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const checked = new Set(checkedIds);
  const searching = !arranging && query.trim().length > 0;
  const groups = groupsForLibraryBooks(books, folders);

  useEffect(() => {
    if (!expandedFolder) return;
    setClosed(previous => {
      if (!previous.has(expandedFolder.id)) return previous;
      const next = new Set(previous);
      next.delete(expandedFolder.id);
      return next;
    });
    if (!expandedFolder.scroll) return;
    const frame = requestAnimationFrame(() => {
      const target = list.current?.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(expandedFolder.id)}"]`);
      if (!target) return;
      const dock = target.closest(".book-library-panel")?.querySelector(".book-library-selection-dock");
      const stickyHeight = dock && getComputedStyle(dock).position === "sticky" ? dock.getBoundingClientRect().height : 0;
      target.style.scrollMarginTop = `${String(stickyHeight + 12)}px`;
      target.querySelector<HTMLButtonElement>(".book-library-folder-toggle")?.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
    });
    return () => { cancelAnimationFrame(frame); };
  }, [expandedFolder]);

  function toggleFolder(id: string): void {
    setClosed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return <div ref={list} className="book-library-folder-list" role="list" aria-label="小说项目列表">
    {groups.map(({ folder, books: members }) => {
      const key = folder?.id ?? "ungrouped";
      const name = folder?.name ?? UNGROUPED_LIBRARY_LABEL;
      const shown = searching ? searchLibraryBooks(members, query) : members;
      if (searching && shown.length === 0) return null;
      const expanded = searching || !closed.has(key);
      const memberIds = new Set(members.map(book => book.id));
      const selectedCount = members.filter(book => checked.has(book.id)).length;
      const allChecked = members.length > 0 && selectedCount === members.length;
      const partial = selectedCount > 0 && !allChecked;
      const createdAt = folder ? new Date(folder.createdAt) : undefined;
      return <section key={key} className="book-library-folder" data-folder-id={key} aria-label={`文件夹 ${name}`}>
        <header className="book-library-folder-heading">
          <div className="book-library-folder-info">
            <h4><button type="button" className="book-library-folder-toggle" aria-expanded={expanded} disabled={searching} aria-label={`${expanded ? "收起" : "展开"} ${name}`} onClick={() => { toggleFolder(key); }}>
              <span className="book-library-folder-caret" aria-hidden="true" />
              <span className="book-library-folder-icon" aria-hidden="true" />
              <span>{name}</span>
            </button></h4>
            <span className="book-library-folder-count">{searching ? `匹配 ${String(shown.length)} / ${String(members.length)} 本` : `${String(members.length)} 本`}{selectedCount > 0 && ` · 已选 ${String(selectedCount)} 本`}</span>
            {createdAt && Number.isFinite(createdAt.getTime()) && <time dateTime={folder?.createdAt} className="book-library-folder-date">{folderDateFormat.format(createdAt)} 创建</time>}
          </div>
          <div className="book-library-folder-actions">
            {!arranging && members.length > 0 && <>
              <label className="book-library-folder-select"><input type="checkbox" checked={allChecked} disabled={busy} ref={element => { if (element) element.indeterminate = partial; }} aria-label={`选择文件夹 ${name} 中的书`} onChange={() => {
                onSelect(allChecked ? checkedIds.filter(id => !memberIds.has(id)) : [...new Set([...checkedIds, ...memberIds])]);
              }} />全选本批</label>
              <button type="button" disabled={busy} onClick={() => { onSelect([...memberIds]); }}>只选本批</button>
            </>}
            {!arranging && folder && <button type="button" disabled={busy} aria-label={`重命名 ${name}`} onClick={() => { onRename(folder.id, folder.name); }}>重命名</button>}
            {!arranging && folder && members.length === 0 && !occupiedFolderIds?.has(key) && <button type="button" disabled={busy} aria-label={`删除空文件夹 ${name}`} onClick={() => { onDeleteEmpty(folder.id); }}>删除空文件夹</button>}
          </div>
        </header>
        {folder && renameEditor?.id === folder.id && renameEditor.content}
        {expanded && <div className="book-library-folder-content">
          {!folder && <p className="book-library-note">旧版没有记录导入批次的书也在这里。勾选书籍后可移入对应的文件夹。</p>}
          {searching && shown.length < members.length && <p className="book-library-note">本批选择包含文件夹内全部 {members.length} 本。仅选择匹配的书可逐本勾选。</p>}
          {members.length > 0 ? <div className="book-library-books" data-arranging={arranging || undefined}>{shown.map(renderBook)}</div> : <p className="book-library-empty">{occupiedFolderIds?.has(key) ? "此文件夹目前没有可显示的书。" : "文件夹为空。可在导入时选择此文件夹，或将已有的书移入。"}</p>}
        </div>}
      </section>;
    })}
  </div>;
}
