// Deck thumbnails: render page 1 to a small JPEG, keep it on this device (IndexedDB)
// and in Drive (_annotations/<deckId>.jpg) so other devices can show it without downloading the PDF.
import { openPdf } from './pdf.js';
import { cget, cset } from './cache.js';
import { saveThumb } from './drive.js';

const WIDTH = 360;

/** Render page 1 of a pdf.js document (or raw PDF bytes) to a JPEG blob. */
export async function renderThumb(source) {
  let doc = source;
  let own = false;
  if (!(source && typeof source.getPage === 'function')) {
    const data = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : new Uint8Array(source.slice(0));
    doc = await openPdf(data);
    own = true;
  }
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: WIDTH / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
  } finally {
    if (own) doc.loadingTask.destroy().catch(() => {});
  }
}

/** Store a thumbnail locally and (in the background) in Drive. */
export async function rememberThumb(deckId, md5, blob) {
  if (!blob) return;
  await cset('thumbs', deckId, { md5: md5 || '', blob });
  if (navigator.onLine) saveThumb(deckId, md5 || '', blob).catch((e) => console.warn('thumb upload failed', e));
}

/** Make + remember a thumbnail unless we already have one for this version of the deck. */
export async function ensureThumb(deckId, md5, source) {
  const have = await cget('thumbs', deckId);
  if (have?.blob && (!md5 || have.md5 === md5)) {
    // Make sure Drive has it too (e.g. the thumb was made offline).
    if (navigator.onLine) saveThumb(deckId, have.md5, have.blob).catch(() => {});
    return;
  }
  try {
    await rememberThumb(deckId, md5, await renderThumb(source));
  } catch (e) {
    console.warn('thumbnail failed', e);
  }
}

export async function cachedThumb(deckId) {
  return (await cget('thumbs', deckId)) || null;
}
