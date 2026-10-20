import { compile, isIgnored } from './ignore.js'
import { Zip, ZipDeflate, ZipPassThrough } from './fflate.js'

// GitHub Pages can't send frame-ancestors, so refuse to run inside a frame
if (window.top !== window) { document.body.textContent = 'Open Packlight directly.'; throw 0 }
document.getElementById('no-js').remove()

// Memory caps are conservative guesses, not measured per device. Raise them after testing on your own phone.
const MEM_CAP = matchMedia('(pointer: coarse)').matches ? 400e6 : 2 ** 30
const MAX_BYTES = 3.9 * 2 ** 30 // fflate writes no ZIP64
const MAX_ENTRIES = 65535
const FOLD = 32 * 2 ** 20
const PRESETS = ['venv/', '.venv/', 'env/', '__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.ipynb_checkpoints/',
  'node_modules/', 'dist/', 'build/', '.next/', 'target/', '.gradle/', '.git/', '.idea/', '.vscode/', '.settings/', '.project',
  '.classpath', '.DS_Store', 'Thumbs.db', '.env*', '!.env.example', '*.pem', '*.key', '*.log', 'coverage/', '.cache/']
const DEFAULTS = ['.git/', 'venv/', '.venv/', 'node_modules/', '__pycache__/', '.DS_Store', '.env*']

const $ = id => document.getElementById(id)
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
const plural = (k, w) => `${k.toLocaleString()} ${w}${k === 1 ? '' : 's'}`
const fmt = b => b < 1024 ? `${b} B` : b < 2 ** 20 ? `${(b / 1024).toFixed(1)} KB` : b < 2 ** 30 ? `${(b / 2 ** 20).toFixed(1)} MB` : `${(b / 2 ** 30).toFixed(2)} GB`
const status = t => { $('status').textContent = t }
const note = t => { $('pick-note').textContent = t; $('pick-note').hidden = !t }
// fflate checks the year in local time and throws outside 1980–2099
const clampMtime = t => Math.min(Math.max(t, new Date(1980, 0, 2).getTime()), new Date(2099, 11, 30).getTime())
const safe = n => n && n !== '.' && n !== '..' && !n.includes('/') && !n.includes('\\')
// the name typed in "Save as", made valid on Windows, macOS and Linux; empty falls back to the folder name
const zipName = () => {
  const n = $('zip-name').value.trim().replace(/\.zip$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').slice(0, 100)
  return `${n || root.name}.zip`
}

// --- folder adapters: each gives { name, dir } where dir.list() → [{ name, dir } | { name, getFile }]

const fromHandle = h => ({
  async list() {
    const out = []
    for await (const [name, c] of h.entries()) out.push(c.kind === 'directory' ? { name, dir: fromHandle(c) } : { name, getFile: () => c.getFile() })
    return out
  },
})

const fromEntry = e => ({
  async list() {
    const reader = e.createReader(), out = []
    for (;;) { // readEntries returns batches; stop on an empty one
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) return out
      for (const c of batch) out.push(c.isDirectory ? { name: c.name, dir: fromEntry(c) } : { name: c.name, getFile: () => new Promise((res, rej) => c.file(res, rej)) })
    }
  },
})

function fromFileList(files) {
  const tree = new Map()
  for (const f of files) {
    const parts = f.webkitRelativePath.split('/')
    let m = tree
    for (const p of parts.slice(1, -1)) { if (!m.has(p)) m.set(p, new Map()); m = m.get(p) }
    m.set(parts.at(-1), f)
  }
  const wrap = m => ({ async list() { return [...m].map(([name, v]) => v instanceof Map ? { name, dir: wrap(v) } : { name, getFile: async () => v }) } })
  return { name: files[0].webkitRelativePath.split('/')[0], dir: wrap(tree) }
}

// --- state

let root = null
let chips = [...DEFAULTS]
let topNames = []
let gen = 0 // bumped on every folder/rule change; Compress needs a scan from the current gen
let scan = null
let busy = false
let zipUrl = null
let debounce
const STALE = Symbol('stale')

// --- walk: prune excluded folders before reading them

async function walk(dir, rel, gi, my, out) {
  const kids = await dir.list()
  if (my !== gen) throw STALE
  if (!rel) out.top = kids.map(k => k.name + (k.dir ? '/' : ''))
  if ($('use-gitignore').checked) {
    const g = kids.find(k => k.name === '.gitignore' && !k.dir)
    if (g) {
      try {
        const lines = (await (await g.getFile()).text()).split('\n')
        // caps only bound memory; matching is already linear
        const rules = compile(lines.filter(l => l.length <= 1000).slice(0, 5000), rel)
        out.giRules += rules.length
        out.giInvalid += rules.filter(r => r.invalid).length
        gi = gi.concat(rules) // new array: these rules only reach this folder's subtree
      } catch { /* unreadable .gitignore: carry on without it */ }
    }
  }
  const rules = gi.concat(out.chipRules) // chips last, so they win
  if (!kids.length && rel) out.emptyDirs.push(rel)
  for (const k of kids) {
    const path = rel ? `${rel}/${k.name}` : k.name
    if (!safe(k.name)) { out.skipped.push(`${path} (name not allowed in a ZIP)`); continue }
    if (isIgnored(rules, path, !!k.dir)) { out.skipped.push(path + (k.dir ? '/' : '')); continue }
    if (k.dir) await walk(k.dir, path, gi, my, out)
    else {
      let size = 0
      try { size = (await k.getFile()).size } catch { /* reported at compress time */ }
      out.files.push({ path, getFile: k.getFile })
      out.bytes += size
    }
  }
}

async function rescan() {
  if (!root) return
  const my = gen
  const out = { files: [], skipped: [], emptyDirs: [], top: [], bytes: 0, giRules: 0, giInvalid: 0, chipRules: compile(chips) }
  try {
    await walk(root.dir, '', [], my, out)
  } catch (e) {
    if (e === STALE || my !== gen) return
    $('summary').textContent = 'Couldn’t read the folder. Choose or drop it again.'
    return
  }
  if (my !== gen) return
  scan = out
  topNames = out.top
  render()
}

// a finished in-memory ZIP must never outlive the rules it was built with
function discardZip() {
  if (!zipUrl) return false
  URL.revokeObjectURL(zipUrl)
  zipUrl = null
  $('saved').hidden = true
  $('save-link').removeAttribute('href')
  return true
}

function invalidate() {
  gen++
  scan = null
  $('compress').disabled = true
  $('unreadable').hidden = true
  if (discardZip()) status('Settings changed. Compress again.')
  if (root) $('summary').textContent = 'Updating…'
  $('reset').hidden = false
}

function reset() {
  root = null
  chips = [...DEFAULTS]
  topNames = []
  clearTimeout(debounce)
  invalidate()
  $('use-gitignore').checked = true
  $('pattern').value = ''
  $('pattern-error').hidden = true
  $('suggest').hidden = true
  $('folder-name').textContent = 'Choose a folder'
  $('drop-hint').textContent = 'or drop one here'
  $('summary').textContent = 'Choose a folder to see what goes into the ZIP.'
  $('compress').textContent = 'Compress'
  for (const id of ['skipped-box', 'block', 'reset', 'name-row']) $(id).hidden = true
  $('zip-name').value = ''
  $('gi-count').textContent = ''
  note('')
  status('')
  renderChips()
  $('pick').focus()
}

function rulesChanged() {
  invalidate()
  clearTimeout(debounce)
  debounce = setTimeout(rescan, 300)
}

function setRoot(r) {
  root = r
  note('')
  status('')
  $('folder-name').textContent = r.name
  $('drop-hint').textContent = 'Choose a different folder'
  $('zip-name').value = r.name
  $('name-row').hidden = false
  invalidate()
  rescan()
}

function render() {
  const s = scan
  $('summary').textContent = `${root.name}: ${plural(s.files.length, 'file')}, ${fmt(s.bytes)}`
  $('gi-count').textContent = s.giRules ? `(${plural(s.giRules, 'rule')}${s.giInvalid ? `, ${s.giInvalid} invalid and ignored` : ''})` : ''
  $('skipped-box').hidden = !s.skipped.length
  $('skipped-sum').textContent = `Left out: ${plural(s.skipped.length, 'item')}`
  const shown = s.skipped.slice(0, 500).map(p => el('li', null, p))
  if (s.skipped.length > 500) shown.push(el('li', 'muted', `and ${(s.skipped.length - 500).toLocaleString()} more`))
  $('skipped').replaceChildren(...shown)

  const entries = s.files.length + s.emptyDirs.length
  const block = !entries ? 'Nothing left to zip. Remove some patterns.'
    : entries > MAX_ENTRIES ? `Too many files (${entries.toLocaleString()}, limit ${MAX_ENTRIES.toLocaleString()}). Leave out more.`
    : s.bytes >= MAX_BYTES ? `Too big (${fmt(s.bytes)}, limit 3.9 GB). Leave out more.`
    : !window.showSaveFilePicker && s.bytes > MEM_CAP ? `Too big to build in this browser’s memory (${fmt(s.bytes)}, limit ${fmt(MEM_CAP)}). Leave out more, or use Chrome or Edge on a computer.`
    : ''
  $('block').textContent = block
  $('block').hidden = !block
  $('compress').textContent = `Compress to ${zipName()}`
  $('compress').disabled = !!block || busy
}

// --- compress

function setBusy(b) {
  busy = b
  $('controls').disabled = b
  $('reset').disabled = b
  $('zip-name').disabled = b
  $('busy').hidden = !b
  $('compress').disabled = b || !scan
}

$('compress').addEventListener('click', async () => {
  const job = scan
  if (!job || busy) return
  // the save dialog must open first, while the click still counts as a user gesture
  let writable = null
  let fileName = zipName()
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'ZIP file', accept: { 'application/zip': ['.zip'] } }] })
      fileName = h.name // the save dialog may have renamed it
      writable = await h.createWritable()
    } catch (e) {
      if (e.name !== 'AbortError') status(`Couldn’t open the save dialog: ${e.message}`)
      return
    }
  }
  status('')
  discardZip()
  $('unreadable').hidden = true
  setBusy(true)
  const ac = new AbortController()
  $('cancel').onclick = () => ac.abort()
  const name = root.name
  const unreadable = [], parts = [], chunks = []
  let held = 0, written = 0, done = 0, zipErr = null, pending = Promise.resolve()
  const zip = new Zip((err, chunk) => {
    if (err) { zipErr = err; return }
    written += chunk.length
    if (writable) pending = pending.then(() => writable.write(chunk))
    else {
      chunks.push(chunk)
      held += chunk.length
      if (held >= FOLD) { parts.push(new Blob(chunks)); chunks.length = 0; held = 0 } // keeps peak RAM ≈ ZIP size
    }
  })
  const flush = async () => {
    await pending
    if (zipErr) throw zipErr
    if (ac.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  }
  const progress = path => {
    $('progress').value = job.bytes ? Math.min(done / job.bytes, 1) : 1
    $('progress-text').textContent = `${Math.round($('progress').value * 100)}%  ${path}`
  }

  try {
    for (const f of job.files) {
      await flush()
      // read the first chunk BEFORE zip.add(): an added entry can't be removed, so unreadable files must be caught here
      let file, reader, r
      try {
        file = await f.getFile()
        reader = file.stream().getReader()
        r = await reader.read()
      } catch {
        unreadable.push(f.path)
        continue
      }
      const entry = new ZipDeflate(`${name}/${f.path}`, { level: 6 })
      entry.mtime = clampMtime(file.lastModified)
      zip.add(entry)
      while (!r.done) {
        entry.push(r.value)
        done += r.value.length
        progress(f.path)
        await flush()
        try { r = await reader.read() } catch { throw new Error(`Couldn’t finish reading ${f.path}. Try again, or leave it out with a pattern.`) }
      }
      entry.push(new Uint8Array(0), true) // 0-byte files land here directly; never push undefined
    }
    for (const d of job.emptyDirs) {
      const e = new ZipPassThrough(`${name}/${d}/`)
      zip.add(e)
      e.push(new Uint8Array(0), true)
    }
    zip.end()
    await flush()

    if (writable) {
      await writable.close()
      status(`Saved ${fileName} (${fmt(written)})`)
    } else {
      parts.push(new Blob(chunks))
      const file = new File(parts, fileName, { type: 'application/zip' })
      zipUrl = URL.createObjectURL(file)
      $('save-link').href = zipUrl
      $('save-link').download = file.name
      // saving needs a fresh tap: share() and late downloads are blocked without one
      $('share').hidden = !navigator.canShare?.({ files: [file] })
      // a rename after compressing applies too: share under the current name
      $('share').onclick = () => navigator.share({ files: [new File([file], zipName(), { type: file.type })] }).catch(e => { if (e.name !== 'AbortError') status(`Couldn’t share: ${e.message}`) })
      $('saved').hidden = false
      status(`${file.name} is ready (${fmt(file.size)})`)
    }
  } catch (e) {
    if (writable) await writable.abort().catch(() => {})
    status(e.name === 'AbortError' ? 'Cancelled.' : e.message || String(e))
  } finally {
    setBusy(false)
    $('progress-text').textContent = ''
    $('unreadable').hidden = !unreadable.length
    $('unreadable-sum').textContent = `${plural(unreadable.length, 'file')} couldn’t be read and ${unreadable.length === 1 ? 'was' : 'were'} left out:`
    $('unreadable-list').replaceChildren(...unreadable.map(p => el('li', null, p)))
  }
})

// --- picking a folder

const canPick = !!window.showDirectoryPicker
const canInput = 'webkitdirectory' in HTMLInputElement.prototype
if (!canPick && canInput) $('pick-hint').hidden = false
if (!canPick && !canInput) {
  $('pick').disabled = true
  note('This browser can’t open folders. Use Chrome, Edge, Firefox or Safari.')
}

// Some browsers (embedded views, locked-down profiles) refuse to show the folder window and report it
// exactly like a user cancel. Nobody cancels in under half a second, so a fast "cancel" means "refused".
const BLOCKED = 'This browser didn’t open the folder window. Drag the folder onto this page instead, or use Chrome, Edge, Firefox or Safari.'
let pickStart = 0
const refused = () => performance.now() - pickStart < 500
const openInput = () => { pickStart = performance.now(); $('dir-input').click() }

$('pick').addEventListener('click', async () => {
  note('')
  if (!window.showDirectoryPicker) return openInput()
  pickStart = performance.now()
  try {
    const h = await window.showDirectoryPicker({ mode: 'read' })
    setRoot({ name: h.name, dir: fromHandle(h) })
  } catch (e) {
    if (e.name === 'AbortError' && !refused()) return // the user closed the window
    if (canInput) openInput() // modern picker refused: try the classic folder input
    else note(BLOCKED)
  }
})
$('dir-input').addEventListener('cancel', () => { if (refused()) note(BLOCKED) })
$('reset').addEventListener('click', reset)

// renaming never needs a re-scan or a re-compress: only the file name changes
$('zip-name').addEventListener('input', () => {
  if (scan) $('compress').textContent = `Compress to ${zipName()}`
  if (zipUrl) $('save-link').download = zipName()
})
$('zip-name').addEventListener('change', () => { if (root) $('zip-name').value = zipName().slice(0, -4) }) // show the cleaned-up name
$('zip-name').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('compress').disabled) $('compress').click() })

$('dir-input').addEventListener('change', e => {
  const files = e.target.files
  if (files.length) setRoot(fromFileList(files))
  else note('That folder is empty.')
  e.target.value = ''
})

// drop anywhere; without preventDefault the browser would open the dropped file
addEventListener('dragover', e => {
  e.preventDefault()
  if (!busy) $('pick').classList.add('over')
})
addEventListener('dragleave', e => { if (!e.relatedTarget) $('pick').classList.remove('over') })
addEventListener('drop', e => {
  e.preventDefault()
  $('pick').classList.remove('over')
  if (busy) return
  const items = e.dataTransfer.items
  const entry = items.length === 1 ? items[0].webkitGetAsEntry?.() : null // must run before any await
  if (!entry?.isDirectory) return note('Drop one folder.')
  setRoot({ name: entry.name, dir: fromEntry(entry) })
})

// --- patterns: search box + suggestion buttons + chips

function renderChips() {
  $('chips').replaceChildren(...chips.map(c => {
    const li = el('li', 'chip')
    li.append(el('span', null, c))
    const x = el('button', null, '×')
    x.type = 'button'
    x.setAttribute('aria-label', `Stop leaving out ${c}`)
    x.addEventListener('click', () => {
      chips = chips.filter(v => v !== c)
      renderChips()
      rulesChanged()
      $('pattern').focus()
    })
    li.append(x)
    return li
  }))
}

function addChip(p) {
  p = p.trim()
  if (!p) return false
  const err = $('pattern-error')
  err.hidden = true
  if (chips.some(c => c.toLowerCase() === p.toLowerCase())) return true
  const rules = compile([p])
  if (p.length > 200 || !rules.length || rules[0].invalid) {
    err.textContent = `“${p}” isn’t a valid pattern.`
    err.hidden = false
    return false
  }
  chips.push(p)
  renderChips()
  rulesChanged()
  return true
}

function renderSuggest() {
  const q = $('pattern').value.trim().toLowerCase()
  const have = new Set(chips.map(c => c.toLowerCase()))
  const items = [...new Set([...PRESETS, ...topNames])].filter(s => !have.has(s.toLowerCase()) && s.toLowerCase().includes(q))
  $('suggest').replaceChildren(...items.map(s => {
    const b = el('button', null, s)
    b.type = 'button'
    b.addEventListener('click', () => {
      addChip(s)
      $('pattern').value = ''
      renderSuggest()
      $('pattern').focus()
    })
    return b
  }))
  $('suggest').hidden = !items.length
}

$('pattern').addEventListener('focus', renderSuggest)
$('pattern').addEventListener('input', renderSuggest)
// Safari doesn't focus clicked buttons; keep focus in the input so focusout doesn't hide the list mid-click
$('suggest').addEventListener('mousedown', e => e.preventDefault())
$('combo').addEventListener('focusout', e => { if (!$('combo').contains(e.relatedTarget)) $('suggest').hidden = true })
$('combo').addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // first Escape closes the list; only a second one lets the search box clear its text
    if (!$('suggest').hidden) { e.preventDefault(); $('suggest').hidden = true; $('pattern').focus() }
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  if ($('suggest').hidden) renderSuggest()
  const list = [$('pattern'), ...$('suggest').querySelectorAll('button')]
  const i = list.indexOf(document.activeElement)
  if (i < 0) return
  e.preventDefault()
  list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus()
})
$('add-form').addEventListener('submit', e => {
  e.preventDefault()
  if (addChip($('pattern').value)) { $('pattern').value = ''; renderSuggest() }
})
$('use-gitignore').addEventListener('change', rulesChanged)

renderChips()
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js')
