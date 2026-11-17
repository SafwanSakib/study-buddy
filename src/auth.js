// Google sign-in via Google Identity Services (token model).
// Scope `drive.file` = the app can only see/modify files it created, nothing else in your Drive.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email profile';
const TOKEN_KEY = 'sb_token';
const HINT_KEY = 'sb_login_hint';

let tokenClient = null;
let token = null; // { access_token, expires_at }
let pending = null; // { resolve, reject }
const expiredListeners = new Set();

export function isConfigured() {
  return !!CLIENT_ID && !CLIENT_ID.startsWith('1234567890');
}

function waitForGis() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - start > 15000) return reject(new Error('Could not load Google sign-in. Check your connection.'));
      setTimeout(check, 100);
    })();
  });
}

export async function initAuth() {
  // Restore a still-valid token from this tab session (survives page reloads).
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    if (saved && saved.expires_at > Date.now() + 60_000) token = saved;
  } catch {}

  await waitForGis();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      const p = pending;
      pending = null;
      if (resp.error) return p?.reject(new Error(resp.error_description || resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/drive.file')) {
        return p?.reject(new Error('Study Buddy needs permission to save files to your Google Drive. Please tick the Drive checkbox.'));
      }
      token = { access_token: resp.access_token, expires_at: Date.now() + (resp.expires_in - 30) * 1000 };
      try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch {}
      p?.resolve(token.access_token);
    },
    error_callback: (err) => {
      const p = pending;
      pending = null;
      p?.reject(new Error(err?.message || err?.type || 'Sign-in was cancelled.'));
    },
  });
}

export function hasValidToken() {
  return !!token && token.expires_at > Date.now();
}

/** Must be called from a user gesture (click) because it may open a popup. */
export function signIn() {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    let hint;
    try { hint = localStorage.getItem(HINT_KEY) || undefined; } catch {}
    tokenClient.requestAccessToken({ prompt: hint ? '' : 'consent', login_hint: hint });
  });
}

export function rememberUser(email) {
  try { localStorage.setItem(HINT_KEY, email); } catch {}
}

export function getToken() {
  if (!hasValidToken()) {
    expiredListeners.forEach((fn) => fn());
    throw new AuthExpiredError();
  }
  return token.access_token;
}

export function markExpired() {
  token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  expiredListeners.forEach((fn) => fn());
}

export function onExpired(fn) {
  expiredListeners.add(fn);
}

export function signOut() {
  if (token) google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(HINT_KEY);
  } catch {}
}

export class AuthExpiredError extends Error {
  constructor() {
    super('Google session expired');
    this.name = 'AuthExpiredError';
  }
}
