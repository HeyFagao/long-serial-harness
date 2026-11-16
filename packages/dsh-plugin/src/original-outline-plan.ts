/** The original portable app's deterministic chapter field and FB plan parser. */
export interface OriginalChapterPlan {
  readonly characters: readonly string[];
  readonly focus: string;
  readonly hook: string;
  readonly fb_plant: readonly string[];
  readonly fb_reap: readonly string[];
  readonly fb_push: readonly string[];
}

/** Python's original FB{int:02d}: remove redundant zeroes, then keep at least two digits. */
export function normalizeOriginalFbId(digits: string): string {
  return `FB${(digits.replace(/^0+/u, "") || "0").padStart(2, "0")}`;
}

function numbers(text: string): string[] {
  return [...text.matchAll(/FB\s*0*(\d+)/gu)].map(match => normalizeOriginalFbId(match[1]!));
}

function byVerb(text: string, verbs: readonly string[]): string[] {
  const result = new Set<string>();
  for (const verb of verbs) {
    // Count Unicode code points, as Python's original regex does.
    for (const match of text.matchAll(new RegExp(`${verb}[^。；;\\n]{0,30}`, "gu"))) {
      for (const id of numbers(match[0])) result.add(id);
    }
  }
  return [...result].sort();
}

/** Match exactly the original labels; duplicate fields retain its final-match semantics. */
export function parseOriginalChapterPlan(raw: string): OriginalChapterPlan {
  let characters: string[] = [];
  let focus = "";
  let hook = "";
  for (const rawLine of raw.split(/\r\n?|\n/u)) {
    const line = rawLine.trim();
    const people = /^本章出场人物\s*[：:]\s*(.+)$/u.exec(line);
    if (people !== null) characters = people[1]!.split(/[、，,/／]/u).map(name => name.trim()).filter(Boolean);
    const writing = /^[◆◇]?\s*写作重点\s*[：:]\s*(.+)$/u.exec(line);
    if (writing !== null) focus = writing[1]!.trim();
    const ending = /^本章钩子\s*[：:]\s*(.+)$/u.exec(line);
    if (ending !== null) hook = ending[1]!.trim();
  }
  const text = `${focus}\n${hook}`;
  return {
    characters, focus, hook,
    fb_plant: byVerb(text, ["埋设", "埋下", "新埋"]),
    fb_reap: byVerb(text, ["回收", "收束", "结清"]),
    fb_push: byVerb(text, ["推进", "提及", "加深"])
  };
}
