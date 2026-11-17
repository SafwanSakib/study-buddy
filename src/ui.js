export const $ = (sel) => document.querySelector(sel);

let toastTimer;
export function toast(msg, kind = 'info', ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 7000 : ms);
}

export function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Small modal. `body` is an element; resolves with the clicked button's value (or null on cancel). */
export function modal({ title, body, buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }], onOpen }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2');
    h.textContent = title;
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const close = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`;
      btn.textContent = b.label;
      btn.onclick = () => close(typeof b.value === 'function' ? b.value() : b.value);
      if (b.primary) box._primary = btn;
      actions.appendChild(btn);
    }
    box.append(h);
    if (body) box.append(body);
    box.append(actions);
    back.appendChild(box);
    back.addEventListener('mousedown', (e) => e.target === back && close(null));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    box._close = close;
    onOpen?.(box, close);
  });
}

/** Text input dialog. Resolves with trimmed text, or null if cancelled/empty. */
/**
 * Text input dialog. Single-line: resolves with trimmed text, or null if cancelled/empty.
 * { multiline: true }: a textarea (Enter = new line, Ctrl/⌘+Enter = save); resolves null only on
 * cancel, and '' if the user saved an empty box.
 */
export async function askText(title, value = '', okLabel = 'Save', { multiline = false } = {}) {
  const input = document.createElement(multiline ? 'textarea' : 'input');
  input.className = 'modal-input';
  input.value = value;
  input.maxLength = multiline ? 2000 : 200;
  if (multiline) input.rows = 4;
  const result = await modal({
    title,
    body: input,
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: () => input.value, primary: true }],
    onOpen: (box) => {
      setTimeout(() => { input.focus(); input.select(); }, 0);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          box._primary.click();
        }
      });
    },
  });
  if (typeof result !== 'string') return null;
  const t = result.trim();
  return multiline ? t : t || null;
}

export async function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  const p = document.createElement('p');
  p.textContent = message;
  p.className = 'muted';
  return !!(await modal({ title, body: p, buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: true, primary: !danger, danger }] }));
}

export function para(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}
