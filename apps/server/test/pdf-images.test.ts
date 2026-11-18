import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pdfPageImages } from "../src/core/pdf-text.js";

// ---- Fixtures: a minimal PDF writer (same shape as pdf-text.test.ts) ---------------------------------------------

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
function pdf(objects: Record<number, Body>): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n", "latin1")];
  for (const n of Object.keys(objects).map(Number).sort((a, b) => a - b)) {
    const body = objects[n]!;
    parts.push(Buffer.from(`${n} 0 obj\n`, "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"), Buffer.from("\nendobj\n", "latin1"));
  }
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return Buffer.concat(parts);
}
const catalog = (kids: number[]) => ({
  1: "<< /Type /Catalog /Pages 2 0 R >>",
  2: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`,
});
/** A page drawing XObject /Im0 (object `img`) full-page, with its own resources. */
const scanPage = (img: number, content: number) => `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`;
const drawIm0 = stream("", "q 612 0 0 792 0 0 cm /Im0 Do Q");
/** Not a real JPEG, but DCT data is passed through byte for byte, so any bytes do. */
const fakeJpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag, "latin1"), Buffer.from([0xff, 0xd9])]);
const LIMITS = { maxBytes: 8 * 1024 * 1024, maxImageBytes: 3 * 1024 * 1024, maxImages: 10 };

/** Reads a PNG back: header fields, palette, and the unfiltered rows (the encoder only writes filter 0). */
function readPng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let pos = 8;
  const chunks: Record<string, Buffer> = {};
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IDAT") idat.push(data);
    else chunks[type] = data;
    pos += len + 12;
  }
  const ihdr = chunks.IHDR!;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8]!;
  const colorType = ihdr[9]!;
  const channels = colorType === 2 ? 3 : 1;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const rows: number[][] = [];
  for (let r = 0; r < height; r++) {
    expect(raw[r * (rowBytes + 1)]).toBe(0);
    rows.push([...raw.subarray(r * (rowBytes + 1) + 1, (r + 1) * (rowBytes + 1))]);
  }
  return { width, height, bitDepth, colorType, palette: chunks.PLTE ? [...chunks.PLTE] : undefined, rows };
}

describe("PDF page images (scanned PDFs)", () => {
  it("passes a JPEG scan through unchanged, one image per page", () => {
    const doc = pdf({
      ...catalog([3, 6]),
      3: scanPage(4, 5),
      4: stream("/Type /XObject /Subtype /Image /Width 1700 /Height 2200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", fakeJpeg("page-1")),
      5: drawIm0,
      6: scanPage(7, 8),
      7: stream("/Type /XObject /Subtype /Image /Width 1700 /Height 2200 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode", fakeJpeg("page-2")),
      8: drawIm0,
    });
    const got = pdfPageImages(doc, undefined, LIMITS);
    expect(got).toMatchObject({ page_count: 2, pages_returned: "1-2", next_pages: null, skipped: [] });
    expect(got.images.map(({ page, mime, width, height }) => ({ page, mime, width, height }))).toEqual([
      { page: 1, mime: "image/jpeg", width: 1700, height: 2200 },
      { page: 2, mime: "image/jpeg", width: 1700, height: 2200 },
    ]);
    expect(got.images[0]!.data).toEqual(fakeJpeg("page-1"));
    expect(got.images[1]!.data).toEqual(fakeJpeg("page-2"));
  });

  it("writes Flate RGB pixels as PNG, undoing PNG predictors that look back a whole pixel", () => {
    // 2x2 RGB: red, green / blue, white. Predictor 15 with Sub (1) on row 0 and Up (2) on row 1.
    const pixels = [
      [255, 0, 0, 0, 255, 0],
      [0, 0, 255, 255, 255, 255],
    ];
    const predicted = Buffer.from([
      1, ...[255, 0, 0, (0 - 255) & 0xff, 255, 0],
      2, ...[(0 - 255) & 0xff, 0, 255, 255, 0, 255],
    ]);
    const doc = pdf({
      ...catalog([3]),
      3: scanPage(4, 5),
      4: stream(
        "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /DecodeParms << /Predictor 15 /Colors 3 /Columns 2 >>",
        predicted,
        true,
      ),
      5: drawIm0,
    });
    const [img] = pdfPageImages(doc, undefined, LIMITS).images;
    expect(img).toMatchObject({ mime: "image/png", width: 2, height: 2 });
    expect(readPng(img!.data)).toMatchObject({ width: 2, height: 2, bitDepth: 8, colorType: 2, rows: pixels });
  });

  it("writes 1-bit scans as 1-bit gray PNG, flipping BlackIs1 (Decode [1 0]) and image masks right", () => {
    // 8x1: alternate black and white. In PDF DeviceGray 1-bit, 0 = black.
    const plain = pdf({
      ...catalog([3]),
      3: scanPage(4, 5),
      4: stream("/Type /XObject /Subtype /Image /Width 8 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 1", Buffer.from([0b01010101])),
      5: drawIm0,
    });
    expect(readPng(pdfPageImages(plain, undefined, LIMITS).images[0]!.data)).toMatchObject({ bitDepth: 1, colorType: 0, rows: [[0b01010101]] });

    const blackIs1 = pdf({
      ...catalog([3]),
      3: scanPage(4, 5),
      4: stream("/Type /XObject /Subtype /Image /Width 8 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0]", Buffer.from([0b01010101])),
      5: drawIm0,
    });
    expect(readPng(pdfPageImages(blackIs1, undefined, LIMITS).images[0]!.data).rows).toEqual([[0b10101010]]);

    const mask = pdf({
      ...catalog([3]),
      3: scanPage(4, 5),
      4: stream("/Type /XObject /Subtype /Image /Width 8 /Height 1 /ImageMask true", Buffer.from([0b11110000])),
      5: drawIm0,
    });
    // Mask samples of 0 are painted (black), 1 left white: the same bits in PNG gray.
    expect(readPng(pdfPageImages(mask, undefined, LIMITS).images[0]!.data)).toMatchObject({ bitDepth: 1, colorType: 0, rows: [[0b11110000]] });
  });

  it("writes indexed images as palette PNGs and converts CMYK to RGB", () => {
    const indexed = pdf({
      ...catalog([3]),
      3: scanPage(4, 5),
      4: stream("/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace [/Indexed /DeviceRGB 1 <FF000000FF00>] /BitsPerComponent 8", Buffer.from([1, 0])),
      5: drawIm0,
    });
    expect(readPng(pdfPageImages(indexed, undefined, LIMITS).images[0]!.data)).toMatchObject({
      colorType: 3,
      palette: [255, 0, 0, 0, 255, 0],
      rows: [[1, 0]],
    });

    const cmyk = pdf({
      ...catalog([3]),
      3: scanPage(4, 5),
      4: stream("/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceCMYK /BitsPerComponent 8", Buffer.from([0, 0, 0, 0, 0, 255, 255, 0])),
      5: drawIm0,
    });
    expect(readPng(pdfPageImages(cmyk, undefined, LIMITS).images[0]!.data)).toMatchObject({ colorType: 2, rows: [[255, 255, 255, 255, 0, 0]] });
  });

  it("returns the image the page draws (also inside forms), the largest when there are several", () => {
    // Shared resources list a big image the page never draws; the page draws a form that draws a logo and the scan.
    const doc = pdf({
      ...catalog([3]),
      3: "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Unused 4 0 R /Fm0 5 0 R >> >> /Contents 9 0 R >>",
      4: stream("/Type /XObject /Subtype /Image /Width 5000 /Height 5000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", fakeJpeg("unused")),
      5: stream("/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /Logo 6 0 R /Scan 7 0 R >> >>", "q 50 0 0 50 0 0 cm /Logo Do Q q 612 0 0 792 0 0 cm /Scan Do Q"),
      6: stream("/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", fakeJpeg("logo")),
      7: stream("/Type /XObject /Subtype /Image /Width 1700 /Height 2200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", fakeJpeg("scan")),
      9: stream("", "BI /W 1 /H 1 /CS /G /BPC 8 ID \x00\xff EI q /Fm0 Do Q"),
    });
    const [img] = pdfPageImages(doc, undefined, LIMITS).images;
    expect(img!.data).toEqual(fakeJpeg("scan"));
  });

  it("skips pages it can't convert, with the reason, and splits long scans into parts", () => {
    const pages = [3, 6, 9, 12];
    const doc = pdf({
      ...catalog(pages),
      3: scanPage(4, 5),
      4: stream("/Type /XObject /Subtype /Image /Width 2480 /Height 3508 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode", "jbig2"),
      5: drawIm0,
      6: "<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>",
      8: stream("", "BT ET"),
      9: scanPage(10, 11),
      10: stream("/Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", fakeJpeg("p3")),
      11: drawIm0,
      12: scanPage(13, 14),
      13: stream("/Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", fakeJpeg("p4")),
      14: drawIm0,
    });
    const first = pdfPageImages(doc, undefined, { ...LIMITS, maxImages: 1 });
    expect(first).toMatchObject({ page_count: 4, pages_returned: "1-3", next_pages: "4" });
    expect(first.images.map((i) => i.page)).toEqual([3]);
    expect(first.skipped).toEqual([
      { page: 1, reason: expect.stringMatching(/JBIG2 compression/) },
      { page: 2, reason: "no image on this page" },
    ]);
    expect(pdfPageImages(doc, "4", LIMITS)).toMatchObject({ pages_returned: "4", next_pages: null, images: [{ page: 4 }] });

    // A single image over the per-image limit is skipped, not sent.
    expect(pdfPageImages(doc, "3", { ...LIMITS, maxImageBytes: 4 }).skipped).toEqual([{ page: 3, reason: expect.stringMatching(/over the .* MB limit/) }]);
    // The total budget stops before the image that would cross it (the first image always goes).
    expect(pdfPageImages(doc, "3-4", { ...LIMITS, maxBytes: 12 })).toMatchObject({ pages_returned: "3", next_pages: "4" });
    expect(() => pdfPageImages(doc, "9", LIMITS)).toThrow(/has 4 pages/);
  });

  it("refuses to convert an image whose declared size would take too much memory, without allocating it", () => {
    // 7000x7000 CMYK would need ~187 MB of pixels; the stream itself is tiny.
    const doc = pdf({
      ...catalog([3]),
      3: scanPage(4, 5),
      4: stream("/Type /XObject /Subtype /Image /Width 7000 /Height 7000 /ColorSpace /DeviceCMYK /BitsPerComponent 8", Buffer.alloc(16), true),
      5: drawIm0,
    });
    const got = pdfPageImages(doc, undefined, LIMITS);
    expect(got.images).toEqual([]);
    expect(got.skipped).toEqual([{ page: 1, reason: expect.stringMatching(/7000x7000 pixels, too large to convert/) }]);
  });
});
