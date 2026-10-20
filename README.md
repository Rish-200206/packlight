# Packlight

Zip a folder and leave out the junk (`venv`, `node_modules`, `.git`, `.env`…) with `.gitignore`-style patterns.
Free, runs entirely in your browser, works offline, installs to your phone or desktop like an app.
Nothing is uploaded and nothing is stored.

## Use it

1. Choose a folder (or drop it on the page).
2. Pick what to leave out: search the list, or type any gitignore pattern (`*.log`, `/build`, `docs/**/*.md`, `!keep.txt`).
   The folder's own `.gitignore` files are used too (toggle).
3. Check the preview, change the name under **Save as** if you like, then **Compress**.

**Reset** (top right) clears the folder and puts the patterns back to the defaults.
If your browser won't open the folder window, the app says so; drag the folder onto the page instead.

`venv/` matches a `venv` folder at any depth, and excluded folders are skipped without being read.

**Install:** browser menu → *Install app* (Chrome/Edge, Android), or Safari → Share → *Add to Home Screen* (iPhone).

| Browser | Folder | Save |
|---|---|---|
| Chrome / Edge desktop, Chrome Android | button or drop, excluded folders never read | save dialog, streamed to disk |
| Firefox / Safari desktop | drop (fast) or button | download, built in memory (1 GB cap) |
| iPhone Safari, Firefox Android | button | Save ZIP or Share → Save to Files (400 MB cap) |

Limits: up to 3.9 GB / 65,535 entries per ZIP (no ZIP64). Unix permissions and symlinks aren't kept.
Pattern matching is case-insensitive.

## Run locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. (`file://` won't work: service workers and folder access need http(s) or localhost.)

Self-check for the pattern matcher (Node 22.7+ or 20.19+, prints nothing on success):

```
node ignore.test.mjs
```

## Deploy (free, GitHub Pages)

Live at **https://rish-200206.github.io/packlight/**, served from `main` / root (Settings → Pages).
Push to `main` to update. Users get the new version on their next online launch; there is no cache version to bump.

Security note: every Pages site on one GitHub account shares the origin `rish-200206.github.io`, including its offline cache.
Packlight is currently the only one. If you add more Pages sites to this account, keep them free of third-party scripts,
or move Packlight to a free GitHub organization of its own (repo `<org>.github.io`). Keep 2FA on.

## Files

`index.html` page · `style.css` styles · `app.js` folder reading, preview, zipping, saving ·
`ignore.js` gitignore matcher (no RegExp, so a hostile `.gitignore` can't freeze the tab) · `ignore.test.mjs` its tests ·
`sw.js` offline cache · `manifest.webmanifest` + icons for installing · `fflate.js` ZIP writer.

`fflate.js` is [fflate](https://github.com/101arrowz/fflate) 0.8.3 `esm/browser.js` (MIT), unmodified.
SHA-256 `b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1`. Re-check the hash if you upgrade it.

See `ARCHITECTURE.md` for the full design and security notes.
