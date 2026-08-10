// Balikin — Service Worker
// Cache app shell so the page still loads (fully offline-usable, since all
// analysis logic runs client-side anyway) even without a connection.

// v2: fixes the "stuck like a splash screen" bug. Root cause was twofold:
//  1) cache.addAll() on the app shell is all-or-nothing — if a single file
//     failed (e.g. a bad path/network hiccup on first install), NOTHING got
//     precached, so an offline/flaky reload later had no fallback at all.
//  2) The runtime cache only stored responses with type === 'basic', which
//     cross-origin CDN requests (Tailwind CDN, Google Fonts, JSZip, Chart.js
//     loaded via <script src>) never are — they come back 'opaque'. So those
//     scripts were NEVER cached, and opening the installed app with a weak/no
//     connection loaded an HTML shell with no CSS/JS engine behind it: blank
//     page, nothing rendered, looks like the splash never went away.
const CACHE_NAME = 'balikin-cache-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        // Cache each file independently instead of cache.addAll(), which
        // aborts the ENTIRE precache if even one request fails. One bad
        // file should not leave the app with zero offline fallback.
        Promise.allSettled(
          APP_SHELL.map((url) => cache.add(url).catch((err) => {
            console.warn('[sw] gagal precache', url, err);
          }))
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Helper: race a fetch against a timeout so a slow/hanging connection falls
// back to cache quickly instead of leaving the page blank while it waits.
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((res) => { clearTimeout(timer); resolve(res); },
                     (err) => { clearTimeout(timer); reject(err); });
  });
}

// Network-first for navigation (so updates are picked up when online),
// falling back to cache when offline or slow. Cache-first for static assets.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetchWithTimeout(req, 4000)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cache same-origin ('basic') AND cross-origin CDN ('opaque')
        // responses — opaque is the normal, successful result for a
        // no-cors cross-origin <script>/<link> fetch, and skipping it
        // meant the Tailwind/Fonts/JSZip/Chart.js CDN scripts this app
        // depends on were never available offline.
        if (res && (res.status === 200 || res.type === 'opaque')) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
