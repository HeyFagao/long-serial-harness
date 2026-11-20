/**
 * Phone reading layout for chapter text at export time.
 * Breaks and spacing only: story wording, names and facts stay put.
 * The saved manuscript is not rewritten, so already-written chapters
 * pick this up the next time they are exported.
 */

/** About four lines of Chinese on a phone. Longer narration breaks after 。！？. */
export const MOBILE_PARAGRAPH_LIMIT = 80;
const SHORT_TAIL = 12;
const HARD_WRAP_MIN = 24;
const STATE_MARKER = "【状态变更】";
const OPEN_TO_CLOSE: Readonly<Record<string, string>> = { "“": "”", "「": "」", "『": "』", "‘": "’", "\"": "\"", "＂": "＂" };

function charAt(text: string, index: number): string {
  const point = text.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
}

function visibleLength(text: string): number {
  let count = 0;
  for (const char of text) if (!/\s/u.test(char)) count += 1;
  return count;
}

function quoteEnd(text: string, openAt: number): number | undefined {
  const open = charAt(text, openAt);
  const close = OPEN_TO_CLOSE[open];
  if (close === undefined) return undefined;
  if (open === close) {
    const end = text.indexOf(close, openAt + open.length);
    return end < 0 ? undefined : end;
  }
  for (let index = openAt + open.length; index < text.length;) {
    const char = charAt(text, index);
    if (char === close) return index;
    if (OPEN_TO_CLOSE[char] !== undefined) {
      const nested = quoteEnd(text, index);
      if (nested === undefined) return undefined;
      index = nested + charAt(text, nested).length;
      continue;
    }
    index += char.length;
  }
  return undefined;
}

function hasUnclosedQuote(text: string): boolean {
  for (let index = 0; index < text.length;) {
    const char = charAt(text, index);
    if (OPEN_TO_CLOSE[char] !== undefined) {
      const end = quoteEnd(text, index);
      if (end === undefined) return true;
      index = end + charAt(text, end).length;
      continue;
    }
    index += char.length;
  }
  return false;
}

function isChapterHeading(line: string): boolean {
  return /^第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*章(?:$|[\s：:·、.．-])/u.test(line.trim());
}

function endsParagraph(line: string): boolean {
  return /[。！？!?…][”」』’"＂]*$/u.test(line) || /[”」』’"＂]$/u.test(line);
}

function startsWithQuote(text: string): boolean {
  return OPEN_TO_CLOSE[charAt(text, 0)] !== undefined;
}

/** Join a hard wrap, or the next line that closes an open quote. A finished paragraph stays separate. */
function shouldContinue(previous: string, next: string): boolean {
  if (isChapterHeading(previous) || isChapterHeading(next)) return false;
  if (hasUnclosedQuote(previous)) {
    if (!hasUnclosedQuote(previous + next)) return true;
    return !endsParagraph(previous) && !endsParagraph(next) && !startsWithQuote(next);
  }
  if (endsParagraph(previous)) return false;
  return visibleLength(previous) >= HARD_WRAP_MIN;
}

function unwrapBlock(lines: readonly string[]): string[] {
  const merged: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current === "") { current = line; continue; }
    if (shouldContinue(current, line)) current += line;
    else { merged.push(current); current = line; }
  }
  if (current !== "") merged.push(current);
  return merged;
}

function paragraphsOf(text: string): string[] {
  const paragraphs: string[] = [];
  let block: string[] = [];
  const flush = (): void => {
    if (block.length === 0) return;
    paragraphs.push(...unwrapBlock(block));
    block = [];
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") flush();
    else block.push(line.trim());
  }
  flush();
  return paragraphs;
}

function normalizeSpacing(text: string): string {
  let next = text;
  next = next.replace(/[ \t\u3000\u00A0]+(?=[，。！？；：、」』”’）】》])/gu, "");
  next = next.replace(/([「『“‘（【《])[ \t\u3000\u00A0]+/gu, "$1");
  next = next.replace(/([，。！？；：、」』”’）】》])[ \t\u3000\u00A0]+/gu, "$1");
  let previous = "";
  while (previous !== next) {
    previous = next;
    next = next.replace(/(\p{Script=Han})[ \t\u3000\u00A0]+(\p{Script=Han})/gu, "$1$2");
  }
  return next;
}

function glueOrphanPunctuation(parts: readonly string[]): string[] {
  const glued: string[] = [];
  for (const part of parts) {
    const previous = glued.at(-1);
    if (previous !== undefined && /^[\s，。！？；：、….!?,;:]+$/u.test(part)) glued[glued.length - 1] = previous + part.trim();
    else glued.push(part);
  }
  return glued;
}

function splitDialogue(paragraph: string): string[] {
  const parts: string[] = [];
  let narrative = "";
  for (let index = 0; index < paragraph.length;) {
    const char = charAt(paragraph, index);
    if (OPEN_TO_CLOSE[char] !== undefined) {
      const end = quoteEnd(paragraph, index);
      if (end !== undefined) {
        const lead = narrative.trim();
        if (lead !== "") parts.push(lead);
        narrative = "";
        const closeLength = charAt(paragraph, end).length;
        parts.push(paragraph.slice(index, end + closeLength));
        index = end + closeLength;
        continue;
      }
    }
    narrative += char;
    index += char.length;
  }
  const tail = narrative.trim();
  if (tail !== "") parts.push(tail);
  return glueOrphanPunctuation(parts);
}

function isDialogue(paragraph: string): boolean {
  const open = charAt(paragraph, 0);
  if (OPEN_TO_CLOSE[open] === undefined) return false;
  const end = quoteEnd(paragraph, 0);
  if (end === undefined) return false;
  return end + charAt(paragraph, end).length === paragraph.length;
}

function isSentencePunctuation(char: string): boolean {
  return char === "。" || char === "！" || char === "？" || char === "!" || char === "?";
}

function isClosingQuote(char: string): boolean {
  return char === "”" || char === "」" || char === "』" || char === "’" || char === "\"" || char === "＂";
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length;) {
    const char = charAt(text, index);
    if (!isSentencePunctuation(char)) { index += char.length; continue; }
    index += char.length;
    while (index < text.length && isSentencePunctuation(charAt(text, index))) index += charAt(text, index).length;
    while (index < text.length && isClosingQuote(charAt(text, index))) index += charAt(text, index).length;
    sentences.push(text.slice(start, index));
    start = index;
  }
  if (start < text.length && text.slice(start).trim() !== "") sentences.push(text.slice(start));
  return sentences;
}

function breakNarrative(paragraph: string): string[] {
  if (isDialogue(paragraph) || visibleLength(paragraph) <= MOBILE_PARAGRAPH_LIMIT) return [paragraph];
  const sentences = splitSentences(paragraph);
  if (sentences.length <= 1) return [paragraph];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current === "") { current = sentence; continue; }
    const combined = current + sentence;
    if (visibleLength(combined) > MOBILE_PARAGRAPH_LIMIT && visibleLength(current) >= SHORT_TAIL) {
      chunks.push(current.trim());
      current = sentence;
    } else current = combined;
  }
  if (current.trim() !== "") chunks.push(current.trim());
  const tail = chunks.at(-1);
  const head = chunks.at(-2);
  if (tail !== undefined && head !== undefined && visibleLength(tail) < SHORT_TAIL) {
    chunks.splice(chunks.length - 2, 2, `${head}${tail}`);
  }
  return chunks;
}

function layoutProse(source: string): string {
  const normalized = normalizeSpacing(source.replace(/\r\n?/gu, "\n")).trim();
  if (normalized === "") return "";
  const pieces: string[] = [];
  for (const paragraph of paragraphsOf(normalized)) {
    for (const segment of splitDialogue(paragraph)) {
      for (const piece of breakNarrative(segment)) {
        const trimmed = piece.trim();
        if (trimmed !== "") pieces.push(trimmed);
      }
    }
  }
  return pieces.join("\n\n");
}

/** Blank line between paragraphs, spoken lines alone, long narration broken on sentence endings. */
export function typesetMobileChapter(source: string): string {
  const withoutBom = source.replace(/^\uFEFF/u, "");
  const marker = withoutBom.indexOf(STATE_MARKER);
  const prose = marker < 0 ? withoutBom : withoutBom.slice(0, marker);
  const change = marker < 0 ? "" : withoutBom.slice(marker);
  const body = layoutProse(prose);
  if (change === "") return body;
  return body === "" ? change : `${body}\n\n${change}`;
}

export function chapterWording(text: string): string {
  let wording = "";
  for (const char of text) if (!/\s/u.test(char)) wording += char;
  return wording;
}
