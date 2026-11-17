// Thin Google Drive v3 REST client (no gapi needed).
//
// Drive layout (mirrors the website):
//   Study Buddy/                      ← root   (appProperties studybuddy=root)
//   ├── Semester 1/                   ← folder (studybuddy=folder), can be nested
//   │   └── Lecture 1.pdf             ← deck   (studybuddy=deck)
//   ├── Lecture 2.pdf
//   └── _annotations/                 ← hidden from the website (studybuddy=annfolder)
//       └── <deck name> — annotations.json   (studybuddy=annotations, deck=<deckId>)
import { getToken, markExpired, AuthExpiredError } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ITEM_FIELDS = 'id,name,mimeType,modifiedTime,size,md5Checksum,thumbnailLink,webViewLink,appProperties,parents';

export class OfflineError extends Error {
  constructor() {
    super('You are offline.');
    this.name = 'OfflineError';
  }
}
export const isOfflineError = (e) => e instanceof OfflineError;

async function api(url, opts = {}) {
  if (!navigator.onLine) throw new OfflineError();
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${getToken()}`, ...(opts.headers || {}) },
    });
  } catch (e) {
    if (e instanceof AuthExpiredError) throw e;
    throw new OfflineError(); // network failure
  }
  if (res.status === 401) {
    markExpired();
    throw new AuthExpiredError();
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body.error?.message || msg;
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

const q = (params) => new URLSearchParams(params).toString();
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const jsonHeaders = { 'Content-Type': 'application/json' };

export async function getUserInfo() {
  const res = await api('https://www.googleapis.com/oauth2/v3/userinfo');
  return res.json();
}

async function findOne(query, fields = 'id,name') {
  const res = await api(`${API}/files?${q({ q: query, fields: `files(${fields})`, pageSize: 1, spaces: 'drive' })}`);
  return (await res.json()).files[0] || null;
}

async function listAll(query, orderBy = 'name') {
  const files = [];
  let pageToken;
  do {
    const res = await api(
      `${API}/files?${q({
        q: query,
        fields: `nextPageToken,files(${ITEM_FIELDS})`,
        orderBy,
        pageSize: 500,
        spaces: 'drive',
        ...(pageToken ? { pageToken } : {}),
      })}`
    );
    const body = await res.json();
    files.push(...body.files);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

async function createFolderRaw(name, parentId, kind) {
  const res = await api(`${API}/files?fields=${ITEM_FIELDS}`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
      appProperties: { studybuddy: kind },
    }),
  });
  return res.json();
}

let rootFolderPromise = null;
export function ensureRootFolder() {
  rootFolderPromise ||= (async () => {
    const existing = await findOne(
      `mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='studybuddy' and value='root' }`
    );
    return existing ? existing.id : (await createFolderRaw('Study Buddy', null, 'root')).id;
  })().catch((e) => {
    rootFolderPromise = null;
    throw e;
  });
  return rootFolderPromise;
}

let annFolderPromise = null;
function ensureAnnotationsFolder() {
  annFolderPromise ||= (async () => {
    const root = await ensureRootFolder();
    const existing = await findOne(
      `mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='studybuddy' and value='annfolder' }`
    );
    return existing ? existing.id : (await createFolderRaw('_annotations', root, 'annfolder')).id;
  })().catch((e) => {
    annFolderPromise = null;
    throw e;
  });
  return annFolderPromise;
}

// ---------- Library: folders & decks ----------

const IS_ITEM = `(appProperties has { key='studybuddy' and value='deck' } or appProperties has { key='studybuddy' and value='folder' })`;

/** Folders and decks directly inside a folder (root if folderId is null). */
export async function listChildren(folderId) {
  const parent = folderId || (await ensureRootFolder());
  const items = await listAll(`'${esc(parent)}' in parents and trashed=false and ${IS_ITEM}`, 'modifiedTime desc');
  const folders = items.filter((f) => f.mimeType === FOLDER_MIME).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const decks = items.filter((f) => f.mimeType !== FOLDER_MIME);
  return { folders, decks };
}

/** Every Study Buddy folder (for breadcrumbs and the "Move to" picker). */
export async function listAllFolders() {
  return listAll(`mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='studybuddy' and value='folder' }`);
}

export async function searchDecks(term) {
  return listAll(
    `trashed=false and name contains '${esc(term)}' and appProperties has { key='studybuddy' and value='deck' }`,
    'modifiedTime desc'
  );
}

export async function createFolder(name, parentId) {
  return createFolderRaw(name, parentId || (await ensureRootFolder()), 'folder');
}

export async function renameFile(id, name) {
  await updateMeta(id, { name });
}

export async function moveFile(id, toFolderId) {
  const target = toFolderId || (await ensureRootFolder());
  const meta = await (await api(`${API}/files/${id}?fields=parents`)).json();
  const remove = (meta.parents || []).filter((p) => p !== target).join(',');
  await api(`${API}/files/${id}?${q({ addParents: target, ...(remove ? { removeParents: remove } : {}), fields: 'id' })}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: '{}',
  });
}

export async function getFileMeta(id) {
  const res = await api(`${API}/files/${id}?fields=${ITEM_FIELDS},trashed`);
  return res.json();
}

export async function updateMeta(id, meta) {
  await api(`${API}/files/${id}?fields=id`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(meta) });
}

export async function trashFile(id) {
  await updateMeta(id, { trashed: true });
}

export async function downloadFile(id, onProgress) {
  const res = await api(`${API}/files/${id}?alt=media`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !total || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

async function resumable(initUrl, method, metadata, blob, onProgress) {
  const init = await api(initUrl, {
    method,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': blob.type || 'application/octet-stream',
    },
    body: JSON.stringify(metadata),
  });
  const location = init.headers.get('Location');
  if (!location) throw new Error('Upload could not be started (no upload URL returned).');

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', location);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else {
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error?.message || msg; } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(blob);
  });
}

/** Resumable upload (works for large files) with progress. Returns created file resource. */
export function uploadFile(blob, metadata, onProgress) {
  return resumable(`${UPLOAD}/files?uploadType=resumable&fields=${ITEM_FIELDS}`, 'POST', metadata, blob, onProgress);
}

/** Replace the contents of an existing file (same id, so annotations stay linked). */
export function replaceFileContent(id, blob, onProgress) {
  return resumable(`${UPLOAD}/files/${id}?uploadType=resumable&fields=${ITEM_FIELDS}`, 'PATCH', {}, blob, onProgress);
}

// ---------- Name clashes ----------

const norm = (n) => n.trim().toLowerCase();

/** Existing folder/deck in `parentId` (root if null) with the same name (case-insensitive), or null. */
export async function findSameName(parentId, name, { folder = false, excludeId = null } = {}) {
  const { folders, decks } = await listChildren(parentId);
  return (folder ? folders : decks).find((f) => f.id !== excludeId && norm(f.name) === norm(name)) || null;
}

/** "Lecture 1.pdf" → "Lecture 1 (2).pdf" (first free number in that folder). */
export async function uniqueName(parentId, name, { folder = false } = {}) {
  const { folders, decks } = await listChildren(parentId);
  const taken = new Set((folder ? folders : decks).map((f) => norm(f.name)));
  const ext = folder ? '' : '.pdf';
  const base = name.replace(/\.pdf$/i, '').replace(/ \(\d+\)$/, '');
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(norm(candidate))) return candidate;
  }
}

const CONVERT = {
  ppt: 'application/vnd.google-apps.presentation',
  pptx: 'application/vnd.google-apps.presentation',
  odp: 'application/vnd.google-apps.presentation',
  doc: 'application/vnd.google-apps.document',
  docx: 'application/vnd.google-apps.document',
  odt: 'application/vnd.google-apps.document',
};

export function isSupported(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  return ext === 'pdf' || file.type === 'application/pdf' || ext in CONVERT;
}

/** Saves a PDF as a deck in the given folder (root if null). */
export async function saveDeckPdf(blob, name, folderId, onProgress) {
  const parent = folderId || (await ensureRootFolder());
  return uploadFile(
    blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }),
    { name, mimeType: 'application/pdf', parents: [parent], appProperties: { studybuddy: 'deck' } },
    onProgress
  );
}

/** The deck name a file will get after upload ("Slides.pptx" → "Slides.pdf"). */
export function deckNameFor(file) {
  return `${file.name.replace(/\.[^.]+$/, '')}.pdf`;
}

/**
 * Uploads a PDF directly, or converts PowerPoint/Word to PDF using Google Drive
 * (upload as Google Slides/Docs → export PDF → delete the temporary copy).
 * Options: name (final deck name), replaceId (overwrite that deck's PDF instead of creating a new one).
 */
export async function uploadDeck(file, { folderId, name, replaceId, onProgress, onStage } = {}) {
  const parent = folderId || (await ensureRootFolder());
  const ext = file.name.split('.').pop().toLowerCase();
  const finalName = name || deckNameFor(file);
  let pdfBlob = file;
  let progressBase = 0;

  if (ext !== 'pdf' && file.type !== 'application/pdf') {
    const target = CONVERT[ext];
    if (!target) throw new Error(`Unsupported file type: .${ext}`);
    onStage?.('Uploading');
    const tmp = await uploadFile(file, { name: finalName.replace(/\.pdf$/i, ''), mimeType: target, parents: [parent] }, (p) => onProgress?.(p * 0.6));
    try {
      onStage?.('Converting to PDF');
      onProgress?.(0.65);
      const res = await api(`${API}/files/${tmp.id}/export?mimeType=application/pdf`);
      pdfBlob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
    } catch (e) {
      if (e.status === 403 || /too large/i.test(e.message)) {
        throw new Error('This file is too large for automatic conversion. Export it as PDF from PowerPoint and upload the PDF instead.');
      }
      throw e;
    } finally {
      api(`${API}/files/${tmp.id}`, { method: 'DELETE' }).catch(() => {});
    }
    onStage?.('Saving PDF');
    progressBase = 0.7;
  } else {
    onStage?.(replaceId ? 'Replacing' : 'Uploading');
  }
  const prog = (p) => onProgress?.(progressBase + p * (1 - progressBase));
  const blob = pdfBlob.type === 'application/pdf' ? pdfBlob : new Blob([pdfBlob], { type: 'application/pdf' });
  const created = replaceId ? await replaceFileContent(replaceId, blob, prog) : await saveDeckPdf(blob, finalName, parent, prog);
  return { ...created, pdfBlob: blob };
}

// ---------- Annotations (JSON, kept in the hidden _annotations folder) ----------

const annName = (deckName) => `${deckName.replace(/\.pdf$/i, '')} — annotations.json`;

function findAnnotationsFile(deckId) {
  return findOne(
    `trashed=false and appProperties has { key='studybuddy' and value='annotations' } and appProperties has { key='deck' and value='${esc(deckId)}' }`,
    'id,name,parents'
  );
}

export async function loadAnnotations(deckId) {
  const file = await findAnnotationsFile(deckId);
  if (!file) return { fileId: null, data: null };
  // Tidy-up: older versions stored annotations next to the decks — move them into _annotations.
  ensureAnnotationsFolder()
    .then((annFolder) => {
      if (!file.parents?.includes(annFolder)) return moveFile(file.id, annFolder);
    })
    .catch(() => {});
  const res = await api(`${API}/files/${file.id}?alt=media`);
  let data = null;
  try { data = await res.json(); } catch {}
  return { fileId: file.id, data };
}

export async function saveAnnotations(deckId, deckName, fileId, data) {
  const body = JSON.stringify(data);
  if (fileId) {
    await api(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body,
      keepalive: body.length < 60_000,
    });
    return fileId;
  }
  const folder = await ensureAnnotationsFolder();
  const boundary = 'sb' + Math.random().toString(36).slice(2);
  const meta = {
    name: annName(deckName),
    mimeType: 'application/json',
    parents: [folder],
    appProperties: { studybuddy: 'annotations', deck: deckId },
  };
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  return (await res.json()).id;
}

/** Rename a deck (keeps .pdf) and its annotations file. Returns the new file name. */
export async function renameDeck(deckId, newBase) {
  const name = `${newBase.replace(/\.pdf$/i, '')}.pdf`;
  await renameFile(deckId, name);
  findAnnotationsFile(deckId)
    .then((f) => f && renameFile(f.id, annName(name)))
    .catch(() => {});
  return name;
}

export async function deleteAnnotationsFor(deckId) {
  const file = await findAnnotationsFile(deckId);
  if (file) await trashFile(file.id);
  const thumb = await findThumbFile(deckId);
  if (thumb) await trashFile(thumb.id);
}

// ---------- Stars & recents ----------

export async function setStarred(id, starred) {
  await updateMeta(id, { appProperties: { starred: starred ? '1' : null } });
}

/** All decks in every folder (for Starred / Recently opened). */
export function listAllDecks() {
  return listAll(`trashed=false and appProperties has { key='studybuddy' and value='deck' }`, 'modifiedTime desc');
}

// ---------- Thumbnails (small JPEGs in _annotations, so every device gets them) ----------

function findThumbFile(deckId) {
  return findOne(
    `trashed=false and appProperties has { key='studybuddy' and value='thumb' } and appProperties has { key='deck' and value='${esc(deckId)}' }`,
    'id,appProperties'
  );
}

/** Map deckId → { fileId, md5 } of every stored thumbnail. */
export async function listThumbs() {
  const files = await listAll(`trashed=false and appProperties has { key='studybuddy' and value='thumb' }`);
  return new Map(files.map((f) => [f.appProperties.deck, { fileId: f.id, md5: f.appProperties.md5 }]));
}

export async function downloadThumb(fileId) {
  const res = await api(`${API}/files/${fileId}?alt=media`);
  return res.blob();
}

export async function saveThumb(deckId, md5, blob) {
  const existing = await findThumbFile(deckId);
  if (existing?.appProperties?.md5 === md5) return;
  if (existing) {
    await replaceFileContent(existing.id, blob);
    await updateMeta(existing.id, { appProperties: { md5 } });
    return;
  }
  const folder = await ensureAnnotationsFolder();
  await uploadFile(blob, {
    name: `${deckId}.jpg`,
    mimeType: 'image/jpeg',
    parents: [folder],
    appProperties: { studybuddy: 'thumb', deck: deckId, md5 },
  });
}

// ---------- Import a file the user picked from their Drive (Google Picker) ----------

const GOOGLE_EXPORTABLE = new Set(['application/vnd.google-apps.presentation', 'application/vnd.google-apps.document']);
const OFFICE_TO_GOOGLE = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.google-apps.presentation',
  'application/vnd.ms-powerpoint': 'application/vnd.google-apps.presentation',
  'application/vnd.oasis.opendocument.presentation': 'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.google-apps.document',
  'application/msword': 'application/vnd.google-apps.document',
  'application/vnd.oasis.opendocument.text': 'application/vnd.google-apps.document',
};

/** Copy a picked Drive file into Study Buddy as a PDF deck (the original is left untouched). */
export async function importFromDrive({ id, mimeType, name }, folderId, finalName) {
  const parent = folderId || (await ensureRootFolder());
  const pdfName = finalName || `${name.replace(/\.[^.]+$/, '')}.pdf`;
  if (mimeType === 'application/pdf') {
    const res = await api(`${API}/files/${id}/copy?fields=${ITEM_FIELDS}`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: pdfName, parents: [parent], appProperties: { studybuddy: 'deck' } }),
    });
    return res.json();
  }
  let exportId = id;
  let tempId = null;
  if (!GOOGLE_EXPORTABLE.has(mimeType)) {
    const target = OFFICE_TO_GOOGLE[mimeType];
    if (!target) throw new Error('Only PDFs, PowerPoint, Word, Google Slides and Google Docs can be imported.');
    const res = await api(`${API}/files/${id}/copy?fields=id`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: pdfName.replace(/\.pdf$/i, ''), mimeType: target, parents: [parent] }),
    });
    exportId = tempId = (await res.json()).id;
  }
  try {
    const res = await api(`${API}/files/${exportId}/export?mimeType=application/pdf`);
    const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
    return await saveDeckPdf(blob, pdfName, parent);
  } catch (e) {
    if (e.status === 403 || /too large/i.test(e.message)) {
      throw new Error('This file is too large for automatic conversion. Export it as PDF first, then import the PDF.');
    }
    throw e;
  } finally {
    if (tempId) api(`${API}/files/${tempId}`, { method: 'DELETE' }).catch(() => {});
  }
}
