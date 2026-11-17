// Tiny IndexedDB wrapper for offline use.
// Stores: pdfs (deck PDFs), ann (annotations + unsynced edits), lists (folder listings), thumbs, kv (misc).
// Every call fails soft: if storage is unavailable (private mode, quota) the app still works online.

const DB_NAME = 'study-buddy';
const STORES = ['pdfs', 'ann', 'lists', 'thumbs', 'kv'];
const MAX_PDF_BYTES = 400 * 1024 * 1024; // keep the PDF cache under ~400 MB

let dbPromise = null;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const result = fn(t.objectStore(store));
        t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export async function cget(store, key) {
  try { return await tx(store, 'readonly', (s) => s.get(key)); } catch { return undefined; }
}
export async function cset(store, key, value) {
  try { await tx(store, 'readwrite', (s) => s.put(value, key)); } catch (e) { console.warn('cache write failed', e); }
}
export async function cdel(store, key) {
  try { await tx(store, 'readwrite', (s) => s.delete(key)); } catch {}
}
async function centries(store) {
  try {
    return await tx(store, 'readonly', (s) => {
      const out = [];
      s.openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push([c.key, c.value]); c.continue(); }
      };
      return out;
    });
  } catch { return []; }
}

/** Save a deck PDF for offline use, evicting least-recently-used PDFs above the size budget. */
export async function cachePdf(deckId, entry) {
  await cset('pdfs', deckId, { ...entry, usedAt: Date.now() });
  const all = (await centries('pdfs')).sort((a, b) => b[1].usedAt - a[1].usedAt);
  let total = 0;
  for (const [key, v] of all) {
    total += v.bytes?.byteLength || 0;
    if (total > MAX_PDF_BYTES && key !== deckId) await cdel('pdfs', key);
  }
}

export async function forgetDeck(deckId) {
  await Promise.all(['pdfs', 'ann', 'thumbs'].map((s) => cdel(s, deckId)));
}

/** Remove everything stored on this device (used on sign-out). */
export async function clearAll() {
  try {
    (await dbPromise)?.close();
  } catch {}
  dbPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
