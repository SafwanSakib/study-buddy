// Add / delete pages in a deck's PDF (pdf-lib), and keep annotations on the right pages.

export const TEMPLATES = {
  blank: 'Blank',
  lined: 'Lined',
  grid: 'Grid',
  dots: 'Dotted',
};

function drawTemplate(page, template, { rgb }) {
  const { width: w, height: h } = page.getSize();
  if (template === 'lined') {
    const gap = Math.max(18, w / 34);
    const top = gap * 2.5;
    for (let y = h - top; y > gap; y -= gap) {
      page.drawLine({ start: { x: 0, y }, end: { x: w, y }, thickness: 0.6, color: rgb(0.68, 0.79, 0.93) });
    }
    const mx = Math.max(40, w * 0.08);
    page.drawLine({ start: { x: mx, y: 0 }, end: { x: mx, y: h }, thickness: 0.8, color: rgb(0.93, 0.55, 0.55) });
  } else if (template === 'grid') {
    const gap = Math.max(12, w / 48);
    const color = rgb(0.82, 0.84, 0.88);
    for (let x = gap; x < w; x += gap) page.drawLine({ start: { x, y: 0 }, end: { x, y: h }, thickness: 0.4, color });
    for (let y = h - gap; y > 0; y -= gap) page.drawLine({ start: { x: 0, y }, end: { x: w, y }, thickness: 0.4, color });
  } else if (template === 'dots') {
    const gap = Math.max(12, w / 40);
    const color = rgb(0.62, 0.65, 0.7);
    for (let x = gap; x < w; x += gap) {
      for (let y = h - gap; y > 0; y -= gap) page.drawCircle({ x, y, size: 0.9, color });
    }
  }
}

async function loadDoc(bytes) {
  const lib = await import('pdf-lib');
  let doc;
  try {
    doc = await lib.PDFDocument.load(bytes);
  } catch (e) {
    if (/encrypt/i.test(e.message)) {
      throw new Error('This PDF is password-protected/encrypted, so pages can’t be added or removed.');
    }
    throw e;
  }
  return { lib, doc };
}

/**
 * Insert a page. `at` = 1-based number the new page will have. size = [w, h] in PDF points.
 * Returns new PDF bytes.
 */
export async function insertPage(bytes, at, size, template) {
  const { lib, doc } = await loadDoc(bytes);
  const page = doc.insertPage(at - 1, size);
  drawTemplate(page, template, lib);
  return doc.save();
}

/** Remove page number `num` (1-based). Returns new PDF bytes. */
export async function removePage(bytes, num) {
  const { doc } = await loadDoc(bytes);
  if (doc.getPageCount() <= 1) throw new Error('A deck needs at least one page.');
  doc.removePage(num - 1);
  return doc.save();
}

/** Shift annotation page keys after inserting a page at `at`. */
export function shiftForInsert(pages, at) {
  const out = {};
  for (const [k, v] of Object.entries(pages)) {
    const n = Number(k);
    out[n >= at ? n + 1 : n] = v;
  }
  return out;
}

/** Drop annotations of page `num` and shift the following pages up. */
export function shiftForRemove(pages, num) {
  const out = {};
  for (const [k, v] of Object.entries(pages)) {
    const n = Number(k);
    if (n === num) continue;
    out[n > num ? n - 1 : n] = v;
  }
  return out;
}
