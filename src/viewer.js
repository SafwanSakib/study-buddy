// PDF viewer: rendering, annotation tools, text selection & search, sidebar, bookmarks,
// stylus mode, focus mode, and saving (Drive + offline cache on this device).
import { pdfjsLib, openPdf } from './pdf.js';
import {
  COLORS, SHAPES, drawItems, hitTest, round, strokeWidth, bbox, translate, inLasso, traceLasso,
} from './annotations.js';
import {
  downloadFile, loadAnnotations, saveAnnotations, getFileMeta, updateMeta, saveDeckPdf, renameDeck,
  replaceFileContent, findSameName, uniqueName, setStarred, isOfflineError,
} from './drive.js';
import { TEMPLATES, insertPage, removePage, shiftForInsert, shiftForRemove } from './pages.js';
import { AuthExpiredError } from './auth.js';
import { cget, cset, cachePdf } from './cache.js';
import { ensureThumb } from './thumbs.js';
import { toast, $, askText, modal, para, confirmDialog } from './ui.js';

const PREFS_KEY = 'sb_prefs';
const SAVE_DELAY = 1200;
const DRAW_TOOLS = new Set(['pen', 'highlighter', 'shape']);
const SHAPE_ICONS = { line: '／', arrow: '↗', rect: '▭', ellipse: '◯' };

let state = null; // per open deck
let prefs = loadPrefs();

function loadPrefs() {
  const defaults = { tool: 'hand', color: COLORS[1], size: 2, shape: 'arrow', stylus: false, stylusAsked: false, sidebar: false, toolbarHidden: false, lastDrawTool: 'pen' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

function capture(el, id) {
  try { el.setPointerCapture(id); } catch {}
}

const quietErrors = (e) => e instanceof AuthExpiredError || isOfflineError(e);

// =====================================================================
// Toolbar & global listeners (set up once)
// =====================================================================
let toolbarReady = false;
function setupToolbar() {
  if (toolbarReady) return;
  toolbarReady = true;

  const colorsEl = $('#colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    b.onclick = () => {
      prefs.color = c;
      savePrefs();
      $('#palette').classList.remove('open');
      if (state?.selection) recolorSelection(c);
      else if (!DRAW_TOOLS.has(prefs.tool) && prefs.tool !== 'text') setTool(prefs.lastDrawTool || 'pen');
      syncToolbar();
    };
    colorsEl.appendChild(b);
  }
  document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $('#shape-kind').onchange = (e) => { prefs.shape = e.target.value; setTool('shape'); };
  $('#size').onchange = (e) => { prefs.size = Number(e.target.value); savePrefs(); syncToolbar(); };
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#zoom-in').onclick = () => setZoom(state.zoom * 1.25);
  $('#zoom-out').onclick = () => setZoom(state.zoom / 1.25);
  $('#zoom-fit').onclick = () => setZoom(1);
  $('#focus-zoom-out').onclick = () => setZoom(state.zoom / 1.25);
  $('#focus-zoom-fit').onclick = () => setZoom(1);
  $('#focus-zoom-in').onclick = () => setZoom(state.zoom * 1.25);
  setupZoomGestures();
  $('#sidebar-btn').onclick = () => toggleSidebar();
  $('#search-btn').onclick = () => openSearch();
  $('#bookmark-btn').onclick = () => toggleBookmark();
  $('#stylus-btn').onclick = () => {
    prefs.stylus = !prefs.stylus;
    prefs.stylusAsked = true;
    savePrefs();
    syncToolbar();
    toast(prefs.stylus ? 'Stylus mode on: pen draws, finger scrolls.' : 'Stylus mode off: fingers draw too.');
  };
  $('#focus-btn').onclick = () => setFocus(true);
  $('#toolbar-toggle').onclick = () => setToolbarHidden(!prefs.toolbarHidden);
  $('#focus-exit').onclick = () => setFocus(false);
  $('#focus-prev').onclick = () => goToPage(state.currentPage - 1);
  $('#focus-next').onclick = () => goToPage(state.currentPage + 1);

  // sidebar tabs
  document.querySelectorAll('[data-sidetab]').forEach((b) => (b.onclick = () => showSideTab(b.dataset.sidetab)));
  $('#sidebar-backdrop').onclick = () => toggleSidebar(false);

  // search bar
  const si = $('#search-input');
  si.oninput = () => { clearTimeout(si._t); si._t = setTimeout(() => runSearch(si.value), 250); };
  si.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') closeSearch();
  };
  $('#search-prev').onclick = () => stepMatch(-1);
  $('#search-next').onclick = () => stepMatch(1);
  $('#search-close').onclick = closeSearch;

  $('#menu-btn').onclick = (e) => { e.stopPropagation(); syncMenu(); $('#menu').hidden = !$('#menu').hidden; };
  document.addEventListener('click', () => ($('#menu').hidden = true));
  $('#menu').onclick = (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action) menuAction(action);
  };

  document.addEventListener('keydown', onKeyDown);

  // Re-fit pages whenever their area changes size (window resize, side panels, rotating a phone…).
  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = $('#pages').clientWidth;
    if (!w || w === lastWidth) return;
    lastWidth = w;
    clearTimeout(setupToolbar._rt);
    setupToolbar._rt = setTimeout(() => state?.pdf && relayout(), 150);
  }).observe($('#pages'));

  // Compact toolbar: colour/size panel and "more tools" on small screens.
  $('#palette-btn').onclick = (e) => {
    e.stopPropagation();
    $('#palette').classList.toggle('open');
  };
  $('#palette').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => $('#palette').classList.remove('open'));
  $('#more-tools-btn').onclick = () => {
    $('#toolbar').classList.toggle('expanded');
    $('#more-tools-btn').classList.toggle('active', $('#toolbar').classList.contains('expanded'));
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && $('#viewer').classList.contains('focus')) setFocus(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state?.dirty) flushSave();
  });
  window.addEventListener('online', () => {
    if (state?.dirty) flushSave();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state?.dirty && navigator.onLine) { flushSave(); e.preventDefault(); }
  });
}

function onKeyDown(e) {
  if (!state?.pdf || $('#viewer').hidden || document.querySelector('.modal-back')) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'f') { e.preventDefault(); openSearch(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); setZoom(state.zoom * 1.25); return; }
  if (mod && k === '-') { e.preventDefault(); setZoom(state.zoom / 1.25); return; }
  if (mod && k === '0') { e.preventDefault(); setZoom(1); return; }
  if (e.target.closest('input, textarea, select')) return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((k === 'delete' || k === 'backspace') && state.selection) { e.preventDefault(); deleteSelection(); }
  else if (k === 'escape') {
    if (state.selection) clearSelection();
    else if ($('#viewer').classList.contains('focus')) setFocus(false);
  } else if (['arrowright', 'pagedown'].includes(k) || (k === ' ' && $('#viewer').classList.contains('focus'))) {
    e.preventDefault(); goToPage(state.currentPage + 1);
  } else if (['arrowleft', 'pageup'].includes(k)) {
    e.preventDefault(); goToPage(state.currentPage - 1);
  } else if (!mod && !e.altKey) {
    const map = { h: 'hand', v: 'select', p: 'pen', l: 'highlighter', t: 'text', s: 'shape', e: 'eraser' };
    if (map[k]) setTool(map[k]);
    else if (k === 'b') toggleBookmark();
    else if (k === '\\') setToolbarHidden(!prefs.toolbarHidden);
    else if (k === 'f') setFocus(!$('#viewer').classList.contains('focus'));
  }
}

function syncToolbar() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === prefs.tool));
  document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === prefs.color));
  $('#size').value = String(prefs.size);
  $('.palette-dot').style.background = prefs.color;
  $('.palette-dot').style.transform = `scale(${0.6 + prefs.size * 0.1})`;
  $('#shape-kind').value = prefs.shape;
  $('[data-tool="shape"]').textContent = SHAPE_ICONS[prefs.shape] || '／';
  $('#stylus-btn').classList.toggle('active', !!prefs.stylus);
  $('#sidebar-btn').classList.toggle('active', !!prefs.sidebar);
  const hidden = !!prefs.toolbarHidden;
  $('#viewer').classList.toggle('toolbar-hidden', hidden);
  $('#toolbar-toggle').title = hidden ? 'Show toolbar (\\)' : 'Hide toolbar (\\)';
  $('#toolbar-toggle').setAttribute('aria-expanded', String(!hidden));
  if (state) {
    $('#undo').disabled = !state.undoStack.length;
    $('#redo').disabled = !state.redoStack.length;
    $('#pages').dataset.tool = prefs.tool;
    $('#bookmark-btn').classList.toggle('active', !!state.ann.bookmarks?.[state.currentPage]);
  }
}

function setToolbarHidden(hidden) {
  prefs.toolbarHidden = hidden;
  savePrefs();
  $('#palette').classList.remove('open');
  syncToolbar();
}

function setTool(t) {
  prefs.tool = t;
  if (DRAW_TOOLS.has(t)) prefs.lastDrawTool = t;
  savePrefs();
  if (state?.selection && t !== 'select') clearSelection();
  syncToolbar();
}

// =====================================================================
// Open / close
// =====================================================================

export async function openDeck(deckId) {
  setupToolbar();
  closeDeck();
  const pagesEl = $('#pages');
  parkSelectionBar();
  pagesEl.innerHTML = '';
  $('#deck-title').textContent = '';
  setSaveStatus('');
  closeSearch();
  showLoading('Loading slides…');

  const myState = (state = {
    deckId,
    meta: null,
    pdf: null,
    pdfBytes: null,
    pages: [],
    ann: { version: 1, pages: {}, bookmarks: {}, lastPage: 1 },
    annFileId: null,
    undoStack: [],
    redoStack: [],
    zoom: 1,
    dirty: false,
    saving: false,
    saveTimer: null,
    observer: null,
    currentPage: 1,
    texts: new Map(), // page → pdf.js TextContent (for search)
    selection: null, // { page, items: [] }
    search: null, // { term, matches: [{page, n}], cur }
  });

  try {
    const cachedAnn = await cget('ann', deckId);
    const cachedPdf = await cget('pdfs', deckId);
    let meta = null;
    let offline = false;
    try {
      meta = await getFileMeta(deckId);
    } catch (e) {
      if (!isOfflineError(e)) throw e;
      offline = true;
    }
    if (state !== myState) return;

    let bytes, annRes = null;
    if (offline) {
      if (!cachedPdf) throw new Error('You’re offline and this deck hasn’t been opened on this device before.');
      meta = cachedPdf.meta;
      bytes = cachedPdf.bytes;
    } else {
      const sameVersion = cachedPdf?.bytes && meta.md5Checksum && cachedPdf.md5 === meta.md5Checksum;
      [bytes, annRes] = await Promise.all([
        sameVersion
          ? cachedPdf.bytes
          : downloadFile(deckId, (p) => showLoading(`Downloading… ${Math.round(p * 100)}%`)),
        loadAnnotations(deckId).catch((e) => {
          if (isOfflineError(e)) return null;
          throw e;
        }),
      ]);
      cachePdf(deckId, { md5: meta.md5Checksum || '', bytes: bytes.slice(0), meta });
    }
    if (state !== myState) return;
    myState.meta = meta;
    myState.pdfBytes = bytes.slice(0); // pdf.js takes ownership of the buffer it gets
    setTitle(meta.name);

    // Annotations: unsynced edits on this device win; otherwise Drive; otherwise the offline copy.
    let data = null;
    if (cachedAnn?.pending && cachedAnn.data) {
      data = cachedAnn.data;
      myState.dirty = true;
    } else if (annRes) {
      data = annRes.data;
    } else if (cachedAnn?.data) {
      data = cachedAnn.data;
    }
    if (data?.pages) myState.ann = { version: 1, lastPage: 1, bookmarks: {}, ...data };
    myState.annFileId = annRes?.fileId ?? cachedAnn?.fileId ?? null;
    if (annRes) cset('ann', deckId, { data: myState.ann, fileId: myState.annFileId, pending: myState.dirty });

    showLoading('Rendering…');
    myState.pdf = await openPdf(new Uint8Array(bytes));
    if (state !== myState) return;
    myState.currentPage = Math.min(myState.ann.lastPage || 1, myState.pdf.numPages);
    await buildPages();
    hideLoading();
    syncToolbar();
    if (offline) setSaveStatus('Offline — changes saved on this device', true);
    else if (myState.dirty) flushSave();
    else setSaveStatus(myState.annFileId ? 'Saved to Drive' : '');

    if (myState.currentPage > 1) {
      myState.pages[myState.currentPage - 1].el.scrollIntoView({ block: 'start' });
      toast(`Resumed at page ${myState.currentPage}`);
    }
    if (prefs.sidebar) toggleSidebar(true);
    if (!offline) {
      // Bump modifiedTime + lastOpened so the deck shows up in "Recently opened".
      updateMeta(deckId, { appProperties: { lastOpened: String(Date.now()) } }).catch(() => {});
      ensureThumb(deckId, meta.md5Checksum, myState.pdf);
    }
  } catch (e) {
    hideLoading();
    if (!(e instanceof AuthExpiredError)) {
      console.error(e);
      toast(isOfflineError(e) ? 'You’re offline.' : `Could not open deck: ${e.message}`, 'error');
    }
    throw e;
  }
}

function setTitle(name) {
  $('#deck-title').textContent = name.replace(/\.pdf$/i, '');
  document.title = `${$('#deck-title').textContent} · Study Buddy`;
}

export function closeDeck() {
  if (!state) return;
  if (state.dirty) flushSave();
  if ($('#viewer').classList.contains('focus')) setFocus(false);
  state.observer?.disconnect();
  state.thumbObserver?.disconnect();
  state.pages.forEach((p) => p.renderTask?.cancel());
  state.pdf?.loadingTask.destroy().catch(() => {});
  state = null;
  toggleSidebar(false, true);
  document.title = 'Study Buddy';
}

export function isLoaded() {
  return !!state?.pdf;
}

export function hasUnsavedChanges() {
  return !!state?.dirty;
}

// =====================================================================
// Layout & rendering
// =====================================================================

function containerWidth() {
  const el = $('#pages');
  return Math.max(200, Math.min(el.clientWidth - 24, 1400));
}

async function buildPages() {
  const s = state;
  const pagesEl = $('#pages');
  const baseWidth = containerWidth();

  s.observer = new IntersectionObserver(onIntersect, { root: pagesEl, rootMargin: '150% 0px' });
  pagesEl.onscroll = () => {
    if (s.scrollRaf) return;
    s.scrollRaf = requestAnimationFrame(() => { s.scrollRaf = 0; if (state === s) trackCurrentPage(); });
  };

  for (let i = 1; i <= s.pdf.numPages; i++) {
    const page = await s.pdf.getPage(i);
    if (state !== s) return;
    const vp = page.getViewport({ scale: 1 });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = i;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = i;
    const mark = document.createElement('div');
    mark.className = 'page-bookmark';
    mark.textContent = '🔖';
    el.append(canvas, textLayer, overlay, label, mark);
    pagesEl.appendChild(el);

    const p = { num: i, page, el, canvas, textLayer, overlay, vp1: vp, aspect: vp.height / vp.width, rendered: 0, renderTask: null };
    s.pages.push(p);
    sizePage(p, baseWidth);
    attachPointer(p);
    s.observer.observe(el);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'btn add-page-end';
  addBtn.textContent = '+ Add page';
  addBtn.onclick = () => addPageDialog(s.pdf.numPages + 1);
  pagesEl.appendChild(addBtn);
  syncBookmarks();
  buildSidebar();
  updatePageIndicator();
}

/** Swap in new PDF bytes and re-render everything, keeping the viewer open. */
async function reloadPdf(s, bytes, goTo) {
  s.observer?.disconnect();
  s.pages.forEach((p) => p.renderTask?.cancel());
  await s.pdf?.loadingTask.destroy().catch(() => {});
  s.pages = [];
  s.texts = new Map();
  s.selection = null;
  parkSelectionBar();
  $('#pages').innerHTML = '';
  s.pdfBytes = bytes.slice(0);
  s.pdf = await openPdf(new Uint8Array(bytes));
  s.currentPage = Math.min(Math.max(1, goTo), s.pdf.numPages);
  await buildPages();
  if (state !== s) return;
  s.pages[s.currentPage - 1]?.el.scrollIntoView({ block: 'start' });
  if (s.search?.term) runSearch(s.search.term);
  syncToolbar();
}

function sizePage(p, baseWidth) {
  let fit = baseWidth;
  // In focus mode, 100% = the whole page fits on screen.
  if ($('#viewer').classList.contains('focus')) {
    const maxH = $('#pages').clientHeight - 24;
    fit = Math.min(fit, Math.max(100, maxH / p.aspect));
  }
  const w = Math.round(fit * state.zoom);
  p.cssW = w;
  p.cssH = Math.round(w * p.aspect);
  p.el.style.width = `${w}px`;
  p.el.style.height = `${p.cssH}px`;
}

function relayout() {
  const anchor = state.currentPage;
  const base = containerWidth();
  for (const p of state.pages) {
    sizePage(p, base);
    p.rendered = 0;
    p.textKey = 0;
    if (p.visible) renderPage(p);
  }
  state.pages[anchor - 1]?.el.scrollIntoView({ block: 'start' });
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/** Zoom buttons / keys: zoom around the middle of the screen. */
function setZoom(z) {
  if (!state?.pdf) return;
  const r = $('#pages').getBoundingClientRect();
  zoomAt(z, r.left + r.width / 2, r.top + r.height / 3);
}

/**
 * Zoom keeping the point under (fx, fy) — fingers or cursor — fixed on screen.
 * Pages are resized instantly (the existing image stretches) and re-rendered sharply
 * once zooming pauses.
 */
function zoomAt(z, fx, fy) {
  const s = state;
  if (!s?.pdf) return;
  z = clampZoom(z);
  if (Math.abs(z - s.zoom) < 0.001) return;
  const pagesEl = $('#pages');
  // Which page is under the focus point, and where on it?
  let anchor = s.pages.find((p) => {
    const r = p.el.getBoundingClientRect();
    return fy >= r.top && fy <= r.bottom;
  }) || s.pages[s.currentPage - 1];
  const r1 = anchor.el.getBoundingClientRect();
  const u = (fx - r1.left) / r1.width;
  const v = (fy - r1.top) / r1.height;

  s.zoom = z;
  const base = containerWidth();
  for (const p of s.pages) sizePage(p, base);
  const r2 = anchor.el.getBoundingClientRect();
  pagesEl.scrollLeft += r2.left + u * r2.width - fx;
  pagesEl.scrollTop += r2.top + v * r2.height - fy;

  pagesEl.classList.add('zooming');
  showZoomLevel();
  clearTimeout(s.zoomTimer);
  s.zoomTimer = setTimeout(() => {
    if (state !== s) return;
    pagesEl.classList.remove('zooming');
    for (const p of s.pages) {
      p.rendered = 0;
      p.textKey = 0;
      if (p.visible) renderPage(p);
    }
    positionSelectionBar();
  }, 220);
}

function showZoomLevel() {
  const pill = $('#zoom-pill');
  pill.textContent = `${Math.round(state.zoom * 100)}%`;
  pill.hidden = false;
  pill.classList.add('show');
  clearTimeout(showZoomLevel._t);
  showZoomLevel._t = setTimeout(() => pill.classList.remove('show'), 900);
}

/** Pinch (touch), trackpad pinch / Ctrl+scroll, Safari gestures, double-tap. */
function setupZoomGestures() {
  const pagesEl = $('#pages');

  // Two-finger pinch + pan (touch screens). Works with every tool.
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  pagesEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && state?.pdf) {
      const [mx, my] = mid(e.touches);
      pinch = { d0: dist(e.touches), z0: state.zoom, mx, my };
    }
  }, { passive: true });
  pagesEl.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [mx, my] = mid(e.touches);
    // pan with the fingers, then zoom around them
    pagesEl.scrollLeft -= mx - pinch.mx;
    pagesEl.scrollTop -= my - pinch.my;
    pinch.mx = mx;
    pinch.my = my;
    zoomAt(pinch.z0 * (dist(e.touches) / pinch.d0), mx, my);
  }, { passive: false });
  const endPinch = (e) => { if (e.touches.length < 2) pinch = null; };
  pagesEl.addEventListener('touchend', endPinch);
  pagesEl.addEventListener('touchcancel', endPinch);

  // Trackpad pinch arrives as wheel + ctrlKey (Chrome, Edge, Firefox); Ctrl+mouse wheel too.
  pagesEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !state?.pdf) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // Trackpads send many small steps; a mouse-wheel notch is ~100 — cap each step at ~1.3×.
    const step = Math.max(-45, Math.min(45, dy));
    zoomAt(state.zoom * Math.exp(-step * 0.006), e.clientX, e.clientY);
  }, { passive: false });

  // Safari (macOS) trackpad pinch
  let g0 = 1;
  pagesEl.addEventListener('gesturestart', (e) => { e.preventDefault(); g0 = state?.zoom || 1; });
  pagesEl.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (state?.pdf) zoomAt(g0 * e.scale, e.clientX, e.clientY);
  });
  pagesEl.addEventListener('gestureend', (e) => e.preventDefault());

  // Double-tap / double-click with the ✋ tool: toggle fit ↔ 200%.
  let lastTap = null;
  const toggleAt = (x, y) => zoomAt(state.zoom > 1.05 ? 1 : 2, x, y);
  pagesEl.addEventListener('dblclick', (e) => {
    if (prefs.tool !== 'hand' || !state?.pdf || e.target.closest('.add-page-end')) return;
    if (window.getSelection()?.toString()) window.getSelection().removeAllRanges();
    toggleAt(e.clientX, e.clientY);
  });
  pagesEl.addEventListener('touchend', (e) => {
    if (prefs.tool !== 'hand' || e.touches.length || e.changedTouches.length !== 1 || !state?.pdf) return;
    const t = e.changedTouches[0];
    const now = Date.now();
    if (lastTap && now - lastTap.t < 300 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30) {
      e.preventDefault();
      lastTap = null;
      toggleAt(t.clientX, t.clientY);
    } else lastTap = { t: now, x: t.clientX, y: t.clientY };
  });
}

function onIntersect(entries) {
  for (const e of entries) {
    const p = state?.pages[Number(e.target.dataset.page) - 1];
    if (!p) continue;
    p.visible = e.isIntersecting;
    if (e.isIntersecting) renderPage(p);
    else if (p.rendered) {
      // Free memory for far-away pages.
      p.renderTask?.cancel();
      p.canvas.width = p.canvas.height = 0;
      p.overlay.width = p.overlay.height = 0;
      p.textLayer.innerHTML = '';
      p.rendered = 0;
      p.textKey = 0;
    }
  }
}

function trackCurrentPage() {
  const pagesEl = $('#pages');
  const mid = pagesEl.getBoundingClientRect().top + pagesEl.clientHeight / 3;
  let n = 1;
  for (const p of state.pages) {
    if (p.el.getBoundingClientRect().top <= mid) n = p.num;
    else break;
  }
  if (n === state.currentPage) return;
  state.currentPage = n;
  updatePageIndicator();
  if (state.ann.lastPage !== n) {
    state.ann.lastPage = n;
    scheduleSave(4000); // low priority: remember reading position
  }
}

function updatePageIndicator() {
  const s = state;
  if (!s?.pdf) return;
  const txt = `${s.currentPage} / ${s.pdf.numPages}`;
  $('#page-num').textContent = txt;
  $('#focus-page').textContent = txt;
  $('#bookmark-btn').classList.toggle('active', !!s.ann.bookmarks?.[s.currentPage]);
  document.querySelectorAll('.thumb-item').forEach((t) => t.classList.toggle('current', Number(t.dataset.page) === s.currentPage));
  const cur = document.querySelector(`.thumb-item[data-page="${s.currentPage}"]`);
  if (cur && !$('#sidebar').hidden) cur.scrollIntoView({ block: 'nearest' });
}

export function goToPage(n) {
  const s = state;
  if (!s?.pdf) return;
  n = Math.max(1, Math.min(s.pdf.numPages, n));
  s.pages[n - 1].el.scrollIntoView({ block: 'start' });
  s.currentPage = n;
  updatePageIndicator();
}

async function renderPage(p) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const key = p.cssW * dpr;
  if (p.rendered === key) return;
  p.rendered = key;
  p.renderTask?.cancel();

  const scale = (p.cssW / p.vp1.width) * dpr;
  const viewport = p.page.getViewport({ scale });
  const off = document.createElement('canvas');
  off.width = Math.floor(viewport.width);
  off.height = Math.floor(viewport.height);
  const task = (p.renderTask = p.page.render({ canvasContext: off.getContext('2d'), viewport }));
  try {
    await task.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
    return;
  }
  if (p.rendered !== key) return;
  p.canvas.width = off.width;
  p.canvas.height = off.height;
  p.canvas.getContext('2d').drawImage(off, 0, 0);
  p.overlay.width = off.width;
  p.overlay.height = off.height;
  redrawOverlay(p);
  renderTextLayer(p);
}

async function getText(num) {
  const s = state;
  if (!s.texts.has(num)) s.texts.set(num, s.pages[num - 1].page.getTextContent());
  return s.texts.get(num);
}

/** Invisible, selectable text over the slide (copy text, search highlights). */
async function renderTextLayer(p) {
  const key = p.cssW;
  if (p.textKey === key) return;
  p.textKey = key;
  const s = state;
  try {
    const textContent = await getText(p.num);
    if (state !== s || p.textKey !== key) return;
    const scale = p.cssW / p.vp1.width;
    p.textLayer.innerHTML = '';
    p.textLayer.style.setProperty('--total-scale-factor', scale);
    p.textLayer.style.setProperty('--scale-round-x', '1px');
    p.textLayer.style.setProperty('--scale-round-y', '1px');
    const layer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: p.textLayer,
      viewport: p.page.getViewport({ scale }),
    });
    await layer.render();
    if (state !== s || p.textKey !== key) return;
    applyHighlights(p);
  } catch (e) {
    console.warn('text layer failed', e);
  }
}

function pageItems(num) {
  return (state.ann.pages[num] ||= []);
}

function redrawOverlay(p, extra) {
  const ctx = p.overlay.getContext('2d');
  const W = p.overlay.width, H = p.overlay.height;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);
  drawItems(ctx, pageItems(p.num), W, H);
  if (extra?.lasso) traceLasso(ctx, extra.lasso);
  else if (extra) drawItems(ctx, [extra], W, H);
  const sel = state.selection;
  if (sel?.page === p.num && sel.items.length) {
    const b = selectionBox(sel, W, H);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = Math.max(1.5, W / 700);
    ctx.strokeStyle = '#4f46e5';
    ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
    ctx.restore();
  }
  positionSelectionBar();
}

// =====================================================================
// Pointer input: tools, stylus mode, palm rejection
// =====================================================================

let lastPenTime = 0;
const penActive = () => Date.now() - lastPenTime < 600;

function attachPointer(p) {
  const ov = p.overlay;
  let action = null; // { kind: 'draw'|'shape'|'erase'|'lasso'|'move'|'pan'|'textdrag', ... }
  let rafPending = false;
  const touches = new Set();

  const norm = (e) => {
    const r = ov.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const px = (e) => {
    const r = ov.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * ov.width, ((e.clientY - r.top) / r.height) * ov.height, ov.width / r.width];
  };
  const schedule = (extra) => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      redrawOverlay(p, typeof extra === 'function' ? extra() : extra);
    });
  };
  const itemAt = (e) => {
    const [x, y, k] = px(e);
    const items = pageItems(p.num);
    for (let i = items.length - 1; i >= 0; i--) if (hitTest(items[i], x, y, 8 * k, ov.width, ov.height)) return items[i];
    return null;
  };

  const eraseAt = (e) => {
    const [x, y, k] = px(e);
    const items = pageItems(p.num);
    for (let i = items.length - 1; i >= 0; i--) {
      if (hitTest(items[i], x, y, 10 * k, ov.width, ov.height)) {
        const [removed] = items.splice(i, 1);
        pushUndo({ type: 'remove', page: p.num, item: removed, index: i });
        redrawOverlay(p);
        changed();
      }
    }
  };

  ov.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'pen') {
      lastPenTime = Date.now();
      if (!prefs.stylus && !prefs.stylusAsked) {
        prefs.stylus = true;
        prefs.stylusAsked = true;
        savePrefs();
        syncToolbar();
        toast('Stylus detected: your pen draws and your finger scrolls. Toggle with ✍️.', 'info', 5000);
      }
      if (action?.kind === 'pan') action = null;
    }
    let tool = prefs.tool;
    if (tool === 'hand') return; // native scrolling / text selection

    if (e.pointerType === 'touch') {
      touches.add(e.pointerId);
      // Palm rejection: ignore touches while the pen is in use.
      if (penActive()) { e.preventDefault(); return; }
      // Second finger = pinch-zoom (handled on the page container): drop whatever this touch started.
      if (touches.size > 1) {
        e.preventDefault();
        if (action) { action = null; redrawOverlay(p); }
        return;
      }
      // Stylus mode: fingers scroll instead of drawing.
      if (prefs.stylus) {
        e.preventDefault();
        capture(ov, e.pointerId);
        action = { kind: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 };
        return;
      }
    }
    e.preventDefault();
    capture(ov, e.pointerId);
    const [x, y] = norm(e);

    if (tool === 'text') {
      const hit = itemAt(e);
      if (hit?.type === 'text') action = { kind: 'textdrag', item: hit, sx: x, sy: y, dx: 0, dy: 0 };
      else addTextAt(p, x, y);
      return;
    }
    if (tool === 'eraser') {
      action = { kind: 'erase' };
      eraseAt(e);
      return;
    }
    if (tool === 'select') {
      const sel = state.selection;
      const [X, Y] = px(e);
      if (sel?.page === p.num) {
        const b = selectionBox(sel, ov.width, ov.height);
        if (X >= b.x - 8 && X <= b.x + b.w + 8 && Y >= b.y - 8 && Y <= b.y + b.h + 8) {
          action = { kind: 'move', sx: x, sy: y, dx: 0, dy: 0 };
          return;
        }
      }
      const hit = itemAt(e);
      if (hit) {
        setSelection(p.num, [hit]);
        action = { kind: 'move', sx: x, sy: y, dx: 0, dy: 0 };
        return;
      }
      clearSelection();
      action = { kind: 'lasso', poly: [X, Y] };
      return;
    }
    if (tool === 'shape') {
      action = { kind: 'shape', item: { type: 'shape', kind: prefs.shape, x1: round(x), y1: round(y), x2: round(x), y2: round(y), color: prefs.color, w: strokeWidth('pen', prefs.size) * 1.25 } };
      return;
    }
    action = {
      kind: 'draw',
      id: e.pointerId,
      item: { type: 'stroke', tool, color: prefs.color, w: strokeWidth(tool, prefs.size), pts: [round(x), round(y)] },
    };
  });

  ov.addEventListener('pointermove', (e) => {
    if (!action) return;
    if (e.pointerType === 'pen') lastPenTime = Date.now();
    if (action.kind === 'pan') {
      if (e.pointerId !== action.id) return;
      const pagesEl = $('#pages');
      const now = performance.now();
      const dx = e.clientX - action.x, dy = e.clientY - action.y;
      const dt = Math.max(1, now - action.t);
      action.vx = 0.8 * (dx / dt) + 0.2 * action.vx;
      action.vy = 0.8 * (dy / dt) + 0.2 * action.vy;
      pagesEl.scrollBy(-dx, -dy);
      Object.assign(action, { x: e.clientX, y: e.clientY, t: now });
      return;
    }
    e.preventDefault();
    if (action.kind === 'erase') return eraseAt(e);
    const [x, y] = norm(e);
    if (action.kind === 'draw') {
      if (e.pointerId !== action.id) return;
      for (const ev of e.getCoalescedEvents?.() || [e]) {
        const [cx, cy] = norm(ev);
        action.item.pts.push(round(cx), round(cy));
      }
      schedule(action.item);
    } else if (action.kind === 'shape') {
      action.item.x2 = round(x);
      action.item.y2 = round(y);
      schedule(action.item);
    } else if (action.kind === 'lasso') {
      const [X, Y] = px(e);
      action.poly.push(X, Y);
      schedule({ lasso: action.poly });
    } else if (action.kind === 'move' || action.kind === 'textdrag') {
      const ndx = x - action.sx, ndy = y - action.sy;
      const items = action.kind === 'move' ? state.selection.items : [action.item];
      for (const it of items) translate(it, ndx - action.dx, ndy - action.dy);
      action.dx = ndx;
      action.dy = ndy;
      schedule(null);
    }
  });

  const end = (e) => {
    if (e.pointerType === 'touch') touches.delete(e.pointerId);
    const a = action;
    if (!a) return;
    if (a.id !== undefined && e.pointerId !== a.id) return;
    action = null;
    if (a.kind === 'pan') return glide(a.vx, a.vy);
    if (a.kind === 'erase') return;
    if (a.kind === 'draw' || a.kind === 'shape') {
      if (e.type === 'pointercancel' && a.kind === 'draw' && a.item.pts.length < 6) return redrawOverlay(p);
      if (a.kind === 'shape' && Math.hypot(a.item.x2 - a.item.x1, a.item.y2 - a.item.y1) < 0.004) return redrawOverlay(p);
      const items = pageItems(p.num);
      items.push(a.item);
      pushUndo({ type: 'add', page: p.num, item: a.item, index: items.length - 1 });
      redrawOverlay(p);
      changed();
    } else if (a.kind === 'lasso') {
      const items = pageItems(p.num).filter((it) => a.poly.length >= 6 && inLasso(it, a.poly, ov.width, ov.height));
      if (items.length) setSelection(p.num, items);
      else redrawOverlay(p);
    } else if (a.kind === 'move' || a.kind === 'textdrag') {
      const moved = Math.hypot(a.dx, a.dy) > 0.002;
      const items = a.kind === 'move' ? state.selection.items : [a.item];
      if (moved) {
        pushUndo({ type: 'move', page: p.num, items, dx: a.dx, dy: a.dy });
        changed();
      } else {
        // Snap back tiny jitters; a tap on a note edits it.
        for (const it of items) translate(it, -a.dx, -a.dy);
        if (a.kind === 'textdrag') editText(p.num, a.item);
      }
      redrawOverlay(p);
    }
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
  ov.addEventListener('dblclick', (e) => {
    if (prefs.tool !== 'select') return;
    const hit = itemAt(e);
    if (hit?.type === 'text') editText(p.num, hit);
  });
}

/** Momentum after a finger pan in stylus mode. */
function glide(vx, vy) {
  const pagesEl = $('#pages');
  let last = performance.now();
  (function step(now) {
    const dt = now - last;
    last = now;
    vx *= Math.pow(0.95, dt / 16);
    vy *= Math.pow(0.95, dt / 16);
    if (Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) return;
    pagesEl.scrollBy(-vx * dt, -vy * dt);
    requestAnimationFrame(step);
  })(last);
}

// ---------- text notes ----------

async function addTextAt(p, x, y) {
  const text = await askText('New note', '', 'Add', { multiline: true });
  if (!text || state?.pages[p.num - 1] !== p) return;
  const item = { type: 'text', x: round(x), y: round(y), text, color: prefs.color, size: 0.012 + 0.004 * prefs.size };
  const items = pageItems(p.num);
  items.push(item);
  pushUndo({ type: 'add', page: p.num, item, index: items.length - 1 });
  redrawOverlay(p);
  changed();
}

async function editText(page, item) {
  const text = await askText('Edit note', item.text, 'Save', { multiline: true });
  if (text === null || !state) return;
  if (!text) {
    // Emptied → delete the note.
    const items = pageItems(page);
    const i = items.indexOf(item);
    if (i >= 0) {
      items.splice(i, 1);
      pushUndo({ type: 'remove', page, item, index: i });
    }
  } else if (text !== item.text) {
    pushUndo({ type: 'patch', page, item, before: { text: item.text }, after: { text } });
    item.text = text;
  } else return;
  if (state.selection?.items.includes(item)) clearSelection();
  redrawOverlay(state.pages[page - 1]);
  changed();
}

// ---------- selection ----------

function selectionBox(sel, W, H) {
  const boxes = sel.items.map((it) => bbox(it, W, H));
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

function setSelection(page, items) {
  const prev = state.selection?.page;
  state.selection = { page, items };
  if (prev && prev !== page) redrawOverlay(state.pages[prev - 1]);
  redrawOverlay(state.pages[page - 1]);
}

function clearSelection() {
  const sel = state?.selection;
  if (!sel) return;
  state.selection = null;
  redrawOverlay(state.pages[sel.page - 1]);
}

/** The selection toolbar lives inside the selected page; move it out before pages are rebuilt. */
function parkSelectionBar() {
  const bar = $('#selection-bar');
  bar.hidden = true;
  if (bar.parentElement !== $('#viewer')) $('#viewer').appendChild(bar);
}

function positionSelectionBar() {
  const bar = $('#selection-bar');
  const sel = state?.selection;
  if (!sel?.items.length) { bar.hidden = true; return; }
  const p = state.pages[sel.page - 1];
  if (!p.overlay.width) { bar.hidden = true; return; }
  const k = p.cssW / p.overlay.width;
  const b = selectionBox(sel, p.overlay.width, p.overlay.height);
  const single = sel.items.length === 1 && sel.items[0].type === 'text';
  bar.querySelector('[data-sel="edit"]').hidden = !single;
  if (bar.parentElement !== p.el) p.el.appendChild(bar);
  bar.hidden = false;
  const top = (b.y - 6) * k - bar.offsetHeight - 8;
  bar.style.top = `${top < 0 ? (b.y + b.h + 6) * k + 8 : top}px`;
  bar.style.left = `${Math.max(0, Math.min(p.cssW - bar.offsetWidth, b.x * k))}px`;
}

function deleteSelection() {
  const sel = state?.selection;
  if (!sel) return;
  const items = pageItems(sel.page);
  const entries = sel.items.map((item) => ({ item, index: items.indexOf(item) })).filter((x) => x.index >= 0).sort((a, b) => b.index - a.index);
  for (const { index } of entries) items.splice(index, 1);
  pushUndo({ type: 'removeMany', page: sel.page, entries });
  state.selection = null;
  redrawOverlay(state.pages[sel.page - 1]);
  changed();
}

function recolorSelection(color) {
  const sel = state.selection;
  for (const item of sel.items) {
    if (item.color === color) continue;
    pushUndo({ type: 'patch', page: sel.page, item, before: { color: item.color }, after: { color } });
    item.color = color;
  }
  redrawOverlay(state.pages[sel.page - 1]);
  changed();
}

function setupSelectionBar() {
  const bar = $('#selection-bar');
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  bar.onclick = (e) => {
    const act = e.target.closest('[data-sel]')?.dataset.sel;
    const sel = state?.selection;
    if (!act || !sel) return;
    if (act === 'delete') deleteSelection();
    else if (act === 'edit') editText(sel.page, sel.items[0]);
    else if (act === 'color') recolorSelection(prefs.color);
  };
}

// =====================================================================
// Undo / redo
// =====================================================================

function pushUndo(op) {
  state.undoStack.push(op);
  if (state.undoStack.length > 500) state.undoStack.shift();
  state.redoStack = [];
  syncToolbar();
}

function applyOp(op, inverse) {
  const items = pageItems(op.page);
  switch (op.type) {
    case 'clear':
      state.ann.pages[op.page] = inverse ? op.items.slice() : [];
      break;
    case 'add':
    case 'remove': {
      const add = (op.type === 'add') !== inverse;
      if (add) items.splice(Math.min(op.index, items.length), 0, op.item);
      else {
        const i = items.indexOf(op.item);
        if (i >= 0) items.splice(i, 1);
      }
      break;
    }
    case 'removeMany':
      if (inverse) for (const { item, index } of [...op.entries].reverse()) items.splice(Math.min(index, items.length), 0, item);
      else for (const { item } of op.entries) { const i = items.indexOf(item); if (i >= 0) items.splice(i, 1); }
      break;
    case 'move':
      for (const it of op.items) translate(it, inverse ? -op.dx : op.dx, inverse ? -op.dy : op.dy);
      break;
    case 'patch':
      Object.assign(op.item, inverse ? op.before : op.after);
      break;
  }
  state.selection = null;
  const p = state.pages[op.page - 1];
  redrawOverlay(p);
  p.el.scrollIntoView({ block: 'nearest' });
  changed();
}

function undo() {
  const op = state?.undoStack.pop();
  if (!op) return;
  applyOp(op, true);
  state.redoStack.push(op);
  syncToolbar();
}

function redo() {
  const op = state?.redoStack.pop();
  if (!op) return;
  applyOp(op, false);
  state.undoStack.push(op);
  syncToolbar();
}

// =====================================================================
// Saving: this device first (IndexedDB), then Google Drive
// =====================================================================

function changed() {
  state.dirty = true;
  persistLocal(state);
  setSaveStatus(navigator.onLine ? 'Unsaved changes…' : 'Offline — saved on this device', !navigator.onLine);
  scheduleSave(SAVE_DELAY);
}

function persistLocal(s) {
  cset('ann', s.deckId, { data: s.ann, fileId: s.annFileId, pending: true });
}

function scheduleSave(delay) {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => doSave(state), delay);
}

function flushSave() {
  clearTimeout(state.saveTimer);
  doSave(state);
}

export function retrySave() {
  if (state?.dirty) flushSave();
}

async function doSave(s) {
  if (!s || !s.dirty) return;
  if (s.saving) { s.saveAgain = true; return; }
  s.saving = true;
  s.dirty = false;
  if (s === state) setSaveStatus('Saving…');
  try {
    // Drop empty pages to keep the file small.
    for (const k of Object.keys(s.ann.pages)) if (!s.ann.pages[k].length) delete s.ann.pages[k];
    s.ann.updatedAt = new Date().toISOString();
    persistLocal(s);
    s.annFileId = await saveAnnotations(s.deckId, s.meta?.name || 'deck', s.annFileId, s.ann);
    if (!s.dirty) cset('ann', s.deckId, { data: s.ann, fileId: s.annFileId, pending: false });
    if (s === state && !s.dirty) setSaveStatus('Saved to Drive');
  } catch (e) {
    s.dirty = true;
    if (s === state) {
      setSaveStatus(
        e instanceof AuthExpiredError ? 'Not synced — reconnect' : isOfflineError(e) ? 'Offline — saved on this device' : 'Sync failed — will retry',
        true
      );
    }
    if (!quietErrors(e)) {
      console.error(e);
      clearTimeout(s.saveTimer);
      s.saveTimer = setTimeout(() => doSave(s), 5000);
    }
  } finally {
    s.saving = false;
    if (s.saveAgain) { s.saveAgain = false; doSave(s); }
  }
}

function setSaveStatus(text, warn = false) {
  const el = $('#save-status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

// =====================================================================
// Sidebar: page thumbnails + bookmarks
// =====================================================================

function toggleSidebar(open = $('#sidebar').hidden, keepPref = false) {
  $('#sidebar').hidden = !open;
  $('#sidebar-backdrop').hidden = !open;
  if (!keepPref) {
    prefs.sidebar = open;
    savePrefs();
  }
  syncToolbar();
  if (state?.pdf) setTimeout(() => state?.pdf && relayout(), 0);
  if (open) updatePageIndicator();
}

function showSideTab(tab) {
  document.querySelectorAll('[data-sidetab]').forEach((b) => b.classList.toggle('active', b.dataset.sidetab === tab));
  $('#thumb-list').hidden = tab !== 'pages';
  $('#bookmark-list').hidden = tab !== 'bookmarks';
}

function buildSidebar() {
  const s = state;
  const list = $('#thumb-list');
  list.innerHTML = '';
  s.thumbObserver?.disconnect();
  s.thumbObserver = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && renderSideThumb(Number(e.target.dataset.page))),
    { root: list, rootMargin: '200px 0px' }
  );
  for (const p of s.pages) {
    const item = document.createElement('button');
    item.className = 'thumb-item';
    item.dataset.page = p.num;
    item.innerHTML = `<canvas width="1" height="1"></canvas><span class="thumb-num">${p.num}</span><span class="thumb-mark">🔖</span>`;
    item.querySelector('canvas').style.aspectRatio = `${p.vp1.width} / ${p.vp1.height}`;
    item.onclick = () => {
      goToPage(p.num);
      if (window.innerWidth < 800) toggleSidebar(false);
    };
    list.appendChild(item);
    s.thumbObserver.observe(item);
  }
  renderBookmarkList();
}

async function renderSideThumb(num) {
  const s = state;
  const item = document.querySelector(`.thumb-item[data-page="${num}"]`);
  if (!item || item.dataset.done) return;
  item.dataset.done = '1';
  const p = s.pages[num - 1];
  const viewport = p.page.getViewport({ scale: 220 / p.vp1.width });
  const canvas = item.querySelector('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await p.page.render({ canvasContext: ctx, viewport }).promise;
    drawItems(ctx, s.ann.pages[num] || [], canvas.width, canvas.height);
  } catch {
    delete item.dataset.done;
  }
}

function syncBookmarks() {
  const bm = state.ann.bookmarks || {};
  for (const p of state.pages) p.el.classList.toggle('bookmarked', !!bm[p.num]);
  document.querySelectorAll('.thumb-item').forEach((t) => t.classList.toggle('bookmarked', !!bm[t.dataset.page]));
  renderBookmarkList();
  syncToolbar();
}

function renderBookmarkList() {
  const list = $('#bookmark-list');
  const bm = state?.ann.bookmarks || {};
  const pages = Object.keys(bm).map(Number).sort((a, b) => a - b);
  list.innerHTML = pages.length
    ? ''
    : '<p class="muted side-empty">No bookmarks yet. Press 🔖 (or B) to bookmark the page you’re on.</p>';
  for (const n of pages) {
    const row = document.createElement('div');
    row.className = 'bookmark-row';
    const go = document.createElement('button');
    go.className = 'bookmark-go';
    go.innerHTML = `<span class="bookmark-page">p. ${n}</span>`;
    go.append(document.createTextNode(bm[n]));
    go.onclick = () => {
      goToPage(n);
      if (window.innerWidth < 800) toggleSidebar(false);
    };
    const edit = document.createElement('button');
    edit.className = 'icon-btn small';
    edit.title = 'Rename bookmark';
    edit.textContent = '✏️';
    edit.onclick = async () => {
      const label = await askText('Bookmark name', bm[n]);
      if (label) { bm[n] = label; syncBookmarks(); changed(); }
    };
    const del = document.createElement('button');
    del.className = 'icon-btn small';
    del.title = 'Remove bookmark';
    del.textContent = '✕';
    del.onclick = () => { delete bm[n]; syncBookmarks(); changed(); };
    row.append(go, edit, del);
    list.appendChild(row);
  }
}

async function toggleBookmark() {
  const s = state;
  if (!s?.pdf) return;
  s.ann.bookmarks ||= {};
  const n = s.currentPage;
  if (s.ann.bookmarks[n]) {
    delete s.ann.bookmarks[n];
    toast(`Bookmark on page ${n} removed.`);
  } else {
    const label = await askText(`Bookmark page ${n}`, `Page ${n}`, 'Add bookmark');
    if (!label || state !== s) return;
    s.ann.bookmarks[n] = label;
    toast(`Page ${n} bookmarked.`);
  }
  syncBookmarks();
  changed();
}

// =====================================================================
// Text search
// =====================================================================

function openSearch() {
  if (!state?.pdf) return;
  $('#search-bar').hidden = false;
  const input = $('#search-input');
  input.focus();
  input.select();
}

function closeSearch() {
  $('#search-bar').hidden = true;
  if (state) {
    state.search = null;
    state.pages.forEach(applyHighlights);
  }
  $('#search-count').textContent = '';
}

async function runSearch(raw) {
  const s = state;
  const term = raw.trim().toLowerCase();
  if (!term) {
    s.search = null;
    s.pages.forEach(applyHighlights);
    $('#search-count').textContent = '';
    return;
  }
  $('#search-count').textContent = 'Searching…';
  const matches = [];
  for (let num = 1; num <= s.pdf.numPages; num++) {
    const tc = await getText(num);
    if (state !== s || $('#search-input').value.trim().toLowerCase() !== term) return;
    let n = 0;
    for (const it of tc.items) {
      const str = (it.str || '').toLowerCase();
      for (let i = str.indexOf(term); i >= 0; i = str.indexOf(term, i + term.length)) matches.push({ page: num, n: n++ });
    }
  }
  s.search = { term, matches, cur: matches.length ? 0 : -1 };
  // Start at the first match at or after the current page.
  const fromHere = matches.findIndex((m) => m.page >= s.currentPage);
  if (fromHere > 0) s.search.cur = fromHere;
  s.pages.forEach(applyHighlights);
  updateSearchCount();
  if (matches.length) showMatch();
}

function updateSearchCount() {
  const sr = state.search;
  $('#search-count').textContent = !sr ? '' : sr.matches.length ? `${sr.cur + 1} of ${sr.matches.length}` : 'No matches';
}

function stepMatch(dir) {
  const sr = state?.search;
  if (!sr?.matches.length) return;
  sr.cur = (sr.cur + dir + sr.matches.length) % sr.matches.length;
  updateSearchCount();
  state.pages.forEach(applyHighlights);
  showMatch();
}

function showMatch() {
  const sr = state.search;
  const m = sr.matches[sr.cur];
  const p = state.pages[m.page - 1];
  const mark = p.textLayer.querySelector('mark.current');
  if (mark) mark.scrollIntoView({ block: 'center' });
  else {
    sr.pendingScroll = m.page;
    p.el.scrollIntoView({ block: 'start' });
  }
}

/** Wrap search hits in this page's text layer with <mark>. */
function applyHighlights(p) {
  const layer = p.textLayer;
  for (const span of layer.querySelectorAll('span[data-orig]')) {
    span.textContent = span.dataset.orig;
    delete span.dataset.orig;
  }
  const sr = state?.search;
  if (!sr?.matches.length || !layer.childElementCount) return;
  const current = sr.matches[sr.cur];
  let n = 0;
  for (const span of layer.querySelectorAll('span')) {
    if (span.querySelector('span') || span.dataset.orig) continue;
    const text = span.textContent;
    const lower = text.toLowerCase();
    if (!lower.includes(sr.term)) continue;
    span.dataset.orig = text;
    span.textContent = '';
    let last = 0;
    for (let i = lower.indexOf(sr.term); i >= 0; i = lower.indexOf(sr.term, i + sr.term.length)) {
      span.append(text.slice(last, i));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(i, i + sr.term.length);
      if (current.page === p.num && current.n === n) mark.className = 'current';
      span.append(mark);
      last = i + sr.term.length;
      n++;
    }
    span.append(text.slice(last));
  }
  if (sr.pendingScroll === p.num) {
    sr.pendingScroll = null;
    layer.querySelector('mark.current')?.scrollIntoView({ block: 'center' });
  }
}

// =====================================================================
// Focus mode
// =====================================================================

function setFocus(on) {
  const v = $('#viewer');
  if (v.classList.contains('focus') === on) return;
  v.classList.toggle('focus', on);
  if (on) {
    clearSelection();
    if (!$('#sidebar').hidden) toggleSidebar(false, true);
    if (document.fullscreenEnabled && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
  updatePageIndicator();
  setTimeout(() => state?.pdf && relayout(), 50);
}

// =====================================================================
// Menu
// =====================================================================

function syncMenu() {
  const starred = state?.meta?.appProperties?.starred === '1';
  $('[data-action="star"]').textContent = starred ? '★ Unstar' : '☆ Star';
}

async function menuAction(action) {
  const s = state;
  if (!s?.pdf) return;
  if (action === 'add-page') {
    addPageDialog(s.currentPage + 1);
  } else if (action === 'delete-page') {
    deletePage(s.currentPage);
  } else if (action === 'star') {
    const next = s.meta.appProperties?.starred !== '1';
    try {
      await setStarred(s.deckId, next);
      s.meta.appProperties = { ...(s.meta.appProperties || {}), starred: next ? '1' : undefined };
      toast(next ? 'Starred.' : 'Removed from starred.');
    } catch (e) {
      if (!(e instanceof AuthExpiredError)) toast(isOfflineError(e) ? 'You’re offline.' : `Failed: ${e.message}`, 'error');
    }
  } else if (action === 'clear-page') {
    const n = s.currentPage;
    const items = pageItems(n);
    if (!items.length) return toast('Nothing to clear on this page.');
    if (!(await confirmDialog(`Clear page ${n}?`, `Remove all annotations on page ${n}? You can undo this.`, 'Clear', true))) return;
    pushUndo({ type: 'clear', page: n, items: items.slice() });
    s.ann.pages[n] = [];
    s.selection = null;
    redrawOverlay(s.pages[n - 1]);
    changed();
  } else if (action === 'rename') {
    const base = s.meta.name.replace(/\.pdf$/i, '');
    let name = await askText('Rename slides', base);
    if (!name || name === base) return;
    try {
      const parent = s.meta.parents?.[0] || null;
      while (await findSameName(parent, `${name.replace(/\.pdf$/i, '')}.pdf`, { excludeId: s.deckId })) {
        const again = await modal({
          title: 'Name already used',
          body: para(`There's already a deck named “${name}” in this folder. Please pick a different name.`),
          buttons: [{ label: 'Cancel', value: null }, { label: 'Choose another name', value: true, primary: true }],
        });
        if (!again) return;
        name = await askText('Rename slides', (await uniqueName(parent, `${name}.pdf`)).replace(/\.pdf$/i, ''));
        if (!name || name === base) return;
      }
      s.meta.name = await renameDeck(s.deckId, name);
      if (state === s) setTitle(s.meta.name);
      toast('Renamed.');
    } catch (e) {
      if (!(e instanceof AuthExpiredError)) toast(isOfflineError(e) ? 'You’re offline.' : `Rename failed: ${e.message}`, 'error');
    }
  } else if (action === 'open-drive') {
    window.open(s.meta.webViewLink, '_blank', 'noopener');
  } else if (action === 'export-download' || action === 'export-drive') {
    showLoading('Building annotated PDF…');
    try {
      const { exportAnnotatedPdf } = await import('./export.js');
      const bytes = await exportAnnotatedPdf(s.pdfBytes, s.pdf, s.ann.pages);
      const name = s.meta.name.replace(/\.pdf$/i, '') + ' (annotated).pdf';
      const blob = new Blob([bytes], { type: 'application/pdf' });
      if (action === 'export-download') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      } else {
        // Save next to the original, as a deck so it also shows up on the website.
        const parent = s.meta.parents?.[0] || null;
        const finalName = (await findSameName(parent, name)) ? await uniqueName(parent, name) : name;
        await saveDeckPdf(blob, finalName, parent);
        toast(`Saved “${finalName}” next to the original in Drive.`);
      }
    } catch (e) {
      console.error(e);
      if (!(e instanceof AuthExpiredError)) toast(isOfflineError(e) ? 'You’re offline.' : `Export failed: ${e.message}`, 'error');
    } finally {
      hideLoading();
    }
  }
}

// =====================================================================
// Add / delete pages
// =====================================================================

/** Dialog: choose page style and where to put it. `defaultAt` = suggested new page number. */
async function addPageDialog(defaultAt) {
  const s = state;
  if (!s?.pdf || s.busy) return;
  if (!navigator.onLine) return toast('Adding pages needs an internet connection.', 'error');
  const n = s.currentPage;
  const total = s.pdf.numPages;
  const body = document.createElement('div');
  body.className = 'add-page-form';

  const styleLabel = document.createElement('div');
  styleLabel.className = 'form-label';
  styleLabel.textContent = 'Page style';
  const styles = document.createElement('div');
  styles.className = 'template-choices';
  let template = 'blank';
  try { template = localStorage.getItem('sb_page_template') || 'blank'; } catch {}
  for (const [key, label] of Object.entries(TEMPLATES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `template-choice tpl-${key}${key === template ? ' selected' : ''}`;
    b.innerHTML = `<span class="tpl-preview"></span><span>${label}</span>`;
    b.onclick = () => {
      template = key;
      styles.querySelectorAll('.template-choice').forEach((x) => x.classList.toggle('selected', x === b));
    };
    styles.appendChild(b);
  }

  const posLabel = document.createElement('div');
  posLabel.className = 'form-label';
  posLabel.textContent = 'Where';
  const pos = document.createElement('select');
  pos.className = 'modal-input';
  const options = [
    [n + 1, `After this page (page ${n})`],
    [n, `Before this page (page ${n})`],
    [total + 1, 'At the end'],
    [1, 'At the beginning'],
  ];
  const seen = new Set();
  for (const [value, label] of options) {
    if (seen.has(value)) continue;
    seen.add(value);
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    pos.appendChild(o);
  }
  pos.value = String(seen.has(defaultAt) ? defaultAt : n + 1);
  body.append(styleLabel, styles, posLabel, pos);

  const ok = await modal({
    title: 'Add page',
    body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add page', value: true, primary: true }],
  });
  if (!ok) return;
  try { localStorage.setItem('sb_page_template', template); } catch {}
  addPage(Number(pos.value), template);
}

async function addPage(at, template) {
  const s = state;
  // Same size as the page you're looking at (as displayed, so rotated slides stay landscape).
  const ref = s.pages[Math.min(s.currentPage, s.pages.length) - 1].vp1;
  await changePages(s, {
    loading: 'Adding page…',
    build: () => insertPage(s.pdfBytes, at, [ref.width, ref.height], template),
    remap: (obj) => shiftForInsert(obj, at),
    goTo: at,
    done: `Page ${at} added.`,
  });
}

async function deletePage(num) {
  const s = state;
  if (!s?.pdf || s.busy) return;
  if (!navigator.onLine) return toast('Deleting pages needs an internet connection.', 'error');
  if (s.pdf.numPages <= 1) return toast('A deck needs at least one page.', 'error');
  const hasNotes = (s.ann.pages[num] || []).length > 0;
  const ok = await confirmDialog(
    `Delete page ${num}?`,
    `Page ${num} will be removed from the PDF in your Drive${hasNotes ? ', together with its annotations' : ''}. This can’t be undone here (Google Drive keeps older versions for about 30 days).`,
    'Delete page',
    true
  );
  if (!ok) return;
  await changePages(s, {
    loading: 'Deleting page…',
    build: () => removePage(s.pdfBytes, num),
    remap: (obj) => shiftForRemove(obj, num),
    goTo: Math.min(num, s.pdf.numPages - 1),
    done: `Page ${num} deleted.`,
  });
}

async function changePages(s, { loading, build, remap, goTo, done }) {
  if (s.busy) return;
  s.busy = true;
  showLoading(loading);
  try {
    const bytes = await build();
    showLoading('Saving to Drive…');
    const updated = await replaceFileContent(s.deckId, new Blob([bytes], { type: 'application/pdf' }), (p) =>
      showLoading(`Saving to Drive… ${Math.round(p * 100)}%`)
    );
    // PDF is saved — now move annotations & bookmarks to their new page numbers and save them too.
    s.ann.pages = remap(s.ann.pages);
    s.ann.bookmarks = remap(s.ann.bookmarks || {});
    s.ann.lastPage = goTo;
    s.undoStack = [];
    s.redoStack = [];
    clearTimeout(s.saveTimer);
    s.dirty = true;
    doSave(s);
    if (updated?.md5Checksum) {
      s.meta.md5Checksum = updated.md5Checksum;
      cachePdf(s.deckId, { md5: updated.md5Checksum, bytes: bytes.slice(0).buffer, meta: s.meta });
    }
    showLoading('Rendering…');
    await reloadPdf(s, bytes, goTo);
    if (updated?.md5Checksum) ensureThumb(s.deckId, updated.md5Checksum, s.pdf);
    toast(done);
  } catch (e) {
    if (!(e instanceof AuthExpiredError)) {
      console.error(e);
      toast(isOfflineError(e) ? 'You’re offline.' : e.message, 'error');
    }
  } finally {
    s.busy = false;
    hideLoading();
  }
}

// =====================================================================
// Loading overlay
// =====================================================================

function showLoading(text) {
  $('#loading').hidden = false;
  $('#loading-text').textContent = text;
}
function hideLoading() {
  $('#loading').hidden = true;
}

setupSelectionBar();
