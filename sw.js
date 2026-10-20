// Offline cache. The app's files are refreshed as one set on each online launch and
// only written if every file arrived, so modules from two versions never mix.
// No version number to bump: editing FILES changes this file, which reinstalls the worker.
// Known limits: refresh() writes aren't one transaction, and a hanging network delays launch;
// upgrade paths: write into a fresh cache then delete the old one, and race refresh() against a 3 s timer.
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'ignore.js', 'fflate.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']
const CACHE = 'packlight'

self.addEventListener('install', e => e.waitUntil((async () => {
  const cache = await caches.open(CACHE)
  await cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))
  await self.skipWaiting()
})()))

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

async function refresh() {
  try {
    const res = await Promise.all(FILES.map(f => fetch(f, { cache: 'no-cache' })))
    if (!res.every(r => r.ok)) return
    const cache = await caches.open(CACHE)
    await Promise.all(res.map((r, i) => cache.put(FILES[i], r)))
  } catch { /* offline: keep the previous complete set */ }
}

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return
  if (req.mode === 'navigate') {
    e.respondWith(refresh().then(async () => (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./')) || fetch(req)))
  } else {
    e.respondWith(caches.match(req).then(r => r || fetch(req)))
  }
})
