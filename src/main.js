import './style.css';
import { initAuth, isConfigured, signIn, signOut, hasValidToken, onExpired, rememberUser } from './auth.js';
import { getUserInfo } from './drive.js';
import { showLibrary, currentLibraryHash } from './library.js';
import { openDeck, closeDeck, retrySave, isLoaded } from './viewer.js';
import { cget, cset, clearAll } from './cache.js';
import { initTheme } from './theme.js';
import { $, showScreen, toast, confirmDialog } from './ui.js';

let user = null;
let authReady = false;

async function start() {
  initTheme();
  registerServiceWorker();
  wireHandlers();

  if (!isConfigured()) {
    showScreen('signin');
    $('#signin-btn').disabled = true;
    showSigninError('Setup needed: add your Google OAuth Client ID to a .env file (see README.md), then restart the dev server / rebuild.');
    return;
  }

  // Offline start: open the app with what's saved on this device; sign in again once online.
  const cachedUser = await cget('kv', 'user');
  if (!navigator.onLine && cachedUser) {
    setUser(cachedUser);
    window.addEventListener('online', ensureAuth, { once: true });
    route();
    return;
  }

  if (!(await ensureAuth())) return;
  if (hasValidToken()) {
    try {
      await afterSignIn();
      return;
    } catch {}
  }
  showScreen('signin');
}

async function ensureAuth() {
  if (authReady) return true;
  try {
    await initAuth();
    authReady = true;
    return true;
  } catch (e) {
    if (!user) {
      showScreen('signin');
      showSigninError(e.message);
    }
    return false;
  }
}

function wireHandlers() {
  $('#signin-btn').onclick = async () => {
    $('#signin-error').hidden = true;
    try {
      if (!(await ensureAuth())) return;
      await signIn();
      await afterSignIn();
    } catch (e) {
      showSigninError(e.message);
    }
  };
  $('#back-btn').onclick = () => (location.hash = currentLibraryHash());
  $('#user-btn').onclick = async () => {
    const ok = await confirmDialog(
      'Sign out?',
      `Signed in as ${user?.email || 'Google user'}. Signing out also removes the offline copies saved on this device (your Drive is not affected).`,
      'Sign out',
      true
    );
    if (!ok) return;
    signOut();
    await clearAll();
    user = null;
    location.hash = '#/';
    showScreen('signin');
  };
  $('#reconnect-btn').onclick = async () => {
    try {
      if (!(await ensureAuth())) return;
      await signIn();
      $('#reconnect').hidden = true;
      retrySave();
      // Don't reload an open deck (that would lose your place); just retry what failed.
      if (!(location.hash.startsWith('#/deck/') && isLoaded())) route();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  onExpired(() => {
    if (user && navigator.onLine) $('#reconnect').hidden = false;
  });
  window.addEventListener('hashchange', route);
}

async function afterSignIn() {
  const info = await getUserInfo();
  rememberUser(info.email);
  cset('kv', 'user', { email: info.email, name: info.name, picture: info.picture });
  setUser(info);
  route();
}

function setUser(info) {
  user = info;
  const btn = $('#user-btn');
  btn.innerHTML = user.picture
    ? `<img src="${user.picture}" alt="" referrerpolicy="no-referrer">`
    : (user.name || user.email || '?')[0].toUpperCase();
  btn.title = user.email;
}

function route() {
  if (!user) return;
  const deck = location.hash.match(/^#\/deck\/([\w-]+)/);
  const folder = location.hash.match(/^#\/folder\/([\w-]+)/);
  if (deck) {
    showScreen('viewer');
    openDeck(deck[1]).catch(() => {});
  } else {
    closeDeck();
    showScreen('library');
    showLibrary(folder ? folder[1] : null);
  }
}

function showSigninError(msg) {
  const el = $('#signin-error');
  el.textContent = msg;
  el.hidden = false;
}

function registerServiceWorker() {
  // Caches the app itself so it opens without internet (production builds only).
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}

start();
