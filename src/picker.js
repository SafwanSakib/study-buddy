// Google Picker: lets you choose files that are already in your Google Drive.
// With the drive.file permission, picking a file is what grants Study Buddy access to it.
import { getToken } from './auth.js';

const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY;
// The Cloud project number is the first part of the OAuth client ID.
const APP_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').split('-')[0];

const MIME_TYPES = [
  'application/pdf',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.oasis.opendocument.text',
].join(',');

export function pickerConfigured() {
  return !!API_KEY;
}

let loadPromise = null;
function loadPicker() {
  loadPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = () => window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Picker failed to load')) });
    s.onerror = () => {
      loadPromise = null;
      reject(new Error('Could not load Google Picker. Check your connection.'));
    };
    document.head.appendChild(s);
  });
  return loadPromise;
}

/** Opens the picker; resolves with [{id, name, mimeType}] (empty if cancelled). */
export async function pickFromDrive() {
  const token = getToken();
  await loadPicker();
  const gp = window.google.picker;
  return new Promise((resolve) => {
    const view = new gp.DocsView(gp.ViewId.DOCS).setMimeTypes(MIME_TYPES).setIncludeFolders(true).setSelectFolderEnabled(false);
    const picker = new gp.PickerBuilder()
      .addView(view)
      .enableFeature(gp.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setAppId(APP_ID)
      .setTitle('Import slides into Study Buddy')
      .setCallback((data) => {
        if (data.action === gp.Action.PICKED) resolve(data.docs.map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })));
        else if (data.action === gp.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
}
