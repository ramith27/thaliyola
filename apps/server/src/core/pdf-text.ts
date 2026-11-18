import { constants, deflateSync, inflateRawSync, inflateSync } from "node:zlib";

/**
 * Plain-text extraction from PDF files, so agents can read attached PDFs (audit reports, specs, exports) over MCP.
 * No dependencies: a small PDF object parser (classic xref files and PDF 1.5 object streams), Flate/ASCII85/ASCIIHex
 * stream decoding, and a content-stream interpreter that follows text operators, fonts (ToUnicode CMaps, simple
 * encodings with Differences, glyph widths for word spacing) and form XObjects. Images and drawings are ignored;
 * a scanned PDF has no text to extract.
 *
 * Limits keep a hostile file from using too much memory or time: decompressed bytes per stream and per document,
 * pages, and form nesting are capped, and an encrypted file is refused.
 */

const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PAGES = 5000;
const MAX_FORM_DEPTH = 8;

export class PdfTextError extends Error {}

export interface PdfTextResult {
  pageCount: number;
  /** Text of each page, in page order (empty string for a page without text). */
  pages: string[];
}

// ---- Objects -------------------------------------------------------------------------------------------------

class Name {
  constructor(readonly name: string) {}
}
class PdfString {
  /** Raw bytes as a latin1 string (one char per byte). */
  constructor(readonly bytes: string) {}
}
class Ref {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}
class Op {
  constructor(readonly op: string) {}
}
type Dict = { [key: string]: Value };
class Stream {
  constructor(
    readonly dict: Dict,
    readonly start: number,
    readonly end: number,
    readonly source: string,
  ) {}
}
type Value = number | boolean | null | Name | PdfString | Ref | Value[] | Dict | Stream | Op;

const isDict = (v: unknown): v is Dict => !!v && typeof v === "object" && v.constructor === Object;
const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

/** A tokenizer/parser over a latin1 string (PDF syntax is byte-oriented). */
class Parser {
  pos: number;
  constructor(
    readonly s: string,
    pos = 0,
  ) {
    this.pos = pos;
  }

  skipSpace() {
    const s = this.s;
    for (;;) {
      while (this.pos < s.length && WS.has(s.charCodeAt(this.pos))) this.pos++;
      if (s[this.pos] === "%") {
        while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++;
        continue;
      }
      return;
    }
  }

  private word() {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos);
      if (WS.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    return this.s.slice(start, this.pos);
  }

  /** Reads one value; in content streams operators come back as Op. Returns undefined at the end or on `>>` / `]`. */
  value(): Value | undefined {
    this.skipSpace();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const c = s[this.pos]!;
    if (c === "/") {
      this.pos++;
      return new Name(this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === "(") return this.literal();
    if (c === "<") {
      if (s[this.pos + 1] === "<") {
        this.pos += 2;
        return this.dict();
      }
      return this.hex();
    }
    if (c === "[") {
      this.pos++;
      const arr: Value[] = [];
      for (;;) {
        this.skipSpace();
        if (this.pos >= s.length) return arr;
        if (s[this.pos] === "]") {
          this.pos++;
          return arr;
        }
        const v = this.value();
        if (v === undefined) {
          this.pos++;
          continue;
        }
        arr.push(v);
      }
    }
    if (c === "]" || c === ">" || c === ")" || c === "{" || c === "}") {
      this.pos++;
      return undefined;
    }
    const w = this.word();
    if (!w) {
      this.pos++;
      return undefined;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      // A reference: "12 0 R".
      if (/^\d+$/.test(w)) {
        const m = /^\s+(\d+)\s+R(?=[\s/<>[\]()%]|$)/.exec(s.slice(this.pos, this.pos + 24));
        if (m) {
          this.pos += m[0].length;
          return new Ref(Number(w), Number(m[1]));
        }
      }
      return Number(w);
    }
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    return new Op(w);
  }

  private dict(): Dict {
    const d: Dict = {};
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.s.length) return d;
      if (this.s.startsWith(">>", this.pos)) {
        this.pos += 2;
        return d;
      }
      const k = this.value();
      if (!(k instanceof Name)) {
        if (k === undefined) this.pos++;
        continue;
      }
      const v = this.value();
      if (v !== undefined) d[k.name] = v;
    }
  }

  private literal(): PdfString {
    const s = this.s;
    let depth = 0;
    let out = "";
    this.pos++;
    while (this.pos < s.length) {
      const c = s[this.pos++]!;
      if (c === "\\") {
        const n = s[this.pos++];
        if (n === undefined) break;
        const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
        if (n in esc) out += esc[n];
        else if (n >= "0" && n <= "7") {
          let oct = n;
          while (oct.length < 3 && s[this.pos]! >= "0" && s[this.pos]! <= "7") oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (n === "\r") {
          if (s[this.pos] === "\n") this.pos++;
        } else if (n !== "\n") out += n;
      } else if (c === "(") {
        depth++;
        out += c;
      } else if (c === ")") {
        if (depth === 0) break;
        depth--;
        out += c;
      } else out += c;
    }
    return new PdfString(out);
  }

  private hex(): PdfString {
    const end = this.s.indexOf(">", this.pos);
    const body = this.s.slice(this.pos + 1, end < 0 ? this.s.length : end).replace(/[^0-9a-fA-F]/g, "");
    this.pos = end < 0 ? this.s.length : end + 1;
    const even = body.length % 2 ? `${body}0` : body;
    let out = "";
    for (let i = 0; i < even.length; i += 2) out += String.fromCharCode(parseInt(even.slice(i, i + 2), 16));
    return new PdfString(out);
  }
}

// ---- Document ------------------------------------------------------------------------------------------------

class PdfDoc {
  private readonly offsets = new Map<number, number>();
  private readonly inStream = new Map<number, { stm: number; index: number }>();
  private readonly cache = new Map<number, Value>();
  private decoded = 0;

  constructor(readonly src: string) {
    // Index every "n g obj" in the file; later definitions win (incremental updates append).
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
      const before = m.index === 0 ? " " : src[m.index - 1]!;
      if (/[0-9]/.test(before)) continue;
      this.offsets.set(Number(m[1]), m.index + m[0].length);
    }
    // Objects packed in object streams (PDF 1.5+).
    for (const num of [...this.offsets.keys()]) {
      const head = src.slice(this.offsets.get(num)!, this.offsets.get(num)! + 200);
      if (!/\/Type\s*\/ObjStm/.test(head) && !/\/ObjStm/.test(head)) continue;
      const stm = this.get(num);
      if (!(stm instanceof Stream) || !isNameValue(stm.dict.Type, "ObjStm")) continue;
      const data = this.decode(stm);
      const n = num2(stm.dict.N);
      const nums = new Parser(data).s.slice(0, num2(stm.dict.First)).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n && i * 2 + 1 < nums.length; i++) {
        const objNum = nums[i * 2]!;
        if (!this.offsets.has(objNum)) this.inStream.set(objNum, { stm: num, index: i });
      }
    }
    if (this.offsets.size === 0) throw new PdfTextError("not a readable PDF (no objects found)");
  }

  get(num: number): Value {
    if (this.cache.has(num)) return this.cache.get(num)!;
    this.cache.set(num, null); // guards against reference loops
    let value: Value = null;
    const off = this.offsets.get(num);
    if (off !== undefined) value = this.parseAt(off);
    else {
      const packed = this.inStream.get(num);
      if (packed) value = this.fromObjStm(packed.stm, packed.index);
    }
    this.cache.set(num, value);
    return value;
  }

  resolve(v: Value | undefined): Value | undefined {
    let guard = 0;
    while (v instanceof Ref && guard++ < 32) v = this.get(v.num);
    return v;
  }

  dict(v: Value | undefined): Dict | undefined {
    const r = this.resolve(v);
    if (r instanceof Stream) return r.dict;
    return isDict(r) ? r : undefined;
  }

  private parseAt(off: number): Value {
    const p = new Parser(this.src, off);
    const v = p.value();
    if (v === undefined) return null;
    if (isDict(v)) {
      p.skipSpace();
      if (this.src.startsWith("stream", p.pos)) {
        let start = p.pos + 6;
        if (this.src[start] === "\r") start++;
        if (this.src[start] === "\n") start++;
        const len = this.resolve(v.Length);
        let end = typeof len === "number" ? start + len : -1;
        if (end < 0 || end > this.src.length || !/^\s*endstream/.test(this.src.slice(end, end + 20))) {
          const e = this.src.indexOf("endstream", start);
          end = e < 0 ? this.src.length : e;
          // Trim the EOL before "endstream".
          if (this.src[end - 1] === "\n") end--;
          if (this.src[end - 1] === "\r") end--;
        }
        return new Stream(v, start, end, this.src);
      }
    }
    return v;
  }

  private fromObjStm(stmNum: number, index: number): Value {
    const stm = this.get(stmNum);
    if (!(stm instanceof Stream)) return null;
    const data = this.decode(stm);
    const first = num2(stm.dict.First);
    const nums = data.slice(0, first).trim().split(/\s+/).map(Number);
    const rel = nums[index * 2 + 1];
    if (rel === undefined) return null;
    return new Parser(data, first + rel).value() ?? null;
  }

  /** Decoded stream bytes as a latin1 string. Images and unknown filters decode to "". */
  decode(stm: Stream): string {
    const { data, codec } = this.unfilter(stm);
    return codec ? "" : data.toString("latin1"); // DCT, JPX, CCITT, LZW, JBIG2: images or rare encodings with no text for us
  }

  /**
   * Applies the stream's general-purpose filters (Flate with predictors, ASCIIHex, ASCII85) and stops at the first
   * other one. `codec` names that filter (DCTDecode, JBIG2Decode, …), or is null when every filter was applied, so
   * `data` is then the plain stream content (raw pixels for an image).
   */
  unfilter(stm: Stream): { data: Buffer; codec: string | null } {
    let data: Buffer = Buffer.from(stm.source.slice(stm.start, stm.end), "latin1");
    const filters = asArray(this.resolve(stm.dict.Filter)).map((f) => (f instanceof Name ? f.name : ""));
    const parms = asArray(this.resolve(stm.dict.DecodeParms));
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i]!;
      if (f === "FlateDecode" || f === "Fl") {
        data = inflate(data);
        const p = this.dict(parms[i] as Value);
        const predictor = p ? num2(this.resolve(p.Predictor), 1) : 1;
        if (predictor >= 10) {
          const colors = num2(this.resolve(p?.Colors), 1);
          const bpc = num2(this.resolve(p?.BitsPerComponent), 8);
          const rowBytes = Math.ceil((num2(this.resolve(p?.Columns), 1) * colors * bpc) / 8);
          data = unpredictPng(data, rowBytes, Math.max(1, Math.ceil((colors * bpc) / 8)));
        }
      } else if (f === "ASCIIHexDecode" || f === "AHx") {
        data = Buffer.from(data.toString("latin1").replace(/>.*$/s, "").replace(/[^0-9a-fA-F]/g, ""), "hex");
      } else if (f === "ASCII85Decode" || f === "A85") {
        data = ascii85(data.toString("latin1"));
      } else {
        return { data, codec: f };
      }
      this.decoded += data.length;
      if (this.decoded > MAX_TOTAL_BYTES) throw new PdfTextError("PDF expands to too much data to read");
    }
    return { data, codec: null };
  }

  catalog(): Dict | undefined {
    const trailerRoot = /trailer[\s\S]*?\/Root\s+(\d+)\s+\d+\s+R/.exec(this.src.slice(-65536));
    if (trailerRoot) {
      const d = this.dict(new Ref(Number(trailerRoot[1]), 0));
      if (d) return d;
    }
    // Cross-reference streams carry /Root in their dictionary; otherwise look for the catalog itself.
    let found: Dict | undefined;
    for (const num of [...this.offsets.keys(), ...this.inStream.keys()]) {
      const d = this.dict(this.get(num));
      if (!d) continue;
      if (isNameValue(d.Type, "XRef") && d.Root) {
        const root = this.dict(d.Root);
        if (root) found = root;
      } else if (isNameValue(d.Type, "Catalog")) found = d;
    }
    return found;
  }

  encrypted() {
    if (/trailer[\s\S]*?\/Encrypt\s/.test(this.src.slice(-65536))) return true;
    for (const num of this.offsets.keys()) {
      const head = this.src.slice(this.offsets.get(num)!, this.offsets.get(num)! + 400);
      if (/\/Type\s*\/XRef/.test(head) && /\/Encrypt\s/.test(head)) return true;
    }
    return false;
  }

  /** Page dictionaries in order, each with its inherited Resources. */
  pages(): { page: Dict; resources: Dict | undefined }[] {
    const out: { page: Dict; resources: Dict | undefined }[] = [];
    const seen = new Set<Value>();
    const walk = (node: Value | undefined, inherited: Dict | undefined, depth: number) => {
      const d = this.dict(node);
      if (!d || seen.has(d) || depth > 64 || out.length >= MAX_PAGES) return;
      seen.add(d);
      const resources = this.dict(d.Resources) ?? inherited;
      const kids = this.resolve(d.Kids);
      if (Array.isArray(kids) && !isNameValue(d.Type, "Page")) {
        for (const k of kids) walk(k, resources, depth + 1);
      } else out.push({ page: d, resources });
    };
    const root = this.catalog();
    if (root?.Pages) walk(root.Pages, undefined, 0);
    if (!out.length) {
      // No usable page tree: fall back to every page object in file order.
      for (const num of [...this.offsets.keys()].sort((a, b) => this.offsets.get(a)! - this.offsets.get(b)!)) {
        const d = this.dict(this.get(num));
        if (d && isNameValue(d.Type, "Page")) out.push({ page: d, resources: this.dict(d.Resources) });
        if (out.length >= MAX_PAGES) break;
      }
    }
    return out;
  }
}

function inflate(data: Buffer): Buffer {
  const opts = { maxOutputLength: MAX_STREAM_BYTES, finishFlush: constants.Z_SYNC_FLUSH };
  try {
    return inflateSync(data, opts);
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new PdfTextError("a PDF stream expands to too much data to read");
    try {
      return inflateRawSync(data, opts);
    } catch {
      return Buffer.alloc(0);
    }
  }
}

/** Undoes PNG row predictors; `bpp` is how many bytes back the Sub/Average/Paeth filters look (one pixel). */
function unpredictPng(data: Buffer, rowBytes: number, bpp = 1): Buffer {
  const width = rowBytes + 1;
  const rows = Math.floor(data.length / width);
  const out = Buffer.alloc(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * width]!;
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[r * width + 1 + i]!;
      const left = i >= bpp ? out[r * rowBytes + i - bpp]! : 0;
      const up = r > 0 ? out[(r - 1) * rowBytes + i]! : 0;
      const upLeft = r > 0 && i >= bpp ? out[(r - 1) * rowBytes + i - bpp]! : 0;
      let v = raw;
      if (type === 1) v = raw + left;
      else if (type === 2) v = raw + up;
      else if (type === 3) v = raw + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[r * rowBytes + i] = v & 0xff;
    }
  }
  return out;
}

function ascii85(s: string): Buffer {
  const body = s.replace(/^\s*<~/, "").replace(/~>[\s\S]*$/, "").replace(/\s+/g, "");
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of body) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const len = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, len - 1));
  }
  return Buffer.from(out);
}

const asArray = (v: Value | undefined): Value[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const num2 = (v: Value | undefined, dflt = 0) => (typeof v === "number" ? v : dflt);
const isNameValue = (v: Value | undefined, name: string) => v instanceof Name && v.name === name;

// ---- Fonts ---------------------------------------------------------------------------------------------------

/** WinAnsi differs from Latin-1 only in 0x80–0x9F. */
const WIN_ANSI_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const MAC_ROMAN_HIGH = "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uf8ffÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";
const GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[",
  backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`", braceleft: "{", bar: "|",
  braceright: "}", asciitilde: "~", bullet: "•", endash: "–", emdash: "—", quoteleft: "‘", quoteright: "’",
  quotedblleft: "“", quotedblright: "”", ellipsis: "…", fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl",
  copyright: "©", registered: "®", trademark: "™", degree: "°", minus: "−", multiply: "×", divide: "÷", Euro: "€",
  nbspace: " ", dagger: "†", daggerdbl: "‡", section: "§", paragraph: "¶", periodcentered: "·", guillemotleft: "«",
  guillemotright: "»", quotesinglbase: "‚", quotedblbase: "„", perthousand: "‰", dotlessi: "ı", sterling: "£", yen: "¥",
  cent: "¢", eacute: "é", egrave: "è", agrave: "à", aacute: "á", ccedilla: "ç", ntilde: "ñ", odieresis: "ö",
  udieresis: "ü", adieresis: "ä", germandbls: "ß", oacute: "ó", uacute: "ú", iacute: "í",
};
function glyphToUnicode(name: string): string | undefined {
  if (name.length === 1) return name;
  if (GLYPHS[name]) return GLYPHS[name];
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) return String.fromCodePoint(...m[1]!.match(/.{4}/g)!.map((h) => parseInt(h, 16)));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1]!, 16));
  const base = name.split(".")[0]!;
  if (base !== name) return glyphToUnicode(base);
  return undefined;
}

function utf16be(bytes: string): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  return out;
}

/** Parses a ToUnicode CMap's bfchar and bfrange sections. */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexNum = (h: string) => parseInt(h || "0", 16);
  const hexStr = (h: string) => utf16be(Buffer.from(h.length % 2 ? `${h}0` : h, "hex").toString("latin1"));
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(hexNum(m[1]!), hexStr(m[2]!));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = hexNum(m[1]!);
      const hi = Math.min(hexNum(m[2]!), lo + 65535);
      const dst = m[3]!;
      if (dst.startsWith("[")) {
        const items = [...dst.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexStr(x[1]!));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]!);
      } else {
        const start = dst.slice(1, -1);
        const base = hexStr(start);
        for (let c = lo; c <= hi; c++) {
          const off = c - lo;
          map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + off));
        }
      }
    }
  }
  return map;
}

interface Font {
  /** Bytes per character code. */
  codeBytes: 1 | 2;
  decode(code: number): string;
  /** Glyph advance in thousandths of the font size. */
  width(code: number): number;
}

function loadFont(doc: PdfDoc, fontDict: Dict | undefined): Font {
  if (!fontDict) return { codeBytes: 1, decode: latin1Char, width: () => 500 };
  const subtype = doc.resolve(fontDict.Subtype);
  const type0 = isNameValue(subtype, "Type0");
  const toUni = doc.resolve(fontDict.ToUnicode);
  const uni = toUni instanceof Stream ? parseToUnicode(doc.decode(toUni)) : undefined;

  if (type0) {
    const desc = doc.dict(asArray(doc.resolve(fontDict.DescendantFonts))[0]);
    const dw = num2(doc.resolve(desc?.DW), 1000);
    const widths = new Map<number, number>();
    const w = asArray(doc.resolve(desc?.W)).map((x) => doc.resolve(x));
    for (let i = 0; i < w.length; ) {
      const first = w[i];
      const next = w[i + 1];
      if (typeof first !== "number") break;
      if (Array.isArray(next)) {
        next.forEach((v, j) => widths.set(first + j, num2(doc.resolve(v), dw)));
        i += 2;
      } else if (typeof next === "number" && typeof w[i + 2] === "number") {
        for (let c = first; c <= next && c - first < 65536; c++) widths.set(c, w[i + 2] as number);
        i += 3;
      } else break;
    }
    return { codeBytes: 2, decode: (c) => uni?.get(c) ?? "", width: (c) => widths.get(c) ?? dw };
  }

  // Simple fonts: one byte per code; ToUnicode, else the encoding (with Differences), else WinAnsi.
  const table = new Map<number, string>();
  const enc = doc.resolve(fontDict.Encoding);
  const encDict = isDict(enc) ? enc : undefined;
  const diffs = asArray(doc.resolve(encDict?.Differences));
  let code = 0;
  for (const d of diffs) {
    const r = doc.resolve(d);
    if (typeof r === "number") code = r;
    else if (r instanceof Name) {
      const ch = glyphToUnicode(r.name);
      if (ch !== undefined) table.set(code, ch);
      code++;
    }
  }
  const baseName = enc instanceof Name ? enc.name : encDict?.BaseEncoding instanceof Name ? encDict.BaseEncoding.name : "";
  const base = baseName === "MacRomanEncoding" ? macRomanChar : latin1Char;
  const firstChar = num2(doc.resolve(fontDict.FirstChar), 0);
  const widthList = asArray(doc.resolve(fontDict.Widths)).map((x) => num2(doc.resolve(x), 0));
  return {
    codeBytes: 1,
    decode: (c) => uni?.get(c) ?? table.get(c) ?? base(c),
    width: (c) => widthList[c - firstChar] || 500,
  };
}

function macRomanChar(c: number) {
  return c >= 0x80 ? MAC_ROMAN_HIGH[c - 0x80]! : latin1Char(c);
}

function latin1Char(c: number) {
  if (c >= 0x80 && c <= 0x9f) return WIN_ANSI_HIGH[c - 0x80]!;
  if (c < 0x20 && c !== 0x09) return "";
  return String.fromCharCode(c);
}

// ---- Content streams -----------------------------------------------------------------------------------------

class TextCollector {
  private out = "";
  private lastY: number | null = null;
  private endX = 0;
  private fontSize = 12;

  setFontSize(size: number) {
    this.fontSize = Math.abs(size) || 12;
  }

  newline() {
    if (this.out && !this.out.endsWith("\n")) this.out += "\n";
  }

  /** Moves to (x, y) in text space; a different baseline starts a new line, a gap on the same line adds a space. */
  moveTo(x: number, y: number) {
    if (this.lastY !== null && Math.abs(y - this.lastY) > this.fontSize * 0.4) this.newline();
    else if (this.lastY !== null && x - this.endX > this.fontSize * 0.2) this.space();
    else if (this.lastY !== null && x < this.endX - this.fontSize * 2) this.newline();
    this.lastY = y;
    this.endX = x;
  }

  space() {
    if (this.out && !/[\s]$/.test(this.out)) this.out += " ";
  }

  add(text: string, advance: number) {
    this.out += text;
    this.endX += advance;
  }

  advance(by: number) {
    this.endX += by;
  }

  text() {
    return this.out
      .replace(/\u0000/g, "")
      .replace(/[\ufb00-\ufb06]/g, (c) => c.normalize("NFKC"))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

function runContent(doc: PdfDoc, data: string, resources: Dict | undefined, out: TextCollector, depth: number, fonts: Map<Dict, Font>) {
  const p = new Parser(data);
  const stack: Value[] = [];
  let font: Font = loadFont(doc, undefined);
  let size = 12;
  let hScale = 1;
  let charSpace = 0;
  let wordSpace = 0;
  let leading = 0;
  // Text and line matrices (a, b, c, d, e, f).
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  const scale = () => Math.hypot(tm[0]!, tm[1]!) || 1;
  const fontDicts = doc.dict(resources?.Font);
  const xobjects = doc.dict(resources?.XObject);

  const show = (s: Value) => {
    if (!(s instanceof PdfString)) return;
    const bytes = s.bytes;
    let text = "";
    let adv = 0;
    for (let i = 0; i + font.codeBytes <= bytes.length; i += font.codeBytes) {
      const code = font.codeBytes === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i);
      text += font.decode(code);
      adv += ((font.width(code) / 1000) * size + charSpace + (code === 32 && font.codeBytes === 1 ? wordSpace : 0)) * hScale;
    }
    out.add(text, adv * scale());
  };
  const moveLine = (tx: number, ty: number) => {
    tlm = [tlm[0]!, tlm[1]!, tlm[2]!, tlm[3]!, tlm[4]! + tx * tlm[0]! + ty * tlm[2]!, tlm[5]! + tx * tlm[1]! + ty * tlm[3]!];
    tm = [...tlm];
    out.moveTo(tm[4]!, tm[5]!);
  };

  for (let guard = 0; guard < 5_000_000; guard++) {
    const v = p.value();
    if (v === undefined) {
      if (p.pos >= data.length) break;
      continue;
    }
    if (!(v instanceof Op)) {
      stack.push(v);
      if (stack.length > 64) stack.shift();
      continue;
    }
    const n = (i: number) => num2(stack[stack.length - i] as Value);
    switch (v.op) {
      case "BI": {
        // Inline image: skip to EI.
        const ei = data.indexOf("EI", p.pos);
        p.pos = ei < 0 ? data.length : ei + 2;
        break;
      }
      case "BT":
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        break;
      case "Tf": {
        const name = stack[stack.length - 2];
        size = n(1) || size;
        const fd = name instanceof Name ? doc.dict(fontDicts?.[name.name]) : undefined;
        if (fd) {
          if (!fonts.has(fd)) fonts.set(fd, loadFont(doc, fd));
          font = fonts.get(fd)!;
        }
        out.setFontSize(size * scale());
        break;
      }
      case "Tz":
        hScale = n(1) / 100 || 1;
        break;
      case "Tc":
        charSpace = n(1);
        break;
      case "Tw":
        wordSpace = n(1);
        break;
      case "TL":
        leading = n(1);
        break;
      case "Td":
        moveLine(n(2), n(1));
        break;
      case "TD":
        leading = -n(1);
        moveLine(n(2), n(1));
        break;
      case "Tm":
        tm = [n(6), n(5), n(4), n(3), n(2), n(1)];
        tlm = [...tm];
        out.setFontSize(size * scale());
        out.moveTo(tm[4]!, tm[5]!);
        break;
      case "T*":
        moveLine(0, -leading);
        break;
      case "Tj":
        show(stack[stack.length - 1]!);
        break;
      case "'":
        moveLine(0, -leading);
        show(stack[stack.length - 1]!);
        break;
      case '"':
        wordSpace = n(3);
        charSpace = n(2);
        moveLine(0, -leading);
        show(stack[stack.length - 1]!);
        break;
      case "TJ": {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item === "number") {
              const shift = (-item / 1000) * size * hScale * scale();
              if (-item > 180) out.space();
              out.advance(shift);
            } else show(item);
          }
        }
        break;
      }
      case "ET":
        break;
      case "Do": {
        const name = stack[stack.length - 1];
        const xo = name instanceof Name ? doc.resolve(xobjects?.[name.name]) : undefined;
        if (xo instanceof Stream && isNameValue(doc.resolve(xo.dict.Subtype), "Form") && depth < MAX_FORM_DEPTH) {
          runContent(doc, doc.decode(xo), doc.dict(xo.dict.Resources) ?? resources, out, depth + 1, fonts);
        }
        break;
      }
    }
    stack.length = 0;
  }
}

// ---- Entry point ---------------------------------------------------------------------------------------------

function openPdf(data: Buffer, what: string): PdfDoc {
  const src = data.toString("latin1");
  if (!src.startsWith("%PDF-") && !src.slice(0, 1024).includes("%PDF-")) throw new PdfTextError("not a PDF file");
  const doc = new PdfDoc(src);
  if (doc.encrypted()) throw new PdfTextError(`the PDF is encrypted, so its ${what} can't be read`);
  return doc;
}

const pageContent = (doc: PdfDoc, page: Dict) =>
  asArray(doc.resolve(page.Contents))
    .map((c) => doc.resolve(c))
    .map((c) => (c instanceof Stream ? doc.decode(c) : ""))
    .join("\n");

/** Extracts the text of every page. Throws PdfTextError for files it can't read. */
export function extractPdfText(data: Buffer): PdfTextResult {
  const doc = openPdf(data, "text");
  const pages = doc.pages();
  const fonts = new Map<Dict, Font>();
  const texts = pages.map(({ page, resources }) => {
    const out = new TextCollector();
    try {
      runContent(doc, pageContent(doc, page), resources, out, 0, fonts);
    } catch (err) {
      if (err instanceof PdfTextError) throw err;
      // A broken page shouldn't hide the rest of the document.
    }
    return out.text();
  });
  return { pageCount: pages.length, pages: texts };
}

/** Parses "3", "2-5", "1,4,7-9" into 1-based page numbers within 1..count (in order, without repeats). */
export function parsePageRange(spec: string, count: number): number[] {
  const picked = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(part);
    if (!m) throw new PdfTextError(`invalid page range "${part}"; use e.g. "3", "2-5" or "1,4,7-9"`);
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : part.includes("-") ? count : from;
    for (let p = Math.max(1, from); p <= Math.min(count, to); p++) picked.add(p);
  }
  return [...picked].sort((a, b) => a - b);
}

// ---- Reading a PDF a few pages at a time (MCP get_asset) -----------------------------------------------------

const textCache = new Map<string, PdfTextResult>();

/** Extracted text, cached by content hash so reading a long PDF page by page parses it once. */
export function pdfTextCached(key: string, data: Buffer): PdfTextResult {
  const hit = textCache.get(key);
  if (hit) {
    textCache.delete(key);
    textCache.set(key, hit);
    return hit;
  }
  const result = extractPdfText(data);
  textCache.set(key, result);
  while (textCache.size > 16) textCache.delete(textCache.keys().next().value!);
  return result;
}

export interface PdfTextSlice {
  page_count: number;
  /** The pages included, e.g. "1-12". */
  pages_returned: string;
  /** What to pass as `pages` to read on, or null when nothing is left. */
  next_pages: string | null;
  /** True when no page has any text (a scanned PDF, or only images). */
  no_text: boolean;
  text: string;
}

/** The requested pages as text with page markers, stopping before `maxChars` (a long page is cut, and said so). */
export function pdfTextSlice(result: PdfTextResult, pages: string | undefined, maxChars: number): PdfTextSlice {
  const count = result.pageCount;
  const wanted = pages ? parsePageRange(pages, count) : Array.from({ length: count }, (_, i) => i + 1);
  if (pages && !wanted.length) throw new PdfTextError(`the PDF has ${count} page${count === 1 ? "" : "s"}; "${pages}" selects none`);
  let text = "";
  const done: number[] = [];
  for (const n of wanted) {
    const block = `--- Page ${n} of ${count} ---\n${result.pages[n - 1] || "(no text on this page)"}\n\n`;
    if (text.length + block.length > maxChars) {
      if (!done.length) {
        text = `${block.slice(0, maxChars)}\n…(page ${n} is cut here: it is longer than one response)\n`;
        done.push(n);
      }
      break;
    }
    text += block;
    done.push(n);
  }
  const rest = wanted.filter((n) => !done.includes(n));
  return {
    page_count: count,
    pages_returned: ranges(done),
    next_pages: rest.length ? ranges(rest) : null,
    no_text: result.pages.every((p) => !p),
    text: text.trimEnd(),
  };
}

function ranges(nums: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    parts.push(i === j ? String(nums[i]) : `${nums[i]}-${nums[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

// ---- Page images (scanned PDFs over MCP: get_asset as "images") ------------------------------------------------
//
// A scanned PDF is one picture per page, so there is no text to extract, and some MCP clients (Claude.ai) refuse a
// PDF sent as an embedded file. This returns each page's picture as a PNG or JPEG instead, which every client
// shows. It doesn't render pages: it finds the largest image drawn on each page and passes it on. JPEG (DCTDecode)
// images go out unchanged; raw and Flate-compressed pixels (gray, RGB, CMYK, indexed) are written as PNG. JBIG2,
// CCITT fax and JPEG 2000 images aren't decoded, and those pages are reported as skipped.

/** Sizes the Claude API accepts for one image; a larger page is skipped rather than sent and refused. */
const MAX_IMAGE_SIDE = 8000;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
/**
 * Uncompressed pixel bytes for one image we convert to PNG. Buffers are sized from the size the PDF declares, so this
 * caps memory for a huge or hostile image (an A4 page scanned at 300 dpi in colour is about 26 MB).
 */
const MAX_RAW_IMAGE_BYTES = 48 * 1024 * 1024;

export interface PdfPageImage {
  page: number;
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  data: Buffer;
}

export interface PdfImageSlice {
  page_count: number;
  /** The pages handled, e.g. "1-4" (including skipped ones). */
  pages_returned: string;
  /** What to pass as `pages` to read on, or null when nothing is left. */
  next_pages: string | null;
  images: PdfPageImage[];
  /** Pages in this part whose picture couldn't be returned, and why. */
  skipped: { page: number; reason: string }[];
}

const CODEC_NAMES: Record<string, string> = {
  JBIG2Decode: "JBIG2",
  CCITTFaxDecode: "CCITT fax",
  CCF: "CCITT fax",
  JPXDecode: "JPEG 2000",
  LZWDecode: "LZW",
  LZW: "LZW",
  RunLengthDecode: "run-length",
  RL: "run-length",
};

/** Image XObjects drawn by a content stream (following form XObjects), in drawing order. */
function drawnImages(doc: PdfDoc, data: string, resources: Dict | undefined, depth: number, out: Stream[]) {
  const p = new Parser(data);
  const xobjects = doc.dict(resources?.XObject);
  let last: Value | undefined;
  for (let guard = 0; guard < 5_000_000; guard++) {
    const v = p.value();
    if (v === undefined) {
      if (p.pos >= data.length) break;
      continue;
    }
    if (v instanceof Op) {
      if (v.op === "BI") {
        // Inline images are small (icons, rules); skip their binary data.
        const ei = data.indexOf("EI", p.pos);
        p.pos = ei < 0 ? data.length : ei + 2;
      } else if (v.op === "Do" && last instanceof Name) {
        const xo = doc.resolve(xobjects?.[last.name]);
        if (xo instanceof Stream) {
          const subtype = doc.resolve(xo.dict.Subtype);
          if (isNameValue(subtype, "Image")) {
            if (!out.includes(xo)) out.push(xo);
          } else if (isNameValue(subtype, "Form") && depth < MAX_FORM_DEPTH) {
            drawnImages(doc, doc.decode(xo), doc.dict(xo.dict.Resources) ?? resources, depth + 1, out);
          }
        }
      }
    }
    last = v;
  }
}

type ColorSpace = { kind: "gray" | "rgb" | "cmyk"; colors: number } | { kind: "indexed"; colors: 1; palette: Buffer; hival: number };

function colorSpace(doc: PdfDoc, v: Value | undefined, depth = 0): ColorSpace | undefined {
  const cs = doc.resolve(v);
  const device = (name: string): ColorSpace | undefined =>
    name === "DeviceGray" || name === "G" || name === "CalGray"
      ? { kind: "gray", colors: 1 }
      : name === "DeviceRGB" || name === "RGB" || name === "CalRGB"
        ? { kind: "rgb", colors: 3 }
        : name === "DeviceCMYK" || name === "CMYK"
          ? { kind: "cmyk", colors: 4 }
          : undefined;
  if (cs instanceof Name) return device(cs.name);
  if (!Array.isArray(cs) || !(cs[0] instanceof Name) || depth > 2) return undefined;
  const family = cs[0].name;
  if (family === "ICCBased") {
    const n = num2(doc.dict(cs[1])?.N);
    return n === 1 ? device("DeviceGray") : n === 3 ? device("DeviceRGB") : n === 4 ? device("DeviceCMYK") : undefined;
  }
  if (family === "CalGray" || family === "CalRGB") return device(family);
  if (family === "Indexed" || family === "I") {
    const base = colorSpace(doc, cs[1], depth + 1);
    const hival = num2(doc.resolve(cs[2]));
    const lookupV = doc.resolve(cs[3]);
    if (!base || base.kind === "indexed" || hival < 0 || hival > 255) return undefined;
    const lookup =
      lookupV instanceof PdfString ? Buffer.from(lookupV.bytes, "latin1") : lookupV instanceof Stream ? doc.unfilter(lookupV).data : undefined;
    if (!lookup) return undefined;
    const palette = Buffer.alloc((hival + 1) * 3);
    for (let i = 0; i <= hival; i++) {
      const c = (k: number) => lookup[i * base.colors + k] ?? 0;
      const rgb = base.kind === "gray" ? [c(0), c(0), c(0)] : base.kind === "rgb" ? [c(0), c(1), c(2)] : cmykToRgb(c(0), c(1), c(2), c(3));
      palette.set(rgb, i * 3);
    }
    return { kind: "indexed", colors: 1, palette, hival };
  }
  return undefined;
}

function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  const f = (x: number) => Math.round(((255 - x) * (255 - k)) / 255);
  return [f(c), f(m), f(y)];
}

/** The picture as a JPEG or PNG file, or why it can't be sent. */
function imageFile(doc: PdfDoc, stm: Stream): Omit<PdfPageImage, "page"> | { reason: string } {
  const d = stm.dict;
  const width = num2(doc.resolve(d.Width ?? d.W));
  const height = num2(doc.resolve(d.Height ?? d.H));
  if (width < 1 || height < 1) return { reason: "the page's image has no size" };
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS)
    return { reason: `the page's image is ${width}x${height} pixels, larger than an image a client accepts (${MAX_IMAGE_SIDE} px a side)` };
  const { data, codec } = doc.unfilter(stm);
  if (codec === "DCTDecode" || codec === "DCT") return { mime: "image/jpeg", width, height, data };
  if (codec) return { reason: `the page's image uses ${CODEC_NAMES[codec] ?? codec} compression, which can't be converted here` };

  const mask = doc.resolve(d.ImageMask ?? d.IM) === true;
  const bpc = mask ? 1 : num2(doc.resolve(d.BitsPerComponent ?? d.BPC), 8);
  const cs: ColorSpace | undefined = mask ? { kind: "gray", colors: 1 } : colorSpace(doc, d.ColorSpace ?? d.CS);
  if (!cs) return { reason: "the page's image uses a color space that can't be converted here" };
  if (![1, 2, 4, 8].includes(bpc) || (bpc !== 8 && cs.kind !== "gray" && cs.kind !== "indexed"))
    return { reason: `the page's image uses ${bpc} bits per component, which can't be converted here` };

  const rowBytes = Math.ceil((width * cs.colors * bpc) / 8);
  if (rowBytes * height > MAX_RAW_IMAGE_BYTES)
    return { reason: `the page's image is ${width}x${height} pixels, too large to convert here; open the PDF in the web UI` };
  const pixels = Buffer.alloc(rowBytes * height);
  data.copy(pixels, 0, 0, Math.min(data.length, pixels.length)); // a short stream leaves the rest black, like viewers do
  const decode = doc.resolve(d.Decode ?? d.D);
  // Samples map straight to PNG gray (0 = black): an image mask paints black where the sample is 0 and leaves 1 white.
  // A Decode array of [1 0] (BlackIs1 scans) flips that.
  const inverted = Array.isArray(decode) && decode[0] === 1 && decode[1] === 0;
  if (cs.kind === "gray" && inverted) for (let i = 0; i < pixels.length; i++) pixels[i] = ~pixels[i]! & 0xff;

  if (cs.kind === "indexed") return { mime: "image/png", width, height, data: encodePng(width, height, bpc, 3, pixels, rowBytes, cs.palette) };
  if (cs.kind === "gray") return { mime: "image/png", width, height, data: encodePng(width, height, bpc, 0, pixels, rowBytes) };
  if (cs.kind === "rgb") return { mime: "image/png", width, height, data: encodePng(width, height, 8, 2, pixels, rowBytes) };
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; i + 3 < pixels.length && o < rgb.length; i += 4, o += 3) rgb.set(cmykToRgb(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!), o);
  return { mime: "image/png", width, height, data: encodePng(width, height, 8, 2, rgb, width * 3) };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A PNG from packed rows (`rowBytes` each, PDF and PNG pack sub-byte samples the same way, high bits first). */
function encodePng(width: number, height: number, bitDepth: number, colorType: 0 | 2 | 3, rows: Buffer, rowBytes: number, palette?: Buffer): Buffer {
  const raw = Buffer.alloc((rowBytes + 1) * height); // each row starts with filter type 0 (none)
  for (let r = 0; r < height; r++) rows.copy(raw, r * (rowBytes + 1) + 1, r * rowBytes, (r + 1) * rowBytes);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...(palette ? [pngChunk("PLTE", palette)] : []),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Each requested page's picture (the largest image drawn on it), stopping before `maxBytes` in total or `maxImages`
 * pictures, so a long scan arrives in parts. A page whose picture is over `maxImageBytes` or can't be converted is
 * listed in `skipped` with the reason.
 */
export function pdfPageImages(
  data: Buffer,
  pages: string | undefined,
  limits: { maxBytes: number; maxImageBytes: number; maxImages: number },
): PdfImageSlice {
  const doc = openPdf(data, "pages");
  const all = doc.pages();
  const count = all.length;
  const wanted = pages ? parsePageRange(pages, count) : Array.from({ length: count }, (_, i) => i + 1);
  if (pages && !wanted.length) throw new PdfTextError(`the PDF has ${count} page${count === 1 ? "" : "s"}; "${pages}" selects none`);
  const images: PdfPageImage[] = [];
  const skipped: { page: number; reason: string }[] = [];
  const done: number[] = [];
  let total = 0;
  for (const n of wanted) {
    if (images.length >= limits.maxImages) break;
    const { page, resources } = all[n - 1]!;
    const found: Stream[] = [];
    try {
      drawnImages(doc, pageContent(doc, page), resources, 0, found);
    } catch (err) {
      if (err instanceof PdfTextError) throw err;
    }
    const area = (s: Stream) => num2(doc.resolve(s.dict.Width ?? s.dict.W)) * num2(doc.resolve(s.dict.Height ?? s.dict.H));
    const biggest = found.reduce<Stream | undefined>((best, s) => (!best || area(s) > area(best) ? s : best), undefined);
    if (!biggest) {
      skipped.push({ page: n, reason: "no image on this page" });
      done.push(n);
      continue;
    }
    const file = imageFile(doc, biggest);
    if ("reason" in file) {
      skipped.push({ page: n, reason: file.reason });
      done.push(n);
      continue;
    }
    if (file.data.length > limits.maxImageBytes) {
      const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
      skipped.push({ page: n, reason: `the page's image is ${mb(file.data.length)} MB, over the ${mb(limits.maxImageBytes)} MB limit for one image` });
      done.push(n);
      continue;
    }
    if (images.length && total + file.data.length > limits.maxBytes) break;
    images.push({ page: n, ...file });
    total += file.data.length;
    done.push(n);
  }
  const rest = wanted.filter((n) => !done.includes(n));
  return { page_count: count, pages_returned: ranges(done), next_pages: rest.length ? ranges(rest) : null, images, skipped };
}
