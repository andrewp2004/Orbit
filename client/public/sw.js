// Offline support: caches the app shell so single-player works without a connection after the first load.
const CACHE = 'orbit-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;
  if (req.mode === 'navigate') {
    // Network first for the page, fall back to the cached shell when offline.
    e.respondWith(fetch(req).then((res) => { caches.open(CACHE).then((c) => c.put('/', res.clone())); return res; }).catch(() => caches.match('/')));
    return;
  }
  // Cache first for hashed assets and fonts.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
