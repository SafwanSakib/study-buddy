// Light / dark theme. Default follows the device; the toggle button pins a choice.
const KEY = 'sb_theme';

function systemDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function currentTheme() {
  return document.documentElement.dataset.theme || (systemDark() ? 'dark' : 'light');
}

function apply(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = currentTheme() === 'dark';
  document.querySelectorAll('.theme-toggle').forEach((b) => {
    b.textContent = dark ? '☀️' : '🌙';
    b.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  });
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#181b22' : '#4f46e5');
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  apply(saved);
  document.querySelectorAll('.theme-toggle').forEach((b) => (b.onclick = toggleTheme));
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => apply(document.documentElement.dataset.theme));
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(KEY, next); } catch {}
  apply(next);
}
