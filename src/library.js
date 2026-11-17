// Library screen: browse folders, upload, rename, move, delete — all mirrored in Google Drive.
// Also: Starred / Recently opened, thumbnails, import from Drive, and offline listings.
import {
  listChildren, listAllFolders, searchDecks, createFolder, renameFile, renameDeck, moveFile,
  uploadDeck, isSupported, trashFile, deleteAnnotationsFor, ensureRootFolder, FOLDER_MIME,
  findSameName, uniqueName, deckNameFor, listAllDecks, setStarred, listThumbs, downloadThumb,
  importFromDrive, isOfflineError,
} from './drive.js';
import { AuthExpiredError } from './auth.js';
import { cget, cset, forgetDeck } from './cache.js';
import { cachedThumb, ensureThumb } from './thumbs.js';
import { pickFromDrive, pickerConfigured } from './picker.js';
import { $, toast, escapeHtml, askText, confirmDialog, modal, para } from './ui.js';

let currentFolder = null; // null = Study Buddy root
let folders = [];
let decks = [];
let allDecks = []; // every deck (for Starred / Recently opened)
let allFolders = null; // cache: [{id,name,parents}]
let rootId = null;
let searchResults = null;
let searchTimer = null;
let loadSeq = 0;
let ready = false;
let offline = false;
let driveThumbs = null; // Map deckId → {fileId, md5} (thumbnails stored in Drive)
const thumbUrls = new Map(); // deckId → object URL

const isFolder = (item) => item.mimeType === FOLDER_MIME;
const isStarred = (item) => item.appProperties?.starred === '1';
const displayName = (item) => (isFolder(item) ? item.name : item.name.replace(/\.pdf$/i, ''));
const findItem = (id) => [...folders, ...decks, ...(searchResults || []), ...allDecks].find((x) => x.id === id);

export function currentLibraryHash() {
  return currentFolder ? `#/folder/${encodeURIComponent(currentFolder)}` : '#/';
}

function handleError(e, what) {
  if (e instanceof AuthExpiredError) return;
  if (isOfflineError(e)) return toast('You’re offline — this needs an internet connection.', 'error');
  console.error(e);
  toast(`${what}: ${e.message}`, 'error');
}

// ---------------- setup ----------------

function setup() {
  if (ready) return;
  ready = true;

  $('#file-input').onchange = (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  };
  $('#new-folder-btn').onclick = newFolder;
  $('#import-btn').onclick = importDialog;
  $('#search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  };

  // File drops from the computer
  const dz = $('#dropzone');
  const lib = $('#library');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  lib.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); dz.classList.add('over'); } });
  lib.addEventListener('dragleave', (e) => { if (!lib.contains(e.relatedTarget)) dz.classList.remove('over'); });
  lib.addEventListener('drop', (e) => {
    dz.classList.remove('over');
    if (!hasFiles(e)) return;
    e.preventDefault();
    handleFiles([...e.dataTransfer.files]);
  });

  // Card "⋯" menus (main grid and home sections)
  for (const el of [$('#deck-grid'), $('#home-sections')]) {
    el.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) {
        e.preventDefault();
        e.stopPropagation();
        openItemMenu(more, more.dataset.more);
      }
    });
  }

  // Drag a card onto a folder card or a breadcrumb to move it (desktop).
  const DND = 'application/x-studybuddy-item';
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.deck[data-id]');
    if (!card) return;
    e.dataTransfer.setData(DND, card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  document.addEventListener('dragend', () => document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging')));
  const dropTarget = (e) => e.target.closest?.('[data-drop]');
  document.addEventListener('dragover', (e) => {
    const t = dropTarget(e);
    if (!t || ![...e.dataTransfer.types].includes(DND)) return;
    e.preventDefault();
    document.querySelectorAll('.drop-over').forEach((el) => el !== t && el.classList.remove('drop-over'));
    t.classList.add('drop-over');
  });
  document.addEventListener('dragleave', (e) => dropTarget(e)?.classList.remove('drop-over'));
  document.addEventListener('drop', (e) => {
    const t = dropTarget(e);
    const id = e.dataTransfer?.getData(DND);
    document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
    if (!t || !id) return;
    e.preventDefault();
    const dest = t.dataset.drop === 'root' ? null : t.dataset.drop;
    if (dest === id) return;
    moveItem(id, dest);
  });

  document.addEventListener('click', closeItemMenu);
  window.addEventListener('online', () => !$('#library').hidden && showLibrary(currentFolder));
  window.addEventListener('offline', () => setOffline(true));
}

function setOffline(on) {
  offline = on;
  $('#offline-banner').hidden = !on;
}

// ---------------- loading ----------------

export async function showLibrary(folderId = null) {
  setup();
  const changed = folderId !== currentFolder;
  currentFolder = folderId;
  if (changed) {
    folders = [];
    decks = [];
    $('#search').value = '';
    searchResults = null;
  }
  const seq = ++loadSeq;
  const key = folderId || 'root';
  if (!folders.length && !decks.length) {
    // Show the last known listing instantly while we refresh.
    const cached = await cget('lists', key);
    if (seq !== loadSeq) return;
    if (cached) {
      ({ folders, decks } = cached);
      allFolders ||= (await cget('lists', 'allFolders')) || null;
      allDecks = allDecks.length ? allDecks : (await cget('lists', 'allDecks')) || [];
      render();
    } else $('#deck-grid').innerHTML = '<div class="muted center grid-wide">Loading…</div>';
  }
  renderCrumbs();
  try {
    const [children, root] = await Promise.all([
      listChildren(folderId),
      ensureRootFolder(),
      refreshFolders(),
      folderId ? null : refreshAllDecks(),
    ]);
    if (seq !== loadSeq) return;
    setOffline(false);
    rootId = root;
    folders = children.folders;
    decks = children.decks;
    cset('lists', key, { folders, decks });
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    if (isOfflineError(e)) {
      setOffline(true);
      if (!folders.length && !decks.length) {
        $('#deck-grid').innerHTML = '<div class="muted center grid-wide">You’re offline and this folder hasn’t been opened on this device yet.</div>';
      }
      return;
    }
    $('#deck-grid').innerHTML = '';
    if (e.status === 404) {
      toast('That folder no longer exists.', 'error');
      location.hash = '#/';
      return;
    }
    handleError(e, 'Could not load folder');
  }
}

async function refreshFolders() {
  try {
    allFolders = await listAllFolders();
    cset('lists', 'allFolders', allFolders);
  } catch (e) {
    allFolders ||= [];
    throw e;
  }
  renderCrumbs();
}

async function refreshAllDecks() {
  allDecks = await listAllDecks();
  cset('lists', 'allDecks', allDecks);
}

/** Path from root to folderId: [{id,name}, ...] */
function pathTo(folderId) {
  const byId = new Map((allFolders || []).map((f) => [f.id, f]));
  const path = [];
  let id = folderId;
  for (let guard = 0; id && byId.has(id) && guard < 50; guard++) {
    const f = byId.get(id);
    path.unshift({ id: f.id, name: f.name });
    id = f.parents?.[0];
  }
  return path;
}

// ---------------- rendering ----------------

function renderCrumbs() {
  const el = $('#crumbs');
  if (searchResults) {
    el.innerHTML = '<span class="crumb current">Search results</span>';
    return;
  }
  const parts = [{ id: 'root', name: 'My slides', href: '#/' }].concat(
    pathTo(currentFolder).map((f) => ({ id: f.id, name: f.name, href: `#/folder/${encodeURIComponent(f.id)}` }))
  );
  if (currentFolder && parts.length === 1) parts.push({ id: currentFolder, name: '…', href: '#' });
  el.innerHTML = parts
    .map((p, i) =>
      i === parts.length - 1
        ? `<span class="crumb current">${escapeHtml(p.name)}</span>`
        : `<a class="crumb" href="${p.href}" data-drop="${escapeHtml(p.id)}">${escapeHtml(p.name)}</a><span class="crumb-sep">›</span>`
    )
    .join('');
}

function folderCard(f) {
  return `<a class="deck folder-card" href="#/folder/${encodeURIComponent(f.id)}" data-id="${escapeHtml(f.id)}" data-drop="${escapeHtml(f.id)}" draggable="true">
      <div class="folder-icon">📁</div>
      <div class="deck-info"><div class="deck-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div></div>
      <button class="more-btn" data-more="${escapeHtml(f.id)}" title="Options" aria-label="Options">⋯</button>
    </a>`;
}

function deckCard(d, showPath, { draggable = true } = {}) {
  const name = escapeHtml(displayName(d));
  const date = new Date(d.modifiedTime).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const where = showPath ? pathTo(d.parents?.[0]).map((p) => p.name).join(' › ') || 'My slides' : '';
  return `<a class="deck" href="#/deck/${encodeURIComponent(d.id)}" data-id="${escapeHtml(d.id)}" draggable="${draggable}">
      <div class="thumb" data-thumb="${escapeHtml(d.id)}"><div class="thumb-fallback">PDF</div></div>
      ${isStarred(d) ? '<span class="star-badge" title="Starred">★</span>' : ''}
      <div class="deck-info">
        <div class="deck-name" title="${name}">${name}</div>
        <div class="deck-date">${showPath ? '📁 ' + escapeHtml(where) : date}</div>
      </div>
      <button class="more-btn" data-more="${escapeHtml(d.id)}" title="Options" aria-label="Options">⋯</button>
    </a>`;
}

function render() {
  renderCrumbs();
  renderHome();
  const grid = $('#deck-grid');
  if (searchResults) {
    const term = $('#search').value.trim().toLowerCase();
    const matchingFolders = (allFolders || []).filter((f) => f.name.toLowerCase().includes(term));
    grid.innerHTML = sections(matchingFolders.map(folderCard), searchResults.map((d) => deckCard(d, true)));
    $('#empty').hidden = true;
    if (!grid.innerHTML) grid.innerHTML = '<div class="muted center grid-wide">Nothing found.</div>';
  } else {
    grid.innerHTML = sections(folders.map(folderCard), decks.map((d) => deckCard(d, false)));
    $('#empty').hidden = folders.length + decks.length > 0;
  }
  hydrateThumbs();
}

/** "Starred" and "Recently opened" rows, shown on the top level only. */
function renderHome() {
  const el = $('#home-sections');
  if (currentFolder || searchResults) { el.innerHTML = ''; return; }
  const starred = allDecks.filter(isStarred);
  const recent = allDecks
    .filter((d) => d.appProperties?.lastOpened)
    .sort((a, b) => Number(b.appProperties.lastOpened) - Number(a.appProperties.lastOpened))
    .slice(0, 8);
  const row = (title, list) =>
    list.length
      ? `<section class="home-row"><h2>${title}</h2><div class="row-scroll">${list.map((d) => deckCard(d, true, { draggable: false })).join('')}</div></section>`
      : '';
  el.innerHTML = row('⭐ Starred', starred) + row('🕘 Recently opened', recent);
}

function sections(folderCards, deckCards) {
  return (
    (folderCards.length ? `<div class="folder-grid">${folderCards.join('')}</div>` : '') +
    (deckCards.length ? `<div class="cards-grid">${deckCards.join('')}</div>` : '')
  );
}

// ---------------- thumbnails ----------------

function setThumb(el, url) {
  const img = document.createElement('img');
  img.alt = '';
  img.src = url;
  el.replaceChildren(img);
}

async function hydrateThumbs() {
  const els = [...document.querySelectorAll('[data-thumb]')];
  if (!els.length) return;
  for (const el of els) {
    const url = thumbUrls.get(el.dataset.thumb);
    if (url) setThumb(el, url);
  }
  const missing = els.filter((el) => !thumbUrls.has(el.dataset.thumb));
  if (!missing.length) return;

  // 1) this device
  for (const el of missing) {
    const t = await cachedThumb(el.dataset.thumb);
    if (t?.blob) {
      thumbUrls.set(el.dataset.thumb, URL.createObjectURL(t.blob));
      setThumb(el, thumbUrls.get(el.dataset.thumb));
    }
  }
  const still = missing.filter((el) => !thumbUrls.has(el.dataset.thumb) && el.isConnected);
  if (!still.length || offline) return;

  // 2) thumbnails saved in Drive by another device
  try {
    driveThumbs ||= await listThumbs();
  } catch {
    driveThumbs = new Map();
  }
  for (const el of still) {
    const id = el.dataset.thumb;
    const t = driveThumbs.get(id);
    if (t) {
      try {
        const blob = await downloadThumb(t.fileId);
        await cset('thumbs', id, { md5: t.md5, blob });
        thumbUrls.set(id, URL.createObjectURL(blob));
        document.querySelectorAll(`[data-thumb="${CSS.escape(id)}"]`).forEach((x) => setThumb(x, thumbUrls.get(id)));
        continue;
      } catch {}
    }
    // 3) Google's own thumbnail (works when the browser is signed in to Google)
    const deck = findItem(id);
    if (deck?.thumbnailLink) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      img.onload = () => el.replaceChildren(img);
      img.src = deck.thumbnailLink;
    }
  }
}

async function runSearch() {
  const term = $('#search').value.trim();
  if (!term) {
    searchResults = null;
    render();
    return;
  }
  try {
    const res = await searchDecks(term);
    if ($('#search').value.trim() !== term) return;
    searchResults = res;
    render();
  } catch (e) {
    if (isOfflineError(e)) {
      // Offline: search what we know about.
      const t = term.toLowerCase();
      const known = new Map([...allDecks, ...decks].map((d) => [d.id, d]));
      searchResults = [...known.values()].filter((d) => d.name.toLowerCase().includes(t));
      render();
      return;
    }
    handleError(e, 'Search failed');
  }
}

// ---------------- import from Google Drive ----------------

async function importDialog() {
  if (!pickerConfigured()) {
    const body = document.createElement('div');
    body.innerHTML = `<p>To pick files that are already in your Google Drive, Study Buddy needs a Google API key (free):</p>
      <ol class="setup-steps">
        <li>In Google Cloud Console → <b>APIs &amp; Services → Library</b>, enable <b>Google Picker API</b>.</li>
        <li><b>Credentials → Create credentials → API key</b>. Restrict it to <i>Google Picker API</i> and your website addresses.</li>
        <li>Add <code>VITE_GOOGLE_API_KEY=…</code> to your <code>.env</code> file and restart / rebuild.</li>
      </ol>`;
    await modal({ title: 'Import from Google Drive', body, buttons: [{ label: 'OK', value: true, primary: true }] });
    return;
  }
  if (offline || !navigator.onLine) return toast('Importing needs an internet connection.', 'error');
  let docs;
  try {
    docs = await pickFromDrive();
  } catch (e) {
    return handleError(e, 'Could not open Google Drive picker');
  }
  if (!docs.length) return;
  const folderAtStart = currentFolder;
  for (const doc of docs) {
    const row = uploadRow(`${doc.name}`, 'Importing…');
    try {
      let name = `${doc.name.replace(/\.(pdf|pptx?|odp|docx?|odt)$/i, '')}.pdf`;
      if (await findSameName(folderAtStart, name)) name = await uniqueName(folderAtStart, name);
      const created = await importFromDrive(doc, folderAtStart, name);
      row.done(name === `${doc.name.replace(/\.(pdf|pptx?|odp|docx?|odt)$/i, '')}.pdf` ? 'Imported ✓' : `Imported as “${name.replace(/\.pdf$/i, '')}” ✓`);
      if (currentFolder === folderAtStart && !searchResults) {
        decks.unshift({ ...created, modifiedTime: created.modifiedTime || new Date().toISOString() });
        render();
      }
    } catch (e) {
      row.fail(isOfflineError(e) ? 'You’re offline' : e.message);
    }
  }
}

function uploadRow(name, stage) {
  const row = document.createElement('div');
  row.className = 'upload-row';
  row.innerHTML = `<span class="upload-name">${escapeHtml(name)}</span><span class="upload-stage">${escapeHtml(stage)}</span><div class="bar"><div class="fill indeterminate"></div></div>`;
  $('#uploads').appendChild(row);
  return {
    done(msg) {
      row.querySelector('.upload-stage').textContent = msg;
      row.querySelector('.fill').className = 'fill';
      row.querySelector('.fill').style.width = '100%';
      setTimeout(() => row.remove(), 2500);
    },
    fail(msg) {
      row.classList.add('failed');
      row.querySelector('.upload-stage').textContent = `Failed: ${msg}`;
      row.querySelector('.fill').className = 'fill';
      row.onclick = () => row.remove();
      row.title = 'Click to dismiss';
    },
  };
}

// ---------------- item menu ----------------

let menuEl = null;
function closeItemMenu() {
  menuEl?.remove();
  menuEl = null;
}

function openItemMenu(anchor, id) {
  closeItemMenu();
  const item = findItem(id);
  if (!item) return;
  menuEl = document.createElement('div');
  menuEl.className = 'menu item-menu';
  menuEl.innerHTML = `
    ${isFolder(item) ? '' : `<button data-act="star">${isStarred(item) ? '★ Unstar' : '☆ Star'}</button>`}
    <button data-act="rename">✏️ Rename</button>
    <button data-act="move">📂 Move to…</button>
    ${isFolder(item) ? '' : '<button data-act="drive">↗ Open in Google Drive</button>'}
    <button data-act="delete" class="danger">🗑 Delete</button>`;
  document.body.appendChild(menuEl);
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))}px`;
  menuEl.style.top = `${r.bottom + mh + 4 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
  menuEl.onclick = (e) => {
    e.stopPropagation();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeItemMenu();
    if (act === 'star') toggleStar(item);
    else if (act === 'rename') renameItem(item);
    else if (act === 'move') pickAndMove(item);
    else if (act === 'drive') window.open(item.webViewLink, '_blank', 'noopener');
    else if (act === 'delete') deleteItem(item);
  };
}

// ---------------- actions ----------------

async function toggleStar(item) {
  const next = !isStarred(item);
  try {
    await setStarred(item.id, next);
    for (const d of [...folders, ...decks, ...allDecks, ...(searchResults || [])]) {
      if (d.id === item.id) d.appProperties = { ...(d.appProperties || {}), starred: next ? '1' : undefined };
    }
    if (next && !allDecks.some((d) => d.id === item.id)) allDecks.push(item);
    render();
    toast(next ? 'Starred.' : 'Removed from starred.');
  } catch (e) {
    handleError(e, 'Could not update star');
  }
}

async function newFolder() {
  const parent = currentFolder;
  let name = await askText('New folder', '', 'Create');
  while (name) {
    try {
      const existing = await findSameName(parent, name, { folder: true });
      if (existing) {
        const choice = await modal({
          title: 'Folder already exists',
          body: para(`A folder named “${existing.name}” already exists here.`),
          buttons: [
            { label: 'Cancel', value: null },
            { label: 'Use another name', value: 'rename' },
            { label: 'Open it', value: 'open', primary: true },
          ],
        });
        if (choice === 'open') location.hash = `#/folder/${encodeURIComponent(existing.id)}`;
        if (choice !== 'rename') return;
        name = await askText('New folder', await uniqueName(parent, name, { folder: true }), 'Create');
        continue;
      }
      const f = await createFolder(name, parent);
      allFolders = [...(allFolders || []), f];
      if (currentFolder === parent && !searchResults) {
        folders.push(f);
        folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        render();
      }
      toast(`Folder “${name}” created in Drive.`);
      return;
    } catch (e) {
      handleError(e, 'Could not create folder');
      return;
    }
  }
}

async function renameItem(item) {
  const folder = isFolder(item);
  const title = folder ? 'Rename folder' : 'Rename slides';
  const parent = item.parents?.[0] || currentFolder;
  let name = await askText(title, displayName(item));
  while (name && name !== displayName(item)) {
    try {
      const fullName = folder ? name : `${name.replace(/\.pdf$/i, '')}.pdf`;
      const clash = await findSameName(parent, fullName, { folder, excludeId: item.id });
      if (clash) {
        const again = await modal({
          title: 'Name already used',
          body: para(`There's already a ${folder ? 'folder' : 'deck'} named “${displayName(clash)}” in this folder. Please pick a different name.`),
          buttons: [{ label: 'Cancel', value: null }, { label: 'Choose another name', value: true, primary: true }],
        });
        if (!again) return;
        const suggestion = await uniqueName(parent, fullName, { folder });
        name = await askText(title, folder ? suggestion : suggestion.replace(/\.pdf$/i, ''));
        continue;
      }
      if (folder) {
        await renameFile(item.id, name);
        item.name = name;
        const cached = allFolders?.find((f) => f.id === item.id);
        if (cached) cached.name = name;
      } else {
        item.name = await renameDeck(item.id, name);
      }
      render();
      toast('Renamed.');
      return;
    } catch (e) {
      handleError(e, 'Rename failed');
      return;
    }
  }
}

async function deleteItem(item) {
  const ok = await confirmDialog(
    isFolder(item) ? 'Delete folder?' : 'Delete slides?',
    isFolder(item)
      ? `“${item.name}” and everything inside it will be moved to your Google Drive trash.`
      : `“${displayName(item)}” and its annotations will be moved to your Google Drive trash.`,
    'Delete',
    true
  );
  if (!ok) return;
  try {
    await trashFile(item.id);
    if (!isFolder(item)) deleteAnnotationsFor(item.id).catch(() => {});
    folders = folders.filter((x) => x.id !== item.id);
    decks = decks.filter((x) => x.id !== item.id);
    allDecks = allDecks.filter((x) => x.id !== item.id);
    if (!isFolder(item)) forgetDeck(item.id);
    if (searchResults) searchResults = searchResults.filter((x) => x.id !== item.id);
    if (isFolder(item)) refreshFolders().catch(() => {});
    render();
    toast('Moved to Drive trash.');
  } catch (e) {
    handleError(e, 'Delete failed');
  }
}

/** ids of a folder and all its sub-folders (can't move a folder into itself). */
function descendantsOf(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of allFolders || []) {
      if (!out.has(f.id) && out.has(f.parents?.[0])) { out.add(f.id); grew = true; }
    }
  }
  return out;
}

async function pickAndMove(item) {
  await refreshFolders().catch(() => {});
  const blocked = isFolder(item) ? descendantsOf(item.id) : new Set();
  const here = item.parents?.[0] || currentFolder || rootId;

  // Build an indented tree.
  const children = new Map();
  for (const f of allFolders || []) {
    const p = f.parents?.[0] === rootId ? 'root' : f.parents?.[0];
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(f);
  }
  const rows = [{ id: 'root', name: 'My slides', depth: 0 }];
  (function walk(parent, depth) {
    for (const f of (children.get(parent) || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      rows.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  })('root', 1);

  const list = document.createElement('div');
  list.className = 'folder-picker';
  let selected = null;
  for (const r of rows) {
    const realId = r.id === 'root' ? rootId : r.id;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'picker-row';
    b.style.paddingLeft = `${12 + r.depth * 18}px`;
    b.textContent = `${r.depth ? '📁' : '🏠'} ${r.name}${realId === here ? '  (current)' : ''}`;
    b.disabled = blocked.has(r.id) || realId === here;
    b.onclick = () => {
      list.querySelectorAll('.picker-row').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      selected = r.id;
    };
    list.appendChild(b);
  }
  const dest = await modal({
    title: `Move “${displayName(item)}” to…`,
    body: list,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Move here', value: () => selected, primary: true }],
  });
  if (!dest) return;
  moveItem(item.id, dest === 'root' ? null : dest);
}

async function moveItem(id, destFolderId) {
  const item = findItem(id);
  try {
    if (item) {
      const folder = isFolder(item);
      const clash = await findSameName(destFolderId, item.name, { folder, excludeId: item.id });
      if (clash) {
        const newName = await uniqueName(destFolderId, item.name, { folder });
        const ok = await modal({
          title: 'Name already used there',
          body: para(`That folder already has a ${folder ? 'folder' : 'deck'} named “${displayName(clash)}”. Keep both by renaming this one to “${folder ? newName : newName.replace(/\.pdf$/i, '')}”?`),
          buttons: [{ label: 'Cancel', value: null }, { label: 'Keep both', value: true, primary: true }],
        });
        if (!ok) return;
        if (folder) await renameFile(item.id, newName);
        else await renameDeck(item.id, newName);
        item.name = newName;
      }
    }
    await moveFile(id, destFolderId);
    const destName = destFolderId ? (allFolders || []).find((f) => f.id === destFolderId)?.name || 'folder' : 'My slides';
    toast(`Moved${item ? ` “${displayName(item)}”` : ''} to ${destName}.`);
    if (item?.mimeType === FOLDER_MIME) refreshFolders().catch(() => {});
    if (searchResults) runSearch();
    showLibrary(currentFolder);
  } catch (e) {
    handleError(e, 'Move failed');
  }
}

/** Ask what to do when an uploaded file's name already exists. Resolves {choice, all}. */
async function askDuplicate(name, moreToCome) {
  const body = document.createElement('div');
  body.append(para(`“${name.replace(/\.pdf$/i, '')}” already exists in this folder.`));
  const tips = document.createElement('ul');
  tips.className = 'muted dup-tips';
  tips.innerHTML =
    '<li><b>Replace</b>: swap in the new PDF but keep your annotations (good for an updated version of the same slides).</li>' +
    '<li><b>Keep both</b>: upload it as a separate copy with a number added.</li>';
  body.append(tips);
  let all = null;
  if (moreToCome) {
    const label = document.createElement('label');
    label.className = 'dup-all';
    all = document.createElement('input');
    all.type = 'checkbox';
    label.append(all, ' Do this for the other duplicates too');
    body.append(label);
  }
  const choice = await modal({
    title: 'File already exists',
    body,
    buttons: [
      { label: 'Skip', value: 'skip' },
      { label: 'Replace', value: 'replace' },
      { label: 'Keep both', value: 'keep', primary: true },
    ],
  });
  return { choice: choice || 'skip', all: !!all?.checked };
}

async function handleFiles(files) {
  const ok = files.filter(isSupported);
  const bad = files.filter((f) => !isSupported(f));
  if (bad.length) toast(`Skipped unsupported: ${bad.map((f) => f.name).join(', ')}. Use PDF, PowerPoint or Word.`, 'error');

  const folderAtStart = currentFolder;
  let remembered = null; // duplicate choice applied to all remaining files

  for (let i = 0; i < ok.length; i++) {
    const file = ok[i];
    const row = document.createElement('div');
    row.className = 'upload-row';
    row.innerHTML = `<span class="upload-name">${escapeHtml(file.name)}</span>
      <span class="upload-stage">Checking…</span>
      <div class="bar"><div class="fill"></div></div>`;
    $('#uploads').appendChild(row);
    const stageEl = row.querySelector('.upload-stage');
    const fill = row.querySelector('.fill');
    let stage = 'Uploading';
    try {
      let name = deckNameFor(file);
      let replaceId = null;
      const clash = await findSameName(folderAtStart, name);
      if (clash) {
        let choice = remembered;
        if (!choice) {
          const ans = await askDuplicate(name, i < ok.length - 1);
          choice = ans.choice;
          if (ans.all) remembered = choice;
        }
        if (choice === 'skip') {
          stageEl.textContent = 'Skipped (already exists)';
          setTimeout(() => row.remove(), 2500);
          continue;
        }
        if (choice === 'replace') replaceId = clash.id;
        else name = await uniqueName(folderAtStart, name);
      }
      if (name !== deckNameFor(file)) row.querySelector('.upload-name').textContent = `${file.name} → ${name}`;

      const created = await uploadDeck(file, {
        folderId: folderAtStart,
        name,
        replaceId,
        onStage: (s) => { stage = s; stageEl.textContent = s + '…'; },
        onProgress: (p) => {
          fill.style.width = `${Math.round(p * 100)}%`;
          stageEl.textContent = `${stage}… ${Math.round(p * 100)}%`;
        },
      });
      fill.style.width = '100%';
      stageEl.textContent = replaceId ? 'Replaced ✓' : 'Done ✓';
      if (created.pdfBlob) {
        thumbUrls.delete(created.id);
        ensureThumb(created.id, created.md5Checksum, created.pdfBlob).then(() => hydrateThumbs());
      }
      delete created.pdfBlob;
      if (currentFolder === folderAtStart && !searchResults) {
        decks = decks.filter((d) => d.id !== created.id);
        decks.unshift({ ...created, name: created.name || name, modifiedTime: created.modifiedTime || new Date().toISOString() });
        render();
      }
      setTimeout(() => row.remove(), 2500);
    } catch (e) {
      row.classList.add('failed');
      stageEl.textContent = e instanceof AuthExpiredError ? 'Session expired — reconnect and retry' : `Failed: ${e.message}`;
      row.onclick = () => row.remove();
      row.title = 'Click to dismiss';
    }
  }
}
