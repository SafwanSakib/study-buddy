# Study Buddy

Upload your slides, annotate them, and read them on any device. Everything is saved to **your own Google Drive**.

- **Upload**: PDF, PowerPoint (`.ppt/.pptx/.odp`) and Word (`.doc/.docx/.odt`). Office files are converted to PDF by Google Drive.
- **Annotate**: pen, highlighter, text notes, eraser, 8 colours, 3 sizes, undo/redo, zoom. Works with mouse, touch and stylus (Apple Pencil, S-Pen).
- **Sync**: annotations autosave to Drive about a second after each change. Open the same deck on another device and you get your notes and the page you were on.
- **Export**: download a PDF with the annotations drawn in, or save one to Drive.
- **Privacy**: the app uses the `drive.file` permission, so it can only see files it created. It has no server, so your files go straight from your browser to Google.

- **Folders**: create folders (and folders inside folders), rename and delete them, and move slides or folders with **⋯ → Move to…** or by dragging a card onto a folder or breadcrumb. These are real folders in your Google Drive, so the website and Drive always match.
- **Rename** slides from **⋯ → Rename** in the library, or from **⋮ → Rename** while you're reading.
- **No accidental duplicates**: if a folder or file name already exists in that folder, you're asked what to do. For uploads you can **Keep both** (adds a number), **Replace** (new PDF, annotations kept) or **Skip**.
- **Add pages** to write notes on: **⋮ → Add page…** or the **+ Add page** button at the end. Pick Blank, Lined, Grid or Dotted, and choose where it goes. **⋮ → Delete this page** removes a page. These changes are saved into the PDF in your Drive, and your annotations stay on the right pages.

- **Works offline**: decks you've opened are kept on your device and open instantly. You can read and annotate without internet, and your notes sync when you're back online.
- **Better notes**: edit a note by tapping it with the 🅣 tool, drag notes to move them, use the ⬚ lasso to select and move or recolour handwriting, and draw lines, arrows, rectangles and ellipses.
- **Find your way**: the ▤ sidebar shows page thumbnails and bookmarks (🔖 or press B). 🔍 or Ctrl+F searches the slide text, and the ✋ tool lets you select and copy text.
- **Stylus mode** ✍️: your pen draws and your finger scrolls, with palm rejection. It turns on automatically the first time you use a stylus.
- **Focus mode** ⛶ (F): full screen with only the slides; use the arrow keys to change page.
- **Library**: real thumbnails, ⭐ Starred, 🕘 Recently opened, and **Import** from your Google Drive.
- **Light/dark theme** toggle (🌙/☀️).

Your Drive mirrors the website:
```
My Drive/
└── Study Buddy/                       ← "My slides" on the website
    ├── Semester 1/
    │   ├── Physics/
    │   │   ├── Lecture 1.pdf
    │   │   └── Lecture 1 (annotated).pdf   ← only if you export to Drive
    │   └── Chemistry/
    ├── Lecture 2.pdf
    └── _annotations/                  ← your pen/highlighter/notes data; don't delete
```

Renaming or moving these files and folders **inside Google Drive** also shows up on the website.
One exception: Study Buddy can only see folders and files it created. A folder you make directly in Drive won't appear on the website, so create folders from the website.

---

## 1. Create a Google OAuth Client ID (one-time, about 5 minutes)

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Study Buddy").
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (called "Google Auth Platform" in newer consoles):
   - User type: **External**
   - App name: Study Buddy, plus your email for support and developer contact.
   - **Scopes**: add `.../auth/drive.file`, `openid`, `email`, `profile`.
   - **Test users**: add your own Google account (and anyone else who will use it).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins**: add
     - `http://localhost:5173` (for local testing)
     - your live URL once deployed, e.g. `https://study-buddy-yourname.netlify.app`
   - No redirect URIs are needed.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

> While the app is in "Testing" mode, only the test users you added can sign in. That's fine for personal use.
> Because `drive.file` is a non-sensitive scope, you can click **Publish app** later without Google's lengthy verification.

### Optional: enable "Import from Google Drive"
1. In **APIs & Services → Library**, enable **Google Picker API**.
2. In **Credentials → Create credentials → API key**, restrict the key to *Google Picker API* and to your website addresses.
3. Add `VITE_GOOGLE_API_KEY=...` to `.env` (and to your hosting's environment variables).

## 2. Run locally

```bash
cp .env.example .env          # then paste your Client ID into .env
npm install
npm run dev                   # open http://localhost:5173
```

To try it on your phone over Wi-Fi, run `npm run dev -- --host`. Google sign-in only works on `localhost` or HTTPS, so for real phone use, deploy it (next step).

## 3. Deploy (free) so you can use it from any device

Build with `npm run build`. This creates a static `dist/` folder you can host anywhere.

**Netlify (easiest):**
1. Run `npm run build`.
2. Drag the `dist` folder onto <https://app.netlify.com/drop>.
3. Copy the URL Netlify gives you and add it to **Authorized JavaScript origins** (step 1.4). It can take a few minutes to take effect.

**Vercel / Cloudflare Pages / GitHub Pages:** connect the repo, set the build command to `npm run build` and the output directory to `dist`, and add the environment variable `VITE_GOOGLE_CLIENT_ID`.

**Install it like an app:** on your phone, open the site, then choose Share → **Add to Home Screen** (iOS) or ⋮ → **Install app** (Android/Chrome).

---

## Using it

| Tool | Shortcut | Notes |
|---|---|---|
| ✋ Read | H | Scroll and pinch normally |
| ✏️ Pen | P | |
| 🖍️ Highlighter | L | Semi-transparent, drawn under the text colour |
| 🅣 Text note | T | Tap where the note should go |
| 🧽 Eraser | E | Removes whole strokes or notes you touch |
| Undo / Redo | Ctrl+Z / Ctrl+Y | |

On a touch screen, switch to ✋ to scroll. The drawing tools use your finger or pen for drawing.

## Limits

- PowerPoint/Word conversion relies on Google's converter, which can't export files over about 10 MB. For very large decks, export to PDF in PowerPoint first.
- If you annotate the *same deck on two devices at the same time*, the last save wins. Annotating on one device and then the other is fine.
- Google sign-in tokens last 1 hour. When yours expires, a **Reconnect** banner appears and unsaved changes are kept and saved after you reconnect.

## Project layout

```
index.html          app shell (sign-in, library, viewer)
src/main.js         startup, routing (#/ and #/deck/<id>)
src/auth.js         Google Identity Services sign-in
src/drive.js        Google Drive REST: folder, upload/convert, annotations JSON
src/library.js      deck grid, upload queue, delete
src/viewer.js       PDF.js rendering, drawing tools, undo, autosave
src/annotations.js  annotation model + drawing + hit-testing
src/export.js       flatten annotations into a PDF (pdf-lib)
```
