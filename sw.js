// HR Tools — service worker (offline-capable PWA shell).
// Bump CACHE version whenever the precached assets change.
const CACHE = 'hr-tools-v1';

// Core shell, resolved relative to the SW location (repo root) so it works no
// matter what sub-path the site is hosted under.
const CORE = [
  '.', 'index.html', 'holidays.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'overtime-calculator/', 'overtime-calculator/index.html',
  'overtime-calculator/style.css',
  'overtime-calculator/app.js?v=20260527b',
  'overtime-calculator/holidays.js?v=20260527b',
  'hiring-sheet/index.html', 'hiring-sheet/style.css', 'hiring-sheet/app.js',
].map(p => new URL(p, self.location).toString());

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Best-effort: a single 404 must not abort the whole install.
    await Promise.allSettled(CORE.map(u => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigations: network-first (fresh HTML when online), fall back to cache/offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || caches.match(new URL('index.html', self.location).toString());
      }
    })());
    return;
  }

  // Everything else (CSS/JS/icons/CDN libs/fonts): cache-first, then network.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // Cache successful same-origin responses and opaque CDN responses for offline use.
      if (res && (res.ok || res.type === 'opaque')) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      return cached || Response.error();
    }
  })());
});
