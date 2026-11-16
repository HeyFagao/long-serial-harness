import type { Context } from "@deepseek-ai/cordis";

const operations = new WeakMap<Context, Map<string, Promise<unknown>>>();
const deleting = new WeakMap<Context, Set<string>>();

export async function withLibraryOperation<T>(context: Context, key: string, work: () => Promise<T>): Promise<T> {
  let map = operations.get(context);
  if (map === undefined) { map = new Map(); operations.set(context, map); }
  const pending = (map.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  map.set(key, pending);
  try { return await pending; }
  finally { if (map.get(key) === pending) map.delete(key); }
}

export function markBookDeleting(context: Context, key: string, value: boolean): void {
  let set = deleting.get(context);
  if (set === undefined) { set = new Set(); deleting.set(context, set); }
  if (value) set.add(key); else set.delete(key);
}

export function assertBookNotDeleting(context: Context, key: string): void {
  if (isBookDeleting(context, key)) throw new Error("这本书正在后台删除，不能再开始或恢复生成。");
}

export function isBookDeleting(context: Context, key: string): boolean { return deleting.get(context)?.has(key) === true; }
