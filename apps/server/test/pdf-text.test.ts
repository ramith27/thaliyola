import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { uploadAsset } from "../src/core/assets.js";
import { extractPdfText, parsePageRange, pdfTextSlice } from "../src/core/pdf-text.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

// ---- A tiny PDF writer for fixtures (byte-exact offsets in the xref table) ------------------------------------

type Body = string | Buffer;
const stream = (dict: string, data: Body, compress = false) => {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
  const bytes = compress ? deflateSync(raw) : raw;
  return Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length}${compress ? " /Filter /FlateDecode" : ""} ${dict} >>\nstream\n`, "latin1"),
    bytes,
    Buffer.from("\nendstream", "latin1"),
  ]);
};
function pdf(objects: Record<number, Body>, trailerExtra = ""): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: Record<number, number> = {};
  let length = parts[0]!.length;
  const nums = Object.keys(objects).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    offsets[n] = length;
    const body = objects[n]!;
    const chunk = Buffer.concat([Buffer.from(`${n} 0 obj\n`, "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"), Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    length += chunk.length;
  }
  const size = Math.max(...nums) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) xref += offsets[n] !== undefined ? `${String(offsets[n]).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${size} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${length}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
const catalog = (kids: number[]) => ({
  1: "<< /Type /Catalog /Pages 2 0 R >>",
  2: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`,
});
const helvetica = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/** Two pages with a standard font, WinAnsi characters and TJ kerning. */
const simplePdf = () =>
  pdf({
    ...catalog([3, 5]),
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    4: helvetica,
    5: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    6: stream("", "BT /F1 12 Tf 72 720 Td (Audit report: caf\\351) Tj 0 -14 Td (\\223Score\\224 72/100 \\(good\\)) Tj ET"),
    7: stream("", "BT /F1 12 Tf 72 720 Td [(Find) -20 (ings)] TJ 0 -14 Td [(two) -300 (words)] TJ ET", true),
  });

/** What Chrome (Skia) writes: compressed streams, a Type0 font with Identity-H codes, a ToUnicode CMap and widths. */
const chromeLikePdf = () => {
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar
<0001> <0048>
<0002> <0069>
<0003> <6771>
endbfchar
1 beginbfrange
<0004> <0006> <0041>
endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;
  return pdf({
    ...catalog([3]),
    3: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    4: "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Inter /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>",
    5: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Inter /DW 1000 /W [1 [600 600] 3 3 1000] >>",
    6: stream("", cmap, true),
    7: stream("", "q 1 0 0 -1 0 792 cm BT /F1 12 Tf 1 0 0 1 72 700 Tm <00010002> Tj 1 0 0 1 96 700 Tm <0003> Tj 1 0 0 1 72 680 Tm <000400050006> Tj ET Q", true),
  });
};

/** PDF 1.5 object stream holding the page and font, plus a form XObject with its own resources. */
const objectStreamPdf = () => {
  const objs = ["<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm1 6 0 R >> >> /Contents 5 0 R >>", helvetica];
  let header = "";
  let body = "";
  objs.forEach((o, i) => {
    header += `${3 + i} ${body.length} `;
    body += `${o}\n`;
  });
  return pdf({
    ...catalog([3]),
    5: stream("", "q /Fm1 Do Q", true),
    6: stream("/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F9 4 0 R >> >>", "BT /F9 10 Tf 50 50 Td (Inside a form) Tj ET", true),
    8: stream(`/Type /ObjStm /N 2 /First ${header.length}`, header + body, true),
  });
};

describe("PDF text extraction", () => {
  it("reads simple fonts page by page, with WinAnsi characters, escapes and kerning", () => {
    const r = extractPdfText(simplePdf());
    expect(r.pageCount).toBe(2);
    expect(r.pages[0]).toBe("Audit report: café\n“Score” 72/100 (good)");
    expect(r.pages[1]).toBe("Findings\ntwo words");
  });

  it("reads Chrome-style PDFs: Type0 fonts, ToUnicode ranges, compressed streams, spaces from positions", () => {
    expect(extractPdfText(chromeLikePdf()).pages).toEqual(["Hi 東\nABC"]);
  });

  it("finds objects inside object streams and text inside form XObjects", () => {
    expect(extractPdfText(objectStreamPdf()).pages).toEqual(["Inside a form"]);
  });

  it("refuses files it can't read", () => {
    expect(() => extractPdfText(Buffer.from("hello"))).toThrow(/not a PDF/);
    expect(() => extractPdfText(pdf({ ...catalog([]), 9: "<< /Filter /Standard >>" }, "/Encrypt 9 0 R"))).toThrow(/encrypted/);
  });

  it("selects page ranges and splits long text into parts with what to read next", () => {
    expect(parsePageRange("1,3-", 5)).toEqual([1, 3, 4, 5]);
    expect(parsePageRange("0-2, 2", 5)).toEqual([1, 2]);
    expect(() => parsePageRange("two", 5)).toThrow(/invalid page range/);

    const doc = { pageCount: 3, pages: ["a".repeat(50), "", "c".repeat(50)] };
    expect(pdfTextSlice(doc, undefined, 10_000)).toMatchObject({ page_count: 3, pages_returned: "1-3", next_pages: null, no_text: false });
    expect(pdfTextSlice(doc, undefined, 10_000).text).toContain("--- Page 2 of 3 ---\n(no text on this page)");
    const part = pdfTextSlice(doc, undefined, 150);
    expect(part).toMatchObject({ pages_returned: "1-2", next_pages: "3" });
    // A page longer than one response is cut rather than skipped.
    expect(pdfTextSlice(doc, "3", 30)).toMatchObject({ pages_returned: "3", next_pages: null });
    expect(() => pdfTextSlice(doc, "7-9", 100)).toThrow(/has 3 pages/);
  });
});

// ---- Over MCP -------------------------------------------------------------------------------------------------

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let server: Server;
let client: Client;

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator("user=alice@example.com"), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: "Bearer user" } } }),
  );
});
afterAll(async () => {
  await client.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

type Content = { type: string; text?: string; resource?: { uri: string; mimeType: string; blob: string } };
async function getAssetTool(args: Record<string, unknown>) {
  const res = await client.callTool({ name: "get_asset", arguments: args });
  const content = res.content as Content[];
  return { isError: !!res.isError, content, meta: res.isError ? null : JSON.parse(content[0]!.text!) };
}

describe("get_asset with PDFs", () => {
  it("returns an attached PDF's text, page by page, and the file itself on request", async () => {
    const ctx = await ctxFor(db);
    const file = simplePdf();
    const { asset_id } = await uploadAsset(ctx, { target_id: ids.dataTable, filename: "audit-report.pdf", mime: "application/pdf", data: file });

    const all = await getAssetTool({ id: asset_id });
    expect(all.meta).toMatchObject({ filename: "audit-report.pdf", mime: "application/pdf", page_count: 2, pages_returned: "1-2", next_pages: null });
    expect(all.content[1]!.text).toBe("--- Page 1 of 2 ---\nAudit report: café\n“Score” 72/100 (good)\n\n--- Page 2 of 2 ---\nFindings\ntwo words");

    const second = await getAssetTool({ id: asset_id, pages: "2" });
    expect(second.meta).toMatchObject({ pages_returned: "2" });
    expect(second.content[1]!.text).not.toContain("Audit report");

    const asFile = await getAssetTool({ id: asset_id, as: "file" });
    expect(asFile.content[1]).toEqual({ type: "resource", resource: { uri: `thaliyola://assets/${asset_id}`, mimeType: "application/pdf", blob: file.toString("base64") } });

    expect((await getAssetTool({ id: asset_id, pages: "5" })).isError).toBe(true);
  });

  it("says when a PDF has no text (scanned pages)", async () => {
    const ctx = await ctxFor(db);
    const scanned = pdf({ ...catalog([3]), 3: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>", 4: stream("", "q 612 0 0 792 0 0 cm Q") });
    const { asset_id } = await uploadAsset(ctx, { target_id: ids.dataTable, filename: "scan.pdf", mime: "application/pdf", data: scanned });
    const got = await getAssetTool({ id: asset_id });
    expect(got.meta).toMatchObject({ page_count: 1, no_text: true });
    expect(got.content[1]!.text).toMatch(/no text to read.*as: "images"/s);
  });

  it("returns a scanned PDF's pages as images (clients that refuse PDF files can still see them)", async () => {
    const ctx = await ctxFor(db);
    // Not a real JPEG: DCT data is passed through byte for byte.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
    const scanned = pdf({
      ...catalog([3]),
      3: "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
      4: stream("/Type /XObject /Subtype /Image /Width 1700 /Height 2200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpeg),
      5: stream("", "q 612 0 0 792 0 0 cm /Im0 Do Q"),
    });
    const { asset_id } = await uploadAsset(ctx, { target_id: ids.dataTable, filename: "signed-scan.pdf", mime: "application/pdf", data: scanned });
    const got = await getAssetTool({ id: asset_id, as: "images" });
    expect(got.meta).toMatchObject({
      filename: "signed-scan.pdf",
      page_count: 1,
      pages_returned: "1",
      next_pages: null,
      skipped: [],
      images: [{ page: 1, mime: "image/jpeg", width: 1700, height: 2200 }],
    });
    expect(got.content.slice(1)).toEqual([
      { type: "text", text: "--- Page 1 of 1 ---" },
      { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
    ]);

    // A text PDF has no page pictures: say so instead of returning nothing.
    const { asset_id: textId } = await uploadAsset(ctx, { target_id: ids.dataTable, filename: "report.pdf", mime: "application/pdf", data: simplePdf() });
    const none = await getAssetTool({ id: textId, as: "images" });
    expect(none.meta.skipped).toHaveLength(2);
    expect(none.content[1]!.text).toMatch(/leave out as to read it/);
  });
});
