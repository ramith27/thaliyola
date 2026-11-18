/**
 * How big one query result may get in this process. Drivers stop reading at the row cap or at RESULT_MAX_CHARS,
 * whichever comes first, and leave the rest in the database.
 */

/** Most text a result may hold (characters, all cells together). */
export const RESULT_MAX_CHARS = 4 * 1024 * 1024;

/** Characters a row holds, roughly: what the budget counts. */
export function rowChars(row: unknown[]): number {
  let n = 16;
  for (const v of row) n += typeof v === "string" ? v.length : v === null || v === undefined ? 1 : Buffer.isBuffer(v) ? v.length : 16;
  return n;
}

/** Where the JSON value starting at `i` ends (the index after it), or -1 when the text ends first. */
function valueEnd(text: string, i: number): number {
  const first = text[i];
  if (first === undefined) return -1;
  if (first !== "{" && first !== "[" && first !== '"') {
    const m = /^[^,\]}\s]*/.exec(text.slice(i, i + 64))!;
    const end = i + m[0].length;
    return end < text.length ? end : -1;
  }
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (ch === '"') {
      for (k++; k < text.length && text[k] !== '"'; k++) if (text[k] === "\\") k++;
      if (k >= text.length) return -1;
      if (depth === 0) return k + 1;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

const skipWs = (text: string, i: number) => {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
};

/**
 * What a JSON object cut short still says: the members that arrived whole, plus the whole elements of the array it was
 * cut in (a result's rows). Used when a warehouse's response grows past the size cap, so the rows read so far come
 * back, marked cut, instead of the query failing. Null when the text isn't an object.
 */
export function jsonPrefix(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  try {
    return readPrefix(text, out);
  } catch {
    return out;
  }
}

function readPrefix(text: string, out: Record<string, unknown>): Record<string, unknown> | null {
  let i = skipWs(text, 0);
  if (text[i] !== "{") return null;
  i = skipWs(text, i + 1);
  while (i < text.length && text[i] !== "}") {
    const keyEnd = valueEnd(text, i);
    if (text[i] !== '"' || keyEnd < 0) return out;
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipWs(text, keyEnd);
    if (text[i] !== ":") return out;
    i = skipWs(text, i + 1);
    const end = valueEnd(text, i);
    if (end >= 0) {
      out[key] = JSON.parse(text.slice(i, end));
      i = skipWs(text, end);
      if (text[i] === ",") i = skipWs(text, i + 1);
      continue;
    }
    // Cut inside this member: keep an array's whole elements.
    if (text[i] === "[") {
      const items: unknown[] = [];
      let k = skipWs(text, i + 1);
      for (;;) {
        const e = valueEnd(text, k);
        if (e < 0) break;
        items.push(JSON.parse(text.slice(k, e)));
        k = skipWs(text, e);
        if (text[k] !== ",") break;
        k = skipWs(text, k + 1);
      }
      out[key] = items;
    }
    return out;
  }
  return out;
}
