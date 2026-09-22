const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFDict, PDFRef } = require('pdf-lib');

/**
 * Returns { pages, hasColor } for a PDF file.
 *
 * pages: exact count via pdf-lib.
 *
 * hasColor: real detection, not a filename guess or a scan of unused
 * declarations. Two checks, both restricted to content actually painted
 * on the page (not just present somewhere in the file):
 *
 *  1. Vector/text paint operators in each page's decompressed content
 *     stream: `rg`/`RG` (RGB) or `k`/`K` (CMYK) where the values aren't
 *     gray (equal RGB channels, or zero CMY).
 *  2. Embedded images that are actually drawn on the page (referenced via
 *     a `Do` operator, not just sitting unused in a resource dictionary):
 *     checks each such image's declared ColorSpace for DeviceRGB/
 *     DeviceCMYK/multi-channel ICC/Indexed-with-color-palette.
 *
 * Known limitation: for images, this checks the declared color space, not
 * actual pixel content — an RGB-encoded image that happens to contain only
 * gray pixels (common with some scanners) can still be flagged. True
 * pixel-level detection would need decoding+rendering the image data,
 * which is a much heavier operation; this heuristic favors not missing
 * real color content over being pixel-perfect on edge cases.
 */
async function getPdfInfo(filePath) {
  const bytes = await fs.readFile(filePath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPageCount();

  const hasColor = scanPagesForColor(pdfDoc);

  return { pages, hasColor };
}

function scanPagesForColor(pdfDoc) {
  for (const page of pdfDoc.getPages()) {
    const streams = getContentStreams(pdfDoc, page);
    let combined = '';
    for (const stream of streams) {
      const decoded = decodeStream(stream, pdfDoc.context);
      if (decoded) combined += Buffer.from(decoded).toString('latin1') + '\n';
    }
    if (!combined) continue;

    if (streamHasColorOps(combined)) return true;
    if (pageHasColorImage(pdfDoc, page, combined)) return true;
  }
  return false;
}

function getContentStreams(pdfDoc, page) {
  const dict = page.node;
  let contents = dict.get(PDFName.of('Contents'));
  contents = pdfDoc.context.lookup(contents);

  const streams = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = pdfDoc.context.lookup(contents.get(i));
      if (s instanceof PDFRawStream) streams.push(s);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams;
}

function decodeStream(stream, context) {
  let data = stream.contents;

  const filterEntry = stream.dict.get(PDFName.of('Filter'));
  const resolvedFilter = filterEntry ? context.lookup(filterEntry) : undefined;
  const filters = [];
  if (resolvedFilter instanceof PDFName) {
    filters.push(resolvedFilter.asString());
  } else if (resolvedFilter instanceof PDFArray) {
    for (let i = 0; i < resolvedFilter.size(); i++) {
      const f = context.lookup(resolvedFilter.get(i));
      if (f instanceof PDFName) filters.push(f.asString());
    }
  }

  for (const filter of filters) {
    if (filter === '/FlateDecode' || filter === 'FlateDecode') {
      try {
        data = zlib.inflateSync(Buffer.from(data));
      } catch {
        return null;
      }
    }
  }

  return data;
}

function streamHasColorOps(text) {
  const rgbOps = text.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(rg|RG)\b/g) || [];
  for (const op of rgbOps) {
    const [r, g, b] = op.trim().split(/\s+/).slice(0, 3).map(Number);
    if (r !== g || g !== b) return true;
  }

  const cmykOps = text.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(k|K)\b/g) || [];
  for (const op of cmykOps) {
    const [c, m, y] = op.trim().split(/\s+/).slice(0, 3).map(Number);
    if (c !== 0 || m !== 0 || y !== 0) return true;
  }

  // `scn`/`SCN`/`sc`/`SC` are the general "set color" operators (the `n`
  // variants add pattern/separation support; both are common in real PDFs
  // — many producers use the plain `sc`/`SC` form even for straightforward
  // RGB/CMYK colors). Operand count tells us which color model is in
  // play: 3 numbers is RGB-like, 4 is CMYK-like. A lone number
  // (grayscale, or a spot-color tint with a colorant name following) is
  // left unflagged to avoid false positives on plain gray fills.
  const scnOps = text.match(/((?:-?[\d.]+\s+){3,4})(scn|SCN|sc|SC)\b/g) || [];
  for (const op of scnOps) {
    const nums = op.trim().split(/\s+/).slice(0, -1).map(Number);
    if (nums.length === 3) {
      const [r, g, b] = nums;
      if (r !== g || g !== b) return true;
    } else if (nums.length === 4) {
      const [c, m, y] = nums;
      if (c !== 0 || m !== 0 || y !== 0) return true;
    }
  }

  return false;
}

// Finds image XObjects actually referenced via a `/Name Do` operator in
// this page's content, then checks each one's declared color space.
function pageHasColorImage(pdfDoc, page, contentText) {
  const usedNames = new Set();
  const doMatches = contentText.match(/\/([A-Za-z0-9#_.+-]+)\s+Do\b/g) || [];
  for (const m of doMatches) {
    const name = m.match(/\/([A-Za-z0-9#_.+-]+)\s+Do\b/)[1];
    usedNames.add(name);
  }
  if (usedNames.size === 0) return false;

  const resources = pdfDoc.context.lookup(page.node.get(PDFName.of('Resources')));
  if (!(resources instanceof PDFDict)) return false;

  const xObjectDict = pdfDoc.context.lookup(resources.get(PDFName.of('XObject')));
  if (!(xObjectDict instanceof PDFDict)) return false;

  for (const name of usedNames) {
    const ref = xObjectDict.get(PDFName.of(name));
    const xObject = pdfDoc.context.lookup(ref);
    if (!(xObject instanceof PDFRawStream)) continue;

    const subtype = xObject.dict.get(PDFName.of('Subtype'));
    const subtypeName = subtype instanceof PDFName ? subtype.asString() : '';
    if (subtypeName !== '/Image') continue;

    if (imageColorSpaceIsColor(pdfDoc, xObject.dict)) return true;
  }

  return false;
}

function imageColorSpaceIsColor(pdfDoc, imageDict) {
  const csEntry = imageDict.get(PDFName.of('ColorSpace'));
  if (!csEntry) return false;
  const cs = pdfDoc.context.lookup(csEntry);
  return colorSpaceIsColor(pdfDoc, cs);
}

function colorSpaceIsColor(pdfDoc, cs) {
  if (cs instanceof PDFName) {
    const name = cs.asString();
    if (name === '/DeviceGray' || name === '/CalGray') return false;
    if (name === '/DeviceRGB' || name === '/DeviceCMYK' || name === '/CalRGB' || name === '/Lab') return true;
    return false;
  }
  if (cs instanceof PDFArray && cs.size() > 0) {
    const family = pdfDoc.context.lookup(cs.get(0));
    const familyName = family instanceof PDFName ? family.asString() : '';

    if (familyName === '/ICCBased' && cs.size() > 1) {
      const streamRef = cs.get(1);
      const stream = pdfDoc.context.lookup(streamRef);
      if (stream instanceof PDFRawStream) {
        const n = stream.dict.get(PDFName.of('N'));
        const nVal = n && n.asNumber ? n.asNumber() : null;
        if (nVal != null) return nVal > 1;
      }
      return false;
    }

    if (familyName === '/Indexed' && cs.size() > 1) {
      const baseSpace = pdfDoc.context.lookup(cs.get(1));
      return colorSpaceIsColor(pdfDoc, baseSpace);
    }

    if (familyName === '/DeviceN' || familyName === '/Separation') {
      // Spot colors: could be a gray-only "black" separation or a true
      // color plate. Treat as color to be safe rather than risk a false
      // negative on process-color separations.
      return true;
    }
  }
  return false;
}

module.exports = { getPdfInfo };
