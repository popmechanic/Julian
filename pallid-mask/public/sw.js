// v2 — sigil.computer domain migration
// Minimal service worker — enables PWA install prompt.
// No offline caching: the installation requires a live server for fortune generation.

// Clear any caches from the old domain on activation
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
