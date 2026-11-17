// Flatten annotations into a copy of the PDF. Each annotated page gets a transparent PNG
// layer rendered at high resolution, so any language/emoji in notes is preserved exactly.
import { PDFDocument, degrees } from 'pdf-lib';
import { drawItems } from './annotations.js';

const EXPORT_PX_PER_PT = 2.5; // ~180 dpi

export async function exportAnnotatedPdf(pdfBytes, pdfjsDoc, annPages) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();

  for (const [key, items] of Object.entries(annPages)) {
    if (!items?.length) continue;
    const idx = Number(key) - 1;
    const page = pages[idx];
    if (!page) continue;

    // pdf.js viewport = page as displayed (rotation applied), matching how annotations were drawn.
    const vp = (await pdfjsDoc.getPage(idx + 1)).getViewport({ scale: 1 });
    const W = Math.round(vp.width * EXPORT_PX_PER_PT);
    const H = Math.round(vp.height * EXPORT_PX_PER_PT);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    drawItems(canvas.getContext('2d'), items, W, H);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const png = await doc.embedPng(await blob.arrayBuffer());

    const box = page.getCropBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    // Image is upright in display orientation; pre-rotate it so the viewer's /Rotate cancels out.
    const dispW = rot % 180 ? box.height : box.width;
    const dispH = rot % 180 ? box.width : box.height;
    const place = {
      0: { x: box.x, y: box.y },
      90: { x: box.x + box.width, y: box.y },
      180: { x: box.x + box.width, y: box.y + box.height },
      270: { x: box.x, y: box.y + box.height },
    }[rot] || { x: box.x, y: box.y };
    page.drawImage(png, { ...place, width: dispW, height: dispH, rotate: degrees(rot) });
  }
  return doc.save();
}
