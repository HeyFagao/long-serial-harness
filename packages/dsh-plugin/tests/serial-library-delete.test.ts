import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FsVersion } from "@deepseek-ai/dsh-fs";
import { purgeLibraryBookFiles } from "../src/serial-library-delete.js";
import type { LibraryBook } from "../src/serial-library.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const path of temporaryRoots.splice(0)) await rm(path, { recursive: true, force: true });
});

const contains = (parent: string, child: string): boolean => {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const exists = async (path: string): Promise<boolean> => { try { await lstat(path); return true; } catch { return false; } };
type Target = { readonly displayPath: string; readonly targetKey: string };
type Policy = { mode: "workspace-write" | "read-only" | "danger-full-access"; workspaceRoot: string };

/** Real disk with provider-shaped versioned operations, never a user's library. */
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "serial-delete-")));
  temporaryRoots.push(path);
  const target = (name: string): Target => ({ displayPath: name, targetKey: name });
  const deleted: string[] = [];
  const policy: Policy = { mode: "workspace-write", workspaceRoot: path };
  let failOnce = "";
  let beforeDelete: ((path: string) => Promise<void>) | undefined;
  let afterDelete: ((path: string) => Promise<void>) | undefined;
  const version = async (name: string) => {
    const stat = await lstat(name);
    const body = stat.isFile() ? await readFile(name) : Buffer.from("");
    return FsVersion(createHash("sha256").update(`${String(stat.dev)}:${String(stat.ino)}:${String(stat.mtimeMs)}:`).update(body).digest("hex"));
  };
  const assertPolicy = (name: string, actual: Policy): void => {
    expect(actual).toBe(policy);
    if (actual.mode === "read-only" || !contains(actual.workspaceRoot, name)) throw new Error("provider policy denied");
  };
  const fs = {
    resolve: async (name: string, options?: { cwd?: string }) => {
      const absolute = resolve(options?.cwd ?? path, name);
      return target(await realpath(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return absolute; }));
    },
    processPath: (entry: Target) => entry.displayPath,
    processPathFromHostPath: (name: string): string | undefined => isAbsolute(name) ? resolve(name) : undefined,
    fileUrl: (entry: Target) => pathToFileURL(entry.displayPath).href,
    contains: (parent: Target, entry: Target) => contains(parent.displayPath, entry.displayPath),
    stat: async (entry: Target) => {
      if (!await exists(entry.displayPath)) return undefined;
      const stat = await lstat(entry.displayPath);
      return { version: await version(entry.displayPath), type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other", size: stat.size };
    },
    readBytes: (entry: Target) => readFile(entry.displayPath),
    deleteFile: async (entry: Target, expected: { version: string }, _signal: unknown, actual: Policy) => {
      assertPolicy(entry.displayPath, actual);
      await beforeDelete?.(entry.displayPath);
      if (entry.displayPath === failOnce) { failOnce = ""; throw new Error("simulated disk failure"); }
      if (await version(entry.displayPath) !== expected.version) throw new Error("stale version");
      await unlink(entry.displayPath);
      deleted.push(entry.displayPath);
      await afterDelete?.(entry.displayPath);
      return { removedText: null };
    },
    writeText: async (entry: Target, text: string, expected: { kind: string }, _signal: unknown, actual: Policy) => {
      assertPolicy(entry.displayPath, actual);
      expect(expected.kind).toBe("createIfAbsent");
      await mkdir(dirname(entry.displayPath), { recursive: true });
      await writeFile(entry.displayPath, text, { flag: "wx" });
      return { version: await version(entry.displayPath) };
    }
  };
  const realm = { cwd: path, root: target(path), fs, sessionId: "test-library", agent: { session: {} }, sandboxPolicy: { resolve: () => policy } } as unknown as WorkspaceRealm;
  const seed = async (letter = "a") => {
    const id = letter.repeat(64);
    const relativePath = `小说项目/测试书--${id.slice(0, 12)}`;
    const absolutePath = join(path, relativePath);
    const receipt = join(absolutePath, "追踪", "书项目.json");
    const identity = { schemaVersion: 1, id, title: "测试书", filename: "最终输出.txt", sourceSha256: "c".repeat(64), libraryPath: path,
      relativePath, totalChapters: 50, status: "ready", deletingAt: "2026-11-17T00:00:00Z", deleteError: "previous failure" };
    await mkdir(dirname(receipt), { recursive: true });
    await writeFile(receipt, JSON.stringify(identity));
    const book: LibraryBook = { id, title: "测试书", filename: "最终输出.txt", absolutePath, relativePath, totalChapters: 50, completedChapters: 0, status: "blocked" };
    return { book, receipt, identity, write: async (name: string, content = "content") => {
      const full = join(absolutePath, name);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
      return full;
    } };
  };
  return { path, realm, fs, seed, policy, deleted, fail: (name: string) => { failOnce = name; },
    before: (fn: (name: string) => Promise<void>) => { beforeDelete = fn; }, after: (fn: (name: string) => Promise<void>) => { afterDelete = fn; } };
}

describe("permanent book file deletion", () => {
  it("physically removes a blocked book, broken tracking and nested error files, preserving the adjacent book", async () => {
    const test = await fixture(); const selected = await test.seed(); const neighbor = await test.seed("b");
    await selected.write("追踪/连载任务.json", "broken { JSON");
    await selected.write("追踪/_tracking-state.json", "not tracking");
    await selected.write("追踪/连载输出/第001章/第5次/error.json", "{ failed");
    await selected.write(".hidden-error", "failure");
    await selected.write("正文/第001章.md", "正文");
    const keep = await neighbor.write("正文/第001章.md", "邻书正文");
    await purgeLibraryBookFiles(test.realm, selected.book);
    expect(await exists(selected.book.absolutePath)).toBe(false);
    expect(await readFile(keep, "utf8")).toBe("邻书正文");
    expect(await exists(neighbor.receipt)).toBe(true);
    expect(test.deleted.at(-1)).toBe(selected.receipt);
  });

  it.each(["file", "directory", "internal"] as const)("rejects a %s symlink before deleting anything", async (kind) => {
    const test = await fixture(); const selected = await test.seed();
    const original = await selected.write("a.txt", "selected content");
    const outside = join(test.path, "outside"); await mkdir(outside);
    const outsideFile = join(outside, "keep.txt"); await writeFile(outsideFile, "untouched outside");
    const destination = kind === "file" ? outsideFile : kind === "internal" ? original : outside;
    await symlink(destination, join(selected.book.absolutePath, "z-link"), kind === "directory" ? "junction" : "file");
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("链接");
    expect(test.deleted).toEqual([]);
    expect(await readFile(outsideFile, "utf8")).toBe("untouched outside");
    expect(await readFile(original, "utf8")).toBe("selected content");
    expect(await exists(selected.receipt)).toBe(true);
  });

  it.each(["id", "relativePath", "libraryPath", "schemaVersion"])("rejects mismatched receipt %s without mutations", async (field) => {
    const test = await fixture(); const selected = await test.seed();
    await writeFile(selected.receipt, JSON.stringify({ ...selected.identity, [field]: "wrong" }));
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("身份记录");
    expect(test.deleted).toEqual([]);
    expect(await exists(selected.receipt)).toBe(true);
  });

  it("rejects a linked book root while preserving every outside file", async () => {
    const test = await fixture(); const selected = await test.seed();
    const outside = join(test.path, "outside"); await mkdir(outside);
    const keep = join(outside, "keep.txt"); await writeFile(keep, "outside");
    await rm(selected.book.absolutePath, { recursive: true });
    await symlink(outside, selected.book.absolutePath, "junction");
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("路径");
    expect(test.deleted).toEqual([]);
    expect(await readFile(keep, "utf8")).toBe("outside");
  });

  it("rejects escaped selections, an invalid receipt and an absent receipt", async () => {
    const test = await fixture(); const selected = await test.seed();
    await expect(purgeLibraryBookFiles(test.realm, { ...selected.book, relativePath: "小说项目/../outside" })).rejects.toThrow("路径");
    await writeFile(selected.receipt, "invalid JSON");
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("身份记录");
    await unlink(selected.receipt);
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("身份记录");
    expect(test.deleted).toEqual([]);
  });

  it("keeps the receipt through partial failure and finishes a retry", async () => {
    const test = await fixture(); const selected = await test.seed();
    const first = await selected.write("a.txt"); const fail = await selected.write("z.txt");
    test.fail(fail);
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("simulated disk failure");
    expect(await exists(first)).toBe(false);
    expect(await exists(fail)).toBe(true);
    expect(await exists(selected.receipt)).toBe(true);
    await purgeLibraryBookFiles(test.realm, selected.book);
    expect(await exists(selected.book.absolutePath)).toBe(false);
  });

  it("keeps changed file content when the observed provider version is stale", async () => {
    const test = await fixture(); const selected = await test.seed(); const file = await selected.write("a.txt");
    test.before(async (name) => { if (name === file) await writeFile(name, "new content"); });
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("stale version");
    expect(await readFile(file, "utf8")).toBe("new content");
    expect(await exists(selected.receipt)).toBe(true);
  });

  it("restores the receipt after final empty-directory cleanup fails", async () => {
    const test = await fixture(); const selected = await test.seed();
    let added = false;
    test.after(async (name) => {
      if (name === selected.receipt && !added) { added = true; await selected.write("unexpected.txt", "new file"); }
    });
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("目录正在变化");
    expect(await readFile(selected.receipt, "utf8")).toBe(JSON.stringify(selected.identity));
    expect(await readFile(join(selected.book.absolutePath, "unexpected.txt"), "utf8")).toBe("new file");
    await purgeLibraryBookFiles(test.realm, selected.book);
    expect(await exists(selected.book.absolutePath)).toBe(false);
  });

  it("allows journal-authorized empty leftovers, while refusing unidentified nonempty projects", async () => {
    const test = await fixture(); const selected = await test.seed();
    await unlink(selected.receipt);
    const unexpected = await selected.write("unexpected.txt");
    await expect(purgeLibraryBookFiles(test.realm, selected.book, { allowEmptyReceiptMissing: true })).rejects.toThrow("身份记录");
    await unlink(unexpected);
    await purgeLibraryBookFiles(test.realm, selected.book, { allowEmptyReceiptMissing: true });
    expect(await exists(selected.book.absolutePath)).toBe(false);
    expect(test.deleted).toEqual([]);
  });

  it("does not fall back from an unavailable host mapping to processPath", async () => {
    const test = await fixture(); const selected = await test.seed();
    test.fs.processPathFromHostPath = () => undefined;
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("本地路径映射");
    expect(test.deleted).toEqual([]);
    expect(await exists(selected.receipt)).toBe(true);
  });

  it("honors a read-only or unrelated workspace policy before any deletion", async () => {
    const test = await fixture(); const selected = await test.seed();
    test.policy.mode = "read-only";
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("只读");
    test.policy.mode = "workspace-write";
    const other = join(test.path, "other"); await mkdir(other); test.policy.workspaceRoot = other;
    await expect(purgeLibraryBookFiles(test.realm, selected.book)).rejects.toThrow("允许写入");
    expect(test.deleted).toEqual([]);
    expect(await exists(selected.receipt)).toBe(true);
  });
});
