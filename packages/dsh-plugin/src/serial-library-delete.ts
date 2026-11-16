import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import type { LibraryBook } from "./serial-library.js";
import { readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "./workspace-route.js";

const BOOKS = "小说项目";
const RECEIPT = join("追踪", "书项目.json");

interface Entry {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly directory: boolean;
}
interface FileEntry extends Entry {
  readonly target: FsTarget;
  readonly version: FsVersion;
}

export interface PurgeLibraryBookOptions {
  /** Only for a book identity retained in the caller's durable deletion journal. */
  readonly allowEmptyReceiptMissing?: boolean;
}

function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function changed(): WorkspaceHttpError {
  return new WorkspaceHttpError(409, "书项目目录正在变化，已停止删除。请稍后重试。");
}

/** A process path can be remote. Require the provider's explicit host mapping. */
function localPath(realm: WorkspaceRealm, target: FsTarget): string {
  let path: string;
  try { path = fileURLToPath(realm.fs.fileUrl(target)); }
  catch { throw new WorkspaceHttpError(409, "当前文件系统不支持本地永久删除。"); }
  const processPath = realm.fs.processPath(target);
  if (!isAbsolute(path) || typeof realm.fs.processPathFromHostPath !== "function"
    || realm.fs.processPathFromHostPath(path) !== processPath) {
    throw new WorkspaceHttpError(409, "当前文件系统没有明确的本地路径映射，未删除文件。");
  }
  return resolve(path);
}

async function observe(path: string): Promise<Entry> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new WorkspaceHttpError(409, "书项目包含符号链接或目录联接，未删除文件。请先移除链接。");
  if (!stat.isFile() && !stat.isDirectory()) throw new WorkspaceHttpError(409, "书项目包含特殊文件，未删除文件。");
  if (await realpath(path) !== path) throw changed();
  return { path, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
}

async function unchanged(entry: Entry): Promise<void> {
  const current = await observe(entry.path);
  if (current.dev !== entry.dev || current.ino !== entry.ino || current.directory !== entry.directory) throw changed();
}

/** rmdir has no provider API; apply the current policy before empty-only cleanup. */
async function allowDirectoryRemoval(realm: WorkspaceRealm, path: string): Promise<void> {
  const policy = realm.sandboxPolicy.resolve({ session: realm.agent.session });
  if (policy.mode === "danger-full-access") return;
  if (policy.mode !== "workspace-write") throw new WorkspaceHttpError(403, "当前工作区是只读模式，无法删除书项目。");
  for (const [index, root] of [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])].entries()) {
    if (!isAbsolute(root)) continue;
    // Extra roots must already be physical paths, matching the native policy.
    if (index > 0 && (await lstat(root)).isSymbolicLink()) continue;
    const target = await realm.fs.resolve(root);
    const hostPath = localPath(realm, target);
    const stat = await lstat(hostPath);
    if (stat.isDirectory() && !stat.isSymbolicLink() && await realpath(hostPath) === hostPath && inside(hostPath, path)) return;
  }
  throw new WorkspaceHttpError(403, "书项目不在当前允许写入的工作区内，未删除目录。");
}

/**
 * The caller must durably tombstone the book and stop its writers first.
 * Only the selected, receipt-identified child is removed. Never follow a link,
 * recursively rm a directory, or treat a remote process path as a host path.
 */
export async function purgeLibraryBookFiles(library: WorkspaceRealm, book: LibraryBook, options: PurgeLibraryBookOptions = {}): Promise<void> {
  const parts = book.relativePath.split("/");
  if (parts.length !== 2 || parts[0] !== BOOKS || parts[1] === "" || parts[1] === "." || parts[1] === ".."
    || book.relativePath.includes("\\") || [...book.relativePath].some(char => char.charCodeAt(0) < 32)
    || !/^[a-f0-9]{64}$/u.test(book.id)) throw new WorkspaceHttpError(400, "书项目路径或标识无效，未删除文件。");

  const libraryPath = localPath(library, library.root);
  const libraryEntry = await observe(libraryPath);
  const booksEntry = await observe(join(libraryPath, BOOKS));
  if (!libraryEntry.directory || !booksEntry.directory) throw changed();
  const bookPath = join(booksEntry.path, parts[1]!);
  const bookTarget = await library.fs.resolve(book.relativePath, { cwd: library.cwd });
  if (!library.fs.contains(library.root, bookTarget) || localPath(library, bookTarget) !== bookPath
    || library.fs.processPath(bookTarget) !== book.absolutePath) {
    throw new WorkspaceHttpError(409, "书项目路径与当前书库不一致，未删除文件。");
  }
  const root = await observe(bookPath);
  if (!root.directory) throw changed();
  const directories: Entry[] = [root];
  const files: FileEntry[] = [];
  // Finish preflight before the first mutation, including every error/hidden file.
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    await unchanged(directory);
    for (const name of (await readdir(directory.path)).sort()) {
      const entry = await observe(join(directory.path, name));
      if (entry.directory) { directories.push(entry); continue; }
      const target = await library.fs.resolve(entry.path);
      if (!library.fs.contains(bookTarget, target) || localPath(library, target) !== entry.path) throw changed();
      const info = await library.fs.stat(target);
      if (info?.type !== "file") throw changed();
      await unchanged(entry);
      files.push({ ...entry, target, version: info.version });
    }
  }
  const receipt = files.find(entry => entry.path === join(bookPath, RECEIPT));
  let receiptText: string | undefined;
  if (receipt === undefined) {
    // A crash after the final receipt unlink can leave only these empty dirs.
    // Without the caller's journal authorization even an empty tree is refused.
    if (options.allowEmptyReceiptMissing !== true || files.length !== 0
      || directories.some(entry => entry.path !== bookPath && entry.path !== join(bookPath, "追踪"))) {
      throw new WorkspaceHttpError(409, "书项目缺少身份记录，未删除文件。");
    }
  } else {
    const stored = await readVersionedFile(library.fs, receipt.target, 2_097_152);
    let identity: unknown;
    try { identity = JSON.parse(stored.content); }
    catch { throw new WorkspaceHttpError(409, "书项目身份记录损坏，未删除文件。"); }
    if (typeof identity !== "object" || identity === null || Array.isArray(identity)) throw new WorkspaceHttpError(409, "书项目身份记录无效，未删除文件。");
    const value = identity as Record<string, unknown>;
    if (stored.version !== receipt.version || value.schemaVersion !== 1 || value.id !== book.id
      || value.relativePath !== book.relativePath || value.libraryPath !== library.cwd) {
      throw new WorkspaceHttpError(409, "书项目身份记录与当前选择不一致，未删除文件。");
    }
    receiptText = stored.content;
  }
  await allowDirectoryRemoval(library, root.path);

  const directoryMap = new Map([libraryEntry, booksEntry, ...directories].map(entry => [entry.path, entry]));
  const checkAncestors = async (path: string): Promise<void> => {
    for (let current = path; inside(libraryPath, current); current = dirname(current)) {
      const entry = directoryMap.get(current);
      if (entry !== undefined) await unchanged(entry);
      if (current === libraryPath) break;
    }
  };
  const removeFile = async (entry: FileEntry): Promise<void> => {
    await checkAncestors(dirname(entry.path));
    await unchanged(entry);
    await library.fs.deleteFile(entry.target, { version: entry.version }, undefined,
      library.sandboxPolicy.resolve({ session: library.agent.session }));
  };
  const removeDirectory = async (entry: Entry): Promise<void> => {
    await allowDirectoryRemoval(library, entry.path);
    await checkAncestors(entry.path);
    // Empty-only removal cannot recurse into an unexpected new directory/file.
    if ((await readdir(entry.path)).length !== 0) throw changed();
    await unchanged(entry);
    await rmdir(entry.path);
    directoryMap.delete(entry.path);
  };

  if (receipt === undefined) {
    for (const directory of [...directories].reverse()) await removeDirectory(directory);
    return;
  }

  for (const file of files) if (file !== receipt) await removeFile(file);
  // Keep the receipt and its ancestors until every other file/directory is gone.
  const receiptParents = new Set([bookPath, dirname(receipt.path)]);
  for (const directory of [...directories].reverse()) if (!receiptParents.has(directory.path)) await removeDirectory(directory);
  await checkAncestors(dirname(receipt.path));
  if ((await readdir(bookPath)).join("\n") !== "追踪"
    || (await readdir(dirname(receipt.path))).join("\n") !== "书项目.json") throw changed();
  await removeFile(receipt);
  try {
    for (const directory of [...directories].reverse()) if (receiptParents.has(directory.path)) await removeDirectory(directory);
  } catch (error) {
    // Keep normal retries possible if an empty-directory cleanup failed. Never
    // recreate a removed/replaced book; the caller's journal covers process loss.
    try {
      await checkAncestors(bookPath);
      await unchanged(root);
      const tracking = directories.find(entry => entry.path === dirname(receipt.path))!;
      try { await unchanged(tracking); }
      catch (trackingError) {
        if (!(trackingError instanceof Error && "code" in trackingError && trackingError.code === "ENOENT")) throw trackingError;
      }
      const target = await library.fs.resolve(receipt.path);
      if (localPath(library, target) !== receipt.path || !library.fs.contains(bookTarget, target)) throw changed();
      await library.fs.writeText(target, receiptText!, { kind: "createIfAbsent" }, undefined,
        library.sandboxPolicy.resolve({ session: library.agent.session }));
    } catch { /* A durable parent journal can retry the strictly empty remainder. */ }
    throw error;
  }
}
