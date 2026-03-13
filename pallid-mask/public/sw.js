// Minimal service worker — enables PWA install prompt.
// No offline caching: the installation requires a live server for fortune generation.

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
